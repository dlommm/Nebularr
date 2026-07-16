"""Request/response helpers shared across the API router modules."""

from __future__ import annotations

import asyncio
import csv
import io
import json
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from fastapi import HTTPException
from fastapi.responses import PlainTextResponse, StreamingResponse

from arrsync.services.url_guard import UrlPolicyError, assert_url_allowed

# Hard ceilings on rows a single request can pull; protects Postgres and the
# event loop from accidental (or unauthenticated) full-table dumps.
REPORTING_MAX_LIMIT = 50_000
EXPORT_ROW_CAP = 100_000


@dataclass
class SetupSyncState:
    """Wizard-triggered initial library sync, shared by the setup and sync-ops routers."""

    task: asyncio.Task[None] | None = None
    sources: list[str] = field(default_factory=list)
    started_at: datetime | None = None

    @property
    def running(self) -> bool:
        return bool(self.task and not self.task.done())


def setup_sync_state(app_state: Any) -> SetupSyncState:
    state = getattr(app_state, "setup_sync_state", None)
    if state is None:
        state = SetupSyncState()
        app_state.setup_sync_state = state
    return state


def clamp_limit(limit: int, default: int = 200, max_limit: int = 2000) -> int:
    if limit <= 0:
        return default
    return min(limit, max_limit)


def clamp_offset(offset: int) -> int:
    if offset <= 0:
        return 0
    return offset


def paged_response(items: list[dict[str, Any]], total: int, limit: int, offset: int) -> dict[str, Any]:
    return {
        "items": items,
        "total": int(total),
        "limit": int(limit),
        "offset": int(offset),
        "has_more": (offset + len(items)) < int(total),
    }


def normalize_sort(sort_by: str, sort_dir: str, allowed: dict[str, str], default_sort: str) -> tuple[str, str]:
    normalized_key = sort_by.strip().lower() if sort_by else default_sort
    normalized_dir = sort_dir.strip().lower() if sort_dir else "asc"
    if normalized_key not in allowed:
        normalized_key = default_sort
    if normalized_dir not in {"asc", "desc"}:
        normalized_dir = "asc"
    return allowed[normalized_key], normalized_dir


def search_params(search: str) -> tuple[str, str]:
    normalized = search.strip()
    return normalized, f"%{normalized}%"


def to_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def parse_webhook_urls(raw: Any) -> list[str]:
    if isinstance(raw, list):
        return [str(item).strip() for item in raw if str(item).strip()]
    if not isinstance(raw, str):
        return []
    urls: list[str] = []
    for line in raw.splitlines():
        for part in line.split(","):
            value = part.strip()
            if value:
                urls.append(value)
    return urls


def require_egress_allowed(url: str, label: str, policy: str) -> None:
    try:
        assert_url_allowed(url, policy)
    except UrlPolicyError as exc:
        raise HTTPException(status_code=400, detail=f"{label}: {exc}") from exc


def safe_filename(filename: str) -> str:
    """Keep the download filename header well-formed regardless of query input."""
    return re.sub(r'[^A-Za-z0-9._-]+', "_", filename)[:120] or "export.csv"


def _normalize_csv_row(row: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    for key, value in row.items():
        if isinstance(value, (list, dict)):
            normalized[key] = json.dumps(value, default=str)
        else:
            normalized[key] = value
    return normalized


def csv_response(filename: str, rows: list[dict[str, Any]]) -> PlainTextResponse:
    output = io.StringIO()
    if rows:
        fieldnames = list(rows[0].keys())
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(_normalize_csv_row(row))
    return PlainTextResponse(
        output.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{safe_filename(filename)}"'},
    )


def csv_stream_response(filename: str, rows_iter: Iterator[dict[str, Any]]) -> StreamingResponse:
    """CSV as an incrementally produced stream.

    The encoder is a *sync* generator, so Starlette iterates it in a thread pool
    — blocking DB work inside `rows_iter` stays off the event loop and the full
    export is never buffered in memory.
    """

    def _encode() -> Iterator[str]:
        buffer = io.StringIO()
        writer: csv.DictWriter[str] | None = None
        for row in rows_iter:
            if writer is None:
                writer = csv.DictWriter(buffer, fieldnames=list(row.keys()))
                writer.writeheader()
            writer.writerow(_normalize_csv_row(row))
            yield buffer.getvalue()
            buffer.seek(0)
            buffer.truncate(0)

    return StreamingResponse(
        _encode(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{safe_filename(filename)}"'},
    )
