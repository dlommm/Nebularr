from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from arrsync.api import build_router
from arrsync.auth import (
    SESSION_COOKIE_NAME,
    enforce_auth,
    invalidate_auth_cache,
    mint_session_token,
)

from fakes import FakeAppState


def _build_client(state: FakeAppState) -> TestClient:
    app = FastAPI()

    @app.middleware("http")
    async def authentication_gate(request: Request, call_next: Any) -> Any:
        return await enforce_auth(request, call_next, state)

    app.include_router(build_router(state))
    return TestClient(app)


def _enable_auth(client: TestClient, state: FakeAppState, password: str = "hunter2secret") -> None:
    response = client.put("/api/auth/config", json={"password": password, "enabled": True})
    assert response.status_code == 200
    assert response.json()["enabled"] is True
    invalidate_auth_cache(state)


def test_disabled_auth_passes_everything_through() -> None:
    state = FakeAppState()
    client = _build_client(state)
    assert client.get("/api/auth/status").json() == {
        "enabled": False,
        "password_set": False,
        "api_token_set": False,
        "authenticated": True,
    }
    assert client.get("/api/config/logging").status_code == 200


def test_enabling_auth_gates_api_and_login_grants_session() -> None:
    state = FakeAppState()
    client = _build_client(state)
    _enable_auth(state=state, client=client)

    denied = client.get("/api/config/logging")
    assert denied.status_code == 401

    bad_login = client.post("/api/auth/login", json={"password": "wrong-password"})
    assert bad_login.status_code == 401

    login = client.post("/api/auth/login", json={"password": "hunter2secret"})
    assert login.status_code == 200
    assert SESSION_COOKIE_NAME in login.cookies

    allowed = client.get("/api/config/logging")
    assert allowed.status_code == 200

    status = client.get("/api/auth/status").json()
    assert status["enabled"] is True
    assert status["authenticated"] is True

    client.post("/api/auth/logout")
    client.cookies.clear()
    assert client.get("/api/config/logging").status_code == 401


def test_exempt_and_public_paths_stay_reachable_with_auth_enabled() -> None:
    state = FakeAppState()
    client = _build_client(state)
    _enable_auth(state=state, client=client)
    assert client.get("/healthz").status_code == 200
    assert client.get("/api/auth/status").status_code == 200
    # webhooks authenticate via their own shared secret, not sessions
    hook = client.post(
        "/hooks/sonarr",
        headers={"x-arr-shared-secret": "test-webhook-secret"},
        json={"eventType": "Test"},
    )
    assert hook.status_code == 200


def test_metrics_is_open_when_auth_is_disabled() -> None:
    state = FakeAppState()
    client = _build_client(state)
    assert client.get("/metrics").status_code == 200


def test_metrics_requires_auth_once_auth_is_enabled() -> None:
    state = FakeAppState()
    client = _build_client(state)
    _enable_auth(state=state, client=client)
    anonymous = TestClient(client.app)
    assert anonymous.get("/metrics").status_code == 401
    assert client.post("/api/auth/login", json={"password": "hunter2secret"}).status_code == 200
    assert client.get("/metrics").status_code == 200


def test_metrics_public_setting_bypasses_the_gate() -> None:
    state = FakeAppState()
    client = _build_client(state)
    _enable_auth(state=state, client=client)
    assert client.post("/api/auth/login", json={"password": "hunter2secret"}).status_code == 200
    anonymous = TestClient(client.app)
    assert anonymous.get("/metrics").status_code == 401

    put = client.put("/api/config/metrics", json={"public": True})
    assert put.status_code == 200
    assert anonymous.get("/metrics").status_code == 200


def test_tampered_and_expired_session_tokens_are_rejected() -> None:
    state = FakeAppState()
    client = _build_client(state)
    _enable_auth(state=state, client=client)

    login = client.post("/api/auth/login", json={"password": "hunter2secret"})
    token = login.cookies[SESSION_COOKIE_NAME]

    client.cookies.set(SESSION_COOKIE_NAME, token[:-4] + "AAAA")
    assert client.get("/api/config/logging").status_code == 401

    client.cookies.set(SESSION_COOKIE_NAME, mint_session_token(ttl_seconds=-10))
    assert client.get("/api/config/logging").status_code == 401


def test_bearer_token_authenticates_and_revokes() -> None:
    state = FakeAppState()
    client = _build_client(state)
    _enable_auth(state=state, client=client)
    login = client.post("/api/auth/login", json={"password": "hunter2secret"})
    assert login.status_code == 200

    issued = client.put("/api/auth/config", json={"rotate_api_token": True})
    token = issued.json()["api_token"]
    assert token

    anonymous = TestClient(client.app)
    assert anonymous.get("/api/config/logging").status_code == 401
    assert (
        anonymous.get("/api/config/logging", headers={"Authorization": f"Bearer {token}"}).status_code == 200
    )

    revoked = client.put("/api/auth/config", json={"revoke_api_token": True})
    assert revoked.json()["api_token_set"] is False
    invalidate_auth_cache(state)
    assert anonymous.get("/api/config/logging", headers={"Authorization": f"Bearer {token}"}).status_code == 401


def test_login_rate_limit_locks_out_after_failures() -> None:
    state = FakeAppState()
    client = _build_client(state)
    _enable_auth(state=state, client=client)
    for _ in range(5):
        assert client.post("/api/auth/login", json={"password": "nope"}).status_code == 401
    assert client.post("/api/auth/login", json={"password": "nope"}).status_code == 429
    # even the right password is throttled during lockout
    assert client.post("/api/auth/login", json={"password": "hunter2secret"}).status_code == 429


def test_recovery_password_env_override() -> None:
    state = FakeAppState()
    state.settings.auth_recovery_password = "break-glass-pass"
    client = _build_client(state)
    _enable_auth(state=state, client=client)
    login = client.post("/api/auth/login", json={"password": "break-glass-pass"})
    assert login.status_code == 200


def test_non_ascii_password_with_recovery_password_set_is_401_not_500() -> None:
    # Regression: secrets.compare_digest(str, str) raises TypeError on non-ASCII
    # input; that must not surface as a 500, and the failed attempt still counts
    # toward the lockout (mismatch falls through to normal failure handling).
    state = FakeAppState()
    state.settings.auth_recovery_password = "break-glass-pass"
    client = _build_client(state)
    _enable_auth(state=state, client=client)
    response = client.post("/api/auth/login", json={"password": "пароль-非-ascii"})
    assert response.status_code == 401
    # Four more identical failures should hit the 5-failure lockout, proving
    # register_failure was actually incremented (not skipped, or never reached).
    # proving register_failure was actually incremented (not skipped/crashed).
    for _ in range(4):
        client.post("/api/auth/login", json={"password": "пароль-非-ascii"})
    locked = client.post("/api/auth/login", json={"password": "пароль-非-ascii"})
    assert locked.status_code == 429


def test_auth_enabled_env_false_is_lockout_escape_hatch() -> None:
    state = FakeAppState()
    client = _build_client(state)
    _enable_auth(state=state, client=client)
    state.settings.auth_enabled = "false"
    invalidate_auth_cache(state)
    assert client.get("/api/config/logging").status_code == 200


def test_enabling_auth_without_password_is_rejected() -> None:
    state = FakeAppState()
    client = _build_client(state)
    response = client.put("/api/auth/config", json={"enabled": True})
    assert response.status_code == 400


def test_short_password_is_rejected() -> None:
    state = FakeAppState()
    client = _build_client(state)
    response = client.put("/api/auth/config", json={"password": "short", "enabled": True})
    assert response.status_code == 400


def test_password_change_revokes_existing_sessions() -> None:
    state = FakeAppState()
    client = _build_client(state)
    _enable_auth(state=state, client=client)

    login = client.post("/api/auth/login", json={"password": "hunter2secret"})
    assert login.status_code == 200
    assert client.get("/api/config/logging").status_code == 200

    changed = client.put("/api/auth/config", json={"password": "newhunter2pass"})
    assert changed.status_code == 200
    invalidate_auth_cache(state)
    # The pre-change cookie carries the old session epoch and must be dead.
    assert client.get("/api/config/logging").status_code == 401

    relogin = client.post("/api/auth/login", json={"password": "newhunter2pass"})
    assert relogin.status_code == 200
    assert client.get("/api/config/logging").status_code == 200
