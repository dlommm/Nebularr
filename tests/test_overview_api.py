"""Overview read models: sync lanes timeline and recent imports."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fakes import FakeAppState, FakeResult
from fastapi import FastAPI
from fastapi.testclient import TestClient

from arrsync.api import build_router

NOW = datetime(2026, 10, 22, 14, 56, tzinfo=timezone.utc)


class OverviewSession:
    def __init__(self, **tables: list[dict[str, Any]]) -> None:
        self.tables = tables
        self.statements: list[tuple[str, dict[str, Any] | None]] = []

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> FakeResult:
        sql = " ".join(str(query).lower().split())
        self.statements.append((sql, params))
        if sql == "select now()":
            return FakeResult(NOW)
        if "from app.integration_instance" in sql:
            return FakeResult(rows=self.tables.get("instances", []))
        if "from app.job_run_summary" in sql and "max(started_at)" in sql:
            return FakeResult(rows=self.tables.get("last_runs", []))
        if "from app.job_run_summary" in sql:
            return FakeResult(rows=self.tables.get("runs", []))
        if "max(received_at)" in sql:
            return FakeResult(self.tables.get("last_hook", [None])[0])
        if "from app.webhook_queue" in sql:
            return FakeResult(rows=self.tables.get("hooks", []))
        if "max(started_at) from app.mal_job_run" in sql:
            return FakeResult(self.tables.get("last_mal", [None])[0])
        if "from app.mal_job_run" in sql:
            return FakeResult(rows=self.tables.get("mal", []))
        if "from warehouse.episode_file" in sql and "union all" in sql:
            return FakeResult(rows=self.tables.get("imports", []))
        if "from warehouse.episode where not deleted" in sql:
            return FakeResult(rows=self.tables.get("episode_totals", []))
        if "from warehouse.movie where not deleted" in sql:
            return FakeResult(rows=self.tables.get("movie_totals", []))
        if "from warehouse.series where not deleted" in sql:
            return FakeResult(self.tables.get("shows", [0])[0])
        if "sum(size_bytes)" in sql:
            return FakeResult(self.tables.get("stored", [0])[0])
        raise RuntimeError(f"unexpected SQL: {sql}")

    def commit(self) -> None:
        return None

    def rollback(self) -> None:
        return None

    def close(self) -> None:
        return None


def _client(session: OverviewSession) -> TestClient:
    state = FakeAppState()
    state.session = session  # type: ignore[assignment]
    app = FastAPI()
    app.include_router(build_router(state))
    return TestClient(app)


def test_timeline_has_a_lane_per_enabled_instance_even_when_silent() -> None:
    started = NOW - timedelta(minutes=30)
    session = OverviewSession(
        instances=[{"source": "sonarr", "name": "sonarr"}, {"source": "sonarr", "name": "sonarr-anime"}],
        runs=[
            {
                "source": "sonarr",
                "instance_name": "sonarr",
                "mode": "incremental",
                "status": "success",
                "started_at": started,
                "finished_at": started + timedelta(seconds=18),
                "rows_written": 340,
            }
        ],
        last_runs=[
            {"source": "sonarr", "instance_name": "sonarr", "last_at": started},
            {"source": "sonarr", "instance_name": "sonarr-anime", "last_at": NOW - timedelta(hours=9)},
        ],
        hooks=[{"received_at": NOW - timedelta(minutes=4), "status": "done", "source": "sonarr"}],
        last_hook=[NOW - timedelta(minutes=4)],
    )
    body = _client(session).get("/api/ui/run-timeline").json()
    lanes = {lane["key"]: lane for lane in body["lanes"]}
    assert set(lanes) == {"sonarr:sonarr", "sonarr:sonarr-anime", "webhooks"}
    assert lanes["sonarr:sonarr"]["events"][0]["rows"] == 340
    assert lanes["sonarr:sonarr"]["events"][0]["duration_seconds"] == 18.0
    assert lanes["sonarr:sonarr-anime"]["events"] == []
    assert lanes["sonarr:sonarr-anime"]["last_at"] is not None
    assert lanes["webhooks"]["events"][0]["kind"] == "webhook"
    assert body["hours"] == 24


def test_timeline_includes_mal_only_when_it_has_ever_run() -> None:
    assert "mal" not in {
        lane["key"] for lane in _client(OverviewSession()).get("/api/ui/run-timeline").json()["lanes"]
    }
    session = OverviewSession(
        mal=[{"job_type": "ingest", "status": "success", "started_at": NOW - timedelta(hours=1), "finished_at": None}],
        last_mal=[NOW - timedelta(hours=1)],
    )
    lanes = _client(session).get("/api/ui/run-timeline").json()["lanes"]
    assert lanes[-1]["key"] == "mal" and lanes[-1]["events"][0]["duration_seconds"] is None


def test_timeline_window_is_bounded() -> None:
    client = _client(OverviewSession())
    assert client.get("/api/ui/run-timeline?hours=0").status_code == 422
    assert client.get("/api/ui/run-timeline?hours=169").status_code == 422
    session = OverviewSession()
    _client(session).get("/api/ui/run-timeline?hours=6")
    assert any(params == {"hours": 6} for _, params in session.statements)


def test_recent_imports_clamps_limit_and_returns_items() -> None:
    session = OverviewSession(
        imports=[{"kind": "episode", "title": "Halcyon Station", "season_number": 6, "episode_number": 10}]
    )
    body = _client(session).get("/api/ui/recent-imports?limit=500").json()
    assert body["items"][0]["title"] == "Halcyon Station"
    sql, params = session.statements[-1]
    assert params == {"limit": 60}
    assert "from warehouse.movie_file" in sql


def test_library_totals_shapes_counts() -> None:
    session = OverviewSession(
        episode_totals=[{"episodes": 133412, "on_disk": 111076, "missing": 1906}],
        movie_totals=[{"movies": 2341, "on_disk": 2298, "missing": 43}],
        shows=[1284],
        stored=[186_400_000_000_000],
    )
    body = _client(session).get("/api/ui/library-totals").json()
    assert body == {
        "shows": 1284,
        "episodes": 133412,
        "episodes_on_disk": 111076,
        "episodes_missing": 1906,
        "movies": 2341,
        "movies_on_disk": 2298,
        "movies_missing": 43,
        "stored_bytes": 186_400_000_000_000,
    }


def test_library_totals_on_an_empty_warehouse() -> None:
    body = _client(OverviewSession()).get("/api/ui/library-totals").json()
    assert body["episodes"] == 0 and body["stored_bytes"] == 0
