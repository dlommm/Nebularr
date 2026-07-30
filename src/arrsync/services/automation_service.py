"""Automation run executor.

Skeleton mirrors CoverageTagSyncService: sync DB work in worker threads, per-phase
error collection, run-row bookkeeping, and diffing against LIVE Arr state before
any mutation (a stale warehouse snapshot must never drive a write).
"""

from __future__ import annotations

import asyncio
import logging
import re
import uuid
from typing import Any

from sqlalchemy import text

from arrsync.config import Settings
from arrsync.db import session_scope
from arrsync.services import automation_store
from arrsync.services import repository as repo
from arrsync.services.arr_client import ArrClient
from arrsync.services.automation_rules import RuleParams, compile_candidates, validate_params

log = logging.getLogger(__name__)


def _profile_language_warning(custom_formats: list[dict[str, Any]]) -> str | None:
    """None when some custom format appears to score language/dub attributes;
    otherwise a human-readable warning for the run details / UI."""
    for cf in custom_formats:
        if re.search(r"dub|language|english", str(cf.get("name", "")), re.IGNORECASE):
            return None
        for spec in cf.get("specifications") or []:
            if "language" in str(spec.get("implementation", "")).lower():
                return None
    return (
        "no custom format references language/dub — searches will fire, but this "
        "instance's quality profiles may grab non-dub releases"
    )


def _select_rows(session: Any, sql: str, binds: dict[str, Any]) -> list[dict[str, Any]]:
    return [dict(r) for r in session.execute(text(sql), binds).mappings()]


def _count_rows(session: Any, sql: str, binds: dict[str, Any]) -> int:
    return int(session.execute(text(sql), binds).scalar_one())


class AutomationService:
    SEARCHLESS_LIMIT = 10_000  # candidate cap for tag/monitor-only rules

    def __init__(
        self,
        settings: Settings,
        session_factory: Any,
        *,
        arr_client_class: type[ArrClient] = ArrClient,
        event_bus: Any | None = None,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.arr_client_class = arr_client_class
        self.event_bus = event_bus

    async def _run_db(self, fn: Any, /, *args: Any, **kwargs: Any) -> Any:
        def _call() -> Any:
            with session_scope(self.session_factory) as session:
                return fn(session, *args, **kwargs)

        return await asyncio.to_thread(_call)

    @staticmethod
    def _targets(params: RuleParams) -> list[tuple[str, str]]:
        targets: list[tuple[str, str]] = []
        if params.scope.media in ("movies", "both"):
            targets.append(("radarr", "movie"))
        if params.scope.media in ("series", "both"):
            targets.append(("sonarr", "episode"))
        return targets

    async def run(self, automation_id: int, *, reason: str = "cron") -> dict[str, Any]:
        automation = await self._run_db(automation_store.get_automation, automation_id)
        if automation is None:
            return {"status": "not_found"}
        try:
            params = validate_params(str(automation["template_key"]), automation["params"] or {})
        except ValueError as exc:
            log.warning("automation %s has invalid params: %s", automation_id, exc)
            return {"status": "invalid_params", "error": str(exc)}
        owner = f"automation-{uuid.uuid4().hex[:12]}"
        lock_name = f"automation:{automation_id}"
        if not await self._run_db(repo.try_job_lock, lock_name, owner):
            return {"status": "already_running"}
        run_id = await self._run_db(automation_store.insert_automation_run, automation_id)
        dry_run = bool(automation["dry_run"])
        details: dict[str, Any] = {"reason": reason, "dry_run": dry_run, "instances": {}, "errors": []}
        counters = {"matched": 0, "actions": 0, "skipped_cooldown": 0, "skipped_budget": 0}
        status = "failed"
        try:
            has_search = any(a.type.startswith("search_") for a in params.actions)
            search_budget = int(automation["budget_per_run"])
            if has_search:
                used = await self._run_db(automation_store.count_recent_searches)
                cap_left = max(0, int(self.settings.automation_max_searches_per_day) - used)
                if cap_left < search_budget:
                    details["daily_cap_clamped"] = True
                search_budget = min(search_budget, cap_left)
            instances_processed = 0
            for source, entity in self._targets(params):
                integrations = await self._run_db(repo.list_enabled_integrations, source)
                for inst in integrations:
                    name = str(inst["name"])
                    if params.scope.instances and name not in params.scope.instances:
                        continue
                    instances_processed += await self._run_instance(
                        automation=automation,
                        params=params,
                        source=source,
                        entity=entity,
                        instance=inst,
                        run_id=run_id,
                        search_budget=search_budget,
                        dry_run=dry_run,
                        details=details,
                        counters=counters,
                    )
            if params.options.new_dub_only and not dry_run:
                await self._run_db(
                    automation_store.set_automation_state,
                    automation_id,
                    {"dub_status_seen": details.get("dub_status_seen", {})},
                )
            if dry_run:
                status = "dry_run"
            elif details["errors"] and instances_processed == 0:
                status = "failed"
            elif details["errors"] or counters["skipped_budget"]:
                status = "partial"
            else:
                status = "success"
        except Exception as exc:
            details["errors"].append({"phase": "run", "error": str(exc)})
            log.exception("automation run failed", extra={"automation_id": automation_id})
        finally:
            error_message = "; ".join(e.get("error", "") for e in details["errors"])[:500] or None
            await self._run_db(
                automation_store.finish_automation_run,
                run_id,
                status,
                matched_count=counters["matched"],
                actions_taken=counters["actions"],
                skipped_cooldown=counters["skipped_cooldown"],
                skipped_budget=counters["skipped_budget"],
                details=details,
                error_message=error_message,
            )
            await self._run_db(repo.release_job_lock, lock_name, owner)
            if self.event_bus is not None:
                self.event_bus.publish(
                    "automation_run",
                    {"automation_id": automation_id, "run_id": run_id, "status": status},
                )
        return {"status": status, "run_id": run_id, **counters}

    async def _run_instance(
        self,
        *,
        automation: dict[str, Any],
        params: RuleParams,
        source: str,
        entity: str,
        instance: dict[str, Any],
        run_id: int,
        search_budget: int,
        dry_run: bool,
        details: dict[str, Any],
        counters: dict[str, int],
    ) -> int:
        name = str(instance["name"])
        inst_details: dict[str, Any] = {"matched": 0}
        details["instances"].setdefault(name, {})[entity] = inst_details
        client = self.arr_client_class(
            self.settings,
            source,
            instance_name=name,
            base_url=str(instance["base_url"]),
            api_key=str(instance["api_key"]),
        )
        try:
            tag_ids: list[int] | None = None
            if params.scope.tags_any:
                try:
                    tags = await client.list_tags()
                except Exception as exc:
                    details["errors"].append({"instance": name, "phase": "list_tags", "error": str(exc)})
                    return 0
                by_label = {
                    str(t.get("label", "")).strip().casefold(): int(t["id"])
                    for t in tags
                    if t.get("id") is not None
                }
                tag_ids = [
                    by_label[label.strip().casefold()]
                    for label in params.scope.tags_any
                    if label.strip().casefold() in by_label
                ] or [-1]  # unmatched labels match nothing

            has_search = any(a.type.startswith("search_") for a in params.actions)
            limit = search_budget if has_search else self.SEARCHLESS_LIMIT
            compiled = compile_candidates(params, entity)
            runtime: dict[str, Any] = {
                "instance_name": name,
                "cooldown_days": int(automation["cooldown_days"]),
                "limit": max(0, limit),
            }
            if tag_ids is not None:
                runtime["tag_ids"] = tag_ids
            count_binds = {k: v for k, v in {**compiled.binds, **runtime}.items() if k != "limit"}
            eligible = await self._run_db(_count_rows, compiled.count_sql, count_binds)
            eligible_all = await self._run_db(
                _count_rows,
                compiled.count_all_sql,
                {k: v for k, v in count_binds.items() if k != "cooldown_days"},
            )
            candidates = await self._run_db(
                _select_rows, compiled.select_sql, {**compiled.binds, **runtime}
            )
            if params.options.new_dub_only:
                seen = (automation.get("state") or {}).get("dub_status_seen", {})
                current = details.setdefault("dub_status_seen", {})
                fresh = []
                for row in candidates:
                    mal_id = str(row.get("mal_id"))
                    now_status = str(row.get("dub_status") or "")
                    current[mal_id] = now_status
                    if seen.get(mal_id) in (None, "none") and now_status in ("partial", "dubbed"):
                        fresh.append(row)
                candidates = fresh
            counters["matched"] += len(candidates)
            counters["skipped_cooldown"] += max(0, eligible_all - eligible)
            if has_search:
                counters["skipped_budget"] += max(0, eligible - len(candidates))
            inst_details["matched"] = len(candidates)

            if has_search and params.require.audio_language_any and not dry_run:
                try:
                    warning = _profile_language_warning(await client.list_custom_formats())
                    if warning:
                        inst_details["profile_warning"] = warning
                except Exception:
                    log.debug("custom format probe failed", exc_info=True)

            if dry_run:
                inst_details["would_do"] = [
                    {
                        "source_id": int(r["source_id"]),
                        "title": str(r.get("series_title") or r.get("title") or ""),
                        "actions": sorted({a.type for a in params.actions if a.when == "non_conforming"}),
                    }
                    for r in candidates
                ]
                return 1

            item_ids = [int(r["source_id"]) for r in candidates]
            if has_search and item_ids:
                if entity == "movie":
                    await client.search_movies(item_ids)
                else:
                    await client.search_episodes(item_ids)

                def _write_ledger(session: Any) -> None:
                    for source_id in item_ids:
                        automation_store.upsert_action_ledger(
                            session,
                            instance_name=name,
                            entity_type=entity,
                            source_id=source_id,
                            action_type="search",
                            automation_id=int(automation["id"]),
                            run_id=run_id,
                        )

                await self._run_db(_write_ledger)
                counters["actions"] += len(item_ids)
                inst_details["searched"] = len(item_ids)

            await self._apply_tag_actions(
                client=client, params=params, entity=entity, candidates=candidates,
                counters=counters, inst_details=inst_details,
            )
            await self._apply_monitored_actions(
                client=client, params=params, entity=entity, candidates=candidates,
                runtime=runtime, counters=counters, inst_details=inst_details,
            )
            return 1
        except Exception as exc:
            details["errors"].append(
                {"instance": name, "entity": entity, "phase": "instance", "error": str(exc)}
            )
            log.warning("automation instance failed instance=%s: %s", name, exc)
            return 0
        finally:
            await client.aclose()

    @staticmethod
    def _target_ids(entity: str, candidates: list[dict[str, Any]]) -> set[int]:
        """Item ids for movie rules; owning-series ids for episode rules."""
        if entity == "movie":
            return {int(r["source_id"]) for r in candidates}
        return {int(r["series_source_id"]) for r in candidates}

    async def _apply_tag_actions(
        self, *, client: Any, params: RuleParams, entity: str,
        candidates: list[dict[str, Any]], counters: dict[str, int], inst_details: dict[str, Any],
    ) -> None:
        tag_actions = [a for a in params.actions if a.type == "tag" and a.when == "non_conforming"]
        if not tag_actions:
            return
        desired_ids = self._target_ids(entity, candidates)
        live_rows = await (client.list_movies() if entity == "movie" else client.list_series())
        for action in tag_actions:
            tag_id = await client.ensure_tag_id(action.label or "")
            add: list[int] = []
            remove: list[int] = []
            for row in live_rows:
                raw_id = row.get("id")
                if raw_id is None:
                    continue
                rid = int(raw_id)
                tags = {int(t) for t in (row.get("tags") or []) if t is not None}
                if rid in desired_ids and tag_id not in tags:
                    add.append(rid)
                elif rid not in desired_ids and tag_id in tags:
                    remove.append(rid)
            for ids, op in ((add, "add"), (remove, "remove")):
                if not ids:
                    continue
                if entity == "movie":
                    await client.update_movie_tags(ids, [tag_id], op)
                else:
                    await client.update_series_tags(ids, [tag_id], op)
            counters["actions"] += len(add) + len(remove)
            inst_details[f"tag:{action.label}"] = {"added": len(add), "removed": len(remove)}

    async def _apply_monitored_actions(
        self, *, client: Any, params: RuleParams, entity: str,
        candidates: list[dict[str, Any]], runtime: dict[str, Any],
        counters: dict[str, int], inst_details: dict[str, Any],
    ) -> None:
        monitored_actions = [a for a in params.actions if a.type == "set_monitored"]
        if not monitored_actions:
            return
        live_rows = await (client.list_movies() if entity == "movie" else client.list_series())
        live_monitored = {
            int(row["id"]): bool(row.get("monitored", False))
            for row in live_rows
            if row.get("id") is not None
        }
        for action in monitored_actions:
            if action.when == "conforming":
                # validation guarantees media == movies here
                compiled = compile_candidates(params, "movie", sense="conforming")
                rows = await self._run_db(
                    _select_rows,
                    compiled.select_sql,
                    {**compiled.binds, **runtime, "limit": self.SEARCHLESS_LIMIT},
                )
                target_ids = {int(r["source_id"]) for r in rows}
            else:
                target_ids = self._target_ids(entity, candidates)
            desired = bool(action.value)
            changed = [
                rid for rid in sorted(target_ids)
                if rid in live_monitored and live_monitored[rid] != desired
            ]
            if not changed:
                continue
            if entity == "movie":
                await client.update_movies_monitored(changed, desired)
            else:
                await client.update_series_monitored(changed, desired)
            counters["actions"] += len(changed)
            inst_details[f"monitored:{action.when}"] = len(changed)
