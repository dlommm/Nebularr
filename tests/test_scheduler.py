from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from arrsync.services.scheduler import SyncScheduler
from tests.fakes import FakeResult, FakeSession


class ScheduleFakeSession(FakeSession):
    """FakeSession plus the two app.sync_schedule statements the scheduler issues."""

    def __init__(self, schedule_rows: list[dict[str, str]] | None = None) -> None:
        super().__init__()
        self.schedule_rows = schedule_rows or []
        self.seeded = False

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> FakeResult:
        sql = " ".join(str(query).lower().split())
        if "insert into app.sync_schedule" in sql:
            self.statements.append((sql, params))
            self.seeded = True
            return FakeResult()
        if "select mode, cron from app.sync_schedule" in sql:
            self.statements.append((sql, params))
            return FakeResult(rows=self.schedule_rows)
        return super().execute(query, params)


def _build_settings(**overrides: Any) -> Any:
    defaults = dict(
        scheduler_timezone="UTC",
        incremental_cron="*/30 * * * *",
        full_reconcile_cron="0 4 * * 0",
        stats_snapshot_cron="10 3 * * *",
        mal_ingest_cron="0 5 * * *",
        mal_matcher_cron="30 5 * * *",
        mal_tag_sync_cron="0 6 * * *",
        mal_ingest_enabled=False,
        mal_matcher_enabled=False,
        mal_tagging_enabled=False,
        mal_allow_title_year_match=False,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def _build_scheduler(
    session: ScheduleFakeSession,
    settings: Any,
    **kwargs: Any,
) -> SyncScheduler:
    return SyncScheduler(
        settings,
        sync_service=SimpleNamespace(),  # ticks are never fired in these tests
        session_factory=lambda: session,
        **kwargs,
    )


@pytest.mark.asyncio
async def test_start_seeds_defaults_and_registers_core_jobs() -> None:
    session = ScheduleFakeSession(
        schedule_rows=[
            {"mode": "incremental", "cron": "*/15 * * * *"},
            {"mode": "reconcile", "cron": "0 3 * * 0"},
            {"mode": "stats_snapshot", "cron": "10 3 * * *"},
        ]
    )
    scheduler = _build_scheduler(session, _build_settings())
    scheduler.start()
    try:
        job_ids = {job.id for job in scheduler.scheduler.get_jobs()}
        assert job_ids == {"incremental", "reconcile", "stats_snapshot"}
        assert session.seeded, "schedule defaults must be seeded on start"
        seed_params = next(p for sql, p in session.statements if "insert into app.sync_schedule" in sql)
        assert seed_params is not None
        assert seed_params["incremental_cron"] == "*/30 * * * *"
    finally:
        scheduler.shutdown()


@pytest.mark.asyncio
async def test_mal_jobs_only_registered_when_flag_and_row_and_coro_present() -> None:
    async def mal_ingest() -> None:
        return None

    session = ScheduleFakeSession(
        schedule_rows=[
            {"mode": "incremental", "cron": "*/30 * * * *"},
            {"mode": "reconcile", "cron": "0 4 * * 0"},
            {"mode": "mal_ingest", "cron": "0 5 * * *"},
        ]
    )
    settings = _build_settings(mal_ingest_enabled=True)
    scheduler = _build_scheduler(session, settings, mal_ingest_coro=mal_ingest)
    scheduler.start()
    try:
        job_ids = {job.id for job in scheduler.scheduler.get_jobs()}
        assert "mal_ingest" in job_ids
        # matcher/tag-sync have no coro and flags off — must not be scheduled
        assert "mal_matcher" not in job_ids
        assert "mal_tag_sync" not in job_ids
    finally:
        scheduler.shutdown()


@pytest.mark.asyncio
async def test_mal_job_skipped_when_flag_disabled() -> None:
    async def mal_ingest() -> None:
        return None

    session = ScheduleFakeSession(
        schedule_rows=[{"mode": "mal_ingest", "cron": "0 5 * * *"}]
    )
    scheduler = _build_scheduler(session, _build_settings(), mal_ingest_coro=mal_ingest)
    scheduler.start()
    try:
        job_ids = {job.id for job in scheduler.scheduler.get_jobs()}
        assert "mal_ingest" not in job_ids
    finally:
        scheduler.shutdown()
