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
from arrsync.services.automation_rules import (
    RuleParams,
    compile_candidates,
    failure_reasons,
    validate_params,
)

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
        alert_notifier: Any | None = None,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.arr_client_class = arr_client_class
        self.event_bus = event_bus
        self.alert_notifier = alert_notifier

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
        # Accumulates mal_id -> observed dub_status across every instance touched this
        # run. Kept local (never written into `details`) so a run row never carries
        # the full mal_id map — only a transition count does (details["new_dub_transitions"]).
        dub_observations: dict[str, str] = {}
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
            # Shared across every (source, entity, instance) combination in this run:
            # budget_per_run/the daily cap are a run-wide ceiling, not a per-instance
            # allowance, so a multi-instance run must deplete one pool, not reset it
            # for every instance it touches.
            budget_state = {"remaining": search_budget}
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
                        budget_state=budget_state,
                        dry_run=dry_run,
                        details=details,
                        counters=counters,
                        dub_observations=dub_observations,
                    )
            if params.options.new_dub_only and not dry_run:
                # Merge into whatever state already exists — both the pre-existing
                # dub_status_seen entries (an instance that saw nothing new this run
                # must not forget statuses it already recorded) and any other state
                # keys future features may add.
                existing_state = automation.get("state") or {}
                merged_seen = {**existing_state.get("dub_status_seen", {}), **dub_observations}
                await self._run_db(
                    automation_store.set_automation_state,
                    automation_id,
                    {**existing_state, "dub_status_seen": merged_seen},
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
            if status == "failed" and self.alert_notifier is not None:
                # Best-effort: a broken/unconfigured alert channel must never turn a
                # completed (if failed) automation run into an unhandled exception.
                try:
                    await self.alert_notifier.send_event(
                        "automation_failure",
                        {
                            "automation_id": automation_id,
                            "automation_name": automation.get("name"),
                            "run_id": run_id,
                            "error": error_message,
                        },
                    )
                except Exception:
                    log.exception(
                        "failed to send automation failure alert", extra={"automation_id": automation_id}
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
        budget_state: dict[str, int],
        dry_run: bool,
        details: dict[str, Any],
        counters: dict[str, int],
        dub_observations: dict[str, str],
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
            # Which set this run is *about*. Search actions are non-conforming by
            # validation, so a rule whose every action is conforming (a
            # ready-to-unmonitor tagger) has nothing to say about the failing set:
            # counting that set as "matched" would report hundreds of matches for a
            # run whose whole job was to tag eight finished shows.
            primary_sense = (
                "non_conforming"
                if any(a.when == "non_conforming" for a in params.actions)
                else "conforming"
            )
            # Bound this instance's select by what's left of the run-wide budget, not
            # the original per-run allowance — budget_state is shared and depleted as
            # each instance actually fires searches, so a later instance in the same
            # run can't spend a pool an earlier instance already used.
            limit = max(0, budget_state["remaining"]) if has_search else self.SEARCHLESS_LIMIT
            compiled = compile_candidates(params, entity, sense=primary_sense)
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
            # Snapshot the budgeted select's row count BEFORE the new_dub_only prune —
            # skipped_budget must reflect what the daily cap/budget actually cost us,
            # not how many of those rows also happened to be "already seen" dub
            # statuses. Conflating the two made steady-state anime-dub-enforcer runs
            # (where most candidates are pruned as not-fresh, not budget-starved)
            # report "partial" every time instead of "success".
            pre_prune_count = len(candidates)
            # Buffered locally, per instance — NOT written into the shared
            # dub_observations dict yet. If this instance's search phase later fails
            # (see below), the buffer is simply discarded: a none->dubbed transition
            # must not be watermarked as "seen" unless it was actually searched, or
            # it would never be retried on a future run.
            local_dub_observations: dict[str, str] = {}
            if params.options.new_dub_only:
                seen = (automation.get("state") or {}).get("dub_status_seen", {})
                fresh = []
                for row in candidates:
                    mal_id = str(row.get("mal_id"))
                    now_status = str(row.get("dub_status") or "")
                    local_dub_observations[mal_id] = now_status
                    if seen.get(mal_id) in (None, "none") and now_status in ("partial", "dubbed"):
                        fresh.append(row)
                details["new_dub_transitions"] = details.get("new_dub_transitions", 0) + len(fresh)
                candidates = fresh
            counters["matched"] += len(candidates)
            counters["skipped_cooldown"] += max(0, eligible_all - eligible)
            if has_search:
                counters["skipped_budget"] += max(0, eligible - pre_prune_count)
            inst_details["matched"] = len(candidates)

            # The tag/monitor reconcile target sets must never come from the
            # budget-truncated (or new_dub_only-pruned) search candidate list — tag
            # and set_monitored actions are cheap, idempotent, and uncapped, and must
            # reconcile against the FULL set every run regardless of how much search
            # budget is left. Recompile without the search actions (which also drops
            # the ledger join/cooldown clause per the compiler contract) and select
            # unbounded (SEARCHLESS_LIMIT).
            #
            # One row set per `when` the rule actually uses, so a rule can carry both
            # senses at once — "tag the finished shows, tag what still needs fixing"
            # in one pass — without either action borrowing the other's set.
            row_sets: dict[str, list[dict[str, Any]]] = {}
            senses_needed = {a.when for a in params.actions if a.type in ("tag", "set_monitored")}
            if senses_needed:
                action_params = params.model_copy(
                    update={"actions": [a for a in params.actions if not a.type.startswith("search_")]}
                )
                for sense in sorted(senses_needed):
                    action_compiled = compile_candidates(action_params, entity, sense=sense)
                    row_sets[sense] = await self._run_db(
                        _select_rows,
                        action_compiled.select_sql,
                        {**action_compiled.binds, **runtime, "limit": self.SEARCHLESS_LIMIT},
                    )

            # "What would I have to fix before this show could retire" — answered
            # from the rows already in hand, so it costs a run no extra query.
            reason_rows = row_sets.get("non_conforming")
            if reason_rows is None and primary_sense == "non_conforming":
                reason_rows = candidates
            if reason_rows:
                inst_details.update(self._reason_summary(reason_rows, params, entity))

            if has_search and params.require.audio_language_any and not dry_run:
                try:
                    warning = _profile_language_warning(await client.list_custom_formats())
                    if warning:
                        inst_details["profile_warning"] = warning
                except Exception:
                    log.debug("custom format probe failed", exc_info=True)

            if dry_run:
                if has_search:
                    inst_details["would_do"] = [
                        {
                            "source_id": int(r["source_id"]),
                            "title": str(r.get("series_title") or r.get("title") or ""),
                            "actions": sorted(
                                {a.type for a in params.actions if a.type.startswith("search_")}
                            ),
                        }
                        for r in candidates
                    ]
                await self._preview_tag_actions(
                    client=client, params=params, entity=entity, row_sets=row_sets,
                    inst_details=inst_details,
                )
                await self._preview_monitored_actions(
                    client=client, params=params, entity=entity, row_sets=row_sets,
                    inst_details=inst_details,
                )
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
                budget_state["remaining"] = max(0, budget_state["remaining"] - len(item_ids))

            # The instance's search phase (search command + ledger write, if any) has
            # completed without raising — safe to merge this instance's buffered
            # dub-status observations into the run-level map now. Had the search
            # command or ledger write above raised, control would never reach this
            # line (the except clause below returns 0 first), so the buffer is
            # discarded wholesale and the none->dubbed transition re-qualifies for
            # search on the next run instead of being silently watermarked "seen"
            # against a search that never actually fired.
            dub_observations.update(local_dub_observations)

            await self._apply_tag_actions(
                client=client, params=params, entity=entity, row_sets=row_sets,
                counters=counters, inst_details=inst_details,
            )
            await self._apply_monitored_actions(
                client=client, params=params, entity=entity, row_sets=row_sets,
                counters=counters, inst_details=inst_details,
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
    def _target_ids(entity: str, rows: list[dict[str, Any]], sense: str) -> set[int]:
        """Item ids for movie rules and for the conforming series set (whose rows are
        already series, not episodes); owning-series ids for non-conforming episode
        rows, where the fault is an episode but the thing you act on is the show."""
        if entity == "movie" or sense == "conforming":
            return {int(r["source_id"]) for r in rows}
        return {int(r["series_source_id"]) for r in rows}

    @staticmethod
    def _reason_summary(
        rows: list[dict[str, Any]], params: RuleParams, entity: str
    ) -> dict[str, Any]:
        """Per-reason counts plus a bounded worst-offenders list, so "what has to be
        fixed before this show can retire" is answerable from the run row without
        re-querying. Series rules group by show: the fault sits on an episode, but
        the show is the unit you act on.
        """
        totals: dict[str, int] = {}
        per_item: dict[Any, dict[str, Any]] = {}
        for row in rows:
            # These rows are the non-conforming set by construction, so a row the
            # helper finds nothing wrong with means the SQL predicate and the helper
            # disagree — reported as 'unknown' rather than as a clean bill of health.
            reasons = failure_reasons(row, params.require) or ["unknown"]
            for reason in reasons:
                totals[reason] = totals.get(reason, 0) + 1
            if entity == "episode":
                key, title = row.get("series_source_id"), row.get("series_title") or ""
            else:
                key, title = row.get("source_id"), row.get("title") or ""
            entry = per_item.setdefault(key, {"title": str(title), "items": 0, "reasons": []})
            entry["items"] += 1
            entry["reasons"] = sorted(set(entry["reasons"]) | set(reasons))
        return {
            "failure_reasons": dict(sorted(totals.items(), key=lambda kv: (-kv[1], kv[0]))),
            # Bounded: a run row must stay a run row, not a copy of the library.
            "failure_worst": sorted(per_item.values(), key=lambda e: (-e["items"], e["title"]))[:20],
        }

    def _rows_for(self, row_sets: dict[str, list[dict[str, Any]]], sense: str) -> list[dict[str, Any]]:
        return row_sets.get(sense, [])

    async def _apply_tag_actions(
        self, *, client: Any, params: RuleParams, entity: str,
        row_sets: dict[str, list[dict[str, Any]]], counters: dict[str, int],
        inst_details: dict[str, Any],
    ) -> None:
        tag_actions = [a for a in params.actions if a.type == "tag"]
        if not tag_actions:
            return
        live_rows = await (client.list_movies() if entity == "movie" else client.list_series())
        for action in tag_actions:
            rows = self._rows_for(row_sets, action.when)
            desired_ids = self._target_ids(entity, rows, action.when)
            # The row set is capped at SEARCHLESS_LIMIT; hitting that cap means the
            # true set may be larger than what we saw. Removing tags off a truncated
            # view could strip the label from items that still genuinely belong in it,
            # so skip removals (adds stay safe: under-covering by omission is not the
            # same failure mode as over-removing).
            truncated = len(rows) >= self.SEARCHLESS_LIMIT
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
                elif not truncated and rid not in desired_ids and tag_id in tags:
                    remove.append(rid)
            for ids, op in ((add, "add"), (remove, "remove")):
                if not ids:
                    continue
                if entity == "movie":
                    await client.update_movie_tags(ids, [tag_id], op)
                else:
                    await client.update_series_tags(ids, [tag_id], op)
            counters["actions"] += len(add) + len(remove)
            detail: dict[str, Any] = {"added": len(add), "removed": len(remove)}
            if truncated:
                detail["removal_skipped"] = "candidate set truncated"
            inst_details[f"tag:{action.label}"] = detail

    async def _apply_monitored_actions(
        self, *, client: Any, params: RuleParams, entity: str,
        row_sets: dict[str, list[dict[str, Any]]],
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
            target_ids = self._target_ids(
                entity, self._rows_for(row_sets, action.when), action.when
            )
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

    async def _preview_tag_actions(
        self, *, client: Any, params: RuleParams, entity: str,
        row_sets: dict[str, list[dict[str, Any]]], inst_details: dict[str, Any],
    ) -> None:
        """Dry-run counterpart of _apply_tag_actions: GETs only, never ensure_tag_id
        (which creates a tag) and never an editor call — the zero-mutation invariant
        for dry runs is absolute."""
        tag_actions = [a for a in params.actions if a.type == "tag"]
        if not tag_actions:
            return
        live_rows = await (client.list_movies() if entity == "movie" else client.list_series())
        existing_tags = await client.list_tags()
        by_label = {
            str(t.get("label", "")).strip().casefold(): int(t["id"])
            for t in existing_tags
            if t.get("id") is not None
        }
        for action in tag_actions:
            desired_ids = self._target_ids(
                entity, self._rows_for(row_sets, action.when), action.when
            )
            tag_id = by_label.get((action.label or "").strip().casefold())
            if tag_id is None:
                # The tag doesn't exist yet on this instance: nothing to remove, and
                # every desired item would be a fresh add once the tag is created.
                add_ids = sorted(desired_ids)
                remove_ids: list[int] = []
            else:
                add_ids = []
                remove_ids = []
                for row in live_rows:
                    raw_id = row.get("id")
                    if raw_id is None:
                        continue
                    rid = int(raw_id)
                    tags = {int(t) for t in (row.get("tags") or []) if t is not None}
                    if rid in desired_ids and tag_id not in tags:
                        add_ids.append(rid)
                    elif rid not in desired_ids and tag_id in tags:
                        remove_ids.append(rid)
                add_ids.sort()
                remove_ids.sort()
            inst_details[f"would_tag:{action.label}"] = {
                "added": len(add_ids),
                "removed": len(remove_ids),
                "added_sample": add_ids[:20],
                "removed_sample": remove_ids[:20],
            }

    async def _preview_monitored_actions(
        self, *, client: Any, params: RuleParams, entity: str,
        row_sets: dict[str, list[dict[str, Any]]], inst_details: dict[str, Any],
    ) -> None:
        """Dry-run counterpart of _apply_monitored_actions: GETs only, never an
        editor call."""
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
            target_ids = self._target_ids(
                entity, self._rows_for(row_sets, action.when), action.when
            )
            desired = bool(action.value)
            changed = sorted(
                rid for rid in target_ids if rid in live_monitored and live_monitored[rid] != desired
            )
            inst_details[f"would_monitor:{action.when}"] = {
                "changed": len(changed),
                "sample": changed[:20],
            }
