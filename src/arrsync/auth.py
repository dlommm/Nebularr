"""Web UI / API authentication: password hashing, signed session cookies, API tokens.

Passwords use salted scrypt (never security.hash_secret, which is unsalted SHA-256
reserved for high-entropy secrets such as webhook secrets and generated API tokens).
Sessions are stateless HMAC-signed cookies so no server-side session table is needed.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import logging
import secrets
import time
from typing import Any

from fastapi.responses import JSONResponse

from arrsync.runtime_secrets import session_signing_key
from arrsync.security import verify_secret_hash
from arrsync.services.auth_store import AuthConfig, read_auth_config

log = logging.getLogger(__name__)

SESSION_COOKIE_NAME = "nebularr_session"
AUTH_EXEMPT_PATHS = {"/api/auth/login", "/api/auth/status"}
AUTH_PROTECTED_DOC_PATHS = {"/docs", "/redoc", "/openapi.json"}

_SCRYPT_N = 2**15
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_MAXMEM = 64 * 1024 * 1024
_SALT_BYTES = 16
_AUTH_CACHE_TTL_SECONDS = 5.0

_TRUE_VALUES = {"1", "true", "yes", "on"}
_FALSE_VALUES = {"0", "false", "no", "off"}


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(_SALT_BYTES)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, maxmem=_SCRYPT_MAXMEM
    )
    salt_b64 = base64.urlsafe_b64encode(salt).decode("utf-8")
    digest_b64 = base64.urlsafe_b64encode(digest).decode("utf-8")
    return f"scrypt${salt_b64}${digest_b64}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        scheme, salt_b64, digest_b64 = stored_hash.split("$", 2)
        if scheme != "scrypt":
            return False
        salt = base64.urlsafe_b64decode(salt_b64.encode("utf-8"))
        expected = base64.urlsafe_b64decode(digest_b64.encode("utf-8"))
    except (ValueError, TypeError):
        return False
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, maxmem=_SCRYPT_MAXMEM
    )
    return hmac.compare_digest(digest, expected)


def generate_api_token() -> str:
    return secrets.token_urlsafe(32)


def _sign(signing_key: bytes, body: str) -> str:
    mac = hmac.new(signing_key, body.encode("utf-8"), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac).decode("utf-8")


def mint_session_token(ttl_seconds: int, signing_key: bytes | None = None, epoch: int = 0) -> str:
    key = signing_key if signing_key is not None else session_signing_key()
    payload = json.dumps({"exp": int(time.time()) + ttl_seconds, "ep": epoch}, separators=(",", ":"))
    body = base64.urlsafe_b64encode(payload.encode("utf-8")).decode("utf-8")
    return f"{body}.{_sign(key, body)}"


def verify_session_token(token: str, signing_key: bytes | None = None, expected_epoch: int = 0) -> bool:
    if not token or "." not in token:
        return False
    key = signing_key if signing_key is not None else session_signing_key()
    body, _, signature = token.rpartition(".")
    if not body or not hmac.compare_digest(_sign(key, body), signature):
        return False
    try:
        payload = json.loads(base64.urlsafe_b64decode(body.encode("utf-8")))
        # Tokens minted before the epoch existed carry ep=0, so they stay valid
        # across the upgrade and die on the first password change.
        if int(payload.get("ep", 0)) != expected_epoch:
            return False
        return float(payload.get("exp", 0)) > time.time()
    except (ValueError, TypeError):
        return False


def _parse_trusted_proxies(raw: str) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    networks: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        try:
            networks.append(ipaddress.ip_network(entry, strict=False))
        except ValueError:
            log.warning("ignoring invalid trusted_proxies entry: %r", entry)
    return networks


def _ip_in_networks(value: str, networks: list[ipaddress.IPv4Network | ipaddress.IPv6Network]) -> bool:
    try:
        addr = ipaddress.ip_address(value)
    except ValueError:
        return False
    return any(addr in net for net in networks)


def client_key_for_request(request: Any, trusted_proxies: str) -> str:
    """Rate-limit key: the real client IP when behind a trusted reverse proxy.

    Walks X-Forwarded-For right-to-left skipping trusted hops, so an attacker
    can't spoof arbitrary keys and a proxy doesn't collapse every client into
    one shared lockout bucket. Without trusted proxies the peer address is used.
    """
    peer = request.client.host if request.client else "unknown"
    networks = _parse_trusted_proxies(trusted_proxies)
    if not networks or not _ip_in_networks(peer, networks):
        return peer
    forwarded = request.headers.get("x-forwarded-for", "")
    hops = [hop.strip() for hop in forwarded.split(",") if hop.strip()]
    for hop in reversed(hops):
        if not _ip_in_networks(hop, networks):
            return hop
    return peer


class LoginRateLimiter:
    """In-memory per-client lockout after repeated login failures."""

    def __init__(self, max_failures: int = 5, lockout_seconds: float = 30.0) -> None:
        self._max_failures = max_failures
        self._lockout_seconds = lockout_seconds
        self._failures: dict[str, tuple[int, float]] = {}

    def is_locked(self, key: str) -> bool:
        count, last_failure = self._failures.get(key, (0, 0.0))
        return count >= self._max_failures and time.time() < last_failure + self._lockout_seconds

    def register_failure(self, key: str) -> None:
        count, last_failure = self._failures.get(key, (0, 0.0))
        now = time.time()
        if count >= self._max_failures and now >= last_failure + self._lockout_seconds:
            count = 0
        if len(self._failures) > 10_000:
            self._failures.clear()
        self._failures[key] = (count + 1, now)

    def reset(self, key: str) -> None:
        self._failures.pop(key, None)


def get_auth_config(app_state: Any) -> AuthConfig | None:
    """Read auth config through a short-lived cache (None when the DB is not bound yet)."""
    if not app_state.session_factory.ready:
        return None
    now = time.monotonic()
    cached = getattr(app_state, "auth_config_cache", None)
    cached_at = getattr(app_state, "auth_config_cached_at", 0.0)
    if cached is not None and now - cached_at < _AUTH_CACHE_TTL_SECONDS:
        return cached
    with app_state.session_scope() as session:
        config = read_auth_config(session)
    app_state.auth_config_cache = config
    app_state.auth_config_cached_at = now
    return config


def invalidate_auth_cache(app_state: Any) -> None:
    app_state.auth_config_cache = None
    app_state.auth_config_cached_at = 0.0


def auth_required(app_state: Any) -> bool:
    """Whether requests must present a session cookie or bearer token.

    AUTH_ENABLED env overrides the stored setting: "false" is the lockout escape
    hatch, "true" forces enforcement on (needs a password or recovery password so
    login stays possible). Unset defers to app.settings written from the UI.
    """
    override = app_state.settings.auth_enabled.strip().lower()
    if override in _FALSE_VALUES:
        return False
    config = get_auth_config(app_state)
    if config is None:
        return False
    if override in _TRUE_VALUES:
        return config.password_set or bool(app_state.settings.auth_recovery_password.strip())
    return config.enabled and config.password_set


def session_epoch(app_state: Any) -> int:
    config = get_auth_config(app_state)
    return config.session_epoch if config is not None else 0


def request_is_authenticated(request: Any, app_state: Any) -> bool:
    config = get_auth_config(app_state)
    token = request.cookies.get(SESSION_COOKIE_NAME, "")
    epoch = config.session_epoch if config is not None else 0
    if token and verify_session_token(token, expected_epoch=epoch):
        return True
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        bearer = auth_header[7:].strip()
        if config is not None and config.api_token_hash and verify_secret_hash(bearer, config.api_token_hash):
            return True
    return False


def is_auth_protected_path(path: str) -> bool:
    """Only the JSON API and API docs are gated; SPA shell pages and static assets
    stay public (the SPA redirects to /login on the first 401), and /hooks/* has
    its own shared-secret check."""
    if path in AUTH_EXEMPT_PATHS:
        return False
    if path in AUTH_PROTECTED_DOC_PATHS:
        return True
    return path.startswith("/api/")


async def enforce_auth(request: Any, call_next: Any, app_state: Any) -> Any:
    """HTTP middleware body shared by the app and tests."""
    if not is_auth_protected_path(request.url.path):
        return await call_next(request)
    if not auth_required(app_state):
        return await call_next(request)
    if request_is_authenticated(request, app_state):
        return await call_next(request)
    return JSONResponse({"detail": "authentication required"}, status_code=401)
