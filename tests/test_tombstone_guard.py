"""Per-source writer coordination (Step 2) and the mass-tombstone guard (Step 3b).

The advisory lock is Postgres-only by design: SQLite serialises writers itself, so
the helper is a correct no-op there and against test fakes. The mass-tombstone
guard refuses to soft-delete a populated warehouse when a fetch comes back empty
(the classic "Arr returned a login page / had a blip" failure mode).
"""

from __future__ import annotations

import asyncio
import os
import zlib
from typing import Any

import pytest

from arrsync.services import repository as repo
from arrsync.services.repository import acquire_source_write_lock
from arrsync.services.sync_service import SyncService


class _Result:
    def __init__(self, count: int) -> None:
        self._count = count

    def scalar_one(self) -> int:
        return self._count

    def scalar_one_or_none(self) -> None:
        return None

    def first(self) -> None:
        return None

    def mappings(self) -> list[Any]:
        return []


class GuardSession:
    """Records SQL; answers the non-deleted count query with a fixed number."""

    def __init__(self, warehouse_count: int) -> None:
        self.warehouse_count = warehouse_count
        self.statements: list[tuple[str, dict[str, Any] | None]] = []

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> _Result:
        sql = " ".join(str(query).lower().split())
        self.statements.append((sql, params))
        if "count(*)" in sql:
            return _Result(self.warehouse_count)
        return _Result(0)

    def commit(self) -> None:
        return None

    def rollback(self) -> None:
        return None

    def close(self) -> None:
        return None


class EmptyListClient:
    def __init__(self) -> None:
        self.settings = None
        self.base_url = "http://sonarr.local"
        self.api_key = "k"

    async def list_series(self) -> list[dict[str, Any]]:
        return []


def _service(session: GuardSession) -> SyncService:
    client = EmptyListClient()
    return SyncService(
        session_factory=lambda: session,
        sonarr=client,  # type: ignore[arg-type]
        radarr=client,  # type: ignore[arg-type]
        stop_event=asyncio.Event(),
    )


# --- Step 2: advisory-lock helper -------------------------------------------------


def test_acquire_source_write_lock_is_noop_without_a_postgres_bind() -> None:
    calls: list[Any] = []

    class NoBindSession:
        def execute(self, query: Any, params: dict[str, Any] | None = None) -> None:
            calls.append((str(query), params))

    acquire_source_write_lock(NoBindSession(), "sonarr", "default")  # type: ignore[arg-type]
    assert calls == [], "no advisory lock without a postgres backend"


def test_acquire_source_write_lock_issues_xact_lock_on_postgres() -> None:
    calls: list[tuple[str, dict[str, Any] | None]] = []

    class _Dialect:
        name = "postgresql"

    class _Bind:
        dialect = _Dialect()

    class PgSession:
        bind = _Bind()

        def execute(self, query: Any, params: dict[str, Any] | None = None) -> None:
            calls.append((" ".join(str(query).lower().split()), params))

    acquire_source_write_lock(PgSession(), "sonarr", "default")  # type: ignore[arg-type]
    assert calls, "postgres must take the advisory lock"
    sql, params = calls[0]
    assert "pg_advisory_xact_lock" in sql
    assert params == {"k": zlib.crc32(b"sonarr:default") & 0x7FFFFFFF}


@pytest.mark.asyncio
async def test_full_sync_tombstone_pass_takes_the_source_write_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lock_calls: list[tuple[str, str]] = []

    def record_lock(_session: Any, source: str, instance_name: str) -> None:
        lock_calls.append((source, instance_name))

    monkeypatch.setattr(repo, "acquire_source_write_lock", record_lock)

    session = GuardSession(warehouse_count=0)
    client = EmptyListClient()

    async def one_series() -> list[dict[str, Any]]:
        return [{"id": 1, "title": "X"}]

    client.list_series = one_series  # type: ignore[method-assign]

    async def no_episodes(_sid: int) -> list[dict[str, Any]]:
        return []

    client.list_episodes = no_episodes  # type: ignore[attr-defined]

    service = SyncService(
        session_factory=lambda: session,
        sonarr=client,  # type: ignore[arg-type]
        radarr=client,  # type: ignore[arg-type]
        stop_event=asyncio.Event(),
    )
    await service._sync_sonarr_full(
        client, run_id=1, mode="full", instance_name="inst-a", trigger="test", summary_id=1  # type: ignore[arg-type]
    )
    assert ("sonarr", "inst-a") in lock_calls, "the tombstone pass must serialise on the source lock"


# --- Step 3b: mass-tombstone guard ------------------------------------------------


@pytest.mark.asyncio
async def test_empty_fetch_with_populated_warehouse_refuses_to_tombstone() -> None:
    session = GuardSession(warehouse_count=5)  # warehouse has live rows
    service = _service(session)

    with pytest.raises(RuntimeError, match="refusing to tombstone"):
        await service._sync_sonarr_full(
            service.default_clients["sonarr"],
            run_id=1,
            mode="full",
            instance_name="default",
            trigger="test",
            summary_id=1,
        )

    assert not any(
        "set deleted = true" in sql for sql, _ in session.statements
    ), "an empty fetch must not soft-delete a populated warehouse"


@pytest.mark.asyncio
async def test_empty_fetch_with_empty_warehouse_still_tombstones() -> None:
    # A genuinely empty library (warehouse also empty) is safe to reconcile.
    session = GuardSession(warehouse_count=0)
    service = _service(session)

    records = await service._sync_sonarr_full(
        service.default_clients["sonarr"],
        run_id=1,
        mode="full",
        instance_name="default",
        trigger="test",
        summary_id=1,
    )
    assert records == 0
    tombstones = [sql for sql, _ in session.statements if "set deleted = true" in sql]
    assert len(tombstones) == 3, "series, episode and episode_file tombstones still run"


# --- Step 2: real Postgres interleaving (skipped without a database) ----------------


@pytest.mark.integration
@pytest.mark.skipif(
    not os.getenv("NEBULARR_TEST_DATABASE_URL", "").strip(),
    reason="NEBULARR_TEST_DATABASE_URL not set",
)
def test_advisory_lock_executes_on_real_postgres() -> None:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(os.environ["NEBULARR_TEST_DATABASE_URL"].strip(), future=True)
    factory = sessionmaker(bind=engine, future=True)
    try:
        s1 = factory()
        s2 = factory()
        # Two transactions taking the same key: the lock is transaction-scoped, so
        # both acquire it once their peer's transaction ends. Here we just assert
        # the dialect-detected SQL runs without error on a real backend.
        acquire_source_write_lock(s1, "sonarr", "default")
        s1.commit()
        acquire_source_write_lock(s2, "sonarr", "default")
        s2.commit()
        s1.close()
        s2.close()
    finally:
        engine.dispose()
