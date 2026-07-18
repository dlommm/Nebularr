"""Integration, MAL, logging, webhook, alert, and schedule configuration."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo

from apscheduler.triggers.cron import CronTrigger
from fastapi import APIRouter, HTTPException
from sqlalchemy import text

from arrsync.logging import apply_root_log_level, normalize_log_level
from arrsync.routers.shared import (
    parse_webhook_urls,
    require_egress_allowed,
    run_db,
    to_bool,
)
from arrsync.security import encrypt_secret, hash_secret
from arrsync.services.alert_config_store import (
    read_alert_email_config,
    read_alert_webhook_config,
    store_alert_email_config,
    store_alert_webhook_events,
    store_alert_webhook_options,
    store_alert_webhook_urls,
)
from arrsync.services.alert_notifier import normalize_ntfy_url
from arrsync.services.log_level_store import (
    clear_stored_log_level,
    effective_log_level,
    read_stored_log_level,
    store_log_level,
)
from arrsync.mal.constants import MYDUBLIST_CONFIDENCE_TIERS
from arrsync.services.mal_config_store import (
    clear_mal_client_id,
    mal_client_id_is_configured,
    read_mal_feature_flags,
    read_mydublist_tier,
    store_mal_client_id,
    store_mal_feature_flags,
    store_mydublist_tier,
)
from arrsync.services import repository as repo
from arrsync.services.queue_config_store import read_queue_policy, write_queue_policy
from arrsync.services.retention_store import (
    MAX_RETENTION_DAYS,
    read_retention_policy,
    write_retention_policy,
)
from arrsync.services.settings_store import get_setting, set_setting

SAVED_VIEWS_KEY = "app.ui_saved_views_json"
SAVED_VIEWS_PAGE_RE = re.compile(r"[a-z0-9.-]{1,64}")
SAVED_VIEWS_MAX_PER_PAGE = 50
SAVED_VIEWS_NAME_MAX = 80
SAVED_VIEWS_SEARCH_MAX = 2000

INTEGRATION_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
INTEGRATION_BASE_URL_MAX_LENGTH = 512
METRICS_PUBLIC_KEY = "app.metrics_public"

log = logging.getLogger(__name__)


def build_config_router(app_state: Any) -> APIRouter:
    router = APIRouter()

    @router.get("/api/config/integrations")
    def list_integrations() -> list[dict[str, Any]]:
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
        if not INTEGRATION_NAME_RE.fullmatch(str(name)):
            raise HTTPException(
                status_code=422, detail="name must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
            )
        base_url = payload.get("base_url")
        if not base_url:
            raise HTTPException(status_code=400, detail="base_url is required")
        if len(str(base_url)) > INTEGRATION_BASE_URL_MAX_LENGTH:
            raise HTTPException(
                status_code=422,
                detail=f"base_url must be at most {INTEGRATION_BASE_URL_MAX_LENGTH} characters",
            )
        await asyncio.to_thread(require_egress_allowed, str(base_url), "base_url", app_state.settings.egress_policy)
        api_key = str(payload.get("api_key", ""))
        enabled = bool(payload.get("enabled", True))
        webhook_enabled = bool(payload.get("webhook_enabled", True))

        def _upsert(session: Any) -> None:
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

        await run_db(app_state, _upsert)
        return {"status": "ok"}

    @router.post("/api/config/integrations/{source}/test")
    async def test_integration(source: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        """Probe the Arr instance with the given (or stored) credentials.

        Failures return HTTP 200 with ok=false so the UI renders them inline
        instead of as a generic error toast.
        """
        if source not in {"sonarr", "radarr"}:
            raise HTTPException(status_code=400, detail="source must be sonarr or radarr")
        payload = payload or {}
        name = str(payload.get("name") or "default")
        base_url = str(payload.get("base_url") or "").strip()
        api_key = str(payload.get("api_key") or "")
        if not base_url or not api_key:
            def _load_stored(session: Any) -> dict[str, Any]:
                return {row["name"]: row for row in repo.list_enabled_integrations(session, source)}

            stored = await run_db(app_state, _load_stored)
            row = stored.get(name)
            if row is None:
                raise HTTPException(
                    status_code=404, detail=f"no enabled {source} integration named {name!r}"
                )
            base_url = base_url or str(row["base_url"])
            api_key = api_key or str(row.get("api_key", ""))
        await asyncio.to_thread(require_egress_allowed, base_url, "base_url", app_state.settings.egress_policy)
        client = app_state.arr_client_class(
            app_state.settings, source, instance_name=name, base_url=base_url, api_key=api_key
        )
        try:
            status = await asyncio.wait_for(client.system_status(), timeout=10.0)
        except Exception as exc:
            return {"ok": False, "error": str(exc)[:300]}
        finally:
            await client.aclose()
        return {
            "ok": True,
            "version": str(status.get("version", "unknown")),
            "app_name": str(status.get("appName", source)),
        }

    @router.get("/api/config/mal")
    def get_mal_config() -> dict[str, Any]:
        with app_state.session_scope() as session:
            client_id_configured = mal_client_id_is_configured(session, app_state.settings)
            mal_flags = read_mal_feature_flags(session, app_state.settings)
            mydublist_tier = read_mydublist_tier(session, app_state.settings)
        env_fallback = bool((app_state.settings.mal_client_id or "").strip())
        return {
            "client_id_configured": client_id_configured,
            "env_fallback_configured": env_fallback,
            "ingest_enabled": bool(mal_flags["ingest_enabled"]),
            "matcher_enabled": bool(mal_flags["matcher_enabled"]),
            "tagging_enabled": bool(mal_flags["tagging_enabled"]),
            "allow_title_year_match": bool(mal_flags["allow_title_year_match"]),
            "source_mal_dubs_enabled": bool(mal_flags["source_mal_dubs_enabled"]),
            "source_mydublist_enabled": bool(mal_flags["source_mydublist_enabled"]),
            "coverage_tagging_enabled": bool(mal_flags["coverage_tagging_enabled"]),
            "mydublist_tier": mydublist_tier,
            "mal_max_ids_per_run": int(app_state.settings.mal_max_ids_per_run),
            "mal_min_request_interval_seconds": float(app_state.settings.mal_min_request_interval_seconds),
            "mal_jikan_min_request_interval_seconds": float(
                app_state.settings.mal_jikan_min_request_interval_seconds
            ),
        }

    @router.put("/api/config/mal")
    def put_mal_config(payload: dict[str, Any]) -> dict[str, Any]:
        clear_flag = to_bool(payload.get("clear_client_id", False), False)
        client_id = str(payload.get("client_id", ""))
        ingest_enabled = payload.get("ingest_enabled", None)
        matcher_enabled = payload.get("matcher_enabled", None)
        tagging_enabled = payload.get("tagging_enabled", None)
        allow_title_year_match = payload.get("allow_title_year_match", None)
        source_mal_dubs_enabled = payload.get("source_mal_dubs_enabled", None)
        source_mydublist_enabled = payload.get("source_mydublist_enabled", None)
        coverage_tagging_enabled = payload.get("coverage_tagging_enabled", None)
        mydublist_tier = payload.get("mydublist_tier", None)
        if mydublist_tier is not None and str(mydublist_tier).strip().lower() not in MYDUBLIST_CONFIDENCE_TIERS:
            raise HTTPException(status_code=400, detail="invalid mydublist_tier")
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
                source_mal_dubs_enabled=(
                    to_bool(source_mal_dubs_enabled, False) if source_mal_dubs_enabled is not None else None
                ),
                source_mydublist_enabled=(
                    to_bool(source_mydublist_enabled, False) if source_mydublist_enabled is not None else None
                ),
                coverage_tagging_enabled=(
                    to_bool(coverage_tagging_enabled, False) if coverage_tagging_enabled is not None else None
                ),
            )
            if mydublist_tier is not None:
                store_mydublist_tier(session, str(mydublist_tier))
        app_state.scheduler.reload()
        return {"status": "ok"}

    @router.get("/api/config/logging")
    def get_logging_config() -> dict[str, Any]:
        with app_state.session_scope() as session:
            stored = read_stored_log_level(session)
            effective = effective_log_level(session, app_state.settings)
        return {
            "effective_level": effective,
            "stored_level": stored,
            "environment_default": normalize_log_level(app_state.settings.log_level),
        }

    @router.put("/api/config/logging")
    def put_logging_config(payload: dict[str, Any]) -> dict[str, Any]:
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
    def get_webhook_config() -> dict[str, Any]:
        with app_state.session_scope() as session:
            stored_hash = get_setting(session, "app.webhook_secret_hash", "")
        return {"secret_set": bool(stored_hash)}

    @router.put("/api/config/webhook")
    def update_webhook_config(payload: dict[str, Any]) -> dict[str, Any]:
        secret = str(payload.get("secret", "")).strip()
        if not secret:
            raise HTTPException(status_code=400, detail="secret is required")
        with app_state.session_scope() as session:
            set_setting(session, "app.webhook_secret_hash", hash_secret(secret))
        return {"status": "ok"}

    @router.get("/api/config/alert-webhooks")
    def get_alert_webhook_config() -> dict[str, Any]:
        with app_state.session_scope() as session:
            config = read_alert_webhook_config(session, app_state.settings)
        email = config["email"]
        return {
            "urls_configured": bool(config["webhook_urls"]),
            "url_count": len(config["webhook_urls"]),
            "timeout_seconds": config["timeout_seconds"],
            "min_state": config["min_state"],
            "notify_recovery": config["notify_recovery"],
            "events": config["events"],
            "email": {
                "enabled": email["enabled"],
                "host": email["host"],
                "port": email["port"],
                "username": email["username"],
                "password_set": bool(email["password"]),
                "from_address": email["from_address"],
                "to_addresses": email["to_addresses"],
                "starttls": email["starttls"],
            },
        }

    @router.put("/api/config/alert-webhooks")
    async def update_alert_webhook_config(payload: dict[str, Any]) -> dict[str, Any]:
        clear_urls = to_bool(payload.get("clear_urls", False), False)
        provided_urls = payload.get("webhook_urls", None)
        # Resolved and egress-checked *before* the DB session is opened: DNS lookups
        # are slow, and there's no reason to hold a connection idle for them.
        parsed_urls: list[str] | None = None
        if not clear_urls and provided_urls is not None:
            parsed_urls = parse_webhook_urls(provided_urls)
            for webhook_url in parsed_urls:
                # ntfy:// is an accepted alias for self-hosted ntfy; the egress
                # check runs against the https URL it resolves to.
                await asyncio.to_thread(
                    require_egress_allowed,
                    normalize_ntfy_url(webhook_url),
                    "webhook_urls",
                    app_state.settings.egress_policy,
                )

        def _apply(session: Any) -> dict[str, Any]:
            current = read_alert_webhook_config(session, app_state.settings)
            webhook_urls = list(current["webhook_urls"])
            if clear_urls:
                webhook_urls = []
                store_alert_webhook_urls(session, webhook_urls)
            elif parsed_urls is not None:
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
            provided_email = payload.get("email", None)
            if isinstance(provided_email, dict):
                merged_email: dict[str, Any] = {**current["email"], **provided_email}
                try:
                    port = int(merged_email.get("port", 587))
                except (TypeError, ValueError) as exc:
                    raise HTTPException(status_code=400, detail="email.port must be an integer") from exc
                if port < 1 or port > 65535:
                    raise HTTPException(status_code=400, detail="email.port must be between 1 and 65535")
                if to_bool(merged_email.get("enabled", False), False) and not str(merged_email.get("host", "")).strip():
                    raise HTTPException(status_code=400, detail="email.host is required when email is enabled")
                password = provided_email.get("password", None)
                if password is not None and not isinstance(password, str):
                    raise HTTPException(status_code=400, detail="email.password must be a string")
                store_alert_email_config(session, merged_email, password=password)
            email_config = read_alert_email_config(session)
            return {
                "webhook_urls": webhook_urls,
                "timeout_seconds": timeout_seconds,
                "min_state": min_state,
                "notify_recovery": notify_recovery,
                "events": events,
                "email_config": dict(email_config),
            }

        applied = await run_db(app_state, _apply)
        alert_notifier = getattr(app_state, "alert_notifier", None)
        if alert_notifier is not None:
            await alert_notifier.configure(
                webhook_urls=applied["webhook_urls"],
                timeout_seconds=applied["timeout_seconds"],
                min_state=applied["min_state"],
                notify_recovery=applied["notify_recovery"],
                events=applied["events"],
                email=applied["email_config"],
            )
        return {"status": "ok", "url_count": len(applied["webhook_urls"]), "events": applied["events"]}

    @router.post("/api/config/alert-webhooks/test")
    async def send_alert_webhook_test(payload: dict[str, Any] | None = None) -> dict[str, Any]:
        alert_notifier = getattr(app_state, "alert_notifier", None)
        if alert_notifier is None:
            raise HTTPException(status_code=503, detail="alert notifier unavailable")
        target = str((payload or {}).get("target", "") or "").strip()
        if target:
            results = [await alert_notifier.send_test_to_target(target)]
        else:
            results = await alert_notifier.send_test_message()
        if not results:
            raise HTTPException(
                status_code=400,
                detail="no webhook accepted the test message (none configured, or all failed)",
            )
        # `status` keeps the pre-2.6 contract for existing callers.
        any_ok = any(result["ok"] for result in results)
        if not any_ok and not target:
            raise HTTPException(
                status_code=400,
                detail="no webhook accepted the test message (none configured, or all failed)",
            )
        return {"status": "ok" if any_ok else "failed", "results": results}

    @router.get("/api/config/metrics")
    def get_metrics_config() -> dict[str, Any]:
        with app_state.session_scope() as session:
            public = get_setting(session, METRICS_PUBLIC_KEY, "false").lower() == "true"
        return {"public": public}

    @router.put("/api/config/metrics")
    def update_metrics_config(payload: dict[str, Any]) -> dict[str, Any]:
        public = to_bool(payload.get("public", False), False)
        with app_state.session_scope() as session:
            set_setting(session, METRICS_PUBLIC_KEY, "true" if public else "false")
        return {"status": "ok", "public": public}

    @router.get("/api/config/schedules")
    def list_schedules() -> list[dict[str, Any]]:
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

    @router.get("/api/config/retention")
    def get_retention() -> dict[str, Any]:
        with app_state.session_scope() as session:
            return dict(read_retention_policy(session))

    @router.put("/api/config/retention")
    def update_retention(payload: dict[str, Any]) -> dict[str, Any]:
        updates: dict[str, object] = {}
        for key in ("queue_days", "sync_run_days", "stat_snapshot_days"):
            if key not in payload:
                continue
            try:
                days = int(payload[key])
            except (TypeError, ValueError) as exc:
                raise HTTPException(status_code=400, detail=f"{key} must be an integer") from exc
            if days < 0 or days > MAX_RETENTION_DAYS:
                raise HTTPException(
                    status_code=400,
                    detail=f"{key} must be between 0 (keep forever) and {MAX_RETENTION_DAYS}",
                )
            updates[key] = days
        if not updates:
            raise HTTPException(status_code=400, detail="no retention fields provided")
        with app_state.session_scope() as session:
            return dict(write_retention_policy(session, updates))

    @router.get("/api/config/queue")
    def get_queue_policy() -> dict[str, Any]:
        with app_state.session_scope() as session:
            return dict(read_queue_policy(session))

    @router.put("/api/config/queue")
    def update_queue_policy(payload: dict[str, Any]) -> dict[str, Any]:
        updates: dict[str, object] = {}
        for key in ("batch_size", "max_attempts", "backoff_base_seconds", "backoff_cap_seconds"):
            if key not in payload:
                continue
            try:
                updates[key] = int(payload[key])
            except (TypeError, ValueError) as exc:
                raise HTTPException(status_code=400, detail=f"{key} must be an integer") from exc
        if not updates:
            raise HTTPException(status_code=400, detail="no queue policy fields provided")
        with app_state.session_scope() as session:
            return dict(write_queue_policy(session, updates))

    @router.post("/api/config/schedules/validate")
    async def validate_schedule_cron(payload: dict[str, Any]) -> dict[str, Any]:
        """Live cron validation + next-run preview. Parse problems come back as
        valid=false with HTTP 200 (this powers as-you-type feedback)."""
        cron = str(payload.get("cron", "")).strip()
        timezone = str(payload.get("timezone") or app_state.settings.scheduler_timezone).strip()
        if not cron:
            return {"valid": False, "error": "cron expression is required"}
        try:
            tzinfo = ZoneInfo(timezone)
        except Exception:
            return {"valid": False, "error": f"unknown timezone {timezone!r}"}
        try:
            trigger = CronTrigger.from_crontab(cron, timezone=timezone)
        except Exception as exc:
            return {"valid": False, "error": str(exc)[:300]}
        fire_times: list[str] = []
        previous: datetime | None = None
        now = datetime.now(tzinfo)
        for _ in range(3):
            next_fire = trigger.get_next_fire_time(previous, previous or now)
            if next_fire is None:
                break
            fire_times.append(next_fire.isoformat())
            previous = next_fire
        return {"valid": True, "timezone": timezone, "next_fire_times": fire_times}

    @router.get("/api/config/saved-views")
    def get_saved_views() -> dict[str, Any]:
        with app_state.session_scope() as session:
            raw = get_setting(session, SAVED_VIEWS_KEY, "")
        try:
            parsed = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            parsed = {}
        return {"views": parsed if isinstance(parsed, dict) else {}}

    @router.put("/api/config/saved-views")
    def put_saved_views(payload: dict[str, Any]) -> dict[str, Any]:
        page = str(payload.get("page", "")).strip().lower()
        if not SAVED_VIEWS_PAGE_RE.fullmatch(page):
            raise HTTPException(status_code=400, detail="invalid page key")
        raw_views = payload.get("views")
        if not isinstance(raw_views, list) or len(raw_views) > SAVED_VIEWS_MAX_PER_PAGE:
            raise HTTPException(
                status_code=400,
                detail=f"views must be a list of at most {SAVED_VIEWS_MAX_PER_PAGE} entries",
            )
        views: list[dict[str, str]] = []
        for entry in raw_views:
            if not isinstance(entry, dict):
                raise HTTPException(status_code=400, detail="each view must be an object")
            name = str(entry.get("name", "")).strip()
            search = str(entry.get("search", ""))
            if not name or len(name) > SAVED_VIEWS_NAME_MAX:
                raise HTTPException(
                    status_code=400, detail=f"view name must be 1-{SAVED_VIEWS_NAME_MAX} characters"
                )
            if len(search) > SAVED_VIEWS_SEARCH_MAX:
                raise HTTPException(
                    status_code=400,
                    detail=f"view search must be at most {SAVED_VIEWS_SEARCH_MAX} characters",
                )
            # Re-serialize only the whitelisted fields.
            views.append({"name": name, "search": search})
        with app_state.session_scope() as session:
            raw = get_setting(session, SAVED_VIEWS_KEY, "")
            try:
                stored = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                stored = {}
            if not isinstance(stored, dict):
                stored = {}
            stored[page] = views
            set_setting(session, SAVED_VIEWS_KEY, json.dumps(stored))
        return {"status": "ok", "page": page, "count": len(views)}

    @router.put("/api/config/schedules/{mode}")
    def update_schedule(mode: str, payload: dict[str, Any]) -> dict[str, Any]:
        allowed_modes = frozenset(
            {
                "incremental",
                "reconcile",
                "full",
                "stats_snapshot",
                "integrity_audit",
                "mal_ingest",
                "mal_matcher",
                "mal_tag_sync",
                "coverage_tag_sync",
            }
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
