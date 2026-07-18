"""Health, metrics, and status endpoints."""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import PlainTextResponse
from sqlalchemy import text

from arrsync.auth import (
    auth_required,
    request_is_authenticated,
)
from arrsync.runtime_secrets import encryption_at_rest_active
from arrsync.services.health_service import compute_health_status
from arrsync.services.settings_store import get_setting

log = logging.getLogger(__name__)

STATUS_CACHE_TTL_SECONDS = 10.0


def build_system_router(app_state: Any) -> APIRouter:
    router = APIRouter()

    @router.get("/healthz")
    def healthz() -> dict[str, Any]:
        payload: dict[str, Any] = {
            "status": "ok",
            "version": app_state.settings.app_version,
            "git_sha": app_state.settings.app_git_sha,
            "time": datetime.now(timezone.utc).isoformat(),
            "encryption": "ok" if encryption_at_rest_active() else "plaintext",
        }
        if not app_state.session_factory.ready:
            payload["database"] = "not_configured"
            payload["auth"] = "disabled"
            return payload
        with app_state.session_scope() as session:
            session.execute(text("select 1"))
            stored_webhook_hash = get_setting(session, "app.webhook_secret_hash", "")
        payload["database"] = "ok"
        payload["auth"] = "enabled" if auth_required(app_state) else "disabled"
        if not stored_webhook_hash and app_state.settings.webhook_shared_secret == "changeme":
            payload["webhook_secret"] = "default"
        return payload

    @router.get("/metrics")
    def metrics(request: Request) -> PlainTextResponse:
        # /metrics sits outside the /api/* auth gate (Prometheus scrapers rarely carry
        # a session cookie), so once auth is enabled it must gate itself — unless the
        # operator has explicitly opted into public metrics via app.metrics_public.
        if auth_required(app_state):
            with app_state.session_scope() as session:
                public = get_setting(session, "app.metrics_public", "false").lower() == "true"
            if not public and not request_is_authenticated(request, app_state):
                raise HTTPException(status_code=401, detail="authentication required")
        return PlainTextResponse(app_state.metrics.render_prometheus(), media_type="text/plain")

    @router.get("/api/status")
    def status() -> dict[str, Any]:
        # Health alerts fire from the background loop in database_lifecycle (every 60s);
        # kicking one off per status poll duplicated alerts and leaked untracked tasks.
        # The loop also refreshes app_state.status_cache, so most polls are served
        # without re-running the ~8 health queries.
        cached = getattr(app_state, "status_cache", None)
        if cached is not None and time.monotonic() - cached[1] < STATUS_CACHE_TTL_SECONDS:
            return cached[0]
        with app_state.session_scope() as session:
            status_payload = compute_health_status(session, app_state.settings, app_state.metrics)
        app_state.status_cache = (status_payload, time.monotonic())
        return status_payload

    return router
