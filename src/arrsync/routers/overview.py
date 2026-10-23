"""Read models for the Overview screen: the 24-hour sync lanes and recent imports."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query
from sqlalchemy import text

from arrsync.routers.shared import clamp_limit

WEBHOOK_EVENT_CAP = 500


def _first(rows: Any) -> dict[str, Any]:
    return dict(next(iter(rows), None) or {})


def build_overview_router(app_state: Any) -> APIRouter:
    router = APIRouter()

    @router.get("/api/ui/run-timeline")
    def run_timeline(hours: int = Query(24, ge=1, le=168)) -> dict[str, Any]:
        """One lane per enabled Arr instance plus webhooks and MyAnimeList, each
        holding every run that started inside the window. ``last_at`` reaches
        back past the window so a silent lane can still say when it last ran."""
        bind = {"hours": hours}
        with app_state.session_scope() as session:
            now = session.execute(text("select now()")).scalar_one()
            instances = session.execute(
                text(
                    "select source, name from app.integration_instance "
                    "where enabled = true order by source desc, name"
                )
            ).mappings()
            lanes: dict[str, dict[str, Any]] = {}
            for row in instances:
                key = f"{row['source']}:{row['name']}"
                lanes[key] = {
                    "key": key,
                    "label": str(row["name"]),
                    "kind": str(row["source"]),
                    "events": [],
                    "last_at": None,
                }
            runs = session.execute(
                text(
                    """
                    select source, instance_name, mode, status, started_at, finished_at, rows_written
                    from app.job_run_summary
                    where started_at >= now() - make_interval(hours => :hours)
                      and mode <> 'webhook'
                    order by started_at
                    """
                ),
                bind,
            ).mappings()
            for run in runs:
                key = f"{run['source']}:{run['instance_name']}"
                lane = lanes.setdefault(
                    key,
                    {"key": key, "label": str(run["instance_name"]), "kind": str(run["source"]), "events": []},
                )
                duration = None
                if run["finished_at"] is not None:
                    duration = round((run["finished_at"] - run["started_at"]).total_seconds(), 1)
                lane["events"].append(
                    {
                        "at": run["started_at"],
                        "kind": str(run["mode"]),
                        "status": str(run["status"]),
                        "rows": int(run["rows_written"] or 0),
                        "duration_seconds": duration,
                    }
                )
            last_rows = session.execute(
                text(
                    """
                    select source, instance_name, max(started_at) as last_at
                    from app.job_run_summary
                    where mode <> 'webhook'
                    group by source, instance_name
                    """
                )
            ).mappings()
            for row in last_rows:
                existing = lanes.get(f"{row['source']}:{row['instance_name']}")
                if existing is not None:
                    existing["last_at"] = row["last_at"]

            hooks = session.execute(
                text(
                    """
                    select received_at, status, source
                    from app.webhook_queue
                    where received_at >= now() - make_interval(hours => :hours)
                    order by received_at desc
                    limit :cap
                    """
                ),
                {**bind, "cap": WEBHOOK_EVENT_CAP},
            ).mappings()
            hook_events = [
                {"at": h["received_at"], "kind": "webhook", "status": str(h["status"]), "source": str(h["source"])}
                for h in hooks
            ]
            last_hook = session.execute(text("select max(received_at) from app.webhook_queue")).scalar_one_or_none()

            mal_runs = session.execute(
                text(
                    """
                    select job_type, status, started_at, finished_at
                    from app.mal_job_run
                    where started_at >= now() - make_interval(hours => :hours)
                    order by started_at
                    """
                ),
                bind,
            ).mappings()
            mal_events = [
                {
                    "at": r["started_at"],
                    "kind": str(r["job_type"]),
                    "status": str(r["status"]),
                    "duration_seconds": (
                        round((r["finished_at"] - r["started_at"]).total_seconds(), 1)
                        if r["finished_at"] is not None
                        else None
                    ),
                }
                for r in mal_runs
            ]
            last_mal = session.execute(text("select max(started_at) from app.mal_job_run")).scalar_one_or_none()

        result = list(lanes.values())
        result.append(
            {
                "key": "webhooks",
                "label": "Webhooks",
                "kind": "webhooks",
                "events": list(reversed(hook_events)),
                "last_at": last_hook,
                "truncated": len(hook_events) >= WEBHOOK_EVENT_CAP,
            }
        )
        if mal_events or last_mal is not None:
            result.append(
                {"key": "mal", "label": "MyAnimeList", "kind": "mal", "events": mal_events, "last_at": last_mal}
            )
        return {"now": now, "hours": hours, "lanes": result}

    @router.get("/api/ui/library-totals")
    def library_totals() -> dict[str, Any]:
        """The Overview's headline figures in one cheap pass per table. "Missing"
        follows the coverage views: monitored, already aired (or available, for
        movies), and no file per the Arr's own ``hasFile``."""
        with app_state.session_scope() as session:
            episodes = _first(session.execute(
                text(
                    """
                    select
                        count(*) as episodes,
                        count(*) filter (where coalesce((payload->>'hasFile')::boolean, false)) as on_disk,
                        count(*) filter (
                            where monitored
                              and air_date is not null
                              and air_date <= now()
                              and not coalesce((payload->>'hasFile')::boolean, false)
                        ) as missing
                    from warehouse.episode
                    where not deleted
                    """
                )
            ).mappings())
            movies = _first(session.execute(
                text(
                    """
                    select
                        count(*) as movies,
                        count(*) filter (where coalesce((payload->>'hasFile')::boolean, false)) as on_disk,
                        count(*) filter (
                            where monitored
                              and coalesce((payload->>'isAvailable')::boolean, true)
                              and not coalesce((payload->>'hasFile')::boolean, false)
                        ) as missing
                    from warehouse.movie
                    where not deleted
                    """
                )
            ).mappings())
            shows = session.execute(text("select count(*) from warehouse.series where not deleted")).scalar_one()
            stored = session.execute(
                text(
                    """
                    select
                        coalesce((select sum(size_bytes) from warehouse.episode_file where not deleted), 0)
                      + coalesce((select sum(size_bytes) from warehouse.movie_file where not deleted), 0)
                    """
                )
            ).scalar_one()
        return {
            "shows": int(shows or 0),
            "episodes": int(episodes.get("episodes") or 0),
            "episodes_on_disk": int(episodes.get("on_disk") or 0),
            "episodes_missing": int(episodes.get("missing") or 0),
            "movies": int(movies.get("movies") or 0),
            "movies_on_disk": int(movies.get("on_disk") or 0),
            "movies_missing": int(movies.get("missing") or 0),
            "stored_bytes": int(stored or 0),
        }

    @router.get("/api/ui/recent-imports")
    def recent_imports(limit: int = 12) -> dict[str, Any]:
        """Newest files the warehouse has seen, episodes and movies together.
        ``seen_at`` is set once when a file row first appears (an import or an
        upgrade's replacement file); the Arr's own ``dateAdded`` breaks ties, which
        matters right after the first full sync when every file arrives at once."""
        bounded = clamp_limit(limit, default=12, max_limit=60)
        with app_state.session_scope() as session:
            rows = session.execute(
                text(
                    """
                    select * from (
                        (
                            select
                                'episode' as kind,
                                s.instance_name,
                                s.source_id as item_id,
                                s.title,
                                nullif(s.payload->>'year', '')::int as year,
                                e.season_number,
                                e.episode_number,
                                e.title as episode_title,
                                ef.quality,
                                ef.size_bytes,
                                ef.video_codec,
                                ef.audio_codec,
                                ef.path,
                                ef.seen_at as seen_at,
                                ef.payload->>'dateAdded' as date_added
                            from warehouse.episode_file ef
                            join warehouse.episode e
                              on e.source_id = ef.episode_source_id
                             and e.instance_name = ef.instance_name
                            join warehouse.series s
                              on s.source_id = e.series_source_id
                             and s.instance_name = e.instance_name
                            where not ef.deleted and not s.deleted
                            order by ef.seen_at desc, ef.payload->>'dateAdded' desc nulls last
                            limit :limit
                        )
                        union all
                        (
                            select
                                'movie' as kind,
                                m.instance_name,
                                m.source_id as item_id,
                                m.title,
                                m.year,
                                null::int as season_number,
                                null::int as episode_number,
                                null::text as episode_title,
                                mf.quality,
                                mf.size_bytes,
                                mf.video_codec,
                                mf.audio_codec,
                                mf.path,
                                mf.seen_at as seen_at,
                                mf.payload->>'dateAdded' as date_added
                            from warehouse.movie_file mf
                            join warehouse.movie m
                              on m.source_id = mf.movie_source_id
                             and m.instance_name = mf.instance_name
                            where not mf.deleted and not m.deleted
                            order by mf.seen_at desc, mf.payload->>'dateAdded' desc nulls last
                            limit :limit
                        )
                    ) as imports
                    order by seen_at desc, date_added desc nulls last
                    limit :limit
                    """
                ),
                {"limit": bounded},
            ).mappings()
            return {"items": [dict(r) for r in rows]}

    return router
