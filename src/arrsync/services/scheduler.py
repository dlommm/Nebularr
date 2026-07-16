from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy import text

from arrsync.config import Settings
from arrsync.db import session_scope
from arrsync.services import repository as repo
from arrsync.services.mal_config_store import read_mal_feature_flags
from arrsync.services.sync_service import SyncService

log = logging.getLogger(__name__)


class SyncScheduler:
    def __init__(
        self,
        settings: Settings,
        sync_service: SyncService,
        session_factory: Any,
        *,
        mal_ingest_coro: Callable[[], Awaitable[Any]] | None = None,
        mal_matcher_coro: Callable[[], Awaitable[Any]] | None = None,
        mal_tag_sync_coro: Callable[[], Awaitable[Any]] | None = None,
        coverage_tag_sync_coro: Callable[[], Awaitable[Any]] | None = None,
    ):
        self.settings = settings
        self.sync_service = sync_service
        self.session_factory = session_factory
        self._mal_ingest_coro = mal_ingest_coro
        self._mal_matcher_coro = mal_matcher_coro
        self._mal_tag_sync_coro = mal_tag_sync_coro
        self._coverage_tag_sync_coro = coverage_tag_sync_coro
        self.scheduler = AsyncIOScheduler(timezone=settings.scheduler_timezone)

    # Retry safety net: retrying webhook jobs wait for next_attempt_at, and the
    # realtime drain only wakes on newly received webhooks — so this runs
    # regardless of which cron schedules are enabled.
    WEBHOOK_DRAIN_INTERVAL_MINUTES = 5

    def _cron_trigger(self, mode: str, jobs: dict[str, dict[str, str]], default_cron: str) -> CronTrigger:
        """Trigger from the schedule row (cron + per-row timezone); one bad row
        falls back to the env defaults instead of killing scheduler start."""
        row = jobs.get(mode, {})
        cron = row.get("cron") or default_cron
        tz = row.get("timezone") or self.settings.scheduler_timezone
        try:
            return CronTrigger.from_crontab(cron, timezone=tz)
        except Exception:
            log.warning(
                "invalid schedule row; falling back to defaults",
                extra={"mode": mode, "cron": cron, "timezone": tz},
                exc_info=True,
            )
            return CronTrigger.from_crontab(default_cron, timezone=self.settings.scheduler_timezone)

    def start(self) -> None:
        self._seed_schedule_defaults()
        jobs = self._read_schedule_rows()
        mal_flags = self._read_mal_feature_flags()
        # Every mode is gated on an enabled schedule row; disabling a schedule in
        # the UI removes it from `jobs` and therefore from the scheduler.
        if "incremental" in jobs:
            self.scheduler.add_job(
                self._run_incremental_tick,
                self._cron_trigger("incremental", jobs, self.settings.incremental_cron),
                id="incremental",
                replace_existing=True,
            )
        if "reconcile" in jobs:
            self.scheduler.add_job(
                self._run_reconcile_tick,
                self._cron_trigger("reconcile", jobs, self.settings.full_reconcile_cron),
                id="reconcile",
                replace_existing=True,
            )
        if "stats_snapshot" in jobs:
            self.scheduler.add_job(
                self._run_stats_snapshot_tick,
                self._cron_trigger("stats_snapshot", jobs, self.settings.stats_snapshot_cron),
                id="stats_snapshot",
                replace_existing=True,
            )
        # "full" is opt-in: it has no seeded default row, so it only fires when the
        # operator saves an enabled full-sync schedule.
        if "full" in jobs:
            self.scheduler.add_job(
                self._run_full_tick,
                self._cron_trigger("full", jobs, self.settings.full_reconcile_cron),
                id="full",
                replace_existing=True,
            )
        if "integrity_audit" in jobs:
            self.scheduler.add_job(
                self._run_integrity_audit_tick,
                self._cron_trigger("integrity_audit", jobs, self.settings.integrity_audit_cron),
                id="integrity_audit",
                replace_existing=True,
            )
        if self._mal_ingest_coro and mal_flags["ingest_enabled"] and "mal_ingest" in jobs:
            self.scheduler.add_job(
                self._mal_ingest_coro,
                self._cron_trigger("mal_ingest", jobs, self.settings.mal_ingest_cron),
                id="mal_ingest",
                replace_existing=True,
            )
        if self._mal_matcher_coro and mal_flags["matcher_enabled"] and "mal_matcher" in jobs:
            self.scheduler.add_job(
                self._mal_matcher_coro,
                self._cron_trigger("mal_matcher", jobs, self.settings.mal_matcher_cron),
                id="mal_matcher",
                replace_existing=True,
            )
        if self._mal_tag_sync_coro and mal_flags["tagging_enabled"] and "mal_tag_sync" in jobs:
            self.scheduler.add_job(
                self._mal_tag_sync_coro,
                self._cron_trigger("mal_tag_sync", jobs, self.settings.mal_tag_sync_cron),
                id="mal_tag_sync",
                replace_existing=True,
            )
        if (
            self._coverage_tag_sync_coro
            and mal_flags["coverage_tagging_enabled"]
            and "coverage_tag_sync" in jobs
        ):
            self.scheduler.add_job(
                self._coverage_tag_sync_coro,
                self._cron_trigger("coverage_tag_sync", jobs, self.settings.coverage_tag_sync_cron),
                id="coverage_tag_sync",
                replace_existing=True,
            )
        self.scheduler.add_job(
            self._run_webhook_drain_tick,
            "interval",
            minutes=self.WEBHOOK_DRAIN_INTERVAL_MINUTES,
            id="webhook_drain",
            replace_existing=True,
        )
        self.scheduler.start()
        log.info(
            "scheduler started",
            extra={
                "active_modes": sorted(jobs),
                "incremental_cron": jobs.get("incremental", {}).get("cron", "(disabled)"),
                "reconcile_cron": jobs.get("reconcile", {}).get("cron", "(disabled)"),
                "mal_ingest": bool(self._mal_ingest_coro and mal_flags["ingest_enabled"]),
                "mal_matcher": bool(self._mal_matcher_coro and mal_flags["matcher_enabled"]),
                "mal_tag_sync": bool(self._mal_tag_sync_coro and mal_flags["tagging_enabled"]),
                "coverage_tag_sync": bool(
                    self._coverage_tag_sync_coro and mal_flags["coverage_tagging_enabled"]
                ),
            },
        )

    def shutdown(self) -> None:
        if self.scheduler.running:
            self.scheduler.shutdown(wait=False)
            log.info("scheduler stopped")

    def reload(self) -> None:
        self.shutdown()
        self.scheduler = AsyncIOScheduler(timezone=self.settings.scheduler_timezone)
        self.start()

    def _seed_schedule_defaults(self) -> None:
        with session_scope(self.session_factory) as session:
            session.execute(
                text(
                    """
                    insert into app.sync_schedule (mode, cron, timezone, enabled, updated_at)
                    values
                      ('incremental', :incremental_cron, :tz, true, now()),
                      ('reconcile', :reconcile_cron, :tz, true, now()),
                      ('stats_snapshot', :stats_snapshot_cron, :tz, true, now()),
                      ('integrity_audit', :integrity_audit_cron, :tz, false, now()),
                      ('mal_ingest', :mal_ingest_cron, :tz, true, now()),
                      ('mal_matcher', :mal_matcher_cron, :tz, true, now()),
                      ('mal_tag_sync', :mal_tag_sync_cron, :tz, true, now()),
                      ('coverage_tag_sync', :coverage_tag_sync_cron, :tz, true, now())
                    on conflict (mode) do nothing
                    """
                ),
                {
                    "incremental_cron": self.settings.incremental_cron,
                    "reconcile_cron": self.settings.full_reconcile_cron,
                    "stats_snapshot_cron": self.settings.stats_snapshot_cron,
                    "integrity_audit_cron": self.settings.integrity_audit_cron,
                    "mal_ingest_cron": self.settings.mal_ingest_cron,
                    "mal_matcher_cron": self.settings.mal_matcher_cron,
                    "mal_tag_sync_cron": self.settings.mal_tag_sync_cron,
                    "coverage_tag_sync_cron": self.settings.coverage_tag_sync_cron,
                    "tz": self.settings.scheduler_timezone,
                },
            )

    def _read_schedule_rows(self) -> dict[str, dict[str, str]]:
        with session_scope(self.session_factory) as session:
            rows = session.execute(
                text("select mode, cron, timezone from app.sync_schedule where enabled = true")
            ).mappings()
            return {
                str(row["mode"]): {
                    "cron": str(row["cron"]),
                    "timezone": str(row["timezone"] or ""),
                }
                for row in rows
            }

    def _read_mal_feature_flags(self) -> dict[str, bool]:
        with session_scope(self.session_factory) as session:
            return read_mal_feature_flags(session, self.settings)

    async def _run_incremental_tick(self) -> None:
        log.debug("scheduler tick: incremental + webhook drain")
        await asyncio.gather(
            self.sync_service.run_sync("sonarr", "incremental", reason="cron"),
            self.sync_service.run_sync("radarr", "incremental", reason="cron"),
        )
        await asyncio.gather(
            self.sync_service.process_webhook_queue("sonarr"),
            self.sync_service.process_webhook_queue("radarr"),
        )
        log.debug("scheduler tick: incremental complete")

    async def _run_webhook_drain_tick(self) -> None:
        log.debug("scheduler tick: webhook retry drain")
        await asyncio.gather(
            self.sync_service.process_webhook_queue("sonarr"),
            self.sync_service.process_webhook_queue("radarr"),
        )

    async def _run_full_tick(self) -> None:
        log.debug("scheduler tick: full")
        await asyncio.gather(
            self.sync_service.run_sync("sonarr", "full", reason="cron"),
            self.sync_service.run_sync("radarr", "full", reason="cron"),
        )
        log.debug("scheduler tick: full complete")

    async def _run_reconcile_tick(self) -> None:
        log.debug("scheduler tick: reconcile")
        await asyncio.gather(
            self.sync_service.run_sync("sonarr", "reconcile", reason="cron"),
            self.sync_service.run_sync("radarr", "reconcile", reason="cron"),
        )
        log.debug("scheduler tick: reconcile complete")

    async def _run_integrity_audit_tick(self) -> None:
        log.debug("scheduler tick: integrity audit")
        await asyncio.gather(
            self.sync_service.run_integrity_audit("sonarr", reason="cron"),
            self.sync_service.run_integrity_audit("radarr", reason="cron"),
        )
        log.debug("scheduler tick: integrity audit complete")

    async def _run_stats_snapshot_tick(self) -> None:
        log.debug("scheduler tick: library stats snapshot")

        def _capture() -> None:
            with session_scope(self.session_factory) as session:
                repo.capture_library_stat_snapshot(session)

        await asyncio.to_thread(_capture)
        log.debug("scheduler tick: library stats snapshot complete")
