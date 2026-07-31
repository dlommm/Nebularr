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
