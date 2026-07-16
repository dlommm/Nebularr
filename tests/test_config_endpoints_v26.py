"""v2.6.0 config endpoints: test-connection, cron validate, queue policy, saved views."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from fakes import FakeAppState, FakeResult
from fastapi import FastAPI
from fastapi.testclient import TestClient

from arrsync.api import build_router


class ConfigFakeSession:
    """Settings-map fake plus the integration select the test endpoint issues."""

    def __init__(self) -> None:
        self.settings: dict[str, str] = {}
        self.integrations: list[dict[str, Any]] = []
        self.statements: list[tuple[str, dict[str, Any] | None]] = []

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> Any:
        sql = " ".join(str(query).lower().split())
        self.statements.append((sql, params))
        if "select value from app.settings" in sql:
            key = str((params or {}).get("key", ""))
            return FakeResult(self.settings.get(key))
        if "insert into app.settings" in sql:
            if params:
                self.settings[str(params["key"])] = str(params["value"])
            return FakeResult()
        if "from app.integration_instance" in sql and "where source" in sql:
            return FakeResult(rows=self.integrations)
        raise RuntimeError(f"unexpected SQL: {sql}")

    def commit(self) -> None:
        return None

    def rollback(self) -> None:
        return None

    def close(self) -> None:
        return None


class StubArrClient:
    fail = False

    def __init__(self, settings: Any, source: str, *, instance_name: str, base_url: str, api_key: str) -> None:
        self.base_url = base_url
        self.api_key = api_key

    async def system_status(self) -> dict[str, Any]:
        if StubArrClient.fail:
            raise RuntimeError("connection refused")
        return {"version": "4.0.9", "appName": "Sonarr"}

    async def aclose(self) -> None:
        return None

    @staticmethod
    def validate_webhook_secret(given: str, expected: str) -> bool:
        return given == expected


def _client(state: FakeAppState | None = None) -> tuple[TestClient, FakeAppState]:
    state = state or FakeAppState()
    state.session = ConfigFakeSession()  # type: ignore[assignment]
    state.arr_client_class = StubArrClient
    app = FastAPI()
    app.include_router(build_router(state))
    return TestClient(app), state


def test_integration_test_with_explicit_credentials() -> None:
    StubArrClient.fail = False
    client, _state = _client()
    response = client.post(
        "/api/config/integrations/sonarr/test",
        json={"base_url": "http://sonarr.example:8989", "api_key": "key"},
    )
    assert response.status_code == 200
    assert response.json() == {"ok": True, "version": "4.0.9", "app_name": "Sonarr"}


def test_integration_test_reports_failure_inline() -> None:
    StubArrClient.fail = True
    client, _state = _client()
    response = client.post(
        "/api/config/integrations/sonarr/test",
        json={"base_url": "http://sonarr.example:8989", "api_key": "key"},
    )
    StubArrClient.fail = False
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert "connection refused" in body["error"]


def test_integration_test_falls_back_to_stored_row() -> None:
    StubArrClient.fail = False
    client, state = _client()
    state.session.integrations = [  # type: ignore[attr-defined]
        {
            "source": "sonarr",
            "name": "default",
            "base_url": "http://stored.example:8989",
            "api_key": "stored-key",
            "enabled": True,
            "webhook_enabled": True,
        }
    ]
    response = client.post("/api/config/integrations/sonarr/test", json={})
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_integration_test_unknown_stored_name_404s() -> None:
    client, _state = _client()
    response = client.post("/api/config/integrations/sonarr/test", json={"name": "nope"})
    assert response.status_code == 404


def test_cron_validate_returns_next_fire_times() -> None:
    client, _state = _client()
    response = client.post(
        "/api/config/schedules/validate",
        json={"cron": "*/15 * * * *", "timezone": "Europe/Berlin"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is True
    assert body["timezone"] == "Europe/Berlin"
    times = [datetime.fromisoformat(t) for t in body["next_fire_times"]]
    assert len(times) == 3
    assert times[0] < times[1] < times[2]
    assert times[0].utcoffset() is not None  # tz-aware, in the requested zone


def test_cron_validate_rejects_bad_cron_and_timezone() -> None:
    client, _state = _client()
    bad_cron = client.post("/api/config/schedules/validate", json={"cron": "not a cron"})
    assert bad_cron.status_code == 200
    assert bad_cron.json()["valid"] is False
    bad_tz = client.post(
        "/api/config/schedules/validate", json={"cron": "* * * * *", "timezone": "Nope/Nowhere"}
    )
    assert bad_tz.json()["valid"] is False
    empty = client.post("/api/config/schedules/validate", json={})
    assert empty.json()["valid"] is False


def test_queue_policy_round_trip_and_validation() -> None:
    client, _state = _client()
    assert client.get("/api/config/queue").json()["batch_size"] == 80
    updated = client.put("/api/config/queue", json={"batch_size": 40, "max_attempts": 8})
    assert updated.status_code == 200
    assert updated.json()["batch_size"] == 40
    assert client.get("/api/config/queue").json()["max_attempts"] == 8
    assert client.put("/api/config/queue", json={"batch_size": "x"}).status_code == 400
    assert client.put("/api/config/queue", json={}).status_code == 400


def test_saved_views_round_trip_and_validation() -> None:
    client, _state = _client()
    assert client.get("/api/config/saved-views").json() == {"views": {}}
    put = client.put(
        "/api/config/saved-views",
        json={"page": "reporting", "views": [{"name": "My view", "search": "q=foo", "junk": 1}]},
    )
    assert put.status_code == 200
    body = client.get("/api/config/saved-views").json()
    # Only whitelisted fields are persisted.
    assert body["views"]["reporting"] == [{"name": "My view", "search": "q=foo"}]

    assert client.put("/api/config/saved-views", json={"page": "Bad Page!", "views": []}).status_code == 400
    too_many = [{"name": f"v{i}", "search": ""} for i in range(51)]
    assert client.put("/api/config/saved-views", json={"page": "library", "views": too_many}).status_code == 400
    long_name = [{"name": "x" * 81, "search": ""}]
    assert client.put("/api/config/saved-views", json={"page": "library", "views": long_name}).status_code == 400
    long_search = [{"name": "ok", "search": "x" * 2001}]
    assert client.put("/api/config/saved-views", json={"page": "library", "views": long_search}).status_code == 400


def test_saved_views_pages_are_independent() -> None:
    client, _state = _client()
    client.put("/api/config/saved-views", json={"page": "reporting", "views": [{"name": "a", "search": "x=1"}]})
    client.put("/api/config/saved-views", json={"page": "library", "views": [{"name": "b", "search": "y=2"}]})
    views = client.get("/api/config/saved-views").json()["views"]
    assert set(views) == {"reporting", "library"}
    stored_raw = _state.session.settings["app.ui_saved_views_json"]  # type: ignore[attr-defined]
    assert json.loads(stored_raw)["library"] == [{"name": "b", "search": "y=2"}]
