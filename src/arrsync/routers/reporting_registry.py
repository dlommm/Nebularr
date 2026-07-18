"""Panel registry for the reporting dashboards.

Every dashboard row panel (table / distribution / timeseries) whose body is a
single SQL query lives here as a ``PanelSpec``: the dashboard GET handlers build
those panels through :func:`rows_panel`, and the CSV export executes *exactly one*
panel's SQL through :func:`build_rows` instead of building the whole dashboard.
(The KPI stat cards stay inline in the handlers.)

Design notes
------------
* ``PanelSpec.build(params) -> (sql, binds)`` is the single source of truth for a
  panel's SQL. ``params`` carries the already-normalized ``instance_name`` and the
  already-clamped ``limit``; ``build`` returns the SQL text and the bind dict.
* One instance-filter fragment (:func:`instance_filter`) and one episode-inventory
  CTE (:data:`EPISODE_INVENTORY_CTE`) are defined here and reused, replacing the
  hand-copied joins that used to live in every episode panel.
* The near-identical quality / codec / language distribution panels are generated
  by :func:`distribution_by_view`, :func:`language_unnest_by_view`,
  :func:`codec_union_mix`, and :func:`language_union_mix` rather than copy-pasted.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from sqlalchemy import text

Params = dict[str, Any]
Built = tuple[str, dict[str, Any]]


@dataclass(frozen=True)
class PanelSpec:
    dashboard: str
    panel_id: str
    title: str
    kind: str  # "stat" | "distribution" | "table" | "timeseries"
    build: Callable[[Params], Built]

    @property
    def key(self) -> str:
        return panel_key(self.dashboard, self.panel_id)


def panel_key(dashboard: str, panel_id: str) -> str:
    return f"{dashboard}:{panel_id}"


# --- shared SQL fragments --------------------------------------------------------

def instance_filter(column: str = "instance_name") -> str:
    """The one instance-scope predicate every panel shares.

    ``:instance_name = ''`` means "all instances"; otherwise match the column.
    ``column`` lets callers qualify it (``e.instance_name``, ``s.instance_name`` …).
    """
    return f"(:instance_name = '' or {column} = :instance_name)"


# Episode ⋈ series ⟕ episode_file, with hasFile and coalesced language arrays
# computed once. Panels select from ``ei`` and add their own WHERE/ORDER; the
# left join keeps file-less episodes so panels can decide whether to require a file.
EPISODE_INVENTORY_CTE = """
    with ei as (
        select
            e.instance_name,
            e.series_source_id,
            e.source_id as episode_source_id,
            s.title as series_title,
            s.monitored as series_monitored,
            s.payload as series_payload,
            e.season_number,
            e.episode_number,
            e.title as episode_title,
            e.air_date,
            e.runtime_minutes,
            e.monitored as episode_monitored,
            e.payload as episode_payload,
            coalesce((e.payload ->> 'hasFile')::boolean, false) as has_file,
            ef.source_id as file_source_id,
            ef.path as file_path,
            ef.payload as file_payload,
            ef.quality,
            ef.size_bytes,
            ef.audio_codec,
            ef.video_codec,
            ef.audio_languages,
            ef.subtitle_languages,
            coalesce(ef.audio_languages, array[]::text[]) as audio_languages_c,
            coalesce(ef.subtitle_languages, array[]::text[]) as subtitle_languages_c
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
          and {inst}
    )
""".format(inst=instance_filter("e.instance_name"))


def distribution_by_view(
    view: str,
    *,
    label: str = "coalesce(quality, 'unknown')",
    where_extra: str = "",
    column: str = "instance_name",
) -> str:
    """Generate a ``label / value`` distribution over a file view.

    Replaces the copy-pasted quality/codec distributions; each was
    ``select <label> as label, count(*) as value from <view> where <instance>
    [and <extra>] group by 1 order by value desc``.
    """
    extra = f"\n          and {where_extra}" if where_extra else ""
    return f"""
        select {label} as label, count(*)::bigint as value
        from warehouse.{view}
        where {instance_filter(column)}{extra}
        group by 1
        order by value desc
    """


def language_unnest_by_view(view: str, array_col: str) -> str:
    """Unnest an audio/subtitle language array into a label/value distribution.

    Shared by the forensics dashboards (episode + movie views, audio + subtitle).
    """
    return f"""
        select coalesce(nullif(trim(lang), ''), 'unknown') as label, count(*)::bigint as value
        from (
            select unnest(coalesce({array_col}, array['unknown'])) as lang
            from warehouse.{view}
            where {instance_filter()}
        ) x
        group by 1
        order by value desc
    """


def codec_union_mix(codec_col: str) -> str:
    """Codec distribution unioned across the episode + movie file views."""
    return f"""
        select coalesce({codec_col}, 'unknown') as label, count(*)::bigint as value
        from (
          select {codec_col} from warehouse.v_episode_files where {instance_filter()}
          union all
          select {codec_col} from warehouse.v_movie_files where {instance_filter()}
        ) x
        group by 1
        order by value desc
    """


def language_union_mix(array_col: str) -> str:
    """Raw language distribution unioned across the episode + movie file views.

    Used by the language-audit dashboard (audio and subtitle), where the labels
    are the raw array entries (no coalesce/trim) across both media types.
    """
    return f"""
        select lang as label, count(*)::bigint as value
        from (
            select unnest({array_col}) as lang
            from warehouse.v_episode_files
            where {instance_filter()}
            union all
            select unnest({array_col}) as lang
            from warehouse.v_movie_files
            where {instance_filter()}
        ) x
        group by 1
        order by value desc
    """


# --- executors -------------------------------------------------------------------

def build_rows(session: Any, spec: PanelSpec, params: Params) -> list[dict[str, Any]]:
    sql, binds = spec.build(params)
    return [dict(r) for r in session.execute(text(sql), binds).mappings()]


def rows_panel(session: Any, spec: PanelSpec, params: Params) -> dict[str, Any]:
    """Assemble a full row-panel dict (table / distribution / timeseries).

    The dashboard handlers use this so a panel's id / title / kind are authored
    once, here in the spec, rather than duplicated in each handler's return.
    """
    return {"id": spec.panel_id, "title": spec.title, "kind": spec.kind,
            "rows": build_rows(session, spec, params)}


# --- panel registry --------------------------------------------------------------

_SPECS: list[PanelSpec] = []


def _register(dashboard: str, panel_id: str, title: str, kind: str,
              build: Callable[[Params], Built]) -> None:
    _SPECS.append(PanelSpec(dashboard, panel_id, title, kind, build))


def _inst(params: Params) -> dict[str, Any]:
    return {"instance_name": params["instance_name"]}


def _inst_limit(params: Params) -> dict[str, Any]:
    return {"instance_name": params["instance_name"], "limit": params["limit"]}


def _sql(sql: str, binds: Callable[[Params], dict[str, Any]] = _inst) -> Callable[[Params], Built]:
    return lambda params: (sql, binds(params))


# Shared across most dashboards: monitored vs unmonitored series/movies.
MONITORED_MIX_SQL = f"""
    select label, sum(value)::bigint as value
    from (
      select concat('series:', case when monitored then 'monitored' else 'unmonitored' end) as label, count(*)::bigint as value
      from warehouse.series
      where not deleted
        and {instance_filter()}
      group by 1
      union all
      select concat('movies:', case when monitored then 'monitored' else 'unmonitored' end) as label, count(*)::bigint as value
      from warehouse.movie
      where not deleted
        and {instance_filter()}
      group by 1
    ) x
    group by label
    order by value desc
"""

_MONITORED_MIX_TITLE = "Monitored vs Unmonitored (Series/Movies)"


def _register_monitored_mix(*dashboards: str) -> None:
    for dash in dashboards:
        _register(dash, "monitored_mix", _MONITORED_MIX_TITLE, "distribution", _sql(MONITORED_MIX_SQL))


# ===== overview =================================================================

_register("overview", "episode_quality_mix", "Episode Quality Distribution", "distribution",
          _sql(distribution_by_view("v_episode_files")))
_register("overview", "movie_quality_mix", "Movie Quality Distribution", "distribution",
          _sql(distribution_by_view("v_movie_files")))
_register("overview", "largest_episode_files", "Largest Episode Files", "table", _sql(
    f"""
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
      and {instance_filter()}
    order by size_bytes desc
    limit :limit
    """, _inst_limit))
_register("overview", "largest_movie_files", "Largest Movie Files", "table", _sql(
    f"""
    select
        instance_name,
        movie_title,
        quality,
        round(size_bytes::numeric / 1024 / 1024, 2) as size_mib,
        path
    from warehouse.v_movie_files
    where size_bytes is not null
      and {instance_filter()}
    order by size_bytes desc
    limit :limit
    """, _inst_limit))
_register_monitored_mix("overview")


# ===== sonarr-forensics =========================================================

_CODEC_PAIR_LABEL = "concat(coalesce(audio_codec, 'unknown'), ' / ', coalesce(video_codec, 'unknown'))"

_register("sonarr-forensics", "quality_mix", "Quality Distribution", "distribution",
          _sql(distribution_by_view("v_episode_files")))
_register("sonarr-forensics", "codec_pair_mix", "Top Codec Pairings", "distribution",
          _sql(distribution_by_view("v_episode_files", label=_CODEC_PAIR_LABEL)))
_register("sonarr-forensics", "audio_language_mix", "Audio Language Mix", "distribution",
          _sql(language_unnest_by_view("v_episode_files", "audio_languages")))
_register("sonarr-forensics", "subtitle_language_mix", "Subtitle Language Mix", "distribution",
          _sql(language_unnest_by_view("v_episode_files", "subtitle_languages")))
_register("sonarr-forensics", "size_band_mix", "Episode File Size Bands", "distribution", _sql(
    f"""
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
          and {instance_filter()}
    ) x
    group by 1
    order by value desc
    """))
_register("sonarr-forensics", "episode_inventory", "Episode File Inventory", "table", _sql(
    EPISODE_INVENTORY_CTE + """
    select
        ei.instance_name,
        ei.series_title,
        ei.season_number,
        ei.episode_number,
        ei.episode_title,
        ei.air_date,
        ei.runtime_minutes,
        ei.episode_monitored as monitored,
        ei.series_monitored,
        ei.has_file,
        coalesce(ei.file_payload ->> 'relativePath', '') as relative_path,
        ei.file_path,
        ei.quality,
        round(ei.size_bytes::numeric / 1024 / 1024, 2) as size_mib,
        coalesce(ei.file_payload -> 'mediaInfo' ->> 'audioCodec', ei.audio_codec) as audio_codec,
        coalesce(ei.file_payload -> 'mediaInfo' ->> 'videoCodec', ei.video_codec) as video_codec,
        ei.audio_languages,
        ei.subtitle_languages,
        coalesce(ei.file_payload ->> 'releaseGroup', '') as release_group
    from ei
    order by ei.series_title, ei.season_number, ei.episode_number
    limit :limit
    """, _inst_limit))
# missing_files stays inline: its join is episode ⋈ series only (no episode_file).
# Forcing it onto the ⟕episode_file CTE would add a join the panel omits and would
# multiply rows for hasFile=false episodes that carry an orphan file row.
_register("sonarr-forensics", "missing_files", "Episodes Missing Files", "table", _sql(
    f"""
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
      and {instance_filter("e.instance_name")}
    order by s.title, e.season_number, e.episode_number
    limit :limit
    """, _inst_limit))
_register_monitored_mix("sonarr-forensics")


# ===== radarr-forensics =========================================================

_register("radarr-forensics", "quality_mix", "Quality Distribution", "distribution",
          _sql(distribution_by_view("v_movie_files")))
_register("radarr-forensics", "codec_pair_mix", "Top Codec Pairings", "distribution",
          _sql(distribution_by_view("v_movie_files", label=_CODEC_PAIR_LABEL)))
_register("radarr-forensics", "audio_language_mix", "Audio Language Mix", "distribution",
          _sql(language_unnest_by_view("v_movie_files", "audio_languages")))
_register("radarr-forensics", "subtitle_language_mix", "Subtitle Language Mix", "distribution",
          _sql(language_unnest_by_view("v_movie_files", "subtitle_languages")))
_register("radarr-forensics", "size_band_mix", "Movie File Size Bands", "distribution", _sql(
    f"""
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
          and {instance_filter()}
    ) x
    group by 1
    order by value desc
    """))
_register("radarr-forensics", "movie_inventory", "Movie File Inventory", "table", _sql(
    f"""
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
      and {instance_filter("m.instance_name")}
    order by m.title asc
    limit :limit
    """, _inst_limit))
_register_monitored_mix("radarr-forensics")


# ===== language-audit ===========================================================
# The two episode tables are rebuilt on the shared episode-inventory CTE.

_register("language-audit", "missing_english_episodes", "Episodes Missing English Audio", "table", _sql(
    EPISODE_INVENTORY_CTE + """
    select ei.instance_name, ei.series_title, ei.season_number, ei.episode_number, ei.episode_title,
           ei.episode_monitored, ei.series_monitored,
           ei.quality, ei.audio_languages, ei.subtitle_languages, ei.file_path as path
    from ei
    where ei.has_file
      and not ('english' = any(ei.audio_languages_c) or 'eng' = any(ei.audio_languages_c))
    order by ei.series_title, ei.season_number, ei.episode_number
    limit :limit
    """, _inst_limit))
_register("language-audit", "episodes_without_subtitles", "Episodes With No Subtitle Languages", "table", _sql(
    EPISODE_INVENTORY_CTE + """
    select ei.instance_name, ei.series_title, ei.season_number, ei.episode_number, ei.episode_title,
           ei.episode_monitored, ei.series_monitored, ei.quality, ei.file_path as path
    from ei
    where ei.has_file
      and (ei.subtitle_languages is null or cardinality(ei.subtitle_languages) = 0)
    order by ei.series_title, ei.season_number, ei.episode_number
    limit :limit
    """, _inst_limit))
_register("language-audit", "audio_language_mix", "Audio Language Mix", "distribution",
          _sql(language_union_mix("audio_languages")))
_register("language-audit", "subtitle_language_mix", "Subtitle Language Mix", "distribution",
          _sql(language_union_mix("subtitle_languages")))
_register_monitored_mix("language-audit")


# ===== media-deep-dive ==========================================================

# Rebuilt on the shared CTE: `where ei.size_bytes is not null` keeps only file rows,
# so `count(*)` and `sum(size_bytes)` match the original episode_file-driven join.
_register("media-deep-dive", "top_series_storage", "Top Series By Storage", "table", _sql(
    EPISODE_INVENTORY_CTE + """
    select ei.instance_name, ei.series_title, ei.series_monitored,
           round(sum(ei.size_bytes)::numeric / 1024 / 1024 / 1024, 2) as total_gib, count(*)::bigint as file_count
    from ei
    where ei.size_bytes is not null
    group by ei.instance_name, ei.series_title, ei.series_monitored
    order by total_gib desc
    limit :limit
    """, _inst_limit))
_register("media-deep-dive", "largest_movie_files", "Largest Movie Files", "table", _sql(
    f"""
    select m.instance_name, m.title as movie_title, m.year, m.monitored as movie_monitored,
           round(mf.size_bytes::numeric / 1024 / 1024 / 1024, 2) as size_gib, mf.quality, mf.audio_languages, mf.subtitle_languages
    from warehouse.movie_file mf
    join warehouse.movie m
      on m.source_id = mf.movie_source_id
     and m.instance_name = mf.instance_name
     and not m.deleted
    where size_bytes is not null
      and not mf.deleted
      and {instance_filter("m.instance_name")}
    order by mf.size_bytes desc
    limit :limit
    """, _inst_limit))
_register("media-deep-dive", "episode_quality_profile", "Episode Quality Profile", "distribution", _sql(
    f"""
    select coalesce(quality, 'unknown') as label, count(*)::bigint as value, round(avg(size_bytes)::numeric / 1024 / 1024, 2) as avg_size_mib
    from warehouse.v_episode_files
    where {instance_filter()}
    group by quality
    order by value desc
    """))
_register("media-deep-dive", "movie_quality_profile", "Movie Quality Profile", "distribution", _sql(
    f"""
    select coalesce(quality, 'unknown') as label, count(*)::bigint as value, round(avg(size_bytes)::numeric / 1024 / 1024, 2) as avg_size_mib
    from warehouse.v_movie_files
    where {instance_filter()}
    group by quality
    order by value desc
    """))
_register("media-deep-dive", "audio_codec_mix", "Audio Codec Mix", "distribution",
          _sql(codec_union_mix("audio_codec")))
_register("media-deep-dive", "video_codec_mix", "Video Codec Mix", "distribution",
          _sql(codec_union_mix("video_codec")))
_register("media-deep-dive", "subtitle_coverage_pct", "Subtitle Coverage %", "distribution", _sql(
    f"""
    select source_type as label, round(100.0 * avg(has_subtitles), 2) as value
    from (
      select 'episodes' as source_type, case when subtitle_languages is not null and cardinality(subtitle_languages) > 0 then 1 else 0 end::numeric as has_subtitles
      from warehouse.v_episode_files
      where {instance_filter()}
      union all
      select 'movies' as source_type, case when subtitle_languages is not null and cardinality(subtitle_languages) > 0 then 1 else 0 end::numeric as has_subtitles
      from warehouse.v_movie_files
      where {instance_filter()}
    ) x
    group by source_type
    order by source_type
    """))
_register("media-deep-dive", "detailed_missing_english", "Detailed: Missing English Audio Episodes", "table", _sql(
    EPISODE_INVENTORY_CTE + """
    select ei.instance_name, ei.series_title, ei.series_monitored, ei.episode_monitored,
           ei.season_number, ei.episode_number, ei.episode_title, ei.quality,
           round(ei.size_bytes::numeric / 1024 / 1024, 1) as size_mib,
           ei.audio_languages, ei.subtitle_languages, ei.file_path as path
    from ei
    where ei.has_file
      and not ('english' = any(ei.audio_languages_c) or 'eng' = any(ei.audio_languages_c))
    order by ei.series_title, ei.season_number, ei.episode_number
    limit :limit
    """, _inst_limit))
_register("media-deep-dive", "detailed_large_files", "Detailed: Large Files", "table", _sql(
    f"""
    select v.instance_name, v.series_title, s.monitored as series_monitored,
           v.season_number, v.episode_number, v.episode_title, v.quality,
           round(v.size_bytes::numeric / 1024 / 1024 / 1024, 2) as size_gib, v.audio_codec, v.video_codec, v.path
    from warehouse.v_large_files v
    left join warehouse.series s
      on s.source_id = v.series_source_id
     and s.instance_name = v.instance_name
     and not s.deleted
    where {instance_filter("v.instance_name")}
    order by size_gib desc
    limit :limit
    """, _inst_limit))
_register_monitored_mix("media-deep-dive")


# ===== monitoring-audit =========================================================

_register("monitoring-audit", "unmonitored_non_english_shows", "Unmonitored Shows Missing English Audio", "table", _sql(
    f"""
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
      and {instance_filter("s.instance_name")}
    group by s.instance_name, s.title, s.monitored
    order by episodes_missing_english_audio desc, s.title
    limit :limit
    """, _inst_limit))
_register("monitoring-audit", "unmonitored_non_english_movies", "Unmonitored Non-English Movies", "table", _sql(
    f"""
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
      and {instance_filter("m.instance_name")}
    order by m.title
    limit :limit
    """, _inst_limit))
# Episode branch rebuilt on the shared CTE (episode⋈series⟕episode_file with the
# ef.source_id filter -> only file rows, same cardinality); movie branch stays inline.
_register("monitoring-audit", "unmonitored_without_subtitles", "Unmonitored Items Without Subtitles", "table", _sql(
    EPISODE_INVENTORY_CTE + f"""
    select *
    from (
        select
            ei.instance_name,
            'episode'::text as item_type,
            ei.series_title as parent_title,
            ei.episode_title as item_title,
            ei.series_monitored as parent_monitored,
            ei.episode_monitored as item_monitored,
            ei.quality,
            ei.subtitle_languages,
            ei.file_path as path
        from ei
        where not ei.series_monitored
          and ei.file_source_id is not null
          and (ei.subtitle_languages is null or cardinality(ei.subtitle_languages) = 0)
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
          and mf.source_id is not null
          and (mf.subtitle_languages is null or cardinality(mf.subtitle_languages) = 0)
          and {instance_filter("m.instance_name")}
    ) x
    order by parent_title, item_title
    limit :limit
    """, _inst_limit))
_register("monitoring-audit", "unmonitored_non_1080p", "Unmonitored Non-1080p Items", "table", _sql(
    EPISODE_INVENTORY_CTE + f"""
    select *
    from (
        select
            ei.instance_name,
            'episode'::text as item_type,
            ei.series_title as parent_title,
            ei.episode_title as item_title,
            ei.series_monitored as parent_monitored,
            ei.episode_monitored as item_monitored,
            ei.quality,
            round(ei.size_bytes::numeric / 1024 / 1024, 1) as size_mib,
            ei.file_path as path
        from ei
        where not ei.series_monitored
          and ei.file_source_id is not null
          and coalesce(ei.quality, '') not ilike '%1080p%'
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
          and mf.source_id is not null
          and coalesce(mf.quality, '') not ilike '%1080p%'
          and {instance_filter("m.instance_name")}
    ) x
    order by parent_title, item_type
    limit :limit
    """, _inst_limit))
# monitored_missing_files stays inline: episode ⋈ series only (no episode_file), a
# grouped count of episodes. The ⟕episode_file CTE would over-count episodes that
# carry an orphan file row, changing the tally.
_register("monitoring-audit", "monitored_missing_files", "Monitored Shows With Missing Files", "table", _sql(
    f"""
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
      and {instance_filter("e.instance_name")}
    group by e.instance_name, s.title, s.monitored
    order by monitored_episodes_without_files desc, s.title
    limit :limit
    """, _inst_limit))
_register_monitored_mix("monitoring-audit")


# ===== storage-growth ===========================================================
# The stat cards (totals, 30-day delta) stay in the handler because they are
# byte-formatted in Python; the row/timeseries panels come from the registry.

_register("storage-growth", "storage_over_time", "Library Size Over Time (bytes)", "timeseries", _sql(
    f"""
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
      where {instance_filter()}
      order by date_trunc('day', captured_at), instance_name, source, captured_at desc
    ) daily
    group by day, source
    order by day asc
    """))
_register("storage-growth", "storage_by_quality", "Storage Share By Quality (bytes)", "distribution", _sql(
    f"""
    select coalesce(quality, 'unknown') as label, sum(size_bytes)::bigint as value
    from (
      select quality, size_bytes from warehouse.v_episode_files
      where size_bytes is not null
        and {instance_filter()}
      union all
      select quality, size_bytes from warehouse.v_movie_files
      where size_bytes is not null
        and {instance_filter()}
    ) files
    group by 1
    order by value desc
    """))
_register("storage-growth", "top_series_by_storage", "Top Series By Disk Usage", "table", _sql(
    f"""
    select series_title, instance_name,
           count(*) as episode_files,
           sum(size_bytes)::bigint as total_bytes,
           round(sum(size_bytes) / 1073741824.0, 2) as total_gib
    from warehouse.v_episode_files
    where size_bytes is not null
      and {instance_filter()}
    group by series_title, instance_name
    order by total_bytes desc
    limit :limit
    """, _inst_limit))
_register("storage-growth", "top_movies_by_storage", "Largest Movie Files", "table", _sql(
    f"""
    select movie_title, year, instance_name, quality,
           size_bytes,
           round(size_bytes / 1073741824.0, 2) as size_gib
    from warehouse.v_movie_files
    where size_bytes is not null
      and {instance_filter()}
    order by size_bytes desc
    limit :limit
    """, _inst_limit))


# ===== sync-ops =================================================================
# The 24h count cards stay in the handler; the run/throughput/audit tables come
# from the registry.

_register("sync-ops", "recent_runs", "Recent Sync Runs", "table", _sql(
    f"""
    select started_at, finished_at, source, mode, instance_name, status, records_processed, coalesce(error_message, '') as error_message
    from warehouse.sync_run
    where {instance_filter()}
    order by started_at desc
    limit :limit
    """, _inst_limit))
_register("sync-ops", "run_aggregates_24h", "Run Aggregates (24h)", "table", _sql(
    f"""
    select source, mode, instance_name, status, count(*)::bigint as run_count, coalesce(sum(records_processed), 0)::bigint as total_records
    from warehouse.sync_run
    where started_at >= now() - interval '24 hours'
      and {instance_filter()}
    group by source, mode, instance_name, status
    order by run_count desc
    """))
_register("sync-ops", "throughput_48h", "Throughput By Hour (48h)", "table", _sql(
    f"""
    select date_trunc('hour', started_at) as hour_bucket, source, mode, count(*)::bigint as runs, coalesce(sum(records_processed), 0)::bigint as records_processed
    from warehouse.sync_run
    where started_at >= now() - interval '48 hours'
      and {instance_filter()}
    group by hour_bucket, source, mode
    order by hour_bucket desc, source, mode
    limit :limit
    """, _inst_limit))
_register("sync-ops", "integrity_audits", "Integrity Audits (Warehouse vs Arr)", "table", _sql(
    f"""
    select
        started_at,
        source,
        instance_name,
        status,
        drift_detected,
        arr_counts->>'item_count' as arr_items,
        warehouse_counts->>'item_count' as warehouse_items,
        arr_counts->>'file_count' as arr_files,
        warehouse_counts->>'file_count' as warehouse_files,
        coalesce(error_message, '') as error_message
    from app.integrity_audit_run
    where {instance_filter()}
    order by started_at desc
    limit 20
    """))
_register_monitored_mix("sync-ops")


# ===== english-dub-coverage =====================================================
# Coverage stat cards stay in the handler (settings-dependent titles); the three
# tables come from the registry.

_register("english-dub-coverage", "series_coverage", "Series Coverage (N non-English of M aired)", "table", _sql(
    f"""
    select
        c.instance_name,
        c.title,
        c.aired_monitored_episodes,
        c.downloaded_episodes,
        c.english_episodes,
        c.non_english_episodes,
        c.coverage_status,
        coalesce(d.dub_list_status, 'not-listed') as dub_list_status,
        coalesce(d.dub_sources, 0) as dub_sources
    from warehouse.v_anime_series_english_coverage c
    left join lateral (
        select
            case max(case a.dub_status when 'dubbed' then 2 when 'partial' then 1 else 0 end)
                when 2 then 'dubbed'
                when 1 then 'partial'
            end as dub_list_status,
            max(a.dub_source_count) as dub_sources
        from mal.warehouse_link l
        join mal.anime a on a.mal_id = l.mal_id
        where l.arr_entity = 'sonarr_series'
          and l.instance_name = c.instance_name
          and l.warehouse_source_id = c.source_id
    ) d on true
    where {instance_filter("c.instance_name")}
    order by (c.coverage_status = 'partial') desc, c.non_english_episodes desc, c.title
    limit :limit
    """, _inst_limit))
_register("english-dub-coverage", "movie_coverage", "Movie Coverage", "table", _sql(
    f"""
    select
        c.instance_name,
        c.title,
        c.has_file,
        c.coverage_status,
        coalesce(d.dub_list_status, 'not-listed') as dub_list_status,
        coalesce(d.dub_sources, 0) as dub_sources
    from warehouse.v_anime_movie_english_coverage c
    left join lateral (
        select
            case max(case a.dub_status when 'dubbed' then 2 when 'partial' then 1 else 0 end)
                when 2 then 'dubbed'
                when 1 then 'partial'
            end as dub_list_status,
            max(a.dub_source_count) as dub_sources
        from mal.warehouse_link l
        join mal.anime a on a.mal_id = l.mal_id
        where l.arr_entity = 'radarr_movie'
          and l.instance_name = c.instance_name
          and l.warehouse_source_id = c.source_id
    ) d on true
    where {instance_filter("c.instance_name")}
    order by (c.coverage_status = 'partial') desc, c.title
    limit :limit
    """, _inst_limit))
_register("english-dub-coverage", "non_english_episodes",
          "Anime Episodes Lacking English Audio (files to replace)", "table", _sql(
    EPISODE_INVENTORY_CTE + """
    select ei.instance_name, ei.series_title, ei.season_number, ei.episode_number,
           ei.episode_title, ei.episode_monitored,
           ei.quality, ei.audio_languages, ei.file_path as path
    from ei
    where ei.episode_monitored
      and lower(coalesce(ei.series_payload ->> 'seriesType', '')) = 'anime'
      and ei.has_file
      and not ('english' = any(ei.audio_languages_c) or 'eng' = any(ei.audio_languages_c))
    order by ei.series_title, ei.season_number, ei.episode_number
    limit :limit
    """, _inst_limit))


# ===== ops-overview =============================================================
# The 16 KPI stat cards stay in the handler; the breakdown/table panels come from
# the registry. queue_status_breakdown reads app.webhook_queue, which has no
# instance_name column. sync_state_snapshot reads app.sync_state, which IS
# instance-scoped, but the panel is intentionally left unfiltered to preserve the
# original panel's cross-instance snapshot shape.

_register("ops-overview", "queue_status_breakdown", "Webhook Queue Status Breakdown", "distribution", _sql(
    """
    select status as label, count(*)::bigint as value
    from app.webhook_queue
    group by status
    order by value desc
    """))
_register("ops-overview", "sync_state_snapshot", "Sync State Snapshot", "table", _sql(
    """
    select source, last_history_time, last_history_id, last_successful_full_sync, last_successful_incremental,
           round(extract(epoch from (now() - coalesce(last_history_time, now()))) / 60.0, 2) as history_lag_min
    from app.sync_state
    order by source
    """))
_register("ops-overview", "recent_failures", "Recent Failures", "table", _sql(
    f"""
    select started_at, source, mode, instance_name, status, records_processed, coalesce(error_message, '') as error_message
    from warehouse.sync_run
    where status = 'failed'
      and {instance_filter()}
    order by started_at desc
    limit :limit
    """, _inst_limit))
_register("ops-overview", "runs_by_hour_7d", "Runs By Hour (7d)", "table", _sql(
    f"""
    select date_trunc('hour', started_at) as hour_bucket,
           count(*) filter (where status = 'success')::bigint as success_runs,
           count(*) filter (where status = 'failed')::bigint as failed_runs,
           count(*)::bigint as total_runs
    from warehouse.sync_run
    where started_at >= now() - interval '7 days'
      and {instance_filter()}
    group by 1
    order by 1
    limit :limit
    """, _inst_limit))
_register("ops-overview", "records_by_hour_7d", "Records Processed By Hour (7d)", "table", _sql(
    f"""
    select date_trunc('hour', started_at) as hour_bucket,
           coalesce(sum(records_processed) filter (where source = 'sonarr'), 0)::bigint as sonarr_records,
           coalesce(sum(records_processed) filter (where source = 'radarr'), 0)::bigint as radarr_records,
           coalesce(sum(records_processed), 0)::bigint as total_records
    from warehouse.sync_run
    where started_at >= now() - interval '7 days'
      and {instance_filter()}
    group by 1
    order by 1
    limit :limit
    """, _inst_limit))
_register("ops-overview", "breakdown_7d", "Source/Mode/Instance Breakdown (7d)", "table", _sql(
    f"""
    select source, mode, instance_name,
           count(*)::bigint as runs,
           count(*) filter (where status = 'failed')::bigint as failed,
           round(100.0 * avg(case when status = 'success' then 1 else 0 end), 2) as success_rate_pct,
           coalesce(sum(records_processed), 0)::bigint as records_processed
    from warehouse.sync_run
    where started_at >= now() - interval '7 days'
      and {instance_filter()}
    group by source, mode, instance_name
    order by source, mode, instance_name
    """))
_register("ops-overview", "latest_per_instance", "Latest Run Per Instance", "table", _sql(
    f"""
    with latest as (
      select distinct on (source, instance_name)
        source, instance_name, mode, status, started_at, finished_at, records_processed, error_message
      from warehouse.sync_run
      where {instance_filter()}
      order by source, instance_name, started_at desc
    )
    select source, instance_name, mode as latest_mode, status as latest_status, started_at as latest_started_at, finished_at as latest_finished_at,
           round(extract(epoch from (now() - started_at)) / 60.0, 2) as minutes_since_last_run,
           records_processed, coalesce(error_message, '') as error_message
    from latest
    order by source, instance_name
    """))
_register("ops-overview", "recent_run_log", "Recent Run Log (Detailed)", "table", _sql(
    f"""
    select started_at, source, mode, instance_name, status, records_processed,
           round(extract(epoch from (finished_at - started_at)) / 60.0, 2) as duration_min,
           coalesce(error_message, '') as error_message
    from warehouse.sync_run
    where {instance_filter()}
    order by started_at desc
    limit :limit
    """, _inst_limit))
_register_monitored_mix("ops-overview")


PANELS: dict[str, PanelSpec] = {spec.key: spec for spec in _SPECS}
