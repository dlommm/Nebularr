import httpx
import pytest

from arrsync.config import Settings
from arrsync.services.arr_client import ArrClient, _summarize_arr_http_error


def _settings() -> Settings:
    return Settings(
        database_url="postgresql+psycopg://arrapp:arrapp@localhost:5432/arranalytics",
        sonarr_base_url="http://sonarr.local",
        sonarr_api_key="sonarr-key",
        radarr_base_url="http://radarr.local",
        radarr_api_key="radarr-key",
    )


@pytest.mark.asyncio
async def test_list_episodes_falls_back_when_include_param_unsupported() -> None:
    client = ArrClient(_settings(), "sonarr")
    client.capabilities.supports_episode_include_files = True
    calls: list[dict[str, object]] = []

    async def fake_request(method: str, path: str, params: dict | None = None):  # type: ignore[no-untyped-def]
        calls.append({"method": method, "path": path, "params": params or {}})
        if params and params.get("includeEpisodeFile") == "true":
            raise RuntimeError("includeEpisodeFile not supported")
        return [{"id": 101, "seriesId": 77}]

    client._request = fake_request  # type: ignore[assignment]
    episodes = await client.list_episodes(77)

    assert episodes == [{"id": 101, "seriesId": 77}]
    assert len(calls) == 2
    assert calls[0]["params"] == {"seriesId": 77, "includeEpisodeFile": "true"}
    assert calls[1]["params"] == {"seriesId": 77}


@pytest.mark.asyncio
async def test_list_history_since_uses_history_since_endpoint() -> None:
    client = ArrClient(_settings(), "radarr")
    client.capabilities.supports_history = True
    client.capabilities.supports_history_since = True

    async def fake_request(method: str, path: str, params: dict | None = None):  # type: ignore[no-untyped-def]
        assert method == "GET"
        assert path == "/api/v3/history/since"
        assert params == {"date": "2026-04-01T00:00:00Z"}
        return [{"id": 1}, {"id": 2}]

    client._request = fake_request  # type: ignore[assignment]
    records = await client.list_history_since("2026-04-01T00:00:00Z")
    assert records == [{"id": 1}, {"id": 2}]


@pytest.mark.asyncio
async def test_list_history_since_falls_back_to_paged_walk_stopping_at_watermark() -> None:
    client = ArrClient(_settings(), "radarr")
    client.capabilities.supports_history = True
    client.capabilities.supports_history_since = True
    calls: list[tuple[str, dict | None]] = []
    page_one = [
        {"id": 30, "date": "2026-04-03T00:00:00Z"},
        {"id": 29, "date": "2026-04-02T00:00:00Z"},
        {"id": 28, "date": "2026-04-01T00:00:00Z"},  # == watermark: stop here
        {"id": 27, "date": "2026-03-31T00:00:00Z"},
    ]

    async def fake_request(method: str, path: str, params: dict | None = None):  # type: ignore[no-untyped-def]
        calls.append((path, params))
        if path == "/api/v3/history/since":
            raise RuntimeError("HTTP 404 unknown endpoint")
        assert path == "/api/v3/history"
        assert params and params["sortKey"] == "date" and params["sortDirection"] == "descending"
        return {"records": page_one if params["page"] == 1 else []}

    client._request = fake_request  # type: ignore[assignment]
    records = await client.list_history_since("2026-04-01T00:00:00Z")

    assert [r["id"] for r in records] == [30, 29]
    assert client.capabilities.supports_history_since is False
    # A later call must not retry the unsupported endpoint.
    await client.list_history_since("2026-04-01T00:00:00Z")
    assert not any(path == "/api/v3/history/since" for path, _ in calls[1:])


@pytest.mark.asyncio
async def test_list_history_since_without_watermark_fetches_single_page() -> None:
    client = ArrClient(_settings(), "radarr")
    client.capabilities.supports_history = True
    pages: list[int] = []

    async def fake_request(method: str, path: str, params: dict | None = None):  # type: ignore[no-untyped-def]
        assert path == "/api/v3/history"
        assert params is not None
        pages.append(int(params["page"]))
        return {"records": [{"id": i, "date": "2026-04-01T00:00:00Z"} for i in range(200)]}

    client._request = fake_request  # type: ignore[assignment]
    records = await client.list_history_since(None)
    assert len(records) == 200
    assert pages == [1]


@pytest.mark.asyncio
async def test_get_movie_returns_none_on_404() -> None:
    client = ArrClient(_settings(), "radarr")
    request = httpx.Request("GET", "http://radarr.local/api/v3/movie/5")
    response = httpx.Response(404, request=request)

    async def fake_request(method: str, path: str, params: dict | None = None):  # type: ignore[no-untyped-def]
        raise RuntimeError("radarr request failed") from httpx.HTTPStatusError(
            "not found", request=request, response=response
        )

    client._request = fake_request  # type: ignore[assignment]
    assert await client.get_movie(5) is None


def test_summarize_http_status_error_truncates_body() -> None:
    request = httpx.Request("POST", "http://sonarr.local/api/v3/tag")
    long_body = "x" * 500
    response = httpx.Response(400, request=request, text=long_body)
    err = httpx.HTTPStatusError("bad", request=request, response=response)
    summary = _summarize_arr_http_error(err)
    assert summary.startswith("HTTP 400")
    assert len(summary) < len(long_body) + 50
    assert summary.endswith("...")


@pytest.mark.asyncio
async def test_ensure_tag_id_matches_existing_tag_case_insensitively() -> None:
    client = ArrClient(_settings(), "sonarr")
    label = "English-Dubbed-Anime"

    async def fake_request(method: str, path: str, params: dict | None = None, json: dict | None = None):  # type: ignore[no-untyped-def]
        assert method == "GET" and path == "/api/v3/tag"
        return [{"id": 77, "label": "english-dubbed-anime"}]

    client._request = fake_request  # type: ignore[assignment]
    assert await client.ensure_tag_id(label) == 77


@pytest.mark.asyncio
async def test_ensure_tag_id_relists_when_post_fails_but_tag_exists() -> None:
    client = ArrClient(_settings(), "sonarr")
    label = "English-Dubbed-Anime"
    calls: list[tuple[str, str]] = []
    get_tag_calls = 0

    async def fake_request(method: str, path: str, params: dict | None = None, json: dict | None = None):  # type: ignore[no-untyped-def]
        nonlocal get_tag_calls
        calls.append((method, path))
        if method == "GET" and path == "/api/v3/tag":
            get_tag_calls += 1
            if get_tag_calls == 1:
                return []
            return [{"id": 42, "label": label}]
        if method == "POST" and path == "/api/v3/tag":
            raise RuntimeError("duplicate tag")
        raise AssertionError((method, path))

    client._request = fake_request  # type: ignore[assignment]
    assert await client.ensure_tag_id(label) == 42
    assert get_tag_calls == 2
    assert ("POST", "/api/v3/tag") in calls


@pytest.mark.asyncio
async def test_detect_capabilities_sets_app_version_and_feature_flags() -> None:
    client = ArrClient(_settings(), "sonarr")

    async def fake_system_status() -> dict[str, str]:
        return {"version": "4.0.2.1234"}

    async def fake_probe_history() -> bool:
        return True

    async def fake_probe_history_since() -> bool:
        return True

    async def fake_probe_episode_include() -> bool:
        return False

    client.system_status = fake_system_status  # type: ignore[assignment]
    client._probe_history_support = fake_probe_history  # type: ignore[assignment]
    client._probe_history_since_support = fake_probe_history_since  # type: ignore[assignment]
    client._probe_sonarr_episode_include_support = fake_probe_episode_include  # type: ignore[assignment]

    capabilities = await client.detect_capabilities()
    assert capabilities.app_version == "4.0.2.1234"
    assert capabilities.supports_history is True
    assert capabilities.supports_history_since is True
    assert capabilities.supports_episode_include_files is False
