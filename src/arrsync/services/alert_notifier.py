from __future__ import annotations

import asyncio
import logging
from typing import Any, Literal

import httpx

from arrsync.config import Settings

log = logging.getLogger(__name__)

_STATE_SEVERITY = {"ok": 0, "warning": 1, "critical": 2}


class AlertNotifier:
    def __init__(self, settings: Settings):
        self.webhook_urls = [url.strip() for url in settings.alert_webhook_urls.split(",") if url.strip()]
        self.timeout_seconds = settings.alert_webhook_timeout_seconds
        self.min_state = settings.alert_webhook_min_state
        self.notify_recovery = settings.alert_webhook_notify_recovery
        self._last_state: str | None = None
        self._last_reasons: tuple[str, ...] = ()
        self._lock = asyncio.Lock()

    async def configure(
        self,
        *,
        webhook_urls: list[str] | None = None,
        timeout_seconds: float | None = None,
        min_state: Literal["warning", "critical"] | None = None,
        notify_recovery: bool | None = None,
    ) -> None:
        async with self._lock:
            if webhook_urls is not None:
                self.webhook_urls = [url.strip() for url in webhook_urls if url.strip()]
            if timeout_seconds is not None:
                self.timeout_seconds = max(float(timeout_seconds), 1.0)
            if min_state is not None and min_state in _STATE_SEVERITY:
                self.min_state = min_state
            if notify_recovery is not None:
                self.notify_recovery = bool(notify_recovery)

    async def snapshot(self) -> dict[str, Any]:
        async with self._lock:
            return {
                "webhook_urls": list(self.webhook_urls),
                "timeout_seconds": self.timeout_seconds,
                "min_state": self.min_state,
                "notify_recovery": self.notify_recovery,
            }

    async def maybe_send_health_alert(self, status_payload: dict[str, Any]) -> bool:
        if not self.webhook_urls:
            return False
        try:
            state = str(status_payload.get("health_state", "ok")).lower()
            reasons = tuple(sorted(str(r) for r in status_payload.get("health_reasons", [])))
            if state not in _STATE_SEVERITY:
                state = "ok"
        except Exception:
            log.exception("failed to parse health payload for alert webhook")
            return False
        async with self._lock:
            if not self._should_send_alert(state, reasons):
                return False
            message = self._build_message(status_payload, state, reasons)
            payload = {"text": message, "content": message, "username": "Nebularr"}
            sent = await self._post_webhooks(payload)
            if sent:
                self._last_state = state
                self._last_reasons = reasons
            return sent

    def _should_send_alert(self, state: str, reasons: tuple[str, ...]) -> bool:
        if self._last_state == state and self._last_reasons == reasons:
            return False
        min_severity = _STATE_SEVERITY[self.min_state]
        state_severity = _STATE_SEVERITY[state]
        if state == "ok":
            return self.notify_recovery and self._last_state in {"warning", "critical"}
        return state_severity >= min_severity

    def _build_message(self, status_payload: dict[str, Any], state: str, reasons: tuple[str, ...]) -> str:
        queue_open = int(status_payload.get("webhook_queue_open", 0))
        active_syncs = int(status_payload.get("active_sync_count", 0))
        lag = status_payload.get("sync_lag_seconds", {})
        if not isinstance(lag, dict):
            lag = {}
        sonarr_lag = round(float(lag.get("sonarr", 0.0)), 1)
        radarr_lag = round(float(lag.get("radarr", 0.0)), 1)
        reasons_text = ", ".join(reasons) if reasons else "none"
        previous = self._last_state or "unknown"
        return (
            f"Nebularr health changed {previous} -> {state}. "
            f"reasons={reasons_text}; "
            f"queue_open={queue_open}; "
            f"active_syncs={active_syncs}; "
            f"lag_seconds(sonarr={sonarr_lag}, radarr={radarr_lag})"
        )

    async def _post_webhooks(self, payload: dict[str, Any]) -> bool:
        delivered = False
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            for url in self.webhook_urls:
                try:
                    response = await client.post(url, json=payload)
                    response.raise_for_status()
                    delivered = True
                except Exception:
                    log.exception("failed to post alert webhook", extra={"webhook_url": url})
        return delivered
