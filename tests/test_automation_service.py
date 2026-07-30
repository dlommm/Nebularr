from __future__ import annotations

import json
from typing import Any

import pytest

from arrsync.services import automation_service as svc_module
from arrsync.services.automation_service import AutomationService, _profile_language_warning
from fakes import FakeResult, FakeSession, FakeSettings


AUTOMATION_ROW = {
    "id": 3,
    "name": "dub hunt",
    "template_key": "custom",
    "params": {
        "scope": {"media": "movies", "monitored_only": True},
        "require": {"audio_language_any": ["english", "eng"], "resolution_min": 1080},
        "actions": [{"type": "search_missing"}, {"type": "search_upgrade"}],
    },
    "enabled": True,
    "dry_run": False,
    "cron": "0 6 */2 * *",
    "timezone": "UTC",
    "budget_per_run": 10,
    "cooldown_days": 7,
    "state": {},
}

CANDIDATES = [
    {"source_id": 1, "title": "jpn only", "has_file": True},
    {"source_id": 3, "title": "missing", "has_file": False},
]


class ServiceFakeSession(FakeSession):
    def __init__(self, automation_row: dict | None = AUTOMATION_ROW, candidates: list | None = None,
                 recent_searches: int = 0) -> None:
        super().__init__()
        self.automation_row = automation_row
        self.candidates = candidates if candidates is not None else list(CANDIDATES)
        self.recent_searches = recent_searches
        self.finish_params: dict | None = None
        self.ledger_writes: list[dict] = []

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> FakeResult:
        sql = " ".join(str(query).lower().split())
        if "from app.automation where id" in sql:
            self.statements.append((sql, params))
            rows = [self.automation_row] if self.automation_row else []
            return FakeResult(rows=rows)
        if "insert into app.automation_run" in sql:
            self.statements.append((sql, params))
            return FakeResult(scalar_value=11)
        if "update app.automation_run" in sql:
            self.finish_params = params
            return FakeResult()
        if "insert into app.automation_action_ledger" in sql:
            self.ledger_writes.append(params or {})
            return FakeResult()
        if "select count(*) from app.automation_action_ledger" in sql:
            return FakeResult(scalar_value=self.recent_searches)
        if sql.startswith("select count(*)"):
            # candidate count variants: cooldown-filtered then unfiltered
            return FakeResult(scalar_value=len(self.candidates))
        if "from warehouse.movie m" in sql or "from warehouse.episode e" in sql:
            self.statements.append((sql, params))
            return FakeResult(rows=self.candidates)
        if "update app.automation set state" in sql:
            return FakeResult()
        return super().execute(query, params)


class FakeArrClient:
    def __init__(self, settings: Any, source: str, *, instance_name: str = "default",
                 base_url: str | None = None, api_key: str | None = None) -> None:
        self.source = source
        self.searched: list[list[int]] = []
        self.custom_formats: list[dict] = [{"name": "English Dub", "specifications": []}]

    async def search_movies(self, movie_ids: list[int]) -> None:
        self.searched.append(list(movie_ids))

    async def search_episodes(self, episode_ids: list[int]) -> None:
        self.searched.append(list(episode_ids))

    async def list_custom_formats(self) -> list[dict]:
        return self.custom_formats

    async def list_tags(self) -> list[dict]:
        return []

    async def aclose(self) -> None:
        return None


@pytest.fixture()
def integrations(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        svc_module.repo,
        "list_enabled_integrations",
        lambda session, source: [
            {"source": source, "name": "default", "base_url": "http://x", "api_key": "k"}
        ],
    )


def _service(session: ServiceFakeSession) -> tuple[AutomationService, list[FakeArrClient]]:
    made: list[FakeArrClient] = []

    class TrackingClient(FakeArrClient):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, **kwargs)
            made.append(self)

    service = AutomationService(
        FakeSettings(), lambda: session, arr_client_class=TrackingClient  # type: ignore[arg-type]
    )
    return service, made


@pytest.mark.asyncio
async def test_live_run_searches_and_writes_ledger(integrations: None) -> None:
    session = ServiceFakeSession()
    service, clients = _service(session)
    result = await service.run(3, reason="manual")
    assert result["status"] == "success"
    assert clients[0].searched == [[1, 3]]
    assert {w["source_id"] for w in session.ledger_writes} == {1, 3}
    assert session.finish_params is not None
    assert session.finish_params["status"] == "success"
    assert session.finish_params["actions_taken"] == 2


@pytest.mark.asyncio
async def test_dry_run_records_would_do_and_touches_nothing(integrations: None) -> None:
    session = ServiceFakeSession(automation_row={**AUTOMATION_ROW, "dry_run": True})
    service, clients = _service(session)
    result = await service.run(3)
    assert result["status"] == "dry_run"
    assert clients[0].searched == []
    assert session.ledger_writes == []
    details = json.loads(session.finish_params["details"])
    assert len(details["instances"]["default"]["movie"]["would_do"]) == 2


@pytest.mark.asyncio
async def test_daily_cap_clamps_budget(integrations: None) -> None:
    # cap 100, 99 used today -> budget clamps to 1 -> select :limit == 1
    session = ServiceFakeSession(recent_searches=99)
    service, _clients = _service(session)
    await service.run(3)
    select_sql, select_params = next(
        (sql, p) for sql, p in session.statements if "from warehouse.movie m" in sql
    )
    assert select_params["limit"] == 1


@pytest.mark.asyncio
async def test_lock_held_returns_already_running(integrations: None) -> None:
    session = ServiceFakeSession()
    session.job_lock_held = True
    service, _ = _service(session)
    result = await service.run(3)
    assert result["status"] == "already_running"
    assert session.finish_params is None


@pytest.mark.asyncio
async def test_unknown_automation_returns_not_found(integrations: None) -> None:
    session = ServiceFakeSession(automation_row=None)
    service, _ = _service(session)
    assert (await service.run(99))["status"] == "not_found"


def test_profile_warning_flags_missing_language_formats() -> None:
    assert _profile_language_warning([]) is not None
    assert _profile_language_warning([{"name": "Anime Dub", "specifications": []}]) is None
    assert (
        _profile_language_warning(
            [{"name": "X", "specifications": [{"implementation": "LanguageSpecification"}]}]
        )
        is None
    )
