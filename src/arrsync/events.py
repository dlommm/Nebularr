"""In-process event bus bridging worker threads to async SSE subscribers.

Publishers may run on the event loop or in `asyncio.to_thread` workers; both
funnel through `call_soon_threadsafe`, so subscriber queues are only touched
on the loop. Slow subscribers drop events instead of back-pressuring sync.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, AsyncIterator

log = logging.getLogger(__name__)

Event = dict[str, Any]


class EventBus:
    def __init__(self, *, max_queue_size: int = 256) -> None:
        self._max_queue_size = max_queue_size
        self._subscribers: set[asyncio.Queue[Event]] = set()
        self._lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    @property
    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subscribers)

    def publish(self, event_type: str, data: dict[str, Any] | None = None) -> None:
        """Safe to call from any thread. Events published before the loop is
        bound (early startup) are dropped — subscribers cannot exist yet."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        event: Event = {
            "type": event_type,
            "ts": datetime.now(timezone.utc).isoformat(),
            "data": data or {},
        }
        try:
            loop.call_soon_threadsafe(self._dispatch, event)
        except RuntimeError:  # loop shut down between the check and the call
            log.debug("event dropped during shutdown", extra={"event_type": event_type})

    def _dispatch(self, event: Event) -> None:
        with self._lock:
            subscribers = list(self._subscribers)
        for queue in subscribers:
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                # Slow consumer: drop rather than stall publishers.
                log.debug("event dropped for slow subscriber", extra={"event_type": event["type"]})

    @asynccontextmanager
    async def subscribe(self) -> AsyncIterator[asyncio.Queue[Event]]:
        queue: asyncio.Queue[Event] = asyncio.Queue(maxsize=self._max_queue_size)
        with self._lock:
            self._subscribers.add(queue)
        try:
            yield queue
        finally:
            with self._lock:
                self._subscribers.discard(queue)
