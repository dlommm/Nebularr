"""Route-table snapshot: guards the api.py → routers/ refactor.

Any change to the set of (method, path) pairs the app serves must be deliberate:
update tests/fixtures/route_table.txt in the same commit and call it out in review.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI

from arrsync.api import build_router

from fakes import FakeAppState

FIXTURE = Path(__file__).parent / "fixtures" / "route_table.txt"


def _walk_routes(routes):  # type: ignore[no-untyped-def]
    """Yield leaf routes across fastapi versions: older releases flatten included
    routers into app.routes; 0.139+ nests them as _IncludedRouter wrappers."""
    for route in routes:
        wrapped = getattr(route, "original_router", None)
        if wrapped is not None:
            yield from _walk_routes(wrapped.routes)
            continue
        yield route


def current_route_table() -> list[str]:
    app = FastAPI()
    app.include_router(build_router(FakeAppState()))
    entries: set[str] = set()
    for route in _walk_routes(app.routes):
        # Duck-type instead of isinstance: route class hierarchies also move
        # between fastapi/starlette releases.
        methods = getattr(route, "methods", None)
        path = getattr(route, "path", None)
        if not methods or path is None:
            continue
        for method in sorted(methods):
            if method == "HEAD":
                continue
            entries.add(f"{method} {path}")
    return sorted(entries)


def test_route_table_matches_snapshot() -> None:
    expected = [line for line in FIXTURE.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert current_route_table() == expected
