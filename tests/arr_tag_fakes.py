"""Shared fakes for tag-reconcile service tests (MAL dub tag + coverage tags)."""

from __future__ import annotations

from typing import Any

from fakes import FakeResult, FakeSession


class TagSyncFakeSession(FakeSession):
    """Answers the SQL shapes the tag-sync services issue."""

    def __init__(
        self,
        *,
        link_rows: list[dict[str, Any]] | None = None,
        series_coverage_rows: list[dict[str, Any]] | None = None,
        movie_coverage_rows: list[dict[str, Any]] | None = None,
        integrations: dict[str, list[dict[str, Any]]] | None = None,
        series_rows: dict[str, list[dict[str, Any]]] | None = None,
        movie_rows: dict[str, list[dict[str, Any]]] | None = None,
    ) -> None:
        super().__init__()
        self.link_rows = link_rows or []
        self.series_coverage_rows = series_coverage_rows or []
        self.movie_coverage_rows = movie_coverage_rows or []
        self.integrations = integrations or {}
        self.series_rows = series_rows or {}
        self.movie_rows = movie_rows or {}
        self.finished_runs: list[tuple[str, str | None]] = []

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> FakeResult:
        sql = " ".join(str(query).lower().split())
        self.statements.append((sql, params))
        if "insert into app.mal_job_run" in sql:
            return FakeResult(scalar_value=1)
        if "update app.mal_job_run" in sql:
            if params:
                self.finished_runs.append((str(params.get("status")), params.get("error_message")))
            return FakeResult()
        if "from mal.warehouse_link" in sql:
            return FakeResult(rows=self.link_rows)
        if "from warehouse.v_anime_series_english_coverage" in sql:
            return FakeResult(rows=self.series_coverage_rows)
        if "from warehouse.v_anime_movie_english_coverage" in sql:
            return FakeResult(rows=self.movie_coverage_rows)
        if "from app.integration_instance" in sql:
            source = str((params or {}).get("source", ""))
            return FakeResult(rows=self.integrations.get(source, []))
        if "from warehouse.series" in sql:
            instance = str((params or {}).get("instance_name", ""))
            return FakeResult(rows=self.series_rows.get(instance, []))
        if "from warehouse.movie" in sql:
            instance = str((params or {}).get("instance_name", ""))
            return FakeResult(rows=self.movie_rows.get(instance, []))
        return super().execute(query, params)


def integration_row(source: str, name: str = "default") -> dict[str, Any]:
    return {
        "source": source,
        "name": name,
        "base_url": f"http://{source}.local",
        "api_key": "key",
        "enabled": True,
        "webhook_enabled": True,
    }


class FakeArrClient:
    """Records tag-editor calls; behavior tweaked via class-level configuration."""

    instances: list["FakeArrClient"] = []
    tag_ids: dict[str, int] = {}
    ensure_tag_failures: set[str] = set()
    # apply ops that raise, e.g. {"sonarr:add"} fails add batches on sonarr
    editor_failures: set[str] = set()
    # live rows returned by list_series/list_movies, keyed by instance name
    live_series: dict[str, list[dict[str, Any]]] = {}
    live_movies: dict[str, list[dict[str, Any]]] = {}

    def __init__(
        self,
        settings: Any,
        source: str,
        *,
        instance_name: str,
        base_url: str,
        api_key: str,
    ) -> None:
        self.source = source
        self.instance_name = instance_name
        self.put_series_calls: list[dict[str, Any]] = []
        self.put_movie_calls: list[dict[str, Any]] = []
        # (apply_tags, entity_ids, tag_ids) per editor call
        self.tag_editor_calls: list[tuple[str, list[int], list[int]]] = []
        self.closed = False
        type(self).instances.append(self)

    @classmethod
    def reset(
        cls,
        *,
        tag_ids: dict[str, int],
        ensure_tag_failures: set[str] | None = None,
        editor_failures: set[str] | None = None,
        live_series: dict[str, list[dict[str, Any]]] | None = None,
        live_movies: dict[str, list[dict[str, Any]]] | None = None,
    ) -> None:
        cls.instances = []
        cls.tag_ids = dict(tag_ids)
        cls.ensure_tag_failures = ensure_tag_failures or set()
        cls.editor_failures = editor_failures or set()
        cls.live_series = live_series or {}
        cls.live_movies = live_movies or {}

    async def ensure_tag_id(self, label: str) -> int:
        if self.source in self.ensure_tag_failures:
            raise RuntimeError(f"{self.source} tag endpoint down")
        return self.tag_ids[label]

    async def list_series(self) -> list[dict[str, Any]]:
        if self.source != "sonarr":
            return []
        return self.live_series.get(self.instance_name, [])

    async def list_movies(self) -> list[dict[str, Any]]:
        if self.source != "radarr":
            return []
        return self.live_movies.get(self.instance_name, [])

    def _editor(self, apply_tags: str, entity_ids: list[int], tags: list[int]) -> None:
        if f"{self.source}:{apply_tags}" in self.editor_failures:
            raise RuntimeError(f"{self.source} editor {apply_tags} failed")
        self.tag_editor_calls.append((apply_tags, list(entity_ids), list(tags)))

    async def update_series_tags(self, series_ids: list[int], tag_ids: list[int], apply_tags: str) -> None:
        assert self.source == "sonarr"
        self._editor(apply_tags, series_ids, tag_ids)

    async def update_movie_tags(self, movie_ids: list[int], tag_ids: list[int], apply_tags: str) -> None:
        assert self.source == "radarr"
        self._editor(apply_tags, movie_ids, tag_ids)

    async def put_series(self, body: dict[str, Any]) -> None:
        # Full-object PUTs clobber concurrent edits; tests assert these stay empty.
        self.put_series_calls.append(body)

    async def put_movie(self, body: dict[str, Any]) -> None:
        self.put_movie_calls.append(body)

    async def aclose(self) -> None:
        self.closed = True
