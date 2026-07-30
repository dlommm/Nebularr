"""Real-Postgres checks for the automations schema and predicate compiler."""

from __future__ import annotations

import os

import pytest
import sqlalchemy
from sqlalchemy import text

DATABASE_URL = os.getenv("NEBULARR_TEST_DATABASE_URL", "")

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not DATABASE_URL, reason="NEBULARR_TEST_DATABASE_URL not set"),
]


@pytest.fixture()
def engine():
    eng = sqlalchemy.create_engine(DATABASE_URL)
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
