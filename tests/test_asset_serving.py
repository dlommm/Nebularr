"""GET /assets/{...}: path traversal must 404, real dist/static assets must still serve."""

from __future__ import annotations

from pathlib import Path

from fakes import FakeAppState
from fastapi import FastAPI
from fastapi.testclient import TestClient

from arrsync.routers.ui_shell import build_ui_shell_router

WEB_DIR = Path(__file__).resolve().parents[1] / "src" / "arrsync" / "web"


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(build_ui_shell_router(FakeAppState()))
    return TestClient(app)


def test_absolute_path_via_double_slash_is_rejected() -> None:
    client = _client()
    response = client.get("/assets//etc/hosts")
    assert response.status_code == 404


def test_percent_encoded_dotdot_traversal_is_rejected() -> None:
    client = _client()
    response = client.get("/assets/%2e%2e/config.py")
    assert response.status_code == 404


def test_legit_dist_asset_still_serves() -> None:
    dist_assets = WEB_DIR / "dist" / "assets"
    real_asset = next(p for p in dist_assets.iterdir() if p.is_file())
    client = _client()
    response = client.get(f"/assets/{real_asset.name}")
    assert response.status_code == 200


def test_legit_static_asset_still_serves() -> None:
    client = _client()
    response = client.get("/assets/nebularr-logo.svg")
    assert response.status_code == 200
