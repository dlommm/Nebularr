from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from arrsync.config import Settings
from arrsync.metrics import Metrics


def compute_health_status(session: Session, settings: Settings, metrics: Metrics) -> dict[str, Any]:
    job_count = session.execute(text("select count(*) from app.job_run_summary")).scalar_one()
    queue_count = session.execute(text("select count(*) from app.webhook_queue where status <> 'done'")).scalar_one()
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
            select source, extract(epoch from (now() - coalesce(last_history_time, now()))) as lag_seconds
            from app.sync_state
            """
        )
    ).mappings()
    lag = {str(r["source"]): float(r["lag_seconds"]) for r in lag_rows}
    arr_versions = {"sonarr": "unknown", "radarr": "unknown"}
    for row in version_rows:
        key = str(row["key"])
        app_version_value = str(row["value"])
        if key.startswith("sonarr."):
            arr_versions["sonarr"] = app_version_value
        if key.startswith("radarr."):
            arr_versions["radarr"] = app_version_value
    metrics.set_gauge("arrsync_webhook_queue_depth", float(queue_count))
    for source, value in lag.items():
        metrics.set_gauge(f"arrsync_sync_lag_seconds_{source}", value)
    health_state = "ok"
    reasons: list[str] = []
    if queue_count >= settings.alert_webhook_queue_critical:
        health_state = "critical"
        reasons.append("webhook_queue_critical")
    elif queue_count >= settings.alert_webhook_queue_warning and health_state == "ok":
        health_state = "warning"
        reasons.append("webhook_queue_warning")
    max_lag = max(lag.values()) if lag else 0
    if max_lag >= settings.alert_sync_lag_critical_seconds:
        health_state = "critical"
        reasons.append("sync_lag_critical")
    elif max_lag >= settings.alert_sync_lag_warning_seconds and health_state == "ok":
        health_state = "warning"
        reasons.append("sync_lag_warning")
    return {
        "jobs_total": job_count,
        "webhook_queue_open": queue_count,
        "active_sync_count": int(running_sync_count),
        "sync_lag_seconds": lag,
        "arr_versions": arr_versions,
        "health_state": health_state,
        "health_reasons": reasons,
    }
