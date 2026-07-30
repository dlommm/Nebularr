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
                 recent_searches: int = 0, alt_rows: list | None = None) -> None:
        super().__init__()
        self.automation_row = automation_row
        self.candidates = candidates if candidates is not None else list(CANDIDATES)
        # Second row-set used only when a test explicitly configures it: routes any
        # warehouse select that asks for AutomationService.SEARCHLESS_LIMIT rows (an
        # action_rows select, or a conforming-sense set_monitored select — the two
        # kinds of query that always request the unbudgeted, searchless cap) away
        # from the budgeted `candidates` list. Tests that never set this keep every
        # searchless-limited select returning `candidates` too (unchanged from
        # before this existed), since the two are semantically identical for a rule
        # with no search action.
        self.alt_rows = alt_rows
        self.recent_searches = recent_searches
        self.finish_params: dict | None = None
        self.ledger_writes: list[dict] = []
        self.state_writes: list[dict] = []

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
            limit = (params or {}).get("limit")
            source_rows = (
                self.alt_rows
                if self.alt_rows is not None and limit == AutomationService.SEARCHLESS_LIMIT
                else self.candidates
            )
            # Real SQL applies LIMIT; mirror that here so budget-depletion tests
            # (a later instance's select seeing a smaller :limit) actually observe
            # a smaller result set instead of always getting every candidate back.
            rows = source_rows if limit is None else source_rows[: max(0, int(limit))]
            return FakeResult(rows=rows)
        if "update app.automation set state" in sql:
            self.state_writes.append(params or {})
            return FakeResult()
        return super().execute(query, params)


class FakeArrClient:
    """Records every method a live-diff reconcile can call.

    ``list_movies``/``list_series``/``list_tags`` are GETs and are safe to call from
    dry-run previews; ``ensure_tag_id`` and the ``update_*`` editors mutate and must
    never be called in a dry run — tests assert on the *_calls lists to prove that.
    """

    def __init__(self, settings: Any, source: str, *, instance_name: str = "default",
                 base_url: str | None = None, api_key: str | None = None) -> None:
        self.source = source
        self.instance_name = instance_name
        self.searched: list[list[int]] = []
        self.custom_formats: list[dict] = [{"name": "English Dub", "specifications": []}]
        self.live_movies: dict[str, list[dict]] = {}
        self.live_series: dict[str, list[dict]] = {}
        self.tags: list[dict] = []
        self.ensure_tag_calls: list[str] = []
        self.tag_editor_calls: list[tuple[str, list[int], list[int], str]] = []
        self.monitored_calls: list[tuple[str, list[int], bool]] = []

    async def search_movies(self, movie_ids: list[int]) -> None:
        self.searched.append(list(movie_ids))

    async def search_episodes(self, episode_ids: list[int]) -> None:
        self.searched.append(list(episode_ids))

    async def list_custom_formats(self) -> list[dict]:
        return self.custom_formats

    async def list_tags(self) -> list[dict]:
        return self.tags

    async def list_movies(self) -> list[dict]:
        return self.live_movies.get(self.instance_name, [])

    async def list_series(self) -> list[dict]:
        return self.live_series.get(self.instance_name, [])

    async def ensure_tag_id(self, label: str) -> int:
        self.ensure_tag_calls.append(label)
        key = label.strip().casefold()
        for t in self.tags:
            if str(t.get("label", "")).strip().casefold() == key:
                return int(t["id"])
        new_id = max((int(t["id"]) for t in self.tags), default=0) + 1
        self.tags.append({"id": new_id, "label": label})
        return new_id

    async def update_movie_tags(self, movie_ids: list[int], tag_ids: list[int], apply_tags: str) -> None:
        self.tag_editor_calls.append(("movie", list(movie_ids), list(tag_ids), apply_tags))

    async def update_series_tags(self, series_ids: list[int], tag_ids: list[int], apply_tags: str) -> None:
        self.tag_editor_calls.append(("series", list(series_ids), list(tag_ids), apply_tags))

    async def update_movies_monitored(self, movie_ids: list[int], monitored: bool) -> None:
        self.monitored_calls.append(("movie", list(movie_ids), monitored))

    async def update_series_monitored(self, series_ids: list[int], monitored: bool) -> None:
        self.monitored_calls.append(("series", list(series_ids), monitored))

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


def _service(
    session: ServiceFakeSession,
    *,
    live_movies: dict[str, list[dict]] | None = None,
    live_series: dict[str, list[dict]] | None = None,
    tags: list[dict] | None = None,
) -> tuple[AutomationService, list[FakeArrClient]]:
    made: list[FakeArrClient] = []

    class TrackingClient(FakeArrClient):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, **kwargs)
            if live_movies is not None:
                self.live_movies = live_movies
            if live_series is not None:
                self.live_series = live_series
            if tags is not None:
                self.tags = tags
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
async def test_budget_depletes_across_instances(monkeypatch: pytest.MonkeyPatch) -> None:
    # cap 100, 97 used today -> 3 remaining for the whole run (shared, not per-instance).
    # Two enabled radarr instances; the first has 2 candidates and searches both,
    # leaving 1 in the pool -> the second instance's select must see :limit == 1,
    # and the run must not search more than 3 items in total across both clients.
    monkeypatch.setattr(
        svc_module.repo,
        "list_enabled_integrations",
        lambda session, source: [
            {"source": source, "name": "inst-a", "base_url": "http://a", "api_key": "k"},
            {"source": source, "name": "inst-b", "base_url": "http://b", "api_key": "k"},
        ],
    )
    session = ServiceFakeSession(
        recent_searches=97,
        candidates=[
            {"source_id": 1, "title": "one", "has_file": False},
            {"source_id": 2, "title": "two", "has_file": False},
        ],
    )
    service, clients = _service(session)
    result = await service.run(3)

    select_calls = [(sql, p) for sql, p in session.statements if "from warehouse.movie m" in sql]
    assert len(select_calls) == 2
    assert select_calls[0][1]["limit"] == 3  # first instance sees the full remaining pool
    assert select_calls[1][1]["limit"] == 1  # second instance sees 3 - 2 already searched

    total_searched = sum(len(batch) for client in clients for batch in client.searched)
    assert total_searched <= 3
    # The second instance's eligible count (2) exceeds what the depleted budget let
    # it select (1), so the run must surface that as a budget skip, not silently succeed.
    assert result["skipped_budget"] == 1
    assert result["status"] == "partial"


@pytest.mark.asyncio
async def test_tag_reconcile_adds_and_removes(integrations: None) -> None:
    """Movie tag rule: adds the label to matched items, removes it from every
    currently-tagged live item that no longer matches — diffed against LIVE state."""
    row = {
        **AUTOMATION_ROW,
        "params": {
            "scope": {"media": "movies", "monitored_only": True},
            "require": {"audio_language_any": ["english", "eng"]},
            "actions": [{"type": "tag", "label": "non-english-audio"}],
        },
    }
    candidates = [{"source_id": 1, "title": "one"}, {"source_id": 3, "title": "three"}]
    session = ServiceFakeSession(automation_row=row, candidates=candidates)
    live_movies = {
        "default": [
            {"id": 1, "tags": []},   # matched, untagged -> add
            {"id": 3, "tags": [7]},  # matched, already tagged -> no-op
            {"id": 5, "tags": [7]},  # unmatched but tagged -> remove
        ]
    }
    tags = [{"id": 7, "label": "non-english-audio"}]
    service, clients = _service(session, live_movies=live_movies, tags=tags)
    result = await service.run(3)

    client = clients[0]
    assert ("movie", [1], [7], "add") in client.tag_editor_calls
    assert ("movie", [5], [7], "remove") in client.tag_editor_calls
    assert result["status"] == "success"


@pytest.mark.asyncio
async def test_tag_reconcile_survives_budget_exhaustion(integrations: None) -> None:
    """C1 regression: the tag/monitor reconcile target set must come from the
    unbudgeted action_rows, never from the budget-truncated search candidate list.
    With the daily cap fully used, the budgeted select returns nothing — but the
    tag reconcile must still diff against the full non-conforming set, or it would
    incorrectly strip the tag from every currently-tagged live item."""
    row = {
        **AUTOMATION_ROW,
        "params": {
            "scope": {"media": "movies", "monitored_only": True},
            "require": {"audio_language_any": ["english", "eng"], "resolution_min": 1080},
            "actions": [{"type": "search_missing"}, {"type": "tag", "label": "needs-search"}],
        },
    }
    action_rows = [{"source_id": 1, "title": "one"}, {"source_id": 3, "title": "three"}]
    session = ServiceFakeSession(
        automation_row=row,
        candidates=list(CANDIDATES),  # would be truncated to [] by the exhausted budget
        alt_rows=action_rows,
        recent_searches=100,  # daily cap already fully used -> 0 remaining for this run
    )
    live_movies = {
        "default": [
            {"id": 1, "tags": []},   # in action_rows, untagged -> add
            {"id": 3, "tags": [9]},  # in action_rows, already tagged -> no-op
            {"id": 5, "tags": [9]},  # NOT in action_rows -> correctly removed
        ]
    }
    tags = [{"id": 9, "label": "needs-search"}]
    service, clients = _service(session, live_movies=live_movies, tags=tags)
    result = await service.run(3)

    client = clients[0]
    assert client.searched == []  # budget exhausted -> nothing searched
    assert ("movie", [1], [9], "add") in client.tag_editor_calls
    removed = [ids for _kind, ids, _tag_ids, op in client.tag_editor_calls if op == "remove"]
    # id 3 (already correctly tagged per action_rows) must NOT show up as a removal —
    # that's exactly the bug: an empty budgeted candidate list must not desired-ify
    # nothing and strip tags from everything.
    assert removed == [[5]]
    assert result["status"] == "partial"  # the search side was genuinely budget-starved


@pytest.mark.asyncio
async def test_episode_tag_applies_at_series_level(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        svc_module.repo,
        "list_enabled_integrations",
        lambda session, source: (
            [{"source": source, "name": "default", "base_url": "http://x", "api_key": "k"}]
            if source == "sonarr"
            else []
        ),
    )
    row = {
        **AUTOMATION_ROW,
        "params": {
            "scope": {"media": "series", "monitored_only": True},
            "require": {"audio_language_any": ["english", "eng"]},
            "actions": [{"type": "tag", "label": "dub-candidate"}],
        },
    }
    candidates = [
        {"source_id": 101, "series_source_id": 50, "title": "ep1"},
        {"source_id": 102, "series_source_id": 50, "title": "ep2"},  # same series as ep1
        {"source_id": 201, "series_source_id": 60, "title": "ep3"},
    ]
    session = ServiceFakeSession(automation_row=row, candidates=candidates)
    live_series = {
        "default": [
            {"id": 50, "tags": []},   # matched series, untagged -> add
            {"id": 60, "tags": []},   # matched series, untagged -> add
            {"id": 70, "tags": [3]},  # unmatched series, tagged -> remove
        ]
    }
    tags = [{"id": 3, "label": "dub-candidate"}]
    service, clients = _service(session, live_series=live_series, tags=tags)
    result = await service.run(3)

    client = clients[0]
    # Two episodes in series 50 collapse to a single series-level tag call —
    # distinct series_source_id, not per-episode.
    assert ("series", [50, 60], [3], "add") in client.tag_editor_calls
    assert ("series", [70], [3], "remove") in client.tag_editor_calls
    assert result["status"] == "success"


@pytest.mark.asyncio
async def test_conforming_set_monitored_diffs_live_state(integrations: None) -> None:
    row = {
        **AUTOMATION_ROW,
        "params": {
            "scope": {"media": "movies", "monitored_only": True},
            "require": {"resolution_min": 1080},
            "actions": [
                {"type": "search_upgrade"},
                {"type": "set_monitored", "value": False, "when": "conforming"},
            ],
        },
    }
    conforming_rows = [{"source_id": 10}, {"source_id": 20}, {"source_id": 30}]
    session = ServiceFakeSession(
        automation_row=row,
        candidates=[{"source_id": 1, "title": "one", "has_file": True}],
        alt_rows=conforming_rows,
    )
    live_movies = {
        "default": [
            {"id": 10, "monitored": True},   # conforming + still monitored -> unmonitor
            {"id": 20, "monitored": False},  # conforming + already unmonitored -> no-op
            {"id": 40, "monitored": True},   # not in the conforming set -> untouched
        ]
    }
    service, clients = _service(session, live_movies=live_movies)
    result = await service.run(3)

    client = clients[0]
    assert client.monitored_calls == [("movie", [10], False)]
    assert result["status"] == "success"


@pytest.mark.asyncio
async def test_new_dub_only_transitions_and_state_merge(integrations: None) -> None:
    row = {
        **AUTOMATION_ROW,
        "params": {
            "scope": {"media": "movies", "monitored_only": True},
            "require": {"audio_language_any": ["english", "eng"], "resolution_min": 1080},
            "actions": [{"type": "search_missing"}, {"type": "search_upgrade"}],
            "options": {"mal_dub_gate": True, "new_dub_only": True},
        },
        "state": {"other_key": "keep-me", "dub_status_seen": {"111": "none", "222": "dubbed"}},
    }
    candidates = [
        {"source_id": 1, "title": "newly dubbed", "has_file": False, "mal_id": 111, "dub_status": "dubbed"},
        {"source_id": 2, "title": "already dubbed", "has_file": False, "mal_id": 222, "dub_status": "dubbed"},
    ]
    session = ServiceFakeSession(automation_row=row, candidates=candidates)
    service, clients = _service(session)
    result = await service.run(3)

    # mal_id 111 flipped none -> dubbed: fresh, searched. mal_id 222 was already
    # seen as dubbed last run: not fresh, not searched.
    assert clients[0].searched == [[1]]
    assert result["status"] == "success"
    assert session.state_writes, "expected automation.state to be persisted"
    persisted = json.loads(session.state_writes[-1]["state"])
    assert persisted["other_key"] == "keep-me"  # pre-existing, unrelated state key preserved
    assert persisted["dub_status_seen"] == {"111": "dubbed", "222": "dubbed"}  # merged, not replaced
    details = json.loads(session.finish_params["details"])
    assert "dub_status_seen" not in details  # the run row must not carry the full mal_id map
    assert details["new_dub_transitions"] == 1


@pytest.mark.asyncio
async def test_dry_run_tag_rule_previews_without_mutating(integrations: None) -> None:
    row = {
        **AUTOMATION_ROW,
        "dry_run": True,
        "params": {
            "scope": {"media": "movies", "monitored_only": True},
            "require": {"audio_language_any": ["english", "eng"]},
            "actions": [{"type": "tag", "label": "non-english-audio"}],
        },
    }
    candidates = [{"source_id": 1, "title": "one"}, {"source_id": 3, "title": "three"}]
    session = ServiceFakeSession(automation_row=row, candidates=candidates)
    live_movies = {
        "default": [
            {"id": 1, "tags": []},
            {"id": 3, "tags": [7]},
            {"id": 5, "tags": [7]},
        ]
    }
    tags = [{"id": 7, "label": "non-english-audio"}]
    service, clients = _service(session, live_movies=live_movies, tags=tags)
    result = await service.run(3)

    assert result["status"] == "dry_run"
    client = clients[0]
    # Zero-mutation invariant: never create a tag, never call an editor.
    assert client.ensure_tag_calls == []
    assert client.tag_editor_calls == []
    assert client.monitored_calls == []
    assert client.searched == []
    assert session.ledger_writes == []
    assert session.state_writes == []

    details = json.loads(session.finish_params["details"])
    preview = details["instances"]["default"]["movie"]
    assert "would_do" not in preview  # no search actions in this rule
    tag_preview = preview["would_tag:non-english-audio"]
    assert tag_preview["added"] == 1
    assert tag_preview["removed"] == 1
    assert tag_preview["added_sample"] == [1]
    assert tag_preview["removed_sample"] == [5]


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
