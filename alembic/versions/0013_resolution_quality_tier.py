"""video_resolution means the quality tier, not the literal frame height

Revision ID: 0013_resolution_quality_tier
Revises: 0012_automations
Create Date: 2026-09-20

0012 backfilled ``video_resolution`` from ``mediaInfo.resolution`` first, taking the
frame HEIGHT: "1920x960" -> 960. That reads a letterboxed 1080p file as 960, so a
``resolution_min: 1080`` rule rejects a file both the Arr and the operator call
1080p. With the series-completeness rules added in 2.9.0 the cost compounds — one
letterboxed episode disqualifies an entire show — and on a real library this hid
thousands of episodes: in one 'ended' TV library, 9,443 episodes failed a 1080
floor against 4,374 at 720, the ~5,000 difference being 1080p-tier files whose
stored height was 800-1000.

This re-derives the column as the quality TIER, in the same precedence the
application now uses (repository._extract_video_resolution — keep the two in step):

  1. payload->quality->quality->>resolution — the Arr's own tier number, i.e. the
     number shown in Sonarr/Radarr's own UI.
  2. the quality NAME ("WEBDL-1080p").
  3. frame WIDTH mapped to a tier — the letterbox-proof route (1920 wide = 1080p
     whatever the height).
  4. frame height, last resort: right for 16:9, and better than null for a file
     carrying no quality metadata at all.

Every row is recomputed (no ``where video_resolution is null`` guard as in 0012):
the point is to correct values that are already there. The payload is retained, so
this needs no re-sync. Rows whose payload yields nothing keep whatever they had.
"""

from collections.abc import Sequence
from typing import Union

from alembic import op

revision: str = "0013_resolution_quality_tier"
down_revision: Union[str, None] = "0012_automations"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Shared by upgrade and downgrade so the two can't drift apart in their shape.
_TIER_FROM_WIDTH = """
            case
                when {w} >= 3840 then 2160
                when {w} >= 2560 then 1440
                when {w} >= 1920 then 1080
                when {w} >= 1280 then 720
                when {w} >= 852  then 480
                when {w} >= 640  then 360
            end
"""


def _rederive_sql(table: str) -> str:
    width = "substring(payload->'mediaInfo'->>'resolution' from '^[[:space:]]*([0-9]{3,5})[[:space:]]*x')::int"
    height = "substring(payload->'mediaInfo'->>'resolution' from 'x[[:space:]]*([0-9]{3,4})[[:space:]]*$')::int"
    # The Arr's own tier, guarded twice: the regex makes the cast safe (a text
    # field could hold anything), and the range check makes a malformed-but-numeric
    # value fall through to the derivations rather than poison the column.
    arr_tier = "(payload->'quality'->'quality'->>'resolution')"
    return f"""
        update warehouse.{table}
        set video_resolution = coalesce(
            case
                when {arr_tier} ~ '^[0-9]{{3,4}}$'
                     and {arr_tier}::int between 240 and 4320
                then {arr_tier}::int
            end,
            substring(payload->'quality'->'quality'->>'name' from '([0-9]{{3,4}})[pi]')::int,
            {_TIER_FROM_WIDTH.format(w=width)},
            {height},
            video_resolution
        )
        """


def upgrade() -> None:
    for table in ("movie_file", "episode_file"):
        op.execute(_rederive_sql(table))


def downgrade() -> None:
    # Restore 0012's semantics: frame height first, then the quality name. Lossy in
    # the same way 0012 was — a letterboxed 1080p file goes back to reading as its
    # crop height — which is the point of being able to go back.
    for table in ("movie_file", "episode_file"):
        op.execute(
            f"""
            update warehouse.{table}
            set video_resolution = coalesce(
                substring(payload->'mediaInfo'->>'resolution' from 'x([0-9]{{3,4}})')::int,
                substring(coalesce(quality, '') from '([0-9]{{3,4}})[pi]')::int,
                video_resolution
            )
            """
        )
