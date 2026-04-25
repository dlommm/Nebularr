from functools import lru_cache
import os
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_host: str = "0.0.0.0"
    app_port: int = 8080
    app_timezone: str = "UTC"
    app_version: str = "1.2.0"
    app_git_sha: str = "release"

    database_url: str = Field(
        "postgresql+psycopg://arrapp:arrapp@localhost:5432/arranalytics",
        description="SQLAlchemy DB URL",
    )
    enable_bootstrap_migrations: bool = True
    sqlalchemy_pool_size: int = 10
    sqlalchemy_max_overflow: int = 20
    sqlalchemy_pool_recycle: int = 1800
    sql_statement_timeout_ms: int = 120000

    sonarr_base_url: str = "http://sonarr:8989"
    sonarr_api_key: str = ""
    radarr_base_url: str = "http://radarr:7878"
    radarr_api_key: str = ""

    webhook_shared_secret: str = "changeme"
    webhook_max_body_bytes: int = 262144

    http_timeout_seconds: float = 15.0
    http_retry_attempts: int = 3
    http_max_parallel_requests: int = 4

    incremental_cron: str = "*/30 * * * *"
    full_reconcile_cron: str = "0 4 * * 0"
    scheduler_timezone: str = "UTC"
    alert_sync_lag_warning_seconds: int = 3600
    alert_sync_lag_critical_seconds: int = 7200
    alert_webhook_queue_warning: int = 100
    alert_webhook_queue_critical: int = 500
    alert_webhook_urls: str = ""
    alert_webhook_timeout_seconds: float = 10.0
    alert_webhook_min_state: Literal["warning", "critical"] = "warning"
    alert_webhook_notify_recovery: bool = True

    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"

    mal_client_id: str = ""
    mal_dub_info_url: str = "https://raw.githubusercontent.com/MAL-Dubs/MAL-Dubs/main/data/dubInfo.json"
    mal_ingest_enabled: bool = False
    mal_matcher_enabled: bool = False
    mal_tagging_enabled: bool = False
    mal_jikan_enabled: bool = True
    mal_ingest_cron: str = "0 3 * * *"
    mal_matcher_cron: str = "30 3 * * *"
    mal_tag_sync_cron: str = "0 4 * * *"
    mal_min_request_interval_seconds: float = 0.6
    mal_jikan_min_request_interval_seconds: float = 1.0
    mal_max_ids_per_run: int = 200
    mal_allow_title_year_match: bool = False
    arr_dub_tag_label: str = "English-Dubbed-Anime"

@lru_cache
def get_settings() -> Settings:
    return Settings(
        database_url=os.getenv(
            "DATABASE_URL",
            "postgresql+psycopg://arrapp:arrapp@localhost:5432/arranalytics",
        )
    )
