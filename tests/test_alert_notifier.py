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


def _install_fake_http(monkeypatch: pytest.MonkeyPatch, requests: list[tuple[str, dict[str, Any]]]) -> None:
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

        async def post(self, url: str, json: dict[str, Any]) -> FakeResponse:
            requests.append((url, json))
            return FakeResponse()

    monkeypatch.setattr("arrsync.services.alert_notifier.httpx.AsyncClient", FakeAsyncClient)


def test_detect_webhook_target() -> None:
    from arrsync.services.alert_notifier import detect_webhook_target

    assert detect_webhook_target("https://discord.com/api/webhooks/1/abc") == "discord"
    assert detect_webhook_target("https://discordapp.com/api/webhooks/1/abc") == "discord"
    assert detect_webhook_target("https://hooks.slack.com/services/T/B/x") == "slack"
    assert detect_webhook_target("https://example.test/notify") == "generic"


def test_format_webhook_payload_shapes() -> None:
    from arrsync.services.alert_notifier import format_webhook_payload

    discord = format_webhook_payload("discord", "Title", "body")
    assert discord == {"username": "Nebularr", "content": "**Title**\nbody"}
    assert "text" not in discord

    slack = format_webhook_payload("slack", "Title", "body")
    assert slack == {"text": "*Title*\nbody"}

    generic = format_webhook_payload("generic", "Title", "body")
    assert generic["text"] == generic["content"] == "Title: body"
    assert generic["username"] == "Nebularr"


@pytest.mark.asyncio
async def test_send_event_formats_per_target_url(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings(
        alert_webhook_urls="https://discord.com/api/webhooks/1/a,https://hooks.slack.com/services/T/B/x",
    )
    notifier = AlertNotifier(settings)
    requests: list[tuple[str, dict[str, Any]]] = []
    _install_fake_http(monkeypatch, requests)

    sent = await notifier.send_event(
        "sync_failure",
        {"source": "sonarr", "mode": "full", "instance_name": "default", "trigger": "cron", "error": "boom"},
    )

    assert sent is True
    assert len(requests) == 2
    by_url = dict(requests)
    discord_payload = by_url["https://discord.com/api/webhooks/1/a"]
    assert "content" in discord_payload and "text" not in discord_payload
    assert "sonarr full sync failed" in discord_payload["content"]
    slack_payload = by_url["https://hooks.slack.com/services/T/B/x"]
    assert "text" in slack_payload and "content" not in slack_payload
    assert "boom" in slack_payload["text"]


@pytest.mark.asyncio
async def test_send_event_respects_event_flags(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings(alert_webhook_urls="https://example.test/hook")
    notifier = AlertNotifier(settings)
    requests: list[tuple[str, dict[str, Any]]] = []
    _install_fake_http(monkeypatch, requests)

    await notifier.configure(events={"sync_failure": False, "dead_letter": True, "health": True})
    assert await notifier.send_event("sync_failure", {"source": "sonarr"}) is False
    assert requests == []

    assert await notifier.send_event("dead_letter", {"job_id": 3, "source": "radarr"}) is True
    assert len(requests) == 1


@pytest.mark.asyncio
async def test_health_alert_respects_health_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings(alert_webhook_urls="https://example.test/hook", alert_webhook_min_state="warning")
    notifier = AlertNotifier(settings)
    requests: list[tuple[str, dict[str, Any]]] = []
    _install_fake_http(monkeypatch, requests)

    await notifier.configure(events={"health": False, "sync_failure": True, "dead_letter": True})
    sent = await notifier.maybe_send_health_alert({"health_state": "critical", "health_reasons": ["x"]})
    assert sent is False
    assert requests == []


@pytest.mark.asyncio
async def test_send_test_message_hits_all_urls(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings(alert_webhook_urls="https://example.test/a,https://example.test/b")
    notifier = AlertNotifier(settings)
    requests: list[tuple[str, dict[str, Any]]] = []
    _install_fake_http(monkeypatch, requests)

    assert await notifier.send_test_message() is True
    assert len(requests) == 2
