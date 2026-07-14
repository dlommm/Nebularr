from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

from arrsync.config import Settings
from arrsync.db import session_scope
from arrsync.mal import repository as mal_repo
from arrsync.mal.dub_sources import enabled_dub_sources, parse_dub_source_payload
from arrsync.mal.externals import externals_from_jikan_data
from arrsync.mal.http_clients import DubListClient, JikanClient, MalApiClient
from arrsync.services import repository as repo
from arrsync.services.mal_config_store import (
    read_mal_client_id,
    read_mal_feature_flags,
    read_mydublist_tier,
)

log = logging.getLogger(__name__)


class MalIngestAlreadyRunningError(RuntimeError):
    """Raised when a MAL ingest job is already in progress."""


def _ingest_batch_limit(settings: Settings, max_ids_per_run: int | None) -> int:
    """Use request override or env default, clamp to a safe range for one run."""
    raw = int(max_ids_per_run) if max_ids_per_run is not None else int(settings.mal_max_ids_per_run)
    return max(1, min(raw, 500))


class MalIngestService:
    # Lease is 3600s; renew well inside it so a slow throttled batch never
    # loses the lock to a concurrent ingest trigger.
    LOCK_HEARTBEAT_INTERVAL_SECONDS: float = 300.0

    def __init__(
        self,
        settings: Settings,
        session_factory: Any,
        *,
        dub_client_class: type[DubListClient] = DubListClient,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.dub_client_class = dub_client_class
        self.jikan_client = JikanClient(settings)

    async def _heartbeat_lock_loop(self, lock_name: str, owner_id: str) -> None:
        while True:
            await asyncio.sleep(self.LOCK_HEARTBEAT_INTERVAL_SECONDS)
            try:
                with session_scope(self.session_factory) as session:
                    repo.heartbeat_job_lock(
                        session, lock_name=lock_name, owner_id=owner_id, lease_seconds=3600
                    )
            except Exception:
                # A missed renewal must not kill the ingest; the next tick retries.
                log.warning("mal ingest lock heartbeat failed", exc_info=True)

    async def run(
        self,
        *,
        reason: str = "manual",
        max_ids_per_run: int | None = None,
    ) -> dict[str, Any]:
        details: dict[str, Any] = {
            "reason": reason,
            "dub_list_unchanged": False,
            "sources": {},
            "mal_api_calls": 0,
            "jikan_calls": 0,
        }
        batch_size = _ingest_batch_limit(self.settings, max_ids_per_run)
        details["max_ids_per_run"] = batch_size
        lock_name = "mal:ingest"
        owner_id = f"mal_ingest:{id(self)}"
        with session_scope(self.session_factory) as session:
            if not repo.try_job_lock(session, lock_name=lock_name, owner_id=owner_id, lease_seconds=3600):
                raise MalIngestAlreadyRunningError("MAL ingest is already running")
            run_id = mal_repo.insert_mal_job_run(session, "ingest")
            resolved_mal_client_id = read_mal_client_id(session, self.settings)
            flags = read_mal_feature_flags(session, self.settings)
            tier = read_mydublist_tier(session, self.settings)
        specs = enabled_dub_sources(self.settings, flags, tier)
        mal_client = MalApiClient(self.settings, client_id=resolved_mal_client_id)
        heartbeat_task = asyncio.create_task(self._heartbeat_lock_loop(lock_name, owner_id))
        try:
            source_errors: list[str] = []
            all_unchanged = bool(specs)
            for spec in specs:
                try:
                    client = self.dub_client_class(self.settings, url=spec.url)
                    raw_json, sha, http_status = await client.fetch()
                    dubbed_ids, partial_ids = parse_dub_source_payload(spec, raw_json)
                except Exception as exc:
                    source_errors.append(f"{spec.name}: {exc}")
                    details["sources"][spec.name] = {"error": str(exc)}
                    all_unchanged = False
                    log.warning("mal ingest: dub source %s failed: %s", spec.name, exc)
                    continue
                log.debug(
                    "mal ingest: dub list fetched",
                    extra={
                        "source": spec.name,
                        "dubbed_count": len(dubbed_ids),
                        "partial_count": len(partial_ids),
                        "http_status": http_status,
                    },
                )
                with session_scope(self.session_factory) as session:
                    prev_sha = mal_repo.latest_dub_list_sha(session, spec.name)
                    if prev_sha == sha:
                        details["sources"][spec.name] = {
                            "unchanged": True,
                            "dubbed": len(dubbed_ids),
                            "partial": len(partial_ids),
                        }
                        log.info(
                            "mal ingest: %s list unchanged (sha256), skipping list sync", spec.name
                        )
                        continue
                    all_unchanged = False
                    fetch_id = mal_repo.insert_dub_list_fetch(
                        session,
                        source_url=spec.url,
                        content_sha256=sha,
                        id_count=len(dubbed_ids) + len(partial_ids),
                        raw=raw_json,
                        http_status=http_status,
                        error_message=None,
                        source_name=spec.name,
                    )
                    counts = mal_repo.upsert_dub_source_snapshot(
                        session,
                        fetch_id=fetch_id,
                        source_name=spec.name,
                        dubbed_ids=dubbed_ids,
                        partial_ids=partial_ids,
                    )
                    details["sources"][spec.name] = {"fetch_id": fetch_id, **counts}
            if source_errors:
                details["source_errors"] = source_errors
            if specs and len(source_errors) == len(specs):
                raise RuntimeError("all dub list sources failed: " + "; ".join(source_errors))
            details["dub_list_unchanged"] = all_unchanged

            pending: list[int] = []
            with session_scope(self.session_factory) as session:
                union = mal_repo.recompute_dub_union(session, [s.name for s in specs])
                details["dub_union_changed"] = union["changed"]
                pending = mal_repo.list_anime_needing_mal_fetch(session, batch_size)
                details["mal_fetch_pending_batch"] = len(pending)

            if pending and not (mal_client.client_id or "").strip():
                err_msg = (
                    "MAL client ID is not configured. Set it under Integrations (MyAnimeList) "
                    "or set MAL_CLIENT_ID in the environment."
                )
                with session_scope(self.session_factory) as session:
                    mal_repo.finish_mal_job_run(session, run_id, "failed", details, err_msg)
                raise ValueError(err_msg)

            for idx, mal_id in enumerate(pending):
                data, code, err = await mal_client.get_anime(mal_id)
                details["mal_api_calls"] += 1
                if idx % 5 == 0 or idx == len(pending) - 1:
                    with session_scope(self.session_factory) as session:
                        mal_repo.merge_mal_job_run_details(
                            session,
                            run_id,
                            {
                                "ingest_progress": {
                                    "batch_index": idx + 1,
                                    "batch_total": len(pending),
                                    "current_mal_id": mal_id,
                                }
                            },
                        )
                with session_scope(self.session_factory) as session:
                    if err == "not_found" or code == 404:
                        mal_repo.upsert_anime_from_mal_api(
                            session, mal_id, {}, status="not_found", error="not_found"
                        )
                        continue
                    if data is None:
                        mal_repo.upsert_anime_from_mal_api(
                            session, mal_id, {}, status="error", error=err or "mal_http_error"
                        )
                        continue
                    mal_repo.upsert_anime_from_mal_api(session, mal_id, data, status="success", error=None)
                if self.settings.mal_jikan_enabled and data is not None:
                    j_body, j_err = await self.jikan_client.get_anime_full(mal_id)
                    details["jikan_calls"] += 1
                    if j_body and isinstance(j_body.get("data"), dict):
                        with session_scope(self.session_factory) as session:
                            mal_repo.set_jikan_response(session, mal_id, j_body)
                            mal_repo.merge_jikan_title_variants(session, mal_id, j_body["data"])
                            ext_pairs = externals_from_jikan_data(j_body["data"])
                            for site, ext_id in ext_pairs:
                                mal_repo.upsert_external_id(session, mal_id, site, ext_id, "jikan")
                    elif j_err:
                        log.debug("jikan fetch issue for mal_id=%s: %s", mal_id, j_err)

            with session_scope(self.session_factory) as session:
                mal_repo.finish_mal_job_run(session, run_id, "success", details, None)
        except Exception as exc:
            log.exception("mal ingest failed")
            with session_scope(self.session_factory) as session:
                mal_repo.finish_mal_job_run(session, run_id, "failed", details, str(exc))
            raise
        finally:
            heartbeat_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await heartbeat_task
            with session_scope(self.session_factory) as session:
                repo.release_job_lock(session, lock_name=lock_name, owner_id=owner_id)
        return details
