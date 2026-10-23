"""Index file rows by first-seen time for the Overview's recent imports

Revision ID: 0017_file_seen_at_index
Revises: 0016_artwork_prefetch_schedule
Create Date: 2026-10-22

GET /api/ui/recent-imports reads the newest episode and movie files by
``seen_at`` (set once, when a file row first appears). Without an index that is a
full scan plus top-N sort of every file row on each Overview refresh; partial
indexes over live rows keep it an index walk.
"""

from collections.abc import Sequence
from typing import Union

from alembic import op

revision: str = "0017_file_seen_at_index"
down_revision: Union[str, None] = "0016_artwork_prefetch_schedule"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "create index if not exists idx_episode_file_seen_at_live "
        "on warehouse.episode_file (seen_at desc) where not deleted"
    )
    op.execute(
        "create index if not exists idx_movie_file_seen_at_live "
        "on warehouse.movie_file (seen_at desc) where not deleted"
    )


def downgrade() -> None:
    op.execute("drop index if exists warehouse.idx_movie_file_seen_at_live")
    op.execute("drop index if exists warehouse.idx_episode_file_seen_at_live")
