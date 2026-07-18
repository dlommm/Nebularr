"""Persist generated secrets (session signing key, encryption key) on the runtime volume.

Follows the same pattern as runtime_database_url.py: secrets live as 0600 files under
NEBULARR_RUNTIME_DIR so they survive container restarts without any operator setup.
An explicit environment variable always wins over a generated file.
"""

from __future__ import annotations

import logging
import os
import secrets
from pathlib import Path

from cryptography.fernet import Fernet

from arrsync.runtime_database_url import runtime_dir

log = logging.getLogger(__name__)

SESSION_KEY_FILENAME = ".nebularr_session_key"
ENCRYPTION_KEY_FILENAME = ".nebularr_app_encryption_key"

_ephemeral_session_key: bytes | None = None
_cached_session_key: bytes | None = None


def _read_key_file(path: Path) -> bytes | None:
    if not path.is_file():
        return None
    raw = path.read_bytes().strip()
    return raw or None


def get_or_create_secret(filename: str) -> bytes | None:
    """Load a persisted secret from the runtime dir, generating one on first use.

    Returns None when the runtime dir is not writable so callers can degrade loudly.
    """
    path = runtime_dir() / filename
    existing = _read_key_file(path)
    if existing:
        return existing
    key = Fernet.generate_key()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # O_EXCL: create-or-fail so two workers racing to first-boot can't each
        # generate a different key. The loser reads the winner's file below.
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return _read_key_file(path)
    except OSError:
        return None
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(key)
    except OSError:
        return None
    return key


def session_signing_key() -> bytes:
    """Key used to HMAC-sign web session cookies.

    Falls back to a process-lifetime random key when the runtime dir is not
    writable (sessions then reset on restart, which is safe but inconvenient).
    """
    global _cached_session_key, _ephemeral_session_key
    if _cached_session_key is not None:
        return _cached_session_key
    key = get_or_create_secret(SESSION_KEY_FILENAME)
    if key is not None:
        _cached_session_key = key
        return key
    if _ephemeral_session_key is None:
        _ephemeral_session_key = secrets.token_bytes(32)
        log.warning(
            "runtime dir %s is not writable; using an ephemeral session signing key "
            "(web sessions will not survive restarts)",
            runtime_dir(),
        )
    return _ephemeral_session_key


def apply_runtime_encryption_key_to_environ() -> None:
    """Provision a persisted APP_ENCRYPTION_KEY when none is configured.

    Without a key, integration API keys and other secrets are stored in plaintext
    (security.encrypt_secret falls back to passthrough). An explicit env value wins.
    """
    if os.getenv("APP_ENCRYPTION_KEY", "").strip():
        return
    key = get_or_create_secret(ENCRYPTION_KEY_FILENAME)
    if key is None:
        log.warning(
            "SECURITY WARNING: APP_ENCRYPTION_KEY is not set and the runtime dir %s is not "
            "writable; integration secrets will be stored in plaintext",
            runtime_dir(),
        )
        return
    os.environ["APP_ENCRYPTION_KEY"] = key.decode("utf-8")


def encryption_at_rest_active() -> bool:
    return bool(os.getenv("APP_ENCRYPTION_KEY", "").strip())
