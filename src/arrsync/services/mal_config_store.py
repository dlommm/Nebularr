from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.orm import Session

from arrsync.config import Settings
from arrsync.security import decrypt_secret, encrypt_secret

MAL_CLIENT_ID_KEY = "mal.client_id"
MAL_INGEST_ENABLED_KEY = "mal.ingest_enabled"
MAL_MATCHER_ENABLED_KEY = "mal.matcher_enabled"
MAL_TAGGING_ENABLED_KEY = "mal.tagging_enabled"
MAL_ALLOW_TITLE_YEAR_MATCH_KEY = "mal.allow_title_year_match"


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


def _read_setting_bool(session: Session, key: str) -> bool | None:
    value = session.execute(
        text("select value from app.settings where key = :key"),
        {"key": key},
    ).scalar_one_or_none()
    if value is None:
        return None
    raw = str(value).strip().lower()
    if raw in {"1", "true", "t", "yes", "y", "on"}:
        return True
    if raw in {"0", "false", "f", "no", "n", "off"}:
        return False
    return None


def _store_setting_bool(session: Session, key: str, value: bool) -> None:
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
        {"key": key, "value": "true" if value else "false"},
    )


def read_mal_feature_flags(session: Session, settings: Settings) -> dict[str, bool]:
    ingest_enabled = _read_setting_bool(session, MAL_INGEST_ENABLED_KEY)
    matcher_enabled = _read_setting_bool(session, MAL_MATCHER_ENABLED_KEY)
    tagging_enabled = _read_setting_bool(session, MAL_TAGGING_ENABLED_KEY)
    title_year_enabled = _read_setting_bool(session, MAL_ALLOW_TITLE_YEAR_MATCH_KEY)
    return {
        "ingest_enabled": settings.mal_ingest_enabled if ingest_enabled is None else ingest_enabled,
        "matcher_enabled": settings.mal_matcher_enabled if matcher_enabled is None else matcher_enabled,
        "tagging_enabled": settings.mal_tagging_enabled if tagging_enabled is None else tagging_enabled,
        "allow_title_year_match": settings.mal_allow_title_year_match if title_year_enabled is None else title_year_enabled,
    }


def store_mal_feature_flags(
    session: Session,
    *,
    ingest_enabled: bool | None = None,
    matcher_enabled: bool | None = None,
    tagging_enabled: bool | None = None,
    allow_title_year_match: bool | None = None,
) -> None:
    if ingest_enabled is not None:
        _store_setting_bool(session, MAL_INGEST_ENABLED_KEY, ingest_enabled)
    if matcher_enabled is not None:
        _store_setting_bool(session, MAL_MATCHER_ENABLED_KEY, matcher_enabled)
    if tagging_enabled is not None:
        _store_setting_bool(session, MAL_TAGGING_ENABLED_KEY, tagging_enabled)
    if allow_title_year_match is not None:
        _store_setting_bool(session, MAL_ALLOW_TITLE_YEAR_MATCH_KEY, allow_title_year_match)
