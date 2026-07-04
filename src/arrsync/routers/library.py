"""Library browsing endpoints (shows, episodes, movies) and CSV exports."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse
from sqlalchemy import text

from arrsync.routers.shared import (
    EXPORT_ROW_CAP,
    clamp_limit,
    clamp_offset,
    csv_response,
    normalize_sort,
    paged_response,
    search_params,
)

log = logging.getLogger(__name__)


def build_library_router(app_state: Any) -> APIRouter:
    router = APIRouter()

    def _query_shows(
        search: str,
        limit: int,
        offset: int,
        sort_by: str,
        sort_dir: str,
        paged: bool,
    ) -> list[dict[str, Any]] | dict[str, Any]:
        normalized, search_like = search_params(search)
        bounded_limit = clamp_limit(limit)
        bounded_offset = clamp_offset(offset)
        sort_map = {
            "title": "s.title",
            "instance_name": "s.instance_name",
            "episode_count": "episode_count",
            "season_count": "season_count",
            "last_seen_at": "s.last_seen_at",
        }
        sort_expr, direction = normalize_sort(sort_by, sort_dir, sort_map, "title")
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
                return paged_response(items, int(total), bounded_limit, bounded_offset)
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
        bounded_limit = clamp_limit(limit, default=500, max_limit=5000)
        bounded_offset = clamp_offset(offset)
        sort_map = {
            "season_number": "e.season_number",
            "episode_number": "e.episode_number",
            "air_date": "e.air_date",
            "episode_title": "e.title",
            "size_bytes": "ef.size_bytes",
        }
        sort_expr, direction = normalize_sort(sort_by, sort_dir, sort_map, "season_number")
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
                return paged_response(items, int(total), bounded_limit, bounded_offset)
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
        normalized, search_like = search_params(search)
        normalized_instance = instance_name.strip()
        bounded_limit = clamp_limit(limit, default=500, max_limit=5000)
        bounded_offset = clamp_offset(offset)
        sort_map = {
            "series_title": "s.title",
            "instance_name": "e.instance_name",
            "season_number": "e.season_number",
            "episode_number": "e.episode_number",
            "air_date": "e.air_date",
            "size_bytes": "ef.size_bytes",
        }
        sort_expr, direction = normalize_sort(sort_by, sort_dir, sort_map, "series_title")
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
                return paged_response(items, int(total), bounded_limit, bounded_offset)
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
        normalized, search_like = search_params(search)
        normalized_instance = instance_name.strip()
        bounded_limit = clamp_limit(limit, default=500, max_limit=5000)
        bounded_offset = clamp_offset(offset)
        sort_map = {
            "title": "m.title",
            "year": "m.year",
            "instance_name": "m.instance_name",
            "size_bytes": "mf.size_bytes",
            "last_seen_at": "m.last_seen_at",
        }
        sort_expr, direction = normalize_sort(sort_by, sort_dir, sort_map, "title")
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
                return paged_response(items, int(total), bounded_limit, bounded_offset)
            return items

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
        query_limit = EXPORT_ROW_CAP if export_all else min(limit, EXPORT_ROW_CAP)
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
        return csv_response(
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
        query_limit = EXPORT_ROW_CAP if export_all else min(limit, EXPORT_ROW_CAP)
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
        return csv_response(filename=f"episodes-{instance_part}.csv", rows=rows if isinstance(rows, list) else rows["items"])

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
        query_limit = EXPORT_ROW_CAP if export_all else min(limit, EXPORT_ROW_CAP)
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
        return csv_response(filename=f"movies-{instance_part}.csv", rows=rows if isinstance(rows, list) else rows["items"])

    return router
