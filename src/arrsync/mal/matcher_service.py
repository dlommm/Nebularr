from __future__ import annotations

import json
import logging
import re
from typing import Any

from sqlalchemy import text

from arrsync.config import Settings
from arrsync.db import session_scope
from arrsync.mal import repository as mal_repo
from arrsync.services import repository as repo
from arrsync.services.mal_config_store import read_mal_feature_flags

log = logging.getLogger(__name__)


def _norm_title(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (value or "").lower())


def _normalized_title_variants(main_title: str | None, additional_titles: Any) -> list[str]:
    """Distinct normalized keys for title+year matching (Sonarr/Radarr title vs MAL strings)."""
    raw: list[str] = []
    if main_title and str(main_title).strip():
        raw.append(str(main_title).strip())
    if isinstance(additional_titles, list):
        for x in additional_titles:
            if x is not None and str(x).strip():
                raw.append(str(x).strip())
    seen: set[str] = set()
    out: list[str] = []
    for s in raw:
        nt = _norm_title(s)
        if nt and nt not in seen:
            seen.add(nt)
            out.append(nt)
    return out


def _mal_year(start_date: str | None) -> int | None:
    if not start_date or len(str(start_date)) < 4:
        return None
    try:
        return int(str(start_date)[:4])
    except ValueError:
        return None


class MalMatcherService:
    def __init__(self, settings: Settings, session_factory: Any) -> None:
        self.settings = settings
        self.session_factory = session_factory

    def _apply_title_year(self, session: Any, *, allow_title_year_match: bool) -> int:
        if not allow_title_year_match:
            return 0
        rows = session.execute(
            text(
                """
                select a.mal_id, a.main_title, a.start_date, a.media_type,
                       coalesce(a.additional_titles, '[]'::jsonb) as additional_titles
                from mal.anime a
                where a.is_english_dubbed = true
                  and not exists (select 1 from mal.warehouse_link l where l.mal_id = a.mal_id)
                  and (
                        coalesce(trim(a.main_title), '') <> ''
                        or coalesce(jsonb_array_length(coalesce(a.additional_titles, '[]'::jsonb)), 0) > 0
                      )
                """
            )
        ).mappings()
        anime_rows = list(rows)
        if not anime_rows:
            return 0
        sonarr_targets = [r for r in anime_rows if str(r.get("media_type") or "").lower() != "movie"]
        movie_targets = [r for r in anime_rows if str(r.get("media_type") or "").lower() == "movie"]
        sonarr_instances = repo.list_enabled_integrations(session, "sonarr")
        inserted = 0
        for inst in sonarr_instances:
            instance_name = str(inst["name"])
            series_rows = session.execute(
                text(
                    """
                    select source_id, title, payload
                    from warehouse.series
                    where instance_name = :instance_name and deleted = false
                    """
                ),
                {"instance_name": instance_name},
            ).mappings()
            by_norm: dict[str, list[tuple[int, int | None]]] = {}
            for sr in series_rows:
                sid = int(sr["source_id"])
                title = str(sr["title"] or "")
                payload = sr["payload"] or {}
                year = payload.get("year")
                y = int(year) if year is not None else None
                nt = _norm_title(title)
                if not nt:
                    continue
                by_norm.setdefault(nt, []).append((sid, y))

            for ar in sonarr_targets:
                mal_id = int(ar["mal_id"])
                add_titles = ar["additional_titles"]
                if not isinstance(add_titles, list):
                    add_titles = []
                norm_keys = _normalized_title_variants(ar.get("main_title"), add_titles)
                if not norm_keys:
                    continue
                my = _mal_year(ar["start_date"])
                sid: int | None = None
                matched_norm: str | None = None
                for mt in norm_keys:
                    candidates = by_norm.get(mt, [])
                    if not candidates:
                        continue
                    filtered = candidates
                    if my is not None:
                        close = [(s, y) for s, y in candidates if y is None or abs(y - my) <= 1]
                        if close:
                            filtered = close
                    if len(filtered) != 1:
                        log.debug(
                            "title_year match ambiguous mal_id=%s instance=%s candidates=%s",
                            mal_id,
                            instance_name,
                            len(filtered),
                        )
                        continue
                    sid = int(filtered[0][0])
                    matched_norm = mt
                    break
                if sid is None or matched_norm is None:
                    continue
                session.execute(
                    text(
                        """
                        insert into mal.warehouse_link (
                            mal_id, instance_name, arr_entity, warehouse_source_id,
                            match_method, confidence, match_detail, last_verified_at, updated_at
                        )
                        values (
                            :mal_id, :instance_name, 'sonarr_series', :sid,
                            'title_year', 'medium',
                            cast(:detail as jsonb), now(), now()
                        )
                        on conflict (mal_id, instance_name, arr_entity) do update
                        set warehouse_source_id = excluded.warehouse_source_id,
                            match_method = excluded.match_method,
                            confidence = excluded.confidence,
                            match_detail = excluded.match_detail,
                            last_verified_at = now(),
                            updated_at = now()
                        """
                    ),
                    {
                        "mal_id": mal_id,
                        "instance_name": instance_name,
                        "sid": sid,
                        "detail": json.dumps({"normalized_title": matched_norm}),
                    },
                )
                inserted += 1

        radarr_instances = repo.list_enabled_integrations(session, "radarr")
        for inst in radarr_instances:
            instance_name = str(inst["name"])
            movie_rows = session.execute(
                text(
                    """
                    select source_id, title, payload
                    from warehouse.movie
                    where instance_name = :instance_name and deleted = false
                    """
                ),
                {"instance_name": instance_name},
            ).mappings()
            by_norm_m: dict[str, list[tuple[int, int | None]]] = {}
            for mr in movie_rows:
                mid = int(mr["source_id"])
                title = str(mr["title"] or "")
                payload = mr["payload"] or {}
                year = payload.get("year")
                y = int(year) if year is not None else None
                nt = _norm_title(title)
                if not nt:
                    continue
                by_norm_m.setdefault(nt, []).append((mid, y))

            for ar in movie_targets:
                mal_id = int(ar["mal_id"])
                add_titles = ar["additional_titles"]
                if not isinstance(add_titles, list):
                    add_titles = []
                norm_keys = _normalized_title_variants(ar.get("main_title"), add_titles)
                if not norm_keys:
                    continue
                my = _mal_year(ar["start_date"])
                mid_match: int | None = None
                matched_norm: str | None = None
                for mt in norm_keys:
                    candidates = by_norm_m.get(mt, [])
                    if not candidates:
                        continue
                    filtered = candidates
                    if my is not None:
                        close = [(m, y) for m, y in candidates if y is None or abs(y - my) <= 1]
                        if close:
                            filtered = close
                    if len(filtered) != 1:
                        log.debug(
                            "title_year radarr ambiguous mal_id=%s instance=%s candidates=%s",
                            mal_id,
                            instance_name,
                            len(filtered),
                        )
                        continue
                    mid_match = int(filtered[0][0])
                    matched_norm = mt
                    break
                if mid_match is None or matched_norm is None:
                    continue
                session.execute(
                    text(
                        """
                        insert into mal.warehouse_link (
                            mal_id, instance_name, arr_entity, warehouse_source_id,
                            match_method, confidence, match_detail, last_verified_at, updated_at
                        )
                        values (
                            :mal_id, :instance_name, 'radarr_movie', :mid,
                            'title_year', 'medium',
                            cast(:detail as jsonb), now(), now()
                        )
                        on conflict (mal_id, instance_name, arr_entity) do update
                        set warehouse_source_id = excluded.warehouse_source_id,
                            match_method = excluded.match_method,
                            confidence = excluded.confidence,
                            match_detail = excluded.match_detail,
                            last_verified_at = now(),
                            updated_at = now()
                        """
                    ),
                    {
                        "mal_id": mal_id,
                        "instance_name": instance_name,
                        "mid": mid_match,
                        "detail": json.dumps({"normalized_title": matched_norm, "arr": "radarr"}),
                    },
                )
                inserted += 1
        return inserted

    def run(self, *, reason: str = "manual") -> dict[str, Any]:
        details: dict[str, Any] = {"reason": reason}
        with session_scope(self.session_factory) as session:
            run_id = mal_repo.insert_mal_job_run(session, "matcher")
        try:
            with session_scope(self.session_factory) as session:
                mal_flags = read_mal_feature_flags(session, self.settings)
            details["allow_title_year_match"] = bool(mal_flags["allow_title_year_match"])
            with session_scope(self.session_factory) as session:
                mal_repo.delete_links_for_undubbed(session)
                mal_repo.clear_auto_warehouse_links(session)
                details["tvdb_series_links"] = mal_repo.insert_tvdb_series_links(session)
                details["tmdb_movie_links"] = mal_repo.insert_tmdb_radarr_links(session)
                details["imdb_movie_links"] = mal_repo.insert_imdb_radarr_links(session)
                details["title_year_links"] = self._apply_title_year(
                    session, allow_title_year_match=bool(mal_flags["allow_title_year_match"])
                )
                details["manual_links_applied"] = mal_repo.upsert_manual_warehouse_links(session)
                external_backfill = mal_repo.backfill_external_ids_from_links(session)
                details["external_ids_backfilled_tvdb"] = int(external_backfill.get("tvdb", 0))
                details["external_ids_backfilled_tmdb"] = int(external_backfill.get("tmdb", 0))
                details["external_ids_backfilled_imdb"] = int(external_backfill.get("imdb", 0))
                details["dubbed_unmatched_count"] = mal_repo.count_dubbed_without_link(session)
                details["unmatched_sample_mal_ids"] = mal_repo.sample_unmatched_mal_ids(session, 30)
            with session_scope(self.session_factory) as session:
                mal_repo.finish_mal_job_run(session, run_id, "success", details, None)
        except Exception as exc:
            log.exception("mal matcher failed")
            with session_scope(self.session_factory) as session:
                mal_repo.finish_mal_job_run(session, run_id, "failed", details, str(exc))
            raise
        return details
