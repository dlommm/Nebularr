"""Egress policy checks for user-configurable outbound URLs (integrations, alert webhooks).

Validation happens at configuration time. Policies:
  - "open":   scheme/netloc shape only (pre-2.0 behavior).
  - "lan":    default — additionally blocks link-local ranges, which covers cloud
              metadata endpoints (169.254.169.254). Loopback and RFC1918 stay allowed
              because Sonarr/Radarr almost always live on the same LAN or host.
  - "strict": also blocks loopback, RFC1918/unique-local, and any other non-global range.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


class UrlPolicyError(ValueError):
    """Raised when a URL is syntactically valid but denied by the egress policy."""


def _resolved_addresses(host: str) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    try:
        return [ipaddress.ip_address(host)]
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise UrlPolicyError(f"host {host!r} does not resolve") from exc
    addresses = []
    for info in infos:
        try:
            addresses.append(ipaddress.ip_address(info[4][0]))
        except ValueError:
            continue
    if not addresses:
        raise UrlPolicyError(f"host {host!r} does not resolve to a usable address")
    return addresses


def assert_url_allowed(url: str, policy: str) -> None:
    """Validate URL shape, then apply the egress policy. Raises UrlPolicyError."""
    parsed = urlparse(url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or not parsed.hostname:
        raise UrlPolicyError("must be a valid http(s) URL")
    if policy == "open":
        return
    for address in _resolved_addresses(parsed.hostname):
        if address.is_link_local:
            raise UrlPolicyError(f"{address} is link-local (metadata range); blocked by egress policy {policy!r}")
        if policy == "strict":
            if address.is_loopback or address.is_private or not address.is_global:
                raise UrlPolicyError(f"{address} is not globally routable; blocked by egress policy 'strict'")
