from __future__ import annotations

import json
from typing import Literal, TypedDict

from sqlalchemy import text
from sqlalchemy.orm import Session

from arrsync.config import Settings
from arrsync.security import decrypt_secret, encrypt_secret

ALERT_WEBHOOK_URLS_KEY = "app.alert_webhook_urls_enc_json"
ALERT_WEBHOOK_TIMEOUT_KEY = "app.alert_webhook_timeout_seconds"
ALERT_WEBHOOK_MIN_STATE_KEY = "app.alert_webhook_min_state"
ALERT_WEBHOOK_NOTIFY_RECOVERY_KEY = "app.alert_webhook_notify_recovery"
ALERT_WEBHOOK_EVENTS_KEY = "app.alert_webhook_events_json"
ALERT_EMAIL_CONFIG_KEY = "app.alert_email_json"
ALERT_EMAIL_PASSWORD_KEY = "app.alert_email_password_enc"

ALERT_EVENT_TYPES = ("health", "sync_failure", "dead_letter")


class AlertEmailConfig(TypedDict):
    enabled: bool
    host: str
    port: int
    username: str
    password: str
    from_address: str
    to_addresses: list[str]
    starttls: bool


DEFAULT_ALERT_EMAIL_CONFIG: AlertEmailConfig = {
    "enabled": False,
    "host": "",
    "port": 587,
    "username": "",
    "password": "",
    "from_address": "",
    "to_addresses": [],
    "starttls": True,
}


class AlertWebhookConfig(TypedDict):
    webhook_urls: list[str]
    timeout_seconds: float
    min_state: Literal["warning", "critical"]
    notify_recovery: bool
    events: dict[str, bool]
    email: AlertEmailConfig


def _get_setting(session: Session, key: str, default: str = "") -> str:
    value = session.execute(
        text("select value from app.settings where key = :key"),
        {"key": key},
    ).scalar_one_or_none()
    return str(value) if value is not None else default


def _set_setting(session: Session, key: str, value: str) -> None:
    session.execute(
        text(
            """
            insert into app.settings(key, value, updated_at)
            values(:key, :value, now())
            on conflict (key) do update
            set value = excluded.value,
                updated_at = now()
            """
        ),
        {"key": key, "value": value},
    )


def _parse_bool(value: str | bool, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def read_alert_webhook_config(session: Session, settings: Settings) -> AlertWebhookConfig:
    raw_urls = _get_setting(session, ALERT_WEBHOOK_URLS_KEY, "").strip()
    urls: list[str] = []
    if raw_urls:
        try:
            encoded_urls = json.loads(raw_urls)
            if isinstance(encoded_urls, list):
                for item in encoded_urls:
                    decrypted = decrypt_secret(str(item))
                    if decrypted:
                        urls.append(decrypted)
        except Exception:
            urls = []
    if not urls:
        urls = [url.strip() for url in settings.alert_webhook_urls.split(",") if url.strip()]
    timeout_raw = _get_setting(session, ALERT_WEBHOOK_TIMEOUT_KEY, "").strip()
    min_state_raw = _get_setting(session, ALERT_WEBHOOK_MIN_STATE_KEY, "").strip().lower()
    notify_raw = _get_setting(session, ALERT_WEBHOOK_NOTIFY_RECOVERY_KEY, "").strip()
    timeout_seconds = settings.alert_webhook_timeout_seconds
    if timeout_raw:
        try:
            timeout_seconds = max(float(timeout_raw), 1.0)
        except Exception:
            timeout_seconds = settings.alert_webhook_timeout_seconds
    if min_state_raw == "critical":
        min_state: Literal["warning", "critical"] = "critical"
    elif min_state_raw == "warning":
        min_state = "warning"
    else:
        min_state = settings.alert_webhook_min_state
    notify_recovery = _parse_bool(notify_raw, settings.alert_webhook_notify_recovery) if notify_raw else settings.alert_webhook_notify_recovery
    events = {name: True for name in ALERT_EVENT_TYPES}
    events_raw = _get_setting(session, ALERT_WEBHOOK_EVENTS_KEY, "").strip()
    if events_raw:
        try:
            stored_events = json.loads(events_raw)
            if isinstance(stored_events, dict):
                for name in ALERT_EVENT_TYPES:
                    if name in stored_events:
                        events[name] = _parse_bool(stored_events[name], True)
        except Exception:
            pass
    return {
        "webhook_urls": urls,
        "timeout_seconds": timeout_seconds,
        "min_state": min_state,
        "notify_recovery": notify_recovery,
        "events": events,
        "email": read_alert_email_config(session),
    }


def read_alert_email_config(session: Session) -> AlertEmailConfig:
    config: AlertEmailConfig = dict(DEFAULT_ALERT_EMAIL_CONFIG)  # type: ignore[assignment]
    config["to_addresses"] = []
    raw = _get_setting(session, ALERT_EMAIL_CONFIG_KEY, "").strip()
    if raw:
        try:
            stored = json.loads(raw)
        except Exception:
            stored = {}
        if isinstance(stored, dict):
            config["enabled"] = _parse_bool(stored.get("enabled", False), False)
            config["host"] = str(stored.get("host", "")).strip()
            try:
                config["port"] = max(1, min(int(stored.get("port", 587)), 65535))
            except (TypeError, ValueError):
                config["port"] = 587
            config["username"] = str(stored.get("username", "")).strip()
            config["from_address"] = str(stored.get("from_address", "")).strip()
            to_addresses = stored.get("to_addresses", [])
            if isinstance(to_addresses, list):
                config["to_addresses"] = [str(a).strip() for a in to_addresses if str(a).strip()]
            config["starttls"] = _parse_bool(stored.get("starttls", True), True)
    encrypted_password = _get_setting(session, ALERT_EMAIL_PASSWORD_KEY, "").strip()
    if encrypted_password:
        config["password"] = decrypt_secret(encrypted_password) or ""
    return config


def store_alert_email_config(
    session: Session,
    config: dict[str, object],
    *,
    password: str | None = None,
) -> None:
    """Persist the non-secret email fields; `password=None` keeps the stored one."""
    to_addresses = config.get("to_addresses", [])
    if not isinstance(to_addresses, list):
        to_addresses = []
    non_secret = {
        "enabled": _parse_bool(config.get("enabled", False), False),  # type: ignore[arg-type]
        "host": str(config.get("host", "")).strip(),
        "port": config.get("port", 587),
        "username": str(config.get("username", "")).strip(),
        "from_address": str(config.get("from_address", "")).strip(),
        "to_addresses": [str(a).strip() for a in to_addresses if str(a).strip()],
        "starttls": _parse_bool(config.get("starttls", True), True),  # type: ignore[arg-type]
    }
    _set_setting(session, ALERT_EMAIL_CONFIG_KEY, json.dumps(non_secret))
    if password is not None:
        _set_setting(session, ALERT_EMAIL_PASSWORD_KEY, encrypt_secret(password) if password else "")


def store_alert_webhook_urls(session: Session, webhook_urls: list[str]) -> None:
    encoded_urls = [encrypt_secret(url) for url in webhook_urls if url.strip()]
    _set_setting(session, ALERT_WEBHOOK_URLS_KEY, json.dumps(encoded_urls))


def store_alert_webhook_options(
    session: Session,
    *,
    timeout_seconds: float,
    min_state: Literal["warning", "critical"],
    notify_recovery: bool,
) -> None:
    _set_setting(session, ALERT_WEBHOOK_TIMEOUT_KEY, str(timeout_seconds))
    _set_setting(session, ALERT_WEBHOOK_MIN_STATE_KEY, min_state)
    _set_setting(session, ALERT_WEBHOOK_NOTIFY_RECOVERY_KEY, "true" if notify_recovery else "false")


def store_alert_webhook_events(session: Session, events: dict[str, bool]) -> None:
    normalized = {name: bool(events.get(name, True)) for name in ALERT_EVENT_TYPES}
    _set_setting(session, ALERT_WEBHOOK_EVENTS_KEY, json.dumps(normalized))
