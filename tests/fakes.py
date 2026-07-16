"""Shared fakes for API-level tests (no real Postgres).

FakeSession answers the small set of SQL shapes the handlers under test issue;
anything unexpected raises so tests fail loudly instead of silently passing.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, Iterator

from arrsync.events import EventBus


class FakeResult:
    def __init__(self, scalar_value: Any = None, rows: list[Any] | None = None) -> None:
        self._scalar_value = scalar_value
        self._rows = rows or []

    def scalar_one_or_none(self) -> Any:
        return self._scalar_value

    def scalar_one(self) -> Any:
        return self._scalar_value

    def scalar(self) -> Any:
        return self._scalar_value

    def first(self) -> Any:
        return self._rows[0] if self._rows else None

    def mappings(self) -> list[Any]:
        return self._rows

    def fetchall(self) -> list[Any]:
        return self._rows

    def __iter__(self) -> Any:
        return iter(self._rows)


class FakeSession:
    """Backs app.settings reads/writes plus a few write-only statements."""

    def __init__(self) -> None:
        self.settings: dict[str, str] = {}
        self.statements: list[tuple[str, dict[str, Any] | None]] = []
        self.webhook_ingest_allowed = True
        # None means "any instance name passes"; a set restricts the lookup.
        self.known_webhook_instances: set[str] | None = None
        # Names returned by enabled_webhook_instance_names (legacy-route stamping).
        self.enabled_webhook_names: list[str] = ["default"]
        self.job_lock_held = False

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> FakeResult:
        sql = " ".join(str(query).lower().split())
        self.statements.append((sql, params))
        if "select value from app.settings" in sql:
            key = str((params or {}).get("key", ""))
            return FakeResult(self.settings.get(key))
        if "insert into app.settings" in sql:
            if params:
                self.settings[str(params["key"])] = str(params["value"])
            return FakeResult()
        if "delete from app.settings" in sql:
            if params:
                self.settings.pop(str(params["key"]), None)
            return FakeResult()
        if sql.strip() == "select 1":
            return FakeResult(1)
        if "insert into app.webhook_queue" in sql:
            return FakeResult()
        if "from app.job_lock" in sql:
            return FakeResult(rows=[(1,)] if self.job_lock_held else [])
        if "select name from app.integration_instance" in sql:
            names = self.enabled_webhook_names if self.webhook_ingest_allowed else []
            return FakeResult(rows=[(name,) for name in names])
        if "from app.integration_instance" in sql and "webhook_enabled" in sql:
            allowed = self.webhook_ingest_allowed
            if allowed and params and "instance_name" in params and self.known_webhook_instances is not None:
                allowed = str(params["instance_name"]) in self.known_webhook_instances
            return FakeResult(rows=[(1,)] if allowed else [])
        raise RuntimeError(f"unexpected SQL in fake session: {sql}")

    # No-ops so this fake also works under the real db.session_scope().
    def commit(self) -> None:
        return None

    def rollback(self) -> None:
        return None

    def close(self) -> None:
        return None


@dataclass
class FakeSettings:
    app_version: str = "test"
    app_git_sha: str = "sha"
    alert_webhook_queue_critical: int = 100
    alert_webhook_queue_warning: int = 50
    alert_sync_lag_critical_seconds: int = 7200
    alert_sync_lag_warning_seconds: int = 3600
    webhook_max_body_bytes: int = 1024
    # Non-default on purpose: the receiver refuses traffic while the shipped
    # default ("changeme") is still in place.
    webhook_shared_secret: str = "test-webhook-secret"
    alert_webhook_urls: str = ""
    alert_webhook_timeout_seconds: float = 10.0
    alert_webhook_min_state: str = "warning"
    alert_webhook_notify_recovery: bool = True
    scheduler_timezone: str = "UTC"
    egress_policy: str = "open"
    log_level: str = "INFO"
    auth_enabled: str = ""
    auth_recovery_password: str = ""
    auth_session_ttl_hours: int = 1
    trusted_proxies: str = ""
    arr_dub_tag_label: str = "English-Dubbed-Anime"
    arr_coverage_full_tag_label: str = "fully-english"
    arr_coverage_partial_tag_label: str = "partial-english"
    database_url: str = ""
    mal_client_id: str = ""
    mal_dub_info_url: str = ""
    mal_jikan_min_request_interval_seconds: float = 1.0
    mal_max_ids_per_run: int = 200
    mal_min_request_interval_seconds: float = 0.6
    mal_dubs_source_enabled: bool = True
    mydublist_enabled: bool = True
    mydublist_url_template: str = (
        "https://raw.githubusercontent.com/Joelis57/MyDubList/main/dubs/confidence/{tier}/dubbed_english.json"
    )
    mydublist_confidence_tier: str = "normal"
    coverage_tagging_enabled: bool = False
    coverage_tag_sync_cron: str = "30 4 * * *"


class FakeMetrics:
    def set_gauge(self, _name: str, _value: float) -> None:
        return None

    def inc(self, _name: str) -> None:
        return None


@dataclass
class FakeAppState:
    settings: FakeSettings = field(default_factory=FakeSettings)
    metrics: FakeMetrics = field(default_factory=FakeMetrics)
    auth_config_cache: Any = None
    auth_config_cached_at: float = 0.0

    def __post_init__(self) -> None:
        self.arr_client_class = type(
            "ArrClient", (), {"validate_webhook_secret": staticmethod(lambda given, expected: given == expected)}
        )
        self.session = FakeSession()
        self.session_factory = SimpleNamespace(ready=True, unbind=lambda: None)
        self.event_bus = EventBus()

    @contextmanager
    def session_scope(self) -> Iterator[FakeSession]:
        yield self.session
