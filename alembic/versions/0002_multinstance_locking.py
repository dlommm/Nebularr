"""multi instance sync_state and lease locks

Revision ID: 0002_multinstance_locking
Revises: 0001_initial
Create Date: 2026-04-23
"""

from collections.abc import Sequence
from typing import Union

from alembic import op

revision: str = "0002_multinstance_locking"
down_revision: Union[str, None] = "0001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("alter table app.sync_state add column if not exists instance_name text not null default 'default'")
    op.execute("alter table app.sync_state drop constraint if exists sync_state_source_key")
    op.execute("alter table app.sync_state add constraint uq_sync_state_source_instance unique (source, instance_name)")

    op.execute("alter table warehouse.sync_run add column if not exists instance_name text not null default 'default'")
    op.execute("create index if not exists idx_sync_run_source_instance_started on warehouse.sync_run(source, instance_name, started_at desc)")
    op.execute("alter table app.job_run_summary add column if not exists instance_name text not null default 'default'")
    op.execute("create index if not exists idx_job_run_source_instance_mode_started on app.job_run_summary(source, instance_name, mode, started_at desc)")

    op.execute(
        """
        create table if not exists app.job_lock (
            lock_name text primary key,
            owner_id text not null,
            acquired_at timestamptz not null default now(),
            heartbeat_at timestamptz not null default now(),
            expires_at timestamptz not null
        )
        """
    )


def downgrade() -> None:
    op.execute("drop table if exists app.job_lock")
    op.execute("drop index if exists idx_job_run_source_instance_mode_started")
    op.execute("alter table app.job_run_summary drop column if exists instance_name")
    op.execute("drop index if exists idx_sync_run_source_instance_started")
    op.execute("alter table warehouse.sync_run drop column if exists instance_name")
    op.execute("alter table app.sync_state drop constraint if exists uq_sync_state_source_instance")
    op.execute("alter table app.sync_state add constraint sync_state_source_key unique (source)")
    op.execute("alter table app.sync_state drop column if exists instance_name")
