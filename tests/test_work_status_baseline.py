"""GET /api/ui/work-status: baseline ETA lookups must be one grouped query, not N+1."""

from __future__ import annotations

from typing import Any

from fakes import FakeAppState
from fastapi import FastAPI
from fastapi.testclient import TestClient

from arrsync.routers.sync_ops import build_sync_ops_router


class _MappingsProxy(list):
    def all(self) -> "_MappingsProxy":
        return self


class FakeResult:
    def __init__(self, rows: list[dict[str, Any]] | None = None) -> None:
        self._rows = rows or []

    def mappings(self) -> _MappingsProxy:
        return _MappingsProxy(self._rows)


class WorkStatusFakeSession:
    def __init__(self) -> None:
        self.statements: list[tuple[str, dict[str, Any] | None]] = []

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> Any:
        sql = " ".join(str(query).lower().split())
        self.statements.append((sql, params))
        if "from warehouse.sync_run" in sql and "where status = 'running'" in sql:
            return FakeResult(
                rows=[
                    {
                        "id": 1, "source": "sonarr", "mode": "full", "instance_name": "default",
                        "started_at": None, "records_processed": 5, "stage": "syncing",
                        "stage_note": "", "trigger": "manual", "elapsed_seconds": 30.0,
                    },
                    {
                        "id": 2, "source": "sonarr", "mode": "full", "instance_name": "default",
                        "started_at": None, "records_processed": 1, "stage": "syncing",
                        "stage_note": "", "trigger": "manual", "elapsed_seconds": 10.0,
                    },
                ]
            )
        if "from warehouse.sync_run" in sql and "group by source, mode, instance_name" in sql:
            return FakeResult(
                rows=[{"source": "sonarr", "mode": "full", "instance_name": "default",
                       "avg_seconds": 60.0, "sample_size": 4}]
            )
        if "from app.mal_job_run" in sql and "where status = 'running'" in sql:
            return FakeResult(rows=[])
        raise RuntimeError(f"unexpected SQL: {sql}")

    def commit(self) -> None:
        return None

    def rollback(self) -> None:
        return None

    def close(self) -> None:
        return None


def _client() -> tuple[TestClient, WorkStatusFakeSession]:
    state = FakeAppState()
    session = WorkStatusFakeSession()
    state.session = session  # type: ignore[assignment]
    app = FastAPI()
    app.include_router(build_sync_ops_router(state))
    return TestClient(app), session


def test_work_status_uses_one_grouped_baseline_query_for_multiple_running_rows() -> None:
    client, session = _client()
    response = client.get("/api/ui/work-status")
    assert response.status_code == 200
    body = response.json()
    assert body["warehouse_running"] is True
    assert len(body["items"]) == 2
    # Both running rows share the (source, mode, instance_name) baseline group.
    for item in body["items"]:
        assert item["estimated_total_seconds"] == 60.0
        assert item["history_sample_size"] == 4

    baseline_queries = [
        sql for sql, _ in session.statements if "group by source, mode, instance_name" in sql
    ]
    assert len(baseline_queries) == 1, "one running-row baseline lookup per table, not one per row"
