"""The episode->file join must stay index-usable, and must stay in one place.

A CASE in a join condition is opaque to the Postgres planner: it cannot push
either branch down to an index, so the join collapses to a materialised scan of
the whole episode_file table replayed once per episode row. Written that way the
series-completeness count hit the statement timeout on a real library (measured
33s against a 90k-episode fixture; 30ms as an OR of equalities).

The predicate was also hand-copied to five call sites, and all five were wrong in
the same way. These tests pin both halves: the shape of the predicate, and that
every site reads it from the one definition.
"""

from __future__ import annotations

import re

from arrsync.routers.reporting_registry import EPISODE_INVENTORY_CTE
from arrsync.services.automation_rules import (
    RuleParams,
    compile_candidates,
)
from arrsync.services.warehouse_sql import EPISODE_FILE_JOIN_ON


def _complete_series_sql() -> str:
    params = RuleParams.model_validate(
        {
            "scope": {"media": "series", "series_status_any": ["ended"]},
            "require": {"resolution_min": 1080},
            "actions": [{"type": "set_monitored", "value": False, "when": "conforming"}],
        }
    )
    return compile_candidates(params, "episode", "conforming").count_sql


def test_join_is_a_disjunction_of_equalities_not_a_case() -> None:
    """Each arm has to be a bare equality on an indexed column for the planner to
    reach episode_file_pkey and idx_episode_file_episode_instance."""
    assert "case" not in EPISODE_FILE_JOIN_ON.lower()
    assert "ef.source_id = e.episode_file_id" in EPISODE_FILE_JOIN_ON
    assert "ef.episode_source_id = e.source_id" in EPISODE_FILE_JOIN_ON
    assert " or " in EPISODE_FILE_JOIN_ON


def test_fallback_arm_is_guarded_so_the_arms_stay_mutually_exclusive() -> None:
    """Without the ``is null`` guard the OR would match a second, wrong file for
    episodes that already know their own — which is the orphan bug inverted."""
    assert "(e.episode_file_id is null and ef.episode_source_id = e.source_id)" in (
        EPISODE_FILE_JOIN_ON
    )


def test_every_query_that_joins_episode_to_its_file_uses_the_shared_fragment() -> None:
    for name, sql in (
        ("complete_series", _complete_series_sql()),
        ("reporting episode inventory", EPISODE_INVENTORY_CTE),
    ):
        assert EPISODE_FILE_JOIN_ON in sql, f"{name} does not use the shared join"
        assert "case when e.episode_file_id" not in sql, f"{name} reintroduced the CASE join"


def test_router_sql_interpolates_the_shared_fragment_rather_than_its_own() -> None:
    """The library and reporting queries are built as f-strings at request time, so
    the only thing a test can hold onto is that they splice the shared name in."""
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[1] / "src" / "arrsync" / "routers"
    for name, expected in (("library.py", 2), ("reporting_registry.py", 2)):
        source = (root / name).read_text()
        assert source.count("{EPISODE_FILE_JOIN}") == expected, (
            f"{name} should splice the shared join at {expected} sites"
        )
        assert "warehouse.episode_file ef\n" not in source, (
            f"{name} still writes an episode_file join out by hand"
        )


def test_no_source_file_spells_the_join_out_by_hand() -> None:
    """The five hand-written copies are why one fix had to be made five times."""
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[1] / "src"
    offenders = [
        str(path.relative_to(root))
        for path in root.rglob("*.py")
        if path.name != "warehouse_sql.py"
        and re.search(r"case when e\.episode_file_id", path.read_text())
    ]
    assert offenders == []
