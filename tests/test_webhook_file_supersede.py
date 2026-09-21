from __future__ import annotations

from typing import Any

from arrsync.services.sync_service import SyncService


class RecordingSession:
    """Accepts any SQL and records it; the webhook writers only ever execute."""

    def __init__(self) -> None:
        self.statements: list[tuple[str, dict[str, Any] | None]] = []

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> Any:
        self.statements.append((" ".join(str(query).lower().split()), params))
        return None

    def commit(self) -> None:
        return None

    def rollback(self) -> None:
        return None

    def close(self) -> None:
        return None


def _service(session: RecordingSession) -> SyncService:
    return SyncService(session_factory=lambda: session, sonarr=None, radarr=None)  # type: ignore[arg-type]


def _supersede_calls(session: RecordingSession, table: str) -> list[dict[str, Any]]:
    return [
        params or {}
        for sql, params in session.statements
        if f"update warehouse.{table}" in sql and "set deleted = true" in sql
    ]


# An upgrade arrives as a NEW file id. Upserting it alone leaves the row it replaced
# live, so the item presents two files — one of which is gone from disk. Conformance
# reads every live row, and under series completeness one stale row disqualifies the
# whole show. Measured on a real library before this fix: 85 episodes across 3 shows
# carried more than one live file row.


def test_upgraded_episode_tombstones_the_row_it_replaced() -> None:
    session = RecordingSession()
    episodes = [
        {
            "id": 501,
            "seriesId": 9,
            "seasonNumber": 1,
            "episodeNumber": 1,
            "hasFile": True,
            "episodeFile": {"id": 7002, "quality": {"quality": {"name": "Bluray-1080p"}}},
        }
    ]
    _service(session)._write_webhook_episodes("sonarr", "inst", episodes, run_id=1, mode="webhook")

    calls = _supersede_calls(session, "episode_file")
    assert len(calls) == 1
    assert calls[0]["episode_source_id"] == 501
    assert calls[0]["keep_source_id"] == 7002
    assert calls[0]["instance_name"] == "inst"


def test_episode_without_a_file_in_the_payload_tombstones_nothing() -> None:
    """The data-loss guard, and the reason this is keyed on a file we DID write.

    ``list_episodes`` only asks for ``includeEpisodeFile`` when the instance supports
    it, and falls back to a request without it — so an absent ``episodeFile`` can
    mean "not included in this response" rather than "no file exists". Tombstoning on
    absence would wipe live rows for files that are still on disk.
    """
    session = RecordingSession()
    episodes = [{"id": 502, "seriesId": 9, "seasonNumber": 1, "episodeNumber": 2, "hasFile": True}]
    _service(session)._write_webhook_episodes("sonarr", "inst", episodes, run_id=1, mode="webhook")

    assert _supersede_calls(session, "episode_file") == []


def test_episode_file_without_an_id_tombstones_nothing() -> None:
    session = RecordingSession()
    episodes = [{"id": 503, "seriesId": 9, "seasonNumber": 1, "episodeNumber": 3, "episodeFile": {}}]
    _service(session)._write_webhook_episodes("sonarr", "inst", episodes, run_id=1, mode="webhook")

    assert _supersede_calls(session, "episode_file") == []


def test_supersede_scopes_to_the_one_episode_and_keeps_the_new_file() -> None:
    """The predicate must not reach other episodes of the series, and must never
    tombstone the row just written."""
    session = RecordingSession()
    episodes = [
        {"id": 601, "seriesId": 9, "seasonNumber": 1, "episodeNumber": 1,
         "episodeFile": {"id": 8001}},
        {"id": 602, "seriesId": 9, "seasonNumber": 1, "episodeNumber": 2,
         "episodeFile": {"id": 8002}},
    ]
    _service(session)._write_webhook_episodes("sonarr", "inst", episodes, run_id=1, mode="webhook")

    calls = _supersede_calls(session, "episode_file")
    assert [(c["episode_source_id"], c["keep_source_id"]) for c in calls] == [(601, 8001), (602, 8002)]
    sql = next(s for s, _ in session.statements if "update warehouse.episode_file" in s)
    assert "episode_source_id = :episode_source_id" in sql
    assert "source_id <> :keep_source_id" in sql
    assert "not deleted" in sql


def test_upgraded_movie_tombstones_the_row_it_replaced() -> None:
    session = RecordingSession()
    movies = [{"id": 301, "title": "a film", "hasFile": True, "movieFile": {"id": 9001}}]
    _service(session)._write_webhook_movies(
        "inst", movies, run_id=1, mode="webhook", deleted_movie_ids=[],
        job_source="radarr", event_type="Download",
    )

    calls = _supersede_calls(session, "movie_file")
    assert len(calls) == 1
    assert calls[0]["movie_source_id"] == 301
    assert calls[0]["keep_source_id"] == 9001


def test_movie_without_a_file_in_the_payload_tombstones_nothing() -> None:
    session = RecordingSession()
    movies = [{"id": 302, "title": "a film", "hasFile": True}]
    _service(session)._write_webhook_movies(
        "inst", movies, run_id=1, mode="webhook", deleted_movie_ids=[],
        job_source="radarr", event_type="Download",
    )

    assert _supersede_calls(session, "movie_file") == []
