"""Webhook queue processing policy, stored in app.settings.

Controls how the drain loop claims and retries webhook jobs. Defaults match
the previously hardcoded values, so an absent/corrupt setting changes nothing.
"""

from __future__ import annotations

import json
from typing import TypedDict

from sqlalchemy import text
from sqlalchemy.orm import Session

QUEUE_POLICY_KEY = "app.queue_policy_json"


class QueuePolicy(TypedDict):
    batch_size: int
    max_attempts: int
    backoff_base_seconds: int
    backoff_cap_seconds: int


DEFAULT_QUEUE_POLICY: QueuePolicy = {
    # jobs claimed per drain round
    "batch_size": 80,
    # attempts before a job dead-letters
    "max_attempts": 5,
    # retry delay = attempts * base, capped
    "backoff_base_seconds": 30,
    "backoff_cap_seconds": 900,
}

_CLAMPS: dict[str, tuple[int, int]] = {
    "batch_size": (1, 500),
    "max_attempts": (1, 20),
    "backoff_base_seconds": (5, 3600),
    "backoff_cap_seconds": (5, 21600),
}


def _clamp(field: str, value: object, default: int) -> int:
    if isinstance(value, bool) or value is None:
        return default
    try:
        number = int(value)  # type: ignore[call-overload]
    except (TypeError, ValueError):
        return default
    low, high = _CLAMPS[field]
    return max(low, min(number, high))


def _stored_policy(session: Session) -> dict[str, object]:
    raw = session.execute(
        text("select value from app.settings where key = :key"),
        {"key": QUEUE_POLICY_KEY},
    ).scalar_one_or_none()
    if not raw:
        return {}
    try:
        parsed = json.loads(str(raw))
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _normalized(source: dict[str, object]) -> QueuePolicy:
    policy: QueuePolicy = {
        "batch_size": _clamp("batch_size", source.get("batch_size"), DEFAULT_QUEUE_POLICY["batch_size"]),
        "max_attempts": _clamp("max_attempts", source.get("max_attempts"), DEFAULT_QUEUE_POLICY["max_attempts"]),
        "backoff_base_seconds": _clamp(
            "backoff_base_seconds", source.get("backoff_base_seconds"), DEFAULT_QUEUE_POLICY["backoff_base_seconds"]
        ),
        "backoff_cap_seconds": _clamp(
            "backoff_cap_seconds", source.get("backoff_cap_seconds"), DEFAULT_QUEUE_POLICY["backoff_cap_seconds"]
        ),
    }
    # The cap can never undercut the base delay.
    policy["backoff_cap_seconds"] = max(policy["backoff_cap_seconds"], policy["backoff_base_seconds"])
    return policy


def read_queue_policy(session: Session) -> QueuePolicy:
    return _normalized(_stored_policy(session))


def write_queue_policy(session: Session, updates: dict[str, object]) -> QueuePolicy:
    current = read_queue_policy(session)
    merged: dict[str, object] = {**current, **{k: v for k, v in updates.items() if k in _CLAMPS}}
    policy = _normalized(merged)
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
        {"key": QUEUE_POLICY_KEY, "value": json.dumps(policy)},
    )
    return policy
