"""Regression tests for the v2.7.0 reporting correctness fixes (task 3, step 3).

Real Postgres only (needs the warehouse views + array SQL the fakes can't answer).
Set NEBULARR_TEST_DATABASE_URL to run; otherwise skipped.

Each test seeds a file-less episode / duplicate-title series / per-instance lag row
that the *old* SQL mis-handled, then asserts the corrected number.
"""

from __future__ import annotations

import json
import os
from contextlib import contextmanager
from types import SimpleNamespace
from typing import Any, Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from arrsync.api import build_router
from arrsync.migrations import run_migrations

DATABASE_URL = os.getenv("NEBULARR_TEST_DATABASE_URL", "").strip()

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not DATABASE_URL, reason="NEBULARR_TEST_DATABASE_URL not set"),
]


@pytest.fixture(scope="module")
def engine():  # type: ignore[no-untyped-def]
    run_migrations(SimpleNamespace(database_url=DATABASE_URL))  # type: ignore[arg-type]
    engine = create_engine(DATABASE_URL, future=True)
    yield engine
    engine.dispose()


@pytest.fixture(scope="module")
def app_state(engine):  # type: ignore[no-untyped-def]
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)

    class IntegrationAppState:
        def __init__(self) -> None:
            self.settings = SimpleNamespace(
                app_version="test",
                app_git_sha="test",
                arr_dub_tag_label="English-Dubbed-Anime",
                arr_coverage_full_tag_label="fully-english",
                arr_coverage_partial_tag_label="partial-english",
                mal_dub_info_url="",
            )
            self.metrics = SimpleNamespace(inc=lambda *_: None, set_gauge=lambda *_: None)

        @contextmanager
        def session_scope(self) -> Iterator[Any]:
            session = factory()
            try:
                yield session
                session.commit()
            except Exception:
                session.rollback()
                raise
            finally:
                session.close()

    return IntegrationAppState()


@pytest.fixture(scope="module")
def client(app_state):  # type: ignore[no-untyped-def]
    app = FastAPI()
    app.include_router(build_router(app_state))
    return TestClient(app)


# --- seeding helpers -------------------------------------------------------------

def _add_series(s: Any, *, sid: int, inst: str, title: str, monitored: bool, stype: str = "standard") -> None:
    s.execute(
        text(
            """
            insert into warehouse.series (source_id, instance_name, title, monitored, payload)
            values (:sid, :inst, :title, :mon, cast(:payload as jsonb))
            on conflict (source_id, instance_name) do update
              set title = excluded.title, monitored = excluded.monitored, payload = excluded.payload
            """
        ),
        {"sid": sid, "inst": inst, "title": title, "mon": monitored, "payload": json.dumps({"seriesType": stype})},
    )


def _add_episode(
    s: Any, *, sid: int, inst: str, series_sid: int, num: int, monitored: bool = True, has_file: bool = True
) -> None:
    s.execute(
        text(
            """
            insert into warehouse.episode (
                source_id, instance_name, series_source_id, season_number, episode_number,
                title, monitored, payload
            )
            values (:sid, :inst, :series_sid, 1, :num, :title, :mon, cast(:payload as jsonb))
            on conflict (source_id, instance_name) do update
              set payload = excluded.payload, monitored = excluded.monitored
            """
        ),
        {
            "sid": sid,
            "inst": inst,
            "series_sid": series_sid,
            "num": num,
            "title": f"ep{num}",
            "mon": monitored,
            "payload": json.dumps({"hasFile": has_file}),
        },
    )


def _add_episode_file(
    s: Any,
    *,
    sid: int,
    inst: str,
    episode_sid: int,
    quality: str = "1080p",
    audio: list[str] | None = None,
    subs: list[str] | None = None,
    size: int = 1024,
    path: str | None = None,
) -> None:
    s.execute(
        text(
            """
            insert into warehouse.episode_file (
                source_id, instance_name, episode_source_id, quality, size_bytes,
                audio_languages, subtitle_languages, path
            )
            values (:sid, :inst, :episode_sid, :quality, :size,
                    cast(:audio as text[]), cast(:subs as text[]), :path)
            on conflict (source_id, instance_name) do update
              set quality = excluded.quality, size_bytes = excluded.size_bytes,
                  audio_languages = excluded.audio_languages,
                  subtitle_languages = excluded.subtitle_languages, path = excluded.path
            """
        ),
        {
            "sid": sid,
            "inst": inst,
            "episode_sid": episode_sid,
            "quality": quality,
            "size": size,
            "audio": audio if audio is not None else [],
            "subs": subs if subs is not None else [],
            "path": path or f"/media/{inst}/{sid}.mkv",
        },
    )


def _add_movie(s: Any, *, sid: int, inst: str, title: str, monitored: bool, has_file: bool) -> None:
    s.execute(
        text(
            """
            insert into warehouse.movie (source_id, instance_name, title, monitored, payload)
            values (:sid, :inst, :title, :mon, cast(:payload as jsonb))
            on conflict (source_id, instance_name) do update
              set monitored = excluded.monitored, payload = excluded.payload
            """
        ),
        {"sid": sid, "inst": inst, "title": title, "mon": monitored, "payload": json.dumps({"hasFile": has_file})},
    )


def _add_movie_file(
    s: Any, *, sid: int, inst: str, movie_sid: int, quality: str = "1080p", subs: list[str] | None = None
) -> None:
    s.execute(
        text(
            """
            insert into warehouse.movie_file (
                source_id, instance_name, movie_source_id, quality, subtitle_languages, path
            )
            values (:sid, :inst, :movie_sid, :quality, cast(:subs as text[]), :path)
            on conflict (source_id, instance_name) do update
              set quality = excluded.quality, subtitle_languages = excluded.subtitle_languages
            """
        ),
        {
            "sid": sid,
            "inst": inst,
            "movie_sid": movie_sid,
            "quality": quality,
            "subs": subs if subs is not None else [],
            "path": f"/movies/{inst}/{sid}.mkv",
        },
    )


def _panel(body: dict, panel_id: str) -> dict:
    return next(p for p in body["panels"] if p["id"] == panel_id)


# --- (a) language-audit: "no subtitles" must require a downloaded file ------------

def test_language_audit_no_subtitles_excludes_fileless_episodes(app_state, client) -> None:  # type: ignore[no-untyped-def]
    inst = "rc_suba"
    with app_state.session_scope() as s:
        _add_series(s, sid=1, inst=inst, title="Sub Show", monitored=True)
        _add_episode(s, sid=11, inst=inst, series_sid=1, num=1, has_file=True)
        _add_episode_file(s, sid=11, inst=inst, episode_sid=11, subs=[])  # file, no subs -> listed
        _add_episode(s, sid=12, inst=inst, series_sid=1, num=2, has_file=False)  # no file -> excluded
        _add_episode(s, sid=13, inst=inst, series_sid=1, num=3, has_file=True)
        _add_episode_file(s, sid=13, inst=inst, episode_sid=13, subs=["english"])  # has subs -> excluded

    body = client.get("/api/reporting/dashboards/language-audit", params={"instance_name": inst}).json()
    nums = {r["episode_number"] for r in _panel(body, "episodes_without_subtitles")["rows"]}
    assert nums == {1}, f"only the file-with-no-subs episode should appear, got {nums}"


# --- (b) monitoring-audit: subtitle/quality panels must require a file row --------

def test_monitoring_audit_subtitle_and_quality_require_file(app_state, client) -> None:  # type: ignore[no-untyped-def]
    inst = "rc_mona"
    with app_state.session_scope() as s:
        _add_series(s, sid=2, inst=inst, title="Mon Show", monitored=False)
        _add_episode(s, sid=21, inst=inst, series_sid=2, num=1, has_file=True)
        _add_episode_file(s, sid=21, inst=inst, episode_sid=21, quality="720p HDTV", subs=[])
        _add_episode(s, sid=22, inst=inst, series_sid=2, num=2, has_file=False)  # no file
        _add_movie(s, sid=25, inst=inst, title="Mon Movie With File", monitored=False, has_file=True)
        _add_movie_file(s, sid=25, inst=inst, movie_sid=25, quality="480p DVD", subs=[])
        _add_movie(s, sid=26, inst=inst, title="Mon Movie No File", monitored=False, has_file=False)  # no file

    body = client.get("/api/reporting/dashboards/monitoring-audit", params={"instance_name": inst}).json()

    subs_titles = {r["item_title"] for r in _panel(body, "unmonitored_without_subtitles")["rows"]}
    assert "ep1" in subs_titles and "Mon Movie With File" in subs_titles
    assert "ep2" not in subs_titles, "file-less episode must not count as 'without subtitles'"
    assert "Mon Movie No File" not in subs_titles, "file-less movie must not count as 'without subtitles'"

    q_titles = {r["item_title"] for r in _panel(body, "unmonitored_non_1080p")["rows"]}
    assert "ep1" in q_titles and "Mon Movie With File" in q_titles
    assert "ep2" not in q_titles, "file-less episode must not count as 'non-1080p'"
    assert "Mon Movie No File" not in q_titles, "file-less movie must not count as 'non-1080p'"


# --- (c) missing-english stat (view) agrees with the detailed table panel ---------

def test_missing_english_stat_matches_detailed_table(app_state, client) -> None:  # type: ignore[no-untyped-def]
    inst = "rc_enga"
    with app_state.session_scope() as s:
        _add_series(s, sid=3, inst=inst, title="Eng Show", monitored=True)
        _add_episode(s, sid=31, inst=inst, series_sid=3, num=1, has_file=True)
        _add_episode_file(s, sid=31, inst=inst, episode_sid=31, audio=["japanese"])  # missing english
        _add_episode(s, sid=32, inst=inst, series_sid=3, num=2, has_file=True)
        _add_episode_file(s, sid=32, inst=inst, episode_sid=32, audio=[])  # empty audio -> missing english
        _add_episode(s, sid=33, inst=inst, series_sid=3, num=3, has_file=True)
        _add_episode_file(s, sid=33, inst=inst, episode_sid=33, audio=["english"])  # has english

    body = client.get("/api/reporting/dashboards/media-deep-dive", params={"instance_name": inst}).json()
    stat = _panel(body, "missing_english_audio")["value"]
    table_rows = _panel(body, "detailed_missing_english")["rows"]
    assert stat == len(table_rows) == 2, f"stat={stat} table={len(table_rows)} (expected 2 each)"

    # the rebuilt view uses coalesce(audio_languages, ...) — assert structurally
    with app_state.session_scope() as s:
        viewdef = s.execute(
            text("select pg_get_viewdef('warehouse.v_episodes_missing_english_audio', true)")
        ).scalar_one()
    assert "coalesce" in viewdef.lower()


# --- (d) large-files detail joins on series_source_id, not title ------------------

def test_large_files_join_uses_series_source_id_not_title(app_state, client) -> None:  # type: ignore[no-untyped-def]
    inst = "rc_lfa"
    big = 4 * 1024 * 1024 * 1024  # 4 GiB > 3 GiB threshold
    with app_state.session_scope() as s:
        # two DISTINCT series sharing the exact same title in the same instance
        _add_series(s, sid=41, inst=inst, title="Dup Title", monitored=True)
        _add_series(s, sid=42, inst=inst, title="Dup Title", monitored=False)
        _add_episode(s, sid=411, inst=inst, series_sid=41, num=1, has_file=True)
        _add_episode_file(s, sid=411, inst=inst, episode_sid=411, size=big, path="/big/mon.mkv")
        _add_episode(s, sid=421, inst=inst, series_sid=42, num=2, has_file=True)
        _add_episode_file(s, sid=421, inst=inst, episode_sid=421, size=big, path="/big/unmon.mkv")

    body = client.get("/api/reporting/dashboards/media-deep-dive", params={"instance_name": inst}).json()
    rows = _panel(body, "detailed_large_files")["rows"]
    # title-based join duplicated each file across both same-title series (would be 4)
    assert len(rows) == 2, f"expected one row per file, got {len(rows)} (title-join duplication)"
    by_ep = {r["episode_number"]: r["series_monitored"] for r in rows}
    assert by_ep == {1: True, 2: False}, f"series_monitored must follow series_source_id, got {by_ep}"


# --- (e) ops-overview: lag honors instance filter; webhook stats labeled ----------

def test_ops_overview_lag_honors_instance_and_webhook_labeled(app_state, client) -> None:  # type: ignore[no-untyped-def]
    with app_state.session_scope() as s:
        for source in ("sonarr", "radarr"):
            s.execute(
                text(
                    """
                    insert into app.sync_state (source, instance_name, last_history_time)
                    values (:src, 'rc_lag_stale', now() - interval '10 days'),
                           (:src, 'rc_lag_fresh', now() - interval '1 minute')
                    on conflict (source, instance_name)
                      do update set last_history_time = excluded.last_history_time
                    """
                ),
                {"src": source},
            )

    body = client.get("/api/reporting/dashboards/ops-overview", params={"instance_name": "rc_lag_fresh"}).json()
    sonarr_lag = _panel(body, "sonarr_history_lag_sec")["value"]
    # unfiltered max would include the 10-day-stale row (~864000s); filtered -> ~60s
    assert sonarr_lag < 3600, f"lag must reflect only rc_lag_fresh, got {sonarr_lag}"

    for pid in ("queued_webhooks", "retrying_webhooks", "dead_letter_webhooks", "webhook_oldest_pending_min"):
        title = _panel(body, pid)["title"]
        assert title.endswith("(all instances)"), f"{pid} title should be labeled all-instances, got {title!r}"
