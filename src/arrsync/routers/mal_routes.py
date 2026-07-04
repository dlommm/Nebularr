"""MyAnimeList pipeline triggers and data reset."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlalchemy import text

from arrsync.mal import repository as mal_repo
from arrsync.mal.ingest_service import MalIngestAlreadyRunningError
from arrsync.routers.shared import (
    to_bool,
)

log = logging.getLogger(__name__)


def build_mal_router(app_state: Any) -> APIRouter:
    router = APIRouter()

    @router.post("/api/mal/ingest")
    async def trigger_mal_ingest(payload: dict[str, Any] | None = None) -> dict[str, Any]:
        svc = app_state.mal_ingest_service
        if svc is None:
            raise HTTPException(status_code=501, detail="MAL ingest service unavailable")
        payload = payload or {}
        raw_mid = payload.get("max_ids_per_run", None)
        max_ids_per_run: int | None
        if raw_mid is None or raw_mid == "":
            max_ids_per_run = None
        else:
            try:
                max_ids_per_run = int(raw_mid)
            except (TypeError, ValueError) as e:
                raise HTTPException(status_code=400, detail="max_ids_per_run must be an integer") from e
            if max_ids_per_run < 1 or max_ids_per_run > 500:
                raise HTTPException(
                    status_code=400, detail="max_ids_per_run must be between 1 and 500 (one batch per run)",
                )
        try:
            details = await svc.run(reason="manual", max_ids_per_run=max_ids_per_run)
        except MalIngestAlreadyRunningError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"mal ingest failed: {exc}") from exc
        return {"status": "ok", "details": details}

    @router.post("/api/mal/ingest-backlog")
    async def trigger_mal_ingest_backlog(payload: dict[str, Any] | None = None) -> dict[str, Any]:
        svc = app_state.mal_ingest_service
        if svc is None:
            raise HTTPException(status_code=501, detail="MAL ingest service unavailable")
        payload = payload or {}
        import_all = to_bool(payload.get("import_all", False), False)
        raw_batch = payload.get("max_ids_per_run", None)
        batch_for_run: int | None
        if raw_batch is None or raw_batch == "":
            batch_for_run = None
        else:
            try:
                batch_for_run = int(raw_batch)
            except (TypeError, ValueError) as e:
                raise HTTPException(status_code=400, detail="max_ids_per_run must be an integer") from e
            if batch_for_run < 1 or batch_for_run > 500:
                raise HTTPException(
                    status_code=400, detail="max_ids_per_run must be between 1 and 500",
                )

        raw_cycle_delay = payload.get("cycle_delay_seconds", 2.0)
        try:
            cycle_delay_seconds = max(0.0, min(float(raw_cycle_delay), 30.0))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="cycle_delay_seconds must be a number") from None
        if import_all:
            # Space out batch runs so we do not hammer MAL / Jikan between cycles.
            cycle_delay_seconds = max(1.0, cycle_delay_seconds)

        with app_state.session_scope() as session:
            pending_before = mal_repo.count_anime_needing_mal_fetch(session)

        batch_size_for_plan = max(
            1,
            min(
                int(batch_for_run) if batch_for_run is not None else int(
                    app_state.settings.mal_max_ids_per_run
                ),
                500,
            ),
        )
        if import_all:
            if pending_before <= 0:
                max_cycles = 0
            else:
                # +2: small buffer if dub list shifts pending counts mid-run.
                max_cycles = min(500, (pending_before + batch_size_for_plan - 1) // batch_size_for_plan + 2)
        else:
            raw_cycles = payload.get("max_cycles", 25)
            try:
                max_cycles = max(1, min(int(raw_cycles), 200))
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="max_cycles must be an integer") from None

        # Per run(): None means use MAL_MAX_IDS_PER_RUN from environment/settings.
        eff_batch_arg: int | None = batch_for_run

        cycle_results: list[dict[str, Any]] = []
        pending_after = pending_before
        for idx in range(max_cycles):
            if pending_after <= 0:
                break
            try:
                details = await svc.run(
                    reason="manual_backlog", max_ids_per_run=eff_batch_arg
                )
            except MalIngestAlreadyRunningError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc
            except Exception as exc:
                raise HTTPException(status_code=502, detail=f"mal ingest-backlog failed: {exc}") from exc
            with app_state.session_scope() as session:
                pending_after = mal_repo.count_anime_needing_mal_fetch(session)
            cycle_results.append(
                {
                    "cycle": idx + 1,
                    "pending_after_cycle": pending_after,
                    "mal_api_calls": int(details.get("mal_api_calls", 0) or 0),
                    "jikan_calls": int(details.get("jikan_calls", 0) or 0),
                    "mal_fetch_pending_batch": int(details.get("mal_fetch_pending_batch", 0) or 0),
                    "max_ids_per_run": int(details.get("max_ids_per_run", 0) or 0),
                }
            )
            # Safety stop: if nothing was fetched in this cycle, further loops are unlikely to progress.
            if int(details.get("mal_api_calls", 0) or 0) == 0:
                break
            if idx + 1 < max_cycles and pending_after > 0 and cycle_delay_seconds > 0:
                await asyncio.sleep(cycle_delay_seconds)
        with app_state.session_scope() as session:
            fetched_success = mal_repo.count_anime_fetched_success(session)
            dubbed_total = int(
                session.execute(
                    text("select count(*) from mal.anime where is_english_dubbed = true")
                ).scalar_one()
            )
        return {
            "status": "ok",
            "details": {
                "pending_before": pending_before,
                "pending_after": pending_after,
                "cycles_run": len(cycle_results),
                "max_cycles": max_cycles,
                "import_all": import_all,
                "batch_size": batch_size_for_plan,
                "cycle_delay_seconds": cycle_delay_seconds,
                "fetched_success": fetched_success,
                "dubbed_total": dubbed_total,
                "cycle_results": cycle_results,
            },
        }

    @router.post("/api/mal/match-refresh")
    async def trigger_mal_match_refresh() -> dict[str, Any]:
        svc = app_state.mal_matcher_service
        if svc is None:
            raise HTTPException(status_code=501, detail="MAL matcher service unavailable")
        try:
            details = await asyncio.to_thread(svc.run, reason="manual")
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"mal match-refresh failed: {exc}") from exc
        return {"status": "ok", "details": details}

    @router.post("/api/mal/tag-sync")
    async def trigger_mal_tag_sync() -> dict[str, Any]:
        svc = app_state.mal_tag_sync_service
        if svc is None:
            raise HTTPException(status_code=501, detail="MAL tag sync service unavailable")
        try:
            details = await svc.run(reason="manual")
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"mal tag-sync failed: {exc}") from exc
        return {"status": "ok", "details": details}

    @router.post("/api/mal/reset-data")
    async def reset_mal_data(payload: dict[str, Any]) -> dict[str, Any]:
        """Clear MAL dub list snapshots, anime rows, links, externals, checkpoints, and job history.

        Does not modify Sonarr/Radarr warehouse tables, ``app.settings``, or integration credentials.
        """
        confirmation = str(payload.get("confirmation", "")).strip().upper()
        if confirmation != "RESET_MAL":
            raise HTTPException(status_code=400, detail="confirmation must be RESET_MAL")
        with app_state.session_scope() as session:
            mal_repo.clear_mal_synchronized_data(session)
        return {
            "status": "ok",
            "message": "MAL synchronized data cleared (warehouse and app settings unchanged)",
        }

    return router
