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
    """Records tag/put calls; behavior tweaked via class-level configuration."""

    instances: list["FakeArrClient"] = []
    tag_ids: dict[str, int] = {}
    ensure_tag_failures: set[str] = set()
    put_failures: set[int] = set()

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
        self.closed = False
        type(self).instances.append(self)

    @classmethod
    def reset(
        cls,
        *,
        tag_ids: dict[str, int],
        ensure_tag_failures: set[str] | None = None,
        put_failures: set[int] | None = None,
    ) -> None:
        cls.instances = []
        cls.tag_ids = dict(tag_ids)
        cls.ensure_tag_failures = ensure_tag_failures or set()
        cls.put_failures = put_failures or set()

    async def ensure_tag_id(self, label: str) -> int:
        if self.source in self.ensure_tag_failures:
            raise RuntimeError(f"{self.source} tag endpoint down")
        return self.tag_ids[label]

    async def put_series(self, body: dict[str, Any]) -> None:
        if int(body.get("id", body.get("source_id", -1)) or -1) in self.put_failures:
            raise RuntimeError("put failed")
        self.put_series_calls.append(body)

    async def put_movie(self, body: dict[str, Any]) -> None:
        if int(body.get("id", body.get("source_id", -1)) or -1) in self.put_failures:
            raise RuntimeError("put failed")
        self.put_movie_calls.append(body)

    async def aclose(self) -> None:
        self.closed = True
