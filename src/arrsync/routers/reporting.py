"""Reporting dashboards: SQL panel builders and their endpoints."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from sqlalchemy import text

from arrsync.routers.shared import (
    REPORTING_MAX_LIMIT,
    clamp_limit,
    csv_response,
)

log = logging.getLogger(__name__)


def build_reporting_router(app_state: Any) -> APIRouter:
    router = APIRouter()

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
        bounded_limit = clamp_limit(limit, default=100, max_limit=REPORTING_MAX_LIMIT)
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
        bounded_limit = clamp_limit(limit, default=200, max_limit=REPORTING_MAX_LIMIT)
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
        bounded_limit = clamp_limit(limit, default=200, max_limit=REPORTING_MAX_LIMIT)
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
        bounded_limit = clamp_limit(limit, default=200, max_limit=REPORTING_MAX_LIMIT)
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
        bounded_limit = clamp_limit(limit, default=300, max_limit=REPORTING_MAX_LIMIT)
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

    def _query_reporting_mal(instance_name: str, limit: int) -> dict[str, Any]:
        """Reporting: MAL schema, dub list, links, and Arr rows tag-sync will target."""
        normalized_instance = instance_name.strip()
        bounded_limit = clamp_limit(limit, default=400, max_limit=REPORTING_MAX_LIMIT)
        tag_label = (app_state.settings.arr_dub_tag_label or "").strip() or "(not configured)"
        dub_info_url = (app_state.settings.mal_dub_info_url or "").strip() or "https://raw.githubusercontent.com/MAL-Dubs/MAL-Dubs/main/data/dubInfo.json"
        with app_state.session_scope() as session:
            dubbed_total = int(
                session.execute(text("select count(*) from mal.anime where is_english_dubbed = true")).scalar_one()
            )
            dubbed_linked = int(
                session.execute(
                    text(
                        """
                        select count(distinct a.mal_id)
                        from mal.anime a
                        where a.is_english_dubbed = true
                          and exists (select 1 from mal.warehouse_link l where l.mal_id = a.mal_id)
                        """
                    )
                ).scalar_one()
            )
            dubbed_unlinked = int(
                session.execute(
                    text(
                        """
                        select count(*)
                        from mal.anime a
                        where a.is_english_dubbed = true
                          and not exists (select 1 from mal.warehouse_link l where l.mal_id = a.mal_id)
                        """
                    )
                ).scalar_one()
            )
            fetch_queue_depth = int(session.execute(text("select count(*) from mal.anime_fetch_queue")).scalar_one())
            manual_link_count = int(session.execute(text("select count(*) from mal.manual_link")).scalar_one())
            last_good_dub_fetch = session.execute(
                text(
                    """
                    select id, fetched_at, source_url, content_sha256, id_count
                    from mal.dub_list_fetch
                    where coalesce(http_status, 0) < 400
                      and (error_message is null or error_message = '')
                    order by id desc
                    limit 1
                    """
                )
            ).mappings().first()
            last_dub_fetch_s = (
                last_good_dub_fetch["fetched_at"].isoformat() if last_good_dub_fetch is not None else "never"
            )
            if last_good_dub_fetch is not None:
                sha = str(last_good_dub_fetch["content_sha256"])
                dub_list_snapshot_stat = (
                    f'{int(last_good_dub_fetch["id_count"])} IDs in dubbed[] · sha256 {sha[:16]}… · '
                    f'fetch #{int(last_good_dub_fetch["id"])}'
                )
            else:
                dub_list_snapshot_stat = "— (run MAL ingest once a dub list fetch succeeds)"
            dubinfo_dubbed_shows = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select
                            a.mal_id as mal_anime_id,
                            a.main_title as primary_title_english_pref,
                            coalesce(a.additional_titles, '[]'::jsonb) as alternate_titles_synonyms_ja,
                            a.media_type,
                            a.status as mal_airing_status,
                            exists (select 1 from mal.warehouse_link l where l.mal_id = a.mal_id) as linked_to_sonarr_or_radarr,
                            (select count(*)::int from mal.warehouse_link l where l.mal_id = a.mal_id) as warehouse_link_count,
                            (
                                select string_agg(
                                    l.instance_name || ' · ' || replace(l.arr_entity, '_', ' ') || ' · source_id '
                                    || l.warehouse_source_id::text,
                                    ' | '
                                    order by l.instance_name, l.arr_entity, l.warehouse_source_id
                                )
                                from mal.warehouse_link l
                                where l.mal_id = a.mal_id
                            ) as library_link_detail
                        from mal.anime a
                        where a.is_english_dubbed = true
                        order by a.main_title nulls last, a.mal_id
                        limit :lim
                        """
                    ),
                    {"lim": bounded_limit},
                ).mappings()
            ]
            match_method_mix = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select l.match_method as label, count(*)::bigint as value
                        from mal.warehouse_link l
                        join mal.anime a on a.mal_id = l.mal_id and a.is_english_dubbed = true
                        where (:instance_name = '' or l.instance_name = :instance_name)
                        group by l.match_method
                        order by value desc
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            tag_sync_targets = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select
                            a.mal_id as mal_anime_id,
                            true as in_mal_dubs_dubbed_list,
                            l.instance_name,
                            l.arr_entity,
                            l.warehouse_source_id,
                            a.main_title as mal_primary_title,
                            coalesce(a.additional_titles, '[]'::jsonb) as mal_alternate_titles,
                            coalesce(
                                case when l.arr_entity = 'sonarr_series' then s.title else m.title end,
                                ''
                            ) as sonarr_or_radarr_title,
                            l.match_method,
                            l.confidence,
                            case
                                when l.arr_entity = 'sonarr_series' then s.monitored
                                else m.monitored
                            end as arr_monitored,
                            case
                                when l.arr_entity = 'sonarr_series' then s.payload -> 'tags'
                                else m.payload -> 'tags'
                            end as current_tag_ids,
                            case
                                when l.arr_entity = 'sonarr_series' and s.source_id is null then 'warehouse series missing'
                                when l.arr_entity = 'radarr_movie' and m.source_id is null then 'warehouse movie missing'
                                else 'ok'
                            end as warehouse_row_state,
                            'add_dub_tag_if_missing' as tag_sync_action
                        from mal.warehouse_link l
                        join mal.anime a on a.mal_id = l.mal_id and a.is_english_dubbed = true
                        left join warehouse.series s
                            on l.arr_entity = 'sonarr_series'
                           and s.instance_name = l.instance_name
                           and s.source_id = l.warehouse_source_id
                           and not s.deleted
                        left join warehouse.movie m
                            on l.arr_entity = 'radarr_movie'
                           and m.instance_name = l.instance_name
                           and m.source_id = l.warehouse_source_id
                           and not m.deleted
                        where (:instance_name = '' or l.instance_name = :instance_name)
                        order by l.instance_name, l.arr_entity, l.warehouse_source_id
                        limit :lim
                        """
                    ),
                    {"instance_name": normalized_instance, "lim": bounded_limit},
                ).mappings()
            ]
            dubbed_without_link = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select
                            a.mal_id as mal_anime_id,
                            true as in_mal_dubs_dubbed_list,
                            a.main_title as primary_title_english_pref,
                            coalesce(a.additional_titles, '[]'::jsonb) as alternate_titles_synonyms_ja,
                            a.mal_fetch_status,
                            a.mal_fetched_at,
                            a.media_type,
                            a.status as mal_airing_status
                        from mal.anime a
                        where a.is_english_dubbed = true
                          and not exists (select 1 from mal.warehouse_link l where l.mal_id = a.mal_id)
                        order by a.main_title nulls last, a.mal_id
                        limit :lim
                        """
                    ),
                    {"lim": bounded_limit},
                ).mappings()
            ]
            recent_mal_jobs = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select id, job_type, status, started_at, finished_at,
                               coalesce(error_message, '') as error_message,
                               details
                        from app.mal_job_run
                        order by started_at desc
                        limit :lim
                        """
                    ),
                    {"lim": min(bounded_limit, 200)},
                ).mappings()
            ]
            recent_dub_fetches = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select id, fetched_at, source_url, content_sha256, id_count,
                               http_status, coalesce(error_message, '') as error_message
                        from mal.dub_list_fetch
                        order by id desc
                        limit :lim
                        """
                    ),
                    {"lim": min(bounded_limit, 100)},
                ).mappings()
            ]
            ingest_checkpoints = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select job_name, cursor, run_metadata, updated_at
                        from mal.ingest_checkpoint
                        order by job_name
                        """
                    )
                ).mappings()
            ]
            fetch_queue = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select mal_id, kind, next_attempt_at, attempts, coalesce(last_error, '') as last_error
                        from mal.anime_fetch_queue
                        order by next_attempt_at
                        limit :lim
                        """
                    ),
                    {"lim": bounded_limit},
                ).mappings()
            ]
            manual_links = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select mal_id, instance_name, arr_entity, warehouse_source_id,
                               coalesce(note, '') as note, created_at, updated_at
                        from mal.manual_link
                        where (:instance_name = '' or instance_name = :instance_name)
                        order by updated_at desc
                        limit :lim
                        """
                    ),
                    {"instance_name": normalized_instance, "lim": bounded_limit},
                ).mappings()
            ]
            tag_apply_audit = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select instance_name, arr_entity, warehouse_source_id, tag_label,
                               last_applied_at, last_desired_tagged, coalesce(payload_hash, '') as payload_hash
                        from mal.tag_apply_state
                        where (:instance_name = '' or instance_name = :instance_name)
                        order by last_applied_at desc
                        limit :lim
                        """
                    ),
                    {"instance_name": normalized_instance, "lim": bounded_limit},
                ).mappings()
            ]
            external_id_stats = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select site as label, count(*)::bigint as value
                        from mal.anime_external_id e
                        join mal.anime a on a.mal_id = e.mal_id and a.is_english_dubbed = true
                        group by site
                        order by value desc
                        """
                    )
                ).mappings()
            ]
        return {
            "key": "mal",
            "title": "MAL-Dubs list ↔ MAL ↔ library",
            "description": (
                "MAL-Dubs publishes dubInfo.json with a "
                '"dubbed" array of integers — each is a MyAnimeList anime ID (same as myanimelist.net/anime/<id>). '
                "Nebularr ingest downloads that file (see source URL in Recent dub list fetches), then sets "
                "`mal.anime.is_english_dubbed` for those IDs. "
                "Primary title prefers MAL `alternative_titles.en`, then falls back to `title`; "
                "`alternate_titles_synonyms_ja` holds Japanese, synonyms, romaji, and Jikan variants for matching Sonarr/Radarr naming. "
                "Linked to Sonarr/Radarr means a row exists in `mal.warehouse_link` for that MAL ID. "
                f'Tag sync adds the Arr label "{tag_label}" to linked series/movies. '
                f"Configured dub list URL: {dub_info_url}. "
                "Filter tables by instance where applicable."
            ),
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "panels": [
                {
                    "id": "dub_list_last_snapshot",
                    "title": "Last successful dubInfo.json ingest snapshot",
                    "kind": "stat",
                    "value": dub_list_snapshot_stat,
                },
                {"id": "dub_tag_label", "title": "Dub tag label applied in Sonarr/Radarr", "kind": "stat", "value": tag_label},
                {
                    "id": "dubbed_anime_total",
                    "title": "MAL IDs flagged dubbed (from MAL-Dubs list)",
                    "kind": "stat",
                    "value": dubbed_total,
                },
                {
                    "id": "dubbed_linked_total",
                    "title": "Those IDs linked to a Sonarr/Radarr title",
                    "kind": "stat",
                    "value": dubbed_linked,
                },
                {
                    "id": "dubbed_unlinked_total",
                    "title": "In MAL-Dubs list but not linked to library yet",
                    "kind": "stat",
                    "value": dubbed_unlinked,
                },
                {"id": "fetch_queue_depth", "title": "MAL/Jikan fetch queue rows", "kind": "stat", "value": fetch_queue_depth},
                {"id": "manual_link_total", "title": "Manual MAL ↔ Arr links", "kind": "stat", "value": manual_link_count},
                {"id": "last_dub_list_fetch", "title": "Last successful dub list fetch (timestamp)", "kind": "stat", "value": last_dub_fetch_s},
                {
                    "id": "match_method_mix",
                    "title": "How linked titles were matched (dubbed IDs only)",
                    "kind": "distribution",
                    "rows": match_method_mix,
                },
                {
                    "id": "external_id_sites",
                    "title": "External IDs stored for dubbed shows (TVDB/TMDB/IMDB)",
                    "kind": "distribution",
                    "rows": external_id_stats,
                },
                {
                    "id": "dubinfo_dubbed_shows",
                    "title": "MAL-Dubs dubbed shows (every MAL ID from the list in your DB)",
                    "kind": "table",
                    "rows": dubinfo_dubbed_shows,
                },
                {
                    "id": "tag_sync_targets",
                    "title": "Linked: Sonarr/Radarr row ↔ MAL-Dubs show (tag sync targets)",
                    "kind": "table",
                    "rows": tag_sync_targets,
                },
                {
                    "id": "dubbed_without_link",
                    "title": "Still only on the MAL-Dubs list (not matched to Sonarr/Radarr)",
                    "kind": "table",
                    "rows": dubbed_without_link,
                },
                {"id": "recent_mal_jobs", "title": "Recent MAL job runs", "kind": "table", "rows": recent_mal_jobs},
                {"id": "recent_dub_list_fetches", "title": "Recent dub list fetches", "kind": "table", "rows": recent_dub_fetches},
                {"id": "ingest_checkpoints", "title": "Ingest checkpoints", "kind": "table", "rows": ingest_checkpoints},
                {"id": "anime_fetch_queue", "title": "Anime fetch queue", "kind": "table", "rows": fetch_queue},
                {"id": "manual_links", "title": "Manual links", "kind": "table", "rows": manual_links},
                {"id": "tag_apply_state", "title": "Tag apply audit (last known apply state)", "kind": "table", "rows": tag_apply_audit},
            ],
        }

    def _query_reporting_ops_overview(instance_name: str, limit: int) -> dict[str, Any]:
        normalized_instance = instance_name.strip()
        bounded_limit = clamp_limit(limit, default=300, max_limit=REPORTING_MAX_LIMIT)
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
            # max() aggregates always yield exactly one row: zero sync_state rows on a
            # fresh install (or several with multiple instances) must not 500 here.
            sonarr_lag_seconds = float(
                session.execute(
                    text(
                        """
                        select coalesce(max(extract(epoch from (now() - coalesce(last_history_time, now())))), 0)
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
                        select coalesce(max(extract(epoch from (now() - coalesce(last_history_time, now())))), 0)
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
        bounded_limit = clamp_limit(limit, default=300, max_limit=REPORTING_MAX_LIMIT)
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
        bounded_limit = clamp_limit(limit, default=300, max_limit=REPORTING_MAX_LIMIT)
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

    def _fmt_bytes(num_bytes: float) -> str:
        value = float(num_bytes)
        for unit in ("B", "KiB", "MiB", "GiB", "TiB", "PiB"):
            if abs(value) < 1024.0 or unit == "PiB":
                return f"{value:,.1f} {unit}"
            value /= 1024.0
        return f"{value:,.1f} PiB"

    def _query_reporting_storage_growth(instance_name: str, limit: int) -> dict[str, Any]:
        normalized_instance = instance_name.strip()
        bounded_limit = clamp_limit(limit, default=100, max_limit=REPORTING_MAX_LIMIT)
        with app_state.session_scope() as session:
            current_totals = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select source, sum(file_bytes)::bigint as file_bytes, sum(file_count)::bigint as file_count
                        from (
                          select 'sonarr' as source, coalesce(sum(size_bytes), 0) as file_bytes, count(*) as file_count
                          from warehouse.v_episode_files
                          where (:instance_name = '' or instance_name = :instance_name)
                          union all
                          select 'radarr', coalesce(sum(size_bytes), 0), count(*)
                          from warehouse.v_movie_files
                          where (:instance_name = '' or instance_name = :instance_name)
                        ) totals
                        group by source
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            # One point per day per source: the day's latest snapshot values.
            growth_rows = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select to_char(day, 'YYYY-MM-DD') as ts,
                               source as label,
                               sum(file_bytes)::bigint as value
                        from (
                          select distinct on (date_trunc('day', captured_at), instance_name, source)
                                 date_trunc('day', captured_at) as day,
                                 instance_name,
                                 source,
                                 file_bytes
                          from warehouse.library_stat_snapshot
                          where (:instance_name = '' or instance_name = :instance_name)
                          order by date_trunc('day', captured_at), instance_name, source, captured_at desc
                        ) daily
                        group by day, source
                        order by day asc
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            growth_delta_30d = session.execute(
                text(
                    """
                    with daily as (
                      select date_trunc('day', captured_at) as day, sum(file_bytes)::bigint as total
                      from (
                        select distinct on (date_trunc('day', captured_at), instance_name, source)
                               captured_at, instance_name, source, file_bytes
                        from warehouse.library_stat_snapshot
                        where captured_at >= now() - interval '30 days'
                          and (:instance_name = '' or instance_name = :instance_name)
                        order by date_trunc('day', captured_at), instance_name, source, captured_at desc
                      ) latest_per_day
                      group by 1
                    )
                    select coalesce(
                      (select total from daily order by day desc limit 1)
                      - (select total from daily order by day asc limit 1),
                      0
                    )
                    """
                ),
                {"instance_name": normalized_instance},
            ).scalar_one()
            storage_by_quality = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select coalesce(quality, 'unknown') as label, sum(size_bytes)::bigint as value
                        from (
                          select quality, size_bytes from warehouse.v_episode_files
                          where size_bytes is not null
                            and (:instance_name = '' or instance_name = :instance_name)
                          union all
                          select quality, size_bytes from warehouse.v_movie_files
                          where size_bytes is not null
                            and (:instance_name = '' or instance_name = :instance_name)
                        ) files
                        group by 1
                        order by value desc
                        """
                    ),
                    {"instance_name": normalized_instance},
                ).mappings()
            ]
            top_series = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select series_title, instance_name,
                               count(*) as episode_files,
                               sum(size_bytes)::bigint as total_bytes,
                               round(sum(size_bytes) / 1073741824.0, 2) as total_gib
                        from warehouse.v_episode_files
                        where size_bytes is not null
                          and (:instance_name = '' or instance_name = :instance_name)
                        group by series_title, instance_name
                        order by total_bytes desc
                        limit :limit
                        """
                    ),
                    {"instance_name": normalized_instance, "limit": bounded_limit},
                ).mappings()
            ]
            top_movies = [
                dict(r)
                for r in session.execute(
                    text(
                        """
                        select movie_title, year, instance_name, quality,
                               size_bytes,
                               round(size_bytes / 1073741824.0, 2) as size_gib
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
        totals_by_source = {str(row["source"]): row for row in current_totals}
        tv_bytes = int(totals_by_source.get("sonarr", {}).get("file_bytes", 0) or 0)
        movie_bytes = int(totals_by_source.get("radarr", {}).get("file_bytes", 0) or 0)
        return {
            "key": "storage-growth",
            "title": "Storage & Growth",
            "description": "Library disk usage over time, storage share by quality, and the biggest consumers.",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "panels": [
                {"id": "total_storage", "title": "Total Library Size", "kind": "stat", "value": _fmt_bytes(tv_bytes + movie_bytes)},
                {"id": "tv_storage", "title": "TV Library Size", "kind": "stat", "value": _fmt_bytes(tv_bytes)},
                {"id": "movie_storage", "title": "Movie Library Size", "kind": "stat", "value": _fmt_bytes(movie_bytes)},
                {"id": "growth_30d", "title": "Growth (last 30 days)", "kind": "stat", "value": _fmt_bytes(int(growth_delta_30d or 0))},
                {"id": "storage_over_time", "title": "Library Size Over Time (bytes)", "kind": "timeseries", "rows": growth_rows},
                {"id": "storage_by_quality", "title": "Storage Share By Quality (bytes)", "kind": "distribution", "rows": storage_by_quality},
                {"id": "top_series_by_storage", "title": "Top Series By Disk Usage", "kind": "table", "rows": top_series},
                {"id": "top_movies_by_storage", "title": "Largest Movie Files", "kind": "table", "rows": top_movies},
            ],
        }

    # Browser receives a fixed dashboard catalog only; no SQL text or dynamic query execution is exposed.
    dashboard_catalog: list[dict[str, str]] = [
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
            {
                "key": "storage-growth",
                "title": "Storage & Growth",
                "description": "Library disk usage over time, storage share by quality, and the biggest consumers.",
            },
            {
                "key": "mal",
                "title": "MAL-Dubs ↔ MAL ↔ library",
                "description": "dubInfo.json dubbed[] IDs, titles, Sonarr/Radarr links, and dub tag sync targets.",
            },
        ]

    @router.get("/api/reporting/dashboards")
    async def list_reporting_dashboards() -> list[dict[str, str]]:
        return dashboard_catalog

    report_handlers: dict[str, Any] = {
        "overview": _query_reporting_overview,
        "language-audit": _query_reporting_language_audit,
        "sync-ops": _query_reporting_sync_ops,
        "ops-overview": _query_reporting_ops_overview,
        "media-deep-dive": _query_reporting_media_deep_dive,
        "monitoring-audit": _query_reporting_monitoring_audit,
        "sonarr-forensics": _query_reporting_sonarr_forensics,
        "radarr-forensics": _query_reporting_radarr_forensics,
        "storage-growth": _query_reporting_storage_growth,
        "mal": _query_reporting_mal,
    }

    catalog_keys = {entry["key"] for entry in dashboard_catalog}
    if catalog_keys != set(report_handlers):
        raise RuntimeError(
            "reporting dashboard catalog and handlers are out of sync: "
            f"catalog-only={sorted(catalog_keys - set(report_handlers))} "
            f"handler-only={sorted(set(report_handlers) - catalog_keys)}"
        )

    @router.get("/api/reporting/dashboards/{dashboard_key}")
    async def get_reporting_dashboard(
        dashboard_key: str,
        instance_name: str = "",
        limit: int = 200,
    ) -> dict[str, Any]:
        effective_limit = clamp_limit(limit, default=REPORTING_MAX_LIMIT, max_limit=REPORTING_MAX_LIMIT)
        handler = report_handlers.get(dashboard_key)
        if not handler:
            raise HTTPException(status_code=404, detail="unknown dashboard")
        # Dashboard handlers run many synchronous queries; keep them off the event loop.
        return await asyncio.to_thread(handler, instance_name=instance_name, limit=effective_limit)

    @router.get("/api/reporting/dashboards/{dashboard_key}/panels/{panel_id}/export.csv")
    async def export_reporting_panel_csv(
        dashboard_key: str,
        panel_id: str,
        instance_name: str = "",
        limit: int = 5000,
    ) -> PlainTextResponse:
        effective_limit = clamp_limit(limit, default=REPORTING_MAX_LIMIT, max_limit=REPORTING_MAX_LIMIT)
        handler = report_handlers.get(dashboard_key)
        if not handler:
            raise HTTPException(status_code=404, detail="unknown dashboard")
        dashboard = await asyncio.to_thread(handler, instance_name=instance_name, limit=effective_limit)
        panel = next((entry for entry in dashboard.get("panels", []) if entry.get("id") == panel_id), None)
        if not panel:
            raise HTTPException(status_code=404, detail="unknown panel")
        rows = panel.get("rows", [])
        if not isinstance(rows, list):
            raise HTTPException(status_code=400, detail="panel has no tabular rows")
        safe_dashboard = dashboard_key.replace("/", "_")
        safe_panel = panel_id.replace("/", "_")
        return csv_response(f"{safe_dashboard}_{safe_panel}.csv", rows)

    return router
