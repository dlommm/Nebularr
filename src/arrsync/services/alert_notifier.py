from __future__ import annotations

import asyncio
import logging
import smtplib
from email.message import EmailMessage
from typing import Any, Literal
from urllib.parse import urlparse

import httpx

from arrsync.config import Settings
from arrsync.services.url_guard import EgressGuardedTransport

log = logging.getLogger(__name__)

_STATE_SEVERITY = {"ok": 0, "warning": 1, "critical": 2}

ALERT_EVENT_TYPES = ("health", "sync_failure", "dead_letter")

DEFAULT_ALERT_EVENTS: dict[str, bool] = {name: True for name in ALERT_EVENT_TYPES}


def detect_webhook_target(url: str) -> Literal["discord", "slack", "ntfy", "generic"]:
    lowered = url.lower()
    if lowered.startswith("ntfy://"):
        return "ntfy"
    if "discord.com/api/webhooks" in lowered or "discordapp.com/api/webhooks" in lowered:
        return "discord"
    if "hooks.slack.com" in lowered:
        return "slack"
    hostname = urlparse(lowered).hostname or ""
    if hostname == "ntfy.sh" or hostname.endswith(".ntfy.sh"):
        return "ntfy"
    return "generic"


def normalize_ntfy_url(url: str) -> str:
    """`ntfy://host/topic` is accepted as an explicit marker for self-hosted ntfy."""
    if url.lower().startswith("ntfy://"):
        return "https://" + url[len("ntfy://") :]
    return url


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
        self.egress_policy = settings.egress_policy
        self.timeout_seconds = settings.alert_webhook_timeout_seconds
        self.min_state = settings.alert_webhook_min_state
        self.notify_recovery = settings.alert_webhook_notify_recovery
        self.events: dict[str, bool] = dict(DEFAULT_ALERT_EVENTS)
        self.email: dict[str, Any] | None = None
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
        email: dict[str, Any] | None = None,
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
            if email is not None:
                self.email = dict(email)

    def _email_ready(self) -> bool:
        cfg = self.email
        return bool(cfg and cfg.get("enabled") and cfg.get("host") and cfg.get("to_addresses"))

    def _has_channels(self) -> bool:
        return bool(self.webhook_urls) or self._email_ready()

    async def snapshot(self) -> dict[str, Any]:
        async with self._lock:
            email = dict(self.email) if self.email else None
            if email is not None:
                email.pop("password", None)
            return {
                "webhook_urls": list(self.webhook_urls),
                "timeout_seconds": self.timeout_seconds,
                "min_state": self.min_state,
                "notify_recovery": self.notify_recovery,
                "events": dict(self.events),
                "email": email,
            }

    async def send_event(self, event_type: str, payload: dict[str, Any]) -> bool:
        """Push a non-health operational event (sync failure, dead-letter job)
        to every configured webhook, honoring the per-event enable flags."""
        if event_type not in ALERT_EVENT_TYPES or event_type == "health":
            return False
        async with self._lock:
            if not self._has_channels() or not self.events.get(event_type, True):
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
            return await self._deliver(title, message)

    async def send_test_message(self) -> bool:
        async with self._lock:
            if not self._has_channels():
                return False
            return await self._deliver(
                "Nebularr test notification",
                "If you can read this, alert notifications are configured correctly.",
            )

    async def maybe_send_health_alert(self, status_payload: dict[str, Any]) -> bool:
        if not self._has_channels() or not self.events.get("health", True):
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
            sent = await self._deliver("Nebularr health alert", message)
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

    async def _deliver(self, title: str, message: str) -> bool:
        """True when at least one configured channel accepted the message."""
        delivered = await self._post_webhooks(title, message)
        if self._email_ready():
            delivered = await self._send_email(title, message) or delivered
        return delivered

    async def _post_webhooks(self, title: str, message: str) -> bool:
        if not self.webhook_urls:
            return False
        delivered = False
        async with httpx.AsyncClient(
            timeout=self.timeout_seconds,
            transport=EgressGuardedTransport(policy=self.egress_policy),
        ) as client:
            for url in self.webhook_urls:
                target = detect_webhook_target(url)
                try:
                    if target == "ntfy":
                        response = await client.post(
                            normalize_ntfy_url(url),
                            content=message.encode("utf-8"),
                            headers={"Title": title},
                        )
                    else:
                        response = await client.post(url, json=format_webhook_payload(target, title, message))
                    response.raise_for_status()
                    delivered = True
                except Exception:
                    log.exception("failed to post alert webhook", extra={"webhook_url": url})
        return delivered

    async def _send_email(self, title: str, message: str) -> bool:
        cfg = dict(self.email or {})
        try:
            await asyncio.to_thread(self._send_email_sync, cfg, title, message)
            return True
        except Exception:
            log.exception(
                "failed to send alert email",
                extra={"smtp_host": str(cfg.get("host", "")), "smtp_port": cfg.get("port")},
            )
            return False

    def _send_email_sync(self, cfg: dict[str, Any], title: str, message: str) -> None:
        email_message = EmailMessage()
        email_message["Subject"] = title
        email_message["From"] = str(cfg.get("from_address") or cfg.get("username") or "nebularr@localhost")
        email_message["To"] = ", ".join(str(a) for a in cfg.get("to_addresses", []))
        email_message.set_content(message)
        host = str(cfg.get("host", ""))
        port = int(cfg.get("port", 587))
        timeout = max(float(self.timeout_seconds), 1.0)
        if port == 465:
            smtp: smtplib.SMTP = smtplib.SMTP_SSL(host, port, timeout=timeout)
        else:
            smtp = smtplib.SMTP(host, port, timeout=timeout)
        try:
            if port != 465 and bool(cfg.get("starttls", True)):
                smtp.starttls()
            username = str(cfg.get("username", ""))
            if username:
                smtp.login(username, str(cfg.get("password", "")))
            smtp.send_message(email_message)
        finally:
            smtp.quit()
