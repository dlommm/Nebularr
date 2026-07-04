from __future__ import annotations

import pytest
from cryptography.fernet import Fernet

from arrsync import security
from arrsync.auth import hash_password, verify_password


@pytest.fixture()
def encryption_key(monkeypatch: pytest.MonkeyPatch) -> str:
    key = Fernet.generate_key().decode("utf-8")
    monkeypatch.setenv("APP_ENCRYPTION_KEY", key)
    return key


def test_encrypt_decrypt_roundtrip(encryption_key: str) -> None:
    stored = security.encrypt_secret("my-api-key")
    assert stored.startswith(security.ENC_PREFIX)
    assert "my-api-key" not in stored
    assert security.decrypt_secret(stored) == "my-api-key"


def test_encrypt_without_key_falls_back_to_plaintext(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("APP_ENCRYPTION_KEY", raising=False)
    assert security.encrypt_secret("my-api-key") == "my-api-key"


def test_decrypt_plaintext_passthrough(encryption_key: str) -> None:
    # Legacy rows written before a key existed must keep working after upgrade.
    assert security.decrypt_secret("legacy-plaintext-key") == "legacy-plaintext-key"


def test_decrypt_with_wrong_key_returns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_ENCRYPTION_KEY", Fernet.generate_key().decode("utf-8"))
    stored = security.encrypt_secret("my-api-key")
    monkeypatch.setenv("APP_ENCRYPTION_KEY", Fernet.generate_key().decode("utf-8"))
    assert security.decrypt_secret(stored) == ""


def test_hash_secret_known_vector_unchanged() -> None:
    # Regression pin: deployed databases store hashes with exactly this scheme
    # (unsalted SHA-256, urlsafe base64). Changing it breaks stored webhook secrets.
    assert security.hash_secret("changeme") == "BXugPWxEEEhj3HNh_kV4ll0YhzYPkKCJWILlimJI_IY="


def test_verify_secret_hash_roundtrip() -> None:
    stored = security.hash_secret("some-secret")
    assert security.verify_secret_hash("some-secret", stored)
    assert not security.verify_secret_hash("other-secret", stored)
    assert not security.verify_secret_hash("some-secret", "")


def test_password_hash_roundtrip_and_salting() -> None:
    first = hash_password("correct horse battery staple")
    second = hash_password("correct horse battery staple")
    assert first.startswith("scrypt$")
    assert first != second  # per-hash random salt
    assert verify_password("correct horse battery staple", first)
    assert verify_password("correct horse battery staple", second)
    assert not verify_password("wrong password", first)


def test_verify_password_rejects_garbage_hashes() -> None:
    assert not verify_password("anything", "")
    assert not verify_password("anything", "not-a-hash")
    assert not verify_password("anything", "sha256$abc$def")
    assert not verify_password("anything", "scrypt$!!!$???")
