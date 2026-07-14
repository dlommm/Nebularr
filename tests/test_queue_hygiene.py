"""Retention must also age out dead-letter webhook rows (they never get processed_at)."""

from __future__ import annotations

from typing import Any

from arrsync.services.repository import prune_old_rows


class RecordingSession:
    def __init__(self) -> None:
        self.statements: list[tuple[str, dict[str, Any] | None]] = []

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> None:
        sql = " ".join(str(query).lower().split())
        self.statements.append((sql, params))

    def commit(self) -> None:
        return None


def test_prune_ages_out_dead_letter_rows() -> None:
    session = RecordingSession()
    prune_old_rows(session, keep_days=30)  # type: ignore[arg-type]
    dead_letter_deletes = [
        (sql, params)
        for sql, params in session.statements
        if "delete from app.webhook_queue" in sql and "dead_letter" in sql
    ]
    assert dead_letter_deletes, "dead_letter rows must be pruned by age"
    sql, params = dead_letter_deletes[0]
    assert "received_at" in sql
    assert params == {"keep_days": 30}


def test_prune_keep_days_zero_keeps_webhook_rows() -> None:
    session = RecordingSession()
    prune_old_rows(session, keep_days=0)
    assert not any("delete from app.webhook_queue" in sql for sql, _ in session.statements)
