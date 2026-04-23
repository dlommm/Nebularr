from __future__ import annotations

from typing import Any

import pytest

from arrsync.config import Settings
from arrsync.services.alert_notifier import AlertNotifier


@pytest.mark.asyncio
async def test_notifier_sends_only_on_state_change(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings(
        alert_webhook_urls="https://example.test/a",
        alert_webhook_min_state="warning",
        alert_webhook_notify_recovery=True,
    )
    notifier = AlertNotifier(settings)
    payloads: list[dict[str, Any]] = []

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

    class FakeAsyncClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            return None

        async def __aenter__(self) -> "FakeAsyncClient":
            return self

        async def __aexit__(self, *_args: Any) -> None:
            return None

        async def post(self, _url: str, json: dict[str, Any]) -> FakeResponse:
            payloads.append(json)
            return FakeResponse()

    monkeypatch.setattr("arrsync.services.alert_notifier.httpx.AsyncClient", FakeAsyncClient)

    sent_warning = await notifier.maybe_send_health_alert(
        {
            "health_state": "warning",
            "health_reasons": ["webhook_queue_warning"],
            "webhook_queue_open": 51,
            "active_sync_count": 0,
            "sync_lag_seconds": {"sonarr": 12, "radarr": 0},
        }
    )
    sent_warning_duplicate = await notifier.maybe_send_health_alert(
        {
            "health_state": "warning",
            "health_reasons": ["webhook_queue_warning"],
            "webhook_queue_open": 52,
            "active_sync_count": 0,
            "sync_lag_seconds": {"sonarr": 20, "radarr": 0},
        }
    )
    sent_critical = await notifier.maybe_send_health_alert(
        {
            "health_state": "critical",
            "health_reasons": ["sync_lag_critical"],
            "webhook_queue_open": 52,
            "active_sync_count": 0,
            "sync_lag_seconds": {"sonarr": 9000, "radarr": 0},
        }
    )
    sent_recovery = await notifier.maybe_send_health_alert(
        {
            "health_state": "ok",
            "health_reasons": [],
            "webhook_queue_open": 0,
            "active_sync_count": 0,
            "sync_lag_seconds": {"sonarr": 0, "radarr": 0},
        }
    )

    assert sent_warning is True
    assert sent_warning_duplicate is False
    assert sent_critical is True
    assert sent_recovery is True
    assert len(payloads) == 3
    assert "warning" in payloads[0]["text"]
    assert "critical" in payloads[1]["text"]
    assert "critical -> ok" in payloads[2]["text"]


@pytest.mark.asyncio
async def test_notifier_respects_min_state(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings(
        alert_webhook_urls="https://example.test/a",
        alert_webhook_min_state="critical",
        alert_webhook_notify_recovery=False,
    )
    notifier = AlertNotifier(settings)
    sent_payloads: list[dict[str, Any]] = []

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

    class FakeAsyncClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            return None

        async def __aenter__(self) -> "FakeAsyncClient":
            return self

        async def __aexit__(self, *_args: Any) -> None:
            return None

        async def post(self, _url: str, json: dict[str, Any]) -> FakeResponse:
            sent_payloads.append(json)
            return FakeResponse()

    monkeypatch.setattr("arrsync.services.alert_notifier.httpx.AsyncClient", FakeAsyncClient)

    sent_warning = await notifier.maybe_send_health_alert(
        {
            "health_state": "warning",
            "health_reasons": ["sync_lag_warning"],
            "webhook_queue_open": 0,
            "active_sync_count": 0,
            "sync_lag_seconds": {"sonarr": 1000, "radarr": 0},
        }
    )
    sent_critical = await notifier.maybe_send_health_alert(
        {
            "health_state": "critical",
            "health_reasons": ["sync_lag_critical"],
            "webhook_queue_open": 0,
            "active_sync_count": 0,
            "sync_lag_seconds": {"sonarr": 9000, "radarr": 0},
        }
    )
    sent_ok = await notifier.maybe_send_health_alert(
        {
            "health_state": "ok",
            "health_reasons": [],
            "webhook_queue_open": 0,
            "active_sync_count": 0,
            "sync_lag_seconds": {"sonarr": 0, "radarr": 0},
        }
    )

    assert sent_warning is False
    assert sent_critical is True
    assert sent_ok is False
    assert len(sent_payloads) == 1
