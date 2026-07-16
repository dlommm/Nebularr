"""Per-instance webhook routes must stamp the instance into the queued payload."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from fakes import FakeAppState
from fastapi import FastAPI
from fastapi.testclient import TestClient

from arrsync.api import build_router
from arrsync.services.sync_service import SyncService

SECRET_HEADER = {"x-arr-shared-secret": "test-webhook-secret"}


def _build_client(state: FakeAppState | None = None) -> tuple[TestClient, FakeAppState]:
    state = state or FakeAppState()
    app = FastAPI()
    app.include_router(build_router(state))
    return TestClient(app), state


def _enqueued(state: FakeAppState) -> list[dict[str, Any] | None]:
    return [params for sql, params in state.session.statements if "insert into app.webhook_queue" in sql]


def test_instance_route_stamps_instance_and_dedupe_differs_from_default() -> None:
    client, state = _build_client()
    body = {"eventType": "Download", "series": {"id": 7}}

    assert client.post("/hooks/sonarr", headers=SECRET_HEADER, json=body).status_code == 200
    assert client.post("/hooks/sonarr/inst-b", headers=SECRET_HEADER, json=body).status_code == 200

    rows = _enqueued(state)
    assert len(rows) == 2
    default_row, instance_row = rows
    assert default_row is not None and instance_row is not None
    assert json.loads(default_row["payload"])["instance_name"] == "default"
    assert json.loads(instance_row["payload"])["instance_name"] == "inst-b"
    assert default_row["dedupe_key"] != instance_row["dedupe_key"]


def test_unknown_instance_is_rejected() -> None:
    state = FakeAppState()
    state.session.known_webhook_instances = {"default", "inst-b"}
    client, _ = _build_client(state)

    ok = client.post("/hooks/sonarr/inst-b", headers=SECRET_HEADER, json={"eventType": "T"})
    assert ok.status_code == 200
    rejected = client.post("/hooks/sonarr/nope", headers=SECRET_HEADER, json={"eventType": "T"})
    assert rejected.status_code == 403


def test_default_shared_secret_is_refused() -> None:
    state = FakeAppState()
    state.settings.webhook_shared_secret = "changeme"
    client, _ = _build_client(state)

    response = client.post(
        "/hooks/sonarr", headers={"x-arr-shared-secret": "changeme"}, json={"eventType": "T"}
    )
    assert response.status_code == 403
    assert "not configured" in response.json()["detail"]
    assert not _enqueued(state)


class WebhookQueueSession:
    """Feeds one claimed job to process_webhook_queue and records all SQL."""

    def __init__(self, jobs: list[dict[str, Any]]) -> None:
        self.jobs = jobs
        self.statements: list[tuple[str, dict[str, Any] | None]] = []

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> Any:
        sql = " ".join(str(query).lower().split())
        self.statements.append((sql, params))
        jobs = self.jobs

        class _Result:
            def mappings(self_inner) -> list[dict[str, Any]]:
                if "update app.webhook_queue" in sql and "returning id" in sql:
                    out = list(jobs)
                    jobs.clear()
                    return out
                return []

            def first(self_inner) -> None:
                return None

            def scalar_one(self_inner) -> int:
                return 1

            def scalar_one_or_none(self_inner) -> None:
                return None

            def scalar(self_inner) -> None:
                return None

        return _Result()

    def commit(self) -> None:
        return None

    def rollback(self) -> None:
        return None

    def close(self) -> None:
        return None


class StubClient:
    def __init__(self) -> None:
        self.list_episodes_calls: list[int] = []
        self.settings = None
        self.base_url = "http://fake:8989"
        self.api_key = "fake"

    async def list_episodes(self, series_id: int) -> list[dict[str, Any]]:
        self.list_episodes_calls.append(series_id)
        return []


@pytest.mark.asyncio
async def test_webhook_job_with_null_series_does_not_crash() -> None:
    # Arr can send "series": null; the processor must treat it as absent.
    job = {
        "id": 1,
        "source": "sonarr",
        "event_type": "SeriesDelete",
        "payload": {"eventType": "SeriesDelete", "series": None, "episode": None},
        "attempts": 1,
    }
    session = WebhookQueueSession([job])
    stub = StubClient()
    service = SyncService(
        session_factory=lambda: session,
        sonarr=stub,  # type: ignore[arg-type]
        radarr=stub,  # type: ignore[arg-type]
        stop_event=asyncio.Event(),
    )
    service._client_for_integration = lambda source, integration: stub  # type: ignore[method-assign]

    summary = await service.process_webhook_queue("sonarr")

    assert summary["processed"] == 1
    assert summary["failed"] == 0
    assert stub.list_episodes_calls == []
    assert any("set status = 'done'" in sql for sql, _ in session.statements)
    assert not any(
        "update app.webhook_queue" in sql and "next_attempt_at = now() + make_interval" in sql
        for sql, _ in session.statements
    ), "job must not be marked failed"


def test_legacy_route_stamps_sole_renamed_integration() -> None:
    # Regression: a single integration renamed away from "default" must still be
    # able to POST to the legacy /hooks/{source} URL and be attributed correctly.
    state = FakeAppState()
    state.session.enabled_webhook_names = ["main-sonarr"]
    client, _ = _build_client(state)

    response = client.post("/hooks/sonarr", headers=SECRET_HEADER, json={"eventType": "Download"})
    assert response.status_code == 200
    rows = _enqueued(state)
    assert rows and rows[0] is not None
    assert json.loads(rows[0]["payload"])["instance_name"] == "main-sonarr"


def test_legacy_route_with_multiple_integrations_falls_back_to_default() -> None:
    state = FakeAppState()
    state.session.enabled_webhook_names = ["a-sonarr", "b-sonarr"]
    client, _ = _build_client(state)

    response = client.post("/hooks/sonarr", headers=SECRET_HEADER, json={"eventType": "Download"})
    assert response.status_code == 200
    rows = _enqueued(state)
    assert json.loads(rows[0]["payload"])["instance_name"] == "default"


def test_legacy_route_rejected_only_when_no_integration_accepts_webhooks() -> None:
    state = FakeAppState()
    state.session.webhook_ingest_allowed = False
    client, _ = _build_client(state)
    response = client.post("/hooks/sonarr", headers=SECRET_HEADER, json={"eventType": "T"})
    assert response.status_code == 403
