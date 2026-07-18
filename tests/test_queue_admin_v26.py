"""v2.6.0 queue admin: paged webhook-jobs, bulk requeue, reset keep-list."""

from __future__ import annotations

import threading
from typing import Any

import httpx
import pytest
from fakes import FakeAppState, FakeResult
from fastapi import FastAPI
from fastapi.testclient import TestClient

from arrsync.api import build_router


class QueueAdminFakeSession:
    def __init__(self) -> None:
        self.settings: dict[str, str] = {
            "app.auth_password_hash": "scrypt$abc$def",
            "app.auth_enabled": "true",
            "app.webhook_secret_hash": "hash",
            "app.setup_completed": "true",
            "mal.client_id": "enc:cid",
            "app.alert_webhook_min_state": "warning",
            "app.metrics_public": "true",
            "sonarr.app_version": "4.0.9",  # derived; must NOT survive reset
        }
        self.job_rows = [
            {"id": i, "source": "sonarr", "event_type": "Download", "status": "retrying",
             "attempts": 1, "received_at": None, "next_attempt_at": None,
             "processed_at": None, "error_message": None}
            for i in range(1, 4)
        ]
        self.statements: list[tuple[str, dict[str, Any] | None]] = []
        self.truncated = False
        self.truncate_sql = ""
        # (id, source) for a successful single-job requeue; None simulates "not found".
        self.requeue_job_row: tuple[int, str] | None = (7, "sonarr")

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> Any:
        sql = " ".join(str(query).lower().split())
        self.statements.append((sql, params))
        if "select id, source, event_type" in sql:
            return FakeResult(rows=self.job_rows)
        if "select count(*) from app.webhook_queue" in sql:
            return FakeResult(scalar_value=103)
        if "update app.webhook_queue" in sql and "returning source" in sql:
            return FakeResult(rows=[("sonarr",), ("sonarr",), ("radarr",)])
        if "update app.webhook_queue" in sql and "returning id, source" in sql:
            return FakeResult(rows=[self.requeue_job_row] if self.requeue_job_row else [])
        if "update app.webhook_queue" in sql and "status = 'dead_letter'" in sql:
            return FakeResult()
        if "select key, value from app.settings" in sql:
            keys = set((params or {}).get("keys", []))
            kept = [
                (k, v)
                for k, v in self.settings.items()
                if k in keys or k.startswith("app.auth_") or k.startswith("app.alert_") or k.startswith("mal.")
            ]
            return FakeResult(rows=kept)
        if "truncate table" in sql:
            self.truncated = True
            self.truncate_sql = sql
            self.settings = {}
            return FakeResult()
        if "insert into app.settings" in sql:
            if params:
                self.settings[str(params["key"])] = str(params["value"])
            return FakeResult()
        if "select value from app.settings" in sql:
            key = str((params or {}).get("key", ""))
            return FakeResult(self.settings.get(key))
        raise RuntimeError(f"unexpected SQL: {sql}")

    def commit(self) -> None:
        return None

    def rollback(self) -> None:
        return None

    def close(self) -> None:
        return None


def _client() -> tuple[TestClient, FakeAppState, QueueAdminFakeSession]:
    state = FakeAppState()
    session = QueueAdminFakeSession()
    state.session = session  # type: ignore[assignment]
    app = FastAPI()
    app.include_router(build_router(state))
    return TestClient(app), state, session


def test_webhook_jobs_paged_shape_and_legacy_list() -> None:
    client, _state, _session = _client()
    paged = client.get("/api/ui/webhook-jobs?paged=true&limit=50&offset=0").json()
    assert paged["total"] == 103
    assert paged["limit"] == 50 and paged["offset"] == 0
    assert len(paged["items"]) == 3
    assert paged["has_more"] is True
    legacy = client.get("/api/ui/webhook-jobs").json()
    assert isinstance(legacy, list) and len(legacy) == 3


def test_webhook_jobs_orders_by_received_at_then_id_for_stable_pagination() -> None:
    client, _state, session = _client()
    client.get("/api/ui/webhook-jobs")
    select_sql = next(sql for sql, _ in session.statements if "select id, source, event_type" in sql)
    assert "order by received_at desc, id desc" in select_sql


def test_requeue_bulk_updates_and_kicks_drain() -> None:
    client, state, session = _client()
    drained: list[str] = []
    state.request_webhook_drain = drained.append
    response = client.post("/api/webhooks/requeue-bulk", json={"status": "dead_letter"})
    assert response.status_code == 200
    body = response.json()
    assert body == {"status": "queued", "requeued": 3, "sources": ["radarr", "sonarr"]}
    assert drained == ["radarr", "sonarr"]
    update_sql = next(sql for sql, _ in session.statements if "returning source" in sql)
    assert "set status = 'queued'" in update_sql


def test_replay_dead_letter_kicks_drain() -> None:
    client, state, _session = _client()
    drained: list[str] = []
    state.request_webhook_drain = drained.append
    response = client.post("/api/webhooks/replay-dead-letter/sonarr")
    assert response.status_code == 200
    assert response.json() == {"status": "queued"}
    assert drained == ["sonarr"]


def test_requeue_single_job_kicks_drain() -> None:
    client, state, session = _client()
    session.requeue_job_row = (7, "radarr")
    drained: list[str] = []
    state.request_webhook_drain = drained.append
    response = client.post("/api/webhooks/requeue/7")
    assert response.status_code == 200
    assert response.json() == {"status": "queued", "job_id": 7}
    assert drained == ["radarr"]


def test_requeue_single_job_not_found_does_not_drain() -> None:
    client, state, session = _client()
    session.requeue_job_row = None
    drained: list[str] = []
    state.request_webhook_drain = drained.append
    response = client.post("/api/webhooks/requeue/999")
    assert response.status_code == 404
    assert drained == []


@pytest.mark.asyncio
async def test_webhook_drain_runs_on_the_event_loop_thread_not_a_worker_thread() -> None:
    # Regression: request_webhook_drain (database_lifecycle.py) sets an asyncio.Event,
    # which is not thread-safe. A plain `def` handler runs entirely in FastAPI's
    # worker threadpool, including the drain call — this must never happen again.
    # ASGITransport calls the app in-process on the current event loop (no portal
    # thread), so the test's own thread ident is exactly "the loop thread".
    state = FakeAppState()
    session = QueueAdminFakeSession()
    state.session = session  # type: ignore[assignment]
    drain_thread_idents: list[int] = []
    state.request_webhook_drain = lambda source: drain_thread_idents.append(threading.get_ident())
    app = FastAPI()
    app.include_router(build_router(state))
    loop_thread_ident = threading.get_ident()

    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    async with client:
        replay = await client.post("/api/webhooks/replay-dead-letter/sonarr")
        assert replay.status_code == 200
        bulk = await client.post("/api/webhooks/requeue-bulk", json={"status": "dead_letter"})
        assert bulk.status_code == 200
        single = await client.post("/api/webhooks/requeue/7")
        assert single.status_code == 200

    assert len(drain_thread_idents) == 4  # replay(1) + bulk(2 sources) + single(1)
    assert set(drain_thread_idents) == {loop_thread_ident}


def test_requeue_bulk_validates_inputs() -> None:
    client, _state, _session = _client()
    assert client.post("/api/webhooks/requeue-bulk", json={"status": "done"}).status_code == 400
    assert (
        client.post("/api/webhooks/requeue-bulk", json={"status": "retrying", "source": "lidarr"}).status_code
        == 400
    )


def test_reset_data_preserves_auth_and_config_settings() -> None:
    client, _state, session = _client()
    response = client.post("/api/admin/reset-data", json={"confirmation": "RESET"})
    assert response.status_code == 200
    body = response.json()
    assert session.truncated
    assert body["kept_setting_count"] == 7
    # Auth, webhook secret, setup flag, alert + MAL config, and metrics visibility
    # survive the reset...
    for key in (
        "app.auth_password_hash",
        "app.auth_enabled",
        "app.webhook_secret_hash",
        "app.setup_completed",
        "mal.client_id",
        "app.alert_webhook_min_state",
        "app.metrics_public",
    ):
        assert key in session.settings, f"{key} must survive reset"
    # ...derived capability keys do not.
    assert "sonarr.app_version" not in session.settings


def test_reset_data_truncates_stat_snapshots_and_integrity_audit_history() -> None:
    client, _state, session = _client()
    response = client.post("/api/admin/reset-data", json={"confirmation": "RESET"})
    assert response.status_code == 200
    assert "warehouse.library_stat_snapshot" in session.truncate_sql
    assert "app.integrity_audit_run" in session.truncate_sql
