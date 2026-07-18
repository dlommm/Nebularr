"""reporting correctness: view semantics + hot-path indexes

Revision ID: 0011_reporting_correctness
Revises: 0010_perf_indexes_queue_hygiene
Create Date: 2026-07-18

Rebuilds two reporting views so their numbers match the detailed table panels
that sit beside them, and adds the two indexes the reporting/ops dashboards scan:

* ``v_episodes_missing_english_audio`` now coalesces ``audio_languages`` to an
  empty array, so an episode file with NULL audio languages counts as "missing
  English" — matching the detailed table panel (which already coalesces). Before
  this, ``not ('english' = any(NULL))`` evaluated to NULL and silently dropped
  those files from the stat, so the headline number undercounted the table.
* ``v_large_files`` now carries ``series_source_id`` (and keeps ``instance_name``)
  so the media-deep-dive "Detailed: Large Files" panel can join back to
  ``warehouse.series`` on the id instead of on ``series_title`` (title joins are
  wrong whenever two series share a title, and match nothing for movie rows).
"""

from collections.abc import Sequence
from typing import Union

from alembic import op

revision: str = "0011_reporting_correctness"
down_revision: Union[str, None] = "0010_perf_indexes_queue_hygiene"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# --- new (0011) view definitions ------------------------------------------------

def _create_missing_english_view_coalesced() -> None:
    op.execute(
        """
        create or replace view warehouse.v_episodes_missing_english_audio as
        select *
        from warehouse.v_episode_files
        where not (
            'english' = any(coalesce(audio_languages, array[]::text[]))
            or 'eng' = any(coalesce(audio_languages, array[]::text[]))
        )
        """
    )


def _create_large_files_view_with_series_source_id() -> None:
    # Episode side is expanded from base tables (v_episode_files does not expose
    # series_source_id); every other column mirrors v_episode_files exactly so
    # existing consumers keep working. Movie rows have no series, hence NULL.
    op.execute(
        """
        create or replace view warehouse.v_large_files as
        select
            e.instance_name,
            e.series_source_id,
            s.title as series_title,
            e.season_number,
            e.episode_number,
            e.title as episode_title,
            e.air_date,
            ef.path,
            ef.size_bytes,
            ef.quality,
            ef.audio_languages,
            ef.subtitle_languages,
            ef.audio_codec,
            ef.audio_channels,
            ef.video_codec,
            ef.deleted
        from warehouse.episode_file ef
        join warehouse.episode e
          on e.source_id = ef.episode_source_id and e.instance_name = ef.instance_name
        join warehouse.series s
          on s.source_id = e.series_source_id and s.instance_name = e.instance_name
        where not ef.deleted and not e.deleted and not s.deleted
          and ef.size_bytes is not null and ef.size_bytes > 3221225472::bigint
        union all
        select
            instance_name,
            null::bigint as series_source_id,
            movie_title as series_title,
            null::int as season_number,
            null::int as episode_number,
            movie_title as episode_title,
            null::timestamptz as air_date,
            path,
            size_bytes,
            quality,
            audio_languages,
            subtitle_languages,
            audio_codec,
            audio_channels,
            video_codec,
            deleted
        from warehouse.v_movie_files
        where size_bytes is not null and size_bytes > 3221225472::bigint
        """
    )


# --- prior (pre-0011) view definitions, copied verbatim for downgrade ------------

def _restore_missing_english_view_0001() -> None:
    # Verbatim from 0001_initial.py.
    op.execute(
        """
        create or replace view warehouse.v_episodes_missing_english_audio as
        select *
        from warehouse.v_episode_files
        where not ('english' = any(audio_languages) or 'eng' = any(audio_languages))
        """
    )


def _restore_large_files_view_0003() -> None:
    # Verbatim from 0003_fix_large_files_threshold.py.
    op.execute(
        """
        create or replace view warehouse.v_large_files as
        select *
        from warehouse.v_episode_files
        where size_bytes is not null and size_bytes > 3221225472::bigint
        union all
        select
            instance_name,
            movie_title as series_title,
            null::int as season_number,
            null::int as episode_number,
            movie_title as episode_title,
            null::timestamptz as air_date,
            path,
            size_bytes,
            quality,
            audio_languages,
            subtitle_languages,
            audio_codec,
            audio_channels,
            video_codec,
            deleted
        from warehouse.v_movie_files
        where size_bytes is not null and size_bytes > 3221225472::bigint
        """
    )


def upgrade() -> None:
    # v_large_files column set changes (adds series_source_id), so drop before
    # recreate: create-or-replace cannot alter an existing view's column list.
    op.execute("drop view if exists warehouse.v_large_files")
    _create_large_files_view_with_series_source_id()
    _create_missing_english_view_coalesced()

    op.execute(
        "create index if not exists ix_sync_run_started_at"
        " on warehouse.sync_run (started_at desc)"
    )
    op.execute(
        "create index if not exists ix_webhook_queue_received_at_id"
        " on app.webhook_queue (received_at desc, id desc)"
    )


def downgrade() -> None:
    op.execute("drop index if exists app.ix_webhook_queue_received_at_id")
    op.execute("drop index if exists warehouse.ix_sync_run_started_at")

    op.execute("drop view if exists warehouse.v_large_files")
    _restore_large_files_view_0003()
    _restore_missing_english_view_0001()
