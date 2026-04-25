"""Wait for Postgres, bind SQLAlchemy, run migrations/seed, and start background services."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any
from urllib.parse import quote_plus

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from arrsync.config import Settings, get_settings
from arrsync.db import build_engine, build_session_factory, session_scope
from arrsync.deferred_session import DeferredSessionFactory
from arrsync.logging import apply_root_log_level
from arrsync.migrations import run_migrations
from arrsync.runtime_database_url import apply_runtime_database_url_to_environ
from arrsync.services import repository as repo
from arrsync.services.alert_config_store import read_alert_webhook_config
from arrsync.services.log_level_store import effective_log_level
from arrsync.validation import validate_settings

log = logging.getLogger(__name__)


def build_sqlalchemy_url(
    *,
    host: str,
    port: int,
    database: str,
    username: str,
    password: str,
) -> str:
    user = quote_plus(username)
    pw = quote_plus(password)
    db = quote_plus(database)
    return f"postgresql+psycopg://{user}:{pw}@{host}:{port}/{db}"


def wait_for_postgres(database_url: str, timeout_seconds: float = 120.0, interval_seconds: float = 2.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    last: BaseException | None = None
    while time.monotonic() < deadline:
        try:
            eng = create_engine(database_url, pool_pre_ping=True, future=True)
            with eng.connect() as conn:
                conn.execute(text("select 1"))
            eng.dispose()
            return
        except BaseException as exc:
            last = exc
            time.sleep(interval_seconds)
    raise TimeoutError(f"Postgres not reachable within {timeout_seconds}s") from last


def bind_database_engine(settings: Settings, session_factory: DeferredSessionFactory) -> Engine:
    engine = build_engine(settings)
    session_factory.bind(build_session_factory(engine))
    return engine


def dispose_bound_engine(app_state: Any) -> None:
    eng = getattr(app_state, "_engine", None)
    if eng is not None:
        try:
            eng.dispose()
        except Exception:
            log.exception("engine dispose failed")
        app_state._engine = None


def run_migrations_and_seed(app_state: Any, settings: Settings) -> None:
    validate_settings(settings, require_database_url=True)
    if settings.enable_bootstrap_migrations:
        run_migrations(settings)
    with session_scope(app_state.session_factory) as session:  # type: ignore[arg-type]
        repo.seed_default_integrations(
            session,
            sonarr_base_url=settings.sonarr_base_url,
            sonarr_api_key=settings.sonarr_api_key,
            radarr_base_url=settings.radarr_base_url,
            radarr_api_key=settings.radarr_api_key,
        )
        alert_config = read_alert_webhook_config(session, settings)
        resolved_log_level = effective_log_level(session, settings)
    apply_root_log_level(resolved_log_level)
    log.info("logging level active", extra={"effective_log_level": resolved_log_level})
    app_state._pending_alert_config = alert_config


def refresh_settings_from_environment() -> Settings:
    get_settings.cache_clear()
    apply_runtime_database_url_to_environ()
    return get_settings()


async def finalize_application_services(app_state: Any) -> None:
    """Alert webhooks, scheduler, and background tasks (idempotent)."""
    if getattr(app_state, "scheduler_started", False):
        return

    alert_config = getattr(app_state, "_pending_alert_config", None)
    if alert_config is None:
        with session_scope(app_state.session_factory) as session:  # type: ignore[arg-type]
            alert_config = read_alert_webhook_config(session, app_state.settings)
            resolved_log_level = effective_log_level(session, app_state.settings)
        apply_root_log_level(resolved_log_level)

    await app_state.alert_notifier.configure(
        webhook_urls=alert_config["webhook_urls"],
        timeout_seconds=alert_config["timeout_seconds"],
        min_state=alert_config["min_state"],
        notify_recovery=alert_config["notify_recovery"],
    )

    async def _detect_capabilities_background() -> None:
        try:
            await app_state.sync_service.detect_capabilities()
        except Exception:
            log.exception("capability detection background task failed")

    async def _run_health_alerts_background() -> None:
        stop_event = app_state.stop_event
        while not stop_event.is_set():
            try:
                with session_scope(app_state.session_factory) as session:  # type: ignore[arg-type]
                    from arrsync.services.health_service import compute_health_status

                    status_payload = compute_health_status(session, app_state.settings, app_state.metrics)
                await app_state.alert_notifier.maybe_send_health_alert(status_payload)
            except Exception:
                log.exception("health alert background task failed")
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=60)
            except TimeoutError:
                continue

    app_state.capability_task = asyncio.create_task(_detect_capabilities_background())
    app_state.health_alert_task = asyncio.create_task(_run_health_alerts_background())
    app_state.scheduler.start()
    app_state.scheduler_started = True
    log.info("scheduler and background tasks started")
