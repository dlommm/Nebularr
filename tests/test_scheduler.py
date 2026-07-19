from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from arrsync.services.scheduler import SyncScheduler
from fakes import FakeResult, FakeSession


class ScheduleFakeSession(FakeSession):
    """FakeSession plus the two app.sync_schedule statements the scheduler issues."""

    def __init__(self, schedule_rows: list[dict[str, str]] | None = None) -> None:
        super().__init__()
        # Rows may omit "timezone"; default to empty (falls back to global tz).
        self.schedule_rows = [{"timezone": "", **row} for row in (schedule_rows or [])]
        self.seeded = False

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> FakeResult:
        sql = " ".join(str(query).lower().split())
        if "insert into app.sync_schedule" in sql:
            self.statements.append((sql, params))
            self.seeded = True
            return FakeResult()
        if "select mode, cron, timezone from app.sync_schedule" in sql:
            self.statements.append((sql, params))
            return FakeResult(rows=self.schedule_rows)
        return super().execute(query, params)


def _build_settings(**overrides: Any) -> Any:
    defaults = dict(
        scheduler_timezone="UTC",
        incremental_cron="*/30 * * * *",
        full_reconcile_cron="0 4 * * 0",
        stats_snapshot_cron="10 3 * * *",
        integrity_audit_cron="30 5 * * 0",
        mal_ingest_cron="0 5 * * *",
        mal_matcher_cron="30 5 * * *",
        mal_tag_sync_cron="0 6 * * *",
        coverage_tag_sync_cron="30 6 * * *",
        mal_ingest_enabled=False,
        mal_matcher_enabled=False,
        mal_tagging_enabled=False,
        mal_allow_title_year_match=False,
        mal_dubs_source_enabled=True,
        mydublist_enabled=True,
        coverage_tagging_enabled=False,
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


# The retry-drain interval job is registered unconditionally.
ALWAYS_ON_JOBS = {"webhook_drain"}


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
        assert job_ids == {"incremental", "reconcile", "stats_snapshot"} | ALWAYS_ON_JOBS
        assert session.seeded, "schedule defaults must be seeded on start"
        seed_params = next(p for sql, p in session.statements if "insert into app.sync_schedule" in sql)
        assert seed_params is not None
        assert seed_params["incremental_cron"] == "*/30 * * * *"
    finally:
        scheduler.shutdown()


@pytest.mark.asyncio
async def test_disabled_incremental_and_reconcile_are_not_scheduled() -> None:
    # Rows exist only for enabled schedules; a disabled incremental/reconcile
    # must not fall back to the env-default cron (pre-2.6 regression).
    session = ScheduleFakeSession(
        schedule_rows=[{"mode": "stats_snapshot", "cron": "10 3 * * *"}]
    )
    scheduler = _build_scheduler(session, _build_settings())
    scheduler.start()
    try:
        job_ids = {job.id for job in scheduler.scheduler.get_jobs()}
        assert "incremental" not in job_ids
        assert "reconcile" not in job_ids
        # The retry drain still runs so retrying webhook jobs never stall.
        assert "webhook_drain" in job_ids
    finally:
        scheduler.shutdown()


@pytest.mark.asyncio
async def test_per_schedule_timezone_is_honored() -> None:
    session = ScheduleFakeSession(
        schedule_rows=[
            {"mode": "incremental", "cron": "*/15 * * * *", "timezone": "Europe/Berlin"},
            {"mode": "reconcile", "cron": "0 3 * * 0"},
        ]
    )
    scheduler = _build_scheduler(session, _build_settings())
    scheduler.start()
    try:
        incremental = scheduler.scheduler.get_job("incremental")
        reconcile = scheduler.scheduler.get_job("reconcile")
        assert incremental is not None and reconcile is not None
        assert incremental.trigger.timezone == ZoneInfo("Europe/Berlin")
        assert str(reconcile.trigger.timezone) == "UTC"
    finally:
        scheduler.shutdown()


@pytest.mark.asyncio
async def test_bad_schedule_row_falls_back_to_env_defaults() -> None:
    session = ScheduleFakeSession(
        schedule_rows=[{"mode": "incremental", "cron": "not a cron", "timezone": "Nope/Nowhere"}]
    )
    scheduler = _build_scheduler(session, _build_settings())
    scheduler.start()
    try:
        incremental = scheduler.scheduler.get_job("incremental")
        assert incremental is not None, "bad row must fall back, not kill scheduling"
        assert str(incremental.trigger.timezone) == "UTC"
    finally:
        scheduler.shutdown()


@pytest.mark.asyncio
async def test_opt_in_full_and_integrity_jobs_registered_when_rows_enabled() -> None:
    session = ScheduleFakeSession(
        schedule_rows=[
            {"mode": "incremental", "cron": "*/30 * * * *"},
            {"mode": "reconcile", "cron": "0 4 * * 0"},
            {"mode": "full", "cron": "0 2 1 * *"},
            {"mode": "integrity_audit", "cron": "30 5 * * 0"},
        ]
    )
    scheduler = _build_scheduler(session, _build_settings())
    scheduler.start()
    try:
        job_ids = {job.id for job in scheduler.scheduler.get_jobs()}
        assert "full" in job_ids
        assert "integrity_audit" in job_ids
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


@pytest.mark.asyncio
async def test_coverage_tag_sync_registered_when_flag_row_and_coro_present() -> None:
    async def coverage_tag_sync() -> None:
        return None

    session = ScheduleFakeSession(
        schedule_rows=[
            {"mode": "incremental", "cron": "*/30 * * * *"},
            {"mode": "reconcile", "cron": "0 4 * * 0"},
            {"mode": "coverage_tag_sync", "cron": "30 6 * * *"},
        ]
    )
    settings = _build_settings(coverage_tagging_enabled=True)
    scheduler = _build_scheduler(session, settings, coverage_tag_sync_coro=coverage_tag_sync)
    scheduler.start()
    try:
        job_ids = {job.id for job in scheduler.scheduler.get_jobs()}
        assert "coverage_tag_sync" in job_ids
    finally:
        scheduler.shutdown()


@pytest.mark.asyncio
async def test_coverage_tag_sync_skipped_when_flag_disabled() -> None:
    async def coverage_tag_sync() -> None:
        return None

    session = ScheduleFakeSession(
        schedule_rows=[{"mode": "coverage_tag_sync", "cron": "30 6 * * *"}]
    )
    scheduler = _build_scheduler(session, _build_settings(), coverage_tag_sync_coro=coverage_tag_sync)
    scheduler.start()
    try:
        job_ids = {job.id for job in scheduler.scheduler.get_jobs()}
        assert "coverage_tag_sync" not in job_ids
    finally:
        scheduler.shutdown()


@pytest.mark.asyncio
async def test_reload_from_threadpool_worker_rebinds_captured_loop() -> None:
    # Regression: the sync setup-wizard and config endpoints run in a FastAPI
    # threadpool worker and call reload(). The fresh AsyncIOScheduler must reuse the
    # loop captured at first start; before the fix it called asyncio.get_running_loop()
    # in the worker and raised "RuntimeError: no running event loop", 500-ing setup.
    session = ScheduleFakeSession(
        schedule_rows=[{"mode": "incremental", "cron": "*/15 * * * *"}]
    )
    scheduler = _build_scheduler(session, _build_settings())
    scheduler.start()  # first start binds to the running loop
    try:
        await asyncio.to_thread(scheduler.reload)  # must not raise off the loop thread
        assert scheduler.scheduler.running
        job_ids = {job.id for job in scheduler.scheduler.get_jobs()}
        assert "incremental" in job_ids
    finally:
        scheduler.shutdown()
