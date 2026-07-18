from __future__ import annotations

import httpx
import pytest

from arrsync.config import Settings
from arrsync.services.arr_client import ArrClient, ArrResponseError


def test_validate_webhook_secret():
    assert ArrClient.validate_webhook_secret("abc", "abc")
    assert not ArrClient.validate_webhook_secret("abc", "abcd")


def _settings() -> Settings:
    return Settings(
        database_url="postgresql+psycopg://arrapp:arrapp@localhost:5432/arranalytics",
        sonarr_base_url="http://sonarr.local",
        sonarr_api_key="sonarr-key",
        radarr_base_url="http://radarr.local",
        radarr_api_key="radarr-key",
    )


class _FakeHttpClient:
    """Minimal stand-in for httpx.AsyncClient returning one canned response."""

    def __init__(self, response: httpx.Response) -> None:
        self._response = response

    async def request(self, *_args: object, **_kwargs: object) -> httpx.Response:
        return self._response


def _client_returning(response: httpx.Response, source: str = "sonarr") -> ArrClient:
    client = ArrClient(_settings(), source)
    client._http_client = lambda: _FakeHttpClient(response)  # type: ignore[assignment,method-assign]
    return client


@pytest.mark.asyncio
async def test_request_raises_on_non_json_html_body() -> None:
    # A reverse proxy / login page returns 200 with an HTML body; the old code
    # silently coerced this to {} and downstream mass-tombstoned. It must raise.
    request = httpx.Request("GET", "http://sonarr.local/api/v3/series")
    response = httpx.Response(
        200,
        request=request,
        headers={"content-type": "text/html; charset=utf-8"},
        text="<html><body>Sign in</body></html>",
    )
    client = _client_returning(response)
    with pytest.raises(ArrResponseError):
        await client._request("GET", "/api/v3/series")


@pytest.mark.asyncio
async def test_request_raises_on_json_content_type_with_unparseable_body() -> None:
    request = httpx.Request("GET", "http://sonarr.local/api/v3/series")
    response = httpx.Response(
        200,
        request=request,
        headers={"content-type": "application/json"},
        content=b"not json at all",
    )
    client = _client_returning(response)
    with pytest.raises(ArrResponseError):
        await client._request("GET", "/api/v3/series")


@pytest.mark.asyncio
async def test_request_returns_parsed_json_list_body() -> None:
    request = httpx.Request("GET", "http://sonarr.local/api/v3/series")
    response = httpx.Response(
        200,
        request=request,
        headers={"content-type": "application/json"},
        json=[{"id": 1}, {"id": 2}],
    )
    client = _client_returning(response)
    assert await client._request("GET", "/api/v3/series") == [{"id": 1}, {"id": 2}]


@pytest.mark.asyncio
async def test_request_empty_body_still_returns_empty_dict() -> None:
    # A 200 with no content (e.g. some PUT/DELETE acks) is legitimate.
    request = httpx.Request("PUT", "http://sonarr.local/api/v3/series/editor")
    response = httpx.Response(200, request=request, content=b"")
    client = _client_returning(response)
    assert await client._request("PUT", "/api/v3/series/editor") == {}


@pytest.mark.asyncio
async def test_list_series_raises_when_payload_is_not_a_list() -> None:
    client = ArrClient(_settings(), "sonarr")

    async def fake_request(method: str, path: str, params: dict | None = None):  # type: ignore[no-untyped-def]
        return {"error": "unauthorized"}

    client._request = fake_request  # type: ignore[assignment]
    with pytest.raises(ArrResponseError):
        await client.list_series()


@pytest.mark.asyncio
async def test_list_movies_raises_when_payload_is_not_a_list() -> None:
    client = ArrClient(_settings(), "radarr")

    async def fake_request(method: str, path: str, params: dict | None = None):  # type: ignore[no-untyped-def]
        return {"page": 1, "records": []}

    client._request = fake_request  # type: ignore[assignment]
    with pytest.raises(ArrResponseError):
        await client.list_movies()


@pytest.mark.asyncio
async def test_list_series_ok_when_payload_is_a_list() -> None:
    client = ArrClient(_settings(), "sonarr")

    async def fake_request(method: str, path: str, params: dict | None = None):  # type: ignore[no-untyped-def]
        return [{"id": 1}]

    client._request = fake_request  # type: ignore[assignment]
    assert await client.list_series() == [{"id": 1}]
