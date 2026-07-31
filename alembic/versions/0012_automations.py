"""automations engine: rule instances, run history, action ledger, resolution columns

Revision ID: 0012_automations
Revises: 0011_reporting_correctness
Create Date: 2026-07-30

* app.automation — one row per user automation (template instance): params jsonb,
  per-row cron/timezone, budget, cooldown, dry_run (defaults true so new rules
  simulate until the operator flips them live), state jsonb for watermarks.
* app.automation_run — run history in the app.mal_job_run mold, plus dry_run status
  and skip counters.
* app.automation_action_ledger — global (not per-automation) cooldown memory keyed
  (instance, entity, source_id, action): two rules matching the same movie must not
  double-search it inside the cooldown window. Also backs the daily search cap.
* warehouse.{movie_file,episode_file}.video_resolution — promoted from
  payload->mediaInfo so resolution floors are an indexed integer compare, backfilled
  from mediaInfo.resolution ("1920x1080") falling back to the quality name ("…-1080p").
"""

from collections.abc import Sequence
from typing import Union

from alembic import op

revision: str = "0012_automations"
down_revision: Union[str, None] = "0011_reporting_correctness"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        create table app.automation (
            id bigserial primary key,
            name text not null unique,
            template_key text not null,
            params jsonb not null default '{}'::jsonb,
            enabled boolean not null default false,
            dry_run boolean not null default true,
            cron text not null,
            timezone text not null default 'UTC',
            budget_per_run int not null default 10
                constraint automation_budget_check check (budget_per_run between 1 and 100),
            cooldown_days int not null default 7
                constraint automation_cooldown_check check (cooldown_days between 1 and 90),
            state jsonb not null default '{}'::jsonb,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
        )
        """
    )
    op.execute(
        """
        create table app.automation_run (
            id bigserial primary key,
            automation_id bigint not null references app.automation(id) on delete cascade,
            started_at timestamptz not null default now(),
            finished_at timestamptz,
            status text not null default 'running'
                constraint automation_run_status_check
                check (status in ('running', 'success', 'partial', 'failed', 'dry_run')),
            matched_count int not null default 0,
            actions_taken int not null default 0,
            skipped_cooldown int not null default 0,
            skipped_budget int not null default 0,
            details jsonb not null default '{}'::jsonb,
            error_message text
        )
        """
    )
    op.execute(
        "create index ix_automation_run_automation_started"
        " on app.automation_run (automation_id, started_at desc)"
    )
    op.execute(
        """
        create table app.automation_action_ledger (
            instance_name text not null,
            entity_type text not null
                constraint automation_ledger_entity_check
                check (entity_type in ('movie', 'series', 'episode')),
            source_id bigint not null,
            action_type text not null
                constraint automation_ledger_action_check
                check (action_type in ('search', 'tag', 'monitor')),
            last_fired_at timestamptz not null default now(),
            last_automation_id bigint,
            last_run_id bigint,
            primary key (instance_name, entity_type, source_id, action_type)
        )
        """
    )
    op.execute(
        "create index ix_automation_ledger_action_fired"
        " on app.automation_action_ledger (action_type, last_fired_at desc)"
    )

    op.execute("alter table warehouse.movie_file add column video_resolution int")
    op.execute("alter table warehouse.episode_file add column video_resolution int")
    for table in ("movie_file", "episode_file"):
        op.execute(
            f"""
            update warehouse.{table}
            set video_resolution = coalesce(
                substring(payload->'mediaInfo'->>'resolution' from 'x([0-9]{{3,4}})')::int,
                substring(coalesce(quality, '') from '([0-9]{{3,4}})[pi]')::int
            )
            where video_resolution is null
            """
        )
    op.execute(
        "create index ix_movie_file_video_resolution"
        " on warehouse.movie_file (video_resolution) where not deleted"
    )
    op.execute(
        "create index ix_episode_file_video_resolution"
        " on warehouse.episode_file (video_resolution) where not deleted"
    )


def downgrade() -> None:
    op.execute("drop index if exists warehouse.ix_episode_file_video_resolution")
    op.execute("drop index if exists warehouse.ix_movie_file_video_resolution")
    op.execute("alter table warehouse.episode_file drop column if exists video_resolution")
    op.execute("alter table warehouse.movie_file drop column if exists video_resolution")
    op.execute("drop table if exists app.automation_action_ledger")
    op.execute("drop table if exists app.automation_run")
    op.execute("drop table if exists app.automation")
