from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from arrsync.api import build_router


class FakeMetrics:
    def set_gauge(self, _name: str, _value: float) -> None:
        return None

    def inc(self, _name: str) -> None:
        return None


class FakeResult:
    def __init__(self, rows: list[dict[str, Any]] | None = None, scalar_value: int | None = None) -> None:
        self._rows = rows or []
        self._scalar_value = scalar_value

    def mappings(self) -> "FakeResult":
        return self

    def scalar_one(self) -> int:
        if self._scalar_value is None:
            raise RuntimeError("missing scalar value")
        return self._scalar_value

    def first(self) -> dict[str, Any] | None:
        if not self._rows:
            return None
        return self._rows[0]

    def __iter__(self):  # type: ignore[no-untyped-def]
        return iter(self._rows)


class FakeSession:
    def execute(self, query: Any, _params: dict[str, Any] | None = None) -> FakeResult:
        sql = str(query)
        if "count(*)" in sql and "from warehouse.series" in sql:
            return FakeResult(scalar_value=2)
        if "from warehouse.series s" in sql and "group by" in sql:
            return FakeResult(
                rows=[
                    {
                        "instance_name": "main",
                        "series_id": 101,
                        "title": "Alpha",
                        "monitored": True,
                        "status": "continuing",
                        "path": "/media/alpha",
                        "episode_count": 10,
                        "season_count": 1,
                        "last_seen_at": None,
                    }
                ]
            )
        if "count(*)" in sql and "from warehouse.episode e" in sql:
            return FakeResult(scalar_value=1)
        if "from warehouse.episode e" in sql and "series_title" in sql:
            return FakeResult(
                rows=[
                    {
                        "instance_name": "main",
                        "series_id": 101,
                        "series_title": "Alpha",
                        "episode_id": 201,
                        "season_number": 1,
                        "episode_number": 1,
                        "absolute_episode_number": "1",
                        "episode_title": "Pilot",
                        "air_date": None,
                        "runtime_minutes": 24,
                        "monitored": True,
                        "has_file": True,
                        "file_path": "/media/alpha/s01e01.mkv",
                        "relative_path": "alpha/s01e01.mkv",
                        "size_bytes": 123456789,
                        "quality": "WEBDL-1080p",
                        "audio_codec": "AAC",
                        "audio_channels": "2.0",
                        "video_codec": "H.264",
                        "video_dynamic_range": "SDR",
                        "audio_languages": ["eng"],
                        "subtitle_languages": ["eng"],
                        "release_group": "GROUP",
                        "custom_formats": [],
                        "custom_format_score": "0",
                        "indexer_flags": "",
                        "series_status": "continuing",
                    }
                ]
            )
        return FakeResult(rows=[])


@dataclass
class FakeSettings:
    app_version: str = "test"
    app_git_sha: str = "sha"
    alert_webhook_queue_critical: int = 100
    alert_webhook_queue_warning: int = 50
    alert_sync_lag_critical_seconds: int = 7200
    alert_sync_lag_warning_seconds: int = 3600
    webhook_max_body_bytes: int = 1024
    webhook_shared_secret: str = "x"


class FakeAppState:
    settings = FakeSettings()
    metrics = FakeMetrics()
    arr_client_class = type("ArrClient", (), {"validate_webhook_secret": staticmethod(lambda *_: True)})
    session_factory = SimpleNamespace(ready=True, unbind=lambda: None)

    @contextmanager
    def session_scope(self):  # type: ignore[no-untyped-def]
        yield FakeSession()


def _build_client() -> TestClient:
    app = FastAPI()
    app.include_router(build_router(FakeAppState()))
    return TestClient(app)


def test_shows_endpoint_supports_paged_envelope() -> None:
    client = _build_client()
    response = client.get("/api/ui/shows?paged=true&limit=25&offset=0&sort_by=title&sort_dir=asc")
    assert response.status_code == 200
    body = response.json()
    assert set(body.keys()) == {"items", "total", "limit", "offset", "has_more"}
    assert body["total"] == 2
    assert len(body["items"]) == 1


def test_all_episodes_csv_export_all_is_supported() -> None:
    client = _build_client()
    response = client.get("/api/ui/episodes/export.csv?search=alpha&export_all=true&sort_by=series_title")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "episode_title" in response.text
