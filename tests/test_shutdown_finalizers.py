"""Cancellation (shutdown) must finalize run rows instead of leaving them 'running'."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from arrsync.mal.ingest_service import MalIngestService
from arrsync.services.sync_service import SyncService


class FinalizerRecordingSession:
    """Grants locks/run ids and records every statement."""

    def __init__(self) -> None:
        self.statements: list[tuple[str, dict[str, Any] | None]] = []

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> Any:
        sql = " ".join(str(query).lower().split())
        self.statements.append((sql, params))

        class _Result:
            def first(self_inner) -> Any:
                if "insert into app.job_lock" in sql:
                    return ("owner",)
                return None

            def scalar_one(self_inner) -> int:
                return 42

            def scalar_one_or_none(self_inner) -> None:
                return None

            def mappings(self_inner) -> list[Any]:
                return []

            def all(self_inner) -> list[Any]:
                return []

        return _Result()

    def commit(self) -> None:
        return None

    def rollback(self) -> None:
        return None

    def close(self) -> None:
        return None

    def failed_run_updates(self) -> list[dict[str, Any] | None]:
        return [
            params
            for sql, params in self.statements
            if "update warehouse.sync_run" in sql
            and params is not None
            and params.get("status") == "failed"
        ]


@pytest.mark.asyncio
async def test_cancelled_run_sync_still_finalizes_the_run_row(monkeypatch: Any) -> None:
    session = FinalizerRecordingSession()
    service = SyncService(
        session_factory=lambda: session,
        sonarr=object(),  # type: ignore[arg-type]
        radarr=object(),  # type: ignore[arg-type]
        stop_event=asyncio.Event(),
    )
    monkeypatch.setattr(
        service, "_enabled_integrations", lambda _source: [{"name": "default", "base_url": "http://x", "api_key": ""}]
    )
    started = asyncio.Event()

    async def hanging_incremental(*_args: Any, **_kwargs: Any) -> int:
        started.set()
        await asyncio.sleep(30)
        return 0

    monkeypatch.setattr(service, "_sync_incremental", hanging_incremental)
    monkeypatch.setattr(service, "_client_for_integration", lambda *_a, **_k: object())

    task = asyncio.create_task(service.run_sync("sonarr", "incremental", reason="test"))
    await asyncio.wait_for(started.wait(), timeout=2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    failed_updates = session.failed_run_updates()
    assert failed_updates, "cancelled run must write a failed sync_run row"
    assert any("cancellederror" in str(p.get("error_message", "")).lower() for p in failed_updates if p)
    # The lock must still be released by the finally block.
    assert any("delete from app.job_lock" in sql for sql, _ in session.statements)


@pytest.mark.asyncio
async def test_cancelled_mal_ingest_finalizes_job_row(monkeypatch: Any) -> None:
    session = FinalizerRecordingSession()
    settings = SimpleNamespace(
        http_timeout_seconds=5.0,
        http_retry_attempts=1,
        mal_jikan_min_request_interval_seconds=0.0,
        mal_min_request_interval_seconds=0.0,
        mal_client_id="cid",
        mal_dub_info_url="",
        mal_max_ids_per_run=10,
        mal_jikan_enabled=False,
        mydublist_url_template="https://example.test/{tier}.json",
        mydublist_confidence_tier="normal",
        mal_dubs_source_enabled=True,
        mydublist_enabled=False,
        mal_ingest_enabled=True,
        mal_matcher_enabled=False,
        mal_tagging_enabled=False,
        mal_allow_title_year_match=False,
        coverage_tagging_enabled=False,
    )
    service = MalIngestService(settings, lambda: session)  # type: ignore[arg-type]
    started = asyncio.Event()

    class HangingDubClient:
        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            return None

        async def fetch(self) -> Any:
            started.set()
            await asyncio.sleep(30)

    service.dub_client_class = HangingDubClient  # type: ignore[assignment]

    task = asyncio.create_task(service.run(reason="test"))
    await asyncio.wait_for(started.wait(), timeout=2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    finalized = [
        params
        for sql, params in session.statements
        if "update app.mal_job_run" in sql
        and params is not None
        and params.get("status") == "failed"
    ]
    assert finalized, "cancelled MAL ingest must finalize its job row as failed"
    assert any("delete from app.job_lock" in sql for sql, _ in session.statements)


def test_startup_sweep_marks_stale_running_rows() -> None:
    from arrsync.services.repository import fail_stuck_running_warehouse_work

    session = FinalizerRecordingSession()
    fail_stuck_running_warehouse_work(session, reason="startup sweep")  # type: ignore[arg-type]
    sweep = [
        params
        for sql, params in session.statements
        if "update warehouse.sync_run" in sql and params is not None
    ]
    assert sweep and "startup sweep" in str(sweep[0]["message"])
