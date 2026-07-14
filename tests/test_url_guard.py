from __future__ import annotations

import pytest

from arrsync.services.url_guard import EgressGuardedTransport, UrlPolicyError, assert_url_allowed


@pytest.mark.parametrize(
    "url",
    [
        "ftp://files.example.com",
        "not a url",
        "http://",
        "",
    ],
)
def test_rejects_malformed_urls_under_every_policy(url: str) -> None:
    for policy in ("open", "lan", "strict"):
        with pytest.raises(UrlPolicyError):
            assert_url_allowed(url, policy)


def test_open_policy_allows_anything_that_parses() -> None:
    assert_url_allowed("http://169.254.169.254/latest/meta-data", "open")
    assert_url_allowed("http://localhost:8989", "open")


@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254/latest/meta-data",  # cloud metadata
        "http://[fe80::1]:8989",  # IPv6 link-local
    ],
)
def test_lan_policy_blocks_link_local(url: str) -> None:
    with pytest.raises(UrlPolicyError):
        assert_url_allowed(url, "lan")


@pytest.mark.parametrize(
    "url",
    [
        "http://192.168.1.10:8989",
        "http://10.0.0.5:7878",
        "http://127.0.0.1:8989",
        "http://localhost:8989",
    ],
)
def test_lan_policy_allows_private_and_loopback(url: str) -> None:
    assert_url_allowed(url, "lan")


@pytest.mark.parametrize(
    "url",
    [
        "http://192.168.1.10:8989",
        "http://10.0.0.5:7878",
        "http://127.0.0.1:8989",
        "http://169.254.169.254/",
    ],
)
def test_strict_policy_blocks_all_non_global(url: str) -> None:
    with pytest.raises(UrlPolicyError):
        assert_url_allowed(url, "strict")


def test_strict_policy_allows_global_addresses() -> None:
    assert_url_allowed("https://8.8.8.8/webhook", "strict")


def test_unresolvable_host_is_rejected_outside_open() -> None:
    with pytest.raises(UrlPolicyError):
        assert_url_allowed("http://definitely-not-a-real-host.invalid:8989", "lan")


class _FakeAddrinfo:
    """getaddrinfo stub returning one fixed address."""

    def __init__(self, address: str) -> None:
        self.address = address

    def __call__(self, *args: object, **kwargs: object) -> list:
        import socket

        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (self.address, 0))]


@pytest.mark.asyncio
async def test_guarded_transport_blocks_host_rebound_to_link_local(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import httpx

    from arrsync.services import url_guard

    monkeypatch.setattr(url_guard.socket, "getaddrinfo", _FakeAddrinfo("169.254.169.254"))
    transport = EgressGuardedTransport(policy="lan")
    request = httpx.Request("GET", "http://sonarr.example/api/v3/system/status")
    with pytest.raises(httpx.ConnectError, match="link-local"):
        await transport.handle_async_request(request)


@pytest.mark.asyncio
async def test_guarded_transport_passes_allowed_host_through(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import httpx

    from arrsync.services import url_guard

    monkeypatch.setattr(url_guard.socket, "getaddrinfo", _FakeAddrinfo("93.184.216.34"))

    async def fake_parent(self: object, request: httpx.Request) -> httpx.Response:
        return httpx.Response(204, request=request)

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", fake_parent)
    transport = EgressGuardedTransport(policy="lan")
    request = httpx.Request("GET", "http://sonarr.example/api/v3/system/status")
    response = await transport.handle_async_request(request)
    assert response.status_code == 204


@pytest.mark.asyncio
async def test_guarded_transport_open_policy_never_resolves(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import httpx

    from arrsync.services import url_guard

    def boom(*args: object, **kwargs: object) -> None:
        raise AssertionError("open policy must not resolve DNS in the guard")

    monkeypatch.setattr(url_guard.socket, "getaddrinfo", boom)

    async def fake_parent(self: object, request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, request=request)

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", fake_parent)
    transport = EgressGuardedTransport(policy="open")
    request = httpx.Request("GET", "http://169.254.169.254/latest/meta-data")
    response = await transport.handle_async_request(request)
    assert response.status_code == 200
