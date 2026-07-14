from __future__ import annotations

import asyncio
import contextlib
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from arrsync.db import session_scope
from arrsync.models import CapabilitySet, SyncResult
from arrsync.services.arr_client import ArrClient
from arrsync.services import repository as repo
from arrsync.services.retention_store import read_retention_policy

log = logging.getLogger(__name__)


class SyncService:
    # Lease is 1800s (repo.try_job_lock); renew well inside it so a long full
    # sync never loses its lock to a concurrent trigger.
    LOCK_HEARTBEAT_INTERVAL_SECONDS: float = 300.0

    def __init__(
        self,
        session_factory: Any,
        sonarr: ArrClient,
        radarr: ArrClient,
        *,
        stop_event: asyncio.Event | None = None,
        event_bus: Any | None = None,
    ):
        self.session_factory = session_factory
        self.default_clients = {"sonarr": sonarr, "radarr": radarr}
        self.lock_owner_id = str(uuid.uuid4())
        self.stop_event = stop_event
        self.event_bus = event_bus
        self._client_cache: dict[tuple[str, str, str, str], ArrClient] = {}

    def _publish(self, event_type: str, data: dict[str, Any]) -> None:
        if self.event_bus is not None:
            self.event_bus.publish(event_type, data)

    def _should_stop(self) -> bool:
        return bool(self.stop_event and self.stop_event.is_set())

    def _fetch_chunk_size(self, client: ArrClient) -> int:
        # Twice the HTTP concurrency bound: enough fan-out to keep the
        # semaphore saturated without spawning one task per series.
        parallel = getattr(getattr(client, "settings", None), "http_max_parallel_requests", None)
        return max(1, int(parallel or 4) * 2)

    async def _heartbeat_lock_loop(self, lock_name: str) -> None:
        while not self._should_stop():
            await asyncio.sleep(self.LOCK_HEARTBEAT_INTERVAL_SECONDS)
            try:
                await self._run_db(
                    repo.heartbeat_job_lock, lock_name=lock_name, owner_id=self.lock_owner_id
                )
            except Exception:
                # A missed renewal must not kill the sync; the next tick retries.
                log.warning("job lock heartbeat failed", extra={"lock_name": lock_name}, exc_info=True)

    async def _run_db(self, fn: Any, /, *args: Any, **kwargs: Any) -> Any:
        """Run a repository call in a worker thread with its own short session,
        so synchronous SQLAlchemy work never blocks the event loop."""

        def _call() -> Any:
            with session_scope(self.session_factory) as session:
                return fn(session, *args, **kwargs)

        return await asyncio.to_thread(_call)

    @staticmethod
    def _prune_per_retention_policy(session: Any) -> None:
        policy = read_retention_policy(session)
        repo.prune_old_rows(
            session,
            keep_days=policy["queue_days"],
            sync_run_days=policy["sync_run_days"],
            stat_snapshot_days=policy["stat_snapshot_days"],
        )

    def _report_progress(
        self,
        run_id: int,
        source: str,
        mode: str,
        instance_name: str,
        records_processed: int,
        trigger: str,
        stage: str,
        stage_note: str | None = None,
    ) -> None:
        with session_scope(self.session_factory) as session:
            repo.update_sync_run_progress(
                session,
                run_id=run_id,
                source=source,
                mode=mode,
                instance_name=instance_name,
                records_processed=records_processed,
                details={
                    "trigger": trigger,
                    "instance_name": instance_name,
                    "stage": stage,
                    "stage_note": stage_note or "",
                },
            )
        self._publish(
            "sync.progress",
            {
                "run_id": run_id,
                "source": source,
                "mode": mode,
                "instance_name": instance_name,
                "records_processed": records_processed,
                "stage": stage,
            },
        )

    async def _report_progress_async(self, *args: Any, **kwargs: Any) -> None:
        await asyncio.to_thread(self._report_progress, *args, **kwargs)

    async def detect_capabilities(self) -> None:
        for source in ("sonarr", "radarr"):
            for integration in self._enabled_integrations(source):
                client = self._client_for_integration(source, integration)
                try:
                    caps = await client.detect_capabilities()
                except Exception as exc:
                    # Capability discovery should never block startup; keep service healthy even if Arr is down.
                    log.warning("capability detection failed for %s/%s: %s", source, integration["name"], str(exc))
                    caps = CapabilitySet(
                        source=source,
                        app_version="unknown",
                        supports_history=False,
                        supports_episode_include_files=False,
                        raw={"error": str(exc)},
                        supports_history_since=False,
                    )
                await asyncio.to_thread(self._record_capabilities, source, integration["name"], caps)
                log.info(
                    "capabilities detected",
                    extra={"sync_run_id": f"{source}:{integration['name']}:capabilities"},
                )

    def _record_capabilities(self, source: str, instance_name: str, caps: CapabilitySet) -> None:
        with session_scope(self.session_factory) as session:
            repo.record_capabilities(session, caps, instance_name=instance_name)
            repo.update_watermark_for_instance(session, source, instance_name, None, None)

    def _maybe_capture_stats_snapshot(self) -> None:
        """At most one opportunistic snapshot per day, so trend charts populate
        after the first successful full sync without waiting for the cron job."""
        with session_scope(self.session_factory) as session:
            if repo.has_library_stat_snapshot_today(session):
                return
            repo.capture_library_stat_snapshot(session)

    async def run_integrity_audit(self, source: str, reason: str = "manual") -> list[dict[str, Any]]:
        """Compare cheap Arr API aggregates against warehouse counts and record drift.

        Reads only list endpoints (no per-item fan-out), so it is safe to run on
        a schedule even against large libraries.
        """
        results: list[dict[str, Any]] = []
        integrations = await asyncio.to_thread(self._enabled_integrations, source)
        for integration in integrations:
            instance_name = str(integration["name"])
            run_id = await self._run_db(repo.start_integrity_audit_run, source, instance_name)
            try:
                client = self._client_for_integration(source, integration)
                if source == "sonarr":
                    series = await client.list_series()
                    arr_counts = {
                        "item_count": len(series),
                        "file_count": sum(
                            int((s.get("statistics") or {}).get("episodeFileCount", 0) or 0) for s in series
                        ),
                        "size_bytes": sum(
                            int((s.get("statistics") or {}).get("sizeOnDisk", 0) or 0) for s in series
                        ),
                    }
                else:
                    movies = await client.list_movies()
                    arr_counts = {
                        "item_count": len(movies),
                        "file_count": sum(1 for m in movies if m.get("hasFile")),
                        "size_bytes": sum(int(m.get("sizeOnDisk", 0) or 0) for m in movies),
                    }
                warehouse_counts = await self._run_db(repo.warehouse_integrity_counts, source, instance_name)
                drift = {key: int(arr_counts[key]) - int(warehouse_counts[key]) for key in arr_counts}
                # Size deltas alone are not drift: Arr's sizeOnDisk includes extras
                # (subtitles, NFOs) the warehouse never tracks per file.
                drift_detected = drift["item_count"] != 0 or drift["file_count"] != 0
                await self._run_db(
                    repo.finish_integrity_audit_run,
                    run_id,
                    status="success",
                    arr_counts=arr_counts,
                    warehouse_counts=warehouse_counts,
                    drift=drift,
                    drift_detected=drift_detected,
                )
                results.append(
                    {
                        "source": source,
                        "instance_name": instance_name,
                        "status": "success",
                        "arr_counts": arr_counts,
                        "warehouse_counts": warehouse_counts,
                        "drift": drift,
                        "drift_detected": drift_detected,
                    }
                )
                log.info(
                    "integrity audit finished",
                    extra={
                        "source": source,
                        "instance_name": instance_name,
                        "trigger": reason,
                        "drift_detected": drift_detected,
                    },
                )
            except Exception as exc:
                await self._run_db(
                    repo.finish_integrity_audit_run, run_id, status="failed", error_message=str(exc)
                )
                results.append(
                    {
                        "source": source,
                        "instance_name": instance_name,
                        "status": "failed",
                        "error": str(exc),
                    }
                )
                log.warning(
                    "integrity audit failed",
                    extra={"source": source, "instance_name": instance_name, "trigger": reason, "error": str(exc)},
                )
        return results

    async def run_sync(self, source: str, mode: str, reason: str = "manual") -> SyncResult:
        started = datetime.now(timezone.utc)
        total_records = 0
        if self._should_stop():
            log.debug(
                "sync skipped (shutdown)",
                extra={"source": source, "mode": mode, "trigger": reason},
            )
            return SyncResult(
                source=source,
                mode=mode,
                status="skipped",
                records_processed=0,
                started_at=started,
                finished_at=datetime.now(timezone.utc),
                details={"reason": "shutting-down", "trigger": reason},
            )
        lock_name = f"{source}:{mode}"
        lock_acquired = await self._run_db(
            repo.try_job_lock, lock_name=lock_name, owner_id=self.lock_owner_id
        )
        if not lock_acquired:
            log.warning(
                "sync skipped (lock busy)",
                extra={"source": source, "mode": mode, "trigger": reason, "lock_name": lock_name},
            )
            return SyncResult(
                source=source,
                mode=mode,
                status="skipped",
                records_processed=0,
                started_at=started,
                finished_at=datetime.now(timezone.utc),
                details={"reason": "lock-busy", "trigger": reason},
            )
        heartbeat_task = asyncio.create_task(self._heartbeat_lock_loop(lock_name))
        try:
            log.info("sync started", extra={"source": source, "mode": mode, "trigger": reason})
            integrations = await asyncio.to_thread(self._enabled_integrations, source)
            for integration in integrations:
                if self._should_stop():
                    break
                instance_name = integration["name"]
                client = self._client_for_integration(source, integration)
                log.debug(
                    "sync instance",
                    extra={"source": source, "mode": mode, "instance_name": instance_name, "trigger": reason},
                )
                records_processed = 0
                run_id: int = await self._run_db(
                    repo.create_sync_run, source, mode, instance_name=instance_name, trigger=reason
                )
                try:
                    if source == "sonarr":
                        if mode in {"full", "reconcile"}:
                            records_processed = await self._sync_sonarr_full(client, run_id, mode, instance_name, reason)
                        else:
                            records_processed = await self._sync_incremental(source, client, run_id, instance_name, reason)
                    else:
                        if mode in {"full", "reconcile"}:
                            records_processed = await self._sync_radarr_full(client, run_id, mode, instance_name, reason)
                        else:
                            records_processed = await self._sync_incremental(source, client, run_id, instance_name, reason)
                    interrupted = self._should_stop()
                    await self._run_db(
                        repo.finish_sync_run,
                        run_id=run_id,
                        source=source,
                        mode=mode,
                        status="failed" if interrupted else "success",
                        records_processed=records_processed,
                        details={
                            "trigger": reason,
                            "instance_name": instance_name,
                            "interrupted": interrupted,
                        },
                        error_message="stopped by shutdown signal" if interrupted else None,
                        instance_name=instance_name,
                    )
                    self._publish(
                        "sync.finished",
                        {
                            "run_id": run_id,
                            "source": source,
                            "mode": mode,
                            "instance_name": instance_name,
                            "status": "failed" if interrupted else "success",
                            "records_processed": records_processed,
                            "trigger": reason,
                        },
                    )
                except Exception as exc:
                    await self._run_db(
                        repo.finish_sync_run,
                        run_id=run_id,
                        source=source,
                        mode=mode,
                        status="failed",
                        records_processed=records_processed,
                        details={"trigger": reason, "instance_name": instance_name},
                        error_message=str(exc),
                        instance_name=instance_name,
                    )
                    self._publish(
                        "sync.finished",
                        {
                            "run_id": run_id,
                            "source": source,
                            "mode": mode,
                            "instance_name": instance_name,
                            "status": "failed",
                            "records_processed": records_processed,
                            "trigger": reason,
                            "error": str(exc),
                        },
                    )
                    raise
                total_records += records_processed
                if self._should_stop():
                    break
            if mode in {"full", "reconcile"} and not self._should_stop():
                try:
                    await asyncio.to_thread(self._maybe_capture_stats_snapshot)
                except Exception:
                    log.warning("post-sync library stats snapshot failed", exc_info=True)
            finished = datetime.now(timezone.utc)
            log.info(
                "sync finished",
                extra={
                    "source": source,
                    "mode": mode,
                    "trigger": reason,
                    "records_processed": total_records,
                    "interrupted": self._should_stop(),
                },
            )
            return SyncResult(
                source=source,
                mode=mode,
                status="failed" if self._should_stop() else "success",
                records_processed=total_records,
                started_at=started,
                finished_at=finished,
                details={"trigger": reason, "interrupted": self._should_stop()},
            )
        finally:
            heartbeat_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await heartbeat_task
            await self._run_db(repo.release_job_lock, lock_name=lock_name, owner_id=self.lock_owner_id)

    def _enabled_integrations(self, source: str) -> list[dict[str, Any]]:
        with session_scope(self.session_factory) as session:
            integrations = repo.list_enabled_integrations(session, source)
        return integrations

    def _client_for_integration(self, source: str, integration: dict[str, Any]) -> ArrClient:
        # Cache clients per integration identity so a run (and subsequent runs)
        # reuse one warm httpx connection pool instead of re-handshaking.
        # A changed base_url or api_key produces a new key, so config edits
        # naturally get a fresh client; the stale one is closed lazily.
        key = (
            source,
            str(integration["name"]),
            str(integration["base_url"]),
            str(integration.get("api_key", "")),
        )
        client = self._client_cache.get(key)
        if client is None:
            client = ArrClient(
                self.default_clients[source].settings,
                source,
                instance_name=integration["name"],
                base_url=integration["base_url"],
                api_key=integration.get("api_key", ""),
            )
            self._client_cache[key] = client
        return client

    async def aclose(self) -> None:
        clients = list(self._client_cache.values())
        self._client_cache.clear()
        for client in clients:
            try:
                await client.aclose()
            except Exception:  # pragma: no cover - best-effort shutdown
                log.debug("error closing cached arr client", exc_info=True)

    def _integration_by_name(self, source: str, instance_name: str) -> dict[str, Any]:
        candidates = self._enabled_integrations(source)
        for candidate in candidates:
            if candidate["name"] == instance_name:
                return candidate
        return {"name": instance_name, "base_url": self.default_clients[source].base_url, "api_key": self.default_clients[source].api_key}

    async def _sync_sonarr_full(
        self,
        client: ArrClient,
        run_id: int,
        mode: str,
        instance_name: str,
        trigger: str,
    ) -> int:
        await self._report_progress_async(run_id, "sonarr", mode, instance_name, 0, trigger, "fetching_series")
        series = await client.list_series()
        records = 0
        seen_series: set[int] = set()
        seen_episodes: set[int] = set()
        seen_episode_files: set[int] = set()
        await self._report_progress_async(
            run_id,
            "sonarr",
            mode,
            instance_name,
            records,
            trigger,
            "syncing_episodes",
            f"series_count={len(series)}",
        )
        chunk_size = self._fetch_chunk_size(client)
        for start in range(0, len(series), chunk_size):
            if self._should_stop():
                break
            chunk = series[start : start + chunk_size]
            episode_lists = await asyncio.gather(
                *(client.list_episodes(int(series_row["id"])) for series_row in chunk)
            )
            records += await asyncio.to_thread(
                self._write_sonarr_chunk,
                list(zip(chunk, episode_lists)),
                run_id,
                mode,
                instance_name,
                seen_series,
                seen_episodes,
                seen_episode_files,
            )
            await self._report_progress_async(
                run_id,
                "sonarr",
                mode,
                instance_name,
                records,
                trigger,
                "syncing_episodes",
            )
        if not self._should_stop():
            # Tombstones require a complete seen-set; skipping them on an
            # interrupted run prevents mass soft-deletes of unfetched rows.
            await self._report_progress_async(
                run_id, "sonarr", mode, instance_name, records, trigger, "reconciling_tombstones"
            )
            await asyncio.to_thread(
                self._mark_full_sync_tombstones,
                instance_name,
                [
                    ("warehouse.series", seen_series),
                    ("warehouse.episode", seen_episodes),
                    ("warehouse.episode_file", seen_episode_files),
                ],
            )
        await self._report_progress_async(run_id, "sonarr", mode, instance_name, records, trigger, "finalizing")
        return records

    def _write_sonarr_chunk(
        self,
        chunk: list[tuple[dict[str, Any], list[dict[str, Any]]]],
        run_id: int,
        mode: str,
        instance_name: str,
        seen_series: set[int],
        seen_episodes: set[int],
        seen_episode_files: set[int],
    ) -> int:
        records = 0
        with session_scope(self.session_factory) as session:
            for series_row, episodes in chunk:
                sid = int(series_row["id"])
                seen_series.add(sid)
                repo.upsert_series(session, instance_name, series_row, run_id, mode)
                for episode in episodes:
                    eid = int(episode["id"])
                    seen_episodes.add(eid)
                    repo.upsert_episode(session, instance_name, episode, run_id, mode)
                    episode_file = episode.get("episodeFile")
                    if episode_file and isinstance(episode_file, dict) and episode_file.get("id"):
                        efid = int(episode_file["id"])
                        seen_episode_files.add(efid)
                        repo.upsert_episode_file(session, instance_name, eid, episode_file, run_id, mode)
                    records += 1
        return records

    def _mark_full_sync_tombstones(
        self,
        instance_name: str,
        tables_and_seen: list[tuple[str, set[int]]],
    ) -> None:
        with session_scope(self.session_factory) as session:
            for table, seen_ids in tables_and_seen:
                repo.mark_tombstones(session, table, instance_name, seen_ids)

    async def _sync_radarr_full(
        self,
        client: ArrClient,
        run_id: int,
        mode: str,
        instance_name: str,
        trigger: str,
    ) -> int:
        await self._report_progress_async(run_id, "radarr", mode, instance_name, 0, trigger, "fetching_movies")
        movies = await client.list_movies()
        records = 0
        seen_movies: set[int] = set()
        seen_movie_files: set[int] = set()
        await self._report_progress_async(
            run_id,
            "radarr",
            mode,
            instance_name,
            records,
            trigger,
            "syncing_movies",
            f"movie_count={len(movies)}",
        )
        write_batch = 200
        for start in range(0, len(movies), write_batch):
            if self._should_stop():
                break
            batch = movies[start : start + write_batch]
            records += await asyncio.to_thread(
                self._write_radarr_chunk,
                batch,
                run_id,
                mode,
                instance_name,
                seen_movies,
                seen_movie_files,
            )
            await self._report_progress_async(
                run_id,
                "radarr",
                mode,
                instance_name,
                records,
                trigger,
                "syncing_movies",
            )
        if not self._should_stop():
            await self._report_progress_async(
                run_id, "radarr", mode, instance_name, records, trigger, "reconciling_tombstones"
            )
            await asyncio.to_thread(
                self._mark_full_sync_tombstones,
                instance_name,
                [
                    ("warehouse.movie", seen_movies),
                    ("warehouse.movie_file", seen_movie_files),
                ],
            )
        await self._report_progress_async(run_id, "radarr", mode, instance_name, records, trigger, "finalizing")
        return records

    def _write_radarr_chunk(
        self,
        batch: list[dict[str, Any]],
        run_id: int,
        mode: str,
        instance_name: str,
        seen_movies: set[int],
        seen_movie_files: set[int],
    ) -> int:
        records = 0
        with session_scope(self.session_factory) as session:
            for movie in batch:
                mid = int(movie["id"])
                seen_movies.add(mid)
                repo.upsert_movie(session, instance_name, movie, run_id, mode)
                movie_file = movie.get("movieFile")
                if movie_file and isinstance(movie_file, dict) and movie_file.get("id"):
                    mfid = int(movie_file["id"])
                    seen_movie_files.add(mfid)
                    repo.upsert_movie_file(session, instance_name, mid, movie_file, run_id, mode)
                records += 1
        return records

    async def _sync_incremental(
        self,
        source: str,
        client: ArrClient,
        run_id: int,
        instance_name: str,
        trigger: str,
    ) -> int:
        await self._report_progress_async(run_id, source, "incremental", instance_name, 0, trigger, "fetching_history")
        since, _ = await self._run_db(repo.get_watermark_for_instance, source, instance_name)
        events = await client.list_history_since(since)
        log.debug(
            "incremental history batch",
            extra={"source": source, "instance_name": instance_name, "event_count": len(events)},
        )
        latest_time: datetime | None = None
        latest_id: int | None = None
        for event in events:
            event_id = int(event.get("id", 0) or 0)
            date_str = event.get("date")
            if date_str:
                try:
                    parsed = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
                except ValueError:
                    # One malformed date from the Arr API must not fail the whole
                    # incremental run; the id watermark still advances below.
                    log.warning(
                        "skipping unparsable history event date",
                        extra={
                            "source": source,
                            "instance_name": instance_name,
                            "event_id": event_id,
                            "date": str(date_str)[:64],
                        },
                    )
                else:
                    latest_time = max(latest_time, parsed) if latest_time else parsed
            latest_id = max(latest_id, event_id) if latest_id else event_id

        records = 0
        if since is None:
            # First incremental run: only establish the watermark. Backfilling
            # everything history mentions is the full sync's job.
            log.info(
                "incremental watermark established; full sync remains authoritative",
                extra={"source": source, "instance_name": instance_name, "event_count": len(events)},
            )
        elif events:
            await self._report_progress_async(
                run_id,
                source,
                "incremental",
                instance_name,
                records,
                trigger,
                "ingesting_changes",
                f"event_count={len(events)}",
            )
            if source == "sonarr":
                records = await self._ingest_sonarr_history_changes(
                    client, events, run_id, instance_name, trigger
                )
            else:
                records = await self._ingest_radarr_history_changes(
                    client, events, run_id, instance_name, trigger
                )
        if self._should_stop():
            # An interrupted ingest must not advance the watermark past
            # changes it never wrote; the next run re-fetches them.
            return records
        await self._run_db(repo.update_watermark_for_instance, source, instance_name, latest_time, latest_id)
        await self._report_progress_async(run_id, source, "incremental", instance_name, records, trigger, "finalizing")
        return records

    async def _ingest_sonarr_history_changes(
        self,
        client: ArrClient,
        events: list[dict[str, Any]],
        run_id: int,
        instance_name: str,
        trigger: str,
    ) -> int:
        series_ids = sorted(
            {int(event["seriesId"]) for event in events if isinstance(event, dict) and event.get("seriesId")}
        )
        records = 0
        chunk_size = self._fetch_chunk_size(client)
        for start in range(0, len(series_ids), chunk_size):
            if self._should_stop():
                break
            chunk_ids = series_ids[start : start + chunk_size]
            series_rows = await asyncio.gather(*(client.get_series(sid) for sid in chunk_ids))
            present = [(sid, row) for sid, row in zip(chunk_ids, series_rows) if row and row.get("id")]
            deleted_ids = [sid for sid, row in zip(chunk_ids, series_rows) if row is None]
            episode_lists = await asyncio.gather(*(client.list_episodes(sid) for sid, _row in present))
            seen_series: set[int] = set()
            seen_episodes: set[int] = set()
            seen_files: set[int] = set()
            records += await asyncio.to_thread(
                self._write_sonarr_chunk,
                [(row, episodes) for (_sid, row), episodes in zip(present, episode_lists)],
                run_id,
                "incremental",
                instance_name,
                seen_series,
                seen_episodes,
                seen_files,
            )
            await asyncio.to_thread(
                self._reconcile_incremental_sonarr,
                instance_name,
                sorted(seen_series),
                seen_episodes,
                seen_files,
                deleted_ids,
            )
            await self._report_progress_async(
                run_id, "sonarr", "incremental", instance_name, records, trigger, "ingesting_changes"
            )
        return records

    def _reconcile_incremental_sonarr(
        self,
        instance_name: str,
        refreshed_series: list[int],
        seen_episodes: set[int],
        seen_files: set[int],
        deleted_series: list[int],
    ) -> None:
        with session_scope(self.session_factory) as session:
            repo.mark_missing_children(
                session, "warehouse.episode", instance_name, "series_source_id", refreshed_series, seen_episodes
            )
            repo.mark_missing_children(
                session,
                "warehouse.episode_file",
                instance_name,
                "episode_source_id",
                sorted(seen_episodes),
                seen_files,
            )
            repo.mark_deleted_source_ids(session, "warehouse.series", instance_name, deleted_series)
            repo.mark_missing_children(
                session, "warehouse.episode", instance_name, "series_source_id", deleted_series, set()
            )

    async def _ingest_radarr_history_changes(
        self,
        client: ArrClient,
        events: list[dict[str, Any]],
        run_id: int,
        instance_name: str,
        trigger: str,
    ) -> int:
        movie_ids = sorted(
            {int(event["movieId"]) for event in events if isinstance(event, dict) and event.get("movieId")}
        )
        records = 0
        chunk_size = self._fetch_chunk_size(client)
        for start in range(0, len(movie_ids), chunk_size):
            if self._should_stop():
                break
            chunk_ids = movie_ids[start : start + chunk_size]
            movie_rows = await asyncio.gather(*(client.get_movie(mid) for mid in chunk_ids))
            present = [row for row in movie_rows if row and row.get("id")]
            deleted_ids = [mid for mid, row in zip(chunk_ids, movie_rows) if row is None]
            seen_movies: set[int] = set()
            seen_movie_files: set[int] = set()
            records += await asyncio.to_thread(
                self._write_radarr_chunk,
                present,
                run_id,
                "incremental",
                instance_name,
                seen_movies,
                seen_movie_files,
            )
            await asyncio.to_thread(
                self._reconcile_incremental_radarr,
                instance_name,
                sorted(seen_movies),
                seen_movie_files,
                deleted_ids,
            )
            await self._report_progress_async(
                run_id, "radarr", "incremental", instance_name, records, trigger, "ingesting_changes"
            )
        return records

    def _reconcile_incremental_radarr(
        self,
        instance_name: str,
        refreshed_movies: list[int],
        seen_movie_files: set[int],
        deleted_movies: list[int],
    ) -> None:
        with session_scope(self.session_factory) as session:
            repo.mark_missing_children(
                session,
                "warehouse.movie_file",
                instance_name,
                "movie_source_id",
                refreshed_movies,
                seen_movie_files,
            )
            repo.mark_deleted_source_ids(session, "warehouse.movie", instance_name, deleted_movies)
            repo.mark_missing_children(
                session, "warehouse.movie_file", instance_name, "movie_source_id", deleted_movies, set()
            )

    async def process_webhook_queue(self, source: str) -> dict[str, Any]:
        processed = 0
        failed = 0
        batch_size = 80
        max_rounds = 30
        for round_idx in range(max_rounds):
            if self._should_stop():
                break
            jobs = await self._run_db(repo.claim_webhook_jobs, source, batch_size=batch_size)
            if not jobs:
                break
            log.debug(
                "webhook queue drain batch",
                extra={"source": source, "round": round_idx + 1, "job_count": len(jobs)},
            )
            for job in jobs:
                if self._should_stop():
                    break
                try:
                    payload = job["payload"] or {}
                    event_type = str(job.get("event_type", "unknown"))
                    mode = "webhook"
                    job_source = str(job.get("source", source))
                    if job_source == "sonarr":
                        instance_name = payload.get("instance_name", "default")
                        client = self._client_for_integration(
                            job_source, self._integration_by_name(job_source, instance_name)
                        )
                        run_id = await self._run_db(
                            repo.create_sync_run,
                            job_source,
                            mode,
                            instance_name=instance_name,
                            trigger="webhook",
                        )
                        series_id = (payload.get("series") or {}).get("id")
                        if series_id:
                            episodes = await client.list_episodes(int(series_id))
                            await asyncio.to_thread(
                                self._write_webhook_episodes, instance_name, episodes, run_id, mode
                            )
                        if "delete" in event_type.lower():
                            deleted_episode_ids = (
                                [int(payload["episode"]["id"])] if (payload.get("episode") or {}).get("id") else []
                            )
                            await self._run_db(
                                repo.mark_deleted_source_ids,
                                "warehouse.episode",
                                instance_name,
                                deleted_episode_ids,
                            )
                        await self._run_db(
                            repo.finish_sync_run,
                            run_id=run_id,
                            source=job_source,
                            mode=mode,
                            status="success",
                            records_processed=1,
                            details={"event_type": event_type, "instance_name": instance_name},
                            instance_name=instance_name,
                        )
                    else:
                        instance_name = payload.get("instance_name", "default")
                        client = self._client_for_integration(
                            job_source, self._integration_by_name(job_source, instance_name)
                        )
                        run_id = await self._run_db(
                            repo.create_sync_run,
                            job_source,
                            mode,
                            instance_name=instance_name,
                            trigger="webhook",
                        )
                        movie_id = (payload.get("movie") or {}).get("id")
                        if movie_id:
                            movie_row = await client.get_movie(int(movie_id))
                            movies = [movie_row] if movie_row else []
                        else:
                            movies = await client.list_movies()
                        deleted_movie_ids = (
                            [int(payload["movie"]["id"])]
                            if "delete" in event_type.lower() and (payload.get("movie") or {}).get("id")
                            else []
                        )
                        await asyncio.to_thread(
                            self._write_webhook_movies,
                            instance_name,
                            movies,
                            run_id,
                            mode,
                            deleted_movie_ids,
                            job_source,
                            event_type,
                        )
                    await self._run_db(repo.mark_webhook_done, int(job["id"]))
                    processed += 1
                except Exception as exc:
                    log.warning(
                        "webhook job failed",
                        extra={
                            "source": source,
                            "job_id": int(job["id"]),
                            "event_type": str(job.get("event_type", "")),
                            "error": str(exc),
                        },
                    )
                    await self._run_db(
                        repo.mark_webhook_failed,
                        queue_id=int(job["id"]),
                        attempts=int(job["attempts"]),
                        error_message=str(exc),
                    )
                    # Mirrors the >= 5 dead-letter threshold in repo.mark_webhook_failed.
                    if int(job["attempts"]) >= 5:
                        self._publish(
                            "webhook.dead_letter",
                            {
                                "job_id": int(job["id"]),
                                "source": str(job.get("source", source)),
                                "event_type": str(job.get("event_type", "")),
                                "error": str(exc),
                            },
                        )
                    failed += 1
        await self._run_db(self._prune_per_retention_policy)
        if processed or failed:
            self._publish(
                "webhook.processed",
                {"source": source, "processed": processed, "failed": failed},
            )
        log.info(
            "webhook queue drain finished",
            extra={"source": source, "processed": processed, "failed": failed},
        )
        return {"processed": processed, "failed": failed}

    def _write_webhook_episodes(
        self,
        instance_name: str,
        episodes: list[dict[str, Any]],
        run_id: int,
        mode: str,
    ) -> None:
        with session_scope(self.session_factory) as session:
            for episode in episodes:
                repo.upsert_episode(session, instance_name, episode, run_id, mode)
                ep_file = episode.get("episodeFile")
                if ep_file and ep_file.get("id"):
                    repo.upsert_episode_file(
                        session, instance_name, int(episode["id"]), ep_file, run_id, mode
                    )

    def _write_webhook_movies(
        self,
        instance_name: str,
        movies: list[dict[str, Any]],
        run_id: int,
        mode: str,
        deleted_movie_ids: list[int],
        job_source: str,
        event_type: str,
    ) -> None:
        with session_scope(self.session_factory) as session:
            for movie in movies:
                repo.upsert_movie(session, instance_name, movie, run_id, mode)
                movie_file = movie.get("movieFile")
                if movie_file and movie_file.get("id"):
                    repo.upsert_movie_file(
                        session, instance_name, int(movie["id"]), movie_file, run_id, mode
                    )
            if deleted_movie_ids:
                repo.mark_deleted_source_ids(session, "warehouse.movie", instance_name, deleted_movie_ids)
            repo.finish_sync_run(
                session,
                run_id=run_id,
                source=job_source,
                mode=mode,
                status="success",
                records_processed=len(movies),
                details={"event_type": event_type, "instance_name": instance_name},
                instance_name=instance_name,
            )
