from __future__ import annotations

import pytest

from arrsync.services.automation_rules import (
    TEMPLATES,
    CompiledQuery,
    RuleParams,  # noqa: F401 - part of the documented public interface exercised below
    compile_candidates,
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


def test_conforming_tag_action_rejected() -> None:
    bad = {
        "scope": {"media": "movies"},
        "require": {"resolution_min": 1080},
        "actions": [{"type": "tag", "label": "x264-candidate", "when": "conforming"}],
    }
    with pytest.raises(ValueError, match="conforming tag actions"):
        validate_params("custom", bad)


def test_conforming_actions_rejected_for_series_media() -> None:
    bad = {
        "scope": {"media": "both"},
        "require": {"audio_language_any": ["english"]},
        "actions": [{"type": "set_monitored", "value": False, "when": "conforming"}],
    }
    with pytest.raises(ValueError, match="conforming"):
        validate_params("custom", bad)


def test_all_templates_have_valid_default_params() -> None:
    assert set(TEMPLATES) == {
        "anime-dub-enforcer",
        "new-dub-watcher",
        "resolution-floor",
        "missing-hunter",
        "codec-preference",
        "language-audit",
        "custom",
    }
    for template in TEMPLATES.values():
        validate_params(template.key, template.default_params)


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


def test_validate_rejects_unknown_param_keys() -> None:
    bad = _minimal()
    bad["require"] = {"audio_langauge_any": ["english"]}  # typo: langauge
    with pytest.raises(ValueError):
        validate_params("custom", bad)
