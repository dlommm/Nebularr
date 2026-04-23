from __future__ import annotations

import asyncio
import csv
import hashlib
import io
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from apscheduler.triggers.cron import CronTrigger
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse
from sqlalchemy import text

from arrsync.services import repository as repo
from arrsync.services.alert_config_store import (
    read_alert_webhook_config,
    store_alert_webhook_options,
    store_alert_webhook_urls,
)
from arrsync.services.health_service import compute_health_status
from arrsync.security import encrypt_secret, hash_secret, verify_secret_hash


def build_router(app_state: Any) -> APIRouter:
    router = APIRouter()
    reporting_max_limit = 1_000_000
    web_ui_dir = Path(__file__).with_name("web")
    web_ui_path = web_ui_dir.joinpath("index.html")
    web_dist_dir = web_ui_dir.joinpath("dist")
    web_dist_index = web_dist_dir.joinpath("index.html")
    web_assets_dir = web_ui_dir.joinpath("assets")
    setup_sync_task: asyncio.Task[None] | None = None
    setup_sync_sources: list[str] = []

    def _bounded_limit(limit: int, default: int = 200, max_limit: int = 2000) -> int:
        if limit <= 0:
            return default
        return min(limit, max_limit)

    def _bounded_offset(offset: int) -> int:
        if offset <= 0:
            return 0
        return offset

    def _paged_response(items: list[dict[str, Any]], total: int, limit: int, offset: int) -> dict[str, Any]:
        return {
            "items": items,
            "total": int(total),
            "limit": int(limit),
            "offset": int(offset),
            "has_more": (offset + len(items)) < int(total),
        }

    def _normalize_sort(sort_by: str, sort_dir: str, allowed: dict[str, str], default_sort: str) -> tuple[str, str]:
        normalized_key = sort_by.strip().lower() if sort_by else default_sort
        normalized_dir = sort_dir.strip().lower() if sort_dir else "asc"
        if normalized_key not in allowed:
            normalized_key = default_sort
        if normalized_dir not in {"asc", "desc"}:
            normalized_dir = "asc"
        return allowed[normalized_key], normalized_dir

    def _search_params(search: str) -> tuple[str, str]:
        normalized = search.strip()
        return normalized, f"%{normalized}%"

    def _to_bool(value: Any, default: bool = False) -> bool:
        if isinstance(value, bool):
            return value
        normalized = str(value).strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
        return default

    def _parse_webhook_urls(raw: Any) -> list[str]:
        if isinstance(raw, list):
            return [str(item).strip() for item in raw if str(item).strip()]
        if not isinstance(raw, str):
            return []
        urls: list[str] = []
        for line in raw.splitlines():
            for part in line.split(","):
                value = part.strip()
                if value:
                    urls.append(value)
        return urls

    def _get_setting(session: Any, key: str, default: str = "") -> str:
        value = session.execute(
            text("select value from app.settings where key = :key"),
            {"key": key},
        ).scalar_one_or_none()
        return str(value) if value is not None else default

    def _set_setting(session: Any, key: str, value: str) -> None:
        session.execute(
            text(
                """
                insert into app.settings(key, value, updated_at)
                values(:key, :value, now())
                on conflict (key) do update
                set value = excluded.value,
                    updated_at = now()
                """
            ),
            {"key": key, "value": value},
        )

    def _csv_response(filename: str, rows: list[dict[str, Any]]) -> PlainTextResponse:
        output = io.StringIO()
        if rows:
            fieldnames = list(rows[0].keys())
            writer = csv.DictWriter(output, fieldnames=fieldnames)
            writer.writeheader()
            for row in rows:
                normalized: dict[str, Any] = {}
                for key, value in row.items():
                    if isinstance(value, (list, dict)):
                        normalized[key] = json.dumps(value, default=str)
                    else:
                        normalized[key] = value
                writer.writerow(normalized)
        return PlainTextResponse(
            output.getvalue(),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    def _query_shows(
        search: str,
        limit: int,
        offset: int,
        sort_by: str,
        sort_dir: str,
        paged: bool,
    ) -> list[dict[str, Any]] | dict[str, Any]:
        normalized, search_like = _search_params(search)
        bounded_limit = _bounded_limit(limit)
        bounded_offset = _bounded_offset(offset)
        sort_map = {
            "title": "s.title",
            "instance_name": "s.instance_name",
            "episode_count": "episode_count",
            "season_count": "season_count",
            "last_seen_at": "s.last_seen_at",
        }
        sort_expr, direction = _normalize_sort(sort_by, sort_dir, sort_map, "title")
        with app_state.session_scope() as session:
            total = session.execute(
                text(
                    """
                    select count(*)
                    from warehouse.series s
                    where not s.deleted
                      and (:search = '' or s.title ilike :search_like)
                    """
                ),
                {"search": normalized, "search_like": search_like},
            ).scalar_one()
            rows = session.execute(
                text(
                    f"""
                    select
                        s.instance_name,
                        s.source_id as series_id,
                        s.title,
                        s.monitored,
                        s.status,
                        s.path,
                        count(e.source_id) filter (where not e.deleted) as episode_count,
                        count(distinct e.season_number) filter (where not e.deleted) as season_count,
                        s.last_seen_at
                    from warehouse.series s
                    left join warehouse.episode e
                        on e.series_source_id = s.source_id
                       and e.instance_name = s.instance_name
                    where not s.deleted
                      and (:search = '' or s.title ilike :search_like)
                    group by s.instance_name, s.source_id, s.title, s.monitored, s.status, s.path, s.last_seen_at
                    order by {sort_expr} {direction}, s.source_id asc
                    limit :limit
                    offset :offset
                    """
                ),
                {
                    "search": normalized,
                    "search_like": search_like,
                    "limit": bounded_limit,
                    "offset": bounded_offset,
                },
            ).mappings()
            items = [dict(r) for r in rows]
            if paged:
                return _paged_response(items, int(total), bounded_limit, bounded_offset)
            return items

    def _query_show_episodes(
        series_id: int,
        instance_name: str,
        season_number: int | None,
        limit: int,
        offset: int,
        sort_by: str,
        sort_dir: str,
        paged: bool,
    ) -> list[dict[str, Any]] | dict[str, Any]:
        bounded_limit = _bounded_limit(limit, default=500, max_limit=5000)
        bounded_offset = _bounded_offset(offset)
        sort_map = {
            "season_number": "e.season_number",
            "episode_number": "e.episode_number",
            "air_date": "e.air_date",
            "episode_title": "e.title",
            "size_bytes": "ef.size_bytes",
        }
        sort_expr, direction = _normalize_sort(sort_by, sort_dir, sort_map, "season_number")
        with app_state.session_scope() as session:
            total = session.execute(
                text(
                    """
                    select count(*)
                    from warehouse.episode e
                    join warehouse.series s
                      on s.source_id = e.series_source_id
                     and s.instance_name = e.instance_name
                    where not s.deleted
                      and not e.deleted
                      and e.series_source_id = :series_id
                      and e.instance_name = :instance_name
                      and (cast(:season_number as int) is null or e.season_number = cast(:season_number as int))
                    """
                ),
                {
                    "series_id": series_id,
                    "instance_name": instance_name,
                    "season_number": season_number,
                },
            ).scalar_one()
            rows = session.execute(
                text(
                    f"""
                    select
                        e.instance_name,
                        e.series_source_id as series_id,
                        s.title as series_title,
                        e.source_id as episode_id,
                        e.season_number,
                        e.episode_number,
                        e.payload ->> 'absoluteEpisodeNumber' as absolute_episode_number,
                        e.title as episode_title,
                        e.air_date,
                        e.runtime_minutes,
                        e.monitored,
                        coalesce((e.payload ->> 'hasFile')::boolean, false) as has_file,
                        ef.path as file_path,
                        ef.payload ->> 'relativePath' as relative_path,
                        ef.size_bytes,
                        ef.quality,
                        coalesce(ef.payload -> 'mediaInfo' ->> 'audioCodec', ef.audio_codec) as audio_codec,
                        coalesce(ef.payload -> 'mediaInfo' ->> 'audioChannels', ef.audio_channels) as audio_channels,
                        coalesce(ef.payload -> 'mediaInfo' ->> 'videoCodec', ef.video_codec) as video_codec,
                        ef.payload -> 'mediaInfo' ->> 'videoDynamicRange' as video_dynamic_range,
                        ef.audio_languages,
                        ef.subtitle_languages,
                        ef.payload ->> 'releaseGroup' as release_group,
                        ef.payload -> 'customFormats' as custom_formats,
                        ef.payload ->> 'customFormatScore' as custom_format_score,
                        ef.payload ->> 'indexerFlags' as indexer_flags,
                        s.status as series_status
                    from warehouse.episode e
                    join warehouse.series s
                      on s.source_id = e.series_source_id
                     and s.instance_name = e.instance_name
                    left join warehouse.episode_file ef
                      on ef.episode_source_id = e.source_id
                     and ef.instance_name = e.instance_name
                     and not ef.deleted
                    where not s.deleted
                      and not e.deleted
                      and e.series_source_id = :series_id
                      and e.instance_name = :instance_name
                      and (cast(:season_number as int) is null or e.season_number = cast(:season_number as int))
                    order by {sort_expr} {direction}, e.source_id asc
                    limit :limit
                    offset :offset
                    """
                ),
                {
                    "series_id": series_id,
                    "instance_name": instance_name,
                    "season_number": season_number,
                    "limit": bounded_limit,
                    "offset": bounded_offset,
                },
            ).mappings()
            items = [dict(r) for r in rows]
            if paged:
                return _paged_response(items, int(total), bounded_limit, bounded_offset)
            return items

    def _query_show_seasons(series_id: int, instance_name: str) -> list[dict[str, Any]]:
        with app_state.session_scope() as session:
            rows = session.execute(
                text(
                    """
                    select distinct e.season_number
                    from warehouse.episode e
                    where not e.deleted
                      and e.series_source_id = :series_id
                      and e.instance_name = :instance_name
                    order by e.season_number
                    """
                ),
                {"series_id": series_id, "instance_name": instance_name},
            ).mappings()
            return [dict(r) for r in rows]

    def _query_all_episodes(
        search: str,
        instance_name: str,
        limit: int,
        offset: int,
        sort_by: str,
        sort_dir: str,
        paged: bool,
    ) -> list[dict[str, Any]] | dict[str, Any]:
        normalized, search_like = _search_params(search)
        normalized_instance = instance_name.strip()
        bounded_limit = _bounded_limit(limit, default=500, max_limit=5000)
        bounded_offset = _bounded_offset(offset)
        sort_map = {
            "series_title": "s.title",
            "instance_name": "e.instance_name",
            "season_number": "e.season_number",
            "episode_number": "e.episode_number",
            "air_date": "e.air_date",
            "size_bytes": "ef.size_bytes",
        }
        sort_expr, direction = _normalize_sort(sort_by, sort_dir, sort_map, "series_title")
        with app_state.session_scope() as session:
            total = session.execute(
                text(
                    """
                    select count(*)
                    from warehouse.episode e
                    join warehouse.series s
                      on s.source_id = e.series_source_id
                     and s.instance_name = e.instance_name
                    where not s.deleted
                      and not e.deleted
                      and (:instance_name = '' or e.instance_name = :instance_name)
                      and (
                        :search = ''
                        or s.title ilike :search_like
                        or e.title ilike :search_like
                      )
                    """
                ),
                {
                    "search": normalized,
                    "search_like": search_like,
                    "instance_name": normalized_instance,
                },
            ).scalar_one()
            rows = session.execute(
                text(
                    f"""
                    select
                        e.instance_name,
                        e.series_source_id as series_id,
                        s.title as series_title,
                        e.source_id as episode_id,
                        e.season_number,
                        e.episode_number,
                        e.payload ->> 'absoluteEpisodeNumber' as absolute_episode_number,
                        e.title as episode_title,
                        e.air_date,
                        e.runtime_minutes,
                        e.monitored,
                        coalesce((e.payload ->> 'hasFile')::boolean, false) as has_file,
                        ef.path as file_path,
                        ef.payload ->> 'relativePath' as relative_path,
                        ef.size_bytes,
                        ef.quality,
                        coalesce(ef.payload -> 'mediaInfo' ->> 'audioCodec', ef.audio_codec) as audio_codec,
                        coalesce(ef.payload -> 'mediaInfo' ->> 'audioChannels', ef.audio_channels) as audio_channels,
                        coalesce(ef.payload -> 'mediaInfo' ->> 'videoCodec', ef.video_codec) as video_codec,
                        ef.payload -> 'mediaInfo' ->> 'videoDynamicRange' as video_dynamic_range,
                        ef.audio_languages,
                        ef.subtitle_languages,
                        ef.payload ->> 'releaseGroup' as release_group,
                        ef.payload -> 'customFormats' as custom_formats,
                        ef.payload ->> 'customFormatScore' as custom_format_score,
                        ef.payload ->> 'indexerFlags' as indexer_flags,
                        s.status as series_status
                    from warehouse.episode e
                    join warehouse.series s
                      on s.source_id = e.series_source_id
                     and s.instance_name = e.instance_name
                    left join warehouse.episode_file ef
                      on ef.episode_source_id = e.source_id
                     and ef.instance_name = e.instance_name
                     and not ef.deleted
                    where not s.deleted
                      and not e.deleted
                      and (:instance_name = '' or e.instance_name = :instance_name)
                      and (
                        :search = ''
                        or s.title ilike :search_like
                        or e.title ilike :search_like
                      )
                    order by {sort_expr} {direction}, e.source_id asc
                    limit :limit
                    offset :offset
                    """
                ),
                {
                    "search": normalized,
                    "search_like": search_like,
                    "instance_name": normalized_instance,
                    "limit": bounded_limit,
                    "offset": bounded_offset,
                },
            ).mappings()
            items = [dict(r) for r in rows]
            if paged:
                return _paged_response(items, int(total), bounded_limit, bounded_offset)
            return items

    def _query_movies(
        search: str,
        instance_name: str,
        limit: int,
        offset: int,
        sort_by: str,
        sort_dir: str,
        paged: bool,
    ) -> list[dict[str, Any]] | dict[str, Any]:
        normalized, search_like = _search_params(search)
        normalized_instance = instance_name.strip()
        bounded_limit = _bounded_limit(limit, default=500, max_limit=5000)
        bounded_offset = _bounded_offset(offset)
        sort_map = {
            "title": "m.title",
            "year": "m.year",
            "instance_name": "m.instance_name",
            "size_bytes": "mf.size_bytes",
            "last_seen_at": "m.last_seen_at",
        }
        sort_expr, direction = _normalize_sort(sort_by, sort_dir, sort_map, "title")
        with app_state.session_scope() as session:
            total = session.execute(
                text(
                    """
                    select count(*)
                    from warehouse.movie m
                    where not m.deleted
                      and (:instance_name = '' or m.instance_name = :instance_name)
                      and (:search = '' or m.title ilike :search_like)
                    """
                ),
                {
                    "search": normalized,
                    "search_like": search_like,
                    "instance_name": normalized_instance,
                },
            ).scalar_one()
            rows = session.execute(
                text(
                    f"""
                    select
                        m.instance_name,
                        m.source_id as movie_id,
                        m.title,
                        m.year,
                        m.payload ->> 'runtime' as runtime_minutes,
                        m.monitored,
                        m.status,
                        m.path as movie_path,
                        mf.source_id as movie_file_id,
                        mf.path as file_path,
                        mf.payload ->> 'relativePath' as relative_path,
                        mf.size_bytes,
                        mf.quality,
                        coalesce(mf.payload -> 'mediaInfo' ->> 'audioCodec', mf.audio_codec) as audio_codec,
                        coalesce(mf.payload -> 'mediaInfo' ->> 'audioChannels', mf.audio_channels) as audio_channels,
                        coalesce(mf.payload -> 'mediaInfo' ->> 'videoCodec', mf.video_codec) as video_codec,
                        mf.payload -> 'mediaInfo' ->> 'videoDynamicRange' as video_dynamic_range,
                        mf.audio_languages,
                        mf.subtitle_languages,
                        mf.payload ->> 'releaseGroup' as release_group,
                        mf.payload -> 'customFormats' as custom_formats,
                        mf.payload ->> 'customFormatScore' as custom_format_score,
                        mf.payload ->> 'indexerFlags' as indexer_flags,
                        m.last_seen_at
                    from warehouse.movie m
                    left join warehouse.movie_file mf
                      on mf.movie_source_id = m.source_id
                     and mf.instance_name = m.instance_name
                     and not mf.deleted
                    where not m.deleted
                      and (:instance_name = '' or m.instance_name = :instance_name)
                      and (:search = '' or m.title ilike :search_like)
                    order by {sort_expr} {direction}, m.source_id asc
                    limit :limit
                    offset :offset
                    """
                ),
                {
                    "search": normalized,
                    "search_like": search_like,
                    "instance_name": normalized_instance,
                    "limit": bounded_limit,
                    "offset": bounded_offset,
                },
            ).mappings()
            items = [dict(r) for r in rows]
            if paged:
                return _paged_response(items, int(total), bounded_limit, bounded_offset)
            return items

    def _query_monitored_mix(instance_name: str) -> list[dict[str, Any]]:
        normalized_instance = instance_name.strip()
        with app_state.session_scope() as session:
            rows = session.execute(
                text(
                    """
                    select label, sum(value)::bigint as value
                    from (
                      select concat('series:', case when monitored then 'monitored' else 'unmonitored' end) as label, count(*)::bigint as value
                      from warehouse.series
                      where not deleted
                        and (:instance_name = '' or instance_name = :instance_name)
                      group by 1
                      union all
                      select concat('movies:', case when monitored then 'monitored' else 'unmonitored' end) as label, count(*)::bigint as value
                      from warehouse.movie
                      where not deleted
                        and (:instance_name = '' or instance_name = :instance_name)
                      group by 1
                    ) x
                    group by label
                    order by value desc
                    """
                ),
                {"instance_name": normalized_instance},
            ).mappings()
            return [dict(r) for r in rows]

    def _query_reporting_overview(instance_name: str, limit: int) -> dict[str, Any]:
        normalized_instance = instance_name.strip()
        bounded_limit = _bounded_limit(limit, default=100, max_limit=reporting_max_limit)
        monitored_mix = _query_monitored_mix(normalized_instance)
        with app_state.session_scope() as session:
            episode_files = int(
                session.execute(
                    text(
                        """
                        select count(*)
                        from warehouse.v_episode_files
                        where (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
            )
            movie_files = int(
                session.execute(
                    text(
                        """
                        select count(*)
                        from warehouse.v_movie_files
                        where (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
            )
            missing_english = int(
                session.execute(
                    text(
                        """
                        select count(*)
                        from warehouse.v_episodes_missing_english_audio
                        where (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
            )
            files_over_3gib = int(
                session.execute(
                    text(
                        """
                        select count(*)
                        from warehouse.v_large_files
                        where (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
            )
            episode_quality = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select coalesce(quality, 'unknown') as label, count(*)::bigint as value
                        from warehouse.v_episode_files
                        where (:instance_name = '' or instance_name = :instance_name)
                        group by 1
                        order by value desc
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            movie_quality = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select coalesce(quality, 'unknown') as label, count(*)::bigint as value
                        from warehouse.v_movie_files
                        where (:instance_name = '' or instance_name = :instance_name)
                        group by 1
                        order by value desc
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            largest_episodes = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select
                            instance_name,
                            series_title,
                            season_number,
                            episode_number,
                            quality,
                            round(size_bytes::numeric / 1024 / 1024, 2) as size_mib,
                            path
                        from warehouse.v_episode_files
                        where size_bytes is not null
                          and (:instance_name = '' or instance_name = :instance_name)
                        order by size_bytes desc
                        limit :limit
                        """
                    ),
                    {"instance_name": normalized_instance, "limit": bounded_limit},
                ).mappings()
            ]
            largest_movies = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select
                            instance_name,
                            movie_title,
                            quality,
                            round(size_bytes::numeric / 1024 / 1024, 2) as size_mib,
                            path
                        from warehouse.v_movie_files
                        where size_bytes is not null
                          and (:instance_name = '' or instance_name = :instance_name)
                        order by size_bytes desc
                        limit :limit
                        """
                    ),
                    {"instance_name": normalized_instance, "limit": bounded_limit},
                ).mappings()
            ]
        return {
            "key": "overview",
            "title": "Overview",
            "description": "Portfolio summary and top file distributions.",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "panels": [
                {"id": "episode_files", "title": "Episode Files", "kind": "stat", "value": episode_files},
                {"id": "movie_files", "title": "Movie Files", "kind": "stat", "value": movie_files},
                {"id": "missing_english_audio", "title": "Episodes Missing English Audio", "kind": "stat", "value": missing_english},
                {"id": "files_over_3gib", "title": "Files Over 3 GiB", "kind": "stat", "value": files_over_3gib},
                {"id": "episode_quality_mix", "title": "Episode Quality Distribution", "kind": "distribution", "rows": episode_quality},
                {"id": "movie_quality_mix", "title": "Movie Quality Distribution", "kind": "distribution", "rows": movie_quality},
                {"id": "monitored_mix", "title": "Monitored vs Unmonitored (Series/Movies)", "kind": "distribution", "rows": monitored_mix},
                {"id": "largest_episode_files", "title": "Largest Episode Files", "kind": "table", "rows": largest_episodes},
                {"id": "largest_movie_files", "title": "Largest Movie Files", "kind": "table", "rows": largest_movies},
            ],
        }

    def _query_reporting_sonarr_forensics(instance_name: str, limit: int) -> dict[str, Any]:
        normalized_instance = instance_name.strip()
        bounded_limit = _bounded_limit(limit, default=200, max_limit=reporting_max_limit)
        monitored_mix = _query_monitored_mix(normalized_instance)
        with app_state.session_scope() as session:
            stats_row = session.execute(
                text(
                    """
                    select
                        count(*)::bigint as total_episodes,
                        count(*) filter (where monitored)::bigint as monitored_episodes,
                        round(100.0 * avg(case when coalesce((payload ->> 'hasFile')::boolean, false) then 1 else 0 end), 2) as has_file_pct
                    from warehouse.episode
                    where not deleted
                      and (:instance_name = '' or instance_name = :instance_name)
                    """
                ),
                {"instance_name": normalized_instance},
            ).mappings().one()
            episode_storage_gib = float(
                session.execute(
                    text(
                        """
                        select round(coalesce(sum(size_bytes), 0)::numeric / 1024 / 1024 / 1024, 2)
                        from warehouse.v_episode_files
                        where (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
            )
            quality_mix = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select coalesce(quality, 'unknown') as label, count(*)::bigint as value
                        from warehouse.v_episode_files
                        where (:instance_name = '' or instance_name = :instance_name)
                        group by 1
                        order by value desc
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            codec_pair_mix = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select concat(coalesce(audio_codec, 'unknown'), ' / ', coalesce(video_codec, 'unknown')) as label, count(*)::bigint as value
                        from warehouse.v_episode_files
                        where (:instance_name = '' or instance_name = :instance_name)
                        group by 1
                        order by value desc
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            audio_language_mix = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select coalesce(nullif(trim(lang), ''), 'unknown') as label, count(*)::bigint as value
                        from (
                            select unnest(coalesce(audio_languages, array['unknown'])) as lang
                            from warehouse.v_episode_files
                            where (:instance_name = '' or instance_name = :instance_name)
                        ) x
                        group by 1
                        order by value desc
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            subtitle_language_mix = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select coalesce(nullif(trim(lang), ''), 'unknown') as label, count(*)::bigint as value
                        from (
                            select unnest(coalesce(subtitle_languages, array['unknown'])) as lang
                            from warehouse.v_episode_files
                            where (:instance_name = '' or instance_name = :instance_name)
                        ) x
                        group by 1
                        order by value desc
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            size_bands = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select size_band as label, count(*)::bigint as value
                        from (
                            select
                                case
                                    when size_bytes < 262144000::bigint then '<250MB'
                                    when size_bytes < 524288000::bigint then '250-500MB'
                                    when size_bytes < 1073741824::bigint then '500MB-1GB'
                                    when size_bytes < 2147483648::bigint then '1-2GB'
                                    else '2GB+'
                                end as size_band
                            from warehouse.v_episode_files
                            where size_bytes is not null
                              and (:instance_name = '' or instance_name = :instance_name)
                        ) x
                        group by 1
                        order by value desc
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            inventory = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select
                            e.instance_name,
                            s.title as series_title,
                            e.season_number,
                            e.episode_number,
                            e.title as episode_title,
                            e.air_date,
                            e.runtime_minutes,
                            e.monitored,
                            s.monitored as series_monitored,
                            coalesce((e.payload ->> 'hasFile')::boolean, false) as has_file,
                            coalesce(ef.payload ->> 'relativePath', '') as relative_path,
                            ef.path as file_path,
                            ef.quality,
                            round(ef.size_bytes::numeric / 1024 / 1024, 2) as size_mib,
                            coalesce(ef.payload -> 'mediaInfo' ->> 'audioCodec', ef.audio_codec) as audio_codec,
                            coalesce(ef.payload -> 'mediaInfo' ->> 'videoCodec', ef.video_codec) as video_codec,
                            ef.audio_languages,
                            ef.subtitle_languages,
                            coalesce(ef.payload ->> 'releaseGroup', '') as release_group
                        from warehouse.episode e
                        join warehouse.series s
                          on s.source_id = e.series_source_id
                         and s.instance_name = e.instance_name
                         and not s.deleted
                        left join warehouse.episode_file ef
                          on ef.episode_source_id = e.source_id
                         and ef.instance_name = e.instance_name
                         and not ef.deleted
                        where not e.deleted
                          and (:instance_name = '' or e.instance_name = :instance_name)
                        order by s.title, e.season_number, e.episode_number
                        limit :limit
                        """
                    ),
                    {"instance_name": normalized_instance, "limit": bounded_limit},
                ).mappings()
            ]
            missing_files = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select
                            e.instance_name,
                            s.title as series_title,
                            e.season_number,
                            e.episode_number,
                            e.title as episode_title,
                            e.air_date,
                            e.monitored,
                            s.monitored as series_monitored,
                            coalesce((e.payload ->> 'episodeType'), '') as episode_type
                        from warehouse.episode e
                        join warehouse.series s
                          on s.source_id = e.series_source_id
                         and s.instance_name = e.instance_name
                         and not s.deleted
                        where not e.deleted
                          and coalesce((e.payload ->> 'hasFile')::boolean, false) is not true
                          and (:instance_name = '' or e.instance_name = :instance_name)
                        order by s.title, e.season_number, e.episode_number
                        limit :limit
                        """
                    ),
                    {"instance_name": normalized_instance, "limit": bounded_limit},
                ).mappings()
            ]
        return {
            "key": "sonarr-forensics",
            "title": "Sonarr Episode Forensics",
            "description": "Episode-level quality, codec, language, and missing-file analysis.",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "panels": [
                {"id": "total_episodes", "title": "Total Episodes", "kind": "stat", "value": int(stats_row["total_episodes"])},
                {"id": "monitored_episodes", "title": "Monitored Episodes", "kind": "stat", "value": int(stats_row["monitored_episodes"])},
                {"id": "has_file_pct", "title": "Has File Coverage %", "kind": "stat", "value": float(stats_row["has_file_pct"] or 0)},
                {"id": "episode_storage_gib", "title": "Episode Storage (GiB)", "kind": "stat", "value": episode_storage_gib},
                {"id": "quality_mix", "title": "Quality Distribution", "kind": "distribution", "rows": quality_mix},
                {"id": "codec_pair_mix", "title": "Top Codec Pairings", "kind": "distribution", "rows": codec_pair_mix},
                {"id": "audio_language_mix", "title": "Audio Language Mix", "kind": "distribution", "rows": audio_language_mix},
                {"id": "subtitle_language_mix", "title": "Subtitle Language Mix", "kind": "distribution", "rows": subtitle_language_mix},
                {"id": "size_band_mix", "title": "Episode File Size Bands", "kind": "distribution", "rows": size_bands},
                {"id": "monitored_mix", "title": "Monitored vs Unmonitored (Series/Movies)", "kind": "distribution", "rows": monitored_mix},
                {"id": "episode_inventory", "title": "Episode File Inventory", "kind": "table", "rows": inventory},
                {"id": "missing_files", "title": "Episodes Missing Files", "kind": "table", "rows": missing_files},
            ],
        }

    def _query_reporting_radarr_forensics(instance_name: str, limit: int) -> dict[str, Any]:
        normalized_instance = instance_name.strip()
        bounded_limit = _bounded_limit(limit, default=200, max_limit=reporting_max_limit)
        monitored_mix = _query_monitored_mix(normalized_instance)
        with app_state.session_scope() as session:
            stats_row = session.execute(
                text(
                    """
                    select
                        count(*)::bigint as total_movies,
                        count(*) filter (where monitored)::bigint as monitored_movies
                    from warehouse.movie
                    where not deleted
                      and (:instance_name = '' or instance_name = :instance_name)
                    """
                ),
                {"instance_name": normalized_instance},
            ).mappings().one()
            movie_storage_gib = float(
                session.execute(
                    text(
                        """
                        select round(coalesce(sum(size_bytes), 0)::numeric / 1024 / 1024 / 1024, 2)
                        from warehouse.v_movie_files
                        where (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
            )
            quality_mix = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select coalesce(quality, 'unknown') as label, count(*)::bigint as value
                        from warehouse.v_movie_files
                        where (:instance_name = '' or instance_name = :instance_name)
                        group by 1
                        order by value desc
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            codec_pair_mix = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select concat(coalesce(audio_codec, 'unknown'), ' / ', coalesce(video_codec, 'unknown')) as label, count(*)::bigint as value
                        from warehouse.v_movie_files
                        where (:instance_name = '' or instance_name = :instance_name)
                        group by 1
                        order by value desc
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            audio_language_mix = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select coalesce(nullif(trim(lang), ''), 'unknown') as label, count(*)::bigint as value
                        from (
                            select unnest(coalesce(audio_languages, array['unknown'])) as lang
                            from warehouse.v_movie_files
                            where (:instance_name = '' or instance_name = :instance_name)
                        ) x
                        group by 1
                        order by value desc
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            subtitle_language_mix = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select coalesce(nullif(trim(lang), ''), 'unknown') as label, count(*)::bigint as value
                        from (
                            select unnest(coalesce(subtitle_languages, array['unknown'])) as lang
                            from warehouse.v_movie_files
                            where (:instance_name = '' or instance_name = :instance_name)
                        ) x
                        group by 1
                        order by value desc
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            size_bands = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select size_band as label, count(*)::bigint as value
                        from (
                            select
                                case
                                    when size_bytes < 1073741824::bigint then '<1GB'
                                    when size_bytes < 2147483648::bigint then '1-2GB'
                                    when size_bytes < 4294967296::bigint then '2-4GB'
                                    when size_bytes < 8589934592::bigint then '4-8GB'
                                    else '8GB+'
                                end as size_band
                            from warehouse.v_movie_files
                            where size_bytes is not null
                              and (:instance_name = '' or instance_name = :instance_name)
                        ) x
                        group by 1
                        order by value desc
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            inventory = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select
                            m.instance_name,
                            m.title as movie_title,
                            m.year,
                            m.monitored,
                            m.status,
                            m.path as movie_path,
                            mf.path as file_path,
                            coalesce(mf.payload ->> 'relativePath', '') as relative_path,
                            mf.quality,
                            round(mf.size_bytes::numeric / 1024 / 1024, 2) as size_mib,
                            coalesce(mf.payload -> 'mediaInfo' ->> 'audioCodec', mf.audio_codec) as audio_codec,
                            coalesce(mf.payload -> 'mediaInfo' ->> 'videoCodec', mf.video_codec) as video_codec,
                            mf.audio_languages,
                            mf.subtitle_languages,
                            coalesce(mf.payload ->> 'releaseGroup', '') as release_group
                        from warehouse.movie m
                        left join warehouse.movie_file mf
                          on mf.movie_source_id = m.source_id
                         and mf.instance_name = m.instance_name
                         and not mf.deleted
                        where not m.deleted
                          and (:instance_name = '' or m.instance_name = :instance_name)
                        order by m.title asc
                        limit :limit
                        """
                    ),
                    {"instance_name": normalized_instance, "limit": bounded_limit},
                ).mappings()
            ]
        return {
            "key": "radarr-forensics",
            "title": "Radarr Movie Forensics",
            "description": "Movie-level quality, codec, language, and storage analysis.",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "panels": [
                {"id": "total_movies", "title": "Total Movies", "kind": "stat", "value": int(stats_row["total_movies"])},
                {"id": "monitored_movies", "title": "Monitored Movies", "kind": "stat", "value": int(stats_row["monitored_movies"])},
                {"id": "movie_storage_gib", "title": "Movie Storage (GiB)", "kind": "stat", "value": movie_storage_gib},
                {"id": "quality_mix", "title": "Quality Distribution", "kind": "distribution", "rows": quality_mix},
                {"id": "codec_pair_mix", "title": "Top Codec Pairings", "kind": "distribution", "rows": codec_pair_mix},
                {"id": "audio_language_mix", "title": "Audio Language Mix", "kind": "distribution", "rows": audio_language_mix},
                {"id": "subtitle_language_mix", "title": "Subtitle Language Mix", "kind": "distribution", "rows": subtitle_language_mix},
                {"id": "size_band_mix", "title": "Movie File Size Bands", "kind": "distribution", "rows": size_bands},
                {"id": "monitored_mix", "title": "Monitored vs Unmonitored (Series/Movies)", "kind": "distribution", "rows": monitored_mix},
                {"id": "movie_inventory", "title": "Movie File Inventory", "kind": "table", "rows": inventory},
            ],
        }

    def _query_reporting_language_audit(instance_name: str, limit: int) -> dict[str, Any]:
        normalized_instance = instance_name.strip()
        bounded_limit = _bounded_limit(limit, default=200, max_limit=reporting_max_limit)
        monitored_mix = _query_monitored_mix(normalized_instance)
        with app_state.session_scope() as session:
            missing_english = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select e.instance_name, s.title as series_title, e.season_number, e.episode_number, e.title as episode_title,
                               e.monitored as episode_monitored, s.monitored as series_monitored,
                               ef.quality, ef.audio_languages, ef.subtitle_languages, ef.path
                        from warehouse.episode e
                        join warehouse.series s
                          on s.source_id = e.series_source_id
                         and s.instance_name = e.instance_name
                         and not s.deleted
                        left join warehouse.episode_file ef
                          on ef.episode_source_id = e.source_id
                         and ef.instance_name = e.instance_name
                         and not ef.deleted
                        where not e.deleted
                          and coalesce((e.payload ->> 'hasFile')::boolean, false) is true
                          and not ('english' = any(coalesce(ef.audio_languages, array[]::text[])) or 'eng' = any(coalesce(ef.audio_languages, array[]::text[])))
                          and (:instance_name = '' or e.instance_name = :instance_name)
                        order by s.title, e.season_number, e.episode_number
                        limit :limit
                        """
                    ),
                    {"instance_name": normalized_instance, "limit": bounded_limit},
                ).mappings()
            ]
            no_subtitles = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select e.instance_name, s.title as series_title, e.season_number, e.episode_number, e.title as episode_title,
                               e.monitored as episode_monitored, s.monitored as series_monitored, ef.quality, ef.path
                        from warehouse.episode e
                        join warehouse.series s
                          on s.source_id = e.series_source_id
                         and s.instance_name = e.instance_name
                         and not s.deleted
                        left join warehouse.episode_file ef
                          on ef.episode_source_id = e.source_id
                         and ef.instance_name = e.instance_name
                         and not ef.deleted
                        where not e.deleted
                          and (ef.subtitle_languages is null or cardinality(ef.subtitle_languages) = 0)
                          and (:instance_name = '' or e.instance_name = :instance_name)
                        order by s.title, e.season_number, e.episode_number
                        limit :limit
                        """
                    ),
                    {"instance_name": normalized_instance, "limit": bounded_limit},
                ).mappings()
            ]
            audio_mix = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select lang as label, count(*)::bigint as value
                        from (
                            select unnest(audio_languages) as lang
                            from warehouse.v_episode_files
                            where (:instance_name = '' or instance_name = :instance_name)
                            union all
                            select unnest(audio_languages) as lang
                            from warehouse.v_movie_files
                            where (:instance_name = '' or instance_name = :instance_name)
                        ) x
                        group by 1
                        order by value desc
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            subtitle_mix = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select lang as label, count(*)::bigint as value
                        from (
                            select unnest(subtitle_languages) as lang
                            from warehouse.v_episode_files
                            where (:instance_name = '' or instance_name = :instance_name)
                            union all
                            select unnest(subtitle_languages) as lang
                            from warehouse.v_movie_files
                            where (:instance_name = '' or instance_name = :instance_name)
                        ) x
                        group by 1
                        order by value desc
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
        return {
            "key": "language-audit",
            "title": "Language Audit",
            "description": "Language coverage and subtitle completeness across episodes and movies.",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "panels": [
                {"id": "missing_english_episodes", "title": "Episodes Missing English Audio", "kind": "table", "rows": missing_english},
                {"id": "episodes_without_subtitles", "title": "Episodes With No Subtitle Languages", "kind": "table", "rows": no_subtitles},
                {"id": "audio_language_mix", "title": "Audio Language Mix", "kind": "distribution", "rows": audio_mix},
                {"id": "subtitle_language_mix", "title": "Subtitle Language Mix", "kind": "distribution", "rows": subtitle_mix},
                {"id": "monitored_mix", "title": "Monitored vs Unmonitored (Series/Movies)", "kind": "distribution", "rows": monitored_mix},
            ],
        }

    def _query_reporting_sync_ops(instance_name: str, limit: int) -> dict[str, Any]:
        normalized_instance = instance_name.strip()
        bounded_limit = _bounded_limit(limit, default=300, max_limit=reporting_max_limit)
        monitored_mix = _query_monitored_mix(normalized_instance)
        with app_state.session_scope() as session:
            runs_24h = int(
                session.execute(
                    text(
                        """
                        select count(*)
                        from warehouse.sync_run
                        where started_at >= now() - interval '24 hours'
                          and (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
            )
            success_24h = int(
                session.execute(
                    text(
                        """
                        select count(*)
                        from warehouse.sync_run
                        where status = 'success'
                          and started_at >= now() - interval '24 hours'
                          and (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
            )
            failed_24h = int(
                session.execute(
                    text(
                        """
                        select count(*)
                        from warehouse.sync_run
                        where status = 'failed'
                          and started_at >= now() - interval '24 hours'
                          and (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
            )
            recent_runs = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select started_at, finished_at, source, mode, instance_name, status, records_processed, coalesce(error_message, '') as error_message
                        from warehouse.sync_run
                        where (:instance_name = '' or instance_name = :instance_name)
                        order by started_at desc
                        limit :limit
                        """
                    ),
                    {"instance_name": normalized_instance, "limit": bounded_limit},
                ).mappings()
            ]
            aggregates_24h = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select source, mode, instance_name, status, count(*)::bigint as run_count, coalesce(sum(records_processed), 0)::bigint as total_records
                        from warehouse.sync_run
                        where started_at >= now() - interval '24 hours'
                          and (:instance_name = '' or instance_name = :instance_name)
                        group by source, mode, instance_name, status
                        order by run_count desc
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            throughput_48h = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select date_trunc('hour', started_at) as hour_bucket, source, mode, count(*)::bigint as runs, coalesce(sum(records_processed), 0)::bigint as records_processed
                        from warehouse.sync_run
                        where started_at >= now() - interval '48 hours'
                          and (:instance_name = '' or instance_name = :instance_name)
                        group by hour_bucket, source, mode
                        order by hour_bucket desc, source, mode
                        limit :limit
                        """
                    ),
                    {"instance_name": normalized_instance, "limit": bounded_limit},
                ).mappings()
            ]
        return {
            "key": "sync-ops",
            "title": "Sync Operations",
            "description": "Run health, recent activity, and throughput summaries.",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "panels": [
                {"id": "runs_24h", "title": "Sync Runs (24h)", "kind": "stat", "value": runs_24h},
                {"id": "success_runs_24h", "title": "Successful Runs (24h)", "kind": "stat", "value": success_24h},
                {"id": "failed_runs_24h", "title": "Failed Runs (24h)", "kind": "stat", "value": failed_24h},
                {"id": "monitored_mix", "title": "Monitored vs Unmonitored (Series/Movies)", "kind": "distribution", "rows": monitored_mix},
                {"id": "recent_runs", "title": "Recent Sync Runs", "kind": "table", "rows": recent_runs},
                {"id": "run_aggregates_24h", "title": "Run Aggregates (24h)", "kind": "table", "rows": aggregates_24h},
                {"id": "throughput_48h", "title": "Throughput By Hour (48h)", "kind": "table", "rows": throughput_48h},
            ],
        }

    def _query_reporting_ops_overview(instance_name: str, limit: int) -> dict[str, Any]:
        normalized_instance = instance_name.strip()
        bounded_limit = _bounded_limit(limit, default=300, max_limit=reporting_max_limit)
        monitored_mix = _query_monitored_mix(normalized_instance)
        with app_state.session_scope() as session:
            active_syncs = int(
                session.execute(
                    text(
                        """
                        select count(*) from warehouse.sync_run
                        where status = 'running'
                          and (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
            )
            runs_24h = int(
                session.execute(
                    text(
                        """
                        select count(*) from warehouse.sync_run
                        where started_at >= now() - interval '24 hours'
                          and (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
            )
            failed_24h = int(
                session.execute(
                    text(
                        """
                        select count(*) from warehouse.sync_run
                        where status = 'failed'
                          and started_at >= now() - interval '24 hours'
                          and (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
            )
            queued_webhooks = int(
                session.execute(
                    text("select count(*) from app.webhook_queue where status in ('queued', 'retrying')")
                ).scalar_one()
            )
            retrying_webhooks = int(
                session.execute(text("select count(*) from app.webhook_queue where status = 'retrying'")).scalar_one()
            )
            dead_letter_webhooks = int(
                session.execute(text("select count(*) from app.webhook_queue where status = 'dead_letter'")).scalar_one()
            )
            webhook_oldest_pending_min = float(
                session.execute(
                    text(
                        """
                        select coalesce(round(max(extract(epoch from (now() - received_at))) / 60.0, 2), 0)
                        from app.webhook_queue
                        where status in ('queued', 'retrying')
                        """
                    )
                ).scalar_one()
                or 0
            )
            success_rate = float(
                session.execute(
                    text(
                        """
                        select round(100.0 * avg(case when status = 'success' then 1 else 0 end), 2)
                        from warehouse.sync_run
                        where started_at >= now() - interval '24 hours'
                          and (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
                or 0
            )
            avg_run_minutes = float(
                session.execute(
                    text(
                        """
                        select round(avg(extract(epoch from (finished_at - started_at)) / 60.0), 2)
                        from warehouse.sync_run
                        where finished_at is not null
                          and started_at >= now() - interval '24 hours'
                          and (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
                or 0
            )
            p95_run_minutes = float(
                session.execute(
                    text(
                        """
                        select coalesce(
                          round(
                            percentile_cont(0.95) within group (
                              order by extract(epoch from (finished_at - started_at)) / 60.0
                            )::numeric,
                            2
                          ),
                          0
                        )
                        from warehouse.sync_run
                        where finished_at is not null
                          and started_at >= now() - interval '24 hours'
                          and (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
                or 0
            )
            max_run_minutes = float(
                session.execute(
                    text(
                        """
                        select coalesce(round(max(extract(epoch from (finished_at - started_at)) / 60.0), 2), 0)
                        from warehouse.sync_run
                        where finished_at is not null
                          and started_at >= now() - interval '24 hours'
                          and (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
                or 0
            )
            records_24h = int(
                session.execute(
                    text(
                        """
                        select coalesce(sum(records_processed), 0)::bigint
                        from warehouse.sync_run
                        where started_at >= now() - interval '24 hours'
                          and (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
            )
            records_per_run_24h = float(
                session.execute(
                    text(
                        """
                        select coalesce(round(avg(records_processed)::numeric, 2), 0)
                        from warehouse.sync_run
                        where started_at >= now() - interval '24 hours'
                          and (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
                or 0
            )
            freshness_minutes = float(
                session.execute(
                    text(
                        """
                        select round(max(extract(epoch from (now() - started_at))) / 60.0, 2)
                        from warehouse.sync_run
                        where (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
                or 0
            )
            sonarr_lag_seconds = float(
                session.execute(
                    text(
                        """
                        select coalesce(extract(epoch from (now() - coalesce(last_history_time, now()))), 0)
                        from app.sync_state where source = 'sonarr'
                        """
                    )
                ).scalar_one()
                or 0
            )
            radarr_lag_seconds = float(
                session.execute(
                    text(
                        """
                        select coalesce(extract(epoch from (now() - coalesce(last_history_time, now()))), 0)
                        from app.sync_state where source = 'radarr'
                        """
                    )
                ).scalar_one()
                or 0
            )
            queue_status_breakdown = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select status as label, count(*)::bigint as value
                        from app.webhook_queue
                        group by status
                        order by value desc
                        """
                    )
                ).mappings()
            ]
            sync_state_snapshot = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select source, last_history_time, last_history_id, last_successful_full_sync, last_successful_incremental,
                               round(extract(epoch from (now() - coalesce(last_history_time, now()))) / 60.0, 2) as history_lag_min
                        from app.sync_state
                        order by source
                        """
                    )
                ).mappings()
            ]
            recent_failures = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select started_at, source, mode, instance_name, status, records_processed, coalesce(error_message, '') as error_message
                        from warehouse.sync_run
                        where status = 'failed'
                          and (:instance_name = '' or instance_name = :instance_name)
                        order by started_at desc
                        limit :limit
                        """
                    ),
                    {"instance_name": normalized_instance, "limit": bounded_limit},
                ).mappings()
            ]
            runs_by_hour_7d = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select date_trunc('hour', started_at) as hour_bucket,
                               count(*) filter (where status = 'success')::bigint as success_runs,
                               count(*) filter (where status = 'failed')::bigint as failed_runs,
                               count(*)::bigint as total_runs
                        from warehouse.sync_run
                        where started_at >= now() - interval '7 days'
                          and (:instance_name = '' or instance_name = :instance_name)
                        group by 1
                        order by 1
                        limit :limit
                        """
                    ),
                    {"instance_name": normalized_instance, "limit": bounded_limit},
                ).mappings()
            ]
            records_by_hour_7d = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select date_trunc('hour', started_at) as hour_bucket,
                               coalesce(sum(records_processed) filter (where source = 'sonarr'), 0)::bigint as sonarr_records,
                               coalesce(sum(records_processed) filter (where source = 'radarr'), 0)::bigint as radarr_records,
                               coalesce(sum(records_processed), 0)::bigint as total_records
                        from warehouse.sync_run
                        where started_at >= now() - interval '7 days'
                          and (:instance_name = '' or instance_name = :instance_name)
                        group by 1
                        order by 1
                        limit :limit
                        """
                    ),
                    {"instance_name": normalized_instance, "limit": bounded_limit},
                ).mappings()
            ]
            breakdown_7d = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select source, mode, instance_name,
                               count(*)::bigint as runs,
                               count(*) filter (where status = 'failed')::bigint as failed,
                               round(100.0 * avg(case when status = 'success' then 1 else 0 end), 2) as success_rate_pct,
                               coalesce(sum(records_processed), 0)::bigint as records_processed
                        from warehouse.sync_run
                        where started_at >= now() - interval '7 days'
                          and (:instance_name = '' or instance_name = :instance_name)
                        group by source, mode, instance_name
                        order by source, mode, instance_name
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            latest_per_instance = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        with latest as (
                          select distinct on (source, instance_name)
                            source, instance_name, mode, status, started_at, finished_at, records_processed, error_message
                          from warehouse.sync_run
                          where (:instance_name = '' or instance_name = :instance_name)
                          order by source, instance_name, started_at desc
                        )
                        select source, instance_name, mode as latest_mode, status as latest_status, started_at as latest_started_at, finished_at as latest_finished_at,
                               round(extract(epoch from (now() - started_at)) / 60.0, 2) as minutes_since_last_run,
                               records_processed, coalesce(error_message, '') as error_message
                        from latest
                        order by source, instance_name
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            recent_log = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select started_at, source, mode, instance_name, status, records_processed,
                               round(extract(epoch from (finished_at - started_at)) / 60.0, 2) as duration_min,
                               coalesce(error_message, '') as error_message
                        from warehouse.sync_run
                        where (:instance_name = '' or instance_name = :instance_name)
                        order by started_at desc
                        limit :limit
                        """
                    ),
                    {"instance_name": normalized_instance, "limit": bounded_limit},
                ).mappings()
            ]
        return {
            "key": "ops-overview",
            "title": "Nebularr Overview / Stats",
            "description": "End-to-end tool performance: run reliability, queue health, lag, throughput, and failure diagnostics.",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "panels": [
                {"id": "active_syncs", "title": "Active Syncs", "kind": "stat", "value": active_syncs},
                {"id": "runs_24h", "title": "Runs (24h)", "kind": "stat", "value": runs_24h},
                {"id": "failed_runs_24h", "title": "Failed Runs (24h)", "kind": "stat", "value": failed_24h},
                {"id": "success_rate_24h", "title": "Success Rate % (24h)", "kind": "stat", "value": success_rate},
                {"id": "avg_run_min_24h", "title": "Avg Run Time (min, 24h)", "kind": "stat", "value": avg_run_minutes},
                {"id": "p95_run_min_24h", "title": "P95 Run Time (min, 24h)", "kind": "stat", "value": p95_run_minutes},
                {"id": "max_run_min_24h", "title": "Max Run Time (min, 24h)", "kind": "stat", "value": max_run_minutes},
                {"id": "records_24h", "title": "Records Processed (24h)", "kind": "stat", "value": records_24h},
                {"id": "records_per_run_24h", "title": "Records Per Run Avg (24h)", "kind": "stat", "value": records_per_run_24h},
                {"id": "freshness_min", "title": "Freshness (min since last run)", "kind": "stat", "value": freshness_minutes},
                {"id": "queued_webhooks", "title": "Webhook Queue Open", "kind": "stat", "value": queued_webhooks},
                {"id": "retrying_webhooks", "title": "Webhook Retrying", "kind": "stat", "value": retrying_webhooks},
                {"id": "dead_letter_webhooks", "title": "Webhook Dead Letter", "kind": "stat", "value": dead_letter_webhooks},
                {"id": "webhook_oldest_pending_min", "title": "Oldest Pending Webhook (min)", "kind": "stat", "value": webhook_oldest_pending_min},
                {"id": "sonarr_history_lag_sec", "title": "Sonarr History Lag (s)", "kind": "stat", "value": sonarr_lag_seconds},
                {"id": "radarr_history_lag_sec", "title": "Radarr History Lag (s)", "kind": "stat", "value": radarr_lag_seconds},
                {"id": "monitored_mix", "title": "Monitored vs Unmonitored (Series/Movies)", "kind": "distribution", "rows": monitored_mix},
                {"id": "queue_status_breakdown", "title": "Webhook Queue Status Breakdown", "kind": "distribution", "rows": queue_status_breakdown},
                {"id": "sync_state_snapshot", "title": "Sync State Snapshot", "kind": "table", "rows": sync_state_snapshot},
                {"id": "runs_by_hour_7d", "title": "Runs By Hour (7d)", "kind": "table", "rows": runs_by_hour_7d},
                {"id": "records_by_hour_7d", "title": "Records Processed By Hour (7d)", "kind": "table", "rows": records_by_hour_7d},
                {"id": "breakdown_7d", "title": "Source/Mode/Instance Breakdown (7d)", "kind": "table", "rows": breakdown_7d},
                {"id": "latest_per_instance", "title": "Latest Run Per Instance", "kind": "table", "rows": latest_per_instance},
                {"id": "recent_failures", "title": "Recent Failures", "kind": "table", "rows": recent_failures},
                {"id": "recent_run_log", "title": "Recent Run Log (Detailed)", "kind": "table", "rows": recent_log},
            ],
        }

    def _query_reporting_media_deep_dive(instance_name: str, limit: int) -> dict[str, Any]:
        normalized_instance = instance_name.strip()
        bounded_limit = _bounded_limit(limit, default=300, max_limit=reporting_max_limit)
        monitored_mix = _query_monitored_mix(normalized_instance)
        with app_state.session_scope() as session:
            episode_storage = float(
                session.execute(
                    text(
                        """
                        select round(coalesce(sum(size_bytes), 0)::numeric / 1024 / 1024 / 1024, 2)
                        from warehouse.v_episode_files
                        where (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
                or 0
            )
            movie_storage = float(
                session.execute(
                    text(
                        """
                        select round(coalesce(sum(size_bytes), 0)::numeric / 1024 / 1024 / 1024, 2)
                        from warehouse.v_movie_files
                        where (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
                or 0
            )
            missing_english = int(
                session.execute(
                    text(
                        """
                        select count(*)
                        from warehouse.v_episodes_missing_english_audio
                        where (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
            )
            over_3gib = int(
                session.execute(
                    text(
                        """
                        select count(*)
                        from warehouse.v_large_files
                        where (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
            )
            english_coverage = float(
                session.execute(
                    text(
                        """
                        select round(
                          100.0 * avg(
                            case when ('english' = any(audio_languages) or 'eng' = any(audio_languages)) then 1 else 0 end
                          ), 2
                        )
                        from warehouse.v_episode_files
                        where (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
                or 0
            )
            top_series_storage = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select s.instance_name, s.title as series_title, s.monitored as series_monitored,
                               round(sum(ef.size_bytes)::numeric / 1024 / 1024 / 1024, 2) as total_gib, count(*)::bigint as file_count
                        from warehouse.episode_file ef
                        join warehouse.episode e
                          on e.source_id = ef.episode_source_id
                         and e.instance_name = ef.instance_name
                         and not e.deleted
                        join warehouse.series s
                          on s.source_id = e.series_source_id
                         and s.instance_name = e.instance_name
                         and not s.deleted
                        where size_bytes is not null
                          and not ef.deleted
                          and (:instance_name = '' or s.instance_name = :instance_name)
                        group by s.instance_name, s.title, s.monitored
                        order by total_gib desc
                        limit :limit
                        """
                    ),
                    {"instance_name": normalized_instance, "limit": bounded_limit},
                ).mappings()
            ]
            largest_movies = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select m.instance_name, m.title as movie_title, m.year, m.monitored as movie_monitored,
                               round(mf.size_bytes::numeric / 1024 / 1024 / 1024, 2) as size_gib, mf.quality, mf.audio_languages, mf.subtitle_languages
                        from warehouse.movie_file mf
                        join warehouse.movie m
                          on m.source_id = mf.movie_source_id
                         and m.instance_name = mf.instance_name
                         and not m.deleted
                        where size_bytes is not null
                          and not mf.deleted
                          and (:instance_name = '' or m.instance_name = :instance_name)
                        order by mf.size_bytes desc
                        limit :limit
                        """
                    ),
                    {"instance_name": normalized_instance, "limit": bounded_limit},
                ).mappings()
            ]
            episode_quality_profile = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select coalesce(quality, 'unknown') as label, count(*)::bigint as value, round(avg(size_bytes)::numeric / 1024 / 1024, 2) as avg_size_mib
                        from warehouse.v_episode_files
                        where (:instance_name = '' or instance_name = :instance_name)
                        group by quality
                        order by value desc
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            movie_quality_profile = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select coalesce(quality, 'unknown') as label, count(*)::bigint as value, round(avg(size_bytes)::numeric / 1024 / 1024, 2) as avg_size_mib
                        from warehouse.v_movie_files
                        where (:instance_name = '' or instance_name = :instance_name)
                        group by quality
                        order by value desc
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            audio_codec_mix = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select coalesce(audio_codec, 'unknown') as label, count(*)::bigint as value
                        from (
                          select audio_codec from warehouse.v_episode_files where (:instance_name = '' or instance_name = :instance_name)
                          union all
                          select audio_codec from warehouse.v_movie_files where (:instance_name = '' or instance_name = :instance_name)
                        ) x
                        group by 1
                        order by value desc
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            video_codec_mix = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select coalesce(video_codec, 'unknown') as label, count(*)::bigint as value
                        from (
                          select video_codec from warehouse.v_episode_files where (:instance_name = '' or instance_name = :instance_name)
                          union all
                          select video_codec from warehouse.v_movie_files where (:instance_name = '' or instance_name = :instance_name)
                        ) x
                        group by 1
                        order by value desc
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            subtitle_coverage = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select source_type as label, round(100.0 * avg(has_subtitles), 2) as value
                        from (
                          select 'episodes' as source_type, case when subtitle_languages is not null and cardinality(subtitle_languages) > 0 then 1 else 0 end::numeric as has_subtitles
                          from warehouse.v_episode_files
                          where (:instance_name = '' or instance_name = :instance_name)
                          union all
                          select 'movies' as source_type, case when subtitle_languages is not null and cardinality(subtitle_languages) > 0 then 1 else 0 end::numeric as has_subtitles
                          from warehouse.v_movie_files
                          where (:instance_name = '' or instance_name = :instance_name)
                        ) x
                        group by source_type
                        order by source_type
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            detailed_missing_english = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select e.instance_name, s.title as series_title, s.monitored as series_monitored, e.monitored as episode_monitored,
                               e.season_number, e.episode_number, e.title as episode_title, ef.quality,
                               round(ef.size_bytes::numeric / 1024 / 1024, 1) as size_mib, ef.audio_languages, ef.subtitle_languages, ef.path
                        from warehouse.episode e
                        join warehouse.series s
                          on s.source_id = e.series_source_id
                         and s.instance_name = e.instance_name
                         and not s.deleted
                        left join warehouse.episode_file ef
                          on ef.episode_source_id = e.source_id
                         and ef.instance_name = e.instance_name
                         and not ef.deleted
                        where not e.deleted
                          and coalesce((e.payload ->> 'hasFile')::boolean, false) is true
                          and not ('english' = any(coalesce(ef.audio_languages, array[]::text[])) or 'eng' = any(coalesce(ef.audio_languages, array[]::text[])))
                          and (:instance_name = '' or e.instance_name = :instance_name)
                        order by s.title, e.season_number, e.episode_number
                        limit :limit
                        """
                    ),
                    {"instance_name": normalized_instance, "limit": bounded_limit},
                ).mappings()
            ]
            detailed_large_files = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select v.instance_name, v.series_title, s.monitored as series_monitored,
                               v.season_number, v.episode_number, v.episode_title, v.quality,
                               round(v.size_bytes::numeric / 1024 / 1024 / 1024, 2) as size_gib, v.audio_codec, v.video_codec, v.path
                        from warehouse.v_large_files v
                        left join warehouse.series s
                          on s.title = v.series_title
                         and s.instance_name = v.instance_name
                         and not s.deleted
                        where (:instance_name = '' or v.instance_name = :instance_name)
                        order by size_gib desc
                        limit :limit
                        """
                    ),
                    {"instance_name": normalized_instance, "limit": bounded_limit},
                ).mappings()
            ]
        return {
            "key": "media-deep-dive",
            "title": "Media Deep Dive",
            "description": "Storage, codec/language mix, and detailed outlier inventories.",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "panels": [
                {"id": "episode_storage_gib", "title": "Episode Storage (GiB)", "kind": "stat", "value": episode_storage},
                {"id": "movie_storage_gib", "title": "Movie Storage (GiB)", "kind": "stat", "value": movie_storage},
                {"id": "missing_english_audio", "title": "Episodes Missing English Audio", "kind": "stat", "value": missing_english},
                {"id": "files_over_3gib", "title": "Files Over 3 GiB", "kind": "stat", "value": over_3gib},
                {"id": "english_audio_coverage", "title": "English Audio Coverage % (Episodes)", "kind": "stat", "value": english_coverage},
                {"id": "monitored_mix", "title": "Monitored vs Unmonitored (Series/Movies)", "kind": "distribution", "rows": monitored_mix},
                {"id": "top_series_storage", "title": "Top Series By Storage", "kind": "table", "rows": top_series_storage},
                {"id": "largest_movie_files", "title": "Largest Movie Files", "kind": "table", "rows": largest_movies},
                {"id": "episode_quality_profile", "title": "Episode Quality Profile", "kind": "distribution", "rows": episode_quality_profile},
                {"id": "movie_quality_profile", "title": "Movie Quality Profile", "kind": "distribution", "rows": movie_quality_profile},
                {"id": "audio_codec_mix", "title": "Audio Codec Mix", "kind": "distribution", "rows": audio_codec_mix},
                {"id": "video_codec_mix", "title": "Video Codec Mix", "kind": "distribution", "rows": video_codec_mix},
                {"id": "subtitle_coverage_pct", "title": "Subtitle Coverage %", "kind": "distribution", "rows": subtitle_coverage},
                {"id": "detailed_missing_english", "title": "Detailed: Missing English Audio Episodes", "kind": "table", "rows": detailed_missing_english},
                {"id": "detailed_large_files", "title": "Detailed: Large Files", "kind": "table", "rows": detailed_large_files},
            ],
        }

    def _query_reporting_monitoring_audit(instance_name: str, limit: int) -> dict[str, Any]:
        normalized_instance = instance_name.strip()
        bounded_limit = _bounded_limit(limit, default=300, max_limit=reporting_max_limit)
        monitored_mix = _query_monitored_mix(normalized_instance)
        with app_state.session_scope() as session:
            monitored_series = int(
                session.execute(
                    text(
                        """
                        select count(*) from warehouse.series
                        where not deleted and monitored
                          and (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
            )
            unmonitored_series = int(
                session.execute(
                    text(
                        """
                        select count(*) from warehouse.series
                        where not deleted and not monitored
                          and (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
            )
            monitored_movies = int(
                session.execute(
                    text(
                        """
                        select count(*) from warehouse.movie
                        where not deleted and monitored
                          and (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
            )
            unmonitored_movies = int(
                session.execute(
                    text(
                        """
                        select count(*) from warehouse.movie
                        where not deleted and not monitored
                          and (:instance_name = '' or instance_name = :instance_name)
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).scalar_one()
            )
            unmonitored_non_english_shows = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select
                            s.instance_name,
                            s.title as series_title,
                            s.monitored as series_monitored,
                            count(*)::bigint as episodes_missing_english_audio
                        from warehouse.series s
                        join warehouse.episode e
                          on e.series_source_id = s.source_id
                         and e.instance_name = s.instance_name
                         and not e.deleted
                        left join warehouse.episode_file ef
                          on ef.episode_source_id = e.source_id
                         and ef.instance_name = e.instance_name
                         and not ef.deleted
                        where not s.deleted
                          and not s.monitored
                          and coalesce((e.payload ->> 'hasFile')::boolean, false) is true
                          and not ('english' = any(coalesce(ef.audio_languages, array[]::text[])) or 'eng' = any(coalesce(ef.audio_languages, array[]::text[])))
                          and (:instance_name = '' or s.instance_name = :instance_name)
                        group by s.instance_name, s.title, s.monitored
                        order by episodes_missing_english_audio desc, s.title
                        limit :limit
                        """
                    ),
                    {"instance_name": normalized_instance, "limit": bounded_limit},
                ).mappings()
            ]
            unmonitored_non_english_movies = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select
                            m.instance_name,
                            m.title as movie_title,
                            m.year,
                            m.monitored as movie_monitored,
                            mf.quality,
                            mf.audio_languages,
                            mf.path
                        from warehouse.movie m
                        left join warehouse.movie_file mf
                          on mf.movie_source_id = m.source_id
                         and mf.instance_name = m.instance_name
                         and not mf.deleted
                        where not m.deleted
                          and not m.monitored
                          and mf.source_id is not null
                          and not ('english' = any(coalesce(mf.audio_languages, array[]::text[])) or 'eng' = any(coalesce(mf.audio_languages, array[]::text[])))
                          and (:instance_name = '' or m.instance_name = :instance_name)
                        order by m.title
                        limit :limit
                        """
                    ),
                    {"instance_name": normalized_instance, "limit": bounded_limit},
                ).mappings()
            ]
            unmonitored_without_subtitles = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select *
                        from (
                            select
                                e.instance_name,
                                'episode'::text as item_type,
                                s.title as parent_title,
                                e.title as item_title,
                                s.monitored as parent_monitored,
                                e.monitored as item_monitored,
                                ef.quality,
                                ef.subtitle_languages,
                                ef.path
                            from warehouse.episode e
                            join warehouse.series s
                              on s.source_id = e.series_source_id
                             and s.instance_name = e.instance_name
                             and not s.deleted
                            left join warehouse.episode_file ef
                              on ef.episode_source_id = e.source_id
                             and ef.instance_name = e.instance_name
                             and not ef.deleted
                            where not e.deleted
                              and not s.monitored
                              and (ef.subtitle_languages is null or cardinality(ef.subtitle_languages) = 0)
                              and (:instance_name = '' or e.instance_name = :instance_name)
                            union all
                            select
                                m.instance_name,
                                'movie'::text as item_type,
                                m.title as parent_title,
                                m.title as item_title,
                                m.monitored as parent_monitored,
                                m.monitored as item_monitored,
                                mf.quality,
                                mf.subtitle_languages,
                                mf.path
                            from warehouse.movie m
                            left join warehouse.movie_file mf
                              on mf.movie_source_id = m.source_id
                             and mf.instance_name = m.instance_name
                             and not mf.deleted
                            where not m.deleted
                              and not m.monitored
                              and (mf.subtitle_languages is null or cardinality(mf.subtitle_languages) = 0)
                              and (:instance_name = '' or m.instance_name = :instance_name)
                        ) x
                        order by parent_title, item_title
                        limit :limit
                        """
                    ),
                    {"instance_name": normalized_instance, "limit": bounded_limit},
                ).mappings()
            ]
            unmonitored_non_1080p = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select *
                        from (
                            select
                                e.instance_name,
                                'episode'::text as item_type,
                                s.title as parent_title,
                                e.title as item_title,
                                s.monitored as parent_monitored,
                                e.monitored as item_monitored,
                                ef.quality,
                                round(ef.size_bytes::numeric / 1024 / 1024, 1) as size_mib,
                                ef.path
                            from warehouse.episode e
                            join warehouse.series s
                              on s.source_id = e.series_source_id
                             and s.instance_name = e.instance_name
                             and not s.deleted
                            left join warehouse.episode_file ef
                              on ef.episode_source_id = e.source_id
                             and ef.instance_name = e.instance_name
                             and not ef.deleted
                            where not e.deleted
                              and not s.monitored
                              and coalesce(ef.quality, '') not ilike '%1080p%'
                              and (:instance_name = '' or e.instance_name = :instance_name)
                            union all
                            select
                                m.instance_name,
                                'movie'::text as item_type,
                                m.title as parent_title,
                                m.title as item_title,
                                m.monitored as parent_monitored,
                                m.monitored as item_monitored,
                                mf.quality,
                                round(mf.size_bytes::numeric / 1024 / 1024, 1) as size_mib,
                                mf.path
                            from warehouse.movie m
                            left join warehouse.movie_file mf
                              on mf.movie_source_id = m.source_id
                             and mf.instance_name = m.instance_name
                             and not mf.deleted
                            where not m.deleted
                              and not m.monitored
                              and coalesce(mf.quality, '') not ilike '%1080p%'
                              and (:instance_name = '' or m.instance_name = :instance_name)
                        ) x
                        order by parent_title, item_type
                        limit :limit
                        """
                    ),
                    {"instance_name": normalized_instance, "limit": bounded_limit},
                ).mappings()
            ]
            monitored_missing_files = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select
                            e.instance_name,
                            s.title as series_title,
                            s.monitored as series_monitored,
                            count(*)::bigint as monitored_episodes_without_files
                        from warehouse.episode e
                        join warehouse.series s
                          on s.source_id = e.series_source_id
                         and s.instance_name = e.instance_name
                         and not s.deleted
                        where not e.deleted
                          and s.monitored
                          and coalesce((e.payload ->> 'hasFile')::boolean, false) is not true
                          and (:instance_name = '' or e.instance_name = :instance_name)
                        group by e.instance_name, s.title, s.monitored
                        order by monitored_episodes_without_files desc, s.title
                        limit :limit
                        """
                    ),
                    {"instance_name": normalized_instance, "limit": bounded_limit},
                ).mappings()
            ]
        return {
            "key": "monitoring-audit",
            "title": "Monitoring Audit",
            "description": "Monitored/unmonitored coverage with language, subtitle, and quality risk slices.",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "panels": [
                {"id": "monitored_series", "title": "Monitored Series", "kind": "stat", "value": monitored_series},
                {"id": "unmonitored_series", "title": "Unmonitored Series", "kind": "stat", "value": unmonitored_series},
                {"id": "monitored_movies", "title": "Monitored Movies", "kind": "stat", "value": monitored_movies},
                {"id": "unmonitored_movies", "title": "Unmonitored Movies", "kind": "stat", "value": unmonitored_movies},
                {"id": "monitored_mix", "title": "Monitored vs Unmonitored (Series/Movies)", "kind": "distribution", "rows": monitored_mix},
                {"id": "unmonitored_non_english_shows", "title": "Unmonitored Shows Missing English Audio", "kind": "table", "rows": unmonitored_non_english_shows},
                {"id": "unmonitored_non_english_movies", "title": "Unmonitored Non-English Movies", "kind": "table", "rows": unmonitored_non_english_movies},
                {"id": "unmonitored_without_subtitles", "title": "Unmonitored Items Without Subtitles", "kind": "table", "rows": unmonitored_without_subtitles},
                {"id": "unmonitored_non_1080p", "title": "Unmonitored Non-1080p Items", "kind": "table", "rows": unmonitored_non_1080p},
                {"id": "monitored_missing_files", "title": "Monitored Shows With Missing Files", "kind": "table", "rows": monitored_missing_files},
            ],
        }

    @router.get("/healthz")
    async def healthz() -> dict[str, Any]:
        with app_state.session_scope() as session:
            session.execute(text("select 1"))
        return {
            "status": "ok",
            "version": app_state.settings.app_version,
            "git_sha": app_state.settings.app_git_sha,
            "time": datetime.now(timezone.utc).isoformat(),
        }

    @router.get("/metrics")
    async def metrics() -> PlainTextResponse:
        return PlainTextResponse(app_state.metrics.render_prometheus(), media_type="text/plain")

    @router.get("/", response_class=HTMLResponse)
    async def ui_home():
        with app_state.session_scope() as session:
            setup_completed = _get_setting(session, "app.setup_completed", "false").lower() == "true"
        if not setup_completed:
            return RedirectResponse(url="/setup", status_code=307)
        selected_index = web_dist_index if web_dist_index.exists() else web_ui_path
        html = selected_index.read_text(encoding="utf-8")
        html = html.replace("__APP_VERSION__", app_state.settings.app_version)
        html = html.replace("__APP_GIT_SHA__", app_state.settings.app_git_sha)
        return html

    @router.get("/setup", response_class=HTMLResponse)
    async def ui_setup():
        with app_state.session_scope() as session:
            setup_completed = _get_setting(session, "app.setup_completed", "false").lower() == "true"
        if setup_completed:
            return RedirectResponse(url="/", status_code=307)
        selected_index = web_dist_index if web_dist_index.exists() else web_ui_path
        html = selected_index.read_text(encoding="utf-8")
        html = html.replace("__APP_VERSION__", app_state.settings.app_version)
        html = html.replace("__APP_GIT_SHA__", app_state.settings.app_git_sha)
        return html

    @router.get("/assets/{asset_name:path}")
    async def ui_asset(asset_name: str) -> FileResponse:
        if ".." in asset_name:
            raise HTTPException(status_code=404, detail="asset not found")
        if web_dist_dir.exists():
            dist_asset = web_dist_dir.joinpath("assets", asset_name)
            if dist_asset.exists() and dist_asset.is_file():
                return FileResponse(dist_asset)
        asset_path = web_assets_dir.joinpath(asset_name)
        if not asset_path.exists() or not asset_path.is_file():
            raise HTTPException(status_code=404, detail="asset not found")
        return FileResponse(asset_path)

    @router.get("/api/status")
    async def status() -> dict[str, Any]:
        with app_state.session_scope() as session:
            status_payload = compute_health_status(session, app_state.settings, app_state.metrics)
        alert_notifier = getattr(app_state, "alert_notifier", None)
        if alert_notifier is not None:
            asyncio.create_task(alert_notifier.maybe_send_health_alert(status_payload))
        return status_payload

    @router.get("/api/reporting/dashboards")
    async def list_reporting_dashboards() -> list[dict[str, str]]:
        # Browser receives a fixed dashboard catalog only; no SQL text or dynamic query execution is exposed.
        return [
            {
                "key": "overview",
                "title": "Overview",
                "description": "Portfolio-level KPIs, quality breakdowns, and largest files.",
            },
            {
                "key": "language-audit",
                "title": "Language Audit",
                "description": "Language coverage and subtitle completeness analytics.",
            },
            {
                "key": "sync-ops",
                "title": "Sync Operations",
                "description": "Run health and throughput operations dashboard.",
            },
            {
                "key": "ops-overview",
                "title": "Nebularr Overview / Stats",
                "description": "Operational performance and platform health KPIs.",
            },
            {
                "key": "media-deep-dive",
                "title": "Media Deep Dive",
                "description": "Storage, quality, codec, and language forensics.",
            },
            {
                "key": "monitoring-audit",
                "title": "Monitoring Audit",
                "description": "Monitored/unmonitored policy and risk tracking.",
            },
            {
                "key": "sonarr-forensics",
                "title": "Sonarr Episode Forensics",
                "description": "Episode-level distributions and missing-file analysis.",
            },
            {
                "key": "radarr-forensics",
                "title": "Radarr Movie Forensics",
                "description": "Movie-level distributions and storage profile.",
            },
        ]

    @router.get("/api/reporting/dashboards/{dashboard_key}")
    async def get_reporting_dashboard(
        dashboard_key: str,
        instance_name: str = "",
        limit: int = 200,
    ) -> dict[str, Any]:
        effective_limit = reporting_max_limit if limit == 0 else limit
        reports: dict[str, Any] = {
            "overview": _query_reporting_overview,
            "language-audit": _query_reporting_language_audit,
            "sync-ops": _query_reporting_sync_ops,
            "ops-overview": _query_reporting_ops_overview,
            "media-deep-dive": _query_reporting_media_deep_dive,
            "monitoring-audit": _query_reporting_monitoring_audit,
            "sonarr-forensics": _query_reporting_sonarr_forensics,
            "radarr-forensics": _query_reporting_radarr_forensics,
        }
        handler = reports.get(dashboard_key)
        if not handler:
            raise HTTPException(status_code=404, detail="unknown dashboard")
        return handler(instance_name=instance_name, limit=effective_limit)

    @router.get("/api/reporting/dashboards/{dashboard_key}/panels/{panel_id}/export.csv")
    async def export_reporting_panel_csv(
        dashboard_key: str,
        panel_id: str,
        instance_name: str = "",
        limit: int = 5000,
    ) -> PlainTextResponse:
        effective_limit = reporting_max_limit if limit == 0 else limit
        reports: dict[str, Any] = {
            "overview": _query_reporting_overview,
            "language-audit": _query_reporting_language_audit,
            "sync-ops": _query_reporting_sync_ops,
            "ops-overview": _query_reporting_ops_overview,
            "media-deep-dive": _query_reporting_media_deep_dive,
            "monitoring-audit": _query_reporting_monitoring_audit,
            "sonarr-forensics": _query_reporting_sonarr_forensics,
            "radarr-forensics": _query_reporting_radarr_forensics,
        }
        handler = reports.get(dashboard_key)
        if not handler:
            raise HTTPException(status_code=404, detail="unknown dashboard")
        dashboard = handler(instance_name=instance_name, limit=effective_limit)
        panel = next((entry for entry in dashboard.get("panels", []) if entry.get("id") == panel_id), None)
        if not panel:
            raise HTTPException(status_code=404, detail="unknown panel")
        rows = panel.get("rows", [])
        if not isinstance(rows, list):
            raise HTTPException(status_code=400, detail="panel has no tabular rows")
        safe_dashboard = dashboard_key.replace("/", "_")
        safe_panel = panel_id.replace("/", "_")
        return _csv_response(f"{safe_dashboard}_{safe_panel}.csv", rows)

    @router.get("/api/setup/status")
    async def setup_status() -> dict[str, Any]:
        with app_state.session_scope() as session:
            setup_completed = _get_setting(session, "app.setup_completed", "false").lower() == "true"
            webhook_hash = _get_setting(session, "app.webhook_secret_hash", "")
            rows = session.execute(
                text(
                    """
                    select source, base_url, coalesce(api_key, '') <> '' as api_key_set
                    from app.integration_instance
                    where name = 'default'
                    """
                )
            ).mappings()
            integration_map: dict[str, dict[str, Any]] = {}
            for row in rows:
                integration_map[str(row["source"])] = {
                    "configured": bool(row["base_url"]) and bool(row["api_key_set"]),
                    "base_url": row["base_url"],
                    "api_key_set": bool(row["api_key_set"]),
                }
            schedule_rows = session.execute(
                text(
                    """
                    select mode, cron, timezone, enabled
                    from app.sync_schedule
                    order by mode
                    """
                )
            ).mappings()
            schedules = [dict(r) for r in schedule_rows]
            return {
                "completed": setup_completed,
                "has_webhook_secret": bool(webhook_hash),
                "integrations": integration_map,
                "schedules": schedules,
            }

    @router.post("/api/setup/skip")
    async def setup_skip() -> dict[str, Any]:
        with app_state.session_scope() as session:
            _set_setting(session, "app.setup_completed", "true")
        return {"status": "ok", "completed": True}

    @router.post("/api/setup/wizard")
    async def setup_wizard(payload: dict[str, Any]) -> dict[str, Any]:
        sonarr = payload.get("sonarr", {}) if isinstance(payload.get("sonarr"), dict) else {}
        radarr = payload.get("radarr", {}) if isinstance(payload.get("radarr"), dict) else {}
        schedules = payload.get("schedules", {}) if isinstance(payload.get("schedules"), dict) else {}
        timezone = str(payload.get("timezone", app_state.settings.scheduler_timezone))
        webhook_secret = str(payload.get("webhook_secret", "")).strip()

        def _integration_params(source: str, data: dict[str, Any]) -> dict[str, Any]:
            skip = bool(data.get("skip", False))
            return {
                "source": source,
                "name": "default",
                "base_url": str(data.get("base_url", "")).strip(),
                "api_key": str(data.get("api_key", "")).strip(),
                "enabled": bool(data.get("enabled", not skip)),
                "webhook_enabled": bool(data.get("webhook_enabled", not skip)),
                "skip": skip,
            }

        integration_rows = [_integration_params("sonarr", sonarr), _integration_params("radarr", radarr)]
        with app_state.session_scope() as session:
            for item in integration_rows:
                if item["skip"]:
                    continue
                if not item["base_url"]:
                    raise HTTPException(status_code=400, detail=f"{item['source']} base_url is required unless skipped")
                parsed = urlparse(str(item["base_url"]))
                if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                    raise HTTPException(status_code=400, detail=f"{item['source']} base_url must be a valid http(s) URL")
                session.execute(
                    text(
                        """
                        insert into app.integration_instance(source, name, base_url, api_key, enabled, webhook_enabled, updated_at)
                        values (:source, :name, :base_url, :api_key, :enabled, :webhook_enabled, now())
                        on conflict (source, name) do update
                        set base_url = excluded.base_url,
                            api_key = case
                                when excluded.api_key = '' then app.integration_instance.api_key
                                else excluded.api_key
                            end,
                            enabled = excluded.enabled,
                            webhook_enabled = excluded.webhook_enabled,
                            updated_at = now()
                        """
                    ),
                    {
                        "source": item["source"],
                        "name": item["name"],
                        "base_url": item["base_url"],
                        "api_key": encrypt_secret(item["api_key"]),
                        "enabled": item["enabled"],
                        "webhook_enabled": item["webhook_enabled"],
                    },
                )

            if webhook_secret:
                _set_setting(session, "app.webhook_secret_hash", hash_secret(webhook_secret))

            incremental = str(schedules.get("incremental", "")).strip()
            reconcile = str(schedules.get("reconcile", "")).strip()
            for mode, cron_value in (("incremental", incremental), ("reconcile", reconcile)):
                if not cron_value:
                    continue
                try:
                    CronTrigger.from_crontab(cron_value, timezone=str(timezone))
                except Exception as exc:
                    raise HTTPException(status_code=400, detail=f"{mode} cron is invalid") from exc
                session.execute(
                    text(
                        """
                        insert into app.sync_schedule(mode, cron, timezone, enabled, updated_at)
                        values (:mode, :cron, :timezone, true, now())
                        on conflict (mode) do update
                        set cron = excluded.cron,
                            timezone = excluded.timezone,
                            enabled = excluded.enabled,
                            updated_at = now()
                        """
                    ),
                    {"mode": mode, "cron": cron_value, "timezone": timezone},
                )

            _set_setting(session, "app.setup_completed", "true")

        app_state.scheduler.reload()
        return {"status": "ok", "completed": True}

    @router.post("/api/setup/initial-sync")
    async def setup_initial_sync(payload: dict[str, Any]) -> dict[str, Any]:
        nonlocal setup_sync_task, setup_sync_sources
        requested_sources = payload.get("sources", [])
        if not isinstance(requested_sources, list):
            raise HTTPException(status_code=400, detail="sources must be an array")
        sources = [str(item).strip().lower() for item in requested_sources if str(item).strip().lower() in {"sonarr", "radarr"}]
        deduped_sources: list[str] = []
        for source in sources:
            if source not in deduped_sources:
                deduped_sources.append(source)
        if not deduped_sources:
            return {"status": "skipped", "running": False, "sources": []}
        if setup_sync_task and not setup_sync_task.done():
            raise HTTPException(status_code=409, detail="initial setup sync already running")

        async def _run_setup_sync(selected_sources: list[str]) -> None:
            for source in selected_sources:
                await app_state.sync_service.run_sync(source, "full", reason="setup")

        setup_sync_sources = deduped_sources
        setup_sync_task = asyncio.create_task(_run_setup_sync(deduped_sources))
        return {"status": "queued", "running": True, "sources": deduped_sources}

    @router.get("/api/setup/initial-sync-status")
    async def setup_initial_sync_status() -> dict[str, Any]:
        running = bool(setup_sync_task and not setup_sync_task.done())
        return {
            "running": running,
            "sources": setup_sync_sources,
        }

    @router.get("/api/config/integrations")
    async def list_integrations() -> list[dict[str, Any]]:
        with app_state.session_scope() as session:
            rows = session.execute(
                text(
                    """
                    select id, source, name, base_url, enabled, webhook_enabled, updated_at,
                           coalesce(api_key, '') <> '' as api_key_set
                    from app.integration_instance
                    order by source, name
                    """
                )
            ).mappings()
            return [dict(r) for r in rows]

    @router.get("/api/ui/recent-runs")
    async def recent_runs() -> list[dict[str, Any]]:
        with app_state.session_scope() as session:
            rows = session.execute(
                text(
                    """
                    select source, mode, instance_name, status, started_at, finished_at, rows_written, error_message
                    from app.job_run_summary
                    order by started_at desc
                    limit 30
                    """
                )
            ).mappings()
            return [dict(r) for r in rows]

    @router.get("/api/ui/sync-progress")
    async def sync_progress() -> dict[str, Any]:
        with app_state.session_scope() as session:
            active_run = session.execute(
                text(
                    """
                    select
                        id,
                        source,
                        mode,
                        instance_name,
                        started_at,
                        coalesce(records_processed, 0) as records_processed,
                        coalesce(details ->> 'stage', 'starting') as stage,
                        coalesce(details ->> 'stage_note', '') as stage_note,
                        round(extract(epoch from (now() - started_at))::numeric, 1) as elapsed_seconds
                    from warehouse.sync_run
                    where status = 'running'
                      and source in ('sonarr', 'radarr')
                      and mode in ('full', 'incremental', 'reconcile')
                      and coalesce(details ->> 'trigger', 'manual') = 'manual'
                    order by started_at desc
                    limit 1
                    """
                )
            ).mappings().first()
            if not active_run:
                return {"running": False}

            baseline = session.execute(
                text(
                    """
                    select
                        round(avg(extract(epoch from (finished_at - started_at)))::numeric, 1) as avg_seconds,
                        count(*)::int as sample_size
                    from warehouse.sync_run
                    where source = :source
                      and mode = :mode
                      and instance_name = :instance_name
                      and status in ('success', 'failed')
                      and finished_at is not null
                    """
                ),
                {
                    "source": active_run["source"],
                    "mode": active_run["mode"],
                    "instance_name": active_run["instance_name"],
                },
            ).mappings().first()

        elapsed_seconds = float(active_run["elapsed_seconds"] or 0)
        avg_seconds = float(baseline["avg_seconds"]) if baseline and baseline["avg_seconds"] is not None else None
        eta_seconds = max(avg_seconds - elapsed_seconds, 0.0) if avg_seconds is not None else None
        progress_pct = min(round((elapsed_seconds / avg_seconds) * 100.0, 1), 99.0) if avg_seconds and avg_seconds > 0 else None
        return {
            "running": True,
            "run_id": int(active_run["id"]),
            "source": active_run["source"],
            "mode": active_run["mode"],
            "instance_name": active_run["instance_name"],
            "started_at": active_run["started_at"],
            "elapsed_seconds": elapsed_seconds,
            "records_processed": int(active_run["records_processed"] or 0),
            "stage": active_run["stage"],
            "stage_note": active_run["stage_note"],
            "estimated_total_seconds": avg_seconds,
            "eta_seconds": eta_seconds,
            "progress_pct": progress_pct,
            "history_sample_size": int(baseline["sample_size"] or 0) if baseline else 0,
        }

    @router.get("/api/ui/sync-activity")
    async def sync_activity() -> list[dict[str, Any]]:
        with app_state.session_scope() as session:
            rows = session.execute(
                text(
                    """
                    select
                        id as run_id,
                        source,
                        mode,
                        instance_name,
                        status,
                        started_at,
                        coalesce(records_processed, 0) as records_processed,
                        coalesce(details ->> 'trigger', 'unknown') as trigger,
                        coalesce(details ->> 'stage', 'starting') as stage,
                        coalesce(details ->> 'stage_note', '') as stage_note,
                        round(extract(epoch from (now() - started_at))::numeric, 1) as elapsed_seconds
                    from warehouse.sync_run
                    where status = 'running'
                    order by started_at desc
                    """
                )
            ).mappings()
            return [dict(r) for r in rows]

    @router.get("/api/ui/webhook-queue")
    async def webhook_queue_summary() -> list[dict[str, Any]]:
        with app_state.session_scope() as session:
            rows = session.execute(
                text(
                    """
                    select status, count(*) as count
                    from app.webhook_queue
                    group by status
                    order by status
                    """
                )
            ).mappings()
            return [dict(r) for r in rows]

    @router.get("/api/ui/webhook-jobs")
    async def webhook_jobs(status: str = "all", limit: int = 100) -> list[dict[str, Any]]:
        normalized_status = status.lower()
        allowed = {"all", "queued", "retrying", "done", "dead_letter"}
        if normalized_status not in allowed:
            raise HTTPException(status_code=400, detail="invalid status filter")
        bounded_limit = max(1, min(limit, 500))
        where_clause = ""
        params: dict[str, Any] = {"limit": bounded_limit}
        if normalized_status != "all":
            where_clause = "where status = :status"
            params["status"] = normalized_status
        with app_state.session_scope() as session:
            rows = session.execute(
                text(
                    f"""
                    select id, source, event_type, status, attempts, received_at, next_attempt_at, processed_at, error_message
                    from app.webhook_queue
                    {where_clause}
                    order by received_at desc
                    limit :limit
                    """
                ),
                params,
            ).mappings()
            return [dict(r) for r in rows]

    @router.get("/api/ui/shows")
    async def list_shows(
        search: str = "",
        limit: int = 200,
        offset: int = 0,
        sort_by: str = "title",
        sort_dir: str = "asc",
        paged: bool = False,
    ) -> list[dict[str, Any]] | dict[str, Any]:
        return _query_shows(
            search=search,
            limit=limit,
            offset=offset,
            sort_by=sort_by,
            sort_dir=sort_dir,
            paged=paged,
        )

    @router.get("/api/ui/shows/{series_id}/seasons")
    async def show_seasons(series_id: int, instance_name: str) -> list[dict[str, Any]]:
        return _query_show_seasons(series_id=series_id, instance_name=instance_name)

    @router.get("/api/ui/shows/{series_id}/episodes")
    async def show_episodes(
        series_id: int,
        instance_name: str,
        season_number: int | None = None,
        limit: int = 2000,
        offset: int = 0,
        sort_by: str = "season_number",
        sort_dir: str = "asc",
        paged: bool = False,
    ) -> list[dict[str, Any]] | dict[str, Any]:
        return _query_show_episodes(
            series_id=series_id,
            instance_name=instance_name,
            season_number=season_number,
            limit=limit,
            offset=offset,
            sort_by=sort_by,
            sort_dir=sort_dir,
            paged=paged,
        )

    @router.get("/api/ui/shows/{series_id}/episodes/export.csv")
    async def export_show_episodes_csv(
        series_id: int,
        instance_name: str,
        season_number: int | None = None,
        limit: int = 5000,
        sort_by: str = "season_number",
        sort_dir: str = "asc",
        export_all: bool = False,
    ) -> PlainTextResponse:
        query_limit = 100_000 if export_all else limit
        rows = _query_show_episodes(
            series_id=series_id,
            instance_name=instance_name,
            season_number=season_number,
            limit=query_limit,
            offset=0,
            sort_by=sort_by,
            sort_dir=sort_dir,
            paged=False,
        )
        season_part = "all" if season_number is None else str(season_number)
        return _csv_response(
            filename=f"show-{series_id}-{instance_name}-season-{season_part}-episodes.csv",
            rows=rows if isinstance(rows, list) else rows["items"],
        )

    @router.get("/api/ui/episodes")
    async def all_episodes(
        search: str = "",
        instance_name: str = "",
        limit: int = 500,
        offset: int = 0,
        sort_by: str = "series_title",
        sort_dir: str = "asc",
        paged: bool = False,
    ) -> list[dict[str, Any]] | dict[str, Any]:
        return _query_all_episodes(
            search=search,
            instance_name=instance_name,
            limit=limit,
            offset=offset,
            sort_by=sort_by,
            sort_dir=sort_dir,
            paged=paged,
        )

    @router.get("/api/ui/episodes/export.csv")
    async def export_all_episodes_csv(
        search: str = "",
        instance_name: str = "",
        limit: int = 5000,
        sort_by: str = "series_title",
        sort_dir: str = "asc",
        export_all: bool = False,
    ) -> PlainTextResponse:
        query_limit = 100_000 if export_all else limit
        rows = _query_all_episodes(
            search=search,
            instance_name=instance_name,
            limit=query_limit,
            offset=0,
            sort_by=sort_by,
            sort_dir=sort_dir,
            paged=False,
        )
        instance_part = instance_name.strip() or "all"
        return _csv_response(filename=f"episodes-{instance_part}.csv", rows=rows if isinstance(rows, list) else rows["items"])

    @router.get("/api/ui/movies")
    async def movies(
        search: str = "",
        instance_name: str = "",
        limit: int = 500,
        offset: int = 0,
        sort_by: str = "title",
        sort_dir: str = "asc",
        paged: bool = False,
    ) -> list[dict[str, Any]] | dict[str, Any]:
        return _query_movies(
            search=search,
            instance_name=instance_name,
            limit=limit,
            offset=offset,
            sort_by=sort_by,
            sort_dir=sort_dir,
            paged=paged,
        )

    @router.get("/api/ui/movies/export.csv")
    async def export_movies_csv(
        search: str = "",
        instance_name: str = "",
        limit: int = 5000,
        sort_by: str = "title",
        sort_dir: str = "asc",
        export_all: bool = False,
    ) -> PlainTextResponse:
        query_limit = 100_000 if export_all else limit
        rows = _query_movies(
            search=search,
            instance_name=instance_name,
            limit=query_limit,
            offset=0,
            sort_by=sort_by,
            sort_dir=sort_dir,
            paged=False,
        )
        instance_part = instance_name.strip() or "all"
        return _csv_response(filename=f"movies-{instance_part}.csv", rows=rows if isinstance(rows, list) else rows["items"])

    @router.put("/api/config/integrations/{source}")
    async def upsert_integration(source: str, payload: dict[str, Any]) -> dict[str, Any]:
        if source not in {"sonarr", "radarr"}:
            raise HTTPException(status_code=400, detail="source must be sonarr or radarr")
        name = payload.get("name", "default")
        base_url = payload.get("base_url")
        if not base_url:
            raise HTTPException(status_code=400, detail="base_url is required")
        parsed = urlparse(str(base_url))
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise HTTPException(status_code=400, detail="base_url must be a valid http(s) URL")
        api_key = str(payload.get("api_key", ""))
        enabled = bool(payload.get("enabled", True))
        webhook_enabled = bool(payload.get("webhook_enabled", True))
        with app_state.session_scope() as session:
            session.execute(
                text(
                    """
                    insert into app.integration_instance(source, name, base_url, api_key, enabled, webhook_enabled, updated_at)
                    values (:source, :name, :base_url, :api_key, :enabled, :webhook_enabled, now())
                    on conflict (source, name) do update
                    set base_url = excluded.base_url,
                        api_key = case
                            when excluded.api_key = '' then app.integration_instance.api_key
                            else excluded.api_key
                        end,
                        enabled = excluded.enabled,
                        webhook_enabled = excluded.webhook_enabled,
                        updated_at = now()
                    """
                ),
                {
                    "source": source,
                    "name": name,
                    "base_url": base_url,
                    "api_key": encrypt_secret(api_key),
                    "enabled": enabled,
                    "webhook_enabled": webhook_enabled,
                },
            )
        return {"status": "ok"}

    @router.get("/api/config/webhook")
    async def get_webhook_config() -> dict[str, Any]:
        with app_state.session_scope() as session:
            stored_hash = _get_setting(session, "app.webhook_secret_hash", "")
        return {"secret_set": bool(stored_hash)}

    @router.put("/api/config/webhook")
    async def update_webhook_config(payload: dict[str, Any]) -> dict[str, Any]:
        secret = str(payload.get("secret", "")).strip()
        if not secret:
            raise HTTPException(status_code=400, detail="secret is required")
        with app_state.session_scope() as session:
            _set_setting(session, "app.webhook_secret_hash", hash_secret(secret))
        return {"status": "ok"}

    @router.get("/api/config/alert-webhooks")
    async def get_alert_webhook_config() -> dict[str, Any]:
        with app_state.session_scope() as session:
            config = read_alert_webhook_config(session, app_state.settings)
        return {
            "urls_configured": bool(config["webhook_urls"]),
            "url_count": len(config["webhook_urls"]),
            "timeout_seconds": config["timeout_seconds"],
            "min_state": config["min_state"],
            "notify_recovery": config["notify_recovery"],
        }

    @router.put("/api/config/alert-webhooks")
    async def update_alert_webhook_config(payload: dict[str, Any]) -> dict[str, Any]:
        clear_urls = _to_bool(payload.get("clear_urls", False), False)
        provided_urls = payload.get("webhook_urls", None)
        with app_state.session_scope() as session:
            current = read_alert_webhook_config(session, app_state.settings)
            webhook_urls = list(current["webhook_urls"])
            if clear_urls:
                webhook_urls = []
                store_alert_webhook_urls(session, webhook_urls)
            elif provided_urls is not None:
                parsed_urls = _parse_webhook_urls(provided_urls)
                for webhook_url in parsed_urls:
                    parsed = urlparse(webhook_url)
                    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                        raise HTTPException(status_code=400, detail="webhook_urls must contain valid http(s) URLs")
                webhook_urls = parsed_urls
                store_alert_webhook_urls(session, webhook_urls)
            timeout_seconds = float(payload.get("timeout_seconds", current["timeout_seconds"]))
            if timeout_seconds <= 0:
                raise HTTPException(status_code=400, detail="timeout_seconds must be greater than zero")
            min_state_input = str(payload.get("min_state", current["min_state"])).strip().lower()
            if min_state_input not in {"warning", "critical"}:
                raise HTTPException(status_code=400, detail="min_state must be warning or critical")
            min_state: Literal["warning", "critical"] = "critical" if min_state_input == "critical" else "warning"
            notify_recovery = _to_bool(payload.get("notify_recovery", current["notify_recovery"]), bool(current["notify_recovery"]))
            store_alert_webhook_options(
                session,
                timeout_seconds=timeout_seconds,
                min_state=min_state,
                notify_recovery=notify_recovery,
            )
        alert_notifier = getattr(app_state, "alert_notifier", None)
        if alert_notifier is not None:
            await alert_notifier.configure(
                webhook_urls=webhook_urls,
                timeout_seconds=timeout_seconds,
                min_state=min_state,
                notify_recovery=notify_recovery,
            )
        return {"status": "ok", "url_count": len(webhook_urls)}

    @router.get("/api/config/schedules")
    async def list_schedules() -> list[dict[str, Any]]:
        with app_state.session_scope() as session:
            rows = session.execute(
                text(
                    """
                    select mode, cron, timezone, enabled, updated_at
                    from app.sync_schedule
                    order by mode
                    """
                )
            ).mappings()
            return [dict(r) for r in rows]

    @router.put("/api/config/schedules/{mode}")
    async def update_schedule(mode: str, payload: dict[str, Any]) -> dict[str, Any]:
        if mode not in {"incremental", "reconcile", "full"}:
            raise HTTPException(status_code=400, detail="invalid mode")
        cron = payload.get("cron")
        if not cron:
            raise HTTPException(status_code=400, detail="cron is required")
        enabled = bool(payload.get("enabled", True))
        timezone = payload.get("timezone", app_state.settings.scheduler_timezone)
        try:
            ZoneInfo(str(timezone))
        except Exception as exc:
            raise HTTPException(status_code=400, detail="timezone must be a valid IANA timezone") from exc
        try:
            CronTrigger.from_crontab(str(cron), timezone=str(timezone))
        except Exception as exc:
            raise HTTPException(status_code=400, detail="cron is invalid (expected crontab format)") from exc
        with app_state.session_scope() as session:
            session.execute(
                text(
                    """
                    insert into app.sync_schedule(mode, cron, timezone, enabled, updated_at)
                    values (:mode, :cron, :timezone, :enabled, now())
                    on conflict (mode) do update
                    set cron = excluded.cron,
                        timezone = excluded.timezone,
                        enabled = excluded.enabled,
                        updated_at = now()
                    """
                ),
                {"mode": mode, "cron": cron, "timezone": timezone, "enabled": enabled},
            )
        app_state.scheduler.reload()
        return {"status": "ok"}

    @router.post("/api/sync/{source}/{mode}")
    async def trigger_sync(source: str, mode: str) -> dict[str, Any]:
        if source not in {"sonarr", "radarr"}:
            raise HTTPException(status_code=400, detail="source must be sonarr or radarr")
        if mode not in {"full", "incremental", "reconcile"}:
            raise HTTPException(status_code=400, detail="invalid mode")
        try:
            result = await app_state.sync_service.run_sync(source, mode, reason="manual")
        except Exception as exc:
            app_state.metrics.inc("arrsync_sync_runs_failed_total")
            raise HTTPException(status_code=502, detail=f"sync failed for {source}/{mode}: {exc}") from exc
        app_state.metrics.inc("arrsync_sync_runs_total")
        if result.status == "failed":
            app_state.metrics.inc("arrsync_sync_runs_failed_total")
        return {
            "source": result.source,
            "mode": result.mode,
            "status": result.status,
            "records_processed": result.records_processed,
            "started_at": result.started_at.isoformat(),
            "finished_at": result.finished_at.isoformat(),
            "details": result.details,
        }

    @router.post("/api/webhooks/replay-dead-letter/{source}")
    async def replay_dead_letter(source: str) -> dict[str, Any]:
        if source not in {"sonarr", "radarr"}:
            raise HTTPException(status_code=400, detail="source must be sonarr or radarr")
        with app_state.session_scope() as session:
            session.execute(
                text(
                    """
                    update app.webhook_queue
                    set status = 'queued', next_attempt_at = now(), error_message = null
                    where source = :source and status = 'dead_letter'
                    """
                ),
                {"source": source},
            )
        return {"status": "queued"}

    @router.post("/api/webhooks/requeue/{job_id}")
    async def requeue_webhook_job(job_id: int) -> dict[str, Any]:
        with app_state.session_scope() as session:
            updated = session.execute(
                text(
                    """
                    update app.webhook_queue
                    set status = 'queued', next_attempt_at = now(), error_message = null
                    where id = :job_id and status in ('dead_letter', 'retrying')
                    returning id
                    """
                ),
                {"job_id": job_id},
            ).first()
        if not updated:
            raise HTTPException(status_code=404, detail="job not found or not requeueable")
        return {"status": "queued", "job_id": job_id}

    @router.post("/api/admin/reset-data")
    async def reset_data(payload: dict[str, Any]) -> dict[str, Any]:
        confirmation = str(payload.get("confirmation", "")).strip().upper()
        if confirmation != "RESET":
            raise HTTPException(status_code=400, detail="confirmation must be RESET")
        with app_state.session_scope() as session:
            session.execute(
                text(
                    """
                    truncate table
                        warehouse.episode_file,
                        warehouse.movie_file,
                        warehouse.episode,
                        warehouse.movie,
                        warehouse.series,
                        warehouse.sync_run,
                        app.webhook_queue,
                        app.job_run_summary,
                        app.sync_state,
                        app.settings,
                        app.job_lock
                    restart identity cascade
                    """
                )
            )
        return {"status": "ok", "message": "database data reset complete"}

    @router.post("/hooks/{source}")
    async def webhook(source: str, request: Request) -> JSONResponse:
        if source not in {"sonarr", "radarr"}:
            raise HTTPException(status_code=404, detail="unknown source")
        content_length = int(request.headers.get("content-length", "0"))
        if content_length > app_state.settings.webhook_max_body_bytes:
            raise HTTPException(status_code=413, detail="payload too large")

        received_secret = request.headers.get("x-arr-shared-secret", "")
        with app_state.session_scope() as session:
            stored_hash = _get_setting(session, "app.webhook_secret_hash", "")
        if stored_hash:
            if not verify_secret_hash(received_secret, stored_hash):
                raise HTTPException(status_code=401, detail="invalid secret")
        elif not app_state.arr_client_class.validate_webhook_secret(received_secret, app_state.settings.webhook_shared_secret):
            raise HTTPException(status_code=401, detail="invalid secret")

        try:
            payload = await asyncio.wait_for(request.json(), timeout=2.0)
            if not isinstance(payload, dict):
                raise ValueError("json payload must be object")
        except Exception as exc:
            raise HTTPException(status_code=400, detail="invalid payload") from exc

        event_type = str(payload.get("eventType", "unknown"))
        dedupe_key = hashlib.sha256(
            json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
        ).hexdigest()
        with app_state.session_scope() as session:
            repo.enqueue_webhook(session, source=source, event_type=event_type, payload=payload, dedupe_key=dedupe_key)
        app_state.metrics.inc("arrsync_webhooks_received_total")
        return JSONResponse({"status": "accepted"})

    @router.get("/{frontend_path:path}", response_class=HTMLResponse)
    async def ui_spa_fallback(frontend_path: str) -> str:
        if frontend_path.startswith(("api/", "healthz", "metrics", "assets/", "hooks/")):
            raise HTTPException(status_code=404, detail="not found")
        selected_index = web_dist_index if web_dist_index.exists() else web_ui_path
        html = selected_index.read_text(encoding="utf-8")
        html = html.replace("__APP_VERSION__", app_state.settings.app_version)
        html = html.replace("__APP_GIT_SHA__", app_state.settings.app_git_sha)
        return html

    return router
