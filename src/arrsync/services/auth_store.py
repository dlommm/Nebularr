"""app.settings-backed storage for web UI / API authentication state."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.orm import Session

AUTH_ENABLED_KEY = "app.auth_enabled"
AUTH_PASSWORD_HASH_KEY = "app.auth_password_hash"
AUTH_API_TOKEN_HASH_KEY = "app.auth_api_token_hash"
AUTH_SESSION_EPOCH_KEY = "app.auth_session_epoch"


@dataclass(slots=True)
class AuthConfig:
    enabled: bool
    password_hash: str
    api_token_hash: str
    session_epoch: int = 0

    @property
    def password_set(self) -> bool:
        return bool(self.password_hash)


def read_setting(session: Session, key: str) -> str:
    row = session.execute(
        text("select value from app.settings where key = :key"),
        {"key": key},
    ).scalar_one_or_none()
    return str(row).strip() if row is not None else ""


def _write_setting(session: Session, key: str, value: str) -> None:
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


def _parse_epoch(raw: str) -> int:
    try:
        return int(raw)
    except ValueError:
        return 0


def read_auth_config(session: Session) -> AuthConfig:
    return AuthConfig(
        enabled=read_setting(session, AUTH_ENABLED_KEY).lower() == "true",
        password_hash=read_setting(session, AUTH_PASSWORD_HASH_KEY),
        api_token_hash=read_setting(session, AUTH_API_TOKEN_HASH_KEY),
        session_epoch=_parse_epoch(read_setting(session, AUTH_SESSION_EPOCH_KEY)),
    )


def store_auth_enabled(session: Session, enabled: bool) -> None:
    _write_setting(session, AUTH_ENABLED_KEY, "true" if enabled else "false")


def store_auth_password_hash(session: Session, password_hash: str) -> None:
    _write_setting(session, AUTH_PASSWORD_HASH_KEY, password_hash)


def store_api_token_hash(session: Session, token_hash: str) -> None:
    _write_setting(session, AUTH_API_TOKEN_HASH_KEY, token_hash)


def bump_session_epoch(session: Session) -> int:
    """Invalidate all outstanding session cookies (they embed the old epoch)."""
    new_epoch = _parse_epoch(read_setting(session, AUTH_SESSION_EPOCH_KEY)) + 1
    _write_setting(session, AUTH_SESSION_EPOCH_KEY, str(new_epoch))
    return new_epoch
