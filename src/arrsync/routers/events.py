"""Server-sent events stream for live UI updates.

`GET /api/ui/events` is intentionally NOT in AUTH_EXEMPT_PATHS: the auth and
database-ready middlewares apply to it like any other /api route.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

KEEPALIVE_SECONDS = 15.0

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    # Tell nginx-style proxies not to buffer the stream.
    "X-Accel-Buffering": "no",
}


async def event_stream(event_bus: Any, keepalive_seconds: float = KEEPALIVE_SECONDS) -> AsyncIterator[str]:
    async with event_bus.subscribe() as queue:
        yield ": connected\n\n"
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=keepalive_seconds)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
                continue
            payload = json.dumps(event, default=str)
            yield f"event: {event['type']}\ndata: {payload}\n\n"


def build_events_router(app_state: Any) -> APIRouter:
    router = APIRouter()

    @router.get("/api/ui/events")
    async def stream_ui_events() -> StreamingResponse:
        return StreamingResponse(
            event_stream(app_state.event_bus), media_type="text/event-stream", headers=SSE_HEADERS
        )

    return router
