"""fix v_large_files bigint threshold overflow

Revision ID: 0003_fix_large_files_threshold
Revises: 0002_multinstance_locking
Create Date: 2026-04-23
"""

from collections.abc import Sequence
from typing import Union

from alembic import op

revision: str = "0003_fix_large_files_threshold"
down_revision: Union[str, None] = "0002_multinstance_locking"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _replace_large_files_view() -> None:
    op.execute(
        """
        create or replace view warehouse.v_large_files as
        select *
        from warehouse.v_episode_files
        where size_bytes is not null and size_bytes > 3221225472::bigint
        union all
        select
            instance_name,
            movie_title as series_title,
            null::int as season_number,
            null::int as episode_number,
            movie_title as episode_title,
            null::timestamptz as air_date,
            path,
            size_bytes,
            quality,
            audio_languages,
            subtitle_languages,
            audio_codec,
            audio_channels,
            video_codec,
            deleted
        from warehouse.v_movie_files
        where size_bytes is not null and size_bytes > 3221225472::bigint
        """
    )


def upgrade() -> None:
    _replace_large_files_view()


def downgrade() -> None:
    _replace_large_files_view()
