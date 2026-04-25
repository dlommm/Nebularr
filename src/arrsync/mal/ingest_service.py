from __future__ import annotations

import logging
from typing import Any

from arrsync.config import Settings
from arrsync.db import session_scope
from arrsync.mal import repository as mal_repo
from arrsync.mal.externals import externals_from_jikan_data
from arrsync.mal.http_clients import DubInfoClient, JikanClient, MalApiClient
from arrsync.services.mal_config_store import read_mal_client_id

log = logging.getLogger(__name__)


class MalIngestService:
    def __init__(self, settings: Settings, session_factory: Any) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.dub_client = DubInfoClient(settings)
        self.jikan_client = JikanClient(settings)

    async def run(self, *, reason: str = "manual") -> dict[str, Any]:
        details: dict[str, Any] = {"reason": reason, "dub_list_unchanged": False, "mal_api_calls": 0, "jikan_calls": 0}
        with session_scope(self.session_factory) as session:
            run_id = mal_repo.insert_mal_job_run(session, "ingest")
            resolved_mal_client_id = read_mal_client_id(session, self.settings)
        mal_client = MalApiClient(self.settings, client_id=resolved_mal_client_id)
        try:
            raw_json, sha, http_status = await self.dub_client.fetch()
            dubbed = raw_json.get("dubbed")
            if not isinstance(dubbed, list):
                raise ValueError("dubInfo.json missing dubbed array")
            mal_ids = sorted({int(x) for x in dubbed})
            log.debug(
                "mal ingest: dub list fetched",
                extra={"dub_id_count": len(mal_ids), "http_status": http_status},
            )

            pending: list[int] = []
            with session_scope(self.session_factory) as session:
                prev_sha = mal_repo.latest_dub_list_sha(session)
                if prev_sha == sha:
                    details["dub_list_unchanged"] = True
                    log.info("mal ingest: dub list unchanged (sha256), skipping list sync")
                else:
                    fetch_id = mal_repo.insert_dub_list_fetch(
                        session,
                        source_url=self.dub_client.url,
                        content_sha256=sha,
                        id_count=len(mal_ids),
                        raw=raw_json,
                        http_status=http_status,
                        error_message=None,
                    )
                    mal_repo.mark_dubbed_from_snapshot(session, fetch_id, mal_ids)
                    cleared = mal_repo.clear_dub_flag_not_in_list(session, mal_ids)
                    details["dub_ids_active"] = len(mal_ids)
                    details["dub_flags_cleared"] = cleared
                    details["dub_list_fetch_id"] = fetch_id

                limit = max(1, int(self.settings.mal_max_ids_per_run))
                pending = mal_repo.list_anime_needing_mal_fetch(session, limit)
                details["mal_fetch_pending_batch"] = len(pending)

            if pending and not (mal_client.client_id or "").strip():
                err_msg = (
                    "MAL client ID is not configured. Set it under Integrations (MyAnimeList) "
                    "or set MAL_CLIENT_ID in the environment."
                )
                with session_scope(self.session_factory) as session:
                    mal_repo.finish_mal_job_run(session, run_id, "failed", details, err_msg)
                raise ValueError(err_msg)

            for mal_id in pending:
                data, code, err = await mal_client.get_anime(mal_id)
                details["mal_api_calls"] += 1
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
        return details
