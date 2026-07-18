from __future__ import annotations

import asyncio
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


def _mal_run_status(details: dict[str, Any], instances_processed: int) -> str:
    """Overall run status. Fail only when every instance errored (nothing got
    through); a mixed run stays 'success' because app.mal_job_run.status is
    CHECK-constrained to ('running','success','failed') — there is no 'partial'."""
    if (details.get("errors") or []) and instances_processed == 0:
        return "failed"
    return "success"


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

    async def _run_db(self, fn: Any, /, *args: Any, **kwargs: Any) -> Any:
        """Run synchronous DB work in a worker thread so it never blocks the loop."""

        def _call() -> Any:
            with session_scope(self.session_factory) as session:
                return fn(session, *args, **kwargs)

        return await asyncio.to_thread(_call)

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
        run_id = await self._run_db(mal_repo.insert_mal_job_run, "coverage_tag_sync")
        try:
            def _load(session: Session) -> tuple[Any, Any, Any, Any]:
                return (
                    self._series_targets(session),
                    self._movie_targets(session),
                    repo.list_enabled_integrations(session, "sonarr"),
                    repo.list_enabled_integrations(session, "radarr"),
                )

            series_targets, movie_targets, sonarr_integrations, radarr_integrations = (
                await self._run_db(_load)
            )

            processed = await self._reconcile_source(
                source="sonarr",
                integrations=sonarr_integrations,
                targets=series_targets,
                details=details,
            )
            processed += await self._reconcile_source(
                source="radarr",
                integrations=radarr_integrations,
                targets=movie_targets,
                details=details,
            )

            status = _mal_run_status(details, processed)
            await self._run_db(mal_repo.finish_mal_job_run, run_id, status, details, None)
        except Exception as exc:
            log.exception("coverage tag sync failed")
            await self._run_db(mal_repo.finish_mal_job_run, run_id, "failed", details, str(exc))
            raise
        return details

    async def _reconcile_source(
        self,
        *,
        source: str,
        integrations: Any,
        targets: dict[str, dict[int, str]],
        details: dict[str, Any],
    ) -> int:
        """Reconcile one source; returns the number of instances that reached the
        apply phase (used to distinguish an all-failed run from a partial one)."""
        full_label = self.settings.arr_coverage_full_tag_label
        partial_label = self.settings.arr_coverage_partial_tag_label
        instances_processed = 0
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
                # Diff against live Arr state, not the last-synced warehouse payload:
                # a stale snapshot must never overwrite newer edits made in the app.
                try:
                    if source == "sonarr":
                        live_rows = await client.list_series()
                    else:
                        live_rows = await client.list_movies()
                except Exception as exc:
                    details["errors"].append(
                        {"instance": instance_name, "source": source, "phase": "list", "error": str(exc)}
                    )
                    log.warning("%s coverage list failed instance=%s: %s", source, instance_name, exc)
                    continue
                # Past both skip points: this instance did real reconcile work.
                instances_processed += 1
                want = targets.get(instance_name, {})
                add_ids: dict[int, list[int]] = {full_id: [], partial_id: []}
                remove_ids: dict[int, list[int]] = {full_id: [], partial_id: []}
                for row in live_rows:
                    raw_id = row.get("id")
                    if raw_id is None:
                        continue
                    sid = int(raw_id)
                    tags = {int(t) for t in (row.get("tags") or []) if t is not None}
                    desired = want.get(sid)
                    desired_id = (
                        full_id
                        if desired == "full"
                        else partial_id
                        if desired == "partial"
                        else None
                    )
                    if desired_id is not None and desired_id not in tags:
                        add_ids[desired_id].append(sid)
                    for coverage_tag in {full_id, partial_id}:
                        if coverage_tag in tags and coverage_tag != desired_id:
                            remove_ids[coverage_tag].append(sid)

                updated_ids: set[int] = set()
                cleared_ids: set[int] = set()
                for apply_tags, buckets, touched in (
                    ("add", add_ids, updated_ids),
                    ("remove", remove_ids, cleared_ids),
                ):
                    for tag_id, ids in buckets.items():
                        if not ids:
                            continue
                        try:
                            if source == "sonarr":
                                await client.update_series_tags(ids, [tag_id], apply_tags)
                            else:
                                await client.update_movie_tags(ids, [tag_id], apply_tags)
                            touched.update(ids)
                        except Exception as exc:
                            details["errors"].append(
                                {
                                    "instance": instance_name,
                                    "source": source,
                                    "phase": f"editor_{apply_tags}",
                                    "ids": ids,
                                    "error": str(exc),
                                }
                            )
                            log.warning(
                                "%s coverage tag editor %s failed instance=%s: %s",
                                source,
                                apply_tags,
                                instance_name,
                                exc,
                            )
                details[f"{source}_updated"] += len(updated_ids)
                # A full<->partial swap counts as updated, not cleared.
                details[f"{source}_cleared"] += len(cleared_ids - updated_ids)
            finally:
                await client.aclose()
        return instances_processed
