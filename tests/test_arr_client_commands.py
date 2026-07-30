from __future__ import annotations

from typing import Any

import pytest

from arrsync.services.arr_client import ArrClient
from fakes import FakeSettings


def _client(source: str) -> tuple[ArrClient, list[tuple[str, str, dict | None]]]:
    client = ArrClient(FakeSettings(), source)  # type: ignore[arg-type]
    calls: list[tuple[str, str, dict | None]] = []

    async def fake_request(method: str, path: str, params: dict | None = None, json: dict | None = None) -> Any:
        calls.append((method, path, json))
        return {}

    client._request = fake_request  # type: ignore[method-assign]
    return client, calls


@pytest.mark.asyncio
async def test_search_movies_chunks_and_posts_command() -> None:
    client, calls = _client("radarr")
    await client.search_movies(list(range(1, 26)))  # 25 ids -> 3 chunks of 10/10/5
    assert [c[1] for c in calls] == ["/api/v3/command"] * 3
    assert calls[0][2] == {"name": "MoviesSearch", "movieIds": list(range(1, 11))}
    assert calls[2][2] == {"name": "MoviesSearch", "movieIds": [21, 22, 23, 24, 25]}


@pytest.mark.asyncio
async def test_search_movies_requires_radarr() -> None:
    client, _ = _client("sonarr")
    with pytest.raises(RuntimeError, match="radarr"):
        await client.search_movies([1])


@pytest.mark.asyncio
async def test_search_episodes_posts_episode_search() -> None:
    client, calls = _client("sonarr")
    await client.search_episodes([7, 8])
    assert calls == [("POST", "/api/v3/command", {"name": "EpisodeSearch", "episodeIds": [7, 8]})]


@pytest.mark.asyncio
async def test_search_with_empty_ids_is_a_noop() -> None:
    client, calls = _client("radarr")
    await client.search_movies([])
    assert calls == []


@pytest.mark.asyncio
async def test_update_movies_monitored_uses_editor() -> None:
    client, calls = _client("radarr")
    await client.update_movies_monitored([5, 6], False)
    assert calls == [
        ("PUT", "/api/v3/movie/editor", {"movieIds": [5, 6], "monitored": False}),
    ]


@pytest.mark.asyncio
async def test_update_series_monitored_uses_editor() -> None:
    client, calls = _client("sonarr")
    await client.update_series_monitored([9], True)
    assert calls == [
        ("PUT", "/api/v3/series/editor", {"seriesIds": [9], "monitored": True}),
    ]


@pytest.mark.asyncio
async def test_profile_reads() -> None:
    client, calls = _client("radarr")
    await client.list_quality_profiles()
    await client.list_custom_formats()
    assert [c[1] for c in calls] == ["/api/v3/qualityprofile", "/api/v3/customformat"]
