from __future__ import annotations

import asyncio
from typing import Any

import pytest

from arrsync.services.sync_service import SyncService


class RecordingSession:
    """Accepts any SQL, records it, and returns empty results."""

    def __init__(self) -> None:
        self.statements: list[tuple[str, dict[str, Any] | None]] = []

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> Any:
        sql = " ".join(str(query).lower().split())
        self.statements.append((sql, params))

        class _Result:
            def first(self) -> None:
                return None

            def scalar_one_or_none(self) -> None:
                return None

        return _Result()

    def commit(self) -> None:
        return None

    def rollback(self) -> None:
        return None

    def close(self) -> None:
        return None


class FakeHistoryClient:
    def __init__(self, events: list[dict[str, Any]]) -> None:
        self.events = events
        self.settings = None
        self.base_url = "http://fake:8989"
        self.api_key = "fake"

    async def list_history_since(self, _since: str | None) -> list[dict[str, Any]]:
        return self.events

    async def aclose(self) -> None:
        return None


@pytest.mark.asyncio
async def test_incremental_survives_malformed_history_date() -> None:
    events = [
        {"id": 10, "date": "2026-07-01T10:00:00Z"},
        {"id": 11, "date": "not-a-date"},  # must be skipped, not fail the run
        {"id": 12, "date": "2026-07-02T09:30:00Z"},
    ]
    session = RecordingSession()
    service = SyncService(
        session_factory=lambda: session,
        sonarr=FakeHistoryClient(events),  # type: ignore[arg-type]
        radarr=FakeHistoryClient([]),  # type: ignore[arg-type]
        stop_event=asyncio.Event(),
    )

    records = await service._sync_incremental(
        "sonarr", FakeHistoryClient(events), run_id=1, instance_name="default", trigger="test"
    )

    assert records == 3
    watermark_writes = [params for sql, params in session.statements if "insert into app.sync_state" in sql]
    assert watermark_writes, "watermark must still be written"
    final = watermark_writes[-1]
    assert final is not None
    assert final["history_id"] == 12
    # latest_time comes from the parsable dates only
    assert final["history_time"] is not None
    assert final["history_time"].isoformat().startswith("2026-07-02T09:30:00")
