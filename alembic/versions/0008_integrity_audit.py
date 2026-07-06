"""app.integrity_audit_run: warehouse-vs-Arr drift audits + integrity_audit cron mode

Revision ID: 0008_integrity_audit
Revises: 0007_library_stat_snapshot
Create Date: 2026-07-06
"""

from collections.abc import Sequence
from typing import Union

from alembic import op

revision: str = "0008_integrity_audit"
down_revision: Union[str, None] = "0007_library_stat_snapshot"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Allow the new integrity_audit cron mode alongside the existing ones.
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

    op.execute(
        """
        create table if not exists app.integrity_audit_run (
            id bigserial primary key,
            source text not null check (source in ('sonarr', 'radarr')),
            instance_name text not null default 'default',
            status text not null check (status in ('running', 'success', 'failed')),
            started_at timestamptz not null default now(),
            finished_at timestamptz,
            arr_counts jsonb not null default '{}'::jsonb,
            warehouse_counts jsonb not null default '{}'::jsonb,
            drift jsonb not null default '{}'::jsonb,
            drift_detected boolean not null default false,
            error_message text
        )
        """
    )
    op.execute(
        "create index if not exists idx_integrity_audit_run_started"
        " on app.integrity_audit_run(source, instance_name, started_at desc)"
    )

    op.execute(
        """
        do $arrapp_integrity_grants$
        begin
          if exists (select 1 from pg_roles where rolname = 'arrapp') then
            execute 'grant all privileges on app.integrity_audit_run to arrapp';
            execute 'grant usage, select on sequence app.integrity_audit_run_id_seq to arrapp';
          end if;
        end
        $arrapp_integrity_grants$;
        """
    )


def downgrade() -> None:
    op.execute("drop table if exists app.integrity_audit_run")
    op.execute("delete from app.sync_schedule where mode = 'integrity_audit'")
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
                'mal_ingest',
                'mal_matcher',
                'mal_tag_sync'
            )
        )
        """
    )
