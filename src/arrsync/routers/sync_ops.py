"""Sync/queue observability (runs, progress, work status, logs) and manual sync triggers."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy import text

from arrsync.log_buffer import get_recent_logs_parsed, ring_buffer_capacity
from arrsync.routers.shared import (
    setup_sync_state,
    clamp_limit,
    paged_response,
)
from arrsync.services import repository as repo
from arrsync.services.log_level_store import (
    effective_log_level,
)

log = logging.getLogger(__name__)


def build_sync_ops_router(app_state: Any) -> APIRouter:
    router = APIRouter()

    @router.get("/api/ui/recent-runs")
    async def recent_runs() -> list[dict[str, Any]]:
        with app_state.session_scope() as session:
            rows = session.execute(
                text(
                    """
                    select source, mode, instance_name, status, started_at, finished_at, rows_written, error_message
                    from app.job_run_summary
                    order by started_at desc
                    limit 30
                    """
                )
            ).mappings()
            return [dict(r) for r in rows]

    @router.get("/api/ui/sync-progress")
    async def sync_progress() -> dict[str, Any]:
        """Primary running Sonarr/Radarr warehouse sync (any trigger: manual, scheduler, webhook, etc.)."""
        with app_state.session_scope() as session:
            active_run = session.execute(
                text(
                    """
                    select
                        id,
                        source,
                        mode,
                        instance_name,
                        started_at,
                        coalesce(records_processed, 0) as records_processed,
                        coalesce(details ->> 'stage', 'starting') as stage,
                        coalesce(details ->> 'stage_note', '') as stage_note,
                        coalesce(details ->> 'trigger', 'unknown') as trigger,
                        round(extract(epoch from (now() - started_at))::numeric, 1) as elapsed_seconds
                    from warehouse.sync_run
                    where status = 'running'
                      and source in ('sonarr', 'radarr')
                      and mode in ('full', 'incremental', 'reconcile')
                    order by started_at desc
                    limit 1
                    """
                )
            ).mappings().first()
            if not active_run:
                return {"running": False}

            baseline = session.execute(
                text(
                    """
                    select
                        round(avg(extract(epoch from (finished_at - started_at)))::numeric, 1) as avg_seconds,
                        count(*)::int as sample_size
                    from warehouse.sync_run
                    where source = :source
                      and mode = :mode
                      and instance_name = :instance_name
                      and status in ('success', 'failed')
                      and finished_at is not null
                    """
                ),
                {
                    "source": active_run["source"],
                    "mode": active_run["mode"],
                    "instance_name": active_run["instance_name"],
                },
            ).mappings().first()

        elapsed_seconds = float(active_run["elapsed_seconds"] or 0)
        avg_seconds = float(baseline["avg_seconds"]) if baseline and baseline["avg_seconds"] is not None else None
        eta_seconds = max(avg_seconds - elapsed_seconds, 0.0) if avg_seconds is not None else None
        progress_pct = min(round((elapsed_seconds / avg_seconds) * 100.0, 1), 99.0) if avg_seconds and avg_seconds > 0 else None
        return {
            "running": True,
            "run_id": int(active_run["id"]),
            "source": active_run["source"],
            "mode": active_run["mode"],
            "instance_name": active_run["instance_name"],
            "started_at": active_run["started_at"],
            "elapsed_seconds": elapsed_seconds,
            "records_processed": int(active_run["records_processed"] or 0),
            "stage": active_run["stage"],
            "stage_note": active_run["stage_note"],
            "trigger": str(active_run["trigger"] or "unknown"),
            "estimated_total_seconds": avg_seconds,
            "eta_seconds": eta_seconds,
            "progress_pct": progress_pct,
            "history_sample_size": int(baseline["sample_size"] or 0) if baseline else 0,
        }

    @router.get("/api/ui/work-status")
    async def work_status() -> dict[str, Any]:
        """Aggregated active work: warehouse syncs, MAL jobs, and setup-wizard initial sync."""
        items: list[dict[str, Any]] = []
        wh_running = False
        with app_state.session_scope() as session:
            wh_rows = session.execute(
                text(
                    """
                    select
                        id,
                        source,
                        mode,
                        instance_name,
                        started_at,
                        coalesce(records_processed, 0) as records_processed,
                        coalesce(details ->> 'stage', 'starting') as stage,
                        coalesce(details ->> 'stage_note', '') as stage_note,
                        coalesce(details ->> 'trigger', 'unknown') as trigger,
                        round(extract(epoch from (now() - started_at))::numeric, 1) as elapsed_seconds
                    from warehouse.sync_run
                    where status = 'running'
                      and source in ('sonarr', 'radarr')
                      and mode in ('full', 'incremental', 'reconcile')
                    order by started_at asc
                    """
                )
            ).mappings().all()
            for row in wh_rows:
                wh_running = True
                baseline = session.execute(
                    text(
                        """
                        select
                            round(avg(extract(epoch from (finished_at - started_at)))::numeric, 1) as avg_seconds,
                            count(*)::int as sample_size
                        from warehouse.sync_run
                        where source = :source
                          and mode = :mode
                          and instance_name = :instance_name
                          and status in ('success', 'failed')
                          and finished_at is not null
                        """
                    ),
                    {
                        "source": row["source"],
                        "mode": row["mode"],
                        "instance_name": row["instance_name"],
                    },
                ).mappings().first()
                elapsed_seconds = float(row["elapsed_seconds"] or 0)
                avg_seconds = float(baseline["avg_seconds"]) if baseline and baseline["avg_seconds"] is not None else None
                eta_seconds = max(avg_seconds - elapsed_seconds, 0.0) if avg_seconds is not None else None
                progress_pct = (
                    min(round((elapsed_seconds / avg_seconds) * 100.0, 1), 99.0) if avg_seconds and avg_seconds > 0 else None
                )
                items.append(
                    {
                        "kind": "warehouse",
                        "run_id": int(row["id"]),
                        "source": row["source"],
                        "mode": row["mode"],
                        "instance_name": row["instance_name"],
                        "started_at": row["started_at"],
                        "trigger": row["trigger"],
                        "stage": row["stage"],
                        "stage_note": row["stage_note"],
                        "elapsed_seconds": elapsed_seconds,
                        "records_processed": int(row["records_processed"] or 0),
                        "estimated_total_seconds": avg_seconds,
                        "eta_seconds": eta_seconds,
                        "progress_pct": progress_pct,
                        "history_sample_size": int(baseline["sample_size"] or 0) if baseline else 0,
                    }
                )

            mal_rows = session.execute(
                text(
                    """
                    select
                        id,
                        job_type,
                        started_at,
                        coalesce(details, '{}'::jsonb) as details,
                        round(extract(epoch from (now() - started_at))::numeric, 1) as elapsed_seconds
                    from app.mal_job_run
                    where status = 'running'
                    order by started_at asc
                    """
                )
            ).mappings().all()
            for row in mal_rows:
                jt = str(row["job_type"])
                baseline_mal = session.execute(
                    text(
                        """
                        select
                            round(avg(extract(epoch from (finished_at - started_at)))::numeric, 1) as avg_seconds,
                            count(*)::int as sample_size
                        from app.mal_job_run
                        where job_type = :job_type
                          and status in ('success', 'failed')
                          and finished_at is not null
                        """
                    ),
                    {"job_type": jt},
                ).mappings().first()
                elapsed_mal = float(row["elapsed_seconds"] or 0)
                avg_mal = float(baseline_mal["avg_seconds"]) if baseline_mal and baseline_mal["avg_seconds"] is not None else None
                eta_mal = max(avg_mal - elapsed_mal, 0.0) if avg_mal is not None else None
                progress_mal = (
                    min(round((elapsed_mal / avg_mal) * 100.0, 1), 99.0) if avg_mal and avg_mal > 0 else None
                )
                raw_details = row["details"]
                details_obj: dict[str, Any]
                if isinstance(raw_details, dict):
                    details_obj = dict(raw_details)
                else:
                    details_obj = {}
                items.append(
                    {
                        "kind": "mal",
                        "run_id": int(row["id"]),
                        "job_type": jt,
                        "started_at": row["started_at"],
                        "elapsed_seconds": elapsed_mal,
                        "details": details_obj,
                        "estimated_total_seconds": avg_mal,
                        "eta_seconds": eta_mal,
                        "progress_pct": progress_mal,
                        "history_sample_size": int(baseline_mal["sample_size"] or 0) if baseline_mal else 0,
                    }
                )

        sync_state = setup_sync_state(app_state)
        if sync_state.running:
            elapsed_setup: float | None = None
            if sync_state.started_at is not None:
                elapsed_setup = max(
                    0.0,
                    (datetime.now(timezone.utc) - sync_state.started_at).total_seconds(),
                )
            items.append(
                {
                    "kind": "setup",
                    "running": True,
                    "sources": list(sync_state.sources),
                    "elapsed_seconds": elapsed_setup,
                    "stage": "setup wizard initial library sync",
                    "stage_note": ", ".join(sync_state.sources) if sync_state.sources else "full library",
                }
            )

        return {
            "active": bool(items),
            "items": items,
            "warehouse_running": wh_running,
            "mal_running": any(i.get("kind") == "mal" for i in items),
            "setup_running": sync_state.running,
        }

    @router.get("/api/ui/sync-activity")
    async def sync_activity() -> list[dict[str, Any]]:
        with app_state.session_scope() as session:
            rows = session.execute(
                text(
                    """
                    select
                        id as run_id,
                        source,
                        mode,
                        instance_name,
                        status,
                        started_at,
                        coalesce(records_processed, 0) as records_processed,
                        coalesce(details ->> 'trigger', 'unknown') as trigger,
                        coalesce(details ->> 'stage', 'starting') as stage,
                        coalesce(details ->> 'stage_note', '') as stage_note,
                        round(extract(epoch from (now() - started_at))::numeric, 1) as elapsed_seconds
                    from warehouse.sync_run
                    where status = 'running'
                    order by started_at desc
                    """
                )
            ).mappings()
            return [dict(r) for r in rows]

    @router.get("/api/ui/logs")
    async def ui_recent_logs(limit: int = 400) -> dict[str, Any]:
        bounded = clamp_limit(limit, default=400, max_limit=2000)
        items = get_recent_logs_parsed(bounded)
        with app_state.session_scope() as session:
            eff = effective_log_level(session, app_state.settings)
        return {"items": items, "capacity": ring_buffer_capacity(), "effective_level": eff}

    @router.get("/api/ui/webhook-queue")
    async def webhook_queue_summary() -> list[dict[str, Any]]:
        with app_state.session_scope() as session:
            rows = session.execute(
                text(
                    """
                    select status, count(*) as count
                    from app.webhook_queue
                    group by status
                    order by status
                    """
                )
            ).mappings()
            return [dict(r) for r in rows]

    @router.get("/api/ui/webhook-jobs")
    async def webhook_jobs(
        status: str = "all", limit: int = 100, offset: int = 0, paged: bool = False
    ) -> list[dict[str, Any]] | dict[str, Any]:
        """paged=true adds a total for real pagination; the bare-list default is
        kept for the legacy fallback UI and any scripts."""
        normalized_status = status.lower()
        allowed = {"all", "queued", "retrying", "done", "dead_letter"}
        if normalized_status not in allowed:
            raise HTTPException(status_code=400, detail="invalid status filter")
        bounded_limit = max(1, min(limit, 500))
        bounded_offset = max(0, offset)
        where_clause = ""
        params: dict[str, Any] = {"limit": bounded_limit, "offset": bounded_offset}
        if normalized_status != "all":
            where_clause = "where status = :status"
            params["status"] = normalized_status
        with app_state.session_scope() as session:
            rows = session.execute(
                text(
                    f"""
                    select id, source, event_type, status, attempts, received_at, next_attempt_at, processed_at, error_message
                    from app.webhook_queue
                    {where_clause}
                    order by received_at desc
                    limit :limit
                    offset :offset
                    """
                ),
                params,
            ).mappings()
            items = [dict(r) for r in rows]
            if not paged:
                return items
            total = session.execute(
                text(f"select count(*) from app.webhook_queue {where_clause}"),  # noqa: S608
                {k: v for k, v in params.items() if k == "status"},
            ).scalar_one()
            return paged_response(items, int(total), bounded_limit, bounded_offset)

    def _sync_lock_held(lock_name: str) -> bool:
        with app_state.session_scope() as session:
            return repo.job_lock_held(session, lock_name)

    async def _run_queued_sync(source: str, mode: str) -> None:
        try:
            result = await app_state.sync_service.run_sync(source, mode, reason="manual")
        except Exception:
            app_state.metrics.inc("arrsync_sync_runs_failed_total")
            log.exception("queued manual sync failed", extra={"source": source, "mode": mode})
            return
        app_state.metrics.inc("arrsync_sync_runs_total")
        if result.status == "failed":
            app_state.metrics.inc("arrsync_sync_runs_failed_total")

    @router.post("/api/sync/{source}/{mode}")
    async def trigger_sync(source: str, mode: str, wait: bool = True) -> Any:
        """Blocking by default (documented for scripted runs). With ?wait=false the
        sync is queued as a background task (202) and progress is observable via
        /api/ui/work-status and SSE — the path the SPA uses."""
        if source not in {"sonarr", "radarr"}:
            raise HTTPException(status_code=400, detail="source must be sonarr or radarr")
        if mode not in {"full", "incremental", "reconcile"}:
            raise HTTPException(status_code=400, detail="invalid mode")
        if not wait:
            if await asyncio.to_thread(_sync_lock_held, f"{source}:{mode}"):
                raise HTTPException(status_code=409, detail=f"{source}/{mode} sync already running")
            task = asyncio.create_task(_run_queued_sync(source, mode))
            app_state.manual_sync_tasks.add(task)
            task.add_done_callback(app_state.manual_sync_tasks.discard)
            return JSONResponse({"status": "queued", "source": source, "mode": mode}, status_code=202)
        try:
            result = await app_state.sync_service.run_sync(source, mode, reason="manual")
        except Exception as exc:
            app_state.metrics.inc("arrsync_sync_runs_failed_total")
            raise HTTPException(status_code=502, detail=f"sync failed for {source}/{mode}: {exc}") from exc
        app_state.metrics.inc("arrsync_sync_runs_total")
        if result.status == "failed":
            app_state.metrics.inc("arrsync_sync_runs_failed_total")
        return {
            "source": result.source,
            "mode": result.mode,
            "status": result.status,
            "records_processed": result.records_processed,
            "started_at": result.started_at.isoformat(),
            "finished_at": result.finished_at.isoformat(),
            "details": result.details,
        }

    return router
