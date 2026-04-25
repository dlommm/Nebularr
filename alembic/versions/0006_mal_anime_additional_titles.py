"""mal.anime: additional title variants for library matching

Revision ID: 0006_mal_anime_additional_titles
Revises: 0005_sync_schedule_mal_modes
Create Date: 2026-04-24
"""

from collections.abc import Sequence
from typing import Union

from alembic import op

revision: str = "0006_mal_anime_additional_titles"
down_revision: Union[str, None] = "0005_sync_schedule_mal_modes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        alter table mal.anime
        add column if not exists additional_titles jsonb not null default '[]'::jsonb
        """
    )


def downgrade() -> None:
    op.execute("alter table mal.anime drop column if exists additional_titles")
