from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from typing import Any

import pytest

from arrsync.services.sync_service import SyncService

FAKE_SETTINGS = SimpleNamespace(
    http_timeout_seconds=1.0,
    http_retry_attempts=1,
    http_max_parallel_requests=4,
    sonarr_base_url="http://fake:8989",
    sonarr_api_key="fake",
    radarr_base_url="http://fake:7878",
    radarr_api_key="fake",
)


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


class FakeSeriesClient:
    """Sonarr client double whose per-series episode fetch takes a fixed delay,
    so wall time exposes whether fetches run serially or concurrently."""

    def __init__(self, series_count: int, episodes_per_series: int, delay: float) -> None:
        self.series_count = series_count
        self.episodes_per_series = episodes_per_series
        self.delay = delay
        self.settings = FAKE_SETTINGS
        self.base_url = "http://fake:8989"
        self.api_key = "fake"
        self.in_flight = 0
        self.max_in_flight = 0

    async def list_series(self) -> list[dict[str, Any]]:
        return [{"id": sid, "title": f"Show {sid}"} for sid in range(1, self.series_count + 1)]

    async def list_episodes(self, series_id: int) -> list[dict[str, Any]]:
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            await asyncio.sleep(self.delay)
        finally:
            self.in_flight -= 1
        return [
            {
                "id": series_id * 1000 + n,
                "seriesId": series_id,
                "episodeFile": {"id": series_id * 1000 + n},
            }
            for n in range(1, self.episodes_per_series + 1)
        ]

    async def aclose(self) -> None:
        return None


def _build_service(client: FakeSeriesClient, session: RecordingSession, stop: asyncio.Event) -> SyncService:
    return SyncService(
        session_factory=lambda: session,
        sonarr=client,  # type: ignore[arg-type]
        radarr=client,  # type: ignore[arg-type]
        stop_event=stop,
    )


@pytest.mark.asyncio
async def test_full_sync_fetches_episodes_concurrently() -> None:
    series_count = 40
    delay = 0.02
    client = FakeSeriesClient(series_count, episodes_per_series=5, delay=delay)
    session = RecordingSession()
    service = _build_service(client, session, asyncio.Event())

    started = time.perf_counter()
    records = await service._sync_sonarr_full(
        client, run_id=1, mode="full", instance_name="default", trigger="test"  # type: ignore[arg-type]
    )
    elapsed = time.perf_counter() - started

    assert records == series_count * 5
    # Serial execution would take >= series_count * delay = 0.8s.
    assert elapsed < series_count * delay * 0.6, f"expected concurrent fetches, took {elapsed:.3f}s"
    assert client.max_in_flight > 1, "episode fetches never overlapped"
    assert client.max_in_flight <= 8, "fan-out exceeded the chunk bound"

    tombstones = [sql for sql, _ in session.statements if "set deleted = true" in sql]
    assert len(tombstones) == 3, "tombstones must run for series, episode, and episode_file"
    series_upserts = [sql for sql, _ in session.statements if "warehouse.series" in sql and "insert" in sql]
    assert len(series_upserts) == series_count


@pytest.mark.asyncio
async def test_client_cache_reuses_and_invalidates_by_config() -> None:
    client = FakeSeriesClient(1, 1, 0.0)
    service = _build_service(client, RecordingSession(), asyncio.Event())
    integration = {"name": "default", "base_url": "http://sonarr:8989", "api_key": "k1"}

    first = service._client_for_integration("sonarr", integration)
    second = service._client_for_integration("sonarr", dict(integration))
    assert first is second, "identical integration config must reuse the pooled client"

    rotated = service._client_for_integration(
        "sonarr", {**integration, "api_key": "k2"}
    )
    assert rotated is not first, "changed api key must produce a fresh client"

    await service.aclose()
    assert service._client_cache == {}


@pytest.mark.asyncio
async def test_interrupted_full_sync_skips_tombstones() -> None:
    client = FakeSeriesClient(40, episodes_per_series=2, delay=0.001)
    session = RecordingSession()
    stop = asyncio.Event()
    service = _build_service(client, session, stop)

    original_list_episodes = client.list_episodes
    calls = 0

    async def stopping_list_episodes(series_id: int) -> list[dict[str, Any]]:
        nonlocal calls
        calls += 1
        if calls >= 8:
            stop.set()
        return await original_list_episodes(series_id)

    client.list_episodes = stopping_list_episodes  # type: ignore[method-assign]

    records = await service._sync_sonarr_full(
        client, run_id=1, mode="full", instance_name="default", trigger="test"  # type: ignore[arg-type]
    )

    assert 0 < records < 80, "run should have stopped early"
    tombstones = [sql for sql, _ in session.statements if "set deleted = true" in sql]
    assert not tombstones, "interrupted runs must not tombstone unfetched rows"
