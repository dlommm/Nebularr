"""Integration tests against a real Postgres.

Set NEBULARR_TEST_DATABASE_URL (e.g. postgresql+psycopg://user:pass@localhost:5432/testdb)
to enable; otherwise every test here is skipped. CI provides a service container.

These exercise the raw SQL the unit-test fakes cannot: Alembic migrations, the
repository layer, and every reporting dashboard builder.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from types import SimpleNamespace
from typing import Any, Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from arrsync.api import build_router
from arrsync.migrations import run_migrations
from arrsync.services import repository as repo

DATABASE_URL = os.getenv("NEBULARR_TEST_DATABASE_URL", "").strip()

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not DATABASE_URL, reason="NEBULARR_TEST_DATABASE_URL not set"),
]

DASHBOARD_KEYS = [
    "overview",
    "language-audit",
    "sync-ops",
    "ops-overview",
    "media-deep-dive",
    "monitoring-audit",
    "sonarr-forensics",
    "radarr-forensics",
    "storage-growth",
    "mal",
]


@pytest.fixture(scope="module")
def engine():  # type: ignore[no-untyped-def]
    run_migrations(SimpleNamespace(database_url=DATABASE_URL))  # type: ignore[arg-type]
    engine = create_engine(DATABASE_URL, future=True)
    yield engine
    engine.dispose()


@pytest.fixture(scope="module")
def app_state(engine):  # type: ignore[no-untyped-def]
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)

    class IntegrationAppState:
        def __init__(self) -> None:
            self.settings = SimpleNamespace(
                app_version="test",
                app_git_sha="test",
                webhook_shared_secret="changeme",
                webhook_max_body_bytes=262144,
                egress_policy="open",
                log_level="INFO",
                auth_enabled="",
                auth_recovery_password="",
                auth_session_ttl_hours=1,
                scheduler_timezone="UTC",
                alert_webhook_urls="",
                alert_webhook_timeout_seconds=10.0,
                alert_webhook_min_state="warning",
                alert_webhook_notify_recovery=True,
                arr_dub_tag_label="English-Dubbed-Anime",
                database_url=DATABASE_URL,
                mal_client_id="",
                mal_dub_info_url="",
                mal_jikan_min_request_interval_seconds=1.0,
                mal_max_ids_per_run=200,
                mal_min_request_interval_seconds=0.6,
            )
            self.metrics = SimpleNamespace(inc=lambda *_: None, set_gauge=lambda *_: None)
            self.arr_client_class = SimpleNamespace(validate_webhook_secret=lambda *_: False)
            self.session_factory = SimpleNamespace(ready=True, unbind=lambda: None)
            self.auth_config_cache: Any = None
            self.auth_config_cached_at = 0.0

        @contextmanager
        def session_scope(self) -> Iterator[Any]:
            session = factory()
            try:
                yield session
                session.commit()
            except Exception:
                session.rollback()
                raise
            finally:
                session.close()

    return IntegrationAppState()


@pytest.fixture(scope="module")
def client(app_state):  # type: ignore[no-untyped-def]
    app = FastAPI()
    app.include_router(build_router(app_state))
    return TestClient(app)


def test_migrations_produce_expected_schemas(engine) -> None:  # type: ignore[no-untyped-def]
    with engine.connect() as conn:
        schemas = {
            row[0]
            for row in conn.execute(
                text("select schema_name from information_schema.schemata")
            )
        }
    assert {"app", "warehouse", "mal"} <= schemas


def test_repository_roundtrip_series_and_watermark(app_state) -> None:  # type: ignore[no-untyped-def]
    series_payload = {
        "id": 9001,
        "title": "Integration Test Show",
        "status": "continuing",
        "monitored": True,
        "seasons": [],
        "statistics": {"sizeOnDisk": 123456},
    }
    with app_state.session_scope() as session:
        run_id = repo.create_sync_run(session, "sonarr", "full", instance_name="itest", trigger="test")
        repo.upsert_series(session, "itest", series_payload, run_id, "full")
        repo.update_watermark_for_instance(session, "sonarr", "itest", None, 42)
        repo.finish_sync_run(
            session,
            run_id=run_id,
            source="sonarr",
            mode="full",
            status="success",
            records_processed=1,
            details={},
            instance_name="itest",
        )
    with app_state.session_scope() as session:
        _, history_id = repo.get_watermark_for_instance(session, "sonarr", "itest")
        title = session.execute(
            text("select title from warehouse.series where instance_name = 'itest' and source_id = 9001")
        ).scalar_one()
    assert history_id == 42
    assert title == "Integration Test Show"


@pytest.mark.parametrize("dashboard_key", DASHBOARD_KEYS)
def test_reporting_dashboards_execute_real_sql(client, dashboard_key: str) -> None:  # type: ignore[no-untyped-def]
    response = client.get(f"/api/reporting/dashboards/{dashboard_key}", params={"limit": 10})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body.get("key", dashboard_key) is not None
    panels = body.get("panels", [])
    assert isinstance(panels, list) and panels, f"{dashboard_key} returned no panels"
    for panel in panels:
        assert "id" in panel
        assert isinstance(panel.get("rows", []), list)


def test_library_endpoints_execute_real_sql(client) -> None:  # type: ignore[no-untyped-def]
    shows = client.get("/api/ui/shows", params={"paged": True, "limit": 10})
    assert shows.status_code == 200, shows.text
    body = shows.json()
    assert {"items", "total", "limit", "offset", "has_more"} <= set(body.keys())

    episodes = client.get("/api/ui/episodes", params={"paged": True, "limit": 10})
    assert episodes.status_code == 200

    movies = client.get("/api/ui/movies", params={"paged": True, "limit": 10})
    assert movies.status_code == 200


def test_library_stat_snapshot_capture_and_daily_guard(app_state) -> None:  # type: ignore[no-untyped-def]
    with app_state.session_scope() as session:
        session.execute(text("delete from warehouse.library_stat_snapshot"))
    with app_state.session_scope() as session:
        assert repo.has_library_stat_snapshot_today(session) is False
        repo.capture_library_stat_snapshot(session)
    with app_state.session_scope() as session:
        assert repo.has_library_stat_snapshot_today(session) is True
        rows = session.execute(
            text(
                "select source, entity_count, file_count, file_bytes"
                " from warehouse.library_stat_snapshot where instance_name = 'itest'"
            )
        ).mappings().all()
    # The series upserted by the roundtrip test above must be counted.
    by_source = {row["source"]: row for row in rows}
    assert "sonarr" in by_source
    assert by_source["sonarr"]["entity_count"] >= 1
    assert by_source["sonarr"]["file_bytes"] >= 0
