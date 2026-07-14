"""CoverageTagSyncService: fully-english/partial-english reconcile against fake Arr clients.

Desired tags diff against LIVE Arr state and apply via the bulk tag editor;
full-object PUTs (which clobber concurrent edits) must never happen.
"""

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
    FakeArrClient.reset(
        tag_ids=TAG_IDS,
        live_series={
            "default": [
                # gets fully-english
                {"id": 10, "tags": []},
                # gets partial-english
                {"id": 11, "tags": [3]},
                # partial -> full swap: one add + one remove, counted once as updated
                {"id": 12, "tags": [PARTIAL_ID, 3]},
                # out of scope: stale coverage tag cleared, other tags untouched
                {"id": 13, "tags": [FULL_ID, 4]},
                # out of scope, no coverage tags: untouched
                {"id": 14, "tags": [4]},
                # already correct: untouched
                {"id": 15, "tags": [FULL_ID]},
            ]
        },
    )
    session = TagSyncFakeSession(
        series_coverage_rows=[
            _coverage(10, "full"),
            _coverage(11, "partial"),
            _coverage(12, "full"),
            _coverage(15, "full"),
        ],
        integrations={"sonarr": [integration_row("sonarr")], "radarr": []},
    )
    details = await _service(session).run(reason="test")
    client = FakeArrClient.instances[0]
    assert client.tag_editor_calls == [
        ("add", [10, 12], [FULL_ID]),
        ("add", [11], [PARTIAL_ID]),
        ("remove", [13], [FULL_ID]),
        ("remove", [12], [PARTIAL_ID]),
    ]
    # Regression: never PUT whole objects — concurrent Sonarr edits must survive.
    assert client.put_series_calls == []
    assert details["sonarr_updated"] == 3
    assert details["sonarr_cleared"] == 1
    assert details["errors"] == []
    assert details["full_tag_label"] == "fully-english"
    assert details["partial_tag_label"] == "partial-english"
    assert client.closed
    assert session.finished_runs == [("success", None)]


@pytest.mark.asyncio
async def test_movies_reconciled_via_tag_editor() -> None:
    FakeArrClient.reset(
        tag_ids=TAG_IDS,
        live_movies={
            "default": [
                {"id": 20, "tags": []},
                {"id": 21, "tags": [FULL_ID]},
                {"id": 22, "tags": [PARTIAL_ID]},
            ]
        },
    )
    session = TagSyncFakeSession(
        movie_coverage_rows=[_coverage(20, "full"), _coverage(21, "partial")],
        integrations={"sonarr": [], "radarr": [integration_row("radarr")]},
    )
    details = await _service(session).run(reason="test")
    client = FakeArrClient.instances[0]
    assert client.tag_editor_calls == [
        ("add", [20], [FULL_ID]),
        ("add", [21], [PARTIAL_ID]),
        ("remove", [21], [FULL_ID]),
        ("remove", [22], [PARTIAL_ID]),
    ]
    assert client.put_movie_calls == []
    assert details["radarr_updated"] == 2
    assert details["radarr_cleared"] == 1


@pytest.mark.asyncio
async def test_ensure_tag_failure_skips_instance() -> None:
    FakeArrClient.reset(
        tag_ids=TAG_IDS,
        ensure_tag_failures={"sonarr"},
        live_series={"default": [{"id": 10, "tags": []}]},
    )
    session = TagSyncFakeSession(
        series_coverage_rows=[_coverage(10, "full")],
        integrations={"sonarr": [integration_row("sonarr")], "radarr": []},
    )
    details = await _service(session).run(reason="test")
    assert details["sonarr_updated"] == 0
    assert details["errors"] and details["errors"][0]["phase"] == "ensure_tag"
    client = FakeArrClient.instances[0]
    assert client.tag_editor_calls == []
    assert client.closed
    assert session.finished_runs == [("success", None)]


@pytest.mark.asyncio
async def test_editor_failure_recorded_and_loop_continues() -> None:
    FakeArrClient.reset(
        tag_ids=TAG_IDS,
        editor_failures={"sonarr:add"},
        live_series={
            "default": [
                {"id": 10, "tags": []},  # add batch fails
                {"id": 13, "tags": [FULL_ID]},  # remove batch still runs
            ]
        },
    )
    session = TagSyncFakeSession(
        series_coverage_rows=[_coverage(10, "full")],
        integrations={"sonarr": [integration_row("sonarr")], "radarr": []},
    )
    details = await _service(session).run(reason="test")
    assert details["sonarr_updated"] == 0
    assert details["sonarr_cleared"] == 1
    assert details["errors"] and details["errors"][0]["phase"] == "editor_add"
    assert details["errors"][0]["ids"] == [10]
    client = FakeArrClient.instances[0]
    assert client.tag_editor_calls == [("remove", [13], [FULL_ID])]
    assert session.finished_runs == [("success", None)]
