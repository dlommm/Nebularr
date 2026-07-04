"""Login/logout/session + auth configuration endpoints."""

from __future__ import annotations

import logging
import secrets
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from arrsync.auth import (
    SESSION_COOKIE_NAME,
    LoginRateLimiter,
    auth_required,
    generate_api_token,
    get_auth_config,
    hash_password,
    invalidate_auth_cache,
    mint_session_token,
    request_is_authenticated,
    verify_password,
)
from arrsync.routers.shared import (
    to_bool,
)
from arrsync.security import hash_secret
from arrsync.services.auth_store import (
    store_api_token_hash,
    store_auth_enabled,
    store_auth_password_hash,
)

log = logging.getLogger(__name__)


def build_auth_router(app_state: Any) -> APIRouter:
    router = APIRouter()

    login_rate_limiter = LoginRateLimiter()

    @router.get("/api/auth/status")
    async def auth_status(request: Request) -> dict[str, Any]:
        config = get_auth_config(app_state)
        required = auth_required(app_state)
        return {
            "enabled": required,
            "password_set": bool(config and config.password_set),
            "api_token_set": bool(config and config.api_token_hash),
            "authenticated": (not required) or request_is_authenticated(request, app_state),
        }

    @router.post("/api/auth/login")
    async def auth_login(payload: dict[str, Any], request: Request) -> JSONResponse:
        client_key = request.client.host if request.client else "unknown"
        if login_rate_limiter.is_locked(client_key):
            raise HTTPException(status_code=429, detail="too many failed login attempts; try again shortly")
        password = str(payload.get("password", ""))
        config = get_auth_config(app_state)
        recovery = app_state.settings.auth_recovery_password.strip()
        authenticated = bool(config and config.password_hash and verify_password(password, config.password_hash))
        if not authenticated and recovery and password:
            if secrets.compare_digest(password, recovery):
                authenticated = True
                log.warning("login accepted via AUTH_RECOVERY_PASSWORD; set a regular password and unset it")
        if not authenticated:
            login_rate_limiter.register_failure(client_key)
            raise HTTPException(status_code=401, detail="invalid password")
        login_rate_limiter.reset(client_key)
        ttl_seconds = max(1, app_state.settings.auth_session_ttl_hours) * 3600
        token = mint_session_token(ttl_seconds)
        response = JSONResponse({"status": "ok"})
        secure_cookie = (
            request.url.scheme == "https"
            or request.headers.get("x-forwarded-proto", "").strip().lower() == "https"
        )
        response.set_cookie(
            SESSION_COOKIE_NAME,
            token,
            max_age=ttl_seconds,
            httponly=True,
            samesite="strict",
            secure=secure_cookie,
            path="/",
        )
        return response

    @router.post("/api/auth/logout")
    async def auth_logout() -> JSONResponse:
        response = JSONResponse({"status": "ok"})
        response.delete_cookie(SESSION_COOKIE_NAME, path="/")
        return response

    @router.put("/api/auth/config")
    async def auth_update_config(payload: dict[str, Any]) -> dict[str, Any]:
        # When auth is enabled the middleware has already authenticated this request;
        # when disabled, setting a password + enabling is intentionally open (first-run).
        if not app_state.session_factory.ready:
            raise HTTPException(status_code=400, detail="database not configured")
        config = get_auth_config(app_state)
        new_password = str(payload.get("password", ""))
        enabled_value = payload.get("enabled")
        rotate_token = bool(payload.get("rotate_api_token", False))
        revoke_token = bool(payload.get("revoke_api_token", False))
        if new_password and len(new_password) < 8:
            raise HTTPException(status_code=400, detail="password must be at least 8 characters")
        result: dict[str, Any] = {}
        with app_state.session_scope() as session:
            if new_password:
                store_auth_password_hash(session, hash_password(new_password))
            if enabled_value is not None:
                want_enabled = to_bool(enabled_value)
                password_available = bool(new_password) or bool(config and config.password_set)
                if want_enabled and not password_available:
                    raise HTTPException(status_code=400, detail="set a password before enabling authentication")
                store_auth_enabled(session, want_enabled)
            if rotate_token:
                api_token = generate_api_token()
                store_api_token_hash(session, hash_secret(api_token))
                result["api_token"] = api_token
            elif revoke_token:
                store_api_token_hash(session, "")
        invalidate_auth_cache(app_state)
        refreshed = get_auth_config(app_state)
        result.update(
            {
                "enabled": auth_required(app_state),
                "password_set": bool(refreshed and refreshed.password_set),
                "api_token_set": bool(refreshed and refreshed.api_token_hash),
            }
        )
        return result

    return router
