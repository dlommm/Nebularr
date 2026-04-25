"""Extend sync_schedule for MAL cron modes

Revision ID: 0005_sync_schedule_mal_modes
Revises: 0004_mal_schema
Create Date: 2026-04-24
"""

from collections.abc import Sequence
from typing import Union

from alembic import op

revision: str = "0005_sync_schedule_mal_modes"
down_revision: Union[str, None] = "0004_mal_schema"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("alter table app.sync_schedule drop constraint if exists sync_schedule_mode_check")
    op.execute(
        """
        alter table app.sync_schedule add constraint sync_schedule_mode_check
        check (
            mode in (
                'full',
                'incremental',
                'reconcile',
                'mal_ingest',
                'mal_matcher',
                'mal_tag_sync'
            )
        )
        """
    )
    op.execute(
        """
        insert into app.sync_schedule (mode, cron, timezone, enabled, updated_at)
        values
            ('mal_ingest', '0 3 * * *', 'UTC', true, now()),
            ('mal_matcher', '30 3 * * *', 'UTC', true, now()),
            ('mal_tag_sync', '0 4 * * *', 'UTC', true, now())
        on conflict (mode) do nothing
        """
    )


def downgrade() -> None:
    op.execute("delete from app.sync_schedule where mode in ('mal_ingest', 'mal_matcher', 'mal_tag_sync')")
    op.execute("alter table app.sync_schedule drop constraint if exists sync_schedule_mode_check")
    op.execute(
        """
        alter table app.sync_schedule add constraint sync_schedule_mode_check
        check (mode in ('full', 'incremental', 'reconcile'))
        """
    )
