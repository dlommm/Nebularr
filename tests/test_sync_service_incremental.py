from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

import pytest

from arrsync.services.sync_service import SyncService


class RecordingSession:
    """Accepts any SQL, records it, and returns empty results.

    Pass a watermark tuple to answer the app.sync_state read like a synced instance.
    """

    def __init__(self, watermark: tuple[Any, Any] | None = None) -> None:
        self.statements: list[tuple[str, dict[str, Any] | None]] = []
        self.watermark = watermark

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> Any:
        sql = " ".join(str(query).lower().split())
        self.statements.append((sql, params))
        watermark = self.watermark

        class _Result:
            def first(self_inner) -> Any:
                if "from app.sync_state" in sql and watermark is not None:
                    return watermark
                return None

            def scalar_one_or_none(self_inner) -> None:
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


class FakeSonarrClient(FakeHistoryClient):
    def __init__(
        self,
        events: list[dict[str, Any]],
        series_by_id: dict[int, dict[str, Any] | None],
        episodes_by_series: dict[int, list[dict[str, Any]]],
    ) -> None:
        super().__init__(events)
        self.series_by_id = series_by_id
        self.episodes_by_series = episodes_by_series

    async def get_series(self, series_id: int) -> dict[str, Any] | None:
        return self.series_by_id[series_id]

    async def list_episodes(self, series_id: int) -> list[dict[str, Any]]:
        return self.episodes_by_series.get(series_id, [])


class FakeRadarrClient(FakeHistoryClient):
    def __init__(
        self,
        events: list[dict[str, Any]],
        movies_by_id: dict[int, dict[str, Any] | None],
    ) -> None:
        super().__init__(events)
        self.movies_by_id = movies_by_id

    async def get_movie(self, movie_id: int) -> dict[str, Any] | None:
        return self.movies_by_id[movie_id]


def _service(session: RecordingSession) -> SyncService:
    return SyncService(
        session_factory=lambda: session,
        sonarr=FakeHistoryClient([]),  # type: ignore[arg-type]
        radarr=FakeHistoryClient([]),  # type: ignore[arg-type]
        stop_event=asyncio.Event(),
    )


WATERMARK = (datetime(2026, 6, 1, tzinfo=timezone.utc), 5)


@pytest.mark.asyncio
async def test_incremental_survives_malformed_history_date() -> None:
    events = [
        {"id": 10, "date": "2026-07-01T10:00:00Z"},
        {"id": 11, "date": "not-a-date"},  # must be skipped, not fail the run
        {"id": 12, "date": "2026-07-02T09:30:00Z"},
    ]
    session = RecordingSession(watermark=WATERMARK)
    service = _service(session)

    records = await service._sync_incremental(
        "sonarr", FakeSonarrClient(events, {}, {}), run_id=1, instance_name="default", trigger="test"
    )

    # No seriesId on any event: nothing to ingest, but the watermark advances.
    assert records == 0
    watermark_writes = [params for sql, params in session.statements if "insert into app.sync_state" in sql]
    assert watermark_writes, "watermark must still be written"
    final = watermark_writes[-1]
    assert final is not None
    assert final["history_id"] == 12
    # latest_time comes from the parsable dates only
    assert final["history_time"] is not None
    assert final["history_time"].isoformat().startswith("2026-07-02T09:30:00")


@pytest.mark.asyncio
async def test_incremental_without_watermark_only_establishes_it() -> None:
    events = [{"id": 10, "date": "2026-07-01T10:00:00Z", "seriesId": 77}]
    session = RecordingSession(watermark=None)
    client = FakeSonarrClient(events, {77: {"id": 77, "title": "T"}}, {77: [{"id": 701}]})
    service = _service(session)

    records = await service._sync_incremental(
        "sonarr", client, run_id=1, instance_name="default", trigger="test"
    )

    assert records == 0
    assert not any("insert into warehouse.series" in sql for sql, _ in session.statements)
    assert any("insert into app.sync_state" in sql for sql, _ in session.statements)


@pytest.mark.asyncio
async def test_incremental_ingests_referenced_series_and_tombstones_deleted() -> None:
    events = [
        {"id": 10, "date": "2026-07-01T10:00:00Z", "seriesId": 77},
        {"id": 11, "date": "2026-07-01T11:00:00Z", "seriesId": 77},
        {"id": 12, "date": "2026-07-02T09:30:00Z", "seriesId": 88},  # deleted in Sonarr
    ]
    session = RecordingSession(watermark=WATERMARK)
    client = FakeSonarrClient(
        events,
        {77: {"id": 77, "title": "Kept"}, 88: None},
        {77: [{"id": 701, "episodeFile": {"id": 7001}}, {"id": 702}]},
    )
    service = _service(session)

    records = await service._sync_incremental(
        "sonarr", client, run_id=1, instance_name="default", trigger="test"
    )

    assert records == 2  # two episodes upserted for series 77
    sqls = [sql for sql, _ in session.statements]
    assert any("insert into warehouse.series" in s for s in sqls)
    assert any("insert into warehouse.episode " in s or "insert into warehouse.episode(" in s for s in sqls)
    assert any("insert into warehouse.episode_file" in s for s in sqls)
    # Deleted series 88 is tombstoned along with its children.
    series_tombstones = [
        params
        for sql, params in session.statements
        if "update warehouse.series set deleted = true" in sql and params and params.get("ids")
    ]
    assert series_tombstones and series_tombstones[0]["ids"] == [88]
    child_sweeps = [
        params
        for sql, params in session.statements
        if "update warehouse.episode set deleted = true" in sql and params and "parent_ids" in (params or {})
    ]
    assert any(params["parent_ids"] == [88] for params in child_sweeps)
    # Watermark advances only after ingest succeeded.
    watermark_writes = [params for sql, params in session.statements if "insert into app.sync_state" in sql]
    assert watermark_writes and watermark_writes[-1] is not None
    assert watermark_writes[-1]["history_id"] == 12


@pytest.mark.asyncio
async def test_incremental_does_not_advance_watermark_when_ingest_fails() -> None:
    events = [{"id": 10, "date": "2026-07-01T10:00:00Z", "seriesId": 77}]
    session = RecordingSession(watermark=WATERMARK)

    class ExplodingClient(FakeSonarrClient):
        async def get_series(self, series_id: int) -> dict[str, Any] | None:
            raise RuntimeError("sonarr unreachable")

    service = _service(session)
    with pytest.raises(RuntimeError):
        await service._sync_incremental(
            "sonarr", ExplodingClient(events, {}, {}), run_id=1, instance_name="default", trigger="test"
        )

    assert not any("insert into app.sync_state" in sql for sql, _ in session.statements)


@pytest.mark.asyncio
async def test_incremental_radarr_refetches_movies_and_tombstones_missing_files() -> None:
    events = [
        {"id": 20, "date": "2026-07-01T10:00:00Z", "movieId": 5},
        {"id": 21, "date": "2026-07-01T11:00:00Z", "movieId": 6},  # deleted in Radarr
    ]
    session = RecordingSession(watermark=WATERMARK)
    client = FakeRadarrClient(events, {5: {"id": 5, "movieFile": {"id": 50}}, 6: None})
    service = _service(session)

    records = await service._sync_incremental(
        "radarr", client, run_id=1, instance_name="default", trigger="test"
    )

    assert records == 1
    sqls = [sql for sql, _ in session.statements]
    assert any("insert into warehouse.movie " in s or "insert into warehouse.movie(" in s for s in sqls)
    assert any("insert into warehouse.movie_file" in s for s in sqls)
    movie_tombstones = [
        params
        for sql, params in session.statements
        if "update warehouse.movie set deleted = true" in sql and params and params.get("ids")
    ]
    assert movie_tombstones and movie_tombstones[0]["ids"] == [6]
    file_sweeps = [
        params
        for sql, params in session.statements
        if "update warehouse.movie_file set deleted = true" in sql and params and "parent_ids" in (params or {})
    ]
    assert any(params["parent_ids"] == [5] for params in file_sweeps)
