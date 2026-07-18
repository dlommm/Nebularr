"""Operator tooling: stuck-state recovery, webhook queue ops, admin reset."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlalchemy import text

from arrsync.auth import invalidate_auth_cache
from arrsync.mal import repository as mal_repo
from arrsync.services.settings_store import set_setting
from arrsync.routers.shared import (
    run_db,
    to_bool,
)
from arrsync.services import repository as repo

log = logging.getLogger(__name__)


def build_operator_router(app_state: Any) -> APIRouter:
    router = APIRouter()

    @router.get("/api/operator/integrity-audit")
    def list_integrity_audits(limit: int = 20) -> list[dict[str, Any]]:
        with app_state.session_scope() as session:
            return repo.list_integrity_audit_runs(session, limit=limit)

    @router.post("/api/operator/integrity-audit")
    async def run_integrity_audit(payload: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = payload or {}
        requested = str(payload.get("source", "all")).lower()
        if requested not in {"all", "sonarr", "radarr"}:
            raise HTTPException(status_code=400, detail="source must be sonarr, radarr, or all")
        sources = ["sonarr", "radarr"] if requested == "all" else [requested]
        results: list[dict[str, Any]] = []
        for source in sources:
            try:
                results.extend(await app_state.sync_service.run_integrity_audit(source, reason="manual"))
            except Exception as exc:
                raise HTTPException(status_code=502, detail=f"integrity audit failed for {source}: {exc}") from exc
        return {"status": "ok", "results": results}

    @router.get("/api/operator/stuck-state")
    def operator_stuck_state() -> dict[str, Any]:
        """Inspect job locks, running MAL jobs, and running warehouse job rows (read-only, for clear-stuck UI)."""

        def _ser_row(m: Any) -> dict[str, Any]:
            d = dict(m)
            for k, v in list(d.items()):
                if v is not None and hasattr(v, "isoformat"):
                    d[k] = v.isoformat()
            return d

        with app_state.session_scope() as session:
            all_locks = session.execute(
                text(
                    """
                    select lock_name, owner_id, acquired_at, heartbeat_at, expires_at
                    from app.job_lock
                    order by lock_name
                    """
                )
            ).mappings().all()
            mal_running = session.execute(
                text(
                    """
                    select id, job_type, status, started_at, error_message
                    from app.mal_job_run
                    where status = 'running'
                    order by id
                    """
                )
            ).mappings().all()
            wh_sync_running = session.execute(
                text(
                    """
                    select
                        id, source, mode, instance_name, status, started_at,
                        records_processed,
                        coalesce(details ->> 'trigger', '') as trigger,
                        coalesce(details ->> 'stage', '') as stage
                    from warehouse.sync_run
                    where status = 'running'
                    order by id
                    """
                )
            ).mappings().all()
            job_summary_running = session.execute(
                text(
                    """
                    select id, source, mode, instance_name, status, started_at, rows_written
                    from app.job_run_summary
                    where status = 'running' and source in ('sonarr', 'radarr')
                    order by id
                    """
                )
            ).mappings().all()

        return {
            "job_locks": [_ser_row(r) for r in all_locks],
            "mal_job_runs_running": [_ser_row(r) for r in mal_running],
            "warehouse_sync_runs_running": [_ser_row(r) for r in wh_sync_running],
            "job_run_summary_running": [_ser_row(r) for r in job_summary_running],
        }

    @router.post("/api/operator/clear-stuck")
    def operator_clear_stuck(payload: dict[str, Any]) -> dict[str, Any]:
        """Clear stuck coordination and job state in the database: locks, MAL run rows, warehouse sync run rows.

        Long tasks run in-process; a crash or kill can leave ``app.job_lock`` or ``running`` run rows
        until cleared here or a lease expires.
        """
        confirmation = str(payload.get("confirmation", "")).strip().upper()
        if confirmation != "CLEAR_STUCK":
            raise HTTPException(status_code=400, detail="confirmation must be CLEAR_STUCK")
        clear_all_job_locks = to_bool(payload.get("clear_all_job_locks"), False)
        clear_mal_ingest_lock = to_bool(payload.get("clear_mal_ingest_lock"), True)
        fail_stuck_mal_job_runs = to_bool(payload.get("fail_stuck_mal_job_runs"), True)
        clear_warehouse_sync_locks = to_bool(payload.get("clear_warehouse_sync_locks"), False)
        fail_stuck_warehouse_sync = to_bool(payload.get("fail_stuck_warehouse_sync_runs"), False)

        out: dict[str, Any] = {
            "status": "ok",
            "cleared_all_job_locks": clear_all_job_locks,
            "job_locks_removed": 0,
            "mal_ingest_locks_removed": 0,
            "warehouse_sync_locks_removed": 0,
            "mal_job_runs_marked_failed": 0,
            "warehouse_sync_runs_marked_failed": 0,
            "job_run_summary_rows_marked_failed": 0,
        }
        with app_state.session_scope() as session:
            if clear_all_job_locks:
                out["job_locks_removed"] = repo.delete_all_job_locks(session)
            else:
                mal_out = mal_repo.clear_mal_stuck_ingest_state(
                    session,
                    clear_ingest_lock=clear_mal_ingest_lock,
                    fail_running_job_rows=fail_stuck_mal_job_runs,
                )
                out["mal_ingest_locks_removed"] = mal_out["mal_ingest_locks_removed"]
                out["mal_job_runs_marked_failed"] = mal_out["mal_job_runs_marked_failed"]
                wh_removed = 0
                if clear_warehouse_sync_locks:
                    wh_removed = repo.delete_warehouse_sync_job_locks(session)
                out["warehouse_sync_locks_removed"] = wh_removed
                out["job_locks_removed"] = int(mal_out["mal_ingest_locks_removed"]) + int(wh_removed)
            if clear_all_job_locks:
                if fail_stuck_mal_job_runs:
                    mal_only = mal_repo.clear_mal_stuck_ingest_state(
                        session, clear_ingest_lock=False, fail_running_job_rows=True
                    )
                    out["mal_job_runs_marked_failed"] = mal_only["mal_job_runs_marked_failed"]
            if fail_stuck_warehouse_sync:
                whf = repo.fail_stuck_running_warehouse_work(session)
                out["warehouse_sync_runs_marked_failed"] = whf["warehouse_sync_runs_marked_failed"]
                out["job_run_summary_rows_marked_failed"] = whf["job_run_summary_rows_marked_failed"]
        return out

    @router.post("/api/webhooks/replay-dead-letter/{source}")
    async def replay_dead_letter(source: str) -> dict[str, Any]:
        if source not in {"sonarr", "radarr"}:
            raise HTTPException(status_code=400, detail="source must be sonarr or radarr")

        def _replay(session: Any) -> None:
            session.execute(
                text(
                    """
                    update app.webhook_queue
                    set status = 'queued', next_attempt_at = now(), error_message = null
                    where source = :source and status = 'dead_letter'
                    """
                ),
                {"source": source},
            )

        await run_db(app_state, _replay)
        # Called back on the event loop (we're past the await): request_webhook_drain
        # sets an asyncio.Event, which is not thread-safe to call off-loop.
        request_drain = getattr(app_state, "request_webhook_drain", None)
        if request_drain is not None:
            request_drain(source)
        return {"status": "queued"}

    @router.post("/api/webhooks/requeue-bulk")
    async def requeue_webhooks_bulk(payload: dict[str, Any]) -> dict[str, Any]:
        """Requeue every job in the given status (optionally per source) in one shot."""
        status = str(payload.get("status", "")).strip().lower()
        if status not in {"retrying", "dead_letter"}:
            raise HTTPException(status_code=400, detail="status must be retrying or dead_letter")
        source = payload.get("source")
        if source is not None:
            source = str(source).strip().lower()
            if source not in {"sonarr", "radarr"}:
                raise HTTPException(status_code=400, detail="source must be sonarr or radarr")
        source_clause = "and source = :source" if source else ""
        params: dict[str, Any] = {"status": status}
        if source:
            params["source"] = source

        def _requeue_bulk(session: Any) -> list[Any]:
            return session.execute(
                text(
                    f"""
                    update app.webhook_queue
                    set status = 'queued', next_attempt_at = now(), error_message = null
                    where status = :status {source_clause}
                    returning source
                    """  # noqa: S608
                ),
                params,
            ).fetchall()

        rows = await run_db(app_state, _requeue_bulk)
        requeued_sources = sorted({str(row[0]) for row in rows})
        # Called back on the event loop, same reason as replay_dead_letter above.
        request_drain = getattr(app_state, "request_webhook_drain", None)
        if request_drain is not None:
            for requeued_source in requeued_sources:
                request_drain(requeued_source)
        return {"status": "queued", "requeued": len(rows), "sources": requeued_sources}

    @router.post("/api/webhooks/requeue/{job_id}")
    async def requeue_webhook_job(job_id: int) -> dict[str, Any]:
        def _requeue_job(session: Any) -> Any:
            return session.execute(
                text(
                    """
                    update app.webhook_queue
                    set status = 'queued', next_attempt_at = now(), error_message = null
                    where id = :job_id and status in ('dead_letter', 'retrying')
                    returning id, source
                    """
                ),
                {"job_id": job_id},
            ).first()

        updated = await run_db(app_state, _requeue_job)
        if not updated:
            raise HTTPException(status_code=404, detail="job not found or not requeueable")
        # Called back on the event loop, same reason as replay_dead_letter above.
        request_drain = getattr(app_state, "request_webhook_drain", None)
        if request_drain is not None:
            request_drain(str(updated[1]))
        return {"status": "queued", "job_id": job_id}

    # Settings that survive a data reset. Integrations (with their API keys) are
    # not truncated, so silently wiping auth/webhook-secret/alert config would
    # leave a box full of live credentials with its locks removed.
    RESET_KEEP_SETTING_PATTERNS = ("app.auth\\_%", "app.alert\\_%", "mal.%")
    RESET_KEEP_SETTING_KEYS = (
        "app.webhook_secret_hash",
        "app.setup_completed",
        "app.log_level",
        "app.retention_policy_json",
        "app.queue_policy_json",
        "app.ui_saved_views_json",
        "app.metrics_public",
    )

    @router.post("/api/admin/reset-data")
    def reset_data(payload: dict[str, Any]) -> dict[str, Any]:
        """Wipe library data, sync/audit history, the webhook queue, and MAL data.

        Truncates (cascading): mal.* dub/matcher/tag state, app.mal_job_run,
        warehouse.{episode,movie}[_file], warehouse.series, warehouse.sync_run,
        warehouse.library_stat_snapshot, app.integrity_audit_run, app.webhook_queue,
        app.job_run_summary, app.sync_state, app.job_lock, and app.settings (except the
        keep-list below). Integrations (with their API keys) are never touched.
        """
        confirmation = str(payload.get("confirmation", "")).strip().upper()
        if confirmation != "RESET":
            raise HTTPException(status_code=400, detail="confirmation must be RESET")
        with app_state.session_scope() as session:
            kept_rows = session.execute(
                text(
                    """
                    select key, value from app.settings
                    where key = any(:keys)
                       or key like :auth_pattern escape '\\'
                       or key like :alert_pattern escape '\\'
                       or key like :mal_pattern escape '\\'
                    """
                ),
                {
                    "keys": list(RESET_KEEP_SETTING_KEYS),
                    "auth_pattern": RESET_KEEP_SETTING_PATTERNS[0],
                    "alert_pattern": RESET_KEEP_SETTING_PATTERNS[1],
                    "mal_pattern": RESET_KEEP_SETTING_PATTERNS[2],
                },
            ).fetchall()
            session.execute(
                text(
                    """
                    truncate table
                        mal.dub_list_snapshot_item,
                        mal.anime_fetch_queue,
                        mal.tag_apply_state,
                        mal.warehouse_link,
                        mal.manual_link,
                        mal.anime_external_id,
                        mal.ingest_checkpoint,
                        mal.anime,
                        mal.dub_list_fetch,
                        app.mal_job_run,
                        warehouse.episode_file,
                        warehouse.movie_file,
                        warehouse.episode,
                        warehouse.movie,
                        warehouse.series,
                        warehouse.sync_run,
                        warehouse.library_stat_snapshot,
                        app.integrity_audit_run,
                        app.webhook_queue,
                        app.job_run_summary,
                        app.sync_state,
                        app.settings,
                        app.job_lock
                    restart identity cascade
                    """
                )
            )
            for key, value in kept_rows:
                set_setting(session, str(key), str(value))
        invalidate_auth_cache(app_state)
        return {
            "status": "ok",
            "message": (
                "database data reset complete (library, sync history, integrity audit "
                "history, library stat snapshots, webhook queue, and MAL data cleared)"
            ),
            "kept_setting_count": len(kept_rows),
        }

    return router
