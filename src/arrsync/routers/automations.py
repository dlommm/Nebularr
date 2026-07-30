"""Automations REST surface: CRUD, validation + match preview, run-now, history.

Literal paths (/templates, /validate, /runs/{run_id}) are registered before the
/{automation_id} parameterized routes so they can never be shadowed.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from apscheduler.triggers.cron import CronTrigger
from fastapi import APIRouter, HTTPException
from sqlalchemy import text

from arrsync.services import automation_store
from arrsync.services import repository as repo
from arrsync.services.automation_rules import TEMPLATES, compile_candidates, validate_params

_SOURCES_FOR_MEDIA = {"movies": ["radarr"], "series": ["sonarr"], "both": ["radarr", "sonarr"]}
_ENTITY_FOR_SOURCE = {"radarr": "movie", "sonarr": "episode"}


def _cron_or_400(cron: str, timezone: str) -> None:
    try:
        ZoneInfo(timezone)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="timezone must be a valid IANA timezone") from exc
    try:
        CronTrigger.from_crontab(cron, timezone=timezone)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="cron is invalid (expected crontab format)") from exc


def _clamp(value: Any, low: int, high: int, default: int) -> int:
    try:
        return max(low, min(int(value), high))
    except (TypeError, ValueError):
        return default


def _common_fields(payload: dict[str, Any], settings: Any) -> dict[str, Any]:
    name = str(payload.get("name", "")).strip()
    if not name or len(name) > 100:
        raise HTTPException(status_code=400, detail="name must be 1-100 characters")
    template_key = str(payload.get("template_key", ""))
    raw_params = payload.get("params")
    if not isinstance(raw_params, dict):
        raise HTTPException(status_code=400, detail="params must be an object")
    try:
        validate_params(template_key, raw_params)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)[:300]) from exc
    cron = str(payload.get("cron", "")).strip()
    timezone = str(payload.get("timezone") or settings.scheduler_timezone).strip()
    if not cron:
        raise HTTPException(status_code=400, detail="cron is required")
    _cron_or_400(cron, timezone)
    return {
        "name": name,
        "template_key": template_key,
        "params": raw_params,
        "cron": cron,
        "timezone": timezone,
        "enabled": bool(payload.get("enabled", False)),
        "dry_run": bool(payload.get("dry_run", True)),
        "budget_per_run": _clamp(payload.get("budget_per_run", 10), 1, 100, 10),
        "cooldown_days": _clamp(payload.get("cooldown_days", 7), 1, 90, 7),
    }


def build_automations_router(app_state: Any) -> APIRouter:
    router = APIRouter()

    @router.get("/api/automations")
    def list_automations() -> dict[str, Any]:
        with app_state.session_scope() as session:
            return {"automations": automation_store.list_automations(session)}

    @router.get("/api/automations/templates")
    def list_templates() -> dict[str, Any]:
        return {
            "templates": [
                {
                    "key": t.key,
                    "title": t.title,
                    "description": t.description,
                    "default_cron": t.default_cron,
                    "default_params": t.default_params,
                }
                for t in TEMPLATES.values()
            ]
        }

    @router.post("/api/automations/validate")
    def validate_automation(payload: dict[str, Any]) -> dict[str, Any]:
        """Parse problems come back as valid=false with HTTP 200 (as-you-type UX,
        same contract as /api/config/schedules/validate)."""
        template_key = str(payload.get("template_key", "custom"))
        params_value = payload.get("params")
        raw_params: dict[str, Any] = params_value if isinstance(params_value, dict) else {}
        try:
            params = validate_params(template_key, raw_params)
        except ValueError as exc:
            return {"valid": False, "error": str(exc)[:300]}
        cron = str(payload.get("cron", "")).strip()
        timezone = str(payload.get("timezone") or app_state.settings.scheduler_timezone).strip()
        fire_times: list[str] = []
        if cron:
            try:
                tzinfo = ZoneInfo(timezone)
                trigger = CronTrigger.from_crontab(cron, timezone=timezone)
            except Exception as exc:
                return {"valid": False, "error": str(exc)[:300]}
            previous: datetime | None = None
            now = datetime.now(tzinfo)
            for _ in range(3):
                next_fire = trigger.get_next_fire_time(previous, previous or now)
                if next_fire is None:
                    break
                fire_times.append(next_fire.isoformat())
                previous = next_fire
        if params.scope.tags_any:
            return {
                "valid": True,
                "next_fire_times": fire_times,
                "match_preview": None,
                "preview_note": "preview unavailable for tag-scoped rules (tags resolve live per instance)",
            }
        cooldown_days = _clamp(payload.get("cooldown_days", 7), 1, 90, 7)
        preview: dict[str, int] = {}
        try:
            with app_state.session_scope() as session:
                for source in _SOURCES_FOR_MEDIA[params.scope.media]:
                    compiled = compile_candidates(params, _ENTITY_FOR_SOURCE[source])
                    for inst in repo.list_enabled_integrations(session, source):
                        name = str(inst["name"])
                        if params.scope.instances and name not in params.scope.instances:
                            continue
                        count = session.execute(
                            text(compiled.count_sql),
                            {**compiled.binds, "instance_name": name, "cooldown_days": cooldown_days},
                        ).scalar_one()
                        preview[name] = preview.get(name, 0) + int(count)
        except Exception:
            return {"valid": True, "next_fire_times": fire_times, "match_preview": None,
                    "preview_note": "preview query failed; rule is still valid"}
        return {"valid": True, "next_fire_times": fire_times, "match_preview": preview}

    @router.get("/api/automations/runs/{run_id}")
    def get_run(run_id: int) -> dict[str, Any]:
        with app_state.session_scope() as session:
            run = automation_store.get_automation_run(session, run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        return run

    @router.post("/api/automations")
    def create_automation(payload: dict[str, Any]) -> dict[str, Any]:
        fields = _common_fields(payload, app_state.settings)
        try:
            with app_state.session_scope() as session:
                new_id = automation_store.create_automation(session, **fields)
        except Exception as exc:
            if "unique" in str(exc).lower():
                raise HTTPException(status_code=409, detail="an automation with that name exists") from exc
            raise
        app_state.scheduler.reload()
        return {"id": new_id}

    @router.put("/api/automations/{automation_id}")
    def update_automation(automation_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        fields = _common_fields(payload, app_state.settings)
        with app_state.session_scope() as session:
            ok = automation_store.update_automation(session, automation_id, fields)
        if not ok:
            raise HTTPException(status_code=404, detail="automation not found")
        app_state.scheduler.reload()
        return {"status": "ok"}

    @router.delete("/api/automations/{automation_id}")
    def delete_automation(automation_id: int) -> dict[str, Any]:
        with app_state.session_scope() as session:
            ok = automation_store.delete_automation(session, automation_id)
        if not ok:
            raise HTTPException(status_code=404, detail="automation not found")
        app_state.scheduler.reload()
        return {"status": "ok"}

    @router.post("/api/automations/{automation_id}/run")
    async def run_automation(automation_id: int) -> dict[str, Any]:
        service = app_state.automation_service
        if service is None:
            raise HTTPException(status_code=503, detail="automation service unavailable")
        task = asyncio.create_task(service.run(automation_id, reason="manual"))
        app_state.manual_sync_tasks.add(task)
        task.add_done_callback(app_state.manual_sync_tasks.discard)
        return {"status": "started"}

    @router.get("/api/automations/{automation_id}/runs")
    def list_runs(automation_id: int, limit: int = 20) -> dict[str, Any]:
        with app_state.session_scope() as session:
            return {"runs": automation_store.list_automation_runs(session, automation_id, limit)}

    return router
