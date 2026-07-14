"""POST /api/sync/{source}/{mode}: blocking by default, 202-queued with ?wait=false."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import httpx
import pytest

from fakes import FakeAppState
from fastapi import FastAPI

from arrsync.api import build_router
from arrsync.models import SyncResult


class StubSyncService:
    def __init__(self, status: str = "success") -> None:
        self.calls: list[tuple[str, str, str]] = []
        self.status = status

    async def run_sync(self, source: str, mode: str, reason: str = "manual") -> SyncResult:
        self.calls.append((source, mode, reason))
        now = datetime.now(timezone.utc)
        return SyncResult(
            source=source,
            mode=mode,
            status=self.status,
            records_processed=3,
            started_at=now,
            finished_at=now,
            details={"trigger": reason},
        )


def _client_and_state() -> tuple[httpx.AsyncClient, FakeAppState, StubSyncService]:
    state = FakeAppState()
    stub = StubSyncService()
    state.sync_service = stub
    state.manual_sync_tasks = set()
    app = FastAPI()
    app.include_router(build_router(state))
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    return client, state, stub


@pytest.mark.asyncio
async def test_default_wait_true_keeps_blocking_contract() -> None:
    client, _state, stub = _client_and_state()
    async with client:
        response = await client.post("/api/sync/sonarr/incremental")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "success"
    assert body["records_processed"] == 3
    assert "finished_at" in body
    assert stub.calls == [("sonarr", "incremental", "manual")]


@pytest.mark.asyncio
async def test_wait_false_returns_202_and_runs_in_background() -> None:
    client, state, stub = _client_and_state()
    async with client:
        response = await client.post("/api/sync/radarr/full?wait=false")
        assert response.status_code == 202
        assert response.json() == {"status": "queued", "source": "radarr", "mode": "full"}
        # Let the queued task run on this loop.
        for _ in range(10):
            await asyncio.sleep(0)
    assert stub.calls == [("radarr", "full", "manual")]
    assert state.manual_sync_tasks == set()  # done-callback discards finished tasks


@pytest.mark.asyncio
async def test_wait_false_conflicts_when_lock_already_held() -> None:
    client, state, stub = _client_and_state()
    state.session.job_lock_held = True
    async with client:
        response = await client.post("/api/sync/sonarr/full?wait=false")
    assert response.status_code == 409
    assert stub.calls == []


@pytest.mark.asyncio
async def test_invalid_source_and_mode_rejected() -> None:
    client, _state, _stub = _client_and_state()
    async with client:
        assert (await client.post("/api/sync/lidarr/full")).status_code == 400
        assert (await client.post("/api/sync/sonarr/turbo")).status_code == 400
