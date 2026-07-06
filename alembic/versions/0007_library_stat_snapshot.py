"""warehouse.library_stat_snapshot: periodic library size/count captures for trend analytics

Revision ID: 0007_library_stat_snapshot
Revises: 0006_mal_anime_additional_titles
Create Date: 2026-07-05
"""

from collections.abc import Sequence
from typing import Union

from alembic import op

revision: str = "0007_library_stat_snapshot"
down_revision: Union[str, None] = "0006_mal_anime_additional_titles"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        create table if not exists warehouse.library_stat_snapshot (
            id bigserial primary key,
            captured_at timestamptz not null default now(),
            instance_name text not null,
            source text not null,
            entity_count integer not null default 0,
            file_count integer not null default 0,
            file_bytes bigint not null default 0
        )
        """
    )
    op.execute(
        """
        create index if not exists ix_library_stat_snapshot_captured_at
        on warehouse.library_stat_snapshot (captured_at)
        """
    )
    op.execute(
        """
        create index if not exists ix_library_stat_snapshot_instance_captured
        on warehouse.library_stat_snapshot (instance_name, source, captured_at)
        """
    )


def downgrade() -> None:
    op.execute("drop table if exists warehouse.library_stat_snapshot")
