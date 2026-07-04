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
    @router.get("/", response_class=HTMLResponse)
    async def ui_home():
        if not app_state.session_factory.ready:
            return RedirectResponse(url="/setup", status_code=307)
        with app_state.session_scope() as session:
            setup_completed = get_setting(session, "app.setup_completed", "false").lower() == "true"
        if not setup_completed:
            return RedirectResponse(url="/setup", status_code=307)
        selected_index = web_dist_index if web_dist_index.exists() else web_ui_path
        html = selected_index.read_text(encoding="utf-8")
        html = html.replace("__APP_VERSION__", app_state.settings.app_version)
        html = html.replace("__APP_GIT_SHA__", app_state.settings.app_git_sha)
        return html

    @router.get("/setup", response_class=HTMLResponse)
    async def ui_setup():
        if app_state.session_factory.ready:
            with app_state.session_scope() as session:
                setup_completed = get_setting(session, "app.setup_completed", "false").lower() == "true"
            if setup_completed:
                return RedirectResponse(url="/", status_code=307)
        selected_index = web_dist_index if web_dist_index.exists() else web_ui_path
        html = selected_index.read_text(encoding="utf-8")
        html = html.replace("__APP_VERSION__", app_state.settings.app_version)
        html = html.replace("__APP_GIT_SHA__", app_state.settings.app_git_sha)
        return html

    @router.get("/assets/{asset_name:path}")
    async def ui_asset(asset_name: str) -> FileResponse:
        if ".." in asset_name:
            raise HTTPException(status_code=404, detail="asset not found")
        if web_dist_dir.exists():
            dist_asset = web_dist_dir.joinpath("assets", asset_name)
            if dist_asset.exists() and dist_asset.is_file():
                return FileResponse(dist_asset)
        asset_path = web_assets_dir.joinpath(asset_name)
        if not asset_path.exists() or not asset_path.is_file():
            raise HTTPException(status_code=404, detail="asset not found")
        return FileResponse(asset_path)

    @router.get("/{frontend_path:path}", response_class=HTMLResponse)
    async def ui_spa_fallback(frontend_path: str) -> str:
        if frontend_path.startswith(("api/", "healthz", "metrics", "assets/", "hooks/")):
            raise HTTPException(status_code=404, detail="not found")
        selected_index = web_dist_index if web_dist_index.exists() else web_ui_path
        html = selected_index.read_text(encoding="utf-8")
        html = html.replace("__APP_VERSION__", app_state.settings.app_version)
        html = html.replace("__APP_GIT_SHA__", app_state.settings.app_git_sha)
        return html

    return router
