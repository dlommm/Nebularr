"""Hot-path indexes + webhook queue dedupe scoped to open jobs

Revision ID: 0010_perf_indexes_queue_hygiene
Revises: 0009_dub_sources_coverage
Create Date: 2026-07-14
"""

from collections.abc import Sequence
from typing import Union

from alembic import op

revision: str = "0010_perf_indexes_queue_hygiene"
down_revision: Union[str, None] = "0009_dub_sources_coverage"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Join keys used by the library endpoints (episode/movie file lookups) and
    # the tag/coverage/matcher services; only size/quality were indexed before.
    op.execute(
        "create index if not exists idx_episode_file_episode_instance"
        " on warehouse.episode_file(episode_source_id, instance_name)"
    )
    op.execute(
        "create index if not exists idx_movie_file_movie_instance"
        " on warehouse.movie_file(movie_source_id, instance_name)"
    )
    op.execute(
        "create index if not exists idx_series_instance_active"
        " on warehouse.series(instance_name) where not deleted"
    )
    op.execute(
        "create index if not exists idx_movie_instance_active"
        " on warehouse.movie(instance_name) where not deleted"
    )

    # Dedupe must only block duplicates of jobs that are still open; a payload
    # identical to an already-processed row has to be accepted again.
    op.execute("drop index if exists app.uq_webhook_queue_dedupe")
    op.execute(
        "create unique index if not exists uq_webhook_queue_dedupe_open"
        " on app.webhook_queue(dedupe_key)"
        " where dedupe_key is not null and status in ('queued', 'retrying')"
    )

    # Background "import all" backlog runs record progress as their own job type.
    op.execute("alter table app.mal_job_run drop constraint if exists mal_job_run_job_type_check")
    op.execute(
        """
        alter table app.mal_job_run add constraint mal_job_run_job_type_check
        check (
            job_type in ('ingest', 'matcher', 'tag_sync', 'coverage_tag_sync', 'ingest_backlog')
        )
        """
    )


def downgrade() -> None:
    op.execute("delete from app.mal_job_run where job_type = 'ingest_backlog'")
    op.execute("alter table app.mal_job_run drop constraint if exists mal_job_run_job_type_check")
    op.execute(
        """
        alter table app.mal_job_run add constraint mal_job_run_job_type_check
        check (job_type in ('ingest', 'matcher', 'tag_sync', 'coverage_tag_sync'))
        """
    )
    op.execute("drop index if exists app.uq_webhook_queue_dedupe_open")
    # Can fail if identical dedupe keys accumulated across terminal rows;
    # deduplicate those rows manually before downgrading in that case.
    op.execute(
        "create unique index if not exists uq_webhook_queue_dedupe"
        " on app.webhook_queue(dedupe_key) where dedupe_key is not null"
    )
    op.execute("drop index if exists warehouse.idx_movie_instance_active")
    op.execute("drop index if exists warehouse.idx_series_instance_active")
    op.execute("drop index if exists warehouse.idx_movie_file_movie_instance")
    op.execute("drop index if exists warehouse.idx_episode_file_episode_instance")
