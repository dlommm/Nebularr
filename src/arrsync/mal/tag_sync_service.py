from __future__ import annotations

import asyncio
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


def _mal_run_status(details: dict[str, Any], instances_processed: int) -> str:
    """Fail only when every instance errored; a mixed run stays 'success' because
    app.mal_job_run.status is CHECK-constrained (no 'partial' value exists)."""
    if (details.get("errors") or []) and instances_processed == 0:
        return "failed"
    return "success"


class MalTagSyncService:
    def __init__(self, settings: Settings, session_factory: Any) -> None:
        self.settings = settings
        self.session_factory = session_factory

    async def _run_db(self, fn: Any, /, *args: Any, **kwargs: Any) -> Any:
        """Run synchronous DB work in a worker thread so it never blocks the loop."""

        def _call() -> Any:
            with session_scope(self.session_factory) as session:
                return fn(session, *args, **kwargs)

        return await asyncio.to_thread(_call)

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

    @staticmethod
    def _tag_diff(
        live_rows: list[dict[str, Any]], want: set[int], tag_id: int
    ) -> tuple[list[int], list[int]]:
        """Split live Arr rows into ids needing the tag added vs removed."""
        to_add: list[int] = []
        to_remove: list[int] = []
        for row in live_rows:
            raw_id = row.get("id")
            if raw_id is None:
                continue
            sid = int(raw_id)
            tags = {int(t) for t in (row.get("tags") or []) if t is not None}
            if sid in want:
                if tag_id not in tags:
                    to_add.append(sid)
            elif tag_id in tags:
                to_remove.append(sid)
        return to_add, to_remove

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
        run_id = await self._run_db(mal_repo.insert_mal_job_run, "tag_sync")
        try:
            def _load(session: Session) -> tuple[Any, Any, Any, Any]:
                sonarr_t, radarr_t = self._link_targets(session)
                return (
                    sonarr_t,
                    radarr_t,
                    repo.list_enabled_integrations(session, "sonarr"),
                    repo.list_enabled_integrations(session, "radarr"),
                )

            sonarr_targets, radarr_targets, sonarr_integrations, radarr_integrations = (
                await self._run_db(_load)
            )

            instances_processed = 0
            for source, integrations, targets in (
                ("sonarr", sonarr_integrations, sonarr_targets),
                ("radarr", radarr_integrations, radarr_targets),
            ):
                for inst_row in integrations:
                    instance_name = str(inst_row["name"])
                    client = ArrClient(
                        self.settings,
                        source,
                        instance_name=instance_name,
                        base_url=str(inst_row["base_url"]),
                        api_key=str(inst_row["api_key"]),
                    )
                    try:
                        try:
                            tag_id = await client.ensure_tag_id(label)
                        except Exception as exc:
                            details["errors"].append(
                                {
                                    "instance": instance_name,
                                    "source": source,
                                    "phase": "ensure_tag",
                                    "error": str(exc),
                                }
                            )
                            log.warning("%s ensure_tag failed instance=%s: %s", source, instance_name, exc)
                            continue
                        # Diff against live Arr state, not the last-synced warehouse
                        # payload: a stale snapshot must never overwrite newer edits.
                        try:
                            if source == "sonarr":
                                live_rows = await client.list_series()
                            else:
                                live_rows = await client.list_movies()
                        except Exception as exc:
                            details["errors"].append(
                                {
                                    "instance": instance_name,
                                    "source": source,
                                    "phase": "list",
                                    "error": str(exc),
                                }
                            )
                            log.warning("%s list failed instance=%s: %s", source, instance_name, exc)
                            continue
                        # Past both skip points: this instance did real work.
                        instances_processed += 1
                        want = targets.get(instance_name, set())
                        to_add, to_remove = self._tag_diff(live_rows, want, tag_id)
                        for ids, apply_tags, counter in (
                            (to_add, "add", f"{source}_tagged"),
                            (to_remove, "remove", f"{source}_untagged"),
                        ):
                            if not ids:
                                continue
                            try:
                                if source == "sonarr":
                                    await client.update_series_tags(ids, [tag_id], apply_tags)
                                else:
                                    await client.update_movie_tags(ids, [tag_id], apply_tags)
                                details[counter] += len(ids)
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
                                    "%s tag editor %s failed instance=%s: %s",
                                    source,
                                    apply_tags,
                                    instance_name,
                                    exc,
                                )
                    finally:
                        await client.aclose()

            status = _mal_run_status(details, instances_processed)
            await self._run_db(mal_repo.finish_mal_job_run, run_id, status, details, None)
        except Exception as exc:
            log.exception("mal tag sync failed")
            await self._run_db(mal_repo.finish_mal_job_run, run_id, "failed", details, str(exc))
            raise
        return details
