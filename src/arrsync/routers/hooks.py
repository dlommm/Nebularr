"""Inbound Sonarr/Radarr webhook receiver."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from arrsync.security import verify_secret_hash
from arrsync.services import repository as repo
from arrsync.services.settings_store import get_setting

log = logging.getLogger(__name__)


def build_hooks_router(app_state: Any) -> APIRouter:
    router = APIRouter()

    @router.post("/hooks/{source}")
    @router.post("/hooks/{source}/{instance_name}")
    async def webhook(source: str, request: Request, instance_name: str | None = None) -> JSONResponse:
        if source not in {"sonarr", "radarr"}:
            raise HTTPException(status_code=404, detail="unknown source")

        received_secret = request.headers.get("x-arr-shared-secret", "")
        with app_state.session_scope() as session:
            stored_hash = get_setting(session, "app.webhook_secret_hash", "")
            # Legacy unsuffixed route: any enabled integration accepts the webhook
            # (the integration name is NOT required to be "default"); the event is
            # attributed to the sole enabled integration when it's unambiguous.
            ingest_allowed = repo.webhook_ingest_allowed(session, source, instance_name)
            if instance_name is None:
                enabled_names = repo.enabled_webhook_instance_names(session, source)
                resolved_instance = enabled_names[0] if len(enabled_names) == 1 else "default"
            else:
                resolved_instance = instance_name
        if stored_hash:
            if not verify_secret_hash(received_secret, stored_hash):
                raise HTTPException(status_code=401, detail="invalid secret")
        elif app_state.settings.webhook_shared_secret == "changeme":
            # Never accept traffic against the shipped default secret.
            raise HTTPException(
                status_code=403,
                detail="webhook shared secret is not configured; set one in Settings",
            )
        elif not app_state.arr_client_class.validate_webhook_secret(received_secret, app_state.settings.webhook_shared_secret):
            raise HTTPException(status_code=401, detail="invalid secret")
        if not ingest_allowed:
            raise HTTPException(status_code=403, detail="webhooks disabled for this source/instance")

        # Enforce the size cap on the bytes actually received: Content-Length can be
        # absent (chunked transfer) or malformed, so it cannot be trusted for the limit.
        max_body_bytes = app_state.settings.webhook_max_body_bytes

        async def _read_body_capped() -> bytes:
            chunks: list[bytes] = []
            received = 0
            async for chunk in request.stream():
                received += len(chunk)
                if received > max_body_bytes:
                    raise HTTPException(status_code=413, detail="payload too large")
                chunks.append(chunk)
            return b"".join(chunks)

        try:
            body = await asyncio.wait_for(_read_body_capped(), timeout=5.0)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=400, detail="invalid payload") from exc
        try:
            payload = json.loads(body)
            if not isinstance(payload, dict):
                raise ValueError("json payload must be object")
        except Exception as exc:
            raise HTTPException(status_code=400, detail="invalid payload") from exc

        event_type = str(payload.get("eventType", "unknown"))
        # Arr apps never send an instance identifier; stamp the resolved one before
        # the dedupe hash so identical events for different instances both queue.
        payload["instance_name"] = resolved_instance
        dedupe_key = hashlib.sha256(
            json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
        ).hexdigest()
        with app_state.session_scope() as session:
            repo.enqueue_webhook(session, source=source, event_type=event_type, payload=payload, dedupe_key=dedupe_key)
        app_state.metrics.inc("arrsync_webhooks_received_total")
        request_drain = getattr(app_state, "request_webhook_drain", None)
        if request_drain is not None:
            request_drain(source)
        log.info(
            "incoming webhook queued",
            extra={
                "webhook_source": source,
                "instance_name": resolved_instance,
                "event_type": event_type,
                "dedupe_key_prefix": dedupe_key[:12],
            },
        )
        return JSONResponse({"status": "accepted"})

    return router
