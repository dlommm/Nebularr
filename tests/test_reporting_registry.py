"""Unit coverage for the reporting panel registry (no real database).

Verifies the registry's structural invariants and the single-panel CSV export
path — i.e. that exporting a registry panel executes exactly one SQL statement
instead of building the whole dashboard.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from arrsync.api import build_router
from arrsync.routers import reporting_registry as reg
from fakes import FakeAppState, FakeResult


def test_panels_keyed_by_dashboard_and_panel_id() -> None:
    assert reg.PANELS, "registry must not be empty"
    for key, spec in reg.PANELS.items():
        assert key == f"{spec.dashboard}:{spec.panel_id}"
        assert key == spec.key
        assert spec.kind in {"stat", "distribution", "table", "timeseries"}


def test_every_build_returns_sql_text_and_bind_dict() -> None:
    params = {"instance_name": "acme", "limit": 25}
    for spec in reg.PANELS.values():
        sql, binds = spec.build(params)
        assert isinstance(sql, str) and sql.strip(), f"{spec.key} produced empty SQL"
        assert isinstance(binds, dict)
        # every bind the SQL references must be supplied
        if ":instance_name" in sql:
            assert binds.get("instance_name") == "acme"
        if ":limit" in sql:
            assert binds.get("limit") == 25


def test_instance_filter_is_the_one_shared_fragment() -> None:
    assert reg.instance_filter() == "(:instance_name = '' or instance_name = :instance_name)"
    assert reg.instance_filter("e.instance_name") == "(:instance_name = '' or e.instance_name = :instance_name)"


def test_episode_inventory_cte_computes_hasfile_and_coalesced_arrays() -> None:
    cte = reg.EPISODE_INVENTORY_CTE
    assert "coalesce((e.payload ->> 'hasFile')::boolean, false) as has_file" in cte
    assert "coalesce(ef.audio_languages, array[]::text[]) as audio_languages_c" in cte
    assert "coalesce(ef.subtitle_languages, array[]::text[]) as subtitle_languages_c" in cte
    # the language-audit / dub-coverage episode tables are built on it
    for key in ("language-audit:missing_english_episodes",
                "media-deep-dive:detailed_missing_english",
                "english-dub-coverage:non_english_episodes"):
        sql, _ = reg.PANELS[key].build({"instance_name": "", "limit": 1})
        assert "with ei as (" in sql


def test_distribution_builder_parameterizes_by_view() -> None:
    ep = reg.distribution_by_view("v_episode_files")
    mv = reg.distribution_by_view("v_movie_files")
    assert "warehouse.v_episode_files" in ep and "warehouse.v_movie_files" in mv
    # both share the same shape; only the view differs
    assert ep.replace("v_episode_files", "V") == mv.replace("v_movie_files", "V")
    codec = reg.distribution_by_view("v_episode_files", label="coalesce(audio_codec, 'unknown')")
    assert "coalesce(audio_codec, 'unknown') as label" in codec


class _RecordingSession:
    """Records executed SQL and returns empty result sets."""

    def __init__(self) -> None:
        self.executed: list[str] = []

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> FakeResult:
        self.executed.append(" ".join(str(query).split()))
        return FakeResult(scalar_value=0, rows=[])


def _client_with_recording_session() -> tuple[TestClient, _RecordingSession]:
    app_state = FakeAppState()
    session = _RecordingSession()
    app_state.session = session  # session_scope yields app_state.session
    app = FastAPI()
    app.include_router(build_router(app_state))
    return TestClient(app, raise_server_exceptions=False), session


def test_csv_export_runs_exactly_one_panel_sql() -> None:
    client, session = _client_with_recording_session()
    resp = client.get("/api/reporting/dashboards/overview/panels/largest_episode_files/export.csv")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/csv")
    # single-panel path: exactly one query, and it is this panel's SQL
    assert len(session.executed) == 1, session.executed
    assert "warehouse.v_episode_files" in session.executed[0]


def test_csv_export_unknown_panel_on_known_dashboard_is_404() -> None:
    client, _session = _client_with_recording_session()
    resp = client.get("/api/reporting/dashboards/overview/panels/not-a-panel/export.csv")
    # not in the registry -> falls back to whole-dashboard build, panel not found
    assert resp.status_code == 404
