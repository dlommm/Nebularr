"""First-run setup wizard and database bootstrap endpoints."""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Any

from apscheduler.triggers.cron import CronTrigger
from fastapi import APIRouter, HTTPException
from sqlalchemy import text

from arrsync.auth import (
    hash_password,
    invalidate_auth_cache,
)
from arrsync.database_lifecycle import (
    bind_database_engine,
    build_sqlalchemy_url,
    dispose_bound_engine,
    finalize_application_services,
    refresh_settings_from_environment,
    run_migrations_and_seed,
    wait_for_postgres,
)
from arrsync.postgres_bootstrap import bootstrap_arrapp_from_admin_url
from arrsync.routers.shared import (
    setup_sync_state,
    require_egress_allowed,
)
from arrsync.runtime_database_url import persist_runtime_database_url, runtime_database_url_persisted
from arrsync.security import encrypt_secret, hash_secret
from arrsync.services.auth_store import (
    store_auth_enabled,
    store_auth_password_hash,
)
from arrsync.services.settings_store import get_setting, set_setting

log = logging.getLogger(__name__)


def build_setup_router(app_state: Any) -> APIRouter:
    router = APIRouter()

    @router.get("/api/setup/status")
    async def setup_status() -> dict[str, Any]:
        if not app_state.session_factory.ready:
            return {
                "completed": False,
                "has_webhook_secret": False,
                "integrations": {},
                "schedules": [],
                "database": {
                    "engine_ready": False,
                    "runtime_url_persisted": runtime_database_url_persisted(),
                    "arrapp_role_exists": False,
                },
            }
        with app_state.session_scope() as session:
            setup_completed = get_setting(session, "app.setup_completed", "false").lower() == "true"
            webhook_hash = get_setting(session, "app.webhook_secret_hash", "")
            rows = session.execute(
                text(
                    """
                    select source, base_url, coalesce(api_key, '') <> '' as api_key_set
                    from app.integration_instance
                    where name = 'default'
                    """
                )
            ).mappings()
            integration_map: dict[str, dict[str, Any]] = {}
            for row in rows:
                integration_map[str(row["source"])] = {
                    "configured": bool(row["base_url"]) and bool(row["api_key_set"]),
                    "base_url": row["base_url"],
                    "api_key_set": bool(row["api_key_set"]),
                }
            schedule_rows = session.execute(
                text(
                    """
                    select mode, cron, timezone, enabled
                    from app.sync_schedule
                    order by mode
                    """
                )
            ).mappings()
            schedules = [dict(r) for r in schedule_rows]
            arrapp_exists = bool(
                session.execute(
                    text("select exists(select 1 from pg_roles where rolname = 'arrapp')")
                ).scalar()
            )
            return {
                "completed": setup_completed,
                "has_webhook_secret": bool(webhook_hash),
                "integrations": integration_map,
                "schedules": schedules,
                "database": {
                    "engine_ready": True,
                    "runtime_url_persisted": runtime_database_url_persisted(),
                    "arrapp_role_exists": arrapp_exists,
                },
            }

    @router.post("/api/setup/skip")
    async def setup_skip() -> dict[str, Any]:
        if not app_state.session_factory.ready:
            raise HTTPException(
                status_code=400,
                detail="Complete the PostgreSQL step before skipping setup.",
            )
        with app_state.session_scope() as session:
            set_setting(session, "app.setup_completed", "true")
        return {"status": "ok", "completed": True}

    @router.post("/api/setup/initialize-postgres")
    async def setup_initialize_postgres(payload: dict[str, Any]) -> dict[str, Any]:
        if app_state.session_factory.ready:
            raise HTTPException(status_code=409, detail="database already initialized")
        host = str(payload.get("host", "")).strip()
        database = str(payload.get("database", "")).strip()
        username = str(payload.get("username", "")).strip()
        password = str(payload.get("password", "")).strip()
        arrapp_pw = str(payload.get("arrapp_password", "")).strip()
        try:
            port = int(payload.get("port", 5432))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="port must be an integer") from None
        if not host or not database or not username or not password:
            raise HTTPException(status_code=400, detail="host, database, username, and password are required")
        if port < 1 or port > 65535:
            raise HTTPException(status_code=400, detail="port must be between 1 and 65535")
        admin_url = build_sqlalchemy_url(
            host=host, port=port, database=database, username=username, password=password
        )
        try:
            await asyncio.to_thread(wait_for_postgres, admin_url, 120.0)
        except TimeoutError as exc:
            raise HTTPException(status_code=504, detail="Postgres did not become ready in time") from exc

        os.environ["DATABASE_URL"] = admin_url
        app_state.settings = refresh_settings_from_environment()
        app_state._engine = bind_database_engine(app_state.settings, app_state.session_factory)
        try:
            await asyncio.to_thread(run_migrations_and_seed, app_state, app_state.settings)
        except Exception:
            dispose_bound_engine(app_state)
            app_state.session_factory.unbind()
            raise

        final_url = admin_url
        if arrapp_pw:
            try:
                final_url = await asyncio.to_thread(
                    bootstrap_arrapp_from_admin_url,
                    admin_url,
                    database,
                    arrapp_pw,
                )
            except Exception:
                log.exception("arrapp bootstrap failed after migrations")
                dispose_bound_engine(app_state)
                app_state.session_factory.unbind()
                raise HTTPException(status_code=500, detail="arrapp bootstrap failed") from None
            dispose_bound_engine(app_state)
            os.environ["DATABASE_URL"] = final_url
            app_state.settings = refresh_settings_from_environment()
            app_state._engine = bind_database_engine(app_state.settings, app_state.session_factory)

        try:
            await asyncio.to_thread(persist_runtime_database_url, final_url)
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"cannot persist database URL: {exc}") from exc

        app_state.settings = refresh_settings_from_environment()
        app_state.scheduler.settings = app_state.settings
        await finalize_application_services(app_state)
        return {"status": "ok", "restart_recommended": bool(arrapp_pw)}

    @router.post("/api/setup/bootstrap-database")
    async def setup_bootstrap_database(payload: dict[str, Any]) -> dict[str, Any]:
        if runtime_database_url_persisted():
            raise HTTPException(status_code=409, detail="runtime database URL already configured")
        admin_url = str(payload.get("admin_database_url", "")).strip()
        database_name = str(payload.get("database_name", "")).strip()
        arrapp_pw = str(payload.get("arrapp_password", "")).strip()
        if not admin_url or not database_name or not arrapp_pw:
            raise HTTPException(status_code=400, detail="admin_database_url, database_name, and arrapp_password are required")
        try:
            arrapp_url = await asyncio.to_thread(
                bootstrap_arrapp_from_admin_url,
                admin_url,
                database_name,
                arrapp_pw,
            )
            await asyncio.to_thread(persist_runtime_database_url, arrapp_url)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            log.exception("database bootstrap failed")
            raise HTTPException(status_code=500, detail="database bootstrap failed") from exc
        return {"status": "ok", "restart_required": True}

    @router.post("/api/setup/persist-runtime-database-url")
    async def setup_persist_runtime_database_url() -> dict[str, Any]:
        if not app_state.session_factory.ready:
            raise HTTPException(status_code=503, detail="database not configured")
        if runtime_database_url_persisted():
            raise HTTPException(status_code=409, detail="runtime database URL already configured")
        url = app_state.settings.database_url.strip()
        if not url.startswith("postgresql"):
            raise HTTPException(status_code=400, detail="DATABASE_URL must be a PostgreSQL URL")
        try:
            await asyncio.to_thread(persist_runtime_database_url, url)
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"cannot write runtime config: {exc}") from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"status": "ok", "restart_required": True}

    @router.post("/api/setup/wizard")
    async def setup_wizard(payload: dict[str, Any]) -> dict[str, Any]:
        if not app_state.session_factory.ready:
            raise HTTPException(
                status_code=400,
                detail="Complete the PostgreSQL step before saving integrations and schedules.",
            )
        sonarr = payload.get("sonarr", {}) if isinstance(payload.get("sonarr"), dict) else {}
        radarr = payload.get("radarr", {}) if isinstance(payload.get("radarr"), dict) else {}
        schedules = payload.get("schedules", {}) if isinstance(payload.get("schedules"), dict) else {}
        timezone = str(payload.get("timezone", app_state.settings.scheduler_timezone))
        webhook_secret = str(payload.get("webhook_secret", "")).strip()
        admin_password = str(payload.get("admin_password", ""))
        if admin_password and len(admin_password) < 8:
            raise HTTPException(status_code=400, detail="admin password must be at least 8 characters")

        def _integration_params(source: str, data: dict[str, Any]) -> dict[str, Any]:
            skip = bool(data.get("skip", False))
            return {
                "source": source,
                "name": "default",
                "base_url": str(data.get("base_url", "")).strip(),
                "api_key": str(data.get("api_key", "")).strip(),
                "enabled": bool(data.get("enabled", not skip)),
                "webhook_enabled": bool(data.get("webhook_enabled", not skip)),
                "skip": skip,
            }

        integration_rows = [_integration_params("sonarr", sonarr), _integration_params("radarr", radarr)]
        with app_state.session_scope() as session:
            for item in integration_rows:
                if item["skip"]:
                    continue
                if not item["base_url"]:
                    raise HTTPException(status_code=400, detail=f"{item['source']} base_url is required unless skipped")
                require_egress_allowed(str(item["base_url"]), f"{item['source']} base_url", app_state.settings.egress_policy)
                session.execute(
                    text(
                        """
                        insert into app.integration_instance(source, name, base_url, api_key, enabled, webhook_enabled, updated_at)
                        values (:source, :name, :base_url, :api_key, :enabled, :webhook_enabled, now())
                        on conflict (source, name) do update
                        set base_url = excluded.base_url,
                            api_key = case
                                when excluded.api_key = '' then app.integration_instance.api_key
                                else excluded.api_key
                            end,
                            enabled = excluded.enabled,
                            webhook_enabled = excluded.webhook_enabled,
                            updated_at = now()
                        """
                    ),
                    {
                        "source": item["source"],
                        "name": item["name"],
                        "base_url": item["base_url"],
                        "api_key": encrypt_secret(item["api_key"]),
                        "enabled": item["enabled"],
                        "webhook_enabled": item["webhook_enabled"],
                    },
                )

            if webhook_secret:
                set_setting(session, "app.webhook_secret_hash", hash_secret(webhook_secret))

            if admin_password:
                store_auth_password_hash(session, hash_password(admin_password))
                store_auth_enabled(session, True)

            incremental = str(schedules.get("incremental", "")).strip()
            reconcile = str(schedules.get("reconcile", "")).strip()
            for mode, cron_value in (("incremental", incremental), ("reconcile", reconcile)):
                if not cron_value:
                    continue
                try:
                    CronTrigger.from_crontab(cron_value, timezone=str(timezone))
                except Exception as exc:
                    raise HTTPException(status_code=400, detail=f"{mode} cron is invalid") from exc
                session.execute(
                    text(
                        """
                        insert into app.sync_schedule(mode, cron, timezone, enabled, updated_at)
                        values (:mode, :cron, :timezone, true, now())
                        on conflict (mode) do update
                        set cron = excluded.cron,
                            timezone = excluded.timezone,
                            enabled = excluded.enabled,
                            updated_at = now()
                        """
                    ),
                    {"mode": mode, "cron": cron_value, "timezone": timezone},
                )

            set_setting(session, "app.setup_completed", "true")

        invalidate_auth_cache(app_state)
        app_state.scheduler.reload()
        return {"status": "ok", "completed": True}

    @router.post("/api/setup/initial-sync")
    async def setup_initial_sync(payload: dict[str, Any]) -> dict[str, Any]:
        sync_state = setup_sync_state(app_state)
        if not app_state.session_factory.ready:
            raise HTTPException(
                status_code=400,
                detail="Complete the PostgreSQL step before running initial sync.",
            )
        requested_sources = payload.get("sources", [])
        if not isinstance(requested_sources, list):
            raise HTTPException(status_code=400, detail="sources must be an array")
        sources = [str(item).strip().lower() for item in requested_sources if str(item).strip().lower() in {"sonarr", "radarr"}]
        deduped_sources: list[str] = []
        for source in sources:
            if source not in deduped_sources:
                deduped_sources.append(source)
        if not deduped_sources:
            return {"status": "skipped", "running": False, "sources": []}
        if sync_state.running:
            raise HTTPException(status_code=409, detail="initial setup sync already running")

        async def _run_setup_sync(selected_sources: list[str]) -> None:
            for source in selected_sources:
                await app_state.sync_service.run_sync(source, "full", reason="setup")

        sync_state.sources = deduped_sources
        sync_state.started_at = datetime.now(timezone.utc)

        def _clear_setup_started(_task: asyncio.Task[None]) -> None:
            sync_state.started_at = None

        sync_state.task = asyncio.create_task(_run_setup_sync(deduped_sources))
        sync_state.task.add_done_callback(_clear_setup_started)
        return {"status": "queued", "running": True, "sources": deduped_sources}

    @router.get("/api/setup/initial-sync-status")
    async def setup_initial_sync_status() -> dict[str, Any]:
        sync_state = setup_sync_state(app_state)
        return {
            "running": sync_state.running,
            "sources": sync_state.sources,
        }

    return router
