"""warehouse.episode.episode_file_id — one file can cover several episodes

Revision ID: 0014_episode_file_id
Revises: 0013_resolution_quality_tier
Create Date: 2026-09-20

``warehouse.episode_file`` is keyed on the FILE's id and carries a single
``episode_source_id``, which models episode->file as one-to-one. Sonarr does not:
a double episode is one file covering two episodes ("S02E01-E02"), returned on both
episode records. Upserting it for E1 then E2 writes one row and the last write wins
``episode_source_id``, so the other episode is orphaned — it reports ``hasFile:
true`` while every query that joins ``ef.episode_source_id = e.source_id`` finds
nothing.

That made an orphan look like a missing file, and under the series-completeness
rules a single missing file disqualifies a whole show. Measured on a real library:
131 orphaned episodes against 123 multi-episode files in the same sample, and 7 of
340 sampled ended shows were otherwise complete and blocked solely by this (Mr.
Robot, Heroes, Star Trek: Voyager among them).

The fix is to join on the episode's OWN file id, which Sonarr gives us on the
episode record. Promoted here to an indexed column and backfilled from the retained
payload, so no re-sync is needed. ``episodeFileId`` is 0 when an episode has no
file; that is normalised to NULL so the column means "the file this episode uses, if
any" and callers can fall back to the old join where it is absent.

Deliberately additive: nothing is dropped, and ``episode_source_id`` stays as the
fallback for rows whose payload predates or omits the field.
"""

from collections.abc import Sequence
from typing import Union

from alembic import op

revision: str = "0014_episode_file_id"
down_revision: Union[str, None] = "0013_resolution_quality_tier"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("alter table warehouse.episode add column if not exists episode_file_id bigint")
    # Backfill from the stored payload. nullif(...,0): Sonarr reports 0 for "no
    # file", and a 0 here would join to nothing while looking like a real id.
    op.execute(
        """
        update warehouse.episode
        set episode_file_id = nullif((payload->>'episodeFileId')::bigint, 0)
        where payload->>'episodeFileId' ~ '^[0-9]+$'
          and episode_file_id is distinct from nullif((payload->>'episodeFileId')::bigint, 0)
        """
    )
    op.execute(
        "create index if not exists ix_episode_episode_file_id"
        " on warehouse.episode (episode_file_id, instance_name)"
        " where episode_file_id is not null and not deleted"
    )


def downgrade() -> None:
    op.execute("drop index if exists warehouse.ix_episode_episode_file_id")
    op.execute("alter table warehouse.episode drop column if exists episode_file_id")
