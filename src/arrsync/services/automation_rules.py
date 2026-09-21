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

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

_MAX_FOLDER_LEN = 512

# Sonarr's series statuses, as written to warehouse.series.status by
# repository.upsert_series (straight from the API payload, never derived).
_SERIES_STATUSES = frozenset({"continuing", "ended", "upcoming", "deleted"})


def folder_separator(folder: str) -> str:
    """Separator this path is written with — '\\' only for Windows-style paths."""
    return "\\" if ("\\" in folder and "/" not in folder) else "/"


def normalize_root_folder(raw: str) -> str:
    """Canonicalize a root-folder path so '/media/anime/' and '/media/anime' scope
    identically. Returns '' for blank input (callers drop those)."""
    folder = (raw or "").strip()
    if not folder:
        return ""
    if len(folder) > _MAX_FOLDER_LEN:
        raise ValueError(f"root folder path exceeds {_MAX_FOLDER_LEN} characters")
    trimmed = folder.rstrip("/\\")
    return trimmed or folder_separator(folder)


def root_folder_prefix(folder: str) -> str:
    """The folder plus its trailing separator — the string a child path starts with.

    Baking the separator into the bind is what keeps '/media/anime' from also
    scoping '/media/anime-movies'.
    """
    sep = folder_separator(folder)
    return folder if folder.endswith(sep) else folder + sep


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
    # Library location filter, matched against warehouse.movie.path /
    # warehouse.series.path. Empty = every folder.
    root_folders_any: list[str] = Field(default_factory=list, max_length=40)
    monitored_only: bool = True
    # Series-side only (rejected for media='movies' so a rule that can never
    # match fails loudly instead of quietly doing nothing). Empty = any status.
    series_status_any: list[str] = Field(default_factory=list, max_length=4)
    # Season 0. Defaults True because specials were unconditionally in scope
    # before this field existed and an already-saved rule must not change
    # meaning under it; the completeness templates turn it off, since a missing
    # special is the most common reason an otherwise-finished show never reads
    # as complete.
    include_specials: bool = True
    # Evaluate every aired episode, not just monitored ones — `monitored_only`
    # still gates the series itself. Off by default (unchanged behaviour); on is
    # what a "do I have every episode" check wants, where an episode you already
    # unmonitored is still a gap in the show.
    include_unmonitored_episodes: bool = False

    @field_validator("series_status_any", mode="after")
    @classmethod
    def _normalize_series_statuses(cls, value: list[str]) -> list[str]:
        statuses: list[str] = []
        for raw in value:
            status = (raw or "").strip().lower()
            if not status:
                continue
            if status not in _SERIES_STATUSES:
                raise ValueError(
                    f"unknown series status {raw!r} (expected one of {sorted(_SERIES_STATUSES)})"
                )
            if status not in statuses:
                statuses.append(status)
        return statuses

    @field_validator("root_folders_any", mode="after")
    @classmethod
    def _normalize_root_folders(cls, value: list[str]) -> list[str]:
        folders: list[str] = []
        for raw in value:
            folder = normalize_root_folder(raw)
            if folder and folder not in folders:
                folders.append(folder)
        return folders


class RuleRequire(BaseModel):
    model_config = ConfigDict(extra="forbid")

    audio_language_any: list[str] = Field(default_factory=list, max_length=10)
    # The half of a foreign-language library's spec that audio can't express:
    # a Korean show with Korean audio is only watchable with English subs, and
    # neither Arr can answer "which files lack them".
    subtitle_language_any: list[str] = Field(default_factory=list, max_length=10)
    resolution_min: int | None = Field(default=None, ge=240, le=4320)
    video_codec_any: list[str] = Field(default_factory=list, max_length=10)
    quality_any: list[str] = Field(default_factory=list, max_length=20)

    def is_empty(self) -> bool:
        return not (
            self.audio_language_any
            or self.subtitle_language_any
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
        if self.scope.series_status_any and self.scope.media == "movies":
            raise ValueError("series_status_any does not apply to media=movies")
        return self


@dataclass(frozen=True)
class AutomationTemplate:
    key: str
    title: str
    description: str
    default_cron: str
    default_params: dict[str, Any]


# Both spellings, always: Sonarr/Radarr report a mix of ISO-639-2 codes and full
# names for the same language even within one library ('english' and 'eng',
# 'korean' and 'kor'), so a single-spelling require silently misses half the files.
_ENGLISH = ["english", "eng"]
_ENGLISH_SUBS = ["eng", "english"]
_KOREAN = ["korean", "kor"]

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
            key="complete-series-tagger",
            title="Ready-to-unmonitor tagger (series)",
            description=(
                "Tags finished shows where every aired episode already meets your "
                "spec, so you can sort by one tag and retire them in bulk. Neither "
                "Sonarr nor Radarr can ask 'is this whole show done' — their views "
                "are per-episode — so nothing is unmonitored for you here: the tag "
                "is the deliverable. Excludes specials and counts episodes you have "
                "already unmonitored, so an old gap still reads as a gap."
            ),
            default_cron="0 4 * * 6",
            default_params={
                "scope": {
                    "media": "series",
                    "series_status_any": ["ended"],
                    "monitored_only": True,
                    "include_specials": False,
                    "include_unmonitored_episodes": True,
                },
                "require": {"audio_language_any": _ENGLISH, "resolution_min": 1080},
                "actions": [
                    {"type": "tag", "label": "ready-to-unmonitor", "when": "conforming"}
                ],
            },
        ),
        AutomationTemplate(
            key="series-done-unmonitor",
            title="Retire finished shows (series)",
            description=(
                "The tagger above, with the unmonitor applied for you: a finished "
                "show whose every aired episode meets spec stops being monitored, "
                "and keeps the tag so you can see what was retired. Cuts what Sonarr "
                "refreshes and RSS-scans forever after a show has ended. Start this "
                "one in dry-run and read the preview before going live."
            ),
            default_cron="30 4 * * 6",
            default_params={
                "scope": {
                    "media": "series",
                    "series_status_any": ["ended"],
                    "monitored_only": True,
                    "include_specials": False,
                    "include_unmonitored_episodes": True,
                },
                "require": {"audio_language_any": _ENGLISH, "resolution_min": 1080},
                "actions": [
                    {"type": "tag", "label": "retired-complete", "when": "conforming"},
                    {"type": "set_monitored", "value": False, "when": "conforming"},
                ],
            },
        ),
        AutomationTemplate(
            key="series-spec-audit",
            title="What needs fixing (series, tag-only)",
            description=(
                "The other half of retiring a show: tags shows that are NOT in spec "
                "yet and records why — which episodes are missing, below your "
                "resolution floor, or in the wrong audio language — in the run "
                "details. Pure visibility, no searches, no monitor changes."
            ),
            default_cron="0 8 * * 6",
            default_params={
                "scope": {
                    "media": "series",
                    "monitored_only": True,
                    "include_specials": False,
                    "include_unmonitored_episodes": True,
                },
                "require": {"audio_language_any": _ENGLISH, "resolution_min": 1080},
                "actions": [{"type": "tag", "label": "needs-fix"}],
            },
        ),
        AutomationTemplate(
            key="incomplete-ended-series",
            title="Abandoned shows (ended with gaps)",
            description=(
                "Tags shows that have finished airing but that you will never "
                "complete by waiting — an episode is simply missing. A gap in a "
                "running show is normal; a gap in an ended one is permanent, and "
                "that is a distinction neither Arr can express. Tag-only: decide "
                "per show whether to hunt it or drop it."
            ),
            default_cron="30 8 * * 6",
            default_params={
                "scope": {
                    "media": "series",
                    "series_status_any": ["ended"],
                    "monitored_only": True,
                    "include_specials": False,
                    "include_unmonitored_episodes": True,
                },
                "require": {},
                "actions": [{"type": "tag", "label": "incomplete-ended"}],
            },
        ),
        AutomationTemplate(
            key="movie-done-unmonitor",
            title="Retire satisfied movies",
            description=(
                "Unmonitors movies whose file already meets your spec. Radarr's "
                "minimum-availability setting decides when to start looking, never "
                "when to stop — so a satisfied movie stays in every RSS sweep and "
                "refresh cycle forever. Tags what it retires."
            ),
            default_cron="0 9 * * 6",
            default_params={
                "scope": {"media": "movies", "monitored_only": True},
                "require": {"audio_language_any": _ENGLISH, "resolution_min": 1080},
                "actions": [
                    {"type": "tag", "label": "retired-complete", "when": "conforming"},
                    {"type": "set_monitored", "value": False, "when": "conforming"},
                ],
            },
        ),
        AutomationTemplate(
            key="foreign-subs-audit",
            title="Subtitle audit for a foreign-language library (tag-only)",
            description=(
                "For libraries where a dub does not exist: keeps the original audio "
                "as the requirement and checks English subtitles instead. Defaults "
                "to Korean audio + English subs — point it at that library's root "
                "folder. Note that an Arr only reports subtitles it can see, so run "
                "this per-library rather than globally."
            ),
            default_cron="0 10 * * 6",
            default_params={
                "scope": {
                    "media": "series",
                    "monitored_only": True,
                    "include_specials": False,
                    "include_unmonitored_episodes": True,
                },
                "require": {
                    "audio_language_any": _KOREAN,
                    "subtitle_language_any": _ENGLISH_SUBS,
                    "resolution_min": 1080,
                },
                "actions": [{"type": "tag", "label": "subs-missing"}],
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


def primary_sense(params: RuleParams) -> str:
    """Which set the rule is *about* — the one its match count should report.

    Search actions are non-conforming by validation, so a rule whose every action is
    conforming (a ready-to-unmonitor tagger) has nothing to say about the failing
    set: counting that set would report hundreds of matches for a run whose whole
    job was to tag eight finished shows.

    Shared by the executor and the editor's live preview deliberately. They had this
    logic separately, the preview kept the default sense, and it therefore showed
    the count of items that FAIL a retirement rule — the exact opposite of what the
    rule acts on.
    """
    if any(action.when == "non_conforming" for action in params.actions):
        return "non_conforming"
    return "conforming"


def counts_series(params: RuleParams, entity: str) -> bool:
    """True when a match count is a number of shows rather than episodes.

    The series-completeness query returns series rows, so "matched 288" under an
    entity named 'episode' means 288 shows. Callers use this to say which.
    """
    return entity == "episode" and primary_sense(params) == "conforming"


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
    if require.subtitle_language_any:
        frags.append(
            f"exists (select 1 from unnest(coalesce({alias}.subtitle_languages,"
            " array[]::text[])) sl where sl = any(:subtitle_langs))"
        )
        binds["subtitle_langs"] = [value.lower() for value in require.subtitle_language_any]
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


def _root_folder_fragment(alias: str) -> str:
    """Scope to items living under any of the selected root folders.

    ``starts_with`` rather than LIKE: a real library path can contain '_' or '%',
    which LIKE would treat as wildcards, and there is nothing to escape here. The
    equality arm catches an item stored directly at the root folder itself; a NULL
    path yields NULL from both arms, so unpathed rows fall out of scope.
    """
    return (
        f"({alias}.path = any(:root_folders)"
        " or exists (select 1 from unnest(cast(:root_folder_prefixes as text[])) rfp"
        f" where starts_with({alias}.path, rfp)))"
    )


def _root_folder_binds(folders: list[str]) -> dict[str, Any]:
    return {
        "root_folders": list(folders),
        "root_folder_prefixes": [root_folder_prefix(folder) for folder in folders],
    }


# Gates a series on having an English dub that exists at all, per the MAL dub
# dataset. A lateral (not a plain join) because mal.warehouse_link is unique on
# (mal_id, instance_name, arr_entity) and NOT on warehouse_source_id — one series
# can be linked from several mal_ids (season splits), which a plain join would fan
# out into duplicate candidate rows.
_DUB_GATE_SERIES_JOIN = (
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

_EPISODE_FILE_JOIN = (
    "left join warehouse.episode_file ef on ef.episode_source_id = e.source_id"
    " and ef.instance_name = e.instance_name and not ef.deleted"
)


def _series_scope_fragments(
    scope: RuleScope, options: RuleOptions
) -> tuple[list[str], list[str], dict[str, Any]]:
    """Series-level scope predicates (alias ``s``) plus the joins they need.

    Shared by the episode candidate query and the series-completeness query, so a
    scope field can never apply to one and silently not the other.
    """
    where: list[str] = []
    joins: list[str] = []
    binds: dict[str, Any] = {}
    if scope.monitored_only:
        where.append("s.monitored")
    if scope.anime_only:
        where.append("lower(coalesce(s.payload->>'seriesType', '')) = 'anime'")
    if scope.series_type:
        where.append("lower(coalesce(s.payload->>'seriesType', '')) = :series_type")
        binds["series_type"] = scope.series_type.lower()
    if scope.series_status_any:
        # First-class column, written from the Sonarr payload by upsert_series.
        where.append("lower(coalesce(s.status, '')) = any(:series_statuses)")
        binds["series_statuses"] = list(scope.series_status_any)
    if scope.genres_any:
        where.append(_jsonb_text_any("s.genres", "genres_any"))
        binds["genres_any"] = [value.lower() for value in scope.genres_any]
    if scope.tags_any:
        where.append(
            "exists (select 1 from jsonb_array_elements_text("
            "coalesce(s.payload->'tags', '[]'::jsonb)) tg"
            " where tg ~ '^[0-9]+$' and tg::int = any(:tag_ids))"
        )
    if scope.root_folders_any:
        # Episodes have no path of their own; the series' folder is what the
        # picker offers and what "location" means for a show.
        where.append(_root_folder_fragment("s"))
        binds.update(_root_folder_binds(scope.root_folders_any))
    if options.mal_dub_gate:
        joins.append(_DUB_GATE_SERIES_JOIN)
    return where, joins, binds


def _episode_scope_fragments(scope: RuleScope) -> list[str]:
    """Episode-level scope predicates (alias ``e``) — which episodes count at all.

    Unaired episodes are always out: a show that hasn't finished airing must not
    read as incomplete because of an episode that doesn't exist yet.
    """
    where = ["not e.deleted", "e.air_date is not null", "e.air_date <= now()"]
    if scope.monitored_only and not scope.include_unmonitored_episodes:
        where.append("e.monitored")
    if not scope.include_specials:
        where.append("e.season_number > 0")
    return where


def _compile_complete_series(params: RuleParams) -> CompiledQuery:
    """Series that are wholly in spec: at least one in-scope episode, and not one
    in-scope episode that fails.

    An anti-join, deliberately not a rollup of conforming episodes — a series with
    one conforming episode out of forty conforms to nothing, and rolling episode
    rows up to their series (what every other episode action does) would tag it
    perfect. This is the query that made series-level ``when=conforming`` unsafe
    in v1 and is why it was movie-only until now.

    "In spec" folds gaps and bad files into the same predicate: an episode with no
    file fails the ``hasFile`` arm, so one missing episode keeps the whole show out
    of the set just as one 720p file does.
    """
    scope, require, options = params.scope, params.require, params.options
    binds: dict[str, Any] = {}
    req_frags, req_binds = _require_fragments(require, "ef")
    binds.update(req_binds)
    req_expr = " and ".join(req_frags) if req_frags else "true"
    series_where, series_joins, series_binds = _series_scope_fragments(scope, options)
    binds.update(series_binds)

    correlate = "e.series_source_id = s.source_id and e.instance_name = s.instance_name"
    in_scope = " and ".join([correlate, *_episode_scope_fragments(scope)])
    conforming_episode = (
        "coalesce((e.payload->>'hasFile')::boolean, false)"
        f" and ef.source_id is not null and {req_expr}"
    )
    where = [
        "not s.deleted",
        "s.instance_name = :instance_name",
        *series_where,
        # Not a show with nothing aired yet: "no episode fails" is vacuously true
        # for an empty set, and an empty show is not a finished one.
        f"exists (select 1 from warehouse.episode e where {in_scope})",
        "not exists (select 1 from warehouse.episode e"
        f" {_EPISODE_FILE_JOIN} where {in_scope} and not ({conforming_episode}))",
    ]
    select_cols = (
        "s.source_id, s.title, s.status,"
        f" (select count(*) from warehouse.episode e where {in_scope})::int as episode_count"
    )
    base = " ".join(["from warehouse.series s", *series_joins]) + " where " + " and ".join(where)
    return CompiledQuery(
        select_sql=f"select {select_cols} {base} order by s.source_id limit :limit",
        count_sql=f"select count(*) {base}",
        count_all_sql=f"select count(*) {base}",
        binds=binds,
    )


_REASON_ORDER = (
    "no_file",
    "audio_language",
    "subtitle_language",
    "resolution",
    "video_codec",
    "quality",
)


def failure_reasons(row: Mapping[str, Any], require: RuleRequire) -> list[str]:
    """Why this candidate row misses the spec, derived from the columns the
    candidate select already returns — no extra query, and no second copy of the
    conformance rules that could drift from the SQL.

    A row with no file reports only ``no_file``: the remaining clauses have nothing
    to judge, and listing them would read as five separate problems to fix.
    """
    if not row.get("has_file"):
        return ["no_file"]
    reasons: list[str] = []
    if require.audio_language_any:
        have = {str(v).lower() for v in (row.get("audio_languages") or [])}
        if not have & {v.lower() for v in require.audio_language_any}:
            reasons.append("audio_language")
    if require.subtitle_language_any:
        have = {str(v).lower() for v in (row.get("subtitle_languages") or [])}
        if not have & {v.lower() for v in require.subtitle_language_any}:
            reasons.append("subtitle_language")
    if require.resolution_min is not None:
        if int(row.get("video_resolution") or 0) < require.resolution_min:
            reasons.append("resolution")
    if require.video_codec_any:
        codec = str(row.get("video_codec") or "").lower()
        if codec not in {v.lower() for v in require.video_codec_any}:
            reasons.append("video_codec")
    if require.quality_any:
        if str(row.get("quality") or "") not in set(require.quality_any):
            reasons.append("quality")
    # Sorted into a stable reported order rather than clause-declaration order, so
    # a run's details read the same way regardless of how the rule was written.
    # Empty means "nothing here fails": callers holding rows they already know to be
    # non-conforming are the ones that can call that an unexplained failure.
    return sorted(reasons, key=_REASON_ORDER.index)


def compile_candidates(
    params: RuleParams, entity: str, sense: str = "non_conforming"
) -> CompiledQuery:
    if entity not in ("movie", "episode"):
        raise ValueError(f"unknown entity {entity!r}")
    if sense not in ("non_conforming", "conforming"):
        raise ValueError(f"unknown sense {sense!r}")
    if entity == "episode" and sense == "conforming":
        # "A conforming series", not "a conforming episode" — see the docstring
        # there for why this can't be the symmetric case.
        return _compile_complete_series(params)
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
            " mf.video_resolution, mf.audio_languages, mf.subtitle_languages,"
            " mf.video_codec, mf.quality"
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
        if scope.root_folders_any:
            where.append(_root_folder_fragment("m"))
            binds.update(_root_folder_binds(scope.root_folders_any))
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
            " ef.video_resolution, ef.audio_languages, ef.subtitle_languages,"
            " ef.video_codec, ef.quality"
        )
        joins = [
            "from warehouse.episode e",
            "join warehouse.series s on s.source_id = e.series_source_id"
            " and s.instance_name = e.instance_name and not s.deleted",
            _EPISODE_FILE_JOIN,
        ]
        series_where, series_joins, series_binds = _series_scope_fragments(scope, options)
        binds.update(series_binds)
        joins.extend(series_joins)
        where = [
            *_episode_scope_fragments(scope),
            "e.instance_name = :instance_name",
            *series_where,
        ]
        if options.mal_dub_gate:
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
