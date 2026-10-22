"""Artwork endpoints: images proxied from Sonarr/Radarr, the sign-in wall, and settings.

``/api/art/wall`` and ``/api/art/wall/{token}`` are deliberately reachable before
sign-in (see ``arrsync.auth.AUTH_EXEMPT_PREFIXES``) so the login page can show the
library's posters. They only ever serve files already in the cache and never start
an outbound fetch, so an anonymous caller cannot use them to drive traffic to the
Arrs.
"""

from __future__ import annotations

import asyncio
import dataclasses
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response

from arrsync.services.artwork_service import WALL_MAX_COUNT, Artwork, ArtworkService
from arrsync.services.artwork_store import (
    ARTWORK_MODES,
    MAX_CACHE_MB,
    read_artwork_settings,
    write_artwork_settings,
)

_PRIVATE_CACHE = "private, max-age=604800"


def _image_response(art: Artwork, request: Request) -> Response:
    headers = {"Cache-Control": _PRIVATE_CACHE, "ETag": art.etag, "X-Content-Type-Options": "nosniff"}
    if request.headers.get("if-none-match") == art.etag:
        return Response(status_code=304, headers=headers)
    if art.path is not None:
        return FileResponse(art.path, media_type=art.content_type, headers=headers)
    return Response(content=art.body or b"", media_type=art.content_type, headers=headers)


def build_artwork_router(app_state: Any) -> APIRouter:
    router = APIRouter()
    background: set[asyncio.Task[Any]] = set()

    def service() -> ArtworkService:
        svc = getattr(app_state, "artwork_service", None)
        if svc is None:
            raise HTTPException(status_code=503, detail="artwork service unavailable")
        return svc  # type: ignore[no-any-return]

    def start_prefetch(svc: ArtworkService, reason: str) -> bool:
        if svc.prefetch_running:
            return False
        task = asyncio.get_running_loop().create_task(svc.prefetch(reason=reason))
        background.add(task)
        task.add_done_callback(background.discard)
        return True

    def status(svc: ArtworkService) -> dict[str, Any]:
        with app_state.session_scope() as session:
            prefs = dict(read_artwork_settings(session))
        report = svc.last_prefetch
        return {
            **prefs,
            "cache": svc.stats(),
            "prefetch_running": svc.prefetch_running,
            "last_prefetch": dataclasses.asdict(report) if report is not None else None,
        }

    @router.get("/api/art/wall")
    async def art_wall(count: int = Query(40, ge=1, le=WALL_MAX_COUNT)) -> dict[str, Any]:
        svc = service()
        tokens = await asyncio.to_thread(svc.wall, count)
        return {"items": [f"/api/art/wall/{token}" for token in tokens]}

    @router.get("/api/art/wall/{token}")
    async def art_wall_image(token: str) -> Response:
        path = await asyncio.to_thread(service().wall_file, token)
        if path is None:
            raise HTTPException(status_code=404, detail="not found")
        return FileResponse(
            path,
            headers={"Cache-Control": _PRIVATE_CACHE, "X-Content-Type-Options": "nosniff"},
        )

    @router.get("/api/art/{kind}/{instance_name}/{item_id}/{cover}")
    async def art_image(
        kind: str,
        instance_name: str,
        item_id: int,
        cover: str,
        request: Request,
        size: int | None = Query(None),
    ) -> Response:
        try:
            art = await service().get(kind, instance_name, item_id, cover, size)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if art is None:
            raise HTTPException(status_code=404, detail="no artwork")
        return _image_response(art, request)

    @router.get("/api/config/artwork")
    async def get_artwork_config() -> dict[str, Any]:
        svc = service()
        return await asyncio.to_thread(status, svc)

    @router.put("/api/config/artwork")
    async def update_artwork_config(payload: dict[str, Any]) -> dict[str, Any]:
        svc = service()
        updates: dict[str, object] = {}
        for key in ("enabled", "remote_fallback"):
            if key in payload:
                if not isinstance(payload[key], bool):
                    raise HTTPException(status_code=400, detail=f"{key} must be true or false")
                updates[key] = payload[key]
        if "mode" in payload:
            if payload["mode"] not in ARTWORK_MODES:
                raise HTTPException(status_code=400, detail="mode must be 'cache' or 'live'")
            updates["mode"] = payload["mode"]
        if "cache_max_mb" in payload:
            cap = payload["cache_max_mb"]
            if isinstance(cap, bool) or not isinstance(cap, int) or cap < 0 or cap > MAX_CACHE_MB:
                raise HTTPException(
                    status_code=400, detail=f"cache_max_mb must be 0 (no limit) to {MAX_CACHE_MB}"
                )
            updates["cache_max_mb"] = cap
        if not updates:
            raise HTTPException(status_code=400, detail="no artwork fields provided")

        def save() -> tuple[str, str]:
            with app_state.session_scope() as session:
                before = read_artwork_settings(session)["mode"]
                after = write_artwork_settings(session, updates)["mode"]
            return before, after

        before, after = await asyncio.to_thread(save)
        svc.invalidate_settings()
        if after == "live" and before != "live":
            await asyncio.to_thread(svc.trim_for_live)
        elif "cache_max_mb" in updates:
            await asyncio.to_thread(svc.enforce_cap, int(updates["cache_max_mb"]))  # type: ignore[call-overload]
        if after == "cache" and before != "cache":
            start_prefetch(svc, "mode-change")
        return await asyncio.to_thread(status, svc)

    @router.post("/api/config/artwork/prefetch")
    async def trigger_artwork_prefetch() -> dict[str, Any]:
        return {"started": start_prefetch(service(), "manual")}

    @router.post("/api/config/artwork/clear-cache")
    async def clear_artwork_cache() -> dict[str, Any]:
        svc = service()
        if svc.prefetch_running:
            raise HTTPException(status_code=409, detail="a prefetch is running; try again when it finishes")
        removed = await asyncio.to_thread(svc.clear)
        return {"removed": removed, **(await asyncio.to_thread(status, svc))}

    return router
