"""Retention policy for history tables, stored in app.settings.

Applies to run/audit/snapshot history only — never to current warehouse
entities (series/episodes/movies). A value of 0 disables pruning for that
table ("keep forever").
"""

from __future__ import annotations

import json
from typing import TypedDict

from sqlalchemy import text
from sqlalchemy.orm import Session

RETENTION_POLICY_KEY = "app.retention_policy_json"

MAX_RETENTION_DAYS = 3650


class RetentionPolicy(TypedDict):
    queue_days: int
    sync_run_days: int
    stat_snapshot_days: int


DEFAULT_RETENTION_POLICY: RetentionPolicy = {
    # app.webhook_queue (processed rows) + app.job_run_summary
    "queue_days": 30,
    # warehouse.sync_run history
    "sync_run_days": 90,
    # warehouse.library_stat_snapshot trend captures
    "stat_snapshot_days": 365,
}


def _clamp_days(value: object, default: int) -> int:
    if isinstance(value, bool) or value is None:
        return default
    try:
        days = int(value)  # type: ignore[call-overload]
    except (TypeError, ValueError):
        return default
    return max(0, min(days, MAX_RETENTION_DAYS))


def _stored_policy(session: Session) -> dict[str, object]:
    raw = session.execute(
        text("select value from app.settings where key = :key"),
        {"key": RETENTION_POLICY_KEY},
    ).scalar_one_or_none()
    if not raw:
        return {}
    try:
        parsed = json.loads(str(raw))
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def read_retention_policy(session: Session) -> RetentionPolicy:
    stored = _stored_policy(session)
    return {
        "queue_days": _clamp_days(stored.get("queue_days"), DEFAULT_RETENTION_POLICY["queue_days"]),
        "sync_run_days": _clamp_days(stored.get("sync_run_days"), DEFAULT_RETENTION_POLICY["sync_run_days"]),
        "stat_snapshot_days": _clamp_days(
            stored.get("stat_snapshot_days"), DEFAULT_RETENTION_POLICY["stat_snapshot_days"]
        ),
    }


def write_retention_policy(session: Session, updates: dict[str, object]) -> RetentionPolicy:
    current = read_retention_policy(session)
    policy: RetentionPolicy = {
        "queue_days": _clamp_days(updates.get("queue_days", current["queue_days"]), current["queue_days"]),
        "sync_run_days": _clamp_days(
            updates.get("sync_run_days", current["sync_run_days"]), current["sync_run_days"]
        ),
        "stat_snapshot_days": _clamp_days(
            updates.get("stat_snapshot_days", current["stat_snapshot_days"]), current["stat_snapshot_days"]
        ),
    }
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
        {"key": RETENTION_POLICY_KEY, "value": json.dumps(policy)},
    )
    return policy
