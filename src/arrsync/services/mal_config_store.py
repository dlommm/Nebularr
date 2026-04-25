from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.orm import Session

from arrsync.config import Settings
from arrsync.security import decrypt_secret, encrypt_secret

MAL_CLIENT_ID_KEY = "mal.client_id"


def read_mal_client_id(session: Session, settings: Settings) -> str:
    row = session.execute(
        text("select value from app.settings where key = :key"),
        {"key": MAL_CLIENT_ID_KEY},
    ).scalar_one_or_none()
    if row is not None and str(row).strip():
        return decrypt_secret(str(row)).strip()
    return (settings.mal_client_id or "").strip()


def mal_client_id_is_configured(session: Session, settings: Settings) -> bool:
    return bool(read_mal_client_id(session, settings))


def store_mal_client_id(session: Session, client_id: str) -> None:
    normalized = client_id.strip()
    if not normalized:
        return
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
        {"key": MAL_CLIENT_ID_KEY, "value": encrypt_secret(normalized)},
    )


def clear_mal_client_id(session: Session) -> None:
    session.execute(text("delete from app.settings where key = :key"), {"key": MAL_CLIENT_ID_KEY})
