from __future__ import annotations

import pytest

from arrsync.services.url_guard import UrlPolicyError, assert_url_allowed


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
