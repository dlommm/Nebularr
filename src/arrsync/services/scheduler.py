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
    ):
        self.settings = settings
        self.sync_service = sync_service
        self.session_factory = session_factory
        self._mal_ingest_coro = mal_ingest_coro
        self._mal_matcher_coro = mal_matcher_coro
        self._mal_tag_sync_coro = mal_tag_sync_coro
        self.scheduler = AsyncIOScheduler(timezone=settings.scheduler_timezone)

    def start(self) -> None:
        self._seed_schedule_defaults()
        jobs = self._read_schedule_rows()
        mal_flags = self._read_mal_feature_flags()
        incremental_cron = jobs.get("incremental", self.settings.incremental_cron)
        reconcile_cron = jobs.get("reconcile", self.settings.full_reconcile_cron)
        mal_ingest_cron = jobs.get("mal_ingest", self.settings.mal_ingest_cron)
        mal_matcher_cron = jobs.get("mal_matcher", self.settings.mal_matcher_cron)
        mal_tag_sync_cron = jobs.get("mal_tag_sync", self.settings.mal_tag_sync_cron)
        self.scheduler.add_job(
            self._run_incremental_tick,
            CronTrigger.from_crontab(incremental_cron, timezone=self.settings.scheduler_timezone),
            id="incremental",
            replace_existing=True,
        )
        self.scheduler.add_job(
            self._run_reconcile_tick,
            CronTrigger.from_crontab(reconcile_cron, timezone=self.settings.scheduler_timezone),
            id="reconcile",
            replace_existing=True,
        )
        if self._mal_ingest_coro and mal_flags["ingest_enabled"] and "mal_ingest" in jobs:
            self.scheduler.add_job(
                self._mal_ingest_coro,
                CronTrigger.from_crontab(mal_ingest_cron, timezone=self.settings.scheduler_timezone),
                id="mal_ingest",
                replace_existing=True,
            )
        if self._mal_matcher_coro and mal_flags["matcher_enabled"] and "mal_matcher" in jobs:
            self.scheduler.add_job(
                self._mal_matcher_coro,
                CronTrigger.from_crontab(mal_matcher_cron, timezone=self.settings.scheduler_timezone),
                id="mal_matcher",
                replace_existing=True,
            )
        if self._mal_tag_sync_coro and mal_flags["tagging_enabled"] and "mal_tag_sync" in jobs:
            self.scheduler.add_job(
                self._mal_tag_sync_coro,
                CronTrigger.from_crontab(mal_tag_sync_cron, timezone=self.settings.scheduler_timezone),
                id="mal_tag_sync",
                replace_existing=True,
            )
        self.scheduler.start()
        log.info(
            "scheduler started",
            extra={
                "incremental_cron": incremental_cron,
                "reconcile_cron": reconcile_cron,
                "mal_ingest": bool(self._mal_ingest_coro and mal_flags["ingest_enabled"]),
                "mal_matcher": bool(self._mal_matcher_coro and mal_flags["matcher_enabled"]),
                "mal_tag_sync": bool(self._mal_tag_sync_coro and mal_flags["tagging_enabled"]),
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
                      ('mal_ingest', :mal_ingest_cron, :tz, true, now()),
                      ('mal_matcher', :mal_matcher_cron, :tz, true, now()),
                      ('mal_tag_sync', :mal_tag_sync_cron, :tz, true, now())
                    on conflict (mode) do nothing
                    """
                ),
                {
                    "incremental_cron": self.settings.incremental_cron,
                    "reconcile_cron": self.settings.full_reconcile_cron,
                    "mal_ingest_cron": self.settings.mal_ingest_cron,
                    "mal_matcher_cron": self.settings.mal_matcher_cron,
                    "mal_tag_sync_cron": self.settings.mal_tag_sync_cron,
                    "tz": self.settings.scheduler_timezone,
                },
            )

    def _read_schedule_rows(self) -> dict[str, str]:
        with session_scope(self.session_factory) as session:
            rows = session.execute(
                text("select mode, cron from app.sync_schedule where enabled = true")
            ).mappings()
            return {str(row["mode"]): str(row["cron"]) for row in rows}

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

    async def _run_reconcile_tick(self) -> None:
        log.debug("scheduler tick: reconcile")
        await asyncio.gather(
            self.sync_service.run_sync("sonarr", "reconcile", reason="cron"),
            self.sync_service.run_sync("radarr", "reconcile", reason="cron"),
        )
        log.debug("scheduler tick: reconcile complete")
