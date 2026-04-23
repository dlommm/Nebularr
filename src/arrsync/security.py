from __future__ import annotations

import base64
import hashlib
import hmac
import os

from cryptography.fernet import Fernet, InvalidToken

ENC_PREFIX = "enc::"


def _build_fernet() -> Fernet | None:
    raw_key = os.getenv("APP_ENCRYPTION_KEY", "").strip()
    if not raw_key:
        return None
    try:
        return Fernet(raw_key.encode("utf-8"))
    except Exception:
        return None


def encrypt_secret(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        return ""
    fernet = _build_fernet()
    if not fernet:
        return normalized
    encrypted = fernet.encrypt(normalized.encode("utf-8")).decode("utf-8")
    return f"{ENC_PREFIX}{encrypted}"


def decrypt_secret(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        return ""
    if not normalized.startswith(ENC_PREFIX):
        return normalized
    fernet = _build_fernet()
    if not fernet:
        return ""
    token = normalized.removeprefix(ENC_PREFIX).encode("utf-8")
    try:
        return fernet.decrypt(token).decode("utf-8")
    except (InvalidToken, ValueError):
        return ""


def hash_secret(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        return ""
    digest = hashlib.sha256(normalized.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).decode("utf-8")


def verify_secret_hash(given_secret: str, stored_hash: str) -> bool:
    if not stored_hash:
        return False
    computed = hash_secret(given_secret)
    return hmac.compare_digest(computed.encode("utf-8"), stored_hash.encode("utf-8"))
