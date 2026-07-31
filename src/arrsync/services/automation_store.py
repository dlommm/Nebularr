"""Raw-SQL persistence for automations: rule rows, run history, action ledger.

Same conventions as services/repository.py — parameterized sqlalchemy.text(),
session passed in, JSON serialized with default=str.
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

_AUTOMATION_COLUMNS = (
    "id, name, template_key, params, enabled, dry_run, cron, timezone,"
    " budget_per_run, cooldown_days, state, created_at, updated_at"
)

_UPDATABLE_FIELDS = frozenset(
    {
        "name",
        "template_key",
        "params",
        "enabled",
        "dry_run",
        "cron",
        "timezone",
        "budget_per_run",
        "cooldown_days",
    }
)


def _row_to_dict(row: Any) -> dict[str, Any]:
    out = dict(row)
    for key in ("params", "state", "details"):
        value = out.get(key)
        if isinstance(value, str):
            try:
                out[key] = json.loads(value)
            except json.JSONDecodeError:
                out[key] = {}
    return out


def list_automations(session: Session) -> list[dict[str, Any]]:
    rows = session.execute(
        text(
            f"""
            select {', '.join('a.' + c.strip() for c in _AUTOMATION_COLUMNS.split(','))},
                   r.id as last_run_id, r.status as last_run_status,
                   r.started_at as last_run_started_at,
                   r.matched_count as last_run_matched,
                   r.actions_taken as last_run_actions
            from app.automation a
            left join lateral (
                select id, status, started_at, matched_count, actions_taken
                from app.automation_run
                where automation_id = a.id
                order by started_at desc
                limit 1
            ) r on true
            order by a.name
            """
        )
    ).mappings()
    return [_row_to_dict(r) for r in rows]


def get_automation(session: Session, automation_id: int) -> dict[str, Any] | None:
    # list()-based fetch instead of .mappings().first(): tests/fakes.py FakeResult
    # returns a plain list from mappings(), which has no .first().
    rows = list(
        session.execute(
            text(f"select {_AUTOMATION_COLUMNS} from app.automation where id = :id"),
            {"id": automation_id},
        ).mappings()
    )
    return _row_to_dict(rows[0]) if rows else None


def create_automation(
    session: Session,
    *,
    name: str,
    template_key: str,
    params: dict[str, Any],
    cron: str,
    timezone: str,
    enabled: bool,
    dry_run: bool,
    budget_per_run: int,
    cooldown_days: int,
) -> int:
    row = session.execute(
        text(
            """
            insert into app.automation
                (name, template_key, params, enabled, dry_run, cron, timezone,
                 budget_per_run, cooldown_days)
            values
                (:name, :template_key, cast(:params as jsonb), :enabled, :dry_run,
                 :cron, :timezone, :budget_per_run, :cooldown_days)
            returning id
            """
        ),
        {
            "name": name,
            "template_key": template_key,
            "params": json.dumps(params, default=str),
            "enabled": enabled,
            "dry_run": dry_run,
            "cron": cron,
            "timezone": timezone,
            "budget_per_run": budget_per_run,
            "cooldown_days": cooldown_days,
        },
    ).scalar_one()
    return int(row)


def update_automation(session: Session, automation_id: int, fields: dict[str, Any]) -> bool:
    updates = {k: v for k, v in fields.items() if k in _UPDATABLE_FIELDS}
    if not updates:
        return False
    if "params" in updates:
        updates["params"] = json.dumps(updates["params"], default=str)
    assignments = ", ".join(
        f"{key} = cast(:{key} as jsonb)" if key == "params" else f"{key} = :{key}"
        for key in sorted(updates)
    )
    result = session.execute(
        text(
            f"update app.automation set {assignments}, updated_at = now()"
            " where id = :automation_id returning id"
        ),
        {**updates, "automation_id": automation_id},
    )
    return result.first() is not None


def delete_automation(session: Session, automation_id: int) -> bool:
    result = session.execute(
        text("delete from app.automation where id = :id returning id"),
        {"id": automation_id},
    )
    return result.first() is not None


def set_automation_state(session: Session, automation_id: int, state: dict[str, Any]) -> None:
    session.execute(
        text(
            "update app.automation set state = cast(:state as jsonb), updated_at = now()"
            " where id = :id"
        ),
        {"id": automation_id, "state": json.dumps(state, default=str)},
    )


def read_enabled_automation_schedules(session: Session) -> list[dict[str, Any]]:
    rows = session.execute(
        text("select id, cron, timezone from app.automation where enabled = true order by id")
    ).mappings()
    return [dict(r) for r in rows]


def insert_automation_run(session: Session, automation_id: int) -> int:
    row = session.execute(
        text(
            """
            insert into app.automation_run (automation_id, status, started_at, details)
            values (:automation_id, 'running', now(), '{}'::jsonb)
            returning id
            """
        ),
        {"automation_id": automation_id},
    ).scalar_one()
    return int(row)


def finish_automation_run(
    session: Session,
    run_id: int,
    status: str,
    *,
    matched_count: int,
    actions_taken: int,
    skipped_cooldown: int,
    skipped_budget: int,
    details: dict[str, Any],
    error_message: str | None = None,
) -> None:
    session.execute(
        text(
            """
            update app.automation_run
            set status = :status,
                finished_at = now(),
                matched_count = :matched_count,
                actions_taken = :actions_taken,
                skipped_cooldown = :skipped_cooldown,
                skipped_budget = :skipped_budget,
                details = cast(:details as jsonb),
                error_message = :error_message
            where id = :run_id
            """
        ),
        {
            "run_id": run_id,
            "status": status,
            "matched_count": matched_count,
            "actions_taken": actions_taken,
            "skipped_cooldown": skipped_cooldown,
            "skipped_budget": skipped_budget,
            "details": json.dumps(details, default=str),
            "error_message": error_message,
        },
    )


def list_automation_runs(
    session: Session, automation_id: int, limit: int = 20
) -> list[dict[str, Any]]:
    rows = session.execute(
        text(
            """
            select id, automation_id, started_at, finished_at, status,
                   matched_count, actions_taken, skipped_cooldown, skipped_budget,
                   error_message
            from app.automation_run
            where automation_id = :automation_id
            order by started_at desc
            limit :limit
            """
        ),
        {"automation_id": automation_id, "limit": max(1, min(int(limit), 100))},
    ).mappings()
    return [dict(r) for r in rows]


def get_automation_run(session: Session, run_id: int) -> dict[str, Any] | None:
    rows = list(
        session.execute(
            text(
                """
                select id, automation_id, started_at, finished_at, status,
                       matched_count, actions_taken, skipped_cooldown, skipped_budget,
                       details, error_message
                from app.automation_run
                where id = :run_id
                """
            ),
            {"run_id": run_id},
        ).mappings()
    )
    return _row_to_dict(rows[0]) if rows else None


def upsert_action_ledger(
    session: Session,
    *,
    instance_name: str,
    entity_type: str,
    source_id: int,
    action_type: str,
    automation_id: int,
    run_id: int,
) -> None:
    session.execute(
        text(
            """
            insert into app.automation_action_ledger
                (instance_name, entity_type, source_id, action_type,
                 last_fired_at, last_automation_id, last_run_id)
            values
                (:instance_name, :entity_type, :source_id, :action_type,
                 now(), :automation_id, :run_id)
            on conflict (instance_name, entity_type, source_id, action_type)
            do update set
                last_fired_at = now(),
                last_automation_id = excluded.last_automation_id,
                last_run_id = excluded.last_run_id
            """
        ),
        {
            "instance_name": instance_name,
            "entity_type": entity_type,
            "source_id": source_id,
            "action_type": action_type,
            "automation_id": automation_id,
            "run_id": run_id,
        },
    )


def count_recent_searches(session: Session, hours: int = 24) -> int:
    row = session.execute(
        text(
            """
            select count(*) from app.automation_action_ledger
            where action_type = 'search'
              and last_fired_at >= now() - make_interval(hours => :hours)
            """
        ),
        {"hours": hours},
    ).scalar_one()
    return int(row)
