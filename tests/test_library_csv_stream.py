"""Streamed library CSV exports: chunked queries, single header, normalization."""

from __future__ import annotations

from typing import Any

from fakes import FakeAppState, FakeResult
from fastapi import FastAPI
from fastapi.testclient import TestClient

from arrsync.routers import library as library_module


class ChunkedLibrarySession:
    """Answers the all-episodes select per offset: full chunk at 0, short at 2."""

    def __init__(self) -> None:
        self.statements: list[tuple[str, dict[str, Any] | None]] = []

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> Any:
        sql = " ".join(str(query).lower().split())
        self.statements.append((sql, params))
        offset = int((params or {}).get("offset", 0))
        if offset == 0:
            rows = [
                {"id": 1, "title": "Alpha, with comma", "audio": ["en", "ja"]},
                {"id": 2, "title": "Beta", "audio": []},
            ]
        elif offset == 2:
            rows = [{"id": 3, "title": "Gamma", "audio": ["en"]}]
        else:
            rows = []
        return FakeResult(rows=rows)

    def commit(self) -> None:
        return None

    def rollback(self) -> None:
        return None

    def close(self) -> None:
        return None


def test_episodes_export_streams_chunks_with_single_header(monkeypatch: Any) -> None:
    monkeypatch.setattr(library_module, "EXPORT_CHUNK_SIZE", 2)
    state = FakeAppState()
    session = ChunkedLibrarySession()
    state.session = session  # type: ignore[assignment]
    app = FastAPI()
    app.include_router(library_module.build_library_router(state))
    client = TestClient(app)

    response = client.get("/api/ui/episodes/export.csv?export_all=true")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert 'filename="episodes-all.csv"' in response.headers["content-disposition"]
    lines = response.text.strip().splitlines()
    assert lines[0] == "id,title,audio"
    assert len(lines) == 4  # one header + three rows across two chunks
    assert '"Alpha, with comma"' in lines[1]
    assert '""en"", ""ja""' in lines[1] or '[""en"", ""ja""]' in lines[1]  # list JSON-encoded then CSV-escaped

    offsets = [
        (params or {}).get("offset")
        for sql, params in session.statements
        if "select" in sql and "offset" in sql
    ]
    assert offsets == [0, 2], "export must page through chunks, not one giant query"


def test_export_filename_is_sanitized(monkeypatch: Any) -> None:
    monkeypatch.setattr(library_module, "EXPORT_CHUNK_SIZE", 2)
    state = FakeAppState()
    state.session = ChunkedLibrarySession()  # type: ignore[assignment]
    app = FastAPI()
    app.include_router(library_module.build_library_router(state))
    client = TestClient(app)

    response = client.get('/api/ui/episodes/export.csv?instance_name=we";ird')
    disposition = response.headers["content-disposition"]
    assert '"' not in disposition.split("filename=")[1].strip('"') or ";" not in disposition