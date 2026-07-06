"""Integration, MAL, logging, webhook, alert, and schedule configuration."""

from __future__ import annotations

import logging
from typing import Any, Literal
from zoneinfo import ZoneInfo

from apscheduler.triggers.cron import CronTrigger
from fastapi import APIRouter, HTTPException
from sqlalchemy import text

from arrsync.logging import apply_root_log_level, normalize_log_level
from arrsync.routers.shared import (
    parse_webhook_urls,
    require_egress_allowed,
    to_bool,
)
from arrsync.security import encrypt_secret, hash_secret
from arrsync.services.alert_config_store import (
    read_alert_webhook_config,
    store_alert_webhook_events,
    store_alert_webhook_options,
    store_alert_webhook_urls,
)
from arrsync.services.log_level_store import (
    clear_stored_log_level,
    effective_log_level,
    read_stored_log_level,
    store_log_level,
)
from arrsync.services.mal_config_store import (
    clear_mal_client_id,
    mal_client_id_is_configured,
    read_mal_feature_flags,
    store_mal_client_id,
    store_mal_feature_flags,
)
from arrsync.services.settings_store import get_setting, set_setting

log = logging.getLogger(__name__)


def build_config_router(app_state: Any) -> APIRouter:
    router = APIRouter()

    @router.get("/api/config/integrations")
    async def list_integrations() -> list[dict[str, Any]]:
        with app_state.session_scope() as session:
            rows = session.execute(
                text(
                    """
                    select id, source, name, base_url, enabled, webhook_enabled, updated_at,
                           coalesce(api_key, '') <> '' as api_key_set
                    from app.integration_instance
                    order by source, name
                    """
                )
            ).mappings()
            return [dict(r) for r in rows]

    @router.put("/api/config/integrations/{source}")
    async def upsert_integration(source: str, payload: dict[str, Any]) -> dict[str, Any]:
        if source not in {"sonarr", "radarr"}:
            raise HTTPException(status_code=400, detail="source must be sonarr or radarr")
        name = payload.get("name", "default")
        base_url = payload.get("base_url")
        if not base_url:
            raise HTTPException(status_code=400, detail="base_url is required")
        require_egress_allowed(str(base_url), "base_url", app_state.settings.egress_policy)
        api_key = str(payload.get("api_key", ""))
        enabled = bool(payload.get("enabled", True))
        webhook_enabled = bool(payload.get("webhook_enabled", True))
        with app_state.session_scope() as session:
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
                    "source": source,
                    "name": name,
                    "base_url": base_url,
                    "api_key": encrypt_secret(api_key),
                    "enabled": enabled,
                    "webhook_enabled": webhook_enabled,
                },
            )
        return {"status": "ok"}

    @router.get("/api/config/mal")
    async def get_mal_config() -> dict[str, Any]:
        with app_state.session_scope() as session:
            client_id_configured = mal_client_id_is_configured(session, app_state.settings)
            mal_flags = read_mal_feature_flags(session, app_state.settings)
        env_fallback = bool((app_state.settings.mal_client_id or "").strip())
        return {
            "client_id_configured": client_id_configured,
            "env_fallback_configured": env_fallback,
            "ingest_enabled": bool(mal_flags["ingest_enabled"]),
            "matcher_enabled": bool(mal_flags["matcher_enabled"]),
            "tagging_enabled": bool(mal_flags["tagging_enabled"]),
            "allow_title_year_match": bool(mal_flags["allow_title_year_match"]),
            "mal_max_ids_per_run": int(app_state.settings.mal_max_ids_per_run),
            "mal_min_request_interval_seconds": float(app_state.settings.mal_min_request_interval_seconds),
            "mal_jikan_min_request_interval_seconds": float(
                app_state.settings.mal_jikan_min_request_interval_seconds
            ),
        }

    @router.put("/api/config/mal")
    async def put_mal_config(payload: dict[str, Any]) -> dict[str, Any]:
        clear_flag = to_bool(payload.get("clear_client_id", False), False)
        client_id = str(payload.get("client_id", ""))
        ingest_enabled = payload.get("ingest_enabled", None)
        matcher_enabled = payload.get("matcher_enabled", None)
        tagging_enabled = payload.get("tagging_enabled", None)
        allow_title_year_match = payload.get("allow_title_year_match", None)
        with app_state.session_scope() as session:
            if clear_flag:
                clear_mal_client_id(session)
            elif client_id.strip():
                store_mal_client_id(session, client_id)
            store_mal_feature_flags(
                session,
                ingest_enabled=(
                    to_bool(ingest_enabled, False) if ingest_enabled is not None else None
                ),
                matcher_enabled=(
                    to_bool(matcher_enabled, False) if matcher_enabled is not None else None
                ),
                tagging_enabled=(
                    to_bool(tagging_enabled, False) if tagging_enabled is not None else None
                ),
                allow_title_year_match=(
                    to_bool(allow_title_year_match, False) if allow_title_year_match is not None else None
                ),
            )
        app_state.scheduler.reload()
        return {"status": "ok"}

    @router.get("/api/config/logging")
    async def get_logging_config() -> dict[str, Any]:
        with app_state.session_scope() as session:
            stored = read_stored_log_level(session)
            effective = effective_log_level(session, app_state.settings)
        return {
            "effective_level": effective,
            "stored_level": stored,
            "environment_default": normalize_log_level(app_state.settings.log_level),
        }

    @router.put("/api/config/logging")
    async def put_logging_config(payload: dict[str, Any]) -> dict[str, Any]:
        use_env = to_bool(payload.get("use_environment_default", False), False)
        if use_env:
            with app_state.session_scope() as session:
                clear_stored_log_level(session)
            eff = apply_root_log_level(app_state.settings.log_level)
        else:
            level = str(payload.get("level", "")).strip()
            if not level:
                raise HTTPException(status_code=400, detail="level is required unless use_environment_default is true")
            try:
                normalized = normalize_log_level(level)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            with app_state.session_scope() as session:
                store_log_level(session, normalized)
            eff = apply_root_log_level(normalized)
        log.info("log level updated from Web UI", extra={"effective_log_level": eff})
        return {"status": "ok", "effective_level": eff}

    @router.get("/api/config/webhook")
    async def get_webhook_config() -> dict[str, Any]:
        with app_state.session_scope() as session:
            stored_hash = get_setting(session, "app.webhook_secret_hash", "")
        return {"secret_set": bool(stored_hash)}

    @router.put("/api/config/webhook")
    async def update_webhook_config(payload: dict[str, Any]) -> dict[str, Any]:
        secret = str(payload.get("secret", "")).strip()
        if not secret:
            raise HTTPException(status_code=400, detail="secret is required")
        with app_state.session_scope() as session:
            set_setting(session, "app.webhook_secret_hash", hash_secret(secret))
        return {"status": "ok"}

    @router.get("/api/config/alert-webhooks")
    async def get_alert_webhook_config() -> dict[str, Any]:
        with app_state.session_scope() as session:
            config = read_alert_webhook_config(session, app_state.settings)
        return {
            "urls_configured": bool(config["webhook_urls"]),
            "url_count": len(config["webhook_urls"]),
            "timeout_seconds": config["timeout_seconds"],
            "min_state": config["min_state"],
            "notify_recovery": config["notify_recovery"],
            "events": config["events"],
        }

    @router.put("/api/config/alert-webhooks")
    async def update_alert_webhook_config(payload: dict[str, Any]) -> dict[str, Any]:
        clear_urls = to_bool(payload.get("clear_urls", False), False)
        provided_urls = payload.get("webhook_urls", None)
        with app_state.session_scope() as session:
            current = read_alert_webhook_config(session, app_state.settings)
            webhook_urls = list(current["webhook_urls"])
            if clear_urls:
                webhook_urls = []
                store_alert_webhook_urls(session, webhook_urls)
            elif provided_urls is not None:
                parsed_urls = parse_webhook_urls(provided_urls)
                for webhook_url in parsed_urls:
                    require_egress_allowed(webhook_url, "webhook_urls", app_state.settings.egress_policy)
                webhook_urls = parsed_urls
                store_alert_webhook_urls(session, webhook_urls)
            timeout_seconds = float(payload.get("timeout_seconds", current["timeout_seconds"]))
            if timeout_seconds <= 0:
                raise HTTPException(status_code=400, detail="timeout_seconds must be greater than zero")
            min_state_input = str(payload.get("min_state", current["min_state"])).strip().lower()
            if min_state_input not in {"warning", "critical"}:
                raise HTTPException(status_code=400, detail="min_state must be warning or critical")
            min_state: Literal["warning", "critical"] = "critical" if min_state_input == "critical" else "warning"
            notify_recovery = to_bool(payload.get("notify_recovery", current["notify_recovery"]), bool(current["notify_recovery"]))
            store_alert_webhook_options(
                session,
                timeout_seconds=timeout_seconds,
                min_state=min_state,
                notify_recovery=notify_recovery,
            )
            events = dict(current["events"])
            provided_events = payload.get("events", None)
            if isinstance(provided_events, dict):
                for name in events:
                    if name in provided_events:
                        events[name] = to_bool(provided_events[name], events[name])
                store_alert_webhook_events(session, events)
        alert_notifier = getattr(app_state, "alert_notifier", None)
        if alert_notifier is not None:
            await alert_notifier.configure(
                webhook_urls=webhook_urls,
                timeout_seconds=timeout_seconds,
                min_state=min_state,
                notify_recovery=notify_recovery,
                events=events,
            )
        return {"status": "ok", "url_count": len(webhook_urls), "events": events}

    @router.post("/api/config/alert-webhooks/test")
    async def send_alert_webhook_test() -> dict[str, Any]:
        alert_notifier = getattr(app_state, "alert_notifier", None)
        if alert_notifier is None:
            raise HTTPException(status_code=503, detail="alert notifier unavailable")
        delivered = await alert_notifier.send_test_message()
        if not delivered:
            raise HTTPException(status_code=400, detail="no webhook accepted the test message (none configured, or all failed)")
        return {"status": "ok"}

    @router.get("/api/config/schedules")
    async def list_schedules() -> list[dict[str, Any]]:
        with app_state.session_scope() as session:
            rows = session.execute(
                text(
                    """
                    select mode, cron, timezone, enabled, updated_at
                    from app.sync_schedule
                    order by mode
                    """
                )
            ).mappings()
            return [dict(r) for r in rows]

    @router.put("/api/config/schedules/{mode}")
    async def update_schedule(mode: str, payload: dict[str, Any]) -> dict[str, Any]:
        allowed_modes = frozenset(
            {"incremental", "reconcile", "full", "mal_ingest", "mal_matcher", "mal_tag_sync"}
        )
        if mode not in allowed_modes:
            raise HTTPException(status_code=400, detail="invalid mode")
        cron = payload.get("cron")
        if not cron:
            raise HTTPException(status_code=400, detail="cron is required")
        enabled = bool(payload.get("enabled", True))
        timezone = payload.get("timezone", app_state.settings.scheduler_timezone)
        try:
            ZoneInfo(str(timezone))
        except Exception as exc:
            raise HTTPException(status_code=400, detail="timezone must be a valid IANA timezone") from exc
        try:
            CronTrigger.from_crontab(str(cron), timezone=str(timezone))
        except Exception as exc:
            raise HTTPException(status_code=400, detail="cron is invalid (expected crontab format)") from exc
        with app_state.session_scope() as session:
            session.execute(
                text(
                    """
                    insert into app.sync_schedule(mode, cron, timezone, enabled, updated_at)
                    values (:mode, :cron, :timezone, :enabled, now())
                    on conflict (mode) do update
                    set cron = excluded.cron,
                        timezone = excluded.timezone,
                        enabled = excluded.enabled,
                        updated_at = now()
                    """
                ),
                {"mode": mode, "cron": cron, "timezone": timezone, "enabled": enabled},
            )
        app_state.scheduler.reload()
        return {"status": "ok"}

    return router
