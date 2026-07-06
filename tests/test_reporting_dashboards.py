from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from arrsync.api import build_router
from tests.fakes import FakeAppState


def _build_client() -> TestClient:
    app = FastAPI()
    app.include_router(build_router(FakeAppState()))
    return TestClient(app, raise_server_exceptions=False)


def test_dashboard_catalog_lists_unique_keys() -> None:
    client = _build_client()
    response = client.get("/api/reporting/dashboards")
    assert response.status_code == 200
    catalog = response.json()
    keys = [entry["key"] for entry in catalog]
    assert len(keys) >= 9
    assert len(keys) == len(set(keys))
    for entry in catalog:
        assert entry["title"]
        assert entry["description"]


def test_every_catalog_key_routes_to_a_handler() -> None:
    """build_router raises at startup if catalog and handlers diverge; this
    exercises the surviving direction — every advertised key is servable
    (anything but 404). The fake session cannot satisfy warehouse SQL, so a
    non-404 response is the signal that a handler exists for the key."""
    client = _build_client()
    catalog = client.get("/api/reporting/dashboards").json()
    for entry in catalog:
        response = client.get(f"/api/reporting/dashboards/{entry['key']}")
        assert response.status_code != 404, f"catalog key {entry['key']} has no handler"


def test_unknown_dashboard_returns_404() -> None:
    client = _build_client()
    response = client.get("/api/reporting/dashboards/not-a-dashboard")
    assert response.status_code == 404
