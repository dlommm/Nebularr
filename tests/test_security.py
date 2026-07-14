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


def test_session_epoch_embedded_and_enforced() -> None:
    from arrsync.auth import mint_session_token, verify_session_token

    key = b"k" * 32
    token_epoch0 = mint_session_token(3600, signing_key=key, epoch=0)
    assert verify_session_token(token_epoch0, signing_key=key, expected_epoch=0)
    assert not verify_session_token(token_epoch0, signing_key=key, expected_epoch=1)
    token_epoch1 = mint_session_token(3600, signing_key=key, epoch=1)
    assert verify_session_token(token_epoch1, signing_key=key, expected_epoch=1)


def test_legacy_token_without_epoch_field_treated_as_epoch_zero() -> None:
    import base64
    import json
    import time as time_mod

    from arrsync.auth import _sign, verify_session_token

    key = b"k" * 32
    payload = json.dumps({"exp": int(time_mod.time()) + 3600}, separators=(",", ":"))
    body = base64.urlsafe_b64encode(payload.encode("utf-8")).decode("utf-8")
    legacy_token = f"{body}.{_sign(key, body)}"
    assert verify_session_token(legacy_token, signing_key=key, expected_epoch=0)
    assert not verify_session_token(legacy_token, signing_key=key, expected_epoch=1)


class _RateLimitRequest:
    def __init__(self, peer: str, forwarded_for: str = "") -> None:
        from types import SimpleNamespace

        self.client = SimpleNamespace(host=peer)
        self.headers = {"x-forwarded-for": forwarded_for} if forwarded_for else {}


def test_client_key_uses_peer_without_trusted_proxies() -> None:
    from arrsync.auth import client_key_for_request

    request = _RateLimitRequest("1.2.3.4", forwarded_for="9.9.9.9")
    assert client_key_for_request(request, "") == "1.2.3.4"


def test_client_key_unwraps_forwarded_for_behind_trusted_proxy() -> None:
    from arrsync.auth import client_key_for_request

    request = _RateLimitRequest("172.18.0.2", forwarded_for="203.0.113.7, 172.18.0.2")
    assert client_key_for_request(request, "172.18.0.0/16") == "203.0.113.7"


def test_client_key_skips_multiple_trusted_hops() -> None:
    from arrsync.auth import client_key_for_request

    request = _RateLimitRequest("172.18.0.2", forwarded_for="198.51.100.4, 172.18.0.3, 172.18.0.2")
    assert client_key_for_request(request, "172.18.0.0/16") == "198.51.100.4"


def test_client_key_ignores_spoofed_header_from_untrusted_peer() -> None:
    from arrsync.auth import client_key_for_request

    request = _RateLimitRequest("203.0.113.9", forwarded_for="10.0.0.1")
    assert client_key_for_request(request, "172.18.0.0/16") == "203.0.113.9"
