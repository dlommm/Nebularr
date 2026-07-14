"""/api/status must serve a short-TTL cached payload between health computations."""

from __future__ import annotations

import time
from typing import Any

from fakes import FakeAppState
from fastapi import FastAPI
from fastapi.testclient import TestClient

from arrsync.routers import system as system_module


def _build_client(monkeypatch: Any) -> tuple[TestClient, dict[str, int], FakeAppState]:
    calls = {"count": 0}

    def fake_compute(_session: Any, _settings: Any, _metrics: Any) -> dict[str, Any]:
        calls["count"] += 1
        return {"health_state": "ok", "computed": calls["count"]}

    monkeypatch.setattr(system_module, "compute_health_status", fake_compute)
    state = FakeAppState()
    app = FastAPI()
    app.include_router(system_module.build_system_router(state))
    return TestClient(app), calls, state


def test_status_served_from_cache_within_ttl(monkeypatch: Any) -> None:
    client, calls, _state = _build_client(monkeypatch)
    first = client.get("/api/status").json()
    second = client.get("/api/status").json()
    assert calls["count"] == 1
    assert first == second


def test_status_recomputes_after_ttl_expiry(monkeypatch: Any) -> None:
    client, calls, state = _build_client(monkeypatch)
    client.get("/api/status")
    assert calls["count"] == 1
    payload, _ts = state.status_cache
    state.status_cache = (payload, time.monotonic() - system_module.STATUS_CACHE_TTL_SECONDS - 1)
    client.get("/api/status")
    assert calls["count"] == 2


def test_status_serves_background_loop_payload_without_compute(monkeypatch: Any) -> None:
    client, calls, state = _build_client(monkeypatch)
    state.status_cache = ({"health_state": "warning", "from": "background"}, time.monotonic())
    body = client.get("/api/status").json()
    assert body["from"] == "background"
    assert calls["count"] == 0
