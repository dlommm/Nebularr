"""SQL fragments shared by every query that reads episodes with their file.

The episode->file link lives here and nowhere else. It was written out by hand at
five call sites once, and all five were wrong in the same way (see
``EPISODE_FILE_JOIN``); a single definition is what stops the next fix from
landing at four of them.
"""

from __future__ import annotations

# One file can cover several episodes ("S02E01-E02"), which episode_file's single
# episode_source_id cannot express: the second episode was orphaned and read as
# having no file. Join on the episode's OWN file id, falling back to the old link
# for rows whose episode_file_id is unknown.
#
# Written as an OR of two equalities rather than the CASE that reads more directly.
# A CASE is opaque to the planner: it cannot push either branch down to an index,
# so the join degrades to a materialised scan of the whole episode_file table
# replayed once per episode row, and the series-completeness count hit the
# statement timeout on a real library. The OR form lets the planner BitmapOr the
# episode_file primary key against idx_episode_file_episode_instance. Same rows,
# measured 33s -> 30ms on a 90k-episode fixture.
#
# The arms stay mutually exclusive because the second is guarded on
# episode_file_id being null, so this matches exactly what the CASE matched.
EPISODE_FILE_JOIN_ON = (
    "ef.instance_name = e.instance_name"
    " and not ef.deleted"
    " and (ef.source_id = e.episode_file_id"
    " or (e.episode_file_id is null and ef.episode_source_id = e.source_id))"
)

EPISODE_FILE_JOIN = f"left join warehouse.episode_file ef on {EPISODE_FILE_JOIN_ON}"
