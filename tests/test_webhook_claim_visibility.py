"""Claiming a webhook job must hide it for a visibility window so a second,
overlapping drain pass cannot claim the same row before the first finishes.

Exercised against a real in-memory SQLite database (schema `app` attached) so the
UPDATE ... RETURNING claim semantics — and the visibility timeout that gates a
re-claim — are verified for real, not mocked. On SQLite the single writer already
serialises writes, so the claim query drops the Postgres-only FOR UPDATE SKIP
LOCKED; the visibility timeout is what actually prevents double-claiming.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from arrsync.services.repository import (
    WEBHOOK_CLAIM_VISIBILITY_SECONDS,
    claim_webhook_jobs,
)


@pytest.fixture()
def sqlite_session() -> Any:
    engine = create_engine(
        "sqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
        future=True,
    )
    with engine.begin() as conn:
        # SQLite has no schemas; attach an in-memory db aliased `app` so the
        # schema-qualified `app.webhook_queue` the repo issues resolves.
        conn.execute(text("attach database ':memory:' as app"))
        conn.execute(
            text(
                """
                create table app.webhook_queue (
                    id integer primary key autoincrement,
                    source text not null,
                    event_type text not null,
                    payload text,
                    dedupe_key text,
                    status text not null default 'queued',
                    attempts int not null default 0,
                    received_at text not null default (datetime('now')),
                    next_attempt_at text not null default (datetime('now')),
                    processed_at text,
                    error_message text
                )
                """
            )
        )
    factory = sessionmaker(bind=engine, future=True)
    session: Session = factory()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _enqueue(session: Session, source: str = "sonarr") -> None:
    session.execute(
        text(
            """
            insert into app.webhook_queue (source, event_type, payload, status, attempts, next_attempt_at)
            values (:source, 'Download', '{}', 'queued', 0, datetime('now'))
            """
        ),
        {"source": source},
    )
    session.commit()


def test_claim_hides_row_for_visibility_window_then_reappears(sqlite_session: Session) -> None:
    _enqueue(sqlite_session)

    first = claim_webhook_jobs(sqlite_session, "sonarr")
    sqlite_session.commit()
    assert len(first) == 1, "the queued job must be claimable"
    assert first[0]["attempts"] == 1

    # A second drain pass overlapping the first must not re-claim the same row:
    # the claim pushed next_attempt_at into the future (the visibility window).
    second = claim_webhook_jobs(sqlite_session, "sonarr")
    sqlite_session.commit()
    assert second == [], "an in-flight (claimed) job must stay invisible to a second claim"

    # Simulate the visibility window elapsing (e.g. the first worker crashed
    # without acking): the job becomes claimable again for redelivery.
    sqlite_session.execute(
        text("update app.webhook_queue set next_attempt_at = datetime('now', '-1 hour')")
    )
    sqlite_session.commit()
    third = claim_webhook_jobs(sqlite_session, "sonarr")
    sqlite_session.commit()
    assert len(third) == 1, "after the visibility window lapses the job is re-claimable"
    assert third[0]["attempts"] == 2


def test_visibility_constant_is_two_minutes() -> None:
    assert WEBHOOK_CLAIM_VISIBILITY_SECONDS == 120
