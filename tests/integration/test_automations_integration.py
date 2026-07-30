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
