from __future__ import annotations

import copy
import logging
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from arrsync.config import Settings
from arrsync.db import session_scope
from arrsync.mal import repository as mal_repo
from arrsync.services import repository as repo
from arrsync.services.arr_client import ArrClient

log = logging.getLogger(__name__)


class CoverageTagSyncService:
    """Reconcile ``fully-english`` / ``partial-english`` tags in Sonarr and Radarr.

    Desired state comes from the warehouse English-audio coverage views — the
    user's own files — not from dub lists. The two tags are mutually exclusive;
    every non-deleted series/movie of an instance is visited so stale tags are
    cleared when an item leaves scope or its coverage status changes.
    """

    def __init__(
        self,
        settings: Settings,
        session_factory: Any,
        *,
        arr_client_class: type[ArrClient] = ArrClient,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.arr_client_class = arr_client_class

    @staticmethod
    def _targets_from_view(session: Session, view_name: str) -> dict[str, dict[int, str]]:
        rows = session.execute(
            text(
                f"""
                select instance_name, source_id, coverage_status
                from {view_name}
                where coverage_status in ('full', 'partial')
                """  # noqa: S608 - view_name is a hardcoded constant below
            )
        ).mappings()
        out: dict[str, dict[int, str]] = {}
        for r in rows:
            out.setdefault(str(r["instance_name"]), {})[int(r["source_id"])] = str(
                r["coverage_status"]
            )
        return out

    @classmethod
    def _series_targets(cls, session: Session) -> dict[str, dict[int, str]]:
        return cls._targets_from_view(session, "warehouse.v_anime_series_english_coverage")

    @classmethod
    def _movie_targets(cls, session: Session) -> dict[str, dict[int, str]]:
        return cls._targets_from_view(session, "warehouse.v_anime_movie_english_coverage")

    async def run(self, *, reason: str = "manual") -> dict[str, Any]:
        full_label = self.settings.arr_coverage_full_tag_label
        partial_label = self.settings.arr_coverage_partial_tag_label
        details: dict[str, Any] = {
            "reason": reason,
            "full_tag_label": full_label,
            "partial_tag_label": partial_label,
            "sonarr_updated": 0,
            "sonarr_cleared": 0,
            "radarr_updated": 0,
            "radarr_cleared": 0,
            "errors": [],
        }
        with session_scope(self.session_factory) as session:
            run_id = mal_repo.insert_mal_job_run(session, "coverage_tag_sync")
        try:
            with session_scope(self.session_factory) as session:
                series_targets = self._series_targets(session)
                movie_targets = self._movie_targets(session)
                sonarr_integrations = repo.list_enabled_integrations(session, "sonarr")
                radarr_integrations = repo.list_enabled_integrations(session, "radarr")

            await self._reconcile_source(
                source="sonarr",
                integrations=sonarr_integrations,
                targets=series_targets,
                details=details,
            )
            await self._reconcile_source(
                source="radarr",
                integrations=radarr_integrations,
                targets=movie_targets,
                details=details,
            )

            with session_scope(self.session_factory) as session:
                mal_repo.finish_mal_job_run(session, run_id, "success", details, None)
        except Exception as exc:
            log.exception("coverage tag sync failed")
            with session_scope(self.session_factory) as session:
                mal_repo.finish_mal_job_run(session, run_id, "failed", details, str(exc))
            raise
        return details

    async def _reconcile_source(
        self,
        *,
        source: str,
        integrations: Any,
        targets: dict[str, dict[int, str]],
        details: dict[str, Any],
    ) -> None:
        full_label = self.settings.arr_coverage_full_tag_label
        partial_label = self.settings.arr_coverage_partial_tag_label
        table = "warehouse.series" if source == "sonarr" else "warehouse.movie"
        id_key = "series_id" if source == "sonarr" else "movie_id"
        for inst_row in integrations:
            instance_name = str(inst_row["name"])
            client = self.arr_client_class(
                self.settings,
                source,
                instance_name=instance_name,
                base_url=str(inst_row["base_url"]),
                api_key=str(inst_row["api_key"]),
            )
            try:
                try:
                    full_id = await client.ensure_tag_id(full_label)
                    partial_id = await client.ensure_tag_id(partial_label)
                except Exception as exc:
                    details["errors"].append(
                        {
                            "instance": instance_name,
                            "source": source,
                            "phase": "ensure_tag",
                            "error": str(exc),
                        }
                    )
                    log.warning(
                        "%s coverage ensure_tag failed instance=%s: %s", source, instance_name, exc
                    )
                    continue
                want = targets.get(instance_name, {})
                with session_scope(self.session_factory) as session:
                    rows = session.execute(
                        text(
                            f"""
                            select source_id, payload
                            from {table}
                            where instance_name = :instance_name and deleted = false
                            """  # noqa: S608 - table is one of two constants above
                        ),
                        {"instance_name": instance_name},
                    ).mappings()
                for row in rows:
                    sid = int(row["source_id"])
                    payload = copy.deepcopy(dict(row["payload"] or {}))
                    tags = [int(t) for t in (payload.get("tags") or []) if t is not None]
                    desired = want.get(sid)
                    desired_id = (
                        full_id
                        if desired == "full"
                        else partial_id
                        if desired == "partial"
                        else None
                    )
                    new_tags = [t for t in tags if t not in (full_id, partial_id)]
                    if desired_id is not None:
                        new_tags.append(desired_id)
                    if set(new_tags) == set(tags):
                        continue
                    payload["tags"] = new_tags
                    try:
                        if source == "sonarr":
                            await client.put_series(payload)
                        else:
                            await client.put_movie(payload)
                        if desired_id is None:
                            details[f"{source}_cleared"] += 1
                        else:
                            details[f"{source}_updated"] += 1
                    except Exception as exc:
                        details["errors"].append(
                            {"instance": instance_name, id_key: sid, "error": str(exc)}
                        )
                        log.warning("%s coverage tag put %s: %s", source, sid, exc)
            finally:
                await client.aclose()
