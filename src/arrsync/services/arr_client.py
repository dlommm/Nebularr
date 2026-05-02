from __future__ import annotations

import asyncio
import hmac
import logging
from typing import Any

import httpx

from arrsync.config import Settings
from arrsync.models import CapabilitySet

log = logging.getLogger(__name__)


def _summarize_arr_http_error(exc: BaseException) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        body = (exc.response.text or "").strip()
        if len(body) > 400:
            body = body[:400] + "..."
        if body:
            return f"HTTP {exc.response.status_code} {body}"
        return f"HTTP {exc.response.status_code} {exc.response.reason_phrase}"
    return str(exc) or type(exc).__name__


class ArrClient:
    def __init__(
        self,
        settings: Settings,
        source: str,
        *,
        instance_name: str = "default",
        base_url: str | None = None,
        api_key: str | None = None,
    ):
        self.settings = settings
        self.source = source
        self.instance_name = instance_name
        if source == "sonarr":
            self.base_url = (base_url or settings.sonarr_base_url).rstrip("/")
            self.api_key = api_key if api_key is not None else settings.sonarr_api_key
        else:
            self.base_url = (base_url or settings.radarr_base_url).rstrip("/")
            self.api_key = api_key if api_key is not None else settings.radarr_api_key
        self.timeout = settings.http_timeout_seconds
        self.retry_attempts = settings.http_retry_attempts
        self.semaphore = asyncio.Semaphore(settings.http_max_parallel_requests)
        self.capabilities = CapabilitySet(
            source=source,
            app_version="unknown",
            supports_history=True,
            supports_episode_include_files=True,
            raw={},
        )

    async def _request(
        self,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
    ) -> Any:
        url = f"{self.base_url}{path}"
        headers = {"X-Api-Key": self.api_key}
        last_err: Exception | None = None
        for attempt in range(1, self.retry_attempts + 1):
            try:
                async with self.semaphore:
                    async with httpx.AsyncClient(timeout=self.timeout) as client:
                        resp = await client.request(method, url, headers=headers, params=params, json=json)
                log.debug(
                    "arr http response",
                    extra={
                        "arr_source": self.source,
                        "instance_name": self.instance_name,
                        "method": method,
                        "path": path,
                        "status_code": resp.status_code,
                        "attempt": attempt,
                    },
                )
                if resp.status_code in {429, 500, 502, 503, 504} and attempt < self.retry_attempts:
                    await asyncio.sleep(0.5 * attempt)
                    continue
                resp.raise_for_status()
                if not resp.content:
                    return {}
                try:
                    return resp.json()
                except ValueError:
                    return {}
            except Exception as exc:
                last_err = exc
                if attempt >= self.retry_attempts:
                    break
                await asyncio.sleep(0.5 * attempt)
        assert last_err is not None
        detail = _summarize_arr_http_error(last_err)
        raise RuntimeError(f"{self.source} request failed: {method} {path}: {detail}") from last_err

    async def system_status(self) -> dict[str, Any]:
        return await self._request("GET", "/api/v3/system/status")

    async def detect_capabilities(self) -> CapabilitySet:
        status = await self.system_status()
        app_version = str(status.get("version", "unknown"))
        supports_history = await self._probe_history_support()
        supports_episode_include = True
        if self.source == "sonarr":
            supports_episode_include = await self._probe_sonarr_episode_include_support()
        detected = CapabilitySet(
            source=self.source,
            app_version=app_version,
            supports_history=supports_history,
            supports_episode_include_files=supports_episode_include,
            raw=status,
        )
        self.capabilities = detected
        return detected

    async def _probe_history_support(self) -> bool:
        try:
            await self._request("GET", "/api/v3/history", params={"page": 1, "pageSize": 1})
            return True
        except Exception:
            return False

    async def _probe_sonarr_episode_include_support(self) -> bool:
        try:
            await self._request(
                "GET",
                "/api/v3/episode",
                params={"seriesId": -1, "includeEpisodeFile": "true"},
            )
            return True
        except Exception:
            return False

    async def list_series(self) -> list[dict[str, Any]]:
        if self.source != "sonarr":
            return []
        payload = await self._request("GET", "/api/v3/series")
        return payload if isinstance(payload, list) else []

    async def list_episodes(self, series_id: int) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"seriesId": series_id}
        if self.capabilities.supports_episode_include_files:
            params["includeEpisodeFile"] = "true"
        try:
            payload = await self._request("GET", "/api/v3/episode", params=params)
        except Exception:
            payload = await self._request("GET", "/api/v3/episode", params={"seriesId": series_id})
        return payload if isinstance(payload, list) else []

    async def list_movies(self) -> list[dict[str, Any]]:
        if self.source != "radarr":
            return []
        payload = await self._request("GET", "/api/v3/movie")
        return payload if isinstance(payload, list) else []

    async def get_movie(self, movie_id: int) -> dict[str, Any]:
        if self.source != "radarr":
            raise RuntimeError("get_movie requires radarr client")
        payload = await self._request("GET", f"/api/v3/movie/{int(movie_id)}")
        return payload if isinstance(payload, dict) else {}

    async def list_history_since(self, since: str | None = None) -> list[dict[str, Any]]:
        if not self.capabilities.supports_history:
            return []
        params: dict[str, Any] = {"page": 1, "pageSize": 200}
        if since:
            params["since"] = since
        payload = await self._request("GET", "/api/v3/history", params=params)
        records = payload.get("records", payload) if isinstance(payload, dict) else payload
        return records if isinstance(records, list) else []

    async def list_tags(self) -> list[dict[str, Any]]:
        payload = await self._request("GET", "/api/v3/tag")
        return payload if isinstance(payload, list) else []

    async def ensure_tag_id(self, label: str) -> int:
        """Resolve tag id by label. Matching is case-insensitive (Sonarr/Radarr SQLite UNIQUE on Label is)."""
        want = label.strip()
        if not want:
            raise ValueError("tag label must be non-empty after stripping whitespace")
        want_key = want.casefold()

        def _row_label_key(row: dict[str, Any]) -> str:
            return str(row.get("label", "")).strip().casefold()

        def _find_tag_id(rows: list[dict[str, Any]]) -> int | None:
            for row in rows:
                if _row_label_key(row) == want_key:
                    return int(row["id"])
            return None

        tags = await self.list_tags()
        existing = _find_tag_id(tags)
        if existing is not None:
            return existing
        try:
            created = await self._request(
                "POST",
                "/api/v3/tag",
                json={"label": want},
            )
            return int(created["id"])
        except Exception:
            # Duplicate label, race with another writer, or list_tags shape mismatch on first pass.
            tags = await self.list_tags()
            existing = _find_tag_id(tags)
            if existing is not None:
                return existing
            raise

    async def put_series(self, body: dict[str, Any]) -> dict[str, Any]:
        if self.source != "sonarr":
            raise RuntimeError("put_series requires sonarr client")
        return await self._request("PUT", "/api/v3/series", json=body)

    async def put_movie(self, body: dict[str, Any]) -> dict[str, Any]:
        if self.source != "radarr":
            raise RuntimeError("put_movie requires radarr client")
        return await self._request("PUT", "/api/v3/movie", json=body)

    @staticmethod
    def validate_webhook_secret(given: str, expected: str) -> bool:
        return hmac.compare_digest(given.encode("utf-8"), expected.encode("utf-8"))
