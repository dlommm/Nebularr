"""MalTagSyncService reconcile loop against fake Arr clients (no network, no Postgres)."""

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
    FakeArrClient.reset(tag_ids={DUB_LABEL: 5})
    monkeypatch.setattr("arrsync.mal.tag_sync_service.ArrClient", FakeArrClient)
    session = TagSyncFakeSession(
        link_rows=[_link(10)],
        integrations={"sonarr": [integration_row("sonarr")], "radarr": []},
        series_rows={
            "default": [
                {"source_id": 10, "payload": {"id": 10, "tags": []}},
                {"source_id": 11, "payload": {"id": 11, "tags": [5, 7]}},
                {"source_id": 12, "payload": {"id": 12, "tags": [7]}},
            ]
        },
    )
    svc = MalTagSyncService(FakeSettings(), lambda: session)
    details = await svc.run(reason="test")
    assert details["sonarr_tagged"] == 1
    assert details["sonarr_untagged"] == 1
    assert details["errors"] == []
    client = FakeArrClient.instances[0]
    assert [b["id"] for b in client.put_series_calls] == [10, 11]
    assert client.put_series_calls[0]["tags"] == [5]
    assert client.put_series_calls[1]["tags"] == [7]
    assert client.closed
    assert session.finished_runs == [("success", None)]


@pytest.mark.asyncio
async def test_radarr_movie_tagging_mirrors_sonarr(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeArrClient.reset(tag_ids={DUB_LABEL: 5})
    monkeypatch.setattr("arrsync.mal.tag_sync_service.ArrClient", FakeArrClient)
    session = TagSyncFakeSession(
        link_rows=[_link(20, entity="radarr_movie")],
        integrations={"sonarr": [], "radarr": [integration_row("radarr")]},
        movie_rows={
            "default": [
                {"source_id": 20, "payload": {"id": 20, "tags": []}},
                {"source_id": 21, "payload": {"id": 21, "tags": [5]}},
            ]
        },
    )
    svc = MalTagSyncService(FakeSettings(), lambda: session)
    details = await svc.run(reason="test")
    assert details["radarr_tagged"] == 1
    assert details["radarr_untagged"] == 1
    client = FakeArrClient.instances[0]
    assert [b["id"] for b in client.put_movie_calls] == [20, 21]
    assert client.put_movie_calls[0]["tags"] == [5]
    assert client.put_movie_calls[1]["tags"] == []


@pytest.mark.asyncio
async def test_ensure_tag_failure_skips_instance_and_records_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    FakeArrClient.reset(tag_ids={DUB_LABEL: 5}, ensure_tag_failures={"sonarr"})
    monkeypatch.setattr("arrsync.mal.tag_sync_service.ArrClient", FakeArrClient)
    session = TagSyncFakeSession(
        link_rows=[_link(10)],
        integrations={"sonarr": [integration_row("sonarr")], "radarr": []},
        series_rows={"default": [{"source_id": 10, "payload": {"id": 10, "tags": []}}]},
    )
    svc = MalTagSyncService(FakeSettings(), lambda: session)
    details = await svc.run(reason="test")
    assert details["sonarr_tagged"] == 0
    assert details["errors"] and details["errors"][0]["phase"] == "ensure_tag"
    client = FakeArrClient.instances[0]
    assert client.put_series_calls == []
    assert client.closed
    # A single unreachable instance is an error entry, not a failed run.
    assert session.finished_runs == [("success", None)]


@pytest.mark.asyncio
async def test_put_failure_is_recorded_and_loop_continues(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    FakeArrClient.reset(tag_ids={DUB_LABEL: 5}, put_failures={10})
    monkeypatch.setattr("arrsync.mal.tag_sync_service.ArrClient", FakeArrClient)
    session = TagSyncFakeSession(
        link_rows=[_link(10), _link(13)],
        integrations={"sonarr": [integration_row("sonarr")], "radarr": []},
        series_rows={
            "default": [
                {"source_id": 10, "payload": {"id": 10, "tags": []}},
                {"source_id": 13, "payload": {"id": 13, "tags": []}},
            ]
        },
    )
    svc = MalTagSyncService(FakeSettings(), lambda: session)
    details = await svc.run(reason="test")
    assert details["sonarr_tagged"] == 1
    assert details["errors"] and details["errors"][0]["series_id"] == 10
    client = FakeArrClient.instances[0]
    assert [b["id"] for b in client.put_series_calls] == [13]
