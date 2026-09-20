"""Real-Postgres checks for the automations schema and predicate compiler."""

from __future__ import annotations

import os
from types import SimpleNamespace

import pytest
import sqlalchemy
from sqlalchemy import text

from arrsync.migrations import run_migrations

DATABASE_URL = os.getenv("NEBULARR_TEST_DATABASE_URL", "").strip()

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not DATABASE_URL, reason="NEBULARR_TEST_DATABASE_URL not set"),
]


@pytest.fixture(scope="module")
def engine():
    # Self-bootstrap like the sibling integration modules: pytest may collect
    # this file first, so it cannot rely on another module having migrated.
    run_migrations(SimpleNamespace(database_url=DATABASE_URL))  # type: ignore[arg-type]
    eng = sqlalchemy.create_engine(DATABASE_URL, future=True)
    yield eng
    eng.dispose()


def test_automation_tables_exist(engine) -> None:
    with engine.connect() as conn:
        for table in ("automation", "automation_run", "automation_action_ledger"):
            assert conn.execute(
                text(
                    "select 1 from information_schema.tables"
                    " where table_schema = 'app' and table_name = :t"
                ),
                {"t": table},
            ).first() is not None, f"app.{table} missing"
        for table in ("movie_file", "episode_file"):
            assert conn.execute(
                text(
                    "select 1 from information_schema.columns"
                    " where table_schema = 'warehouse' and table_name = :t"
                    " and column_name = 'video_resolution'"
                ),
                {"t": table},
            ).first() is not None, f"warehouse.{table}.video_resolution missing"


def test_video_resolution_backfill_expression(engine) -> None:
    """The backfill regexes must extract heights from real payload shapes."""
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                """
                select
                    coalesce(
                        substring(v.payload->'mediaInfo'->>'resolution' from 'x([0-9]{3,4})')::int,
                        substring(coalesce(v.quality, '') from '([0-9]{3,4})[pi]')::int
                    ) as res,
                    v.expected
                from (values
                    ('{"mediaInfo": {"resolution": "1920x1080"}}'::jsonb, 'WEBDL-1080p', 1080),
                    ('{"mediaInfo": {"resolution": "3840x2160"}}'::jsonb, 'Bluray-2160p', 2160),
                    ('{}'::jsonb, 'HDTV-720p', 720),
                    ('{}'::jsonb, null, null)
                ) as v(payload, quality, expected)
                """
            )
        ).all()
        for res, expected in rows:
            assert res == expected


def test_movie_predicate_finds_missing_english_audio(engine) -> None:
    from arrsync.services.automation_rules import compile_candidates, validate_params

    params = validate_params(
        "custom",
        {
            "scope": {"media": "movies", "monitored_only": True},
            "require": {"audio_language_any": ["english", "eng"], "resolution_min": 1080},
            "actions": [{"type": "search_missing"}, {"type": "search_upgrade"}],
        },
    )
    compiled = compile_candidates(params, "movie")
    instance = "itest-automations"
    with engine.begin() as conn:
        conn.execute(text("delete from warehouse.movie_file where instance_name = :i"), {"i": instance})
        conn.execute(text("delete from warehouse.movie where instance_name = :i"), {"i": instance})
        conn.execute(text("delete from app.automation_action_ledger where instance_name = :i"), {"i": instance})
        conn.execute(
            text(
                """
                insert into warehouse.movie
                    (source_id, instance_name, title, monitored, payload, seen_at, last_seen_at, deleted)
                values
                    (1, :i, 'jpn-only 1080p', true, '{"hasFile": true}'::jsonb, now(), now(), false),
                    (2, :i, 'dual audio 1080p', true, '{"hasFile": true}'::jsonb, now(), now(), false),
                    (3, :i, 'missing entirely', true, '{"hasFile": false}'::jsonb, now(), now(), false),
                    (4, :i, 'eng but 720p', true, '{"hasFile": true}'::jsonb, now(), now(), false),
                    (5, :i, 'already 4k eng', true, '{"hasFile": true}'::jsonb, now(), now(), false),
                    (6, :i, 'unmonitored', false, '{"hasFile": false}'::jsonb, now(), now(), false)
                """
            ),
            {"i": instance},
        )
        conn.execute(
            text(
                """
                insert into warehouse.movie_file
                    (source_id, instance_name, movie_source_id, audio_languages, video_resolution,
                     payload, seen_at, last_seen_at, deleted)
                values
                    (101, :i, 1, array['japanese'], 1080, '{}'::jsonb, now(), now(), false),
                    (102, :i, 2, array['eng', 'jpn'], 1080, '{}'::jsonb, now(), now(), false),
                    (104, :i, 4, array['english'], 720, '{}'::jsonb, now(), now(), false),
                    (105, :i, 5, array['english'], 2160, '{}'::jsonb, now(), now(), false)
                """
            ),
            {"i": instance},
        )
    with engine.connect() as conn:
        rows = conn.execute(
            text(compiled.select_sql),
            {**compiled.binds, "instance_name": instance, "cooldown_days": 7, "limit": 50},
        ).mappings().all()
    got = {int(r["source_id"]) for r in rows}
    # 1 = has file but no english; 3 = missing; 4 = english but below floor.
    # 2 (dual audio ok) and 5 (4k, above floor) conform; 6 is unmonitored.
    assert got == {1, 3, 4}


def test_cooldown_ledger_excludes_recent(engine) -> None:
    from arrsync.services.automation_rules import compile_candidates, validate_params

    params = validate_params(
        "custom",
        {
            "scope": {"media": "movies", "monitored_only": True},
            "require": {"audio_language_any": ["english", "eng"]},
            "actions": [{"type": "search_missing"}],
        },
    )
    compiled = compile_candidates(params, "movie")
    instance = "itest-automations"
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                insert into app.automation_action_ledger
                    (instance_name, entity_type, source_id, action_type, last_fired_at)
                values (:i, 'movie', 3, 'search', now())
                on conflict (instance_name, entity_type, source_id, action_type)
                do update set last_fired_at = now()
                """
            ),
            {"i": instance},
        )
    with engine.connect() as conn:
        rows = conn.execute(
            text(compiled.select_sql),
            {**compiled.binds, "instance_name": instance, "cooldown_days": 7, "limit": 50},
        ).mappings().all()
    assert 3 not in {int(r["source_id"]) for r in rows}


def test_dub_gate_lateral_join_prevents_fanout(engine) -> None:
    """One movie linked from TWO mal_ids (MAL season-split) must appear once.

    A plain inner join on mal.warehouse_link + mal.anime would duplicate the
    candidate row and overcount both count_sql and count_all_sql because
    warehouse_link is unique on (mal_id, instance_name, arr_entity), not on
    warehouse_source_id.
    """
    from arrsync.services.automation_rules import compile_candidates, validate_params

    params = validate_params(
        "custom",
        {
            "scope": {"media": "movies", "monitored_only": True},
            "require": {},
            "actions": [{"type": "search_missing"}],
            "options": {"mal_dub_gate": True},
        },
    )
    compiled = compile_candidates(params, "movie")
    instance = "itest-automations-dubgate"
    with engine.begin() as conn:
        conn.execute(text("delete from mal.warehouse_link where instance_name = :i"), {"i": instance})
        conn.execute(text("delete from warehouse.movie_file where instance_name = :i"), {"i": instance})
        conn.execute(text("delete from warehouse.movie where instance_name = :i"), {"i": instance})
        conn.execute(text("delete from app.automation_action_ledger where instance_name = :i"), {"i": instance})
        conn.execute(text("delete from mal.anime where mal_id in (990001, 990002)"))
        conn.execute(
            text(
                """
                insert into warehouse.movie
                    (source_id, instance_name, title, monitored, payload, seen_at, last_seen_at, deleted)
                values (1, :i, 'split-season anime movie', true, '{"hasFile": false}'::jsonb, now(), now(), false)
                """
            ),
            {"i": instance},
        )
        conn.execute(
            text(
                """
                insert into mal.anime (mal_id, dub_status)
                values (990001, 'dubbed'), (990002, 'dubbed')
                """
            )
        )
        conn.execute(
            text(
                """
                insert into mal.warehouse_link
                    (mal_id, instance_name, arr_entity, warehouse_source_id, match_method, confidence)
                values
                    (990001, :i, 'radarr_movie', 1, 'manual', 'high'),
                    (990002, :i, 'radarr_movie', 1, 'manual', 'high')
                """
            ),
            {"i": instance},
        )
    binds = {**compiled.binds, "instance_name": instance, "cooldown_days": 7, "limit": 50}
    with engine.connect() as conn:
        rows = conn.execute(text(compiled.select_sql), binds).mappings().all()
        count = conn.execute(text(compiled.count_sql), binds).scalar()
    assert [int(r["source_id"]) for r in rows] == [1]
    assert count == 1


def test_episode_predicate_scopes_anime_series_and_airdate(engine) -> None:
    from arrsync.services.automation_rules import compile_candidates, validate_params

    params = validate_params(
        "custom",
        {
            "scope": {"media": "series", "anime_only": True, "monitored_only": True},
            "require": {"audio_language_any": ["english", "eng"], "resolution_min": 1080},
            "actions": [{"type": "search_missing"}, {"type": "search_upgrade"}],
        },
    )
    compiled = compile_candidates(params, "episode")
    instance = "itest-automations-episodes"
    with engine.begin() as conn:
        conn.execute(text("delete from warehouse.episode_file where instance_name = :i"), {"i": instance})
        conn.execute(text("delete from warehouse.episode where instance_name = :i"), {"i": instance})
        conn.execute(text("delete from warehouse.series where instance_name = :i"), {"i": instance})
        conn.execute(text("delete from app.automation_action_ledger where instance_name = :i"), {"i": instance})
        conn.execute(
            text(
                """
                insert into warehouse.series
                    (source_id, instance_name, title, monitored, payload, seen_at, last_seen_at, deleted)
                values (101, :i, 'Anime Series', true, '{"seriesType": "Anime"}'::jsonb, now(), now(), false)
                """
            ),
            {"i": instance},
        )
        conn.execute(
            text(
                """
                insert into warehouse.episode
                    (source_id, instance_name, series_source_id, season_number, episode_number,
                     title, monitored, air_date, payload, seen_at, last_seen_at, deleted)
                values
                    (201, :i, 101, 1, 1, 'non-english aired', true, now() - interval '10 days',
                     '{"hasFile": true}'::jsonb, now(), now(), false),
                    (202, :i, 101, 1, 2, 'english 1080p aired', true, now() - interval '5 days',
                     '{"hasFile": true}'::jsonb, now(), now(), false),
                    (203, :i, 101, 1, 3, 'future episode', true, now() + interval '10 days',
                     '{"hasFile": false}'::jsonb, now(), now(), false)
                """
            ),
            {"i": instance},
        )
        conn.execute(
            text(
                """
                insert into warehouse.episode_file
                    (source_id, instance_name, episode_source_id, audio_languages, video_resolution,
                     payload, seen_at, last_seen_at, deleted)
                values
                    (301, :i, 201, array['japanese'], 1080, '{}'::jsonb, now(), now(), false),
                    (302, :i, 202, array['english'], 1080, '{}'::jsonb, now(), now(), false)
                """
            ),
            {"i": instance},
        )
    with engine.connect() as conn:
        rows = conn.execute(
            text(compiled.select_sql),
            {**compiled.binds, "instance_name": instance, "cooldown_days": 7, "limit": 50},
        ).mappings().all()
    got = {int(r["source_id"]) for r in rows}
    # 201 = aired, non-english audio -> upgrade candidate.
    # 202 conforms (english, 1080p) so is excluded; 203 has not aired yet.
    assert got == {201}


def test_conforming_sense_returns_movies_that_already_meet_bar(engine) -> None:
    from arrsync.services.automation_rules import compile_candidates, validate_params

    params = validate_params(
        "custom",
        {
            "scope": {"media": "movies", "monitored_only": True},
            "require": {"resolution_min": 1080},
            "actions": [
                {"type": "search_upgrade"},
                {"type": "set_monitored", "value": False, "when": "conforming"},
            ],
        },
    )
    compiled = compile_candidates(params, "movie", sense="conforming")
    instance = "itest-automations-conforming"
    with engine.begin() as conn:
        conn.execute(text("delete from warehouse.movie_file where instance_name = :i"), {"i": instance})
        conn.execute(text("delete from warehouse.movie where instance_name = :i"), {"i": instance})
        conn.execute(
            text(
                """
                insert into warehouse.movie
                    (source_id, instance_name, title, monitored, payload, seen_at, last_seen_at, deleted)
                values
                    (1, :i, 'conforms 1080p', true, '{"hasFile": true}'::jsonb, now(), now(), false),
                    (2, :i, 'below floor 720p', true, '{"hasFile": true}'::jsonb, now(), now(), false),
                    (3, :i, 'missing', true, '{"hasFile": false}'::jsonb, now(), now(), false),
                    (4, :i, 'unmonitored conforms', false, '{"hasFile": true}'::jsonb, now(), now(), false)
                """
            ),
            {"i": instance},
        )
        conn.execute(
            text(
                """
                insert into warehouse.movie_file
                    (source_id, instance_name, movie_source_id, video_resolution, payload, seen_at, last_seen_at, deleted)
                values
                    (101, :i, 1, 1080, '{}'::jsonb, now(), now(), false),
                    (102, :i, 2, 720, '{}'::jsonb, now(), now(), false),
                    (104, :i, 4, 2160, '{}'::jsonb, now(), now(), false)
                """
            ),
            {"i": instance},
        )
    with engine.connect() as conn:
        rows = conn.execute(
            text(compiled.select_sql),
            {**compiled.binds, "instance_name": instance, "cooldown_days": 7, "limit": 50},
        ).mappings().all()
    got = {int(r["source_id"]) for r in rows}
    # 1 conforms at the floor; 2 is below it; 3 has no file; 4 conforms but is unmonitored.
    assert got == {1}


def test_root_folder_scope_respects_path_boundaries(engine) -> None:
    """Prefix matching must stop at a separator, and must not treat '_' as a wildcard."""
    from arrsync.services.automation_rules import compile_candidates, validate_params

    params = validate_params(
        "custom",
        {
            "scope": {
                "media": "movies",
                "monitored_only": True,
                # Trailing separator on one of them: normalization must make the
                # two forms behave identically.
                "root_folders_any": ["/media/movies/", "/media/my_movies"],
            },
            "require": {"resolution_min": 1080},
            "actions": [{"type": "search_missing"}],
        },
    )
    compiled = compile_candidates(params, "movie")
    instance = "itest-automations-folders"
    with engine.begin() as conn:
        conn.execute(text("delete from warehouse.movie where instance_name = :i"), {"i": instance})
        conn.execute(
            text(
                """
                insert into warehouse.movie
                    (source_id, instance_name, title, monitored, path, payload,
                     seen_at, last_seen_at, deleted)
                values
                    (1, :i, 'under folder', true, '/media/movies/Film (2020)',
                     '{"hasFile": false}'::jsonb, now(), now(), false),
                    (2, :i, 'prefix-adjacent folder', true, '/media/movies-4k/Film (2021)',
                     '{"hasFile": false}'::jsonb, now(), now(), false),
                    (3, :i, 'the folder itself', true, '/media/movies',
                     '{"hasFile": false}'::jsonb, now(), now(), false),
                    (4, :i, 'nested under second folder', true, '/media/my_movies/Box/Film (2022)',
                     '{"hasFile": false}'::jsonb, now(), now(), false),
                    (5, :i, 'underscore is not a wildcard', true, '/media/myXmovies/Film (2023)',
                     '{"hasFile": false}'::jsonb, now(), now(), false),
                    (6, :i, 'no path yet', true, null,
                     '{"hasFile": false}'::jsonb, now(), now(), false)
                """
            ),
            {"i": instance},
        )
    with engine.connect() as conn:
        rows = conn.execute(
            text(compiled.select_sql),
            {**compiled.binds, "instance_name": instance, "cooldown_days": 7, "limit": 50},
        ).mappings().all()
    got = {int(r["source_id"]) for r in rows}
    # 2 would leak in on a bare prefix compare, 5 on a LIKE with '_' unescaped,
    # 6 has no path at all.
    assert got == {1, 3, 4}


def test_count_sql_and_count_all_sql_reflect_ledger_cooldown(engine) -> None:
    from arrsync.services.automation_rules import compile_candidates, validate_params

    params = validate_params(
        "custom",
        {
            "scope": {"media": "movies", "monitored_only": True},
            "require": {"audio_language_any": ["english", "eng"]},
            "actions": [{"type": "search_missing"}],
        },
    )
    compiled = compile_candidates(params, "movie")
    instance = "itest-automations-counts"
    with engine.begin() as conn:
        conn.execute(text("delete from warehouse.movie_file where instance_name = :i"), {"i": instance})
        conn.execute(text("delete from warehouse.movie where instance_name = :i"), {"i": instance})
        conn.execute(text("delete from app.automation_action_ledger where instance_name = :i"), {"i": instance})
        conn.execute(
            text(
                """
                insert into warehouse.movie
                    (source_id, instance_name, title, monitored, payload, seen_at, last_seen_at, deleted)
                values
                    (1, :i, 'missing 1', true, '{"hasFile": false}'::jsonb, now(), now(), false),
                    (2, :i, 'missing 2', true, '{"hasFile": false}'::jsonb, now(), now(), false),
                    (3, :i, 'has file', true, '{"hasFile": true}'::jsonb, now(), now(), false)
                """
            ),
            {"i": instance},
        )
        conn.execute(
            text(
                """
                insert into warehouse.movie_file
                    (source_id, instance_name, movie_source_id, audio_languages, payload, seen_at, last_seen_at, deleted)
                values (301, :i, 3, array['english'], '{}'::jsonb, now(), now(), false)
                """
            ),
            {"i": instance},
        )

    binds = {**compiled.binds, "instance_name": instance, "cooldown_days": 7, "limit": 50}
    with engine.connect() as conn:
        count_all_before = conn.execute(text(compiled.count_all_sql), binds).scalar()
        count_before = conn.execute(text(compiled.count_sql), binds).scalar()
        rows_before = conn.execute(text(compiled.select_sql), binds).mappings().all()
    assert count_all_before == 2
    assert count_before == 2
    assert count_all_before == len(rows_before)

    with engine.begin() as conn:
        conn.execute(
            text(
                """
                insert into app.automation_action_ledger
                    (instance_name, entity_type, source_id, action_type, last_fired_at)
                values (:i, 'movie', 1, 'search', now())
                on conflict (instance_name, entity_type, source_id, action_type)
                do update set last_fired_at = now()
                """
            ),
            {"i": instance},
        )
    with engine.connect() as conn:
        count_all_after = conn.execute(text(compiled.count_all_sql), binds).scalar()
        count_after = conn.execute(text(compiled.count_sql), binds).scalar()
    assert count_all_after == 2
    assert count_after == 1
    assert count_after < count_all_after


def test_complete_series_anti_join_against_real_postgres(engine) -> None:
    """The series-completeness query, executed for real.

    Four shows that between them cover every way a show can fail to be finished —
    a below-floor file, a wrong-language file, a gap, and a gap that was papered
    over by unmonitoring the episode — plus one that is genuinely done. Only the
    last may come back, and it must come back as a SERIES id.
    """
    from arrsync.services.automation_rules import compile_candidates, validate_params

    params = validate_params(
        "complete-series-tagger",
        {
            "scope": {
                "media": "series",
                "series_status_any": ["ended"],
                "monitored_only": True,
                "include_specials": False,
                "include_unmonitored_episodes": True,
            },
            "require": {"audio_language_any": ["english", "eng"], "resolution_min": 1080},
            "actions": [{"type": "tag", "label": "ready-to-unmonitor", "when": "conforming"}],
        },
    )
    compiled = compile_candidates(params, "episode", sense="conforming")
    instance = "itest-automations-complete"
    with engine.begin() as conn:
        for table in ("episode_file", "episode", "series"):
            conn.execute(
                text(f"delete from warehouse.{table} where instance_name = :i"), {"i": instance}
            )
        conn.execute(
            text(
                """
                insert into warehouse.series
                    (source_id, instance_name, title, monitored, status, payload,
                     seen_at, last_seen_at, deleted)
                values
                    (701, :i, 'perfect and ended', true, 'ended', '{}'::jsonb, now(), now(), false),
                    (702, :i, 'one 720p episode', true, 'ended', '{}'::jsonb, now(), now(), false),
                    (703, :i, 'one japanese episode', true, 'ended', '{}'::jsonb, now(), now(), false),
                    (704, :i, 'missing an episode', true, 'ended', '{}'::jsonb, now(), now(), false),
                    (705, :i, 'gap hidden by unmonitoring', true, 'ended', '{}'::jsonb, now(), now(), false),
                    (706, :i, 'perfect but still running', true, 'continuing', '{}'::jsonb, now(), now(), false),
                    (707, :i, 'nothing aired yet', true, 'ended', '{}'::jsonb, now(), now(), false),
                    (708, :i, 'perfect but special missing', true, 'ended', '{}'::jsonb, now(), now(), false)
                """
            ),
            {"i": instance},
        )
        conn.execute(
            text(
                """
                insert into warehouse.episode
                    (source_id, instance_name, series_source_id, season_number, episode_number,
                     title, monitored, air_date, payload, seen_at, last_seen_at, deleted)
                values
                    (801, :i, 701, 1, 1, 'ok', true, now() - interval '30 days', '{"hasFile": true}'::jsonb, now(), now(), false),
                    (802, :i, 701, 1, 2, 'ok', true, now() - interval '20 days', '{"hasFile": true}'::jsonb, now(), now(), false),
                    (803, :i, 702, 1, 1, 'ok', true, now() - interval '30 days', '{"hasFile": true}'::jsonb, now(), now(), false),
                    (804, :i, 702, 1, 2, '720p', true, now() - interval '20 days', '{"hasFile": true}'::jsonb, now(), now(), false),
                    (805, :i, 703, 1, 1, 'japanese', true, now() - interval '30 days', '{"hasFile": true}'::jsonb, now(), now(), false),
                    (806, :i, 704, 1, 1, 'ok', true, now() - interval '30 days', '{"hasFile": true}'::jsonb, now(), now(), false),
                    (807, :i, 704, 1, 2, 'no file', true, now() - interval '20 days', '{"hasFile": false}'::jsonb, now(), now(), false),
                    (808, :i, 705, 1, 1, 'ok', true, now() - interval '30 days', '{"hasFile": true}'::jsonb, now(), now(), false),
                    (809, :i, 705, 1, 2, 'unmonitored gap', false, now() - interval '20 days', '{"hasFile": false}'::jsonb, now(), now(), false),
                    (810, :i, 706, 1, 1, 'ok', true, now() - interval '30 days', '{"hasFile": true}'::jsonb, now(), now(), false),
                    (811, :i, 707, 1, 1, 'unaired', true, now() + interval '30 days', '{"hasFile": false}'::jsonb, now(), now(), false),
                    (812, :i, 708, 1, 1, 'ok', true, now() - interval '30 days', '{"hasFile": true}'::jsonb, now(), now(), false),
                    (813, :i, 708, 0, 1, 'missing special', true, now() - interval '25 days', '{"hasFile": false}'::jsonb, now(), now(), false)
                """
            ),
            {"i": instance},
        )
        conn.execute(
            text(
                """
                insert into warehouse.episode_file
                    (source_id, instance_name, episode_source_id, audio_languages, video_resolution,
                     payload, seen_at, last_seen_at, deleted)
                values
                    (901, :i, 801, array['english'], 1080, '{}'::jsonb, now(), now(), false),
                    (902, :i, 802, array['eng'], 2160, '{}'::jsonb, now(), now(), false),
                    (903, :i, 803, array['english'], 1080, '{}'::jsonb, now(), now(), false),
                    (904, :i, 804, array['english'], 720, '{}'::jsonb, now(), now(), false),
                    (905, :i, 805, array['japanese'], 1080, '{}'::jsonb, now(), now(), false),
                    (906, :i, 806, array['english'], 1080, '{}'::jsonb, now(), now(), false),
                    (907, :i, 808, array['english'], 1080, '{}'::jsonb, now(), now(), false),
                    (908, :i, 810, array['english'], 1080, '{}'::jsonb, now(), now(), false),
                    (909, :i, 812, array['english'], 1080, '{}'::jsonb, now(), now(), false)
                """
            ),
            {"i": instance},
        )
    with engine.connect() as conn:
        rows = conn.execute(
            text(compiled.select_sql),
            {**compiled.binds, "instance_name": instance, "limit": 100},
        ).mappings().all()
        counted = conn.execute(
            text(compiled.count_sql), {**compiled.binds, "instance_name": instance}
        ).scalar_one()

    got = {int(r["source_id"]) for r in rows}
    # 701: every aired episode english + >=1080 -> complete.
    # 708: complete too — its only gap is a season-0 special, excluded by scope.
    # 702/703: one file misses the spec. 704: a gap. 705: a gap that was
    # unmonitored, which include_unmonitored_episodes refuses to forgive.
    # 706: not ended. 707: nothing aired, so "no episode fails" must not count.
    assert got == {701, 708}
    assert int(counted) == 2
    # Series rows, not episode rows: the executor tags these ids directly.
    by_id = {int(r["source_id"]): r for r in rows}
    assert by_id[701]["title"] == "perfect and ended"
    assert int(by_id[701]["episode_count"]) == 2
    assert by_id[701]["status"] == "ended"


def test_subtitle_require_runs_against_real_postgres(engine) -> None:
    """The subtitle clause, which has no equivalent in either Arr's own filters."""
    from arrsync.services.automation_rules import compile_candidates, validate_params

    params = validate_params(
        "foreign-subs-audit",
        {
            "scope": {"media": "movies", "monitored_only": True},
            "require": {
                "audio_language_any": ["korean", "kor"],
                "subtitle_language_any": ["eng", "english"],
            },
            "actions": [{"type": "tag", "label": "subs-missing"}],
        },
    )
    compiled = compile_candidates(params, "movie")
    instance = "itest-automations-subs"
    with engine.begin() as conn:
        for table in ("movie_file", "movie"):
            conn.execute(
                text(f"delete from warehouse.{table} where instance_name = :i"), {"i": instance}
            )
        conn.execute(
            text(
                """
                insert into warehouse.movie
                    (source_id, instance_name, title, monitored, payload, seen_at, last_seen_at, deleted)
                values
                    (601, :i, 'korean with eng subs', true, '{"hasFile": true}'::jsonb, now(), now(), false),
                    (602, :i, 'korean, no eng subs', true, '{"hasFile": true}'::jsonb, now(), now(), false),
                    (603, :i, 'korean, no subs at all', true, '{"hasFile": true}'::jsonb, now(), now(), false)
                """
            ),
            {"i": instance},
        )
        conn.execute(
            text(
                """
                insert into warehouse.movie_file
                    (source_id, instance_name, movie_source_id, audio_languages, subtitle_languages,
                     payload, seen_at, last_seen_at, deleted)
                values
                    (611, :i, 601, array['korean'], array['eng','spa'], '{}'::jsonb, now(), now(), false),
                    (612, :i, 602, array['kor'], array['spa'], '{}'::jsonb, now(), now(), false),
                    (613, :i, 603, array['korean'], array[]::text[], '{}'::jsonb, now(), now(), false)
                """
            ),
            {"i": instance},
        )
    with engine.connect() as conn:
        rows = conn.execute(
            text(compiled.select_sql),
            {**compiled.binds, "instance_name": instance, "limit": 50},
        ).mappings().all()
    # 601 has English subs and conforms; the other two are what needs fixing.
    assert {int(r["source_id"]) for r in rows} == {602, 603}


def test_0013_rederives_resolution_as_the_quality_tier(engine) -> None:
    """The 0013 re-derivation, executed for real.

    Each row below is a shape that appears in a real library, seeded with the wrong
    value 0012 would have produced (the frame height), and expected to come out as
    the tier. The migration has already run by the time this test does, so the SQL
    is invoked directly — which is also what proves it is idempotent.
    """
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "m0013", "alembic/versions/0013_resolution_quality_tier.py"
    )
    assert spec and spec.loader
    m0013 = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m0013)

    instance = "itest-resolution-tier"
    # (source_id, payload, seeded wrong value, expected tier, why)
    rows = [
        (
            9101,
            '{"quality": {"quality": {"name": "WEBRip-1080p", "resolution": 1080}},'
            ' "mediaInfo": {"resolution": "1920x960"}}',
            960,
            1080,
            "2:1 letterbox, the 1883 case",
        ),
        (
            9102,
            '{"quality": {"quality": {"name": "Bluray-1080p", "resolution": 1080}},'
            ' "mediaInfo": {"resolution": "1920x800"}}',
            800,
            1080,
            "2.39:1 scope letterbox",
        ),
        (
            9103,
            '{"quality": {"quality": {"name": "WEBDL-1080p"}},'
            ' "mediaInfo": {"resolution": "1920x816"}}',
            816,
            1080,
            "no tier number: the quality name carries it",
        ),
        (
            9104,
            '{"mediaInfo": {"resolution": "1920x872"}}',
            872,
            1080,
            "no quality metadata at all: width implies the tier",
        ),
        (
            9105,
            '{"quality": {"quality": {"name": "Bluray-2160p", "resolution": 2160}},'
            ' "mediaInfo": {"resolution": "3840x1600"}}',
            1600,
            2160,
            "letterboxed 4K",
        ),
        (
            9106,
            '{"quality": {"quality": {"name": "HDTV-720p", "resolution": 720}},'
            ' "mediaInfo": {"resolution": "1280x720"}}',
            720,
            720,
            "plain 16:9 720p is unchanged",
        ),
        (
            9107,
            '{"quality": {"quality": {"name": "WEBDL-1080p", "resolution": 99999}},'
            ' "mediaInfo": {"resolution": "1920x800"}}',
            800,
            1080,
            "nonsense tier number falls through to the name",
        ),
        (
            9108,
            '{"mediaInfo": {"resolution": "400x1080"}}',
            1080,
            1080,
            "too narrow to imply a tier: height is the last resort",
        ),
        (
            9109,
            '{"mediaInfo": {"resolution": "widescreen"}}',
            555,
            555,
            "nothing derivable: the existing value is kept, not nulled",
        ),
    ]
    with engine.begin() as conn:
        conn.execute(
            text("delete from warehouse.episode_file where instance_name = :i"), {"i": instance}
        )
        for source_id, payload, seeded, _expected, _why in rows:
            conn.execute(
                text(
                    """
                    insert into warehouse.episode_file
                        (source_id, instance_name, episode_source_id, video_resolution,
                         payload, seen_at, last_seen_at, deleted)
                    values (:sid, :i, 1, :res, cast(:payload as jsonb), now(), now(), false)
                    """
                ),
                {"sid": source_id, "i": instance, "res": seeded, "payload": payload},
            )
        conn.execute(text(m0013._rederive_sql("episode_file")))
        got = dict(
            conn.execute(
                text(
                    "select source_id, video_resolution from warehouse.episode_file"
                    " where instance_name = :i"
                ),
                {"i": instance},
            ).all()
        )

    for source_id, _payload, seeded, expected, why in rows:
        assert got[source_id] == expected, (
            f"source_id {source_id} ({why}): seeded {seeded}, expected {expected},"
            f" got {got[source_id]}"
        )

    # Idempotent: running it again must not move anything.
    with engine.begin() as conn:
        conn.execute(text(m0013._rederive_sql("episode_file")))
        again = dict(
            conn.execute(
                text(
                    "select source_id, video_resolution from warehouse.episode_file"
                    " where instance_name = :i"
                ),
                {"i": instance},
            ).all()
        )
    assert again == got

    with engine.begin() as conn:
        conn.execute(
            text("delete from warehouse.episode_file where instance_name = :i"), {"i": instance}
        )


def test_letterboxed_episode_no_longer_disqualifies_a_complete_series(engine) -> None:
    """End to end, on real Postgres: a finished show whose every episode is a
    letterboxed 1080p release must land in the completeness set.

    This is the regression that hid ~5,000 episodes in one library — the shape of
    the 1883 and 11.22.63 reports — so it is asserted against the compiled rule, not
    just against the extraction helper.
    """
    from arrsync.services.automation_rules import compile_candidates, validate_params

    params = validate_params(
        "complete-series-tagger",
        {
            "scope": {
                "media": "series",
                "series_status_any": ["ended"],
                "monitored_only": False,
                "include_specials": False,
                "include_unmonitored_episodes": True,
            },
            "require": {"audio_language_any": ["english", "eng"], "resolution_min": 1080},
            "actions": [{"type": "tag", "label": "ready", "when": "conforming"}],
        },
    )
    compiled = compile_candidates(params, "episode", sense="conforming")
    instance = "itest-letterbox-complete"
    with engine.begin() as conn:
        for table in ("episode_file", "episode", "series"):
            conn.execute(
                text(f"delete from warehouse.{table} where instance_name = :i"), {"i": instance}
            )
        conn.execute(
            text(
                """
                insert into warehouse.series
                    (source_id, instance_name, title, monitored, status, payload,
                     seen_at, last_seen_at, deleted)
                values
                    (7701, :i, 'letterboxed but complete', true, 'ended', '{}'::jsonb, now(), now(), false),
                    (7702, :i, 'genuinely below the floor', true, 'ended', '{}'::jsonb, now(), now(), false)
                """
            ),
            {"i": instance},
        )
        conn.execute(
            text(
                """
                insert into warehouse.episode
                    (source_id, instance_name, series_source_id, season_number, episode_number,
                     title, monitored, air_date, payload, seen_at, last_seen_at, deleted)
                values
                    (8801, :i, 7701, 1, 1, 'ep1', true, now() - interval '20 days', '{"hasFile": true}'::jsonb, now(), now(), false),
                    (8802, :i, 7701, 1, 2, 'ep2', true, now() - interval '10 days', '{"hasFile": true}'::jsonb, now(), now(), false),
                    (8803, :i, 7702, 1, 1, 'ep1', true, now() - interval '20 days', '{"hasFile": true}'::jsonb, now(), now(), false)
                """
            ),
            {"i": instance},
        )
        # 7701: both episodes are 1920x960 Bluray-1080p -> tier 1080 -> complete.
        # 7702: a real 720p file -> tier 720 -> correctly not complete.
        conn.execute(
            text(
                """
                insert into warehouse.episode_file
                    (source_id, instance_name, episode_source_id, audio_languages,
                     video_resolution, quality, payload, seen_at, last_seen_at, deleted)
                values
                    (9901, :i, 8801, array['english'], 1080, 'Bluray-1080p', '{}'::jsonb, now(), now(), false),
                    (9902, :i, 8802, array['eng'], 1080, 'Bluray-1080p', '{}'::jsonb, now(), now(), false),
                    (9903, :i, 8803, array['english'], 720, 'HDTV-720p', '{}'::jsonb, now(), now(), false)
                """
            ),
            {"i": instance},
        )
    with engine.connect() as conn:
        rows = conn.execute(
            text(compiled.select_sql),
            {**compiled.binds, "instance_name": instance, "limit": 50},
        ).mappings().all()
    got = {int(r["source_id"]) for r in rows}
    assert got == {7701}, "the letterboxed-but-complete show must be in the conforming set"

    with engine.begin() as conn:
        for table in ("episode_file", "episode", "series"):
            conn.execute(
                text(f"delete from warehouse.{table} where instance_name = :i"), {"i": instance}
            )
