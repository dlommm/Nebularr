"""initial schemas app and warehouse

Revision ID: 0001_initial
Revises:
Create Date: 2026-04-23
"""

from collections.abc import Sequence
from typing import Union

from alembic import op

revision: str = "0001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("create schema if not exists app")
    op.execute("create schema if not exists warehouse")

    op.execute(
        """
        create table if not exists app.integration_instance (
            id bigserial primary key,
            source text not null check (source in ('sonarr', 'radarr')),
            name text not null,
            base_url text not null,
            api_key text not null default '',
            enabled boolean not null default true,
            webhook_enabled boolean not null default true,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            unique (source, name)
        )
        """
    )
    op.execute(
        """
        create table if not exists app.sync_schedule (
            id bigserial primary key,
            mode text not null check (mode in ('full', 'incremental', 'reconcile')),
            cron text not null,
            timezone text not null default 'UTC',
            enabled boolean not null default true,
            updated_at timestamptz not null default now(),
            unique (mode)
        )
        """
    )
    op.execute(
        """
        create table if not exists app.sync_state (
            id bigserial primary key,
            source text not null check (source in ('sonarr', 'radarr')),
            last_history_time timestamptz,
            last_history_id bigint,
            last_successful_full_sync timestamptz,
            last_successful_incremental timestamptz,
            capabilities jsonb not null default '{}'::jsonb,
            updated_at timestamptz not null default now(),
            unique (source)
        )
        """
    )
    op.execute(
        """
        create table if not exists app.webhook_queue (
            id bigserial primary key,
            source text not null check (source in ('sonarr', 'radarr')),
            event_type text not null default 'unknown',
            dedupe_key text,
            payload jsonb not null,
            status text not null default 'queued' check (status in ('queued', 'retrying', 'done', 'dead_letter')),
            attempts int not null default 0,
            next_attempt_at timestamptz not null default now(),
            error_message text,
            received_at timestamptz not null default now(),
            processed_at timestamptz
        )
        """
    )
    op.execute("create index if not exists idx_webhook_queue_status_next on app.webhook_queue(status, next_attempt_at)")
    op.execute("create unique index if not exists uq_webhook_queue_dedupe on app.webhook_queue(dedupe_key) where dedupe_key is not null")

    op.execute(
        """
        create table if not exists app.job_run_summary (
            id bigserial primary key,
            source text not null check (source in ('sonarr', 'radarr')),
            mode text not null check (mode in ('full', 'incremental', 'reconcile', 'webhook')),
            status text not null check (status in ('running', 'success', 'failed', 'skipped')),
            started_at timestamptz not null default now(),
            finished_at timestamptz,
            rows_written bigint not null default 0,
            details jsonb not null default '{}'::jsonb,
            error_message text
        )
        """
    )
    op.execute("create index if not exists idx_job_run_source_mode_started on app.job_run_summary(source, mode, started_at desc)")

    op.execute(
        """
        create table if not exists app.settings (
            id bigserial primary key,
            key text not null unique,
            value text not null,
            updated_at timestamptz not null default now()
        )
        """
    )

    op.execute(
        """
        create table if not exists warehouse.sync_run (
            id bigserial primary key,
            source text not null check (source in ('sonarr', 'radarr')),
            mode text not null check (mode in ('full', 'incremental', 'reconcile', 'webhook')),
            status text not null check (status in ('running', 'success', 'failed')),
            started_at timestamptz not null default now(),
            finished_at timestamptz,
            records_processed bigint not null default 0,
            details jsonb not null default '{}'::jsonb,
            error_message text
        )
        """
    )

    op.execute(
        """
        create table if not exists warehouse.series (
            source_id bigint not null,
            instance_name text not null default 'default',
            title text not null,
            monitored boolean not null default true,
            path text,
            genres jsonb not null default '[]'::jsonb,
            status text,
            payload jsonb not null default '{}'::jsonb,
            sync_source text not null default 'full',
            sync_run_id bigint references warehouse.sync_run(id) on delete set null,
            seen_at timestamptz not null default now(),
            last_seen_at timestamptz not null default now(),
            deleted boolean not null default false,
            primary key (source_id, instance_name)
        )
        """
    )
    op.execute("create index if not exists idx_series_title on warehouse.series(title)")
    op.execute("create index if not exists idx_series_deleted on warehouse.series(deleted)")

    op.execute(
        """
        create table if not exists warehouse.episode (
            source_id bigint not null,
            instance_name text not null default 'default',
            series_source_id bigint not null,
            season_number int not null,
            episode_number int not null,
            title text not null default '',
            air_date timestamptz,
            runtime_minutes int,
            monitored boolean not null default true,
            payload jsonb not null default '{}'::jsonb,
            sync_source text not null default 'full',
            sync_run_id bigint references warehouse.sync_run(id) on delete set null,
            seen_at timestamptz not null default now(),
            last_seen_at timestamptz not null default now(),
            deleted boolean not null default false,
            primary key (source_id, instance_name)
        )
        """
    )
    op.execute("create index if not exists idx_episode_series on warehouse.episode(series_source_id, instance_name)")

    op.execute(
        """
        create table if not exists warehouse.episode_file (
            source_id bigint not null,
            instance_name text not null default 'default',
            episode_source_id bigint not null,
            path text,
            size_bytes bigint,
            quality text,
            audio_languages text[] not null default '{}',
            subtitle_languages text[] not null default '{}',
            audio_codec text,
            audio_channels text,
            video_codec text,
            payload jsonb not null default '{}'::jsonb,
            sync_source text not null default 'full',
            sync_run_id bigint references warehouse.sync_run(id) on delete set null,
            seen_at timestamptz not null default now(),
            last_seen_at timestamptz not null default now(),
            deleted boolean not null default false,
            primary key (source_id, instance_name)
        )
        """
    )
    op.execute("create index if not exists idx_episode_file_size on warehouse.episode_file(size_bytes)")
    op.execute("create index if not exists idx_episode_file_quality on warehouse.episode_file(quality)")

    op.execute(
        """
        create table if not exists warehouse.movie (
            source_id bigint not null,
            instance_name text not null default 'default',
            title text not null,
            year int,
            monitored boolean not null default true,
            path text,
            status text,
            payload jsonb not null default '{}'::jsonb,
            sync_source text not null default 'full',
            sync_run_id bigint references warehouse.sync_run(id) on delete set null,
            seen_at timestamptz not null default now(),
            last_seen_at timestamptz not null default now(),
            deleted boolean not null default false,
            primary key (source_id, instance_name)
        )
        """
    )

    op.execute(
        """
        create table if not exists warehouse.movie_file (
            source_id bigint not null,
            instance_name text not null default 'default',
            movie_source_id bigint not null,
            path text,
            size_bytes bigint,
            quality text,
            audio_languages text[] not null default '{}',
            subtitle_languages text[] not null default '{}',
            audio_codec text,
            audio_channels text,
            video_codec text,
            payload jsonb not null default '{}'::jsonb,
            sync_source text not null default 'full',
            sync_run_id bigint references warehouse.sync_run(id) on delete set null,
            seen_at timestamptz not null default now(),
            last_seen_at timestamptz not null default now(),
            deleted boolean not null default false,
            primary key (source_id, instance_name)
        )
        """
    )
    op.execute("create index if not exists idx_movie_file_size on warehouse.movie_file(size_bytes)")
    op.execute("create index if not exists idx_movie_file_quality on warehouse.movie_file(quality)")

    op.execute(
        """
        create or replace view warehouse.v_episode_files as
        select
            e.instance_name,
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
        join warehouse.episode e on e.source_id = ef.episode_source_id and e.instance_name = ef.instance_name
        join warehouse.series s on s.source_id = e.series_source_id and s.instance_name = e.instance_name
        where not ef.deleted and not e.deleted and not s.deleted
        """
    )
    op.execute(
        """
        create or replace view warehouse.v_movie_files as
        select
            m.instance_name,
            m.title as movie_title,
            m.year,
            mf.path,
            mf.size_bytes,
            mf.quality,
            mf.audio_languages,
            mf.subtitle_languages,
            mf.audio_codec,
            mf.audio_channels,
            mf.video_codec,
            mf.deleted
        from warehouse.movie_file mf
        join warehouse.movie m on m.source_id = mf.movie_source_id and m.instance_name = mf.instance_name
        where not mf.deleted and not m.deleted
        """
    )
    op.execute(
        """
        create or replace view warehouse.v_episodes_missing_english_audio as
        select *
        from warehouse.v_episode_files
        where not ('english' = any(audio_languages) or 'eng' = any(audio_languages))
        """
    )
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

    op.execute("grant usage on schema app to arrapp")
    op.execute("grant usage on schema warehouse to arrapp")
    op.execute("grant all privileges on all tables in schema app to arrapp")
    op.execute("grant all privileges on all tables in schema warehouse to arrapp")
    op.execute("grant all privileges on all sequences in schema app to arrapp")
    op.execute("grant all privileges on all sequences in schema warehouse to arrapp")


def downgrade() -> None:
    op.execute("drop view if exists warehouse.v_large_files")
    op.execute("drop view if exists warehouse.v_episodes_missing_english_audio")
    op.execute("drop view if exists warehouse.v_movie_files")
    op.execute("drop view if exists warehouse.v_episode_files")
    op.execute("drop table if exists warehouse.movie_file")
    op.execute("drop table if exists warehouse.movie")
    op.execute("drop table if exists warehouse.episode_file")
    op.execute("drop table if exists warehouse.episode")
    op.execute("drop table if exists warehouse.series")
    op.execute("drop table if exists warehouse.sync_run")
    op.execute("drop table if exists app.settings")
    op.execute("drop table if exists app.job_run_summary")
    op.execute("drop table if exists app.webhook_queue")
    op.execute("drop table if exists app.sync_state")
    op.execute("drop table if exists app.sync_schedule")
    op.execute("drop table if exists app.integration_instance")
