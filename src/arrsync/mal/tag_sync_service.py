from __future__ import annotations

import copy
import logging
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from arrsync.config import Settings
from arrsync.db import session_scope
from arrsync.mal import repository as mal_repo
from arrsync.services.arr_client import ArrClient
from arrsync.services import repository as repo

log = logging.getLogger(__name__)


class MalTagSyncService:
    def __init__(self, settings: Settings, session_factory: Any) -> None:
        self.settings = settings
        self.session_factory = session_factory

    @staticmethod
    def _link_targets(session: Session) -> tuple[dict[str, set[int]], dict[str, set[int]]]:
        rows = session.execute(
            text(
                """
                select l.instance_name, l.arr_entity, l.warehouse_source_id
                from mal.warehouse_link l
                join mal.anime a on a.mal_id = l.mal_id
                where a.is_english_dubbed = true
                """
            )
        ).mappings()
        sonarr: dict[str, set[int]] = {}
        radarr: dict[str, set[int]] = {}
        for r in rows:
            inst = str(r["instance_name"])
            sid = int(r["warehouse_source_id"])
            ent = str(r["arr_entity"])
            if ent == "sonarr_series":
                sonarr.setdefault(inst, set()).add(sid)
            elif ent == "radarr_movie":
                radarr.setdefault(inst, set()).add(sid)
        return sonarr, radarr

    async def run(self, *, reason: str = "manual") -> dict[str, Any]:
        label = self.settings.arr_dub_tag_label
        details: dict[str, Any] = {
            "reason": reason,
            "tag_label": label,
            "sonarr_tagged": 0,
            "sonarr_untagged": 0,
            "radarr_tagged": 0,
            "radarr_untagged": 0,
            "errors": [],
        }
        with session_scope(self.session_factory) as session:
            run_id = mal_repo.insert_mal_job_run(session, "tag_sync")
        try:
            with session_scope(self.session_factory) as session:
                sonarr_targets, radarr_targets = self._link_targets(session)
                sonarr_integrations = repo.list_enabled_integrations(session, "sonarr")
                radarr_integrations = repo.list_enabled_integrations(session, "radarr")

            for inst_row in sonarr_integrations:
                instance_name = str(inst_row["name"])
                client = ArrClient(
                    self.settings,
                    "sonarr",
                    instance_name=instance_name,
                    base_url=str(inst_row["base_url"]),
                    api_key=str(inst_row["api_key"]),
                )
                try:
                    tag_id = await client.ensure_tag_id(label)
                except Exception as exc:
                    details["errors"].append({"instance": instance_name, "source": "sonarr", "phase": "ensure_tag", "error": str(exc)})
                    log.warning("sonarr ensure_tag failed instance=%s: %s", instance_name, exc)
                    continue
                want = sonarr_targets.get(instance_name, set())
                with session_scope(self.session_factory) as session:
                    series_rows = session.execute(
                        text(
                            """
                            select source_id, payload
                            from warehouse.series
                            where instance_name = :instance_name and deleted = false
                            """
                        ),
                        {"instance_name": instance_name},
                    ).mappings()
                for sr in series_rows:
                    sid = int(sr["source_id"])
                    payload = copy.deepcopy(dict(sr["payload"] or {}))
                    tags = [int(t) for t in (payload.get("tags") or []) if t is not None]
                    if sid in want:
                        if tag_id not in tags:
                            tags.append(tag_id)
                            payload["tags"] = tags
                            try:
                                await client.put_series(payload)
                                details["sonarr_tagged"] += 1
                            except Exception as exc:
                                details["errors"].append({"instance": instance_name, "series_id": sid, "error": str(exc)})
                                log.warning("sonarr put_series %s: %s", sid, exc)
                    else:
                        if tag_id in tags:
                            payload["tags"] = [t for t in tags if t != tag_id]
                            try:
                                await client.put_series(payload)
                                details["sonarr_untagged"] += 1
                            except Exception as exc:
                                details["errors"].append({"instance": instance_name, "series_id": sid, "error": str(exc)})
                                log.warning("sonarr untag %s: %s", sid, exc)

            for inst_row in radarr_integrations:
                instance_name = str(inst_row["name"])
                client = ArrClient(
                    self.settings,
                    "radarr",
                    instance_name=instance_name,
                    base_url=str(inst_row["base_url"]),
                    api_key=str(inst_row["api_key"]),
                )
                try:
                    tag_id = await client.ensure_tag_id(label)
                except Exception as exc:
                    details["errors"].append({"instance": instance_name, "source": "radarr", "phase": "ensure_tag", "error": str(exc)})
                    log.warning("radarr ensure_tag failed instance=%s: %s", instance_name, exc)
                    continue
                want = radarr_targets.get(instance_name, set())
                with session_scope(self.session_factory) as session:
                    movie_rows = session.execute(
                        text(
                            """
                            select source_id, payload
                            from warehouse.movie
                            where instance_name = :instance_name and deleted = false
                            """
                        ),
                        {"instance_name": instance_name},
                    ).mappings()
                for mr in movie_rows:
                    mid = int(mr["source_id"])
                    payload = copy.deepcopy(dict(mr["payload"] or {}))
                    tags = [int(t) for t in (payload.get("tags") or []) if t is not None]
                    if mid in want:
                        if tag_id not in tags:
                            tags.append(tag_id)
                            payload["tags"] = tags
                            try:
                                await client.put_movie(payload)
                                details["radarr_tagged"] += 1
                            except Exception as exc:
                                details["errors"].append({"instance": instance_name, "movie_id": mid, "error": str(exc)})
                                log.warning("radarr put_movie %s: %s", mid, exc)
                    else:
                        if tag_id in tags:
                            payload["tags"] = [t for t in tags if t != tag_id]
                            try:
                                await client.put_movie(payload)
                                details["radarr_untagged"] += 1
                            except Exception as exc:
                                details["errors"].append({"instance": instance_name, "movie_id": mid, "error": str(exc)})
                                log.warning("radarr untag %s: %s", mid, exc)

            with session_scope(self.session_factory) as session:
                mal_repo.finish_mal_job_run(session, run_id, "success", details, None)
        except Exception as exc:
            log.exception("mal tag sync failed")
            with session_scope(self.session_factory) as session:
                mal_repo.finish_mal_job_run(session, run_id, "failed", details, str(exc))
            raise
        return details
