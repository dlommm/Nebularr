from __future__ import annotations

import json
from typing import Any

from arrsync.services import automation_store
from fakes import FakeResult, FakeSession


class AutomationFakeSession(FakeSession):
    def __init__(self, rows: list[Any] | None = None, scalar: Any = None) -> None:
        super().__init__()
        self.rows = rows or []
        self.scalar = scalar

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> FakeResult:
        sql = " ".join(str(query).lower().split())
        if "app.automation" in sql or "app.automation_run" in sql or "app.automation_action_ledger" in sql:
            self.statements.append((sql, params))
            return FakeResult(scalar_value=self.scalar, rows=self.rows)
        return super().execute(query, params)


def test_create_automation_serializes_params_and_returns_id() -> None:
    session = AutomationFakeSession(scalar=7)
    new_id = automation_store.create_automation(
        session,
        name="dub hunt",
        template_key="anime-dub-enforcer",
        params={"scope": {"media": "both"}},
        cron="0 6 */2 * *",
        timezone="UTC",
        enabled=False,
        dry_run=True,
        budget_per_run=10,
        cooldown_days=7,
    )
    assert new_id == 7
    sql, params = session.statements[-1]
    assert "insert into app.automation" in sql
    assert json.loads(params["params"]) == {"scope": {"media": "both"}}
    assert params["dry_run"] is True


def test_update_automation_only_touches_whitelisted_fields() -> None:
    session = AutomationFakeSession(rows=[(1,)])
    ok = automation_store.update_automation(
        session, 3, {"cron": "0 4 * * *", "enabled": True, "nope": "ignored"}
    )
    assert ok
    sql, params = session.statements[-1]
    assert "cron = :cron" in sql
    assert "enabled = :enabled" in sql
    assert "nope" not in sql
    assert "updated_at = now()" in sql


def test_update_automation_rejects_empty_fields() -> None:
    session = AutomationFakeSession()
    assert automation_store.update_automation(session, 3, {"nope": 1}) is False
    assert session.statements == []


def test_finish_automation_run_writes_counters() -> None:
    session = AutomationFakeSession()
    automation_store.finish_automation_run(
        session,
        11,
        "dry_run",
        matched_count=5,
        actions_taken=0,
        skipped_cooldown=2,
        skipped_budget=1,
        details={"instances": {}},
    )
    sql, params = session.statements[-1]
    assert "update app.automation_run" in sql
    assert params["status"] == "dry_run"
    assert params["skipped_cooldown"] == 2
    assert json.loads(params["details"]) == {"instances": {}}


def test_upsert_action_ledger_conflict_updates_fired_at() -> None:
    session = AutomationFakeSession()
    automation_store.upsert_action_ledger(
        session,
        instance_name="default",
        entity_type="movie",
        source_id=42,
        action_type="search",
        automation_id=3,
        run_id=11,
    )
    sql, _params = session.statements[-1]
    assert "on conflict (instance_name, entity_type, source_id, action_type)" in sql
    assert "last_fired_at = now()" in sql


def test_count_recent_searches_uses_window() -> None:
    session = AutomationFakeSession(scalar=13)
    assert automation_store.count_recent_searches(session) == 13
    sql, params = session.statements[-1]
    assert "action_type = 'search'" in sql
    assert params["hours"] == 24
