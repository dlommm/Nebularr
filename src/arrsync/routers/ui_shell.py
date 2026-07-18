"""SPA shell: index/setup pages, static assets, and the catch-all fallback.

build_router must include this module LAST: the /{frontend_path:path} route
matches anything not claimed by an earlier route."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse

from arrsync.services.settings_store import get_setting

log = logging.getLogger(__name__)


def build_ui_shell_router(app_state: Any) -> APIRouter:
    router = APIRouter()

    web_ui_dir = Path(__file__).parent.parent.joinpath("web")
    web_ui_path = web_ui_dir.joinpath("index.html")
    web_dist_dir = web_ui_dir.joinpath("dist")
    web_dist_index = web_dist_dir.joinpath("index.html")
    web_assets_dir = web_ui_dir.joinpath("assets")

    def _index_html() -> str:
        selected_index = web_dist_index if web_dist_index.exists() else web_ui_path
        return selected_index.read_text(encoding="utf-8")

    @router.get("/", response_class=HTMLResponse)
    def ui_home():
        if not app_state.session_factory.ready:
            return RedirectResponse(url="/setup", status_code=307)
        with app_state.session_scope() as session:
            setup_completed = get_setting(session, "app.setup_completed", "false").lower() == "true"
        if not setup_completed:
            return RedirectResponse(url="/setup", status_code=307)
        return _index_html()

    @router.get("/setup", response_class=HTMLResponse)
    def ui_setup():
        if app_state.session_factory.ready:
            with app_state.session_scope() as session:
                setup_completed = get_setting(session, "app.setup_completed", "false").lower() == "true"
            if setup_completed:
                return RedirectResponse(url="/", status_code=307)
        return _index_html()

    @router.get("/assets/{asset_name:path}")
    async def ui_asset(asset_name: str) -> FileResponse:
        def _safe(base: Path) -> Path | None:
            if not base.is_dir():
                return None
            candidate = (base / asset_name).resolve()
            if not candidate.is_relative_to(base.resolve()):
                return None
            return candidate if candidate.is_file() else None

        if asset_name.startswith(("/", "\\")) or ".." in asset_name.split("/"):
            raise HTTPException(status_code=404, detail="asset not found")
        for base in (web_dist_dir / "assets", web_assets_dir):
            found = _safe(base)
            if found is not None:
                return FileResponse(found)
        raise HTTPException(status_code=404, detail="asset not found")

    @router.get("/{frontend_path:path}", response_class=HTMLResponse)
    async def ui_spa_fallback(frontend_path: str) -> str:
        if frontend_path.startswith(("api/", "healthz", "metrics", "assets/", "hooks/")):
            raise HTTPException(status_code=404, detail="not found")
        return _index_html()

    return router
