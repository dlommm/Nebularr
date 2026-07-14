"""MAL ingest-backlog: wait=false queues a tracked app.mal_job_run background job."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from fakes import FakeAppState
from fastapi import FastAPI

from arrsync.api import build_router


class BacklogSession:
    """Answers the SQL the backlog endpoint and job runner issue."""

    def __init__(self, pending_counts: list[int]) -> None:
        # One value per count_anime_needing_mal_fetch call (first = pending_before).
        self.pending_counts = list(pending_counts)
        self.statements: list[tuple[str, dict[str, Any] | None]] = []
        self.merged_patches: list[dict[str, Any]] = []
        self.finished_runs: list[tuple[str, str | None]] = []

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> Any:
        sql = " ".join(str(query).lower().split())
        self.statements.append((sql, params))
        session = self

        class _Result:
            def scalar_one(self_inner) -> int:
                if "insert into app.mal_job_run" in sql:
                    return 7
                if "count(*) from mal.anime" in sql:
                    if "mal_fetch_status in" in sql or "mal_fetched_at" in sql:
                        return session.pending_counts.pop(0) if session.pending_counts else 0
                    return 5  # fetched_success / dubbed_total summary counts
                raise AssertionError(f"unexpected scalar_one: {sql}")

            def scalar_one_or_none(self_inner) -> None:
                return None

            def first(self_inner) -> None:
                return None

        if "update app.mal_job_run" in sql and params is not None:
            if "finished_at" in sql:
                self.finished_runs.append((str(params.get("status")), params.get("error_message")))
            elif "patch" in (params or {}):
                self.merged_patches.append(json.loads(str(params["patch"])))
        return _Result()

    def commit(self) -> None:
        return None

    def rollback(self) -> None:
        return None

    def close(self) -> None:
        return None


class StubIngestService:
    def __init__(self, api_calls_per_run: int = 4) -> None:
        self.runs: list[str] = []
        self.api_calls_per_run = api_calls_per_run

    async def run(self, *, reason: str = "manual", max_ids_per_run: int | None = None) -> dict[str, Any]:
        self.runs.append(reason)
        return {
            "mal_api_calls": self.api_calls_per_run,
            "jikan_calls": 1,
            "mal_fetch_pending_batch": 2,
            "max_ids_per_run": max_ids_per_run or 200,
        }


def _client_and_state(pending_counts: list[int]) -> tuple[httpx.AsyncClient, FakeAppState, StubIngestService]:
    state = FakeAppState()
    state.session = BacklogSession(pending_counts)  # type: ignore[assignment]
    stub = StubIngestService()
    state.mal_ingest_service = stub
    state.mal_backlog_task = None
    app = FastAPI()
    app.include_router(build_router(state))
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
    return client, state, stub


@pytest.mark.asyncio
async def test_wait_false_queues_tracked_job_and_merges_progress() -> None:
    # pending_before=4, then 2 after cycle 1, 0 after cycle 2 -> job stops.
    client, state, stub = _client_and_state([4, 2, 0])
    async with client:
        response = await client.post(
            "/api/mal/ingest-backlog",
            json={"import_all": True, "wait": False, "cycle_delay_seconds": 0},
        )
        assert response.status_code == 202
        body = response.json()
        assert body["status"] == "queued"
        assert body["job_run_id"] == 7
        assert body["details"]["pending_before"] == 4
        assert state.mal_backlog_task is not None
        await asyncio.wait_for(state.mal_backlog_task, timeout=5)

    session = state.session
    assert stub.runs == ["manual_backlog", "manual_backlog"]
    # Initial patch plus one per completed cycle.
    assert len(session.merged_patches) == 3
    assert session.merged_patches[-1]["backlog_progress"]["pending_after"] == 0
    assert session.merged_patches[-1]["backlog_progress"]["cycles_run"] == 2
    assert session.finished_runs == [("success", None)]


@pytest.mark.asyncio
async def test_wait_false_conflicts_while_job_running() -> None:
    client, state, _stub = _client_and_state([4])

    async def _never_done() -> None:
        await asyncio.sleep(30)

    blocker = asyncio.create_task(_never_done())
    state.mal_backlog_task = blocker
    try:
        async with client:
            response = await client.post(
                "/api/mal/ingest-backlog", json={"import_all": True, "wait": False}
            )
        assert response.status_code == 409
    finally:
        blocker.cancel()


@pytest.mark.asyncio
async def test_wait_true_keeps_blocking_contract() -> None:
    client, _state, stub = _client_and_state([4, 0])
    async with client:
        response = await client.post(
            "/api/mal/ingest-backlog", json={"max_cycles": 3, "cycle_delay_seconds": 0}
        )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["details"]["pending_before"] == 4
    assert body["details"]["cycles_run"] == 1
    assert stub.runs == ["manual_backlog"]


@pytest.mark.asyncio
async def test_background_job_failure_finishes_run_as_failed() -> None:
    client, state, stub = _client_and_state([4, 2])

    async def exploding_run(**_kwargs: Any) -> dict[str, Any]:
        raise RuntimeError("MAL down")

    stub.run = exploding_run  # type: ignore[method-assign]
    async with client:
        response = await client.post(
            "/api/mal/ingest-backlog", json={"import_all": True, "wait": False}
        )
        assert response.status_code == 202
        assert state.mal_backlog_task is not None
        await asyncio.wait_for(state.mal_backlog_task, timeout=5)

    session = state.session
    assert session.finished_runs == [("failed", "MAL down")]
