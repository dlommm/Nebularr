from __future__ import annotations

import json
from typing import Any

from cryptography.fernet import Fernet

from arrsync.config import Settings
from arrsync.services.alert_config_store import (
    ALERT_WEBHOOK_MIN_STATE_KEY,
    ALERT_WEBHOOK_NOTIFY_RECOVERY_KEY,
    ALERT_WEBHOOK_TIMEOUT_KEY,
    ALERT_WEBHOOK_URLS_KEY,
    read_alert_webhook_config,
    store_alert_webhook_options,
    store_alert_webhook_urls,
)


class FakeResult:
    def __init__(self, scalar_value: str | None = None) -> None:
        self._scalar_value = scalar_value

    def scalar_one_or_none(self) -> str | None:
        return self._scalar_value


class FakeSession:
    def __init__(self) -> None:
        self.settings: dict[str, str] = {}

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> FakeResult:
        sql = str(query).lower()
        if "select value from app.settings" in sql:
            key = str((params or {}).get("key", ""))
            return FakeResult(self.settings.get(key))
        if "insert into app.settings" in sql:
            if params:
                self.settings[str(params["key"])] = str(params["value"])
            return FakeResult()
        raise RuntimeError(f"unexpected SQL in fake session: {sql}")


def test_alert_config_store_roundtrip_encrypted_urls(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("APP_ENCRYPTION_KEY", Fernet.generate_key().decode("utf-8"))
    settings = Settings(
        alert_webhook_urls="",
        alert_webhook_timeout_seconds=10,
        alert_webhook_min_state="warning",
        alert_webhook_notify_recovery=True,
    )
    session = FakeSession()

    store_alert_webhook_urls(session, ["https://discord.example/webhook", "https://slack.example/webhook"])
    store_alert_webhook_options(session, timeout_seconds=15.0, min_state="critical", notify_recovery=False)

    encoded = json.loads(session.settings[ALERT_WEBHOOK_URLS_KEY])
    assert encoded and all(item.startswith("enc::") for item in encoded)
    loaded = read_alert_webhook_config(session, settings)

    assert loaded["webhook_urls"] == ["https://discord.example/webhook", "https://slack.example/webhook"]
    assert loaded["timeout_seconds"] == 15.0
    assert loaded["min_state"] == "critical"
    assert loaded["notify_recovery"] is False


def test_alert_config_store_falls_back_to_env_defaults() -> None:
    settings = Settings(
        alert_webhook_urls="https://env.example/webhook",
        alert_webhook_timeout_seconds=8,
        alert_webhook_min_state="warning",
        alert_webhook_notify_recovery=True,
    )
    session = FakeSession()
    loaded = read_alert_webhook_config(session, settings)

    assert loaded["webhook_urls"] == ["https://env.example/webhook"]
    assert loaded["timeout_seconds"] == 8
    assert loaded["min_state"] == "warning"
    assert loaded["notify_recovery"] is True
    assert ALERT_WEBHOOK_TIMEOUT_KEY not in session.settings
    assert ALERT_WEBHOOK_MIN_STATE_KEY not in session.settings
    assert ALERT_WEBHOOK_NOTIFY_RECOVERY_KEY not in session.settings
