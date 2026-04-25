"""mal schema: anime, dub list, warehouse links, job runs

Revision ID: 0004_mal_schema
Revises: 0003_fix_large_files_threshold
Create Date: 2026-04-24
"""

from collections.abc import Sequence
from typing import Union

from alembic import op

revision: str = "0004_mal_schema"
down_revision: Union[str, None] = "0003_fix_large_files_threshold"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("create schema if not exists mal")

    op.execute(
        """
        create table if not exists mal.anime (
            mal_id int primary key,
            is_english_dubbed boolean not null default false,
            dub_list_seen_at timestamptz,
            dub_list_last_present_at timestamptz,
            mal_fetch_status text not null default 'pending'
                check (mal_fetch_status in ('pending', 'success', 'error', 'not_found')),
            mal_last_error text,
            mal_fetched_at timestamptz,
            jikan_fetched_at timestamptz,
            mal_response jsonb not null default '{}'::jsonb,
            jikan_response jsonb,
            main_title text,
            media_type text,
            status text,
            start_date text,
            num_episodes int,
            nsfw boolean,
            mean_score double precision
        )
        """
    )
    op.execute("create index if not exists idx_mal_anime_dubbed on mal.anime(is_english_dubbed) where is_english_dubbed = true")

    op.execute(
        """
        create table if not exists mal.dub_list_fetch (
            id bigserial primary key,
            fetched_at timestamptz not null default now(),
            source_url text not null,
            content_sha256 text not null,
            id_count int not null default 0,
            raw jsonb,
            http_status int,
            error_message text
        )
        """
    )

    op.execute(
        """
        create table if not exists mal.dub_list_snapshot_item (
            dub_list_fetch_id bigint not null references mal.dub_list_fetch(id) on delete cascade,
            mal_id int not null,
            primary key (dub_list_fetch_id, mal_id)
        )
        """
    )
    op.execute(
        "create index if not exists idx_dub_snapshot_mal on mal.dub_list_snapshot_item(mal_id)"
    )

    op.execute(
        """
        create table if not exists mal.anime_external_id (
            id bigserial primary key,
            mal_id int not null references mal.anime(mal_id) on delete cascade,
            site text not null,
            external_id text not null,
            source text not null check (source in ('mal_api', 'jikan', 'manual')),
            updated_at timestamptz not null default now(),
            unique (mal_id, site)
        )
        """
    )
    op.execute(
        "create index if not exists idx_mal_external_lookup on mal.anime_external_id(site, external_id)"
    )

    op.execute(
        """
        create table if not exists mal.warehouse_link (
            id bigserial primary key,
            mal_id int not null references mal.anime(mal_id) on delete cascade,
            instance_name text not null default 'default',
            arr_entity text not null check (arr_entity in ('sonarr_series', 'radarr_movie')),
            warehouse_source_id bigint not null,
            match_method text not null
                check (match_method in ('tvdb', 'tmdb', 'imdb', 'title_year', 'manual')),
            confidence text not null check (confidence in ('high', 'medium', 'low')),
            match_detail jsonb not null default '{}'::jsonb,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            last_verified_at timestamptz,
            unique (mal_id, instance_name, arr_entity)
        )
        """
    )
    op.execute(
        "create index if not exists idx_mal_wh_link_instance on mal.warehouse_link(instance_name, warehouse_source_id)"
    )
    op.execute("create index if not exists idx_mal_wh_link_mal on mal.warehouse_link(mal_id)")

    op.execute(
        """
        create table if not exists mal.ingest_checkpoint (
            job_name text primary key,
            cursor text,
            run_metadata jsonb not null default '{}'::jsonb,
            updated_at timestamptz not null default now()
        )
        """
    )

    op.execute(
        """
        create table if not exists mal.manual_link (
            mal_id int not null references mal.anime(mal_id) on delete cascade,
            instance_name text not null default 'default',
            arr_entity text not null check (arr_entity in ('sonarr_series', 'radarr_movie')),
            warehouse_source_id bigint not null,
            note text,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now(),
            primary key (mal_id, instance_name, arr_entity)
        )
        """
    )

    op.execute(
        """
        create table if not exists mal.tag_apply_state (
            instance_name text not null default 'default',
            arr_entity text not null check (arr_entity in ('sonarr_series', 'radarr_movie')),
            warehouse_source_id bigint not null,
            tag_label text not null,
            last_applied_at timestamptz not null default now(),
            last_desired_tagged boolean not null,
            payload_hash text,
            primary key (instance_name, arr_entity, warehouse_source_id, tag_label)
        )
        """
    )

    op.execute(
        """
        create table if not exists mal.anime_fetch_queue (
            mal_id int not null references mal.anime(mal_id) on delete cascade,
            kind text not null check (kind in ('mal', 'jikan')),
            next_attempt_at timestamptz not null default now(),
            attempts int not null default 0,
            last_error text,
            primary key (mal_id, kind)
        )
        """
    )

    op.execute(
        """
        create table if not exists app.mal_job_run (
            id bigserial primary key,
            job_type text not null check (job_type in ('ingest', 'matcher', 'tag_sync')),
            status text not null check (status in ('running', 'success', 'failed')),
            started_at timestamptz not null default now(),
            finished_at timestamptz,
            details jsonb not null default '{}'::jsonb,
            error_message text
        )
        """
    )
    op.execute(
        "create index if not exists idx_mal_job_run_type_started on app.mal_job_run(job_type, started_at desc)"
    )

    op.execute(
        """
        create or replace view mal.v_dubbed_anime_linked as
        select
            a.mal_id,
            a.is_english_dubbed,
            a.main_title,
            a.media_type,
            l.instance_name,
            l.arr_entity,
            l.warehouse_source_id,
            l.match_method,
            l.confidence,
            l.last_verified_at
        from mal.anime a
        join mal.warehouse_link l on l.mal_id = a.mal_id
        where a.is_english_dubbed = true
        """
    )

    op.execute("grant usage on schema mal to arrapp")
    op.execute("grant all privileges on all tables in schema mal to arrapp")
    op.execute("grant all privileges on all sequences in schema mal to arrapp")
    op.execute("grant all privileges on app.mal_job_run to arrapp")
    op.execute("grant all privileges on sequence app.mal_job_run_id_seq to arrapp")


def downgrade() -> None:
    op.execute("drop view if exists mal.v_dubbed_anime_linked")
    op.execute("drop table if exists app.mal_job_run")
    op.execute("drop table if exists mal.anime_fetch_queue")
    op.execute("drop table if exists mal.tag_apply_state")
    op.execute("drop table if exists mal.manual_link")
    op.execute("drop table if exists mal.ingest_checkpoint")
    op.execute("drop table if exists mal.warehouse_link")
    op.execute("drop table if exists mal.anime_external_id")
    op.execute("drop table if exists mal.dub_list_snapshot_item")
    op.execute("drop table if exists mal.dub_list_fetch")
    op.execute("drop table if exists mal.anime")
    op.execute("drop schema if exists mal cascade")
