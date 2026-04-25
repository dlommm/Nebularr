from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from arrsync.config import Settings
from arrsync.mal.repository import get_mal_sync_ui_snapshot
from arrsync.metrics import Metrics
from arrsync.services.mal_config_store import mal_client_id_is_configured, read_mal_feature_flags

_SEVERITY = {"ok": 0, "warning": 1, "critical": 2}


def _worse(a: str, b: str) -> str:
    if _SEVERITY.get(a, 0) >= _SEVERITY.get(b, 0):
        return a
    return b


def _eval_webhooks(
    settings: Settings, queue_backlog: int, dead_letter_count: int
) -> tuple[str, list[str]]:
    """Webhook queue: queued + retrying backlog, plus dead-letter visibility (non-critical)."""
    reasons: list[str] = []
    if queue_backlog >= settings.alert_webhook_queue_critical:
        return "critical", ["webhook_queue_critical"]
    if queue_backlog >= settings.alert_webhook_queue_warning:
        reasons.append("webhook_queue_warning")
    if dead_letter_count > 0:
        reasons.append("webhook_dead_letter")
    if reasons:
        return "warning", reasons
    return "ok", []


def _eval_sync(settings: Settings, max_lag: float) -> tuple[str, list[str]]:
    if max_lag >= settings.alert_sync_lag_critical_seconds:
        return "critical", ["sync_lag_critical"]
    if max_lag >= settings.alert_sync_lag_warning_seconds:
        return "warning", ["sync_lag_warning"]
    return "ok", []


def _eval_integrations(arr_versions: dict[str, str]) -> tuple[str, list[str]]:
    """Probe outcome: app versions in settings; unknown means capability probe or sync not seen yet."""
    s, r = (arr_versions.get("sonarr") or "unknown"), (arr_versions.get("radarr") or "unknown")
    u = s.lower() == "unknown" or s == "" or s == "—"
    v = r.lower() == "unknown" or r == "" or r == "—"
    if u and v:
        return "warning", ["arr_versions_unknown"]
    if u or v:
        return "warning", ["arr_version_partial"]
    return "ok", []


def _eval_mal(mal_sync: dict[str, Any]) -> tuple[str, list[str]]:
    schedulers = mal_sync.get("schedulers") or {}
    any_enabled = bool(schedulers.get("ingest_enabled") or schedulers.get("matcher_enabled") or schedulers.get("tagging_enabled"))
    if not any_enabled:
        return "ok", []
    if not bool(mal_sync.get("client_configured")):
        return "warning", ["mal_client_not_configured"]
    reasons: list[str] = []
    for job_type, row in (mal_sync.get("last_finished") or {}).items():
        st = str(row.get("status") or "").lower()
        if st == "failed":
            reasons.append(f"mal_{job_type}_last_failed")
    if reasons:
        return "warning", reasons
    return "ok", []


def compute_health_status(session: Session, settings: Settings, metrics: Metrics) -> dict[str, Any]:
    job_count = session.execute(text("select count(*) from app.job_run_summary")).scalar_one()
    queue_backlog = session.execute(
        text("select count(*) from app.webhook_queue where status in ('queued', 'retrying')")
    ).scalar_one()
    dead_letter_count = session.execute(
        text("select count(*) from app.webhook_queue where status = 'dead_letter'")
    ).scalar_one()
    running_sync_count = session.execute(
        text("select count(*) from warehouse.sync_run where status = 'running'")
    ).scalar_one()
    version_rows = session.execute(
        text(
            """
            select key, value
            from app.settings
            where key in ('sonarr.app_version', 'radarr.app_version')
            """
        )
    ).mappings()
    lag_rows = session.execute(
        text(
            """
            select
                source,
                extract(
                    epoch
                    from (
                        now() - coalesce(
                            greatest(
                                last_history_time,
                                last_successful_incremental,
                                last_successful_full_sync
                            ),
                            now()
                        )
                    )
                ) as lag_seconds
            from app.sync_state
            """
        )
    ).mappings()
    lag = {str(r["source"]): float(r["lag_seconds"]) for r in lag_rows}
    arr_versions: dict[str, str] = {"sonarr": "unknown", "radarr": "unknown"}
    for row in version_rows:
        key = str(row["key"])
        app_version_value = str(row["value"])
        if key.startswith("sonarr."):
            arr_versions["sonarr"] = app_version_value
        if key.startswith("radarr."):
            arr_versions["radarr"] = app_version_value
    max_lag = max(lag.values()) if lag else 0.0
    metrics.set_gauge("arrsync_webhook_queue_depth", float(queue_backlog))
    metrics.set_gauge("arrsync_webhook_dead_letter_total", float(dead_letter_count))
    for source, value in lag.items():
        metrics.set_gauge(f"arrsync_sync_lag_seconds_{source}", value)

    webhooks_state, webhooks_r = _eval_webhooks(settings, int(queue_backlog), int(dead_letter_count))
    sync_state, sync_r = _eval_sync(settings, max_lag)
    integrations_state, integrations_r = _eval_integrations(arr_versions)
    mal_sync = get_mal_sync_ui_snapshot(session)
    mal_flags = read_mal_feature_flags(session, settings)
    mal_sync["client_configured"] = mal_client_id_is_configured(session, settings)
    mal_sync["schedulers"] = {
        "ingest_enabled": bool(mal_flags["ingest_enabled"]),
        "matcher_enabled": bool(mal_flags["matcher_enabled"]),
        "tagging_enabled": bool(mal_flags["tagging_enabled"]),
    }
    mal_state, mal_r = _eval_mal(mal_sync)

    health_dimensions: dict[str, str] = {
        "webhooks": webhooks_state,
        "sync": sync_state,
        "integrations": integrations_state,
        "mal": mal_state,
    }
    health_dimension_reasons: dict[str, list[str]] = {
        "webhooks": list(webhooks_r),
        "sync": list(sync_r),
        "integrations": list(integrations_r),
        "mal": list(mal_r),
    }
    # Aggregate: worst severity across dimensions; merge unique reason codes.
    health_state: str = "ok"
    for s in health_dimensions.values():
        health_state = _worse(health_state, s)
    all_reasons: list[str] = []
    for key in ("webhooks", "sync", "integrations", "mal"):
        for r in health_dimension_reasons.get(key) or []:
            if r not in all_reasons:
                all_reasons.append(r)

    return {
        "jobs_total": job_count,
        "webhook_queue_open": int(queue_backlog),
        "webhook_queue_dead_letter": int(dead_letter_count),
        "active_sync_count": int(running_sync_count),
        "sync_lag_seconds": lag,
        "arr_versions": arr_versions,
        "health_state": health_state,
        "health_reasons": all_reasons,
        "health_dimensions": health_dimensions,
        "health_dimension_reasons": health_dimension_reasons,
        "mal_sync": mal_sync,
    }
