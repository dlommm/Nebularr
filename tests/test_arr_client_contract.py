import pytest

from arrsync.config import Settings
from arrsync.services.arr_client import ArrClient


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
async def test_list_history_since_reads_records_payload_shape() -> None:
    client = ArrClient(_settings(), "radarr")
    client.capabilities.supports_history = True

    async def fake_request(method: str, path: str, params: dict | None = None):  # type: ignore[no-untyped-def]
        assert method == "GET"
        assert path == "/api/v3/history"
        assert params and params["page"] == 1
        assert params and params["pageSize"] == 200
        assert params and params["since"] == "2026-04-01T00:00:00Z"
        return {"records": [{"id": 1}, {"id": 2}]}

    client._request = fake_request  # type: ignore[assignment]
    records = await client.list_history_since("2026-04-01T00:00:00Z")
    assert records == [{"id": 1}, {"id": 2}]


@pytest.mark.asyncio
async def test_detect_capabilities_sets_app_version_and_feature_flags() -> None:
    client = ArrClient(_settings(), "sonarr")

    async def fake_system_status() -> dict[str, str]:
        return {"version": "4.0.2.1234"}

    async def fake_probe_history() -> bool:
        return True

    async def fake_probe_episode_include() -> bool:
        return False

    client.system_status = fake_system_status  # type: ignore[assignment]
    client._probe_history_support = fake_probe_history  # type: ignore[assignment]
    client._probe_sonarr_episode_include_support = fake_probe_episode_include  # type: ignore[assignment]

    capabilities = await client.detect_capabilities()
    assert capabilities.app_version == "4.0.2.1234"
    assert capabilities.supports_history is True
    assert capabilities.supports_episode_include_files is False
