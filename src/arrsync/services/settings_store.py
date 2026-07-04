"""Generic key/value access to app.settings (see also the typed stores next to this)."""

from __future__ import annotations

from typing import Any

from sqlalchemy import text


def get_setting(session: Any, key: str, default: str = "") -> str:
    value = session.execute(
        text("select value from app.settings where key = :key"),
        {"key": key},
    ).scalar_one_or_none()
    return str(value) if value is not None else default


def set_setting(session: Any, key: str, value: str) -> None:
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
