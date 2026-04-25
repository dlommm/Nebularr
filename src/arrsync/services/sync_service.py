from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session, sessionmaker

from arrsync.db import session_scope
from arrsync.models import CapabilitySet, SyncResult
from arrsync.services.arr_client import ArrClient
from arrsync.services import repository as repo

log = logging.getLogger(__name__)


class SyncService:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        sonarr: ArrClient,
        radarr: ArrClient,
        *,
        stop_event: asyncio.Event | None = None,
    ):
        self.session_factory = session_factory
        self.default_clients = {"sonarr": sonarr, "radarr": radarr}
        self.lock_owner_id = str(uuid.uuid4())
        self.stop_event = stop_event

    def _should_stop(self) -> bool:
        return bool(self.stop_event and self.stop_event.is_set())

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
                    )
                with session_scope(self.session_factory) as session:
                    repo.record_capabilities(session, caps, instance_name=integration["name"])
                    repo.update_watermark_for_instance(session, source, integration["name"], None, None)
                log.info(
                    "capabilities detected",
                    extra={"sync_run_id": f"{source}:{integration['name']}:capabilities"},
                )

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
        with session_scope(self.session_factory) as lock_session:
            if not repo.try_job_lock(lock_session, lock_name=lock_name, owner_id=self.lock_owner_id):
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
        try:
            log.info("sync started", extra={"source": source, "mode": mode, "trigger": reason})
            for integration in self._enabled_integrations(source):
                if self._should_stop():
                    break
                instance_name = integration["name"]
                client = self._client_for_integration(source, integration)
                log.debug(
                    "sync instance",
                    extra={"source": source, "mode": mode, "instance_name": instance_name, "trigger": reason},
                )
                run_id: int | None = None
                records_processed = 0
                with session_scope(self.session_factory) as session:
                    repo.heartbeat_job_lock(
                        session,
                        lock_name=lock_name,
                        owner_id=self.lock_owner_id,
                    )
                    run_id = repo.create_sync_run(
                        session,
                        source,
                        mode,
                        instance_name=instance_name,
                        trigger=reason,
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
                    with session_scope(self.session_factory) as session:
                        interrupted = self._should_stop()
                        repo.finish_sync_run(
                            session,
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
                except Exception as exc:
                    with session_scope(self.session_factory) as session:
                        repo.finish_sync_run(
                            session,
                            run_id=run_id,
                            source=source,
                            mode=mode,
                            status="failed",
                            records_processed=records_processed,
                            details={"trigger": reason, "instance_name": instance_name},
                            error_message=str(exc),
                            instance_name=instance_name,
                        )
                    raise
                total_records += records_processed
                if self._should_stop():
                    break
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
            with session_scope(self.session_factory) as session:
                repo.release_job_lock(session, lock_name=lock_name, owner_id=self.lock_owner_id)

    def _enabled_integrations(self, source: str) -> list[dict[str, Any]]:
        with session_scope(self.session_factory) as session:
            integrations = repo.list_enabled_integrations(session, source)
        return integrations

    def _client_for_integration(self, source: str, integration: dict[str, Any]) -> ArrClient:
        return ArrClient(
            self.default_clients[source].settings,
            source,
            instance_name=integration["name"],
            base_url=integration["base_url"],
            api_key=integration.get("api_key", ""),
        )

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
        self._report_progress(run_id, "sonarr", mode, instance_name, 0, trigger, "fetching_series")
        series = await client.list_series()
        records = 0
        seen_series: set[int] = set()
        seen_episodes: set[int] = set()
        seen_episode_files: set[int] = set()
        self._report_progress(
            run_id,
            "sonarr",
            mode,
            instance_name,
            records,
            trigger,
            "syncing_episodes",
            f"series_count={len(series)}",
        )
        with session_scope(self.session_factory) as session:
            for series_row in series:
                if self._should_stop():
                    break
                sid = int(series_row["id"])
                seen_series.add(sid)
                repo.upsert_series(session, instance_name, series_row, run_id, mode)
                episodes = await client.list_episodes(sid)
                for episode in episodes:
                    if self._should_stop():
                        break
                    eid = int(episode["id"])
                    seen_episodes.add(eid)
                    repo.upsert_episode(session, instance_name, episode, run_id, mode)
                    episode_file = episode.get("episodeFile")
                    if episode_file and isinstance(episode_file, dict) and episode_file.get("id"):
                        efid = int(episode_file["id"])
                        seen_episode_files.add(efid)
                        repo.upsert_episode_file(session, instance_name, eid, episode_file, run_id, mode)
                    records += 1
                    if records % 50 == 0:
                        self._report_progress(
                            run_id,
                            "sonarr",
                            mode,
                            instance_name,
                            records,
                            trigger,
                            "syncing_episodes",
                        )
            self._report_progress(run_id, "sonarr", mode, instance_name, records, trigger, "reconciling_tombstones")
            repo.mark_tombstones(session, "warehouse.series", instance_name, seen_series)
            repo.mark_tombstones(session, "warehouse.episode", instance_name, seen_episodes)
            repo.mark_tombstones(session, "warehouse.episode_file", instance_name, seen_episode_files)
        self._report_progress(run_id, "sonarr", mode, instance_name, records, trigger, "finalizing")
        return records

    async def _sync_radarr_full(
        self,
        client: ArrClient,
        run_id: int,
        mode: str,
        instance_name: str,
        trigger: str,
    ) -> int:
        self._report_progress(run_id, "radarr", mode, instance_name, 0, trigger, "fetching_movies")
        movies = await client.list_movies()
        records = 0
        seen_movies: set[int] = set()
        seen_movie_files: set[int] = set()
        self._report_progress(
            run_id,
            "radarr",
            mode,
            instance_name,
            records,
            trigger,
            "syncing_movies",
            f"movie_count={len(movies)}",
        )
        with session_scope(self.session_factory) as session:
            for movie in movies:
                if self._should_stop():
                    break
                mid = int(movie["id"])
                seen_movies.add(mid)
                repo.upsert_movie(session, instance_name, movie, run_id, mode)
                movie_file = movie.get("movieFile")
                if movie_file and isinstance(movie_file, dict) and movie_file.get("id"):
                    mfid = int(movie_file["id"])
                    seen_movie_files.add(mfid)
                    repo.upsert_movie_file(session, instance_name, mid, movie_file, run_id, mode)
                records += 1
                if records % 50 == 0:
                    self._report_progress(
                        run_id,
                        "radarr",
                        mode,
                        instance_name,
                        records,
                        trigger,
                        "syncing_movies",
                    )
            self._report_progress(run_id, "radarr", mode, instance_name, records, trigger, "reconciling_tombstones")
            repo.mark_tombstones(session, "warehouse.movie", instance_name, seen_movies)
            repo.mark_tombstones(session, "warehouse.movie_file", instance_name, seen_movie_files)
        self._report_progress(run_id, "radarr", mode, instance_name, records, trigger, "finalizing")
        return records

    async def _sync_incremental(
        self,
        source: str,
        client: ArrClient,
        run_id: int,
        instance_name: str,
        trigger: str,
    ) -> int:
        self._report_progress(run_id, source, "incremental", instance_name, 0, trigger, "fetching_history")
        with session_scope(self.session_factory) as session:
            since, _ = repo.get_watermark_for_instance(session, source, instance_name)
        events = await client.list_history_since(since)
        log.debug(
            "incremental history batch",
            extra={"source": source, "instance_name": instance_name, "event_count": len(events)},
        )
        records = 0
        latest_time: datetime | None = None
        latest_id: int | None = None
        self._report_progress(
            run_id,
            source,
            "incremental",
            instance_name,
            records,
            trigger,
            "processing_history",
            f"event_count={len(events)}",
        )
        with session_scope(self.session_factory) as session:
            for event in events:
                if self._should_stop():
                    break
                event_id = int(event.get("id", 0) or 0)
                records += 1
                date_str = event.get("date")
                if date_str:
                    parsed = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
                    latest_time = max(latest_time, parsed) if latest_time else parsed
                latest_id = max(latest_id, event_id) if latest_id else event_id
                if records % 100 == 0:
                    self._report_progress(
                        run_id,
                        source,
                        "incremental",
                        instance_name,
                        records,
                        trigger,
                        "processing_history",
                    )
            repo.update_watermark_for_instance(session, source, instance_name, latest_time, latest_id)
        self._report_progress(run_id, source, "incremental", instance_name, records, trigger, "finalizing")
        return records

    async def process_webhook_queue(self, source: str) -> dict[str, Any]:
        processed = 0
        failed = 0
        batch_size = 80
        max_rounds = 30
        for round_idx in range(max_rounds):
            if self._should_stop():
                break
            with session_scope(self.session_factory) as session:
                jobs = repo.claim_webhook_jobs(session, source, batch_size=batch_size)
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
                        with session_scope(self.session_factory) as session:
                            run_id = repo.create_sync_run(
                                session,
                                job_source,
                                mode,
                                instance_name=instance_name,
                                trigger="webhook",
                            )
                        series_id = payload.get("series", {}).get("id")
                        if series_id:
                            episodes = await client.list_episodes(int(series_id))
                            with session_scope(self.session_factory) as session:
                                for episode in episodes:
                                    repo.upsert_episode(session, instance_name, episode, run_id, mode)
                                    ep_file = episode.get("episodeFile")
                                    if ep_file and ep_file.get("id"):
                                        repo.upsert_episode_file(
                                            session, instance_name, int(episode["id"]), ep_file, run_id, mode
                                        )
                        if "delete" in event_type.lower():
                            deleted_episode_ids = (
                                [int(payload["episode"]["id"])] if payload.get("episode", {}).get("id") else []
                            )
                            with session_scope(self.session_factory) as session:
                                repo.mark_deleted_source_ids(
                                    session, "warehouse.episode", instance_name, deleted_episode_ids
                                )
                        with session_scope(self.session_factory) as session:
                            repo.finish_sync_run(
                                session,
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
                        with session_scope(self.session_factory) as session:
                            run_id = repo.create_sync_run(
                                session,
                                job_source,
                                mode,
                                instance_name=instance_name,
                                trigger="webhook",
                            )
                        movie_id = payload.get("movie", {}).get("id")
                        if movie_id:
                            movie_row = await client.get_movie(int(movie_id))
                            movies = [movie_row] if movie_row else []
                        else:
                            movies = await client.list_movies()
                        with session_scope(self.session_factory) as session:
                            for movie in movies:
                                repo.upsert_movie(session, instance_name, movie, run_id, mode)
                                movie_file = movie.get("movieFile")
                                if movie_file and movie_file.get("id"):
                                    repo.upsert_movie_file(
                                        session, instance_name, int(movie["id"]), movie_file, run_id, mode
                                    )
                            if "delete" in event_type.lower():
                                deleted_movie_ids = (
                                    [int(payload["movie"]["id"])] if payload.get("movie", {}).get("id") else []
                                )
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
                    with session_scope(self.session_factory) as session:
                        repo.mark_webhook_done(session, int(job["id"]))
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
                    with session_scope(self.session_factory) as session:
                        repo.mark_webhook_failed(
                            session,
                            queue_id=int(job["id"]),
                            attempts=int(job["attempts"]),
                            error_message=str(exc),
                        )
                    failed += 1
        with session_scope(self.session_factory) as session:
            repo.prune_old_rows(session)
        log.info(
            "webhook queue drain finished",
            extra={"source": source, "processed": processed, "failed": failed},
        )
        return {"processed": processed, "failed": failed}
