from __future__ import annotations

import logging

from sqlalchemy import text
from sqlalchemy.orm import Session

from arrsync.config import Settings
from arrsync.logging import normalize_log_level

log = logging.getLogger(__name__)

LOG_LEVEL_KEY = "app.log_level"


def read_stored_log_level(session: Session) -> str | None:
    row = session.execute(
        text("select value from app.settings where key = :key"),
        {"key": LOG_LEVEL_KEY},
    ).scalar_one_or_none()
    if row is None:
        return None
    s = str(row).strip()
    return s or None


def effective_log_level(session: Session, settings: Settings) -> str:
    raw = read_stored_log_level(session)
    if raw:
        try:
            return normalize_log_level(raw)
        except ValueError:
            log.warning("invalid stored log level %r; using environment default", raw)
    return normalize_log_level(settings.log_level)


def store_log_level(session: Session, level: str) -> str:
    normalized = normalize_log_level(level)
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
        {"key": LOG_LEVEL_KEY, "value": normalized},
    )
    return normalized


def clear_stored_log_level(session: Session) -> None:
    session.execute(text("delete from app.settings where key = :key"), {"key": LOG_LEVEL_KEY})
