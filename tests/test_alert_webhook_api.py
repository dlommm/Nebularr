from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from arrsync.api import build_router


class FakeResult:
    def __init__(self, scalar_value: str | None = None) -> None:
        self._scalar_value = scalar_value

    def scalar_one_or_none(self) -> str | None:
        return self._scalar_value


class FakeSession:
    def __init__(self) -> None:
        self.settings: dict[str, str] = {}

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> FakeResult:
        sql = str(query).lower()
        if "select value from app.settings" in sql:
            key = str((params or {}).get("key", ""))
            return FakeResult(self.settings.get(key))
        if "insert into app.settings" in sql:
            if params:
                self.settings[str(params["key"])] = str(params["value"])
            return FakeResult()
        raise RuntimeError(f"unexpected SQL in fake session: {sql}")


@dataclass
class FakeSettings:
    app_version: str = "test"
    app_git_sha: str = "sha"
    alert_webhook_queue_critical: int = 100
    alert_webhook_queue_warning: int = 50
    alert_sync_lag_critical_seconds: int = 7200
    alert_sync_lag_warning_seconds: int = 3600
    webhook_max_body_bytes: int = 1024
    webhook_shared_secret: str = "x"
    alert_webhook_urls: str = ""
    alert_webhook_timeout_seconds: float = 10.0
    alert_webhook_min_state: str = "warning"
    alert_webhook_notify_recovery: bool = True
    scheduler_timezone: str = "UTC"
    egress_policy: str = "open"


class FakeMetrics:
    def set_gauge(self, _name: str, _value: float) -> None:
        return None

    def inc(self, _name: str) -> None:
        return None


class FakeAlertNotifier:
    def __init__(self) -> None:
        self.test_results: list[dict[str, Any]] = []  # nothing configured by default
        self.single_target_calls: list[str] = []

    async def configure(self, **_kwargs: Any) -> None:
        return None

    async def maybe_send_health_alert(self, _payload: dict[str, Any]) -> bool:
        return False

    async def send_test_message(self) -> list[dict[str, Any]]:
        return list(self.test_results)

    async def send_test_to_target(self, target: str) -> dict[str, Any]:
        self.single_target_calls.append(target)
        for result in self.test_results:
            if result["target"] == target:
                return result
        return {"target": target, "ok": False, "error": "not a configured webhook URL"}


class FakeAppState:
    def __init__(self) -> None:
        self.settings = FakeSettings()
        self.metrics = FakeMetrics()
        self.arr_client_class = type("ArrClient", (), {"validate_webhook_secret": staticmethod(lambda *_: True)})
        self.alert_notifier = FakeAlertNotifier()
        self._session = FakeSession()
        self.session_factory = SimpleNamespace(ready=True, unbind=lambda: None)

    @contextmanager
    def session_scope(self):  # type: ignore[no-untyped-def]
        yield self._session


def _build_client(state: FakeAppState | None = None) -> TestClient:
    app = FastAPI()
    app.include_router(build_router(state or FakeAppState()))
    return TestClient(app)


def test_alert_webhook_config_get_and_put_roundtrip() -> None:
    client = _build_client()
    get_before = client.get("/api/config/alert-webhooks")
    assert get_before.status_code == 200
    assert get_before.json()["url_count"] == 0

    update = client.put(
        "/api/config/alert-webhooks",
        json={
            "webhook_urls": "https://discord.example/webhook\nhttps://slack.example/webhook",
            "timeout_seconds": 12,
            "min_state": "critical",
            "notify_recovery": False,
        },
    )
    assert update.status_code == 200
    assert update.json()["url_count"] == 2

    get_after = client.get("/api/config/alert-webhooks")
    assert get_after.status_code == 200
    body = get_after.json()
    assert body["urls_configured"] is True
    assert body["url_count"] == 2
    assert body["timeout_seconds"] == 12.0
    assert body["min_state"] == "critical"
    assert body["notify_recovery"] is False


def test_alert_webhook_event_flags_roundtrip() -> None:
    client = _build_client()

    get_before = client.get("/api/config/alert-webhooks")
    assert get_before.status_code == 200
    assert get_before.json()["events"] == {"health": True, "sync_failure": True, "dead_letter": True}

    update = client.put(
        "/api/config/alert-webhooks",
        json={"events": {"sync_failure": False}},
    )
    assert update.status_code == 200
    assert update.json()["events"]["sync_failure"] is False
    assert update.json()["events"]["health"] is True

    get_after = client.get("/api/config/alert-webhooks")
    assert get_after.status_code == 200
    assert get_after.json()["events"] == {"health": True, "sync_failure": False, "dead_letter": True}


def test_alert_webhook_test_route_reports_failure_when_unconfigured() -> None:
    client = _build_client()
    response = client.post("/api/config/alert-webhooks/test")
    assert response.status_code == 400


def test_alert_webhook_test_route_returns_per_target_results() -> None:
    state = FakeAppState()
    state.alert_notifier.test_results = [
        {"target": "https://a.example/hook", "ok": True, "error": None},
        {"target": "https://b.example/hook", "ok": False, "error": "timeout"},
    ]
    client = _build_client(state)
    response = client.post("/api/config/alert-webhooks/test")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"  # at least one channel delivered
    assert len(body["results"]) == 2
    assert body["results"][1]["error"] == "timeout"


def test_alert_webhook_test_route_targets_single_channel() -> None:
    state = FakeAppState()
    state.alert_notifier.test_results = [
        {"target": "https://a.example/hook", "ok": True, "error": None},
    ]
    client = _build_client(state)
    response = client.post(
        "/api/config/alert-webhooks/test", json={"target": "https://a.example/hook"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["results"] == [{"target": "https://a.example/hook", "ok": True, "error": None}]
    assert state.alert_notifier.single_target_calls == ["https://a.example/hook"]

    unknown = client.post("/api/config/alert-webhooks/test", json={"target": "https://x.example"})
    assert unknown.status_code == 200
    assert unknown.json()["status"] == "failed"
