"""Persist DATABASE_URL on a writable volume (encrypted), applied before Settings loads."""

from __future__ import annotations

import os
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

_RUNTIME_DIR = Path(os.getenv("NEBULARR_RUNTIME_DIR", "/app/data")).expanduser()
_KEY_FILE = _RUNTIME_DIR / ".nebularr_runtime_key"
_URL_FILE = _RUNTIME_DIR / "database.url.enc"


def runtime_dir() -> Path:
    return _RUNTIME_DIR


def _load_fernet() -> Fernet | None:
    if not _KEY_FILE.exists():
        return None
    raw = _KEY_FILE.read_bytes().strip()
    try:
        return Fernet(raw)
    except (ValueError, TypeError):
        return None


def _get_or_create_fernet() -> Fernet:
    _RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    existing = _load_fernet()
    if existing:
        return existing
    key = Fernet.generate_key()
    # O_EXCL: create-or-fail so a concurrent boot can't clobber the key file and
    # strand the URL it already encrypted. On a lost race, adopt the winner's key.
    try:
        fd = os.open(str(_KEY_FILE), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raw = _KEY_FILE.read_bytes().strip()
        return Fernet(raw)
    with os.fdopen(fd, "wb") as handle:
        handle.write(key)
    return Fernet(key)


def runtime_database_url_persisted() -> bool:
    return _URL_FILE.is_file() and _URL_FILE.stat().st_size > 0


def read_persisted_database_url() -> str | None:
    if not runtime_database_url_persisted():
        return None
    fernet = _load_fernet()
    if not fernet:
        return None
    token = _URL_FILE.read_bytes()
    try:
        return fernet.decrypt(token).decode("utf-8").strip() or None
    except (InvalidToken, ValueError):
        return None


def persist_runtime_database_url(database_url: str) -> None:
    normalized = database_url.strip()
    if not normalized:
        raise ValueError("database_url is empty")
    _RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    token = _get_or_create_fernet().encrypt(normalized.encode("utf-8"))
    _URL_FILE.write_bytes(token)
    try:
        os.chmod(_URL_FILE, 0o600)
    except OSError:
        pass


def apply_runtime_database_url_to_environ() -> None:
    """If a persisted URL exists, set os.environ['DATABASE_URL'] before Settings is built."""
    url = read_persisted_database_url()
    if url:
        os.environ["DATABASE_URL"] = url
