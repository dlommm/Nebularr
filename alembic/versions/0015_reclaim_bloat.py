"""Reclaim the heap 0013/0014 left behind, and drop indexes nothing reads

Revision ID: 0015_reclaim_bloat
Revises: 0014_episode_file_id
Create Date: 2026-09-21

Two bulk rewrites shipped in consecutive releases — 0013 re-derived
``video_resolution`` for every episode_file row, 0014 backfilled
``episode_file_id`` for every episode row. An UPDATE writes a new tuple and leaves
the old one dead, so each migration roughly doubled its table. Autovacuum reclaimed
the space *for reuse* but cannot hand it back to the filesystem, and the workload
never grew into it.

Measured with pgstattuple on a real 133k-episode library before this migration:

    episode       420 MB file, 186 MB live tuples, 231 MB free (55.1%)
    episode_file  430 MB file, 188 MB live tuples, 232 MB free (54.0%)

That is not only disk. These two tables are the hot path for every automation,
report and library listing, and at twice their necessary size neither fits in a
default 128 MB shared_buffers — measured cache hit ratio on that library was 10.9%
and 10.8%, against >95% for a table that fits. VACUUM FULL rewrites each without
the holes: 1031 MB -> 588 MB in 6.9 seconds there.

A one-time correction, not a habit. Ordinary sync churn under a healthy autovacuum
settles at a far smaller steady state — this migration exists because two specific
migrations bulk-rewrote the tables, not because the workload bloats them. Nothing
here is scheduled to repeat.

VACUUM FULL takes an ACCESS EXCLUSIVE lock and needs room for a second copy of the
table while it runs. Both are acceptable here: migrations run at startup before the
app serves anything, and at library scale it is over in seconds. If the copy will
not fit, Postgres fails the migration with the original table untouched — the
original is only dropped once the rewrite is complete.
"""

from collections.abc import Sequence
from typing import Union

from alembic import op

revision: str = "0015_reclaim_bloat"
down_revision: Union[str, None] = "0014_episode_file_id"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Each verified unused against a real library, over statistics that had never been
# reset — idx_scan = 0 for the index's entire lifetime:
#
#     idx_episode_file_quality                     0 scans   4384 kB
#     ix_episode_episode_file_id                   0 scans   3136 kB
#     ix_episode_file_video_resolution             0 scans   2632 kB
#     ix_movie_file_video_resolution               0 scans    160 kB
#     idx_movie_file_quality                       0 scans    120 kB
#     idx_series_deleted                           0 scans     48 kB
#     ix_library_stat_snapshot_instance_captured   0 scans     16 kB
#
# Three could never have been used at all. ix_episode_episode_file_id (added by
# 0014) indexes episode(episode_file_id) — the driving side of the join, not the
# side looked up; nothing in the codebase filters an episode by its file id. The
# video_resolution and quality indexes are defeated by their own predicates, which
# wrap the column: `coalesce(ef.video_resolution, 0) >= :min` and
# `coalesce(ef.quality, '') = any(:names)` cannot use a plain btree on the bare
# column. None of them is free — every one is maintained on every upsert, and a
# full reconcile upserts 133k episodes and 111k files.
#
# Deliberately kept: idx_episode_file_size (10 scans) and idx_movie_file_size
# (12 scans) are used, if rarely, by the large-files view.
_DEAD_INDEXES = (
    "warehouse.idx_episode_file_quality",
    "warehouse.ix_episode_episode_file_id",
    "warehouse.ix_episode_file_video_resolution",
    "warehouse.ix_movie_file_video_resolution",
    "warehouse.idx_movie_file_quality",
    "warehouse.idx_series_deleted",
    "warehouse.ix_library_stat_snapshot_instance_captured",
)

# Rewritten by 0013 and 0014 respectively.
_BLOATED_TABLES = ("warehouse.episode_file", "warehouse.episode")


def upgrade() -> None:
    for index in _DEAD_INDEXES:
        op.execute(f"drop index if exists {index}")

    # VACUUM cannot run inside a transaction block and alembic wraps a migration in
    # one. ANALYZE rides along in the same pass: 0013 and 0014 both bulk-updated
    # without one, so the planner has been costing these tables from statistics
    # that predate the column they were written for.
    #
    # No disk-space precheck: SQL cannot see free space on the volume, and a check
    # that cannot fail is worse than none. If the rewrite cannot fit, Postgres says
    # so and the migration fails loudly with the original table intact — VACUUM
    # FULL only drops the original once the copy is complete.
    with op.get_context().autocommit_block():
        for table in _BLOATED_TABLES:
            op.execute(f"vacuum (full, analyze) {table}")


def downgrade() -> None:
    # Reclaimed space cannot be un-reclaimed, and would not be wanted back. Only
    # the indexes are restorable — recreated exactly as their original migrations
    # wrote them, so a downgrade lands on the schema those migrations describe.
    op.execute(
        "create index if not exists idx_episode_file_quality on warehouse.episode_file(quality)"
    )
    op.execute(
        "create index if not exists ix_episode_episode_file_id"
        " on warehouse.episode (episode_file_id, instance_name)"
        " where episode_file_id is not null and not deleted"
    )
    op.execute(
        "create index if not exists ix_episode_file_video_resolution"
        " on warehouse.episode_file (video_resolution) where not deleted"
    )
    op.execute(
        "create index if not exists ix_movie_file_video_resolution"
        " on warehouse.movie_file (video_resolution) where not deleted"
    )
    op.execute("create index if not exists idx_movie_file_quality on warehouse.movie_file(quality)")
    op.execute("create index if not exists idx_series_deleted on warehouse.series(deleted)")
    op.execute(
        "create index if not exists ix_library_stat_snapshot_instance_captured"
        " on warehouse.library_stat_snapshot (instance_name, source, captured_at)"
    )
