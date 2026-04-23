from __future__ import annotations

import asyncio
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from arrsync.config import Settings
from arrsync.db import session_scope
from arrsync.services.sync_service import SyncService

log = logging.getLogger(__name__)


class SyncScheduler:
    def __init__(self, settings: Settings, sync_service: SyncService, session_factory: sessionmaker[Session]):
        self.settings = settings
        self.sync_service = sync_service
        self.session_factory = session_factory
        self.scheduler = AsyncIOScheduler(timezone=settings.scheduler_timezone)

    def start(self) -> None:
        self._seed_schedule_defaults()
        jobs = self._read_schedule_rows()
        incremental_cron = jobs.get("incremental", self.settings.incremental_cron)
        reconcile_cron = jobs.get("reconcile", self.settings.full_reconcile_cron)
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
        self.scheduler.start()
        log.info("scheduler started")

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
                      ('reconcile', :reconcile_cron, :tz, true, now())
                    on conflict (mode) do nothing
                    """
                ),
                {
                    "incremental_cron": self.settings.incremental_cron,
                    "reconcile_cron": self.settings.full_reconcile_cron,
                    "tz": self.settings.scheduler_timezone,
                },
            )

    def _read_schedule_rows(self) -> dict[str, str]:
        with session_scope(self.session_factory) as session:
            rows = session.execute(
                text("select mode, cron from app.sync_schedule where enabled = true")
            ).mappings()
            return {str(row["mode"]): str(row["cron"]) for row in rows}

    async def _run_incremental_tick(self) -> None:
        await asyncio.gather(
            self.sync_service.run_sync("sonarr", "incremental", reason="cron"),
            self.sync_service.run_sync("radarr", "incremental", reason="cron"),
        )
        await asyncio.gather(
            self.sync_service.process_webhook_queue("sonarr"),
            self.sync_service.process_webhook_queue("radarr"),
        )

    async def _run_reconcile_tick(self) -> None:
        await asyncio.gather(
            self.sync_service.run_sync("sonarr", "reconcile", reason="cron"),
            self.sync_service.run_sync("radarr", "reconcile", reason="cron"),
        )
