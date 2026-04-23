from __future__ import annotations

import asyncio
import hmac
import logging
from typing import Any

import httpx

from arrsync.config import Settings
from arrsync.models import CapabilitySet

log = logging.getLogger(__name__)


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
    ) -> Any:
        url = f"{self.base_url}{path}"
        headers = {"X-Api-Key": self.api_key}
        last_err: Exception | None = None
        for attempt in range(1, self.retry_attempts + 1):
            try:
                async with self.semaphore:
                    async with httpx.AsyncClient(timeout=self.timeout) as client:
                        resp = await client.request(method, url, headers=headers, params=params)
                if resp.status_code in {429, 500, 502, 503, 504} and attempt < self.retry_attempts:
                    await asyncio.sleep(0.5 * attempt)
                    continue
                resp.raise_for_status()
                return resp.json()
            except Exception as exc:
                last_err = exc
                if attempt >= self.retry_attempts:
                    break
                await asyncio.sleep(0.5 * attempt)
        raise RuntimeError(f"{self.source} request failed: {method} {path}") from last_err

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

    async def list_history_since(self, since: str | None = None) -> list[dict[str, Any]]:
        if not self.capabilities.supports_history:
            return []
        params: dict[str, Any] = {"page": 1, "pageSize": 200}
        if since:
            params["since"] = since
        payload = await self._request("GET", "/api/v3/history", params=params)
        records = payload.get("records", payload) if isinstance(payload, dict) else payload
        return records if isinstance(records, list) else []

    @staticmethod
    def validate_webhook_secret(given: str, expected: str) -> bool:
        return hmac.compare_digest(given.encode("utf-8"), expected.encode("utf-8"))
