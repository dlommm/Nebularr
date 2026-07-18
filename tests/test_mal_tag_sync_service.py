"""MalTagSyncService reconcile loop against fake Arr clients (no network, no Postgres).

Desired tags diff against LIVE Arr state and apply via the bulk tag editor;
full-object PUTs (which clobber concurrent edits) must never happen.
"""

from __future__ import annotations

import pytest

from arrsync.mal.tag_sync_service import MalTagSyncService
from arr_tag_fakes import FakeArrClient, TagSyncFakeSession, integration_row
from fakes import FakeSettings

DUB_LABEL = "English-Dubbed-Anime"


def _link(source_id: int, entity: str = "sonarr_series", instance: str = "default") -> dict:
    return {"instance_name": instance, "arr_entity": entity, "warehouse_source_id": source_id}


@pytest.mark.asyncio
async def test_sonarr_tag_added_removed_and_untouched(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeArrClient.reset(
        tag_ids={DUB_LABEL: 5},
        live_series={
            "default": [
                {"id": 10, "tags": []},  # wanted, tag missing -> add
                {"id": 11, "tags": [5, 7]},  # not wanted, tagged -> remove
                {"id": 12, "tags": [7]},  # not wanted, untagged -> untouched
            ]
        },
    )
    monkeypatch.setattr("arrsync.mal.tag_sync_service.ArrClient", FakeArrClient)
    session = TagSyncFakeSession(
        link_rows=[_link(10)],
        integrations={"sonarr": [integration_row("sonarr")], "radarr": []},
    )
    svc = MalTagSyncService(FakeSettings(), lambda: session)
    details = await svc.run(reason="test")
    assert details["sonarr_tagged"] == 1
    assert details["sonarr_untagged"] == 1
    assert details["errors"] == []
    client = FakeArrClient.instances[0]
    assert client.tag_editor_calls == [("add", [10], [5]), ("remove", [11], [5])]
    # Regression: never PUT whole objects — concurrent Sonarr edits must survive.
    assert client.put_series_calls == []
    assert client.closed
    assert session.finished_runs == [("success", None)]


@pytest.mark.asyncio
async def test_radarr_movie_tagging_mirrors_sonarr(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeArrClient.reset(
        tag_ids={DUB_LABEL: 5},
        live_movies={
            "default": [
                {"id": 20, "tags": []},
                {"id": 21, "tags": [5]},
            ]
        },
    )
    monkeypatch.setattr("arrsync.mal.tag_sync_service.ArrClient", FakeArrClient)
    session = TagSyncFakeSession(
        link_rows=[_link(20, entity="radarr_movie")],
        integrations={"sonarr": [], "radarr": [integration_row("radarr")]},
    )
    svc = MalTagSyncService(FakeSettings(), lambda: session)
    details = await svc.run(reason="test")
    assert details["radarr_tagged"] == 1
    assert details["radarr_untagged"] == 1
    client = FakeArrClient.instances[0]
    assert client.tag_editor_calls == [("add", [20], [5]), ("remove", [21], [5])]
    assert client.put_movie_calls == []


@pytest.mark.asyncio
async def test_ensure_tag_failure_skips_instance_and_records_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    FakeArrClient.reset(
        tag_ids={DUB_LABEL: 5},
        ensure_tag_failures={"sonarr"},
        live_series={"default": [{"id": 10, "tags": []}]},
    )
    monkeypatch.setattr("arrsync.mal.tag_sync_service.ArrClient", FakeArrClient)
    session = TagSyncFakeSession(
        link_rows=[_link(10)],
        integrations={"sonarr": [integration_row("sonarr")], "radarr": []},
    )
    svc = MalTagSyncService(FakeSettings(), lambda: session)
    details = await svc.run(reason="test")
    assert details["sonarr_tagged"] == 0
    assert details["errors"] and details["errors"][0]["phase"] == "ensure_tag"
    client = FakeArrClient.instances[0]
    assert client.tag_editor_calls == []
    assert client.closed
    # Every processed instance failed (zero made progress): the run is failed.
    assert session.finished_runs == [("failed", None)]


@pytest.mark.asyncio
async def test_editor_failure_is_recorded_and_run_continues(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    FakeArrClient.reset(
        tag_ids={DUB_LABEL: 5},
        editor_failures={"sonarr:add"},
        live_series={
            "default": [
                {"id": 10, "tags": []},  # add batch fails
                {"id": 13, "tags": [5]},  # remove batch still runs
            ]
        },
    )
    monkeypatch.setattr("arrsync.mal.tag_sync_service.ArrClient", FakeArrClient)
    session = TagSyncFakeSession(
        link_rows=[_link(10)],
        integrations={"sonarr": [integration_row("sonarr")], "radarr": []},
    )
    svc = MalTagSyncService(FakeSettings(), lambda: session)
    details = await svc.run(reason="test")
    assert details["sonarr_tagged"] == 0
    assert details["sonarr_untagged"] == 1
    assert details["errors"] and details["errors"][0]["phase"] == "editor_add"
    assert details["errors"][0]["ids"] == [10]
    client = FakeArrClient.instances[0]
    assert client.tag_editor_calls == [("remove", [13], [5])]
    assert session.finished_runs == [("success", None)]
