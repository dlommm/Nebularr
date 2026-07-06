from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from arrsync.api import build_router

from fakes import FakeAppState


def _build_client(state: FakeAppState | None = None) -> TestClient:
    app = FastAPI()
    app.include_router(build_router(state or FakeAppState()))
    return TestClient(app)


SECRET_HEADER = {"x-arr-shared-secret": "changeme"}


def test_webhook_accepts_small_payload() -> None:
    client = _build_client()
    response = client.post("/hooks/sonarr", headers=SECRET_HEADER, json={"eventType": "Download"})
    assert response.status_code == 200
    assert response.json() == {"status": "accepted"}


def test_webhook_rejects_oversized_payload() -> None:
    state = FakeAppState()
    state.settings.webhook_max_body_bytes = 64
    client = _build_client(state)
    big = {"eventType": "Download", "padding": "x" * 500}
    response = client.post("/hooks/sonarr", headers=SECRET_HEADER, json=big)
    assert response.status_code == 413


def test_webhook_rejects_oversized_chunked_payload_without_content_length() -> None:
    # Chunked transfer means no Content-Length header at all; the cap must apply
    # to the bytes actually received.
    state = FakeAppState()
    state.settings.webhook_max_body_bytes = 64
    client = _build_client(state)

    def body_chunks():  # type: ignore[no-untyped-def]
        yield b'{"eventType": "Download", "padding": "'
        yield b"x" * 500
        yield b'"}'

    response = client.post(
        "/hooks/sonarr",
        headers={**SECRET_HEADER, "content-type": "application/json"},
        content=body_chunks(),
    )
    assert response.status_code == 413


def test_webhook_rejects_invalid_json_and_non_object() -> None:
    client = _build_client()
    bad = client.post(
        "/hooks/sonarr",
        headers={**SECRET_HEADER, "content-type": "application/json"},
        content=b"{not json",
    )
    assert bad.status_code == 400
    non_object = client.post(
        "/hooks/sonarr",
        headers={**SECRET_HEADER, "content-type": "application/json"},
        content=b'["a", "list"]',
    )
    assert non_object.status_code == 400


def test_webhook_rejects_wrong_secret_and_unknown_source() -> None:
    client = _build_client()
    assert (
        client.post("/hooks/sonarr", headers={"x-arr-shared-secret": "wrong"}, json={"eventType": "T"}).status_code
        == 401
    )
    assert client.post("/hooks/lidarr", headers=SECRET_HEADER, json={"eventType": "T"}).status_code == 404


def test_webhook_rejected_when_ingest_disabled() -> None:
    state = FakeAppState()
    state.session.webhook_ingest_allowed = False
    client = _build_client(state)
    response = client.post("/hooks/sonarr", headers=SECRET_HEADER, json={"eventType": "Download"})
    assert response.status_code == 403


def test_webhook_signals_realtime_drain() -> None:
    state = FakeAppState()
    drained: list[str] = []
    state.request_webhook_drain = drained.append
    client = _build_client(state)
    response = client.post("/hooks/sonarr", headers=SECRET_HEADER, json={"eventType": "Download"})
    assert response.status_code == 200
    assert drained == ["sonarr"]
