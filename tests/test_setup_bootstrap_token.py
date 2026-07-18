"""X-Setup-Token gate on setup's mutating first-boot endpoints (v2.7.0 task 1).

The token exists only to protect the window between "container up" and "operator
finished the wizard" on a box with no auth configured yet; see main.py's
``_maybe_issue_bootstrap_token`` for when it gets minted.
"""

from __future__ import annotations

import io
import logging

from fakes import FakeAppState
from fastapi import FastAPI
from fastapi.testclient import TestClient

from arrsync import main as main_mod
from arrsync.api import build_router
from arrsync.log_buffer import RING_MAX_LINES, get_recent_log_lines
from arrsync.logging import configure_logging

WIZARD_PAYLOAD = {"sonarr": {"skip": True}, "radarr": {"skip": True}}


def _client(state: FakeAppState) -> TestClient:
    app = FastAPI()
    app.include_router(build_router(state))
    return TestClient(app)


def test_missing_header_is_rejected() -> None:
    state = FakeAppState()
    state.setup_bootstrap_token = "s3cr3t-token"
    client = _client(state)
    response = client.post("/api/setup/wizard", json=WIZARD_PAYLOAD)
    assert response.status_code == 403


def test_wrong_token_is_rejected() -> None:
    state = FakeAppState()
    state.setup_bootstrap_token = "s3cr3t-token"
    client = _client(state)
    response = client.post(
        "/api/setup/wizard", json=WIZARD_PAYLOAD, headers={"x-setup-token": "wrong-token"}
    )
    assert response.status_code == 403


def test_correct_token_is_accepted() -> None:
    state = FakeAppState()
    state.setup_bootstrap_token = "s3cr3t-token"
    client = _client(state)
    response = client.post(
        "/api/setup/wizard", json=WIZARD_PAYLOAD, headers={"x-setup-token": "s3cr3t-token"}
    )
    assert response.status_code == 200


def test_no_token_required_after_setup_complete() -> None:
    state = FakeAppState()
    state.setup_bootstrap_token = "s3cr3t-token"
    state.session.settings["app.setup_completed"] = "true"
    client = _client(state)
    response = client.post("/api/setup/wizard", json=WIZARD_PAYLOAD)
    assert response.status_code == 200


def test_no_token_required_once_auth_is_configured() -> None:
    state = FakeAppState()
    state.setup_bootstrap_token = "s3cr3t-token"
    state.session.settings["app.auth_password_hash"] = "scrypt$abc$def"
    client = _client(state)
    response = client.post("/api/setup/wizard", json=WIZARD_PAYLOAD)
    assert response.status_code == 200


def test_no_token_configured_never_gates_the_endpoint() -> None:
    state = FakeAppState()
    client = _client(state)
    response = client.post("/api/setup/wizard", json=WIZARD_PAYLOAD)
    assert response.status_code == 200


def test_status_reports_bootstrap_token_required() -> None:
    state = FakeAppState()
    state.setup_bootstrap_token = "s3cr3t-token"
    client = _client(state)
    assert client.get("/api/setup/status").json()["bootstrap_token_required"] is True

    state.session.settings["app.setup_completed"] = "true"
    assert client.get("/api/setup/status").json()["bootstrap_token_required"] is False


def test_status_reports_no_token_required_when_none_issued() -> None:
    state = FakeAppState()
    client = _client(state)
    assert client.get("/api/setup/status").json()["bootstrap_token_required"] is False


def test_non_ascii_header_is_rejected_not_500() -> None:
    # Regression: secrets.compare_digest(str, str) raises TypeError on non-ASCII
    # input, same footgun as the auth_routes.py recovery-password compare. httpx's
    # convenience headers=dict[str, str] refuses non-ASCII str values client-side
    # (UnicodeEncodeError), so send raw high-byte bytes instead — Starlette decodes
    # ASGI header bytes via latin-1, landing as a non-ASCII str on the server side,
    # same as a real adversarial/malformed client would produce.
    state = FakeAppState()
    state.setup_bootstrap_token = "s3cr3t-token"
    client = _client(state)
    response = client.post(
        "/api/setup/wizard", json=WIZARD_PAYLOAD, headers={"x-setup-token": b"\xe9\xe8\xe7-token"}
    )
    assert response.status_code == 403


def test_bootstrap_token_reaches_stdout_but_not_the_ring_buffer(monkeypatch) -> None:
    # The token gates the unauthenticated /api/setup/* window, but /api/ui/logs is
    # itself unauthenticated exactly while that gate is active — so the token line
    # must stay visible in container stdout yet never enter the Web UI ring buffer.
    configure_logging("INFO")
    stream = io.StringIO()
    stream_handler = logging.StreamHandler(stream)
    stream_handler.setLevel(logging.WARNING)
    root = logging.getLogger()
    root.addHandler(stream_handler)
    try:
        state = FakeAppState()
        monkeypatch.setattr(main_mod, "app_state", state)
        main_mod._maybe_issue_bootstrap_token()

        token = state.setup_bootstrap_token
        assert token, "expected a bootstrap token to be minted"

        # (a) The token is visible via a plain stdout/stream handler.
        stream_handler.flush()
        assert token in stream.getvalue()

        # (b) The token is NOT in the ring buffer that /api/ui/logs serves.
        assert all(token not in line for line in get_recent_log_lines(RING_MAX_LINES))
    finally:
        root.removeHandler(stream_handler)


def test_ui_logs_endpoint_never_serves_the_bootstrap_token(monkeypatch) -> None:
    configure_logging("INFO")
    state = FakeAppState()
    monkeypatch.setattr(main_mod, "app_state", state)
    main_mod._maybe_issue_bootstrap_token()
    token = state.setup_bootstrap_token
    assert token

    # Gate is active (token set, setup not complete) — the same unauthenticated
    # window in which the logs endpoint is reachable.
    client = _client(state)
    response = client.get("/api/ui/logs")
    assert response.status_code == 200
    assert token not in response.text


def test_setup_skip_is_gated_by_bootstrap_token() -> None:
    # setup_skip flips app.setup_completed=true, which deactivates the gate itself —
    # it must be gated too, not just initialize-postgres/bootstrap-database/wizard/
    # initial-sync.
    state = FakeAppState()
    state.setup_bootstrap_token = "s3cr3t-token"
    client = _client(state)

    missing = client.post("/api/setup/skip")
    assert missing.status_code == 403

    wrong = client.post("/api/setup/skip", headers={"x-setup-token": "nope"})
    assert wrong.status_code == 403

    ok = client.post("/api/setup/skip", headers={"x-setup-token": "s3cr3t-token"})
    assert ok.status_code == 200
