from __future__ import annotations

import asyncio
import hashlib
import logging
from typing import Any

import httpx

from arrsync.config import Settings
from arrsync.mal.constants import DEFAULT_DUB_INFO_URL, JIKAN_API_BASE, MAL_ANIME_DETAIL_FIELDS, MAL_API_BASE

log = logging.getLogger(__name__)


class DubInfoClient:
    def __init__(self, settings: Settings) -> None:
        self.url = settings.mal_dub_info_url or DEFAULT_DUB_INFO_URL
        self.timeout = settings.http_timeout_seconds
        self.retry = settings.http_retry_attempts

    async def fetch(self) -> tuple[dict[str, Any], str, int]:
        last_err: Exception | None = None
        for attempt in range(1, self.retry + 1):
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    resp = await client.get(self.url)
                    status = resp.status_code
                    if status in {429, 500, 502, 503, 504} and attempt < self.retry:
                        await asyncio.sleep(0.5 * attempt)
                        continue
                    resp.raise_for_status()
                    body = resp.content
                    sha = hashlib.sha256(body).hexdigest()
                    data = resp.json()
                    return data, sha, status
            except Exception as exc:
                last_err = exc
                if attempt >= self.retry:
                    break
                await asyncio.sleep(0.5 * attempt)
        raise RuntimeError(f"dub info fetch failed: {self.url}") from last_err


class MalApiClient:
    def __init__(self, settings: Settings, *, client_id: str | None = None) -> None:
        explicit = (client_id or "").strip()
        self.client_id = explicit or (settings.mal_client_id or "").strip()
        self.timeout = settings.http_timeout_seconds
        self.retry = settings.http_retry_attempts
        self.interval = settings.mal_min_request_interval_seconds
        self._lock = asyncio.Lock()
        self._last_at = 0.0

    async def _throttle(self) -> None:
        async with self._lock:
            loop = asyncio.get_event_loop()
            now = loop.time()
            wait = self._last_at + self.interval - now
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_at = loop.time()

    async def get_anime(self, mal_id: int) -> tuple[dict[str, Any] | None, int, str | None]:
        if not self.client_id:
            raise RuntimeError("MAL_CLIENT_ID is not configured")
        url = f"{MAL_API_BASE}/anime/{mal_id}"
        headers = {"X-MAL-CLIENT-ID": self.client_id}
        params = {"fields": MAL_ANIME_DETAIL_FIELDS}
        last_err: Exception | None = None
        for attempt in range(1, self.retry + 1):
            try:
                await self._throttle()
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    resp = await client.get(url, headers=headers, params=params)
                    code = resp.status_code
                    if code == 404:
                        return None, code, "not_found"
                    if code in {429, 500, 502, 503, 504} and attempt < self.retry:
                        await asyncio.sleep(0.5 * attempt)
                        continue
                    resp.raise_for_status()
                    return resp.json(), code, None
            except httpx.HTTPStatusError as exc:
                last_err = exc
                if exc.response.status_code == 404:
                    return None, 404, "not_found"
                if attempt >= self.retry:
                    break
                await asyncio.sleep(0.5 * attempt)
            except Exception as exc:
                last_err = exc
                if attempt >= self.retry:
                    break
                await asyncio.sleep(0.5 * attempt)
        return None, 0, str(last_err) if last_err else "error"


class JikanClient:
    def __init__(self, settings: Settings) -> None:
        self.timeout = settings.http_timeout_seconds
        self.retry = settings.http_retry_attempts
        self.interval = settings.mal_jikan_min_request_interval_seconds
        self._lock = asyncio.Lock()
        self._last_at = 0.0

    async def _throttle(self) -> None:
        async with self._lock:
            loop = asyncio.get_event_loop()
            now = loop.time()
            wait = self._last_at + self.interval - now
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_at = loop.time()

    async def get_anime_full(self, mal_id: int) -> tuple[dict[str, Any] | None, str | None]:
        url = f"{JIKAN_API_BASE}/anime/{mal_id}/full"
        last_err: Exception | None = None
        for attempt in range(1, self.retry + 1):
            try:
                await self._throttle()
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    resp = await client.get(url)
                    if resp.status_code == 404:
                        return None, "not_found"
                    if resp.status_code in {429, 500, 502, 503, 504} and attempt < self.retry:
                        await asyncio.sleep(1.0 * attempt)
                        continue
                    resp.raise_for_status()
                    return resp.json(), None
            except Exception as exc:
                last_err = exc
                if attempt >= self.retry:
                    break
                await asyncio.sleep(1.0 * attempt)
        return None, str(last_err) if last_err else "error"
