"""Long runs must renew the job-lock lease so a concurrent trigger cannot steal it."""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from typing import Any

import pytest

from arrsync.mal.ingest_service import MalIngestService
from arrsync.services.sync_service import SyncService


class LockRecordingSession:
    """Grants the job lock on insert and records every statement."""

    def __init__(self) -> None:
        self.statements: list[tuple[str, dict[str, Any] | None]] = []

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> Any:
        sql = " ".join(str(query).lower().split())
        self.statements.append((sql, params))

        class _Result:
            def first(self_inner) -> Any:
                return ("owner",) if "insert into app.job_lock" in sql else None

            def scalar_one_or_none(self_inner) -> None:
                return None

        return _Result()

    def commit(self) -> None:
        return None

    def rollback(self) -> None:
        return None

    def close(self) -> None:
        return None

    def heartbeat_count(self) -> int:
        return sum(1 for sql, _ in self.statements if "update app.job_lock" in sql)


@pytest.mark.asyncio
async def test_run_sync_heartbeats_lock_during_long_run_and_stops_after(monkeypatch: Any) -> None:
    session = LockRecordingSession()
    service = SyncService(
        session_factory=lambda: session,
        sonarr=object(),  # type: ignore[arg-type]
        radarr=object(),  # type: ignore[arg-type]
        stop_event=asyncio.Event(),
    )
    monkeypatch.setattr(SyncService, "LOCK_HEARTBEAT_INTERVAL_SECONDS", 0.01)

    def slow_no_integrations(_source: str) -> list[dict[str, Any]]:
        time.sleep(0.1)  # long enough for several heartbeat ticks
        return []

    monkeypatch.setattr(service, "_enabled_integrations", slow_no_integrations)

    result = await service.run_sync("sonarr", "incremental", reason="test")

    assert result.status == "success"
    count_after_run = session.heartbeat_count()
    assert count_after_run >= 1, "lease must be renewed while the run is in flight"
    release_index = max(
        i for i, (sql, _) in enumerate(session.statements) if "delete from app.job_lock" in sql
    )
    last_heartbeat_index = max(
        i for i, (sql, _) in enumerate(session.statements) if "update app.job_lock" in sql
    )
    assert last_heartbeat_index < release_index, "heartbeat must stop before the lock is released"

    await asyncio.sleep(0.05)
    assert session.heartbeat_count() == count_after_run, "heartbeat must not outlive the run"


@pytest.mark.asyncio
async def test_mal_ingest_heartbeat_loop_renews_lease(monkeypatch: Any) -> None:
    session = LockRecordingSession()
    settings = SimpleNamespace(
        http_timeout_seconds=5.0,
        http_retry_attempts=1,
        mal_jikan_min_request_interval_seconds=0.0,
        mal_client_id="",
    )
    service = MalIngestService(settings, lambda: session)  # type: ignore[arg-type]
    monkeypatch.setattr(MalIngestService, "LOCK_HEARTBEAT_INTERVAL_SECONDS", 0.01)

    task = asyncio.create_task(service._heartbeat_lock_loop("mal:ingest", "owner-1"))
    await asyncio.sleep(0.05)
    task.cancel()

    assert session.heartbeat_count() >= 1
    params = next(p for sql, p in session.statements if "update app.job_lock" in sql)
    assert params is not None and params["lock_name"] == "mal:ingest"
