from __future__ import annotations

import asyncio
import logging
from typing import Any, Literal

import httpx

from arrsync.config import Settings

log = logging.getLogger(__name__)

_STATE_SEVERITY = {"ok": 0, "warning": 1, "critical": 2}

ALERT_EVENT_TYPES = ("health", "sync_failure", "dead_letter")

DEFAULT_ALERT_EVENTS: dict[str, bool] = {name: True for name in ALERT_EVENT_TYPES}


def detect_webhook_target(url: str) -> Literal["discord", "slack", "generic"]:
    lowered = url.lower()
    if "discord.com/api/webhooks" in lowered or "discordapp.com/api/webhooks" in lowered:
        return "discord"
    if "hooks.slack.com" in lowered:
        return "slack"
    return "generic"


def format_webhook_payload(target: str, title: str, message: str) -> dict[str, Any]:
    if target == "discord":
        return {"username": "Nebularr", "content": f"**{title}**\n{message}"}
    if target == "slack":
        return {"text": f"*{title}*\n{message}"}
    # Generic targets keep the historical dual-key shape (Slack reads `text`,
    # Discord reads `content`), so unknown services stay compatible.
    combined = f"{title}: {message}" if title else message
    return {"text": combined, "content": combined, "username": "Nebularr"}


class AlertNotifier:
    def __init__(self, settings: Settings):
        self.webhook_urls = [url.strip() for url in settings.alert_webhook_urls.split(",") if url.strip()]
        self.timeout_seconds = settings.alert_webhook_timeout_seconds
        self.min_state = settings.alert_webhook_min_state
        self.notify_recovery = settings.alert_webhook_notify_recovery
        self.events: dict[str, bool] = dict(DEFAULT_ALERT_EVENTS)
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
        events: dict[str, bool] | None = None,
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
            if events is not None:
                self.events = {
                    name: bool(events.get(name, DEFAULT_ALERT_EVENTS[name])) for name in ALERT_EVENT_TYPES
                }

    async def snapshot(self) -> dict[str, Any]:
        async with self._lock:
            return {
                "webhook_urls": list(self.webhook_urls),
                "timeout_seconds": self.timeout_seconds,
                "min_state": self.min_state,
                "notify_recovery": self.notify_recovery,
                "events": dict(self.events),
            }

    async def send_event(self, event_type: str, payload: dict[str, Any]) -> bool:
        """Push a non-health operational event (sync failure, dead-letter job)
        to every configured webhook, honoring the per-event enable flags."""
        if event_type not in ALERT_EVENT_TYPES or event_type == "health":
            return False
        async with self._lock:
            if not self.webhook_urls or not self.events.get(event_type, True):
                return False
            if event_type == "sync_failure":
                title = "Nebularr sync failed"
                message = (
                    f"{payload.get('source', '?')} {payload.get('mode', '?')} sync failed "
                    f"(instance={payload.get('instance_name', 'default')}, "
                    f"trigger={payload.get('trigger', '?')}, "
                    f"records={payload.get('records_processed', 0)})"
                )
                if payload.get("error"):
                    message += f": {str(payload['error'])[:400]}"
            else:
                title = "Nebularr webhook job dead-lettered"
                message = (
                    f"job #{payload.get('job_id', '?')} from {payload.get('source', '?')} "
                    f"({payload.get('event_type', 'unknown event')}) exhausted its retries"
                )
                if payload.get("error"):
                    message += f": {str(payload['error'])[:400]}"
            return await self._post_webhooks(title, message)

    async def send_test_message(self) -> bool:
        async with self._lock:
            if not self.webhook_urls:
                return False
            return await self._post_webhooks(
                "Nebularr test notification",
                "If you can read this, alert webhooks are configured correctly.",
            )

    async def maybe_send_health_alert(self, status_payload: dict[str, Any]) -> bool:
        if not self.webhook_urls or not self.events.get("health", True):
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
            sent = await self._post_webhooks("Nebularr health alert", message)
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
        dead_letter = int(status_payload.get("webhook_queue_dead_letter", 0))
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
            f"webhook_backlog={queue_open}; "
            f"webhook_dead_letter={dead_letter}; "
            f"active_syncs={active_syncs}; "
            f"lag_seconds(sonarr={sonarr_lag}, radarr={radarr_lag})"
        )

    async def _post_webhooks(self, title: str, message: str) -> bool:
        delivered = False
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            for url in self.webhook_urls:
                payload = format_webhook_payload(detect_webhook_target(url), title, message)
                try:
                    response = await client.post(url, json=payload)
                    response.raise_for_status()
                    delivered = True
                except Exception:
                    log.exception("failed to post alert webhook", extra={"webhook_url": url})
        return delivered
