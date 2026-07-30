from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from arrsync.api import build_router
from arrsync.routers import automations as automations_module
from fakes import FakeAppState, FakeResult, FakeSession


class AutomationApiFakeSession(FakeSession):
    def __init__(self) -> None:
        super().__init__()
        self.automations: list[dict[str, Any]] = []

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> FakeResult:
        sql = " ".join(str(query).lower().split())
        if "app.automation" in sql:
            self.statements.append((sql, params))
            if sql.startswith("insert into app.automation"):
                return FakeResult(scalar_value=42)
            if "from app.automation a" in sql:  # list with lateral last-run join
                return FakeResult(rows=self.automations)
            if "delete from app.automation" in sql:
                return FakeResult(rows=[(1,)])
            if "from app.automation where id" in sql:
                return FakeResult(rows=self.automations[:1])
            if "from app.automation_run" in sql:
                return FakeResult(rows=[])
            return FakeResult(rows=[(1,)])
        return super().execute(query, params)


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    state = FakeAppState()
    state.session = AutomationApiFakeSession()
    reloads = {"count": 0}

    def _reload() -> None:
        reloads["count"] += 1

    state.scheduler = SimpleNamespace(reload=_reload, settings=state.settings)
    state.reloads = reloads
    monkeypatch.setattr(
        automations_module.repo, "list_enabled_integrations", lambda session, source: []
    )
    app = FastAPI()
    app.include_router(build_router(state))
    test_client = TestClient(app)
    test_client.app_state = state  # type: ignore[attr-defined]
    return test_client


VALID_BODY = {
    "name": "dub hunt",
    "template_key": "anime-dub-enforcer",
    "params": {
        "scope": {"media": "both", "anime_only": True},
        "require": {"audio_language_any": ["english", "eng"], "resolution_min": 1080},
        "actions": [{"type": "search_missing"}, {"type": "search_upgrade"}],
        "options": {"mal_dub_gate": True},
    },
    "cron": "0 6 */2 * *",
    "timezone": "UTC",
}


def test_templates_catalog(client: TestClient) -> None:
    resp = client.get("/api/automations/templates")
    assert resp.status_code == 200
    keys = {t["key"] for t in resp.json()["templates"]}
    assert "anime-dub-enforcer" in keys and "custom" in keys


def test_create_valid_automation_reloads_scheduler(client: TestClient) -> None:
    resp = client.post("/api/automations", json=VALID_BODY)
    assert resp.status_code == 200, resp.text
    assert resp.json()["id"] == 42
    assert client.app_state.reloads["count"] == 1  # type: ignore[attr-defined]


def test_create_rejects_bad_cron(client: TestClient) -> None:
    resp = client.post("/api/automations", json={**VALID_BODY, "cron": "nope"})
    assert resp.status_code == 400
    assert "cron" in resp.json()["detail"].lower()


def test_create_rejects_unknown_template(client: TestClient) -> None:
    resp = client.post("/api/automations", json={**VALID_BODY, "template_key": "nope"})
    assert resp.status_code == 400


def test_create_rejects_invalid_params(client: TestClient) -> None:
    body = {**VALID_BODY, "params": {**VALID_BODY["params"], "actions": []}}
    resp = client.post("/api/automations", json=body)
    assert resp.status_code == 400


def test_validate_returns_fire_times_and_preview(client: TestClient) -> None:
    resp = client.post(
        "/api/automations/validate",
        json={"template_key": "custom", "params": VALID_BODY["params"], "cron": "0 6 * * *"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["valid"] is True
    assert len(body["next_fire_times"]) == 3
    assert body["match_preview"] == {}  # no enabled integrations in this fixture


def test_validate_flags_bad_params_without_500(client: TestClient) -> None:
    resp = client.post(
        "/api/automations/validate",
        json={"template_key": "custom", "params": {"actions": []}, "cron": "0 6 * * *"},
    )
    assert resp.status_code == 200
    assert resp.json()["valid"] is False


def test_run_now_starts_background_task(client: TestClient) -> None:
    calls: list[int] = []

    class FakeService:
        async def run(self, automation_id: int, *, reason: str = "cron") -> dict:
            calls.append(automation_id)
            return {"status": "success"}

    client.app_state.automation_service = FakeService()  # type: ignore[attr-defined]
    resp = client.post("/api/automations/5/run")
    assert resp.status_code == 200
    assert resp.json()["status"] == "started"
