"""Artwork proxy/cache: payload parsing, fetch rules, cache modes, wall, prefetch, API."""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any

import httpx
import pytest
from fakes import FakeAppState, FakeResult, FakeSettings
from fastapi import FastAPI
from fastapi.testclient import TestClient

from arrsync.api import build_router
from arrsync.auth import is_auth_protected_path
from arrsync.services import artwork_service as art
from arrsync.services.artwork_service import (
    ArtworkService,
    cache_key,
    image_ref_from_payload,
    sized_filename,
    sniff_image_type,
    validate_request,
)
from arrsync.services.artwork_store import ARTWORK_SETTINGS_KEY, normalize_artwork_settings

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def _images(series_id: int, last_write: str = "638000") -> list[dict[str, str]]:
    return [
        {
            "coverType": "poster",
            "url": f"/MediaCover/{series_id}/poster.jpg?lastWrite={last_write}",
            "remoteUrl": f"https://artworks.example/{series_id}/poster.jpg",
        },
        {"coverType": "fanart", "url": f"/MediaCover/{series_id}/fanart.jpg?lastWrite={last_write}"},
    ]


class ArtSession:
    """Answers the handful of queries the artwork service issues."""

    def __init__(self, state: dict[str, Any]) -> None:
        self.state = state

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> FakeResult:
        sql = " ".join(str(query).lower().split())
        params = params or {}
        if "select value from app.settings" in sql:
            return FakeResult(self.state["settings"].get(params.get("key")))
        if "insert into app.settings" in sql:
            self.state["settings"][params["key"]] = params["value"]
            return FakeResult()
        if "from app.integration_instance" in sql:
            return FakeResult(rows=[i for i in self.state["integrations"] if i["source"] == params.get("source")])
        if "select payload->'images' from warehouse." in sql:
            kind = "series" if "warehouse.series" in sql else "movie"
            row = self.state["items"].get((kind, params["instance_name"], params["item_id"]))
            return FakeResult(row)
        if "payload->'images' as images" in sql:
            kind = "series" if "warehouse.series" in sql else "movie"
            rows = [
                {"source_id": item_id, "instance_name": inst, "images": images}
                for (k, inst, item_id), images in self.state["items"].items()
                if k == kind
            ]
            return FakeResult(rows=rows)
        raise RuntimeError(f"unexpected SQL: {sql}")

    def commit(self) -> None:
        return None

    def rollback(self) -> None:
        return None

    def close(self) -> None:
        return None


def _state(**settings: Any) -> dict[str, Any]:
    stored = {ARTWORK_SETTINGS_KEY: json.dumps(normalize_artwork_settings(settings))} if settings else {}
    return {
        "settings": stored,
        "integrations": [
            {"source": "sonarr", "name": "sonarr", "base_url": "http://sonarr:8989", "api_key": "sk", "enabled": True},
            {"source": "radarr", "name": "radarr", "base_url": "http://radarr:7878", "api_key": "rk", "enabled": True},
        ],
        "items": {("series", "sonarr", 12): _images(12), ("movie", "radarr", 7): _images(7)},
    }


class Upstream:
    """Fake Sonarr/Radarr/remote image hosts; records every request."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.missing: set[str] = set()
        self.bodies: dict[str, bytes] = {}

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        url = str(request.url)
        if url in self.missing:
            return httpx.Response(404)
        return httpx.Response(200, content=self.bodies.get(url, JPEG), headers={"content-type": "image/jpeg"})


def _service(tmp_path: Path, state: dict[str, Any], upstream: Upstream) -> ArtworkService:
    return ArtworkService(
        FakeSettings(),  # type: ignore[arg-type]
        lambda: ArtSession(state),
        cache_root=tmp_path,
        transport=httpx.MockTransport(upstream.handler),
    )


# --- pure helpers ----------------------------------------------------------------


def test_image_ref_parses_arr_cover_url() -> None:
    ref = image_ref_from_payload(_images(12), source="sonarr", instance_name="sonarr", item_id=12, cover="poster")
    assert ref is not None
    assert (ref.filename, ref.last_write) == ("poster.jpg", "638000")
    assert ref.remote_url == "https://artworks.example/12/poster.jpg"


def test_image_ref_missing_cover_and_bad_payloads() -> None:
    assert image_ref_from_payload(_images(1), source="sonarr", instance_name="s", item_id=1, cover="banner") is None
    assert image_ref_from_payload(None, source="sonarr", instance_name="s", item_id=1, cover="poster") is None
    assert image_ref_from_payload(
        [{"coverType": "poster", "remoteUrl": "javascript:alert(1)"}],
        source="sonarr",
        instance_name="s",
        item_id=1,
        cover="poster",
    ) is None


def test_last_write_is_sanitized_for_filenames() -> None:
    images = [{"coverType": "poster", "url": "/MediaCover/1/poster.jpg?lastWrite=../../etc"}]
    ref = image_ref_from_payload(images, source="sonarr", instance_name="s", item_id=1, cover="poster")
    assert ref is not None and ref.last_write == "etc"


def test_sized_filename_and_sniffing() -> None:
    assert sized_filename("poster.jpg", 500) == "poster-500.jpg"
    assert sized_filename("poster.jpg", None) == "poster.jpg"
    assert sniff_image_type(JPEG) == "image/jpeg"
    assert sniff_image_type(PNG) == "image/png"
    assert sniff_image_type(b"<html>login</html>") is None


@pytest.mark.parametrize(
    ("kind", "cover", "size"),
    [("episode", "poster", None), ("series", "logo", None), ("series", "poster", 999), ("movie", "banner", 500)],
)
def test_validate_request_rejects(kind: str, cover: str, size: int | None) -> None:
    with pytest.raises(ValueError):
        validate_request(kind, cover, size)


# --- fetching and caching ---------------------------------------------------------


def test_cache_mode_fetches_once_then_serves_from_disk(tmp_path: Path) -> None:
    upstream = Upstream()
    svc = _service(tmp_path, _state(), upstream)
    first = asyncio.run(svc.get("series", "sonarr", 12, "poster", 500))
    second = asyncio.run(svc.get("series", "sonarr", 12, "poster", 500))
    assert first is not None and first.path is not None and first.path.is_file()
    assert second is not None and second.path == first.path
    assert len(upstream.requests) == 1
    request = upstream.requests[0]
    assert str(request.url) == "http://sonarr:8989/api/v3/mediacover/12/poster-500.jpg"
    assert request.headers["x-api-key"] == "sk"


def test_sized_miss_falls_back_to_original(tmp_path: Path) -> None:
    upstream = Upstream()
    upstream.missing.add("http://radarr:7878/api/v3/mediacover/7/poster-500.jpg")
    svc = _service(tmp_path, _state(), upstream)
    result = asyncio.run(svc.get("movie", "radarr", 7, "poster", 500))
    assert result is not None
    assert [str(r.url) for r in upstream.requests][-1] == "http://radarr:7878/api/v3/mediacover/7/poster.jpg"


def test_non_image_body_is_rejected(tmp_path: Path) -> None:
    upstream = Upstream()
    upstream.bodies["http://sonarr:8989/api/v3/mediacover/12/fanart.jpg"] = b"<html>sign in</html>"
    svc = _service(tmp_path, _state(), upstream)
    assert asyncio.run(svc.get("series", "sonarr", 12, "fanart")) is None
    assert not list(tmp_path.rglob("*.jpg"))


def test_remote_fallback_is_off_by_default_and_never_gets_the_api_key(tmp_path: Path) -> None:
    upstream = Upstream()
    upstream.missing.update(
        {
            "http://sonarr:8989/api/v3/mediacover/12/poster.jpg",
            "http://sonarr:8989/api/v3/mediacover/12/poster-500.jpg",
        }
    )
    assert asyncio.run(_service(tmp_path, _state(), upstream).get("series", "sonarr", 12, "poster", 500)) is None
    assert all("artworks.example" not in str(r.url) for r in upstream.requests)

    upstream.requests.clear()
    svc = _service(tmp_path / "remote", _state(remote_fallback=True), upstream)
    assert asyncio.run(svc.get("series", "sonarr", 12, "poster", 500)) is not None
    remote = [r for r in upstream.requests if "artworks.example" in str(r.url)]
    assert len(remote) == 1 and "x-api-key" not in remote[0].headers


def test_live_mode_streams_without_storing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(art, "WALL_SAMPLE_SIZE", 0)
    upstream = Upstream()
    svc = _service(tmp_path, _state(mode="live"), upstream)
    result = asyncio.run(svc.get("series", "sonarr", 12, "poster", 500))
    assert result is not None and result.body == JPEG and result.path is None
    assert not any(tmp_path.rglob("*.jpg"))


def test_live_mode_still_keeps_a_wall_sample(tmp_path: Path) -> None:
    svc = _service(tmp_path, _state(mode="live"), Upstream())
    poster = asyncio.run(svc.get("series", "sonarr", 12, "poster", 500))
    fanart = asyncio.run(svc.get("series", "sonarr", 12, "fanart"))
    assert poster is not None and poster.path is not None
    assert fanart is not None and fanart.path is None


def test_disabled_artwork_serves_nothing(tmp_path: Path) -> None:
    upstream = Upstream()
    svc = _service(tmp_path, _state(enabled=False), upstream)
    assert asyncio.run(svc.get("series", "sonarr", 12, "poster", 500)) is None
    assert upstream.requests == []


def test_replaced_artwork_gets_a_new_file(tmp_path: Path) -> None:
    state = _state()
    svc = _service(tmp_path, state, Upstream())
    old = asyncio.run(svc.get("series", "sonarr", 12, "poster", 500))
    state["items"][("series", "sonarr", 12)] = _images(12, last_write="639999")
    new = asyncio.run(svc.get("series", "sonarr", 12, "poster", 500))
    assert old is not None and new is not None and old.path != new.path
    assert old.path is not None and not old.path.exists()


# --- wall, cap, prefetch -------------------------------------------------------------


def test_wall_only_offers_cached_posters(tmp_path: Path) -> None:
    svc = _service(tmp_path, _state(), Upstream())
    assert svc.wall(10) == []
    asyncio.run(svc.get("series", "sonarr", 12, "poster", 500))
    asyncio.run(svc.get("series", "sonarr", 12, "fanart"))
    svc._wall_index = None
    tokens = svc.wall(10)
    assert len(tokens) == 1
    assert svc.wall_file(tokens[0]) is not None


@pytest.mark.parametrize("token", ["../../etc/passwd", "a" * 64, "z" * 64 + "-1", "A" * 64 + "-1"])
def test_wall_file_rejects_bad_tokens(tmp_path: Path, token: str) -> None:
    assert _service(tmp_path, _state(), Upstream()).wall_file(token) is None


def test_enforce_cap_evicts_least_recently_served(tmp_path: Path) -> None:
    svc = _service(tmp_path, _state(), Upstream())
    old = asyncio.run(svc.get("series", "sonarr", 12, "poster", 500))
    new = asyncio.run(svc.get("movie", "radarr", 7, "poster", 500))
    assert old is not None and new is not None and old.path is not None and new.path is not None
    past = time.time() - 3600
    os.utime(old.path, (past, past))
    # Together the two files exceed 1 MB; the newer one alone fits.
    new.path.write_bytes(JPEG + b"\x00" * (1024 * 1024 - 30 - len(JPEG)))
    assert svc.enforce_cap(1) == 1
    assert not old.path.exists() and new.path.exists()


def test_prefetch_warms_posters_and_fanart_then_prunes(tmp_path: Path) -> None:
    state = _state()
    upstream = Upstream()
    svc = _service(tmp_path, state, upstream)
    report = asyncio.run(svc.prefetch(reason="test"))
    assert report is not None
    assert report.fetched == 4  # poster-500 + fanart for one series and one movie
    again = asyncio.run(svc.prefetch(reason="test"))
    assert again is not None and again.fetched == 0 and again.already_cached == 4

    del state["items"][("movie", "radarr", 7)]
    pruned = asyncio.run(svc.prefetch(reason="test"))
    assert pruned is not None and pruned.pruned == 2
    assert svc.stats()["files"] == 2


def test_prefetch_in_live_mode_only_tops_up_the_wall(tmp_path: Path) -> None:
    svc = _service(tmp_path, _state(mode="live"), Upstream())
    report = asyncio.run(svc.prefetch(reason="test"))
    assert report is not None and report.fetched == 2
    assert set(svc.stats()["by_cover"]) == {"poster"}


def test_trim_for_live_keeps_only_a_poster_sample(tmp_path: Path) -> None:
    svc = _service(tmp_path, _state(), Upstream())
    asyncio.run(svc.prefetch(reason="test"))
    assert svc.trim_for_live() == 2
    assert set(svc.stats()["by_cover"]) == {"poster"}


# --- API -------------------------------------------------------------------------------


def test_only_the_wall_is_reachable_before_sign_in() -> None:
    assert not is_auth_protected_path("/api/art/wall")
    assert not is_auth_protected_path("/api/art/wall/" + "a" * 64 + "-1")
    assert is_auth_protected_path("/api/art/series/sonarr/12/poster")
    assert is_auth_protected_path("/api/config/artwork")


def _api(tmp_path: Path, state: dict[str, Any]) -> tuple[TestClient, ArtworkService]:
    app_state = FakeAppState()
    app_state.session = ArtSession(state)  # type: ignore[assignment]
    svc = _service(tmp_path, state, Upstream())
    app_state.artwork_service = svc  # type: ignore[attr-defined]
    app = FastAPI()
    app.include_router(build_router(app_state))
    return TestClient(app), svc


def test_image_endpoint_serves_and_honours_etag(tmp_path: Path) -> None:
    client, _ = _api(tmp_path, _state())
    resp = client.get("/api/art/series/sonarr/12/poster?size=500")
    assert resp.status_code == 200 and resp.headers["content-type"] == "image/jpeg"
    assert resp.headers["cache-control"].startswith("private")
    etag = resp.headers["etag"]
    assert client.get("/api/art/series/sonarr/12/poster?size=500", headers={"if-none-match": etag}).status_code == 304
    assert client.get("/api/art/series/sonarr/99/poster").status_code == 404
    assert client.get("/api/art/series/sonarr/12/poster?size=123").status_code == 400


def test_wall_endpoint_lists_cached_posters(tmp_path: Path) -> None:
    client, _ = _api(tmp_path, _state())
    assert client.get("/api/art/wall").json() == {"items": []}
    client.get("/api/art/series/sonarr/12/poster?size=500")
    items = client.get("/api/art/wall?count=5").json()["items"]
    assert len(items) == 1
    assert client.get(items[0]).status_code == 200
    assert client.get("/api/art/wall/" + "0" * 64 + "-1").status_code == 404


def test_config_roundtrip_and_validation(tmp_path: Path) -> None:
    client, _ = _api(tmp_path, _state())
    body = client.get("/api/config/artwork").json()
    assert body["mode"] == "cache" and body["enabled"] is True and body["cache"]["files"] == 0
    assert client.put("/api/config/artwork", json={"mode": "sometimes"}).status_code == 400
    assert client.put("/api/config/artwork", json={"cache_max_mb": -1}).status_code == 400
    assert client.put("/api/config/artwork", json={"enabled": "yes"}).status_code == 400
    assert client.put("/api/config/artwork", json={}).status_code == 400
    updated = client.put("/api/config/artwork", json={"mode": "live", "cache_max_mb": 512}).json()
    assert updated["mode"] == "live" and updated["cache_max_mb"] == 512


def test_clear_cache_endpoint(tmp_path: Path) -> None:
    client, svc = _api(tmp_path, _state())
    client.get("/api/art/series/sonarr/12/poster?size=500")
    assert client.post("/api/config/artwork/clear-cache").json()["removed"] == 1
    assert svc.stats()["files"] == 0


def test_cache_key_is_stable_and_size_specific() -> None:
    assert cache_key("sonarr", "sonarr", 1, "poster", 500) == cache_key("sonarr", "sonarr", 1, "poster", 500)
    assert cache_key("sonarr", "sonarr", 1, "poster", 500) != cache_key("sonarr", "sonarr", 1, "poster", None)
