from __future__ import annotations

import pytest

from arrsync.services.automation_rules import (
    TEMPLATES,
    CompiledQuery,
    RuleParams,  # noqa: F401 - part of the documented public interface exercised below
    RuleRequire,
    compile_candidates,
    failure_reasons,
    validate_params,
)


def _minimal(actions=None, **overrides):
    params = {
        "scope": {"media": "movies"},
        "require": {"resolution_min": 1080},
        "actions": [{"type": "search_upgrade"}] if actions is None else actions,
    }
    params.update(overrides)
    return params


def test_validate_rejects_unknown_template() -> None:
    with pytest.raises(ValueError, match="unknown template"):
        validate_params("nope", _minimal())


def test_validate_requires_actions() -> None:
    with pytest.raises(ValueError):
        validate_params("custom", _minimal(actions=[]))


def test_search_upgrade_requires_nonempty_require() -> None:
    bad = _minimal()
    bad["require"] = {}
    with pytest.raises(ValueError, match="search_upgrade"):
        validate_params("custom", bad)


def test_new_dub_only_requires_dub_gate() -> None:
    bad = _minimal(options={"new_dub_only": True, "mal_dub_gate": False})
    with pytest.raises(ValueError, match="new_dub_only"):
        validate_params("custom", bad)


def test_conforming_tag_action_is_allowed() -> None:
    """The v1 rejection is gone: tagging the set that *passes* is the whole point of
    a ready-to-unmonitor label, and the reconcile is now per-action."""
    params = validate_params(
        "custom",
        {
            "scope": {"media": "movies"},
            "require": {"resolution_min": 1080},
            "actions": [{"type": "tag", "label": "retired-complete", "when": "conforming"}],
        },
    )
    assert params.actions[0].when == "conforming"


def test_conforming_actions_allowed_for_series_media() -> None:
    params = validate_params(
        "custom",
        {
            "scope": {"media": "both"},
            "require": {"audio_language_any": ["english"]},
            "actions": [{"type": "set_monitored", "value": False, "when": "conforming"}],
        },
    )
    assert params.scope.media == "both"


def test_search_actions_still_cannot_be_conforming() -> None:
    with pytest.raises(ValueError, match="search actions"):
        validate_params(
            "custom",
            _minimal(actions=[{"type": "search_upgrade", "when": "conforming"}]),
        )


def test_all_templates_have_valid_default_params() -> None:
    assert set(TEMPLATES) == {
        "anime-dub-enforcer",
        "new-dub-watcher",
        "resolution-floor",
        "missing-hunter",
        "codec-preference",
        "language-audit",
        "complete-series-tagger",
        "series-done-unmonitor",
        "series-spec-audit",
        "incomplete-ended-series",
        "movie-done-unmonitor",
        "foreign-subs-audit",
        "custom",
    }
    for template in TEMPLATES.values():
        validate_params(template.key, template.default_params)


def test_language_templates_carry_both_spellings() -> None:
    """Arrs report a mix of ISO-639-2 codes and full names for one language, even
    inside a single library ('english' and 'eng'), so a template that shipped one
    spelling would silently miss half the files."""
    for key in ("anime-dub-enforcer", "complete-series-tagger", "movie-done-unmonitor"):
        langs = TEMPLATES[key].default_params["require"]["audio_language_any"]
        assert {"english", "eng"} <= set(langs), key
    subs = TEMPLATES["foreign-subs-audit"].default_params["require"]["subtitle_language_any"]
    assert {"eng", "english"} <= set(subs)


def test_completeness_templates_exclude_specials_and_count_unmonitored() -> None:
    """Both settings exist to stop a show reading as incomplete for the wrong
    reason: a missing special, or a gap that was papered over by unmonitoring it."""
    for key in ("complete-series-tagger", "series-done-unmonitor", "incomplete-ended-series"):
        scope = TEMPLATES[key].default_params["scope"]
        assert scope["include_specials"] is False, key
        assert scope["include_unmonitored_episodes"] is True, key


def test_movie_sql_binds_are_values_not_text() -> None:
    params = validate_params("custom", _minimal())
    compiled = compile_candidates(params, "movie")
    assert isinstance(compiled, CompiledQuery)
    assert ":resolution_min" in compiled.select_sql
    assert compiled.binds["resolution_min"] == 1080
    assert "1080" not in compiled.select_sql  # value must be bound, never inlined
    assert ":limit" in compiled.select_sql
    assert ":cooldown_days" in compiled.select_sql
    assert "order by lg.last_fired_at asc nulls first" in compiled.select_sql


def test_movie_missing_and_upgrade_branches() -> None:
    params = validate_params(
        "custom",
        _minimal(actions=[{"type": "search_missing"}, {"type": "search_upgrade"}]),
    )
    sql = compile_candidates(params, "movie").select_sql
    assert "hasFile" in sql
    assert "mf.source_id is not null and not (" in sql


def test_dub_gate_joins_mal() -> None:
    params = validate_params("anime-dub-enforcer", TEMPLATES["anime-dub-enforcer"].default_params)
    sql = compile_candidates(params, "movie").select_sql
    assert "mal.warehouse_link" in sql
    assert "ma.dub_status in ('partial', 'dubbed')" in sql
    # Gated via a single-row lateral join (not a plain inner join) so a
    # movie/series linked from multiple mal_ids can never fan out the
    # candidate row set — see test_dub_gate_lateral_join_prevents_fanout in
    # the integration suite for the real-Postgres proof.
    assert "join lateral (" in sql
    assert ") dub on true" in sql
    assert "join mal.warehouse_link wl on wl.arr_entity" not in sql


def test_episode_sql_scopes_series_and_airdate() -> None:
    params = validate_params("anime-dub-enforcer", TEMPLATES["anime-dub-enforcer"].default_params)
    sql = compile_candidates(params, "episode").select_sql
    assert "join warehouse.series s" in sql
    assert "e.air_date <= now()" in sql
    assert "seriesType" in sql  # anime_only on the series side
    assert "lg.entity_type = 'episode'" in sql


def test_count_sql_variants() -> None:
    params = validate_params("custom", _minimal())
    compiled = compile_candidates(params, "movie")
    assert compiled.count_sql.startswith("select count(*)")
    assert ":cooldown_days" in compiled.count_sql
    assert ":cooldown_days" not in compiled.count_all_sql


def test_conforming_sense_flips_predicate_and_drops_cooldown() -> None:
    params = validate_params(
        "custom",
        _minimal(actions=[{"type": "search_upgrade"}, {"type": "set_monitored", "value": False, "when": "conforming"}]),
    )
    compiled = compile_candidates(params, "movie", sense="conforming")
    assert ":cooldown_days" not in compiled.select_sql
    assert "mf.source_id is not null" in compiled.select_sql


def test_tags_scope_requires_runtime_tag_ids_bind() -> None:
    params = validate_params("custom", _minimal(scope={"media": "movies", "tags_any": ["keep"]}))
    compiled = compile_candidates(params, "movie")
    assert ":tag_ids" in compiled.select_sql
    assert "tag_ids" not in compiled.binds  # resolved live per instance by the executor


def test_root_folder_scope_binds_paths_and_prefixes() -> None:
    params = validate_params(
        "custom", _minimal(scope={"media": "movies", "root_folders_any": ["/media/movies/"]})
    )
    compiled = compile_candidates(params, "movie")
    assert ":root_folders" in compiled.select_sql
    assert "starts_with(m.path, rfp)" in compiled.select_sql
    assert "/media/movies" not in compiled.select_sql  # value bound, never inlined
    # Trailing separator normalized away; the prefix bind carries the separator so
    # '/media/movies' can never scope '/media/movies-4k'.
    assert compiled.binds["root_folders"] == ["/media/movies"]
    assert compiled.binds["root_folder_prefixes"] == ["/media/movies/"]


def test_root_folder_scope_matches_series_path_for_episodes() -> None:
    params = validate_params(
        "custom", _minimal(scope={"media": "series", "root_folders_any": ["/media/anime"]})
    )
    compiled = compile_candidates(params, "episode")
    assert "starts_with(s.path, rfp)" in compiled.select_sql
    assert "e.path" not in compiled.select_sql  # episodes carry no path of their own


def test_root_folders_are_deduped_and_blanks_dropped() -> None:
    params = validate_params(
        "custom",
        _minimal(
            scope={
                "media": "movies",
                "root_folders_any": ["/media/movies", "/media/movies/", "  ", "/media/4k"],
            }
        ),
    )
    assert params.scope.root_folders_any == ["/media/movies", "/media/4k"]


def test_windows_root_folder_keeps_backslash_separator() -> None:
    params = validate_params(
        "custom", _minimal(scope={"media": "movies", "root_folders_any": ["C:\\Media\\Movies\\"]})
    )
    compiled = compile_candidates(params, "movie")
    assert compiled.binds["root_folders"] == ["C:\\Media\\Movies"]
    assert compiled.binds["root_folder_prefixes"] == ["C:\\Media\\Movies\\"]


def test_root_folder_too_long_is_rejected() -> None:
    with pytest.raises(ValueError):
        validate_params(
            "custom", _minimal(scope={"media": "movies", "root_folders_any": ["/" + "x" * 600]})
        )


def test_no_root_folder_scope_leaves_sql_and_binds_untouched() -> None:
    compiled = compile_candidates(validate_params("custom", _minimal()), "movie")
    assert "root_folders" not in compiled.select_sql
    assert "root_folders" not in compiled.binds


def test_tag_only_rule_has_no_cooldown_or_ledger() -> None:
    params = validate_params(
        "custom",
        _minimal(actions=[{"type": "tag", "label": "x264-candidate"}]),
    )
    compiled = compile_candidates(params, "movie")
    assert "automation_action_ledger" not in compiled.select_sql
    assert ":cooldown_days" not in compiled.select_sql
    assert "order by m.source_id" in compiled.select_sql
    assert compiled.count_sql == compiled.count_all_sql


def test_compile_candidates_rejects_unknown_sense() -> None:
    params = validate_params("custom", _minimal())
    with pytest.raises(ValueError, match="unknown sense"):
        compile_candidates(params, "movie", sense="bogus")


def _complete_series(**scope_extra):
    scope = {
        "media": "series",
        "series_status_any": ["ended"],
        "include_specials": False,
        "include_unmonitored_episodes": True,
    }
    scope.update(scope_extra)
    return validate_params(
        "custom",
        {
            "scope": scope,
            "require": {"audio_language_any": ["english", "eng"], "resolution_min": 1080},
            "actions": [{"type": "tag", "label": "ready", "when": "conforming"}],
        },
    )


def test_conforming_episode_sense_compiles_a_series_anti_join() -> None:
    """The correctness crux of series completeness: a show is in spec when NO aired
    episode fails, never when some episode passes. A rollup of conforming episodes
    would tag a show with one good episode out of forty as finished."""
    sql = compile_candidates(_complete_series(), "episode", sense="conforming").select_sql
    assert sql.startswith("select s.source_id")
    assert "from warehouse.series s" in sql
    assert "not exists (select 1 from warehouse.episode e" in sql
    # The failing-episode probe is the negation of the whole conformance predicate,
    # so one missing file and one 720p file are the same kind of disqualification.
    assert "and not (coalesce((e.payload->>'hasFile')::boolean, false)" in sql
    # No ledger/cooldown: nothing is being searched here.
    assert ":cooldown_days" not in sql
    assert "automation_action_ledger" not in sql


def test_complete_series_requires_at_least_one_aired_episode() -> None:
    """'No episode fails' is vacuously true for a show with nothing aired yet, and an
    empty show is not a finished one."""
    sql = compile_candidates(_complete_series(), "episode", sense="conforming").select_sql
    assert "exists (select 1 from warehouse.episode e" in sql
    assert "e.air_date <= now()" in sql


def test_complete_series_scopes_status_by_bind() -> None:
    compiled = compile_candidates(_complete_series(), "episode", sense="conforming")
    assert "lower(coalesce(s.status, '')) = any(:series_statuses)" in compiled.select_sql
    assert compiled.binds["series_statuses"] == ["ended"]
    assert "ended" not in compiled.select_sql  # value bound, never inlined


def test_include_specials_toggles_season_zero() -> None:
    off = compile_candidates(_complete_series(), "episode", sense="conforming").select_sql
    assert "e.season_number > 0" in off
    on = compile_candidates(
        _complete_series(include_specials=True), "episode", sense="conforming"
    ).select_sql
    assert "e.season_number > 0" not in on


def test_include_specials_defaults_to_on_for_pre_existing_rules() -> None:
    """Specials were unconditionally in scope before the field existed; a saved rule
    must not change meaning when this code ships under it."""
    params = validate_params("custom", _minimal(scope={"media": "series"}))
    assert params.scope.include_specials is True
    assert "e.season_number > 0" not in compile_candidates(params, "episode").select_sql


def test_include_unmonitored_episodes_keeps_the_series_gate() -> None:
    """An episode you already unmonitored is still a gap in the show, but an
    unmonitored *show* is still out of scope."""
    sql = compile_candidates(_complete_series(), "episode", sense="conforming").select_sql
    assert "e.monitored" not in sql
    assert "s.monitored" in sql


def test_episode_monitored_gate_survives_by_default() -> None:
    sql = compile_candidates(
        validate_params("custom", _minimal(scope={"media": "series"})), "episode"
    ).select_sql
    assert "e.monitored" in sql
    assert "s.monitored" in sql


def test_series_status_rejected_for_movie_media() -> None:
    with pytest.raises(ValueError, match="series_status_any"):
        validate_params("custom", _minimal(scope={"media": "movies", "series_status_any": ["ended"]}))


def test_unknown_series_status_is_rejected() -> None:
    with pytest.raises(ValueError, match="unknown series status"):
        validate_params("custom", _minimal(scope={"media": "series", "series_status_any": ["finished"]}))


def test_series_statuses_are_normalized_and_deduped() -> None:
    params = validate_params(
        "custom", _minimal(scope={"media": "series", "series_status_any": ["Ended", "ended", " "]})
    )
    assert params.scope.series_status_any == ["ended"]


def test_subtitle_require_compiles_and_binds() -> None:
    params = validate_params(
        "custom",
        _minimal(
            actions=[{"type": "tag", "label": "subs-missing"}],
            require={"subtitle_language_any": ["eng"], "resolution_min": 1080},
        ),
    )
    compiled = compile_candidates(params, "movie")
    assert "mf.subtitle_languages" in compiled.select_sql
    assert ":subtitle_langs" in compiled.select_sql
    assert compiled.binds["subtitle_langs"] == ["eng"]


def test_subtitle_only_require_is_not_empty() -> None:
    """is_empty gates search_upgrade; a subtitle clause is a real requirement."""
    params = validate_params(
        "custom", _minimal(require={"subtitle_language_any": ["eng"]})
    )
    assert not params.require.is_empty()


def test_series_scope_fragments_are_shared_by_both_series_queries() -> None:
    """Regression guard for the refactor: the episode candidate query and the
    series-completeness query must read the same scope, or a folder/genre/status
    filter would apply to one and silently not the other."""
    params = _complete_series(root_folders_any=["/PerPlexed/Anime/TV Shows"], genres_any=["Anime"])
    non_conf = compile_candidates(
        params.model_copy(update={"actions": [a for a in params.actions]}), "episode"
    ).select_sql
    conf = compile_candidates(params, "episode", sense="conforming").select_sql
    for fragment in (
        "starts_with(s.path, rfp)",
        "lower(coalesce(s.status, '')) = any(:series_statuses)",
        "s.monitored",
    ):
        assert fragment in non_conf, fragment
        assert fragment in conf, fragment


def test_validate_rejects_unknown_param_keys() -> None:
    bad = _minimal()
    bad["require"] = {"audio_langauge_any": ["english"]}  # typo: langauge
    with pytest.raises(ValueError):
        validate_params("custom", bad)


# --- failure reasons -------------------------------------------------------
# Derived in Python from columns the candidate select already returns, so "why is
# this show not ready" costs a run no extra query. The clauses must stay in step
# with the SQL in _require_fragments; the tests below are that contract.


def _require(**kw) -> RuleRequire:
    return RuleRequire(**kw)


def test_no_file_short_circuits_every_other_reason() -> None:
    """An episode with no file has nothing to hold against the spec; reporting five
    problems for one absent file would read as five things to fix."""
    row = {"has_file": False, "video_resolution": None, "audio_languages": None}
    assert failure_reasons(row, _require(audio_language_any=["english"], resolution_min=1080)) == [
        "no_file"
    ]


def test_reasons_report_every_failing_clause_in_a_stable_order() -> None:
    row = {
        "has_file": True,
        "audio_languages": ["japanese"],
        "subtitle_languages": [],
        "video_resolution": 720,
        "video_codec": "x264",
        "quality": "HDTV-720p",
    }
    reasons = failure_reasons(
        row,
        _require(
            audio_language_any=["english", "eng"],
            subtitle_language_any=["eng"],
            resolution_min=1080,
            video_codec_any=["x265"],
            quality_any=["Bluray-1080p"],
        ),
    )
    assert reasons == [
        "audio_language",
        "subtitle_language",
        "resolution",
        "video_codec",
        "quality",
    ]


def test_a_code_does_not_satisfy_a_name_spelling() -> None:
    """The trap the _ENGLISH constant exists for: matching is set membership after
    case-folding, not language identity, so a file tagged 'eng' fails a require that
    lists only 'english'. Same semantics as the SQL's any(:audio_langs) — which is
    why every shipped template lists both spellings."""
    row = {"has_file": True, "audio_languages": ["ENG"], "video_resolution": 1080}
    assert failure_reasons(row, _require(audio_language_any=["english"], resolution_min=1080)) == [
        "audio_language"
    ]
    assert failure_reasons(
        row, _require(audio_language_any=["english", "eng"], resolution_min=1080)
    ) == []


def test_conforming_row_reports_nothing() -> None:
    row = {"has_file": True, "audio_languages": ["english"], "video_resolution": 2160}
    assert failure_reasons(row, _require(audio_language_any=["english"], resolution_min=1080)) == []


def test_a_clean_row_reports_no_reasons() -> None:
    """The helper reports only what it can see failing. Deciding that a failing row
    with no explicable reason is 'unknown' belongs to the caller, which is the only
    side that knows the rows it holds are non-conforming."""
    assert failure_reasons({"has_file": True}, _require()) == []


def test_missing_resolution_column_counts_as_below_floor() -> None:
    row = {"has_file": True, "video_resolution": None}
    assert failure_reasons(row, _require(resolution_min=1080)) == ["resolution"]


# --- which set is a rule about ---------------------------------------------
# primary_sense is shared by the executor and the editor's live preview on purpose:
# they each had this logic, the preview kept the default sense, and it therefore
# reported the count of items that FAIL a retirement rule — the opposite of what
# the rule acts on.


def test_primary_sense_is_conforming_only_when_nothing_targets_the_failing_set() -> None:
    from arrsync.services.automation_rules import primary_sense

    retire = validate_params(
        "custom",
        {
            "scope": {"media": "series"},
            "require": {"resolution_min": 1080},
            "actions": [{"type": "tag", "label": "ready", "when": "conforming"}],
        },
    )
    assert primary_sense(retire) == "conforming"

    both = validate_params(
        "custom",
        {
            "scope": {"media": "series"},
            "require": {"resolution_min": 1080},
            "actions": [
                {"type": "tag", "label": "ready", "when": "conforming"},
                {"type": "tag", "label": "needs-fix"},
            ],
        },
    )
    # A rule carrying both is about the failing set for counting purposes: that is
    # the set with a per-item story to tell.
    assert primary_sense(both) == "non_conforming"

    assert primary_sense(validate_params("custom", _minimal())) == "non_conforming"


def test_counts_series_only_for_the_completeness_query() -> None:
    from arrsync.services.automation_rules import counts_series

    retire = validate_params(
        "custom",
        {
            "scope": {"media": "series"},
            "require": {"resolution_min": 1080},
            "actions": [{"type": "tag", "label": "ready", "when": "conforming"}],
        },
    )
    # The completeness query returns series rows, so its count is a number of shows.
    assert counts_series(retire, "episode") is True
    assert counts_series(retire, "movie") is False
    assert counts_series(validate_params("custom", _minimal()), "episode") is False
