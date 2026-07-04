from __future__ import annotations

import asyncio
import logging
import signal
import time
import uuid
from contextlib import asynccontextmanager, contextmanager, suppress
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Iterator

from fastapi import FastAPI
from fastapi import Request
from fastapi.responses import JSONResponse

from arrsync.api import build_router
from arrsync.auth import auth_required, enforce_auth
from arrsync.config import Settings, get_settings
from arrsync.runtime_secrets import encryption_at_rest_active
from arrsync.services.auth_store import read_setting
from arrsync.database_lifecycle import (
    bind_database_engine,
    dispose_bound_engine,
    finalize_application_services,
    run_migrations_and_seed,
)
from arrsync.db import session_scope
from arrsync.deferred_session import DeferredSessionFactory
from arrsync.logging import apply_root_log_level, configure_logging
from arrsync.metrics import Metrics
from arrsync.services.arr_client import ArrClient
from arrsync.services.alert_notifier import AlertNotifier
from arrsync.mal.ingest_service import MalIngestService
from arrsync.mal.matcher_service import MalMatcherService
from arrsync.mal.tag_sync_service import MalTagSyncService
from arrsync.services.scheduler import SyncScheduler
from arrsync.services.sync_service import SyncService
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
    session_factory: DeferredSessionFactory
    alert_notifier: AlertNotifier
    mal_ingest_service: MalIngestService | None = None
    mal_matcher_service: MalMatcherService | None = None
    mal_tag_sync_service: MalTagSyncService | None = None
    capability_task: asyncio.Task[None] | None = None
    health_alert_task: asyncio.Task[None] | None = None
    auth_config_cache: Any | None = field(default=None, repr=False)
    auth_config_cached_at: float = field(default=0.0, repr=False)
    _engine: Any | None = field(default=None, repr=False)
    _pending_alert_config: dict[str, Any] | None = field(default=None, repr=False)
    scheduler_started: bool = field(default=False, repr=False)

    @contextmanager
    def session_scope(self) -> Iterator:
        with session_scope(self.session_factory) as session:  # type: ignore[arg-type]
            yield session


settings = get_settings()
configure_logging(settings.log_level)

session_factory_holder = DeferredSessionFactory()
metrics = Metrics()
stop_event = asyncio.Event()

sonarr_client = ArrClient(settings, "sonarr")
radarr_client = ArrClient(settings, "radarr")
sync_service = SyncService(session_factory_holder, sonarr_client, radarr_client, stop_event=stop_event)
mal_ingest_service = MalIngestService(settings, session_factory_holder)
mal_matcher_service = MalMatcherService(settings, session_factory_holder)
mal_tag_sync_service = MalTagSyncService(settings, session_factory_holder)


async def _cron_mal_ingest() -> None:
    await mal_ingest_service.run(reason="cron")


async def _cron_mal_matcher() -> None:
    await asyncio.to_thread(mal_matcher_service.run, reason="cron")


async def _cron_mal_tag_sync() -> None:
    await mal_tag_sync_service.run(reason="cron")


scheduler = SyncScheduler(
    settings,
    sync_service,
    session_factory_holder,
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
    session_factory=session_factory_holder,
    alert_notifier=alert_notifier,
    mal_ingest_service=mal_ingest_service,
    mal_matcher_service=mal_matcher_service,
    mal_tag_sync_service=mal_tag_sync_service,
)

@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    await _startup()
    yield
    await _shutdown()


app = FastAPI(title="Nebularr Sync", version=settings.app_version, lifespan=_lifespan)


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


@app.middleware("http")
async def database_ready_gate(request: Request, call_next: Any) -> Any:
    if app_state.session_factory.ready:
        return await call_next(request)
    path = request.url.path
    if path.startswith(("/setup", "/assets/", "/api/setup")):
        return await call_next(request)
    if path in {"/healthz", "/metrics", "/docs", "/openapi.json", "/redoc", "/favicon.ico"}:
        return await call_next(request)
    if path == "/":
        return await call_next(request)
    return JSONResponse({"detail": "database not configured"}, status_code=503)


@app.middleware("http")
async def authentication_gate(request: Request, call_next: Any) -> Any:
    return await enforce_auth(request, call_next, app_state)


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


def _log_security_posture() -> None:
    """Loud, actionable warnings for insecure-but-supported configurations."""
    if not encryption_at_rest_active():
        log.warning(
            "SECURITY WARNING: secrets at rest are NOT encrypted (no APP_ENCRYPTION_KEY "
            "available); integration API keys are stored in plaintext in Postgres"
        )
    if not app_state.session_factory.ready:
        return
    if not auth_required(app_state):
        log.warning(
            "SECURITY WARNING: API authentication is disabled; anyone with network access "
            "to this service can read and modify its configuration, including stored API "
            "keys. Enable it under Settings → Authentication in the web UI (see SECURITY.md)."
        )
    with app_state.session_scope() as session:
        stored_webhook_hash = read_setting(session, "app.webhook_secret_hash")
    if not stored_webhook_hash and app_state.settings.webhook_shared_secret == "changeme":
        log.warning(
            "SECURITY WARNING: webhook shared secret is the default 'changeme'; set "
            "WEBHOOK_SHARED_SECRET or store a secret in the web UI setup wizard"
        )


async def _startup() -> None:
    _register_signal_handlers()
    if not settings.database_url:
        validate_settings(settings, require_database_url=False)
        apply_root_log_level(settings.log_level)
        log.warning("DATABASE_URL not configured; Web UI setup will connect to Postgres and run migrations")
        _log_security_posture()
        return
    validate_settings(settings)
    app_state._engine = bind_database_engine(settings, app_state.session_factory)
    await asyncio.to_thread(run_migrations_and_seed, app_state, settings)
    await finalize_application_services(app_state)
    _log_security_posture()
    log.info("startup complete")


async def _shutdown() -> None:
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
    await sonarr_client.aclose()
    await radarr_client.aclose()
    dispose_bound_engine(app_state)
    log.info("shutdown complete")
