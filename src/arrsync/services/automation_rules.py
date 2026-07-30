"""Rule schema + SQL predicate compiler for automations.

Whitelist-only: user params contribute bind VALUES, never SQL text — the same
invariant as reporting_registry ("no ad-hoc SQL from the browser"). Every
fragment below is a hardcoded string; pydantic validation rejects anything
outside the whitelisted fields/operators before compilation. All models use
extra="forbid" so a typoed or unknown param key fails validation loudly
instead of being silently ignored.

The runtime bind ``:cooldown_days`` is only referenced in the generated SQL
for rules that have at least one search_missing/search_upgrade action —
tag-only and set_monitored-only rules never join the action ledger, so they
have nothing to cool down. The executor may still pass ``:cooldown_days`` for
every rule unconditionally; sqlalchemy's ``text()`` tolerates unused bind
parameters, so passing it for a non-search rule is harmless.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class RuleScope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    media: Literal["movies", "series", "both"] = "both"
    instances: list[str] = Field(default_factory=list)  # empty = all enabled
    # series: seriesType == 'anime'; movies: MAL-linked OR genre 'anime'
    # (mirrors warehouse.v_anime_*_english_coverage scoping).
    anime_only: bool = False
    series_type: str | None = None
    genres_any: list[str] = Field(default_factory=list, max_length=20)
    tags_any: list[str] = Field(default_factory=list, max_length=20)
    monitored_only: bool = True


class RuleRequire(BaseModel):
    model_config = ConfigDict(extra="forbid")

    audio_language_any: list[str] = Field(default_factory=list, max_length=10)
    resolution_min: int | None = Field(default=None, ge=240, le=4320)
    video_codec_any: list[str] = Field(default_factory=list, max_length=10)
    quality_any: list[str] = Field(default_factory=list, max_length=20)

    def is_empty(self) -> bool:
        return not (
            self.audio_language_any
            or self.resolution_min is not None
            or self.video_codec_any
            or self.quality_any
        )


class RuleAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["search_missing", "search_upgrade", "tag", "set_monitored"]
    label: str | None = None  # tag only
    value: bool | None = None  # set_monitored only
    when: Literal["non_conforming", "conforming"] = "non_conforming"

    @model_validator(mode="after")
    def _check_fields(self) -> "RuleAction":
        if self.type == "tag" and not (self.label or "").strip():
            raise ValueError("tag action requires a non-empty label")
        if self.type == "set_monitored" and self.value is None:
            raise ValueError("set_monitored action requires value true/false")
        if self.type.startswith("search_") and self.when != "non_conforming":
            raise ValueError("search actions only apply to non-conforming items")
        return self


class RuleOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mal_dub_gate: bool = False
    new_dub_only: bool = False


class RuleParams(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scope: RuleScope = Field(default_factory=RuleScope)
    require: RuleRequire = Field(default_factory=RuleRequire)
    actions: list[RuleAction] = Field(default_factory=list, max_length=8)
    options: RuleOptions = Field(default_factory=RuleOptions)

    @model_validator(mode="after")
    def _check(self) -> "RuleParams":
        if not self.actions:
            raise ValueError("at least one action is required")
        wants_upgrade = any(a.type == "search_upgrade" for a in self.actions)
        if wants_upgrade and self.require.is_empty():
            raise ValueError("search_upgrade needs at least one require clause")
        if self.options.new_dub_only and not self.options.mal_dub_gate:
            raise ValueError("new_dub_only requires mal_dub_gate")
        has_conforming = any(a.when == "conforming" for a in self.actions)
        if has_conforming and self.scope.media != "movies":
            # v1: conforming-state actions (e.g. unmonitor once acquired) are
            # movie-level only; series-level conforming semantics are ambiguous
            # (which episodes count?) and deferred.
            raise ValueError("when=conforming actions are only supported for media=movies")
        return self


@dataclass(frozen=True)
class AutomationTemplate:
    key: str
    title: str
    description: str
    default_cron: str
    default_params: dict[str, Any]


_ENGLISH = ["english", "eng"]

TEMPLATES: dict[str, AutomationTemplate] = {
    t.key: t
    for t in (
        AutomationTemplate(
            key="anime-dub-enforcer",
            title="Anime English-dub enforcer",
            description=(
                "Hunts English-dubbed upgrades for anime series and movies at your "
                "resolution floor. Skips items MAL dub lists say have no dub at all, "
                "so indexer quota is never burned on searches that cannot succeed."
            ),
            default_cron="0 6 */2 * *",
            default_params={
                "scope": {"media": "both", "anime_only": True, "monitored_only": True},
                "require": {"audio_language_any": _ENGLISH, "resolution_min": 1080},
                "actions": [{"type": "search_missing"}, {"type": "search_upgrade"}],
                "options": {"mal_dub_gate": True},
            },
        ),
        AutomationTemplate(
            key="new-dub-watcher",
            title="New-dub watcher",
            description=(
                "Watches the MAL dub dataset and searches an item the day its dub "
                "status flips from none to partial/dubbed."
            ),
            default_cron="15 6 * * *",
            default_params={
                "scope": {"media": "both", "anime_only": True, "monitored_only": True},
                "require": {"audio_language_any": _ENGLISH},
                "actions": [{"type": "search_missing"}, {"type": "search_upgrade"}],
                "options": {"mal_dub_gate": True, "new_dub_only": True},
            },
        ),
        AutomationTemplate(
            key="resolution-floor",
            title="Resolution floor",
            description="Upgrade-searches anything below your minimum resolution (items already at or above the floor — e.g. 4K — are left alone).",
            default_cron="0 5 * * 6",
            default_params={
                "scope": {"media": "both", "monitored_only": True},
                "require": {"resolution_min": 1080},
                "actions": [{"type": "search_upgrade"}],
            },
        ),
        AutomationTemplate(
            key="missing-hunter",
            title="Missing-content hunter",
            description="Periodically searches monitored items that have no file at all.",
            default_cron="30 5 * * 6",
            default_params={
                "scope": {"media": "both", "monitored_only": True},
                "require": {},
                "actions": [{"type": "search_missing"}],
            },
        ),
        AutomationTemplate(
            key="codec-preference",
            title="Codec preference (tag-only)",
            description=(
                "Tags files not in your preferred codecs (default x265/HEVC) so you "
                "can see re-encode candidates; switch the action to search_upgrade "
                "if you want grabs instead of visibility."
            ),
            default_cron="0 7 * * 6",
            default_params={
                "scope": {"media": "both", "monitored_only": True},
                "require": {"video_codec_any": ["x265", "hevc", "h265"]},
                "actions": [{"type": "tag", "label": "x264-candidate"}],
            },
        ),
        AutomationTemplate(
            key="language-audit",
            title="Language audit (tag-only)",
            description="Tags items whose files lack English audio. Pure visibility — no searches.",
            default_cron="30 7 * * 6",
            default_params={
                "scope": {"media": "both", "monitored_only": True},
                "require": {"audio_language_any": _ENGLISH},
                "actions": [{"type": "tag", "label": "non-english-audio"}],
            },
        ),
        AutomationTemplate(
            key="custom",
            title="Custom rule",
            description="Build your own condition from the whitelisted fields and pick the actions.",
            default_cron="0 8 * * 6",
            default_params={
                "scope": {"media": "both", "monitored_only": True},
                "require": {"audio_language_any": _ENGLISH, "resolution_min": 1080},
                "actions": [{"type": "search_missing"}],
            },
        ),
    )
}


def validate_params(template_key: str, params: dict[str, Any]) -> RuleParams:
    if template_key not in TEMPLATES:
        raise ValueError(f"unknown template {template_key!r}")
    try:
        return RuleParams.model_validate(params)
    except ValueError:
        raise
    except Exception as exc:  # pydantic ValidationError subclasses ValueError in v2; belt and braces
        raise ValueError(str(exc)) from exc


@dataclass(frozen=True)
class CompiledQuery:
    select_sql: str
    count_sql: str
    count_all_sql: str  # no cooldown filter — used to compute skipped_cooldown
    binds: dict[str, Any]


_MOVIE_ANIME_SCOPE = (
    "(exists (select 1 from mal.warehouse_link l where l.arr_entity = 'radarr_movie'"
    " and l.instance_name = m.instance_name and l.warehouse_source_id = m.source_id)"
    " or exists (select 1 from jsonb_array_elements_text("
    "coalesce(m.payload->'genres', '[]'::jsonb)) as g(genre)"
    " where lower(g.genre) = 'anime'))"
)


def _require_fragments(require: RuleRequire, alias: str) -> tuple[list[str], dict[str, Any]]:
    frags: list[str] = []
    binds: dict[str, Any] = {}
    if require.audio_language_any:
        frags.append(
            f"exists (select 1 from unnest(coalesce({alias}.audio_languages,"
            " array[]::text[])) al where al = any(:audio_langs))"
        )
        binds["audio_langs"] = [value.lower() for value in require.audio_language_any]
    if require.resolution_min is not None:
        frags.append(f"coalesce({alias}.video_resolution, 0) >= :resolution_min")
        binds["resolution_min"] = require.resolution_min
    if require.video_codec_any:
        frags.append(f"lower(coalesce({alias}.video_codec, '')) = any(:video_codecs)")
        binds["video_codecs"] = [value.lower() for value in require.video_codec_any]
    if require.quality_any:
        frags.append(f"coalesce({alias}.quality, '') = any(:quality_names)")
        binds["quality_names"] = list(require.quality_any)
    return frags, binds


def _jsonb_text_any(expr: str, bind: str) -> str:
    return (
        f"exists (select 1 from jsonb_array_elements_text(coalesce({expr}, '[]'::jsonb)) v"
        f" where lower(v) = any(:{bind}))"
    )


def compile_candidates(
    params: RuleParams, entity: str, sense: str = "non_conforming"
) -> CompiledQuery:
    if entity not in ("movie", "episode"):
        raise ValueError(f"unknown entity {entity!r}")
    if sense not in ("non_conforming", "conforming"):
        raise ValueError(f"unknown sense {sense!r}")
    scope, require, options = params.scope, params.require, params.options
    wants_missing = any(a.type == "search_missing" for a in params.actions)
    wants_upgrade = any(a.type == "search_upgrade" for a in params.actions)
    binds: dict[str, Any] = {}
    req_frags, req_binds = _require_fragments(require, "mf" if entity == "movie" else "ef")
    binds.update(req_binds)
    req_expr = " and ".join(req_frags) if req_frags else "true"

    if entity == "movie":
        item, file_alias = "m", "mf"
        select_cols = (
            "m.source_id, m.title,"
            " coalesce((m.payload->>'hasFile')::boolean, false) as has_file,"
            " mf.video_resolution, mf.audio_languages, mf.video_codec, mf.quality"
        )
        joins = [
            "from warehouse.movie m",
            "left join warehouse.movie_file mf on mf.movie_source_id = m.source_id"
            " and mf.instance_name = m.instance_name and not mf.deleted",
        ]
        where = ["not m.deleted", "m.instance_name = :instance_name"]
        if scope.monitored_only:
            where.append("m.monitored")
        if scope.anime_only:
            where.append(_MOVIE_ANIME_SCOPE)
        if scope.genres_any:
            where.append(_jsonb_text_any("m.payload->'genres'", "genres_any"))
            binds["genres_any"] = [value.lower() for value in scope.genres_any]
        if scope.tags_any:
            where.append(
                "exists (select 1 from jsonb_array_elements_text("
                "coalesce(m.payload->'tags', '[]'::jsonb)) tg"
                " where tg ~ '^[0-9]+$' and tg::int = any(:tag_ids))"
            )
        if options.mal_dub_gate:
            # mal.warehouse_link is unique on (mal_id, instance_name, arr_entity),
            # NOT on warehouse_source_id — MAL can split one series/movie across
            # multiple mal_ids (e.g. season splits), so a plain inner join here
            # would fan out and duplicate candidate rows. The lateral subquery
            # picks exactly one linked mal_id (preferring 'dubbed' over
            # 'partial') so this join can never multiply the outer row.
            joins.append(
                "join lateral ("
                "select wl.mal_id, ma.dub_status"
                " from mal.warehouse_link wl"
                " join mal.anime ma on ma.mal_id = wl.mal_id"
                " where wl.arr_entity = 'radarr_movie'"
                " and wl.instance_name = m.instance_name"
                " and wl.warehouse_source_id = m.source_id"
                " and ma.dub_status in ('partial', 'dubbed')"
                " order by case ma.dub_status when 'dubbed' then 2 else 1 end desc, wl.mal_id"
                " limit 1"
                ") dub on true"
            )
            select_cols += ", dub.dub_status, dub.mal_id"
        has_file = "coalesce((m.payload->>'hasFile')::boolean, false)"
    else:
        item, file_alias = "e", "ef"
        select_cols = (
            "e.source_id, e.series_source_id, e.season_number, e.episode_number,"
            " e.title, s.title as series_title,"
            " coalesce((e.payload->>'hasFile')::boolean, false) as has_file,"
            " ef.video_resolution, ef.audio_languages, ef.video_codec, ef.quality"
        )
        joins = [
            "from warehouse.episode e",
            "join warehouse.series s on s.source_id = e.series_source_id"
            " and s.instance_name = e.instance_name and not s.deleted",
            "left join warehouse.episode_file ef on ef.episode_source_id = e.source_id"
            " and ef.instance_name = e.instance_name and not ef.deleted",
        ]
        where = [
            "not e.deleted",
            "e.instance_name = :instance_name",
            "e.air_date is not null",
            "e.air_date <= now()",
        ]
        if scope.monitored_only:
            where.append("e.monitored")
            where.append("s.monitored")
        if scope.anime_only:
            where.append("lower(coalesce(s.payload->>'seriesType', '')) = 'anime'")
        if scope.series_type:
            where.append("lower(coalesce(s.payload->>'seriesType', '')) = :series_type")
            binds["series_type"] = scope.series_type.lower()
        if scope.genres_any:
            where.append(_jsonb_text_any("s.genres", "genres_any"))
            binds["genres_any"] = [value.lower() for value in scope.genres_any]
        if scope.tags_any:
            where.append(
                "exists (select 1 from jsonb_array_elements_text("
                "coalesce(s.payload->'tags', '[]'::jsonb)) tg"
                " where tg ~ '^[0-9]+$' and tg::int = any(:tag_ids))"
            )
        if options.mal_dub_gate:
            # Same fan-out hazard as the movie branch above — one series can
            # be linked from multiple mal_ids — so gate via a lateral join
            # that returns at most one row, correlated on the series (s.).
            joins.append(
                "join lateral ("
                "select wl.mal_id, ma.dub_status"
                " from mal.warehouse_link wl"
                " join mal.anime ma on ma.mal_id = wl.mal_id"
                " where wl.arr_entity = 'sonarr_series'"
                " and wl.instance_name = s.instance_name"
                " and wl.warehouse_source_id = s.source_id"
                " and ma.dub_status in ('partial', 'dubbed')"
                " order by case ma.dub_status when 'dubbed' then 2 else 1 end desc, wl.mal_id"
                " limit 1"
                ") dub on true"
            )
            select_cols += ", dub.dub_status, dub.mal_id"
        has_file = "coalesce((e.payload->>'hasFile')::boolean, false)"

    wants_search = wants_missing or wants_upgrade
    if wants_search:
        order = f"order by lg.last_fired_at asc nulls first, {item}.source_id"
        ledger_join = (
            f"left join app.automation_action_ledger lg on lg.instance_name = {item}.instance_name"
            f" and lg.entity_type = '{entity}' and lg.source_id = {item}.source_id"
            " and lg.action_type = 'search'"
        )
        joins.append(ledger_join)
    else:
        order = f"order by {item}.source_id"

    conforming = f"({has_file} and {file_alias}.source_id is not null and {req_expr})"
    if sense == "conforming":
        where.append(conforming)
        cooldown_clause = None
    else:
        branches: list[str] = []
        if wants_missing:
            branches.append(f"not {has_file}")
        if wants_upgrade:
            branches.append(f"({file_alias}.source_id is not null and not ({req_expr}))")
        if not branches:  # tag / monitor-only rules act on every non-conforming item
            branches.append(f"not {conforming}")
        where.append("(" + " or ".join(branches) + ")")
        cooldown_clause = (
            (
                "(lg.last_fired_at is null or lg.last_fired_at <"
                " now() - make_interval(days => :cooldown_days))"
            )
            if wants_search
            else None
        )

    base = " ".join(joins) + " where " + " and ".join(where)
    base_with_cooldown = base + (f" and {cooldown_clause}" if cooldown_clause else "")
    select_sql = f"select {select_cols} {base_with_cooldown} {order} limit :limit"
    count_sql = f"select count(*) {base_with_cooldown}"
    count_all_sql = f"select count(*) {base}"
    return CompiledQuery(
        select_sql=select_sql, count_sql=count_sql, count_all_sql=count_all_sql, binds=binds
    )
