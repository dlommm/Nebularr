"""CoverageTagSyncService: fully-english/partial-english reconcile against fake Arr clients."""

from __future__ import annotations

import pytest

from arrsync.services.coverage_tag_service import CoverageTagSyncService
from arr_tag_fakes import FakeArrClient, TagSyncFakeSession, integration_row
from fakes import FakeSettings

FULL_ID = 11
PARTIAL_ID = 12
TAG_IDS = {"fully-english": FULL_ID, "partial-english": PARTIAL_ID}


def _coverage(source_id: int, status: str, instance: str = "default") -> dict:
    return {"instance_name": instance, "source_id": source_id, "coverage_status": status}


def _service(session: TagSyncFakeSession) -> CoverageTagSyncService:
    return CoverageTagSyncService(
        FakeSettings(), lambda: session, arr_client_class=FakeArrClient
    )


@pytest.mark.asyncio
async def test_series_full_partial_swap_clear_and_noop() -> None:
    FakeArrClient.reset(tag_ids=TAG_IDS)
    session = TagSyncFakeSession(
        series_coverage_rows=[
            _coverage(10, "full"),
            _coverage(11, "partial"),
            _coverage(12, "full"),
            _coverage(15, "full"),
        ],
        integrations={"sonarr": [integration_row("sonarr")], "radarr": []},
        series_rows={
            "default": [
                # gets fully-english
                {"source_id": 10, "payload": {"id": 10, "tags": []}},
                # gets partial-english
                {"source_id": 11, "payload": {"id": 11, "tags": [3]}},
                # partial -> full swap must happen in ONE put
                {"source_id": 12, "payload": {"id": 12, "tags": [PARTIAL_ID, 3]}},
                # out of scope: stale coverage tag cleared, other tags kept
                {"source_id": 13, "payload": {"id": 13, "tags": [FULL_ID, 4]}},
                # out of scope, no coverage tags: untouched
                {"source_id": 14, "payload": {"id": 14, "tags": [4]}},
                # already correct: untouched
                {"source_id": 15, "payload": {"id": 15, "tags": [FULL_ID]}},
            ]
        },
    )
    details = await _service(session).run(reason="test")
    client = FakeArrClient.instances[0]
    puts = {b["id"]: b["tags"] for b in client.put_series_calls}
    assert set(puts) == {10, 11, 12, 13}
    assert puts[10] == [FULL_ID]
    assert puts[11] == [3, PARTIAL_ID]
    assert puts[12] == [3, FULL_ID]
    assert puts[13] == [4]
    assert details["sonarr_updated"] == 3
    assert details["sonarr_cleared"] == 1
    assert details["errors"] == []
    assert details["full_tag_label"] == "fully-english"
    assert details["partial_tag_label"] == "partial-english"
    assert client.closed
    assert session.finished_runs == [("success", None)]


@pytest.mark.asyncio
async def test_movies_reconciled_via_put_movie() -> None:
    FakeArrClient.reset(tag_ids=TAG_IDS)
    session = TagSyncFakeSession(
        movie_coverage_rows=[_coverage(20, "full"), _coverage(21, "partial")],
        integrations={"sonarr": [], "radarr": [integration_row("radarr")]},
        movie_rows={
            "default": [
                {"source_id": 20, "payload": {"id": 20, "tags": []}},
                {"source_id": 21, "payload": {"id": 21, "tags": [FULL_ID]}},
                {"source_id": 22, "payload": {"id": 22, "tags": [PARTIAL_ID]}},
            ]
        },
    )
    details = await _service(session).run(reason="test")
    client = FakeArrClient.instances[0]
    puts = {b["id"]: b["tags"] for b in client.put_movie_calls}
    assert puts == {20: [FULL_ID], 21: [PARTIAL_ID], 22: []}
    assert details["radarr_updated"] == 2
    assert details["radarr_cleared"] == 1


@pytest.mark.asyncio
async def test_ensure_tag_failure_skips_instance() -> None:
    FakeArrClient.reset(tag_ids=TAG_IDS, ensure_tag_failures={"sonarr"})
    session = TagSyncFakeSession(
        series_coverage_rows=[_coverage(10, "full")],
        integrations={"sonarr": [integration_row("sonarr")], "radarr": []},
        series_rows={"default": [{"source_id": 10, "payload": {"id": 10, "tags": []}}]},
    )
    details = await _service(session).run(reason="test")
    assert details["sonarr_updated"] == 0
    assert details["errors"] and details["errors"][0]["phase"] == "ensure_tag"
    client = FakeArrClient.instances[0]
    assert client.put_series_calls == []
    assert client.closed
    assert session.finished_runs == [("success", None)]


@pytest.mark.asyncio
async def test_put_failure_recorded_and_loop_continues() -> None:
    FakeArrClient.reset(tag_ids=TAG_IDS, put_failures={10})
    session = TagSyncFakeSession(
        series_coverage_rows=[_coverage(10, "full"), _coverage(13, "partial")],
        integrations={"sonarr": [integration_row("sonarr")], "radarr": []},
        series_rows={
            "default": [
                {"source_id": 10, "payload": {"id": 10, "tags": []}},
                {"source_id": 13, "payload": {"id": 13, "tags": []}},
            ]
        },
    )
    details = await _service(session).run(reason="test")
    assert details["sonarr_updated"] == 1
    assert details["errors"] and details["errors"][0]["series_id"] == 10
    client = FakeArrClient.instances[0]
    assert [b["id"] for b in client.put_series_calls] == [13]
