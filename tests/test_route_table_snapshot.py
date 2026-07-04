"""Route-table snapshot: guards the api.py → routers/ refactor.

Any change to the set of (method, path) pairs the app serves must be deliberate:
update tests/fixtures/route_table.txt in the same commit and call it out in review.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from starlette.routing import Route

from arrsync.api import build_router

from fakes import FakeAppState

FIXTURE = Path(__file__).parent / "fixtures" / "route_table.txt"


def current_route_table() -> list[str]:
    app = FastAPI()
    app.include_router(build_router(FakeAppState()))
    entries: set[str] = set()
    for route in app.routes:
        if not isinstance(route, Route):
            continue
        for method in sorted(route.methods or []):
            if method == "HEAD":
                continue
            entries.add(f"{method} {route.path}")
    return sorted(entries)


def test_route_table_matches_snapshot() -> None:
    expected = [line for line in FIXTURE.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert current_route_table() == expected
