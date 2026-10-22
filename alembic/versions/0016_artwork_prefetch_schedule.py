"""Allow an artwork_prefetch schedule row

Revision ID: 0016_artwork_prefetch_schedule
Revises: 0015_reclaim_bloat
Create Date: 2026-10-22

The artwork cache (services/artwork_service.py) is warmed by a cron job like the
other background work, so its schedule lives in app.sync_schedule and shows up on
the Schedules page. Only the mode check constraint and the default row change.
"""

from collections.abc import Sequence
from typing import Union

from alembic import op

revision: str = "0016_artwork_prefetch_schedule"
down_revision: Union[str, None] = "0015_reclaim_bloat"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_MODES_BEFORE = (
    "'full', 'incremental', 'reconcile', 'stats_snapshot', 'integrity_audit', "
    "'mal_ingest', 'mal_matcher', 'mal_tag_sync', 'coverage_tag_sync'"
)


def upgrade() -> None:
    op.execute("alter table app.sync_schedule drop constraint if exists sync_schedule_mode_check")
    op.execute(
        "alter table app.sync_schedule add constraint sync_schedule_mode_check "
        f"check (mode in ({_MODES_BEFORE}, 'artwork_prefetch'))"
    )
    op.execute(
        """
        insert into app.sync_schedule (mode, cron, timezone, enabled, updated_at)
        values ('artwork_prefetch', '20 */6 * * *', 'UTC', true, now())
        on conflict (mode) do nothing
        """
    )


def downgrade() -> None:
    op.execute("delete from app.sync_schedule where mode = 'artwork_prefetch'")
    op.execute("alter table app.sync_schedule drop constraint if exists sync_schedule_mode_check")
    op.execute(
        "alter table app.sync_schedule add constraint sync_schedule_mode_check "
        f"check (mode in ({_MODES_BEFORE}))"
    )
