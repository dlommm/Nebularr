from __future__ import annotations

from urllib.parse import urlparse

from apscheduler.triggers.cron import CronTrigger

from arrsync.config import Settings


def validate_settings(settings: Settings, *, require_database_url: bool = True) -> None:
    if require_database_url:
        if not settings.database_url or not settings.database_url.startswith("postgresql"):
            raise ValueError("DATABASE_URL must be set to a PostgreSQL SQLAlchemy URL")
    for key, value in (
        ("SONARR_BASE_URL", settings.sonarr_base_url),
        ("RADARR_BASE_URL", settings.radarr_base_url),
    ):
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError(f"{key} must be a valid http/https URL")
    for webhook_url in (url.strip() for url in settings.alert_webhook_urls.split(",") if url.strip()):
        parsed = urlparse(webhook_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("ALERT_WEBHOOK_URLS must contain valid http/https URLs")
    CronTrigger.from_crontab(settings.incremental_cron, timezone=settings.scheduler_timezone)
    CronTrigger.from_crontab(settings.full_reconcile_cron, timezone=settings.scheduler_timezone)
    if settings.mal_ingest_enabled:
        CronTrigger.from_crontab(settings.mal_ingest_cron, timezone=settings.scheduler_timezone)
    if settings.mal_matcher_enabled:
        CronTrigger.from_crontab(settings.mal_matcher_cron, timezone=settings.scheduler_timezone)
    if settings.mal_tagging_enabled:
        CronTrigger.from_crontab(settings.mal_tag_sync_cron, timezone=settings.scheduler_timezone)
