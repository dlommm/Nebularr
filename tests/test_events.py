from __future__ import annotations

import asyncio
import threading

import pytest

from arrsync.events import EventBus
from arrsync.routers.events import event_stream


@pytest.mark.asyncio
async def test_publish_from_worker_thread_reaches_subscriber() -> None:
    bus = EventBus()
    bus.bind_loop(asyncio.get_running_loop())
    async with bus.subscribe() as queue:
        thread = threading.Thread(target=bus.publish, args=("sync.progress", {"records_processed": 5}))
        thread.start()
        thread.join()
        event = await asyncio.wait_for(queue.get(), timeout=2.0)
    assert event["type"] == "sync.progress"
    assert event["data"]["records_processed"] == 5
    assert event["ts"]
    assert bus.subscriber_count == 0


@pytest.mark.asyncio
async def test_publish_without_bound_loop_is_dropped() -> None:
    bus = EventBus()
    bus.publish("sync.progress", {})  # must not raise


@pytest.mark.asyncio
async def test_slow_subscriber_drops_events_without_blocking_publisher() -> None:
    bus = EventBus(max_queue_size=2)
    bus.bind_loop(asyncio.get_running_loop())
    async with bus.subscribe() as queue:
        for i in range(5):
            bus.publish("sync.progress", {"i": i})
        await asyncio.sleep(0)  # let call_soon_threadsafe callbacks run
        received = []
        while not queue.empty():
            received.append(queue.get_nowait())
    assert len(received) == 2, "overflow events must be dropped, not queued"
    assert [e["data"]["i"] for e in received] == [0, 1]


@pytest.mark.asyncio
async def test_event_stream_yields_connected_keepalive_and_event_frames() -> None:
    bus = EventBus()
    bus.bind_loop(asyncio.get_running_loop())
    stream = event_stream(bus, keepalive_seconds=0.02)
    try:
        first = await asyncio.wait_for(stream.__anext__(), timeout=1.0)
        assert first == ": connected\n\n"
        assert bus.subscriber_count == 1

        # No events published yet → keepalive comment.
        frame = await asyncio.wait_for(stream.__anext__(), timeout=1.0)
        assert frame == ": keepalive\n\n"

        bus.publish("sync.finished", {"status": "success"})
        for _ in range(10):  # allow at most a few keepalives before the event
            frame = await asyncio.wait_for(stream.__anext__(), timeout=1.0)
            if not frame.startswith(":"):
                break
        assert frame.startswith("event: sync.finished\n")
        assert '"status": "success"' in frame
    finally:
        await stream.aclose()
    assert bus.subscriber_count == 0, "closing the stream must unsubscribe"
