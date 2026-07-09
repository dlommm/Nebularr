"""Multi-source dub lists + per-series English audio coverage views

Revision ID: 0009_dub_sources_coverage
Revises: 0008_integrity_audit
Create Date: 2026-07-08
"""

from collections.abc import Sequence
from typing import Union

from alembic import op

revision: str = "0009_dub_sources_coverage"
down_revision: Union[str, None] = "0008_integrity_audit"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Per-source dub-list membership: one row per (anime, source) so the union
    # and per-anime source agreement stay queryable.
    op.execute(
        """
        create table if not exists mal.anime_dub_source (
            mal_id int not null references mal.anime(mal_id) on delete cascade,
            source text not null check (source in ('mal_dubs', 'mydublist')),
            status text not null check (status in ('dubbed', 'partial')),
            first_seen_at timestamptz not null default now(),
            last_seen_at timestamptz not null default now(),
            last_fetch_id bigint references mal.dub_list_fetch(id) on delete set null,
            primary key (mal_id, source)
        )
        """
    )
    op.execute(
        "create index if not exists idx_anime_dub_source_source on mal.anime_dub_source(source)"
    )

    op.execute(
        "alter table mal.dub_list_fetch add column if not exists source_name text not null default 'mal_dubs'"
    )
    op.execute(
        "create index if not exists idx_dub_list_fetch_source on mal.dub_list_fetch(source_name, id desc)"
    )
    op.execute(
        "alter table mal.dub_list_snapshot_item add column if not exists status text not null default 'dubbed'"
    )

    op.execute(
        """
        alter table mal.anime
        add column if not exists dub_status text not null default 'none'
            check (dub_status in ('none', 'partial', 'dubbed'))
        """
    )
    op.execute(
        "alter table mal.anime add column if not exists dub_source_count int not null default 0"
    )

    # Seed per-source rows from the current single-source state so the first
    # multi-source ingest reconciles instead of starting from an empty union.
    op.execute(
        """
        insert into mal.anime_dub_source (mal_id, source, status)
        select mal_id, 'mal_dubs', 'dubbed'
        from mal.anime
        where is_english_dubbed = true
        on conflict (mal_id, source) do nothing
        """
    )
    op.execute(
        """
        update mal.anime
        set dub_status = 'dubbed', dub_source_count = 1
        where is_english_dubbed = true
        """
    )

    op.execute("alter table app.mal_job_run drop constraint if exists mal_job_run_job_type_check")
    op.execute(
        """
        alter table app.mal_job_run add constraint mal_job_run_job_type_check
        check (job_type in ('ingest', 'matcher', 'tag_sync', 'coverage_tag_sync'))
        """
    )

    op.execute("alter table app.sync_schedule drop constraint if exists sync_schedule_mode_check")
    op.execute(
        """
        alter table app.sync_schedule add constraint sync_schedule_mode_check
        check (
            mode in (
                'full',
                'incremental',
                'reconcile',
                'stats_snapshot',
                'integrity_audit',
                'mal_ingest',
                'mal_matcher',
                'mal_tag_sync',
                'coverage_tag_sync'
            )
        )
        """
    )
    op.execute(
        """
        insert into app.sync_schedule (mode, cron, timezone, enabled, updated_at)
        values ('coverage_tag_sync', '30 4 * * *', 'UTC', true, now())
        on conflict (mode) do nothing
        """
    )

    # Per-series English audio coverage over monitored, already-aired episodes.
    # An episode with a file whose audio_languages lacks english/eng (including
    # an empty array or a missing episode_file row) counts as non-English,
    # matching warehouse.v_episodes_missing_english_audio semantics.
    op.execute(
        """
        create or replace view warehouse.v_anime_series_english_coverage as
        with ep as (
            select
                e.instance_name,
                e.series_source_id,
                e.source_id,
                coalesce((e.payload->>'hasFile')::boolean, false) as has_file,
                bool_or(
                    'english' = any(coalesce(ef.audio_languages, array[]::text[]))
                    or 'eng' = any(coalesce(ef.audio_languages, array[]::text[]))
                ) as has_english_audio
            from warehouse.episode e
            left join warehouse.episode_file ef
              on ef.episode_source_id = e.source_id
             and ef.instance_name = e.instance_name
             and not ef.deleted
            where not e.deleted
              and e.monitored
              and e.air_date is not null
              and e.air_date <= now()
            group by 1, 2, 3, 4
        )
        select
            s.instance_name,
            s.source_id,
            s.title,
            s.monitored,
            count(ep.source_id)::int as aired_monitored_episodes,
            (count(*) filter (where ep.has_file))::int as downloaded_episodes,
            (count(*) filter (where ep.has_file and coalesce(ep.has_english_audio, false)))::int
                as english_episodes,
            (count(*) filter (where ep.has_file and not coalesce(ep.has_english_audio, false)))::int
                as non_english_episodes,
            case
                when count(*) filter (where ep.has_file and not coalesce(ep.has_english_audio, false)) >= 1
                    then 'partial'
                when count(ep.source_id) > 0
                 and count(*) filter (where ep.has_file) = count(ep.source_id)
                    then 'full'
                else 'none'
            end as coverage_status
        from warehouse.series s
        left join ep
          on ep.instance_name = s.instance_name
         and ep.series_source_id = s.source_id
        where not s.deleted
          and lower(coalesce(s.payload->>'seriesType', '')) = 'anime'
        group by 1, 2, 3, 4
        """
    )

    # Anime scope for Radarr: MAL-linked movies (definitionally anime) plus a
    # case-insensitive 'anime' genre match. 'Animation' is deliberately not
    # matched to keep western animation out.
    op.execute(
        """
        create or replace view warehouse.v_anime_movie_english_coverage as
        select
            m.instance_name,
            m.source_id,
            m.title,
            coalesce((m.payload->>'hasFile')::boolean, false) as has_file,
            bool_or(
                'english' = any(coalesce(mf.audio_languages, array[]::text[]))
                or 'eng' = any(coalesce(mf.audio_languages, array[]::text[]))
            ) as has_english_audio,
            case
                when not coalesce((m.payload->>'hasFile')::boolean, false) then 'none'
                when coalesce(
                    bool_or(
                        'english' = any(coalesce(mf.audio_languages, array[]::text[]))
                        or 'eng' = any(coalesce(mf.audio_languages, array[]::text[]))
                    ),
                    false
                ) then 'full'
                else 'partial'
            end as coverage_status
        from warehouse.movie m
        left join warehouse.movie_file mf
          on mf.movie_source_id = m.source_id
         and mf.instance_name = m.instance_name
         and not mf.deleted
        where not m.deleted
          and (
            exists (
                select 1 from mal.warehouse_link l
                where l.arr_entity = 'radarr_movie'
                  and l.instance_name = m.instance_name
                  and l.warehouse_source_id = m.source_id
            )
            or exists (
                select 1 from jsonb_array_elements_text(
                    coalesce(m.payload->'genres', '[]'::jsonb)
                ) as g(genre)
                where lower(g.genre) = 'anime'
            )
          )
        group by 1, 2, 3, 4
        """
    )

    op.execute(
        """
        do $arrapp_dub_coverage_grants$
        begin
          if exists (select 1 from pg_roles where rolname = 'arrapp') then
            execute 'grant all privileges on mal.anime_dub_source to arrapp';
            execute 'grant select on warehouse.v_anime_series_english_coverage to arrapp';
            execute 'grant select on warehouse.v_anime_movie_english_coverage to arrapp';
          end if;
        end
        $arrapp_dub_coverage_grants$;
        """
    )


def downgrade() -> None:
    op.execute("drop view if exists warehouse.v_anime_movie_english_coverage")
    op.execute("drop view if exists warehouse.v_anime_series_english_coverage")
    op.execute("drop table if exists mal.anime_dub_source")
    op.execute("alter table mal.anime drop column if exists dub_source_count")
    op.execute("alter table mal.anime drop column if exists dub_status")
    op.execute("alter table mal.dub_list_snapshot_item drop column if exists status")
    op.execute("drop index if exists mal.idx_dub_list_fetch_source")
    op.execute("alter table mal.dub_list_fetch drop column if exists source_name")
    op.execute("delete from app.sync_schedule where mode = 'coverage_tag_sync'")
    op.execute("alter table app.sync_schedule drop constraint if exists sync_schedule_mode_check")
    op.execute(
        """
        alter table app.sync_schedule add constraint sync_schedule_mode_check
        check (
            mode in (
                'full',
                'incremental',
                'reconcile',
                'stats_snapshot',
                'integrity_audit',
                'mal_ingest',
                'mal_matcher',
                'mal_tag_sync'
            )
        )
        """
    )
    op.execute("delete from app.mal_job_run where job_type = 'coverage_tag_sync'")
    op.execute("alter table app.mal_job_run drop constraint if exists mal_job_run_job_type_check")
    op.execute(
        """
        alter table app.mal_job_run add constraint mal_job_run_job_type_check
        check (job_type in ('ingest', 'matcher', 'tag_sync'))
        """
    )
