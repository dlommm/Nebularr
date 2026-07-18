"""X-Setup-Token gate on setup's mutating first-boot endpoints (v2.7.0 task 1).

The token exists only to protect the window between "container up" and "operator
finished the wizard" on a box with no auth configured yet; see main.py's
``_maybe_issue_bootstrap_token`` for when it gets minted.
"""

from __future__ import annotations

from fakes import FakeAppState
from fastapi import FastAPI
from fastapi.testclient import TestClient

from arrsync.api import build_router

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
