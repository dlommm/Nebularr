"""API surface for Nebularr: composes the routers under arrsync.routers.

Route paths and behavior are covered by tests/test_route_table_snapshot.py —
update that fixture deliberately when the surface changes.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from arrsync.routers.auth_routes import build_auth_router
from arrsync.routers.config import build_config_router
from arrsync.routers.hooks import build_hooks_router
from arrsync.routers.library import build_library_router
from arrsync.routers.mal_routes import build_mal_router
from arrsync.routers.operator import build_operator_router
from arrsync.routers.reporting import build_reporting_router
from arrsync.routers.setup import build_setup_router
from arrsync.routers.sync_ops import build_sync_ops_router
from arrsync.routers.system import build_system_router
from arrsync.routers.ui_shell import build_ui_shell_router


def build_router(app_state: Any) -> APIRouter:
    router = APIRouter()
    router.include_router(build_system_router(app_state))
    router.include_router(build_auth_router(app_state))
    router.include_router(build_reporting_router(app_state))
    router.include_router(build_setup_router(app_state))
    router.include_router(build_config_router(app_state))
    router.include_router(build_sync_ops_router(app_state))
    router.include_router(build_library_router(app_state))
    router.include_router(build_mal_router(app_state))
    router.include_router(build_operator_router(app_state))
    router.include_router(build_hooks_router(app_state))
    # Must stay last: contains the /{frontend_path:path} SPA catch-all.
    router.include_router(build_ui_shell_router(app_state))
    return router
