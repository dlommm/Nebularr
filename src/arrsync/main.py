from __future__ import annotations

import asyncio
import logging
import signal
import time
import uuid
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from typing import Any, Iterator

from fastapi import FastAPI
from fastapi import Request

from arrsync.api import build_router
from arrsync.config import Settings, get_settings
from arrsync.db import build_engine, build_session_factory, session_scope
from arrsync.logging import apply_root_log_level, configure_logging
from arrsync.metrics import Metrics
from arrsync.migrations import run_migrations
from arrsync.services.arr_client import ArrClient
from arrsync.services.alert_config_store import read_alert_webhook_config
from arrsync.services.alert_notifier import AlertNotifier
from arrsync.services.health_service import compute_health_status
from arrsync.mal.ingest_service import MalIngestService
from arrsync.mal.matcher_service import MalMatcherService
from arrsync.mal.tag_sync_service import MalTagSyncService
from arrsync.services.scheduler import SyncScheduler
from arrsync.services.sync_service import SyncService
from arrsync.services import repository as repo
from arrsync.services.log_level_store import effective_log_level
from arrsync.validation import validate_settings

log = logging.getLogger(__name__)


@dataclass
class AppState:
    settings: Settings
    metrics: Metrics
    sync_service: SyncService
    scheduler: SyncScheduler
    arr_client_class: type[ArrClient]
    stop_event: asyncio.Event
    session_factory: Any
    alert_notifier: AlertNotifier
    mal_ingest_service: MalIngestService | None = None
    mal_matcher_service: MalMatcherService | None = None
    mal_tag_sync_service: MalTagSyncService | None = None
    capability_task: asyncio.Task[None] | None = None
    health_alert_task: asyncio.Task[None] | None = None

    @contextmanager
    def session_scope(self) -> Iterator:
        with session_scope(self.session_factory) as session:
            yield session


settings = get_settings()
configure_logging(settings.log_level)

engine = build_engine(settings)
session_factory = build_session_factory(engine)
metrics = Metrics()
stop_event = asyncio.Event()

sonarr_client = ArrClient(settings, "sonarr")
radarr_client = ArrClient(settings, "radarr")
sync_service = SyncService(session_factory, sonarr_client, radarr_client, stop_event=stop_event)
mal_ingest_service = MalIngestService(settings, session_factory)
mal_matcher_service = MalMatcherService(settings, session_factory)
mal_tag_sync_service = MalTagSyncService(settings, session_factory)


async def _cron_mal_ingest() -> None:
    await mal_ingest_service.run(reason="cron")


async def _cron_mal_matcher() -> None:
    await asyncio.to_thread(mal_matcher_service.run, reason="cron")


async def _cron_mal_tag_sync() -> None:
    await mal_tag_sync_service.run(reason="cron")


scheduler = SyncScheduler(
    settings,
    sync_service,
    session_factory,
    mal_ingest_coro=_cron_mal_ingest,
    mal_matcher_coro=_cron_mal_matcher,
    mal_tag_sync_coro=_cron_mal_tag_sync,
)
alert_notifier = AlertNotifier(settings)

app_state = AppState(
    settings=settings,
    metrics=metrics,
    sync_service=sync_service,
    scheduler=scheduler,
    arr_client_class=ArrClient,
    stop_event=stop_event,
    session_factory=session_factory,
    alert_notifier=alert_notifier,
    mal_ingest_service=mal_ingest_service,
    mal_matcher_service=mal_matcher_service,
    mal_tag_sync_service=mal_tag_sync_service,
)

app = FastAPI(title="Nebularr Sync", version=settings.app_version)


@app.middleware("http")
async def request_context_middleware(request: Request, call_next: Any) -> Any:
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    started = time.perf_counter()
    response = await call_next(request)
    duration_ms = round((time.perf_counter() - started) * 1000, 2)
    response.headers["x-request-id"] = request_id
    log.info(
        "request complete",
        extra={
            "request_id": request_id,
            "method": request.method,
            "path": request.url.path,
            "status_code": response.status_code,
            "duration_ms": duration_ms,
        },
    )
    return response

app.include_router(build_router(app_state))


def _register_signal_handlers() -> None:
    loop = asyncio.get_running_loop()

    def _handle_signal() -> None:
        log.info("received shutdown signal")
        stop_event.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _handle_signal)
        except NotImplementedError:
            pass


@app.on_event("startup")
async def startup_event() -> None:
    validate_settings(settings)
    if settings.enable_bootstrap_migrations:
        run_migrations(settings)
    with session_scope(session_factory) as session:
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
    await alert_notifier.configure(
        webhook_urls=alert_config["webhook_urls"],
        timeout_seconds=alert_config["timeout_seconds"],
        min_state=alert_config["min_state"],
        notify_recovery=alert_config["notify_recovery"],
    )
    _register_signal_handlers()
    async def _detect_capabilities_background() -> None:
        try:
            await sync_service.detect_capabilities()
        except Exception:
            log.exception("capability detection background task failed")

    async def _run_health_alerts_background() -> None:
        while not stop_event.is_set():
            try:
                with session_scope(session_factory) as session:
                    status_payload = compute_health_status(session, settings, metrics)
                await alert_notifier.maybe_send_health_alert(status_payload)
            except Exception:
                log.exception("health alert background task failed")
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=60)
            except TimeoutError:
                continue

    app_state.capability_task = asyncio.create_task(_detect_capabilities_background())
    app_state.health_alert_task = asyncio.create_task(_run_health_alerts_background())
    scheduler.start()
    log.info("startup complete")


@app.on_event("shutdown")
async def shutdown_event() -> None:
    stop_event.set()
    scheduler.shutdown()
    if app_state.capability_task and not app_state.capability_task.done():
        app_state.capability_task.cancel()
        with suppress(asyncio.CancelledError):
            await app_state.capability_task
    if app_state.health_alert_task and not app_state.health_alert_task.done():
        app_state.health_alert_task.cancel()
        with suppress(asyncio.CancelledError):
            await app_state.health_alert_task
    log.info("shutdown complete")
