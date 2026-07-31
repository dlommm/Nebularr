# Automations Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configurable automation engine that converges the library toward user-declared quality/language preferences via rate-limited Sonarr/Radarr search commands, tags, and monitored flips.

**Architecture:** Template-instance engine. Rule params (pydantic-validated JSON) compile server-side into parameterized SQL over the warehouse (whitelisted fields only — user input becomes bind values, never SQL text). A per-automation APScheduler cron job runs an `AutomationService` executor (skeleton = `CoverageTagSyncService`): select non-conforming items excluding cooldown ledger, cap to budget, apply actions through `ArrClient`, record run + ledger.

**Tech Stack:** Python 3.11 / FastAPI / SQLAlchemy `text()` raw SQL / Alembic raw DDL / APScheduler / httpx; React 18 + TS + Vite + Tailwind + shadcn + @tanstack/react-query; pytest + vitest + Playwright.

**Spec:** `Backlog/Plans/2026-07-29-automations-design.md` (approved). Read it before starting.

## Global Constraints

- Branch: all work lands on existing branch `feat/automations`. Frequent small commits. NEVER add `Co-Authored-By` trailers to commits.
- Database is PostgreSQL only; **no ORM models** — all DB access is raw parameterized SQL via `sqlalchemy.text()`. Alembic migrations are raw `op.execute` DDL (no autogenerate), new revision chains off `0011_reporting_correctness`.
- **No user-authored SQL ever.** User params become bind values only. Same invariant as `src/arrsync/routers/reporting_registry.py`.
- Route surface is snapshot-tested: any new route requires updating `tests/fixtures/route_table.txt` in the same commit (sorted `METHOD /path` lines, no HEAD).
- Committed web dist (`src/arrsync/web/dist`) must be rebuilt on **Node 24** (use `docker run --rm -v "$PWD:/repo" -w /repo/frontend node:24 bash -lc "npm ci && npm run build"`) or CI's freshness gate fails. Rebuild once at the end (Task 12), not per frontend commit.
- Frontend lint: `npm run lint` runs eslint with `--max-warnings 0`; local rule forbids PascalCase components defined inside components — hoist subcomponents to module scope.
- Backend tests: `python -m pytest tests/ -x -q` from repo root (unit tests need no Postgres; `tests/fakes.py` FakeSession answers known SQL shapes and **raises on unexpected SQL** — extend fakes when adding SQL).
- Integration tests (real Postgres): `NEBULARR_TEST_DATABASE_URL=postgresql+psycopg://... python -m pytest tests/integration -q`. If no local PG: `docker compose --profile nebularr-bundled-postgres up -d postgres` then use `postgresql+psycopg://nebularr:nebularr@localhost:5432/nebularr` (check `docker-compose.yml` for actual credentials before assuming these).
- Settings defaults live in `src/arrsync/config.py` `Settings`; every new field must also be added to `tests/fakes.py` `FakeSettings`.
- New schedule-capable jobs do NOT extend `app.sync_schedule` / `SCHEDULE_MODE_LABELS` — automations have their own table and page.

## File Structure

| File | Responsibility |
| --- | --- |
| `alembic/versions/0012_automations.py` | Create: 3 new `app.*` tables, `video_resolution` columns + backfill + indexes |
| `src/arrsync/services/automation_rules.py` | Create: pydantic rule schema, template registry, SQL predicate compiler |
| `src/arrsync/services/automation_store.py` | Create: raw-SQL CRUD for automation rows, runs, action ledger |
| `src/arrsync/services/automation_service.py` | Create: run executor (locking, budget, cooldown, actions, dry-run) |
| `src/arrsync/services/arr_client.py` | Modify: search commands, monitored editors, profile reads, command throttle |
| `src/arrsync/services/repository.py` | Modify: `_extract_video_resolution` + wire into both file upserts |
| `src/arrsync/services/scheduler.py` | Modify: register `automation:{id}` jobs from `app.automation` |
| `src/arrsync/routers/automations.py` | Create: REST surface `/api/automations*` |
| `src/arrsync/api.py` | Modify: include automations router (before ui_shell) |
| `src/arrsync/main.py` | Modify: construct `AutomationService`, wire into scheduler + `AppState` |
| `src/arrsync/config.py` | Modify: 2 new settings knobs |
| `tests/test_automation_rules.py`, `tests/test_automation_store.py`, `tests/test_automation_service.py`, `tests/test_arr_client_commands.py`, `tests/test_automations_api.py` | Create: unit tests |
| `tests/test_scheduler.py`, `tests/fakes.py`, `tests/fixtures/route_table.txt` | Modify |
| `tests/integration/test_automations_integration.py` | Create: real-PG predicate/migration correctness |
| `frontend/src/pages/AutomationsPage.tsx`, `frontend/src/pages/automations/*` | Create: page, list, template gallery, editor, run sheet |
| `frontend/src/{routes/paths.ts, App.tsx, layout/AppLayout.tsx, api.ts, types.ts, lib/queryKeys.ts}` | Modify: route/nav/api plumbing |
| `docs/AUTOMATIONS.md`, `README.md`, `Backlog/V2_BACKLOG.md` | Docs |
| `frontend/tests/e2e/critical-flows.spec.ts` | Modify: automation-creation e2e |

---

### Task 1: Migration `0012_automations`

**Files:**
- Create: `alembic/versions/0012_automations.py`
- Test: `tests/integration/test_automations_integration.py` (first half; extended in Task 3)

**Interfaces:**
- Produces tables `app.automation`, `app.automation_run`, `app.automation_action_ledger`; columns `warehouse.movie_file.video_resolution int`, `warehouse.episode_file.video_resolution int`. All later tasks depend on these exact names.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/test_automations_integration.py`. Copy the connection/skip scaffolding style from `tests/integration/test_postgres_integration.py` (read it first — reuse its engine fixture/skip marker verbatim rather than inventing one):

```python
"""Real-Postgres checks for the automations schema and predicate compiler."""

from __future__ import annotations

import os

import pytest
import sqlalchemy
from sqlalchemy import text

DATABASE_URL = os.getenv("NEBULARR_TEST_DATABASE_URL", "")

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not DATABASE_URL, reason="NEBULARR_TEST_DATABASE_URL not set"),
]


@pytest.fixture()
def engine():
    eng = sqlalchemy.create_engine(DATABASE_URL)
    yield eng
    eng.dispose()


def test_automation_tables_exist(engine) -> None:
    with engine.connect() as conn:
        for table in ("automation", "automation_run", "automation_action_ledger"):
            assert conn.execute(
                text(
                    "select 1 from information_schema.tables"
                    " where table_schema = 'app' and table_name = :t"
                ),
                {"t": table},
            ).first() is not None, f"app.{table} missing"
        for table in ("movie_file", "episode_file"):
            assert conn.execute(
                text(
                    "select 1 from information_schema.columns"
                    " where table_schema = 'warehouse' and table_name = :t"
                    " and column_name = 'video_resolution'"
                ),
                {"t": table},
            ).first() is not None, f"warehouse.{table}.video_resolution missing"


def test_video_resolution_backfill_expression(engine) -> None:
    """The backfill regexes must extract heights from real payload shapes."""
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                """
                select
                    coalesce(
                        substring(v.payload->'mediaInfo'->>'resolution' from 'x([0-9]{3,4})')::int,
                        substring(coalesce(v.quality, '') from '([0-9]{3,4})[pi]')::int
                    ) as res,
                    v.expected
                from (values
                    ('{"mediaInfo": {"resolution": "1920x1080"}}'::jsonb, 'WEBDL-1080p', 1080),
                    ('{"mediaInfo": {"resolution": "3840x2160"}}'::jsonb, 'Bluray-2160p', 2160),
                    ('{}'::jsonb, 'HDTV-720p', 720),
                    ('{}'::jsonb, null, null)
                ) as v(payload, quality, expected)
                """
            )
        ).all()
        for res, expected in rows:
            assert res == expected
```

- [ ] **Step 2: Run migrations against the test DB, then run the test to verify it fails**

```bash
NEBULARR_TEST_DATABASE_URL=... python -m pytest tests/integration/test_automations_integration.py -q
```
Expected: `test_automation_tables_exist` FAILS with "app.automation missing" (the DB is on 0011). If the test DB has never had migrations applied, apply them first the same way `tests/integration/test_postgres_integration.py` does (read how it bootstraps — reuse that mechanism).

- [ ] **Step 3: Write the migration**

`alembic/versions/0012_automations.py`:

```python
"""automations engine: rule instances, run history, action ledger, resolution columns

Revision ID: 0012_automations
Revises: 0011_reporting_correctness
Create Date: 2026-07-30

* app.automation — one row per user automation (template instance): params jsonb,
  per-row cron/timezone, budget, cooldown, dry_run (defaults true so new rules
  simulate until the operator flips them live), state jsonb for watermarks.
* app.automation_run — run history in the app.mal_job_run mold, plus dry_run status
  and skip counters.
* app.automation_action_ledger — global (not per-automation) cooldown memory keyed
  (instance, entity, source_id, action): two rules matching the same movie must not
  double-search it inside the cooldown window. Also backs the daily search cap.
* warehouse.{movie_file,episode_file}.video_resolution — promoted from
  payload->mediaInfo so resolution floors are an indexed integer compare, backfilled
  from mediaInfo.resolution ("1920x1080") falling back to the quality name ("…-1080p").
"""

from collections.abc import Sequence
from typing import Union

from alembic import op

revision: str = "0012_automations"
down_revision: Union[str, None] = "0011_reporting_correctness"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        create table app.automation (
            id bigserial primary key,
            name text not null unique,
            template_key text not null,
            params jsonb not null default '{}'::jsonb,
            enabled boolean not null default false,
            dry_run boolean not null default true,
            cron text not null,
            timezone text not null default 'UTC',
            budget_per_run int not null default 10
                constraint automation_budget_check check (budget_per_run between 1 and 100),
            cooldown_days int not null default 7
                constraint automation_cooldown_check check (cooldown_days between 1 and 90),
            state jsonb not null default '{}'::jsonb,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
        )
        """
    )
    op.execute(
        """
        create table app.automation_run (
            id bigserial primary key,
            automation_id bigint not null references app.automation(id) on delete cascade,
            started_at timestamptz not null default now(),
            finished_at timestamptz,
            status text not null default 'running'
                constraint automation_run_status_check
                check (status in ('running', 'success', 'partial', 'failed', 'dry_run')),
            matched_count int not null default 0,
            actions_taken int not null default 0,
            skipped_cooldown int not null default 0,
            skipped_budget int not null default 0,
            details jsonb not null default '{}'::jsonb,
            error_message text
        )
        """
    )
    op.execute(
        "create index ix_automation_run_automation_started"
        " on app.automation_run (automation_id, started_at desc)"
    )
    op.execute(
        """
        create table app.automation_action_ledger (
            instance_name text not null,
            entity_type text not null
                constraint automation_ledger_entity_check
                check (entity_type in ('movie', 'series', 'episode')),
            source_id bigint not null,
            action_type text not null
                constraint automation_ledger_action_check
                check (action_type in ('search', 'tag', 'monitor')),
            last_fired_at timestamptz not null default now(),
            last_automation_id bigint,
            last_run_id bigint,
            primary key (instance_name, entity_type, source_id, action_type)
        )
        """
    )
    op.execute(
        "create index ix_automation_ledger_action_fired"
        " on app.automation_action_ledger (action_type, last_fired_at desc)"
    )

    op.execute("alter table warehouse.movie_file add column video_resolution int")
    op.execute("alter table warehouse.episode_file add column video_resolution int")
    for table in ("movie_file", "episode_file"):
        op.execute(
            f"""
            update warehouse.{table}
            set video_resolution = coalesce(
                substring(payload->'mediaInfo'->>'resolution' from 'x([0-9]{{3,4}})')::int,
                substring(coalesce(quality, '') from '([0-9]{{3,4}})[pi]')::int
            )
            where video_resolution is null
            """
        )
    op.execute(
        "create index ix_movie_file_video_resolution"
        " on warehouse.movie_file (video_resolution) where not deleted"
    )
    op.execute(
        "create index ix_episode_file_video_resolution"
        " on warehouse.episode_file (video_resolution) where not deleted"
    )


def downgrade() -> None:
    op.execute("drop index if exists warehouse.ix_episode_file_video_resolution")
    op.execute("drop index if exists warehouse.ix_movie_file_video_resolution")
    op.execute("alter table warehouse.episode_file drop column if exists video_resolution")
    op.execute("alter table warehouse.movie_file drop column if exists video_resolution")
    op.execute("drop table if exists app.automation_action_ledger")
    op.execute("drop table if exists app.automation_run")
    op.execute("drop table if exists app.automation")
```

Note the doubled braces `{{3,4}}` only inside the f-string loop; the non-f-string SQL uses single braces `{3,4}`.

- [ ] **Step 4: Apply migration and run the test to verify it passes**

```bash
NEBULARR_TEST_DATABASE_URL=... python -m pytest tests/integration/test_automations_integration.py -q
```
Expected: both tests PASS. Also run `python -m pytest tests/ -x -q` to confirm nothing else broke.

- [ ] **Step 5: Commit**

```bash
git add alembic/versions/0012_automations.py tests/integration/test_automations_integration.py
git commit -m "feat(db): automations tables, action ledger, video_resolution columns (0012)"
```

---

### Task 2: `video_resolution` in file upserts

**Files:**
- Modify: `src/arrsync/services/repository.py` (helpers around line 352, `upsert_episode_file` ~line 378, `upsert_movie_file` ~line 467)
- Test: `tests/test_automation_resolution.py` (create)

**Interfaces:**
- Produces: `repository._extract_video_resolution(row: dict[str, Any]) -> int | None`; both file upserts write column `video_resolution`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_automation_resolution.py`:

```python
from __future__ import annotations

from arrsync.services.repository import _extract_video_resolution


def test_resolution_from_media_info() -> None:
    assert _extract_video_resolution({"mediaInfo": {"resolution": "1920x1080"}}) == 1080
    assert _extract_video_resolution({"mediaInfo": {"resolution": "3840x2160"}}) == 2160


def test_resolution_falls_back_to_quality_name() -> None:
    row = {"mediaInfo": {}, "quality": {"quality": {"name": "WEBDL-720p"}}}
    assert _extract_video_resolution(row) == 720
    row = {"quality": {"quality": {"name": "HDTV-1080i"}}}
    assert _extract_video_resolution(row) == 1080


def test_resolution_none_when_unparseable() -> None:
    assert _extract_video_resolution({}) is None
    assert _extract_video_resolution({"mediaInfo": {"resolution": "widescreen"}, "quality": {"quality": {"name": "Unknown"}}}) is None
```

- [ ] **Step 2: Run to verify failure**

Run: `python -m pytest tests/test_automation_resolution.py -q`
Expected: FAIL with `ImportError: cannot import name '_extract_video_resolution'`

- [ ] **Step 3: Implement**

In `src/arrsync/services/repository.py`, next to `_extract_media_languages` (after line ~375), add (`import re` at top of file if absent):

```python
def _extract_video_resolution(row: dict[str, Any]) -> int | None:
    """Vertical resolution from mediaInfo.resolution ("1920x1080"), falling back
    to the Arr quality name ("WEBDL-1080p"). Mirrors the 0012 backfill SQL."""
    media_info = row.get("mediaInfo") or {}
    match = re.search(r"x(\d{3,4})\s*$", str(media_info.get("resolution") or ""))
    if match:
        return int(match.group(1))
    quality = ((row.get("quality") or {}).get("quality") or {}).get("name") or ""
    match = re.search(r"(\d{3,4})[pi]", str(quality))
    if match:
        return int(match.group(1))
    return None
```

Then wire into **both** `upsert_episode_file` and `upsert_movie_file`:
1. Add `video_resolution` to the insert column list and `:video_resolution` to values.
2. Add `video_resolution = excluded.video_resolution,` to the `do update set` list.
3. Add `"video_resolution": _extract_video_resolution(row),` to the params dict.

- [ ] **Step 4: Run tests**

Run: `python -m pytest tests/test_automation_resolution.py tests/test_repository_contract.py -q` (the contract test may assert on upsert SQL text — if it fails, update its expected SQL to include the new column; that is a deliberate contract change).
Then: `python -m pytest tests/ -x -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/arrsync/services/repository.py tests/test_automation_resolution.py tests/test_repository_contract.py
git commit -m "feat(sync): promote video_resolution into file upserts"
```

---
### Task 3: Rule schema, template registry, predicate compiler

**Files:**
- Create: `src/arrsync/services/automation_rules.py`
- Test: `tests/test_automation_rules.py` (create), extend `tests/integration/test_automations_integration.py`

**Interfaces:**
- Produces (consumed by Tasks 6, 8):
  - `RuleParams` (pydantic): `.scope: RuleScope`, `.require: RuleRequire`, `.actions: list[RuleAction]`, `.options: RuleOptions`
  - `validate_params(template_key: str, params: dict) -> RuleParams` — raises `ValueError` on unknown template or invalid params
  - `TEMPLATES: dict[str, AutomationTemplate]` — frozen dataclass `AutomationTemplate(key, title, description, default_cron, default_params: dict)`
  - `compile_candidates(params: RuleParams, entity: str, sense: str = "non_conforming") -> CompiledQuery` where `entity in ("movie", "episode")` and `CompiledQuery(select_sql, count_sql, count_all_sql, binds)`
  - Runtime binds the executor must supply on top of `CompiledQuery.binds`: `:instance_name`, `:cooldown_days`, `:limit`, and `:tag_ids` (list[int], only when `scope.tags_any` non-empty)

- [ ] **Step 1: Write the failing tests**

Create `tests/test_automation_rules.py`:

```python
from __future__ import annotations

import pytest

from arrsync.services.automation_rules import (
    TEMPLATES,
    CompiledQuery,
    RuleParams,
    compile_candidates,
    validate_params,
)


def _minimal(actions=None, **overrides):
    params = {
        "scope": {"media": "movies"},
        "require": {"resolution_min": 1080},
        "actions": actions or [{"type": "search_upgrade"}],
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
```

- [ ] **Step 2: Run to verify failure**

Run: `python -m pytest tests/test_automation_rules.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'arrsync.services.automation_rules'`

- [ ] **Step 3: Implement `automation_rules.py`**

```python
"""Rule schema + SQL predicate compiler for automations.

Whitelist-only: user params contribute bind VALUES, never SQL text — the same
invariant as reporting_registry ("no ad-hoc SQL from the browser"). Every
fragment below is a hardcoded string; pydantic validation rejects anything
outside the whitelisted fields/operators before compilation.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


class RuleScope(BaseModel):
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
    mal_dub_gate: bool = False
    new_dub_only: bool = False


class RuleParams(BaseModel):
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
            joins.append(
                "join mal.warehouse_link wl on wl.arr_entity = 'radarr_movie'"
                " and wl.instance_name = m.instance_name"
                " and wl.warehouse_source_id = m.source_id"
            )
            joins.append("join mal.anime ma on ma.mal_id = wl.mal_id")
            where.append("ma.dub_status in ('partial', 'dubbed')")
            select_cols += ", ma.dub_status, wl.mal_id"
        has_file = "coalesce((m.payload->>'hasFile')::boolean, false)"
        order = "order by lg.last_fired_at asc nulls first, m.source_id"
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
            joins.append(
                "join mal.warehouse_link wl on wl.arr_entity = 'sonarr_series'"
                " and wl.instance_name = s.instance_name"
                " and wl.warehouse_source_id = s.source_id"
            )
            joins.append("join mal.anime ma on ma.mal_id = wl.mal_id")
            where.append("ma.dub_status in ('partial', 'dubbed')")
            select_cols += ", ma.dub_status, wl.mal_id"
        has_file = "coalesce((e.payload->>'hasFile')::boolean, false)"
        order = "order by lg.last_fired_at asc nulls first, e.source_id"

    ledger_join = (
        f"left join app.automation_action_ledger lg on lg.instance_name = {item}.instance_name"
        f" and lg.entity_type = '{entity}' and lg.source_id = {item}.source_id"
        " and lg.action_type = 'search'"
    )
    joins.append(ledger_join)

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
            "(lg.last_fired_at is null or lg.last_fired_at <"
            " now() - make_interval(days => :cooldown_days))"
        )

    base = " ".join(joins) + " where " + " and ".join(where)
    base_with_cooldown = base + (f" and {cooldown_clause}" if cooldown_clause else "")
    select_sql = f"select {select_cols} {base_with_cooldown} {order} limit :limit"
    count_sql = f"select count(*) {base_with_cooldown}"
    count_all_sql = f"select count(*) {base}"
    return CompiledQuery(
        select_sql=select_sql, count_sql=count_sql, count_all_sql=count_all_sql, binds=binds
    )
```

- [ ] **Step 4: Run tests**

Run: `python -m pytest tests/test_automation_rules.py -q`
Expected: PASS. If a string-assert fails on spacing, fix the test to match the generated SQL exactly (assertions target substrings, so normalize by adjusting the fragment strings, not by weakening asserts to regex).

- [ ] **Step 5: Extend the integration test with real predicate execution**

Append to `tests/integration/test_automations_integration.py`:

```python
def test_movie_predicate_finds_missing_english_audio(engine) -> None:
    from arrsync.services.automation_rules import compile_candidates, validate_params

    params = validate_params(
        "custom",
        {
            "scope": {"media": "movies", "monitored_only": True},
            "require": {"audio_language_any": ["english", "eng"], "resolution_min": 1080},
            "actions": [{"type": "search_missing"}, {"type": "search_upgrade"}],
        },
    )
    compiled = compile_candidates(params, "movie")
    instance = "itest-automations"
    with engine.begin() as conn:
        conn.execute(text("delete from warehouse.movie_file where instance_name = :i"), {"i": instance})
        conn.execute(text("delete from warehouse.movie where instance_name = :i"), {"i": instance})
        conn.execute(text("delete from app.automation_action_ledger where instance_name = :i"), {"i": instance})
        conn.execute(
            text(
                """
                insert into warehouse.movie
                    (source_id, instance_name, title, monitored, payload, seen_at, last_seen_at, deleted)
                values
                    (1, :i, 'jpn-only 1080p', true, '{"hasFile": true}'::jsonb, now(), now(), false),
                    (2, :i, 'dual audio 1080p', true, '{"hasFile": true}'::jsonb, now(), now(), false),
                    (3, :i, 'missing entirely', true, '{"hasFile": false}'::jsonb, now(), now(), false),
                    (4, :i, 'eng but 720p', true, '{"hasFile": true}'::jsonb, now(), now(), false),
                    (5, :i, 'already 4k eng', true, '{"hasFile": true}'::jsonb, now(), now(), false),
                    (6, :i, 'unmonitored', false, '{"hasFile": false}'::jsonb, now(), now(), false)
                """
            ),
            {"i": instance},
        )
        conn.execute(
            text(
                """
                insert into warehouse.movie_file
                    (source_id, instance_name, movie_source_id, audio_languages, video_resolution,
                     payload, seen_at, last_seen_at, deleted)
                values
                    (101, :i, 1, array['japanese'], 1080, '{}'::jsonb, now(), now(), false),
                    (102, :i, 2, array['eng', 'jpn'], 1080, '{}'::jsonb, now(), now(), false),
                    (104, :i, 4, array['english'], 720, '{}'::jsonb, now(), now(), false),
                    (105, :i, 5, array['english'], 2160, '{}'::jsonb, now(), now(), false)
                """
            ),
            {"i": instance},
        )
    with engine.connect() as conn:
        rows = conn.execute(
            text(compiled.select_sql),
            {**compiled.binds, "instance_name": instance, "cooldown_days": 7, "limit": 50},
        ).mappings().all()
    got = {int(r["source_id"]) for r in rows}
    # 1 = has file but no english; 3 = missing; 4 = english but below floor.
    # 2 (dual audio ok) and 5 (4k, above floor) conform; 6 is unmonitored.
    assert got == {1, 3, 4}


def test_cooldown_ledger_excludes_recent(engine) -> None:
    from arrsync.services.automation_rules import compile_candidates, validate_params

    params = validate_params(
        "custom",
        {
            "scope": {"media": "movies", "monitored_only": True},
            "require": {"audio_language_any": ["english", "eng"]},
            "actions": [{"type": "search_missing"}],
        },
    )
    compiled = compile_candidates(params, "movie")
    instance = "itest-automations"
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                insert into app.automation_action_ledger
                    (instance_name, entity_type, source_id, action_type, last_fired_at)
                values (:i, 'movie', 3, 'search', now())
                on conflict (instance_name, entity_type, source_id, action_type)
                do update set last_fired_at = now()
                """
            ),
            {"i": instance},
        )
    with engine.connect() as conn:
        rows = conn.execute(
            text(compiled.select_sql),
            {**compiled.binds, "instance_name": instance, "cooldown_days": 7, "limit": 50},
        ).mappings().all()
    assert 3 not in {int(r["source_id"]) for r in rows}
```

Note: if the `warehouse.movie` / `warehouse.movie_file` insert column lists above don't match the real NOT NULL columns (check `alembic/versions/0001_initial.py:207` and `:228`), add the missing required columns with dummy values rather than relaxing the schema.

- [ ] **Step 6: Run integration tests**

Run: `NEBULARR_TEST_DATABASE_URL=... python -m pytest tests/integration/test_automations_integration.py -q`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/arrsync/services/automation_rules.py tests/test_automation_rules.py tests/integration/test_automations_integration.py
git commit -m "feat(automations): rule schema, template registry, SQL predicate compiler"
```

---
### Task 4: Automation store

**Files:**
- Create: `src/arrsync/services/automation_store.py`
- Test: `tests/test_automation_store.py` (create), modify `tests/fakes.py`

**Interfaces:**
- Produces (consumed by Tasks 6, 7, 8) — all take `session` first, mirroring `repository.py`:
  - `list_automations(session) -> list[dict]` (includes `last_run_*` fields via lateral join)
  - `get_automation(session, automation_id: int) -> dict | None`
  - `create_automation(session, *, name, template_key, params: dict, cron, timezone, enabled, dry_run, budget_per_run, cooldown_days) -> int`
  - `update_automation(session, automation_id: int, fields: dict) -> bool` (whitelisted keys only)
  - `delete_automation(session, automation_id: int) -> bool`
  - `set_automation_state(session, automation_id: int, state: dict) -> None`
  - `read_enabled_automation_schedules(session) -> list[dict]` (`id`, `cron`, `timezone`)
  - `insert_automation_run(session, automation_id: int) -> int`
  - `finish_automation_run(session, run_id, status, *, matched_count, actions_taken, skipped_cooldown, skipped_budget, details, error_message=None) -> None`
  - `list_automation_runs(session, automation_id: int, limit: int = 20) -> list[dict]`
  - `get_automation_run(session, run_id: int) -> dict | None`
  - `upsert_action_ledger(session, *, instance_name, entity_type, source_id, action_type, automation_id, run_id) -> None`
  - `count_recent_searches(session, hours: int = 24) -> int`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_automation_store.py`. Test via a FakeSession subclass that records statements and returns canned rows (pattern: `tests/test_scheduler.py` `ScheduleFakeSession`):

```python
from __future__ import annotations

import json
from typing import Any

from arrsync.services import automation_store
from fakes import FakeResult, FakeSession


class AutomationFakeSession(FakeSession):
    def __init__(self, rows: list[Any] | None = None, scalar: Any = None) -> None:
        super().__init__()
        self.rows = rows or []
        self.scalar = scalar

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> FakeResult:
        sql = " ".join(str(query).lower().split())
        if "app.automation" in sql or "app.automation_run" in sql or "app.automation_action_ledger" in sql:
            self.statements.append((sql, params))
            return FakeResult(scalar_value=self.scalar, rows=self.rows)
        return super().execute(query, params)


def test_create_automation_serializes_params_and_returns_id() -> None:
    session = AutomationFakeSession(scalar=7)
    new_id = automation_store.create_automation(
        session,
        name="dub hunt",
        template_key="anime-dub-enforcer",
        params={"scope": {"media": "both"}},
        cron="0 6 */2 * *",
        timezone="UTC",
        enabled=False,
        dry_run=True,
        budget_per_run=10,
        cooldown_days=7,
    )
    assert new_id == 7
    sql, params = session.statements[-1]
    assert "insert into app.automation" in sql
    assert json.loads(params["params"]) == {"scope": {"media": "both"}}
    assert params["dry_run"] is True


def test_update_automation_only_touches_whitelisted_fields() -> None:
    session = AutomationFakeSession(rows=[(1,)])
    ok = automation_store.update_automation(
        session, 3, {"cron": "0 4 * * *", "enabled": True, "nope": "ignored"}
    )
    assert ok
    sql, params = session.statements[-1]
    assert "cron = :cron" in sql
    assert "enabled = :enabled" in sql
    assert "nope" not in sql
    assert "updated_at = now()" in sql


def test_update_automation_rejects_empty_fields() -> None:
    session = AutomationFakeSession()
    assert automation_store.update_automation(session, 3, {"nope": 1}) is False
    assert session.statements == []


def test_finish_automation_run_writes_counters() -> None:
    session = AutomationFakeSession()
    automation_store.finish_automation_run(
        session,
        11,
        "dry_run",
        matched_count=5,
        actions_taken=0,
        skipped_cooldown=2,
        skipped_budget=1,
        details={"instances": {}},
    )
    sql, params = session.statements[-1]
    assert "update app.automation_run" in sql
    assert params["status"] == "dry_run"
    assert params["skipped_cooldown"] == 2
    assert json.loads(params["details"]) == {"instances": {}}


def test_upsert_action_ledger_conflict_updates_fired_at() -> None:
    session = AutomationFakeSession()
    automation_store.upsert_action_ledger(
        session,
        instance_name="default",
        entity_type="movie",
        source_id=42,
        action_type="search",
        automation_id=3,
        run_id=11,
    )
    sql, _params = session.statements[-1]
    assert "on conflict (instance_name, entity_type, source_id, action_type)" in sql
    assert "last_fired_at = now()" in sql


def test_count_recent_searches_uses_window() -> None:
    session = AutomationFakeSession(scalar=13)
    assert automation_store.count_recent_searches(session) == 13
    sql, params = session.statements[-1]
    assert "action_type = 'search'" in sql
    assert params["hours"] == 24
```

- [ ] **Step 2: Run to verify failure**

Run: `python -m pytest tests/test_automation_store.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'arrsync.services.automation_store'`

- [ ] **Step 3: Implement `automation_store.py`**

```python
"""Raw-SQL persistence for automations: rule rows, run history, action ledger.

Same conventions as services/repository.py — parameterized sqlalchemy.text(),
session passed in, JSON serialized with default=str.
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

_AUTOMATION_COLUMNS = (
    "id, name, template_key, params, enabled, dry_run, cron, timezone,"
    " budget_per_run, cooldown_days, state, created_at, updated_at"
)

_UPDATABLE_FIELDS = frozenset(
    {
        "name",
        "template_key",
        "params",
        "enabled",
        "dry_run",
        "cron",
        "timezone",
        "budget_per_run",
        "cooldown_days",
    }
)


def _row_to_dict(row: Any) -> dict[str, Any]:
    out = dict(row)
    for key in ("params", "state", "details"):
        value = out.get(key)
        if isinstance(value, str):
            try:
                out[key] = json.loads(value)
            except json.JSONDecodeError:
                out[key] = {}
    return out


def list_automations(session: Session) -> list[dict[str, Any]]:
    rows = session.execute(
        text(
            f"""
            select {', '.join('a.' + c.strip() for c in _AUTOMATION_COLUMNS.split(','))},
                   r.id as last_run_id, r.status as last_run_status,
                   r.started_at as last_run_started_at,
                   r.matched_count as last_run_matched,
                   r.actions_taken as last_run_actions
            from app.automation a
            left join lateral (
                select id, status, started_at, matched_count, actions_taken
                from app.automation_run
                where automation_id = a.id
                order by started_at desc
                limit 1
            ) r on true
            order by a.name
            """
        )
    ).mappings()
    return [_row_to_dict(r) for r in rows]


def get_automation(session: Session, automation_id: int) -> dict[str, Any] | None:
    # list()-based fetch instead of .mappings().first(): tests/fakes.py FakeResult
    # returns a plain list from mappings(), which has no .first().
    rows = list(
        session.execute(
            text(f"select {_AUTOMATION_COLUMNS} from app.automation where id = :id"),
            {"id": automation_id},
        ).mappings()
    )
    return _row_to_dict(rows[0]) if rows else None


def create_automation(
    session: Session,
    *,
    name: str,
    template_key: str,
    params: dict[str, Any],
    cron: str,
    timezone: str,
    enabled: bool,
    dry_run: bool,
    budget_per_run: int,
    cooldown_days: int,
) -> int:
    row = session.execute(
        text(
            """
            insert into app.automation
                (name, template_key, params, enabled, dry_run, cron, timezone,
                 budget_per_run, cooldown_days)
            values
                (:name, :template_key, cast(:params as jsonb), :enabled, :dry_run,
                 :cron, :timezone, :budget_per_run, :cooldown_days)
            returning id
            """
        ),
        {
            "name": name,
            "template_key": template_key,
            "params": json.dumps(params, default=str),
            "enabled": enabled,
            "dry_run": dry_run,
            "cron": cron,
            "timezone": timezone,
            "budget_per_run": budget_per_run,
            "cooldown_days": cooldown_days,
        },
    ).scalar_one()
    return int(row)


def update_automation(session: Session, automation_id: int, fields: dict[str, Any]) -> bool:
    updates = {k: v for k, v in fields.items() if k in _UPDATABLE_FIELDS}
    if not updates:
        return False
    if "params" in updates:
        updates["params"] = json.dumps(updates["params"], default=str)
    assignments = ", ".join(
        f"{key} = cast(:{key} as jsonb)" if key == "params" else f"{key} = :{key}"
        for key in sorted(updates)
    )
    result = session.execute(
        text(
            f"update app.automation set {assignments}, updated_at = now()"
            " where id = :automation_id returning id"
        ),
        {**updates, "automation_id": automation_id},
    )
    return result.first() is not None


def delete_automation(session: Session, automation_id: int) -> bool:
    result = session.execute(
        text("delete from app.automation where id = :id returning id"),
        {"id": automation_id},
    )
    return result.first() is not None


def set_automation_state(session: Session, automation_id: int, state: dict[str, Any]) -> None:
    session.execute(
        text(
            "update app.automation set state = cast(:state as jsonb), updated_at = now()"
            " where id = :id"
        ),
        {"id": automation_id, "state": json.dumps(state, default=str)},
    )


def read_enabled_automation_schedules(session: Session) -> list[dict[str, Any]]:
    rows = session.execute(
        text("select id, cron, timezone from app.automation where enabled = true order by id")
    ).mappings()
    return [dict(r) for r in rows]


def insert_automation_run(session: Session, automation_id: int) -> int:
    row = session.execute(
        text(
            """
            insert into app.automation_run (automation_id, status, started_at, details)
            values (:automation_id, 'running', now(), '{}'::jsonb)
            returning id
            """
        ),
        {"automation_id": automation_id},
    ).scalar_one()
    return int(row)


def finish_automation_run(
    session: Session,
    run_id: int,
    status: str,
    *,
    matched_count: int,
    actions_taken: int,
    skipped_cooldown: int,
    skipped_budget: int,
    details: dict[str, Any],
    error_message: str | None = None,
) -> None:
    session.execute(
        text(
            """
            update app.automation_run
            set status = :status,
                finished_at = now(),
                matched_count = :matched_count,
                actions_taken = :actions_taken,
                skipped_cooldown = :skipped_cooldown,
                skipped_budget = :skipped_budget,
                details = cast(:details as jsonb),
                error_message = :error_message
            where id = :run_id
            """
        ),
        {
            "run_id": run_id,
            "status": status,
            "matched_count": matched_count,
            "actions_taken": actions_taken,
            "skipped_cooldown": skipped_cooldown,
            "skipped_budget": skipped_budget,
            "details": json.dumps(details, default=str),
            "error_message": error_message,
        },
    )


def list_automation_runs(
    session: Session, automation_id: int, limit: int = 20
) -> list[dict[str, Any]]:
    rows = session.execute(
        text(
            """
            select id, automation_id, started_at, finished_at, status,
                   matched_count, actions_taken, skipped_cooldown, skipped_budget,
                   error_message
            from app.automation_run
            where automation_id = :automation_id
            order by started_at desc
            limit :limit
            """
        ),
        {"automation_id": automation_id, "limit": max(1, min(int(limit), 100))},
    ).mappings()
    return [dict(r) for r in rows]


def get_automation_run(session: Session, run_id: int) -> dict[str, Any] | None:
    rows = list(
        session.execute(
            text(
                """
                select id, automation_id, started_at, finished_at, status,
                       matched_count, actions_taken, skipped_cooldown, skipped_budget,
                       details, error_message
                from app.automation_run
                where id = :run_id
                """
            ),
            {"run_id": run_id},
        ).mappings()
    )
    return _row_to_dict(rows[0]) if rows else None


def upsert_action_ledger(
    session: Session,
    *,
    instance_name: str,
    entity_type: str,
    source_id: int,
    action_type: str,
    automation_id: int,
    run_id: int,
) -> None:
    session.execute(
        text(
            """
            insert into app.automation_action_ledger
                (instance_name, entity_type, source_id, action_type,
                 last_fired_at, last_automation_id, last_run_id)
            values
                (:instance_name, :entity_type, :source_id, :action_type,
                 now(), :automation_id, :run_id)
            on conflict (instance_name, entity_type, source_id, action_type)
            do update set
                last_fired_at = now(),
                last_automation_id = excluded.last_automation_id,
                last_run_id = excluded.last_run_id
            """
        ),
        {
            "instance_name": instance_name,
            "entity_type": entity_type,
            "source_id": source_id,
            "action_type": action_type,
            "automation_id": automation_id,
            "run_id": run_id,
        },
    )


def count_recent_searches(session: Session, hours: int = 24) -> int:
    row = session.execute(
        text(
            """
            select count(*) from app.automation_action_ledger
            where action_type = 'search'
              and last_fired_at >= now() - make_interval(hours => :hours)
            """
        ),
        {"hours": hours},
    ).scalar_one()
    return int(row)
```

- [ ] **Step 4: Run tests**

Run: `python -m pytest tests/test_automation_store.py -q` then `python -m pytest tests/ -x -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/arrsync/services/automation_store.py tests/test_automation_store.py
git commit -m "feat(automations): automation/run/ledger store"
```

---

### Task 5: ArrClient search commands, monitored editors, profile reads, throttle

**Files:**
- Modify: `src/arrsync/services/arr_client.py` (append after `update_movie_tags`, ~line 414), `src/arrsync/config.py` (after line 116), `tests/fakes.py` `FakeSettings`
- Test: `tests/test_arr_client_commands.py` (create)

**Interfaces:**
- Produces (consumed by Task 6):
  - `ArrClient.search_movies(movie_ids: list[int]) -> None` (radarr; POST `/api/v3/command` `{"name": "MoviesSearch", "movieIds": [...]}` in chunks of `COMMAND_SEARCH_CHUNK = 10`, throttled)
  - `ArrClient.search_episodes(episode_ids: list[int]) -> None` (sonarr; `{"name": "EpisodeSearch", "episodeIds": [...]}`)
  - `ArrClient.update_series_monitored(series_ids: list[int], monitored: bool) -> None` / `update_movies_monitored(movie_ids: list[int], monitored: bool) -> None` (PUT `…/editor`, chunk 100)
  - `ArrClient.list_quality_profiles() -> list[dict]` / `list_custom_formats() -> list[dict]`
  - `Settings.automation_command_min_interval_seconds: float = 2.0`, `Settings.automation_max_searches_per_day: int = 100`

- [ ] **Step 1: Add the settings knobs (no test — pydantic defaults)**

In `src/arrsync/config.py` after the coverage-tag block (line ~116):

```python
    automation_command_min_interval_seconds: float = 2.0
    automation_max_searches_per_day: int = 100
```

In `tests/fakes.py` `FakeSettings`, add the same two fields plus the three HTTP fields ArrClient reads (skip any that already exist — check first):

```python
    automation_command_min_interval_seconds: float = 0.0  # no sleeps in tests
    automation_max_searches_per_day: int = 100
    http_timeout_seconds: float = 5.0
    http_retry_attempts: int = 1
    http_max_parallel_requests: int = 4
    sonarr_base_url: str = "http://sonarr:8989"
    sonarr_api_key: str = "k"
    radarr_base_url: str = "http://radarr:7878"
    radarr_api_key: str = "k"
```

- [ ] **Step 2: Write the failing tests**

Create `tests/test_arr_client_commands.py` (monkeypatch `_request` — same style as existing `tests/test_arr_client.py`, read it first and mirror its helpers if it already has a capture pattern):

```python
from __future__ import annotations

from typing import Any

import pytest

from arrsync.services.arr_client import ArrClient
from fakes import FakeSettings


def _client(source: str) -> tuple[ArrClient, list[tuple[str, str, dict | None]]]:
    client = ArrClient(FakeSettings(), source)  # type: ignore[arg-type]
    calls: list[tuple[str, str, dict | None]] = []

    async def fake_request(method: str, path: str, params: dict | None = None, json: dict | None = None) -> Any:
        calls.append((method, path, json))
        return {}

    client._request = fake_request  # type: ignore[method-assign]
    return client, calls


@pytest.mark.asyncio
async def test_search_movies_chunks_and_posts_command() -> None:
    client, calls = _client("radarr")
    await client.search_movies(list(range(1, 26)))  # 25 ids -> 3 chunks of 10/10/5
    assert [c[1] for c in calls] == ["/api/v3/command"] * 3
    assert calls[0][2] == {"name": "MoviesSearch", "movieIds": list(range(1, 11))}
    assert calls[2][2] == {"name": "MoviesSearch", "movieIds": [21, 22, 23, 24, 25]}


@pytest.mark.asyncio
async def test_search_movies_requires_radarr() -> None:
    client, _ = _client("sonarr")
    with pytest.raises(RuntimeError, match="radarr"):
        await client.search_movies([1])


@pytest.mark.asyncio
async def test_search_episodes_posts_episode_search() -> None:
    client, calls = _client("sonarr")
    await client.search_episodes([7, 8])
    assert calls == [("POST", "/api/v3/command", {"name": "EpisodeSearch", "episodeIds": [7, 8]})]


@pytest.mark.asyncio
async def test_search_with_empty_ids_is_a_noop() -> None:
    client, calls = _client("radarr")
    await client.search_movies([])
    assert calls == []


@pytest.mark.asyncio
async def test_update_movies_monitored_uses_editor() -> None:
    client, calls = _client("radarr")
    await client.update_movies_monitored([5, 6], False)
    assert calls == [
        ("PUT", "/api/v3/movie/editor", {"movieIds": [5, 6], "monitored": False}),
    ]


@pytest.mark.asyncio
async def test_update_series_monitored_uses_editor() -> None:
    client, calls = _client("sonarr")
    await client.update_series_monitored([9], True)
    assert calls == [
        ("PUT", "/api/v3/series/editor", {"seriesIds": [9], "monitored": True}),
    ]


@pytest.mark.asyncio
async def test_profile_reads() -> None:
    client, calls = _client("radarr")
    await client.list_quality_profiles()
    await client.list_custom_formats()
    assert [c[1] for c in calls] == ["/api/v3/qualityprofile", "/api/v3/customformat"]
```

- [ ] **Step 3: Run to verify failure**

Run: `python -m pytest tests/test_arr_client_commands.py -q`
Expected: FAIL with `AttributeError: 'ArrClient' object has no attribute 'search_movies'`

- [ ] **Step 4: Implement**

In `ArrClient.__init__` (after the semaphore, line ~84) add:

```python
        self._command_lock = asyncio.Lock()
        self._last_command_at = 0.0
```

Append after `update_movie_tags` (~line 414):

```python
    COMMAND_SEARCH_CHUNK = 10

    async def _throttle_commands(self) -> None:
        """Min-interval gate between /command posts (MalApiClient._throttle pattern)
        so automation runs can never machine-gun the Arr command queue."""
        interval = getattr(self.settings, "automation_command_min_interval_seconds", 0.0)
        async with self._command_lock:
            loop = asyncio.get_running_loop()
            wait = self._last_command_at + interval - loop.time()
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_command_at = loop.time()

    async def _post_command(self, body: dict[str, Any]) -> None:
        await self._throttle_commands()
        await self._request("POST", "/api/v3/command", json=body)

    async def search_movies(self, movie_ids: list[int]) -> None:
        if self.source != "radarr":
            raise RuntimeError("search_movies requires radarr client")
        for start in range(0, len(movie_ids), self.COMMAND_SEARCH_CHUNK):
            chunk = movie_ids[start : start + self.COMMAND_SEARCH_CHUNK]
            await self._post_command({"name": "MoviesSearch", "movieIds": chunk})

    async def search_episodes(self, episode_ids: list[int]) -> None:
        if self.source != "sonarr":
            raise RuntimeError("search_episodes requires sonarr client")
        for start in range(0, len(episode_ids), self.COMMAND_SEARCH_CHUNK):
            chunk = episode_ids[start : start + self.COMMAND_SEARCH_CHUNK]
            await self._post_command({"name": "EpisodeSearch", "episodeIds": chunk})

    async def update_series_monitored(self, series_ids: list[int], monitored: bool) -> None:
        if self.source != "sonarr":
            raise RuntimeError("update_series_monitored requires sonarr client")
        for start in range(0, len(series_ids), self.TAG_EDITOR_CHUNK):
            chunk = series_ids[start : start + self.TAG_EDITOR_CHUNK]
            await self._request(
                "PUT", "/api/v3/series/editor", json={"seriesIds": chunk, "monitored": monitored}
            )

    async def update_movies_monitored(self, movie_ids: list[int], monitored: bool) -> None:
        if self.source != "radarr":
            raise RuntimeError("update_movies_monitored requires radarr client")
        for start in range(0, len(movie_ids), self.TAG_EDITOR_CHUNK):
            chunk = movie_ids[start : start + self.TAG_EDITOR_CHUNK]
            await self._request(
                "PUT", "/api/v3/movie/editor", json={"movieIds": chunk, "monitored": monitored}
            )

    async def list_quality_profiles(self) -> list[dict[str, Any]]:
        payload = await self._request("GET", "/api/v3/qualityprofile")
        return payload if isinstance(payload, list) else []

    async def list_custom_formats(self) -> list[dict[str, Any]]:
        payload = await self._request("GET", "/api/v3/customformat")
        return payload if isinstance(payload, list) else []
```

- [ ] **Step 5: Run tests**

Run: `python -m pytest tests/test_arr_client_commands.py tests/test_arr_client.py tests/test_arr_client_contract.py -q` then full `python -m pytest tests/ -x -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/arrsync/services/arr_client.py src/arrsync/config.py tests/fakes.py tests/test_arr_client_commands.py
git commit -m "feat(arr): search commands, monitored editors, profile reads, command throttle"
```

---
### Task 6: AutomationService executor

**Files:**
- Create: `src/arrsync/services/automation_service.py`
- Test: `tests/test_automation_service.py` (create)

**Interfaces:**
- Consumes: `automation_store.*` (Task 4), `compile_candidates`/`validate_params` (Task 3), `ArrClient.search_movies/search_episodes/update_*_monitored/list_tags/ensure_tag_id/update_*_tags/list_custom_formats` (Task 5), `repo.try_job_lock/release_job_lock/list_enabled_integrations`, `EventBus.publish`.
- Produces (consumed by Tasks 7, 8): `AutomationService(settings, session_factory, *, arr_client_class=ArrClient, event_bus=None)` with `async run(automation_id: int, *, reason: str = "cron") -> dict[str, Any]` returning `{"status": "success" | "partial" | "failed" | "dry_run" | "not_found" | "invalid_params" | "already_running", ...}`.

Semantics locked by the spec:
- Budget (`budget_per_run`) and the global daily cap apply to **search** actions only; tag/monitor reconciles are cheap idempotent bulk-editor calls, uncapped but diffed against live Arr state so nothing is re-applied.
- Ledger rows are written only for `action_type='search'` in v1 (tag/monitor are diffed, not cooled down); the ledger CHECK still allows all three for later.
- A tag label used by an automation is owned by it: the reconcile adds it to matched items and removes it from every live item not currently matched.
- For episode-entity rules, tag and `set_monitored` actions apply at the **series** level (distinct `series_source_id` of matched episodes).

- [ ] **Step 1: Write the failing tests**

Create `tests/test_automation_service.py`:

```python
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
```

- [ ] **Step 2: Run to verify failure**

Run: `python -m pytest tests/test_automation_service.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'arrsync.services.automation_service'`

- [ ] **Step 3: Implement `automation_service.py`**

```python
"""Automation run executor.

Skeleton mirrors CoverageTagSyncService: sync DB work in worker threads, per-phase
error collection, run-row bookkeeping, and diffing against LIVE Arr state before
any mutation (a stale warehouse snapshot must never drive a write).
"""

from __future__ import annotations

import asyncio
import logging
import re
import uuid
from typing import Any

from sqlalchemy import text

from arrsync.config import Settings
from arrsync.db import session_scope
from arrsync.services import automation_store
from arrsync.services import repository as repo
from arrsync.services.arr_client import ArrClient
from arrsync.services.automation_rules import RuleParams, compile_candidates, validate_params

log = logging.getLogger(__name__)


def _profile_language_warning(custom_formats: list[dict[str, Any]]) -> str | None:
    """None when some custom format appears to score language/dub attributes;
    otherwise a human-readable warning for the run details / UI."""
    for cf in custom_formats:
        if re.search(r"dub|language|english", str(cf.get("name", "")), re.IGNORECASE):
            return None
        for spec in cf.get("specifications") or []:
            if "language" in str(spec.get("implementation", "")).lower():
                return None
    return (
        "no custom format references language/dub — searches will fire, but this "
        "instance's quality profiles may grab non-dub releases"
    )


def _select_rows(session: Any, sql: str, binds: dict[str, Any]) -> list[dict[str, Any]]:
    return [dict(r) for r in session.execute(text(sql), binds).mappings()]


def _count_rows(session: Any, sql: str, binds: dict[str, Any]) -> int:
    return int(session.execute(text(sql), binds).scalar_one())


class AutomationService:
    SEARCHLESS_LIMIT = 10_000  # candidate cap for tag/monitor-only rules

    def __init__(
        self,
        settings: Settings,
        session_factory: Any,
        *,
        arr_client_class: type[ArrClient] = ArrClient,
        event_bus: Any | None = None,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.arr_client_class = arr_client_class
        self.event_bus = event_bus

    async def _run_db(self, fn: Any, /, *args: Any, **kwargs: Any) -> Any:
        def _call() -> Any:
            with session_scope(self.session_factory) as session:
                return fn(session, *args, **kwargs)

        return await asyncio.to_thread(_call)

    @staticmethod
    def _targets(params: RuleParams) -> list[tuple[str, str]]:
        targets: list[tuple[str, str]] = []
        if params.scope.media in ("movies", "both"):
            targets.append(("radarr", "movie"))
        if params.scope.media in ("series", "both"):
            targets.append(("sonarr", "episode"))
        return targets

    async def run(self, automation_id: int, *, reason: str = "cron") -> dict[str, Any]:
        automation = await self._run_db(automation_store.get_automation, automation_id)
        if automation is None:
            return {"status": "not_found"}
        try:
            params = validate_params(str(automation["template_key"]), automation["params"] or {})
        except ValueError as exc:
            log.warning("automation %s has invalid params: %s", automation_id, exc)
            return {"status": "invalid_params", "error": str(exc)}
        owner = f"automation-{uuid.uuid4().hex[:12]}"
        lock_name = f"automation:{automation_id}"
        if not await self._run_db(repo.try_job_lock, lock_name, owner):
            return {"status": "already_running"}
        run_id = await self._run_db(automation_store.insert_automation_run, automation_id)
        dry_run = bool(automation["dry_run"])
        details: dict[str, Any] = {"reason": reason, "dry_run": dry_run, "instances": {}, "errors": []}
        counters = {"matched": 0, "actions": 0, "skipped_cooldown": 0, "skipped_budget": 0}
        status = "failed"
        try:
            has_search = any(a.type.startswith("search_") for a in params.actions)
            search_budget = int(automation["budget_per_run"])
            if has_search:
                used = await self._run_db(automation_store.count_recent_searches)
                cap_left = max(0, int(self.settings.automation_max_searches_per_day) - used)
                if cap_left < search_budget:
                    details["daily_cap_clamped"] = True
                search_budget = min(search_budget, cap_left)
            instances_processed = 0
            for source, entity in self._targets(params):
                integrations = await self._run_db(repo.list_enabled_integrations, source)
                for inst in integrations:
                    name = str(inst["name"])
                    if params.scope.instances and name not in params.scope.instances:
                        continue
                    instances_processed += await self._run_instance(
                        automation=automation,
                        params=params,
                        source=source,
                        entity=entity,
                        instance=inst,
                        run_id=run_id,
                        search_budget=search_budget,
                        dry_run=dry_run,
                        details=details,
                        counters=counters,
                    )
            if params.options.new_dub_only and not dry_run:
                await self._run_db(
                    automation_store.set_automation_state,
                    automation_id,
                    {"dub_status_seen": details.get("dub_status_seen", {})},
                )
            if dry_run:
                status = "dry_run"
            elif details["errors"] and instances_processed == 0:
                status = "failed"
            elif details["errors"] or counters["skipped_budget"]:
                status = "partial"
            else:
                status = "success"
        except Exception as exc:
            details["errors"].append({"phase": "run", "error": str(exc)})
            log.exception("automation run failed", extra={"automation_id": automation_id})
        finally:
            error_message = "; ".join(e.get("error", "") for e in details["errors"])[:500] or None
            await self._run_db(
                automation_store.finish_automation_run,
                run_id,
                status,
                matched_count=counters["matched"],
                actions_taken=counters["actions"],
                skipped_cooldown=counters["skipped_cooldown"],
                skipped_budget=counters["skipped_budget"],
                details=details,
                error_message=error_message,
            )
            await self._run_db(repo.release_job_lock, lock_name, owner)
            if self.event_bus is not None:
                self.event_bus.publish(
                    "automation_run",
                    {"automation_id": automation_id, "run_id": run_id, "status": status},
                )
        return {"status": status, "run_id": run_id, **counters}

    async def _run_instance(
        self,
        *,
        automation: dict[str, Any],
        params: RuleParams,
        source: str,
        entity: str,
        instance: dict[str, Any],
        run_id: int,
        search_budget: int,
        dry_run: bool,
        details: dict[str, Any],
        counters: dict[str, int],
    ) -> int:
        name = str(instance["name"])
        inst_details: dict[str, Any] = {"matched": 0}
        details["instances"].setdefault(name, {})[entity] = inst_details
        client = self.arr_client_class(
            self.settings,
            source,
            instance_name=name,
            base_url=str(instance["base_url"]),
            api_key=str(instance["api_key"]),
        )
        try:
            tag_ids: list[int] | None = None
            if params.scope.tags_any:
                try:
                    tags = await client.list_tags()
                except Exception as exc:
                    details["errors"].append({"instance": name, "phase": "list_tags", "error": str(exc)})
                    return 0
                by_label = {
                    str(t.get("label", "")).strip().casefold(): int(t["id"])
                    for t in tags
                    if t.get("id") is not None
                }
                tag_ids = [
                    by_label[label.strip().casefold()]
                    for label in params.scope.tags_any
                    if label.strip().casefold() in by_label
                ] or [-1]  # unmatched labels match nothing

            has_search = any(a.type.startswith("search_") for a in params.actions)
            limit = search_budget if has_search else self.SEARCHLESS_LIMIT
            compiled = compile_candidates(params, entity)
            runtime: dict[str, Any] = {
                "instance_name": name,
                "cooldown_days": int(automation["cooldown_days"]),
                "limit": max(0, limit),
            }
            if tag_ids is not None:
                runtime["tag_ids"] = tag_ids
            count_binds = {k: v for k, v in {**compiled.binds, **runtime}.items() if k != "limit"}
            eligible = await self._run_db(_count_rows, compiled.count_sql, count_binds)
            eligible_all = await self._run_db(
                _count_rows,
                compiled.count_all_sql,
                {k: v for k, v in count_binds.items() if k != "cooldown_days"},
            )
            candidates = await self._run_db(
                _select_rows, compiled.select_sql, {**compiled.binds, **runtime}
            )
            if params.options.new_dub_only:
                seen = (automation.get("state") or {}).get("dub_status_seen", {})
                current = details.setdefault("dub_status_seen", {})
                fresh = []
                for row in candidates:
                    mal_id = str(row.get("mal_id"))
                    now_status = str(row.get("dub_status") or "")
                    current[mal_id] = now_status
                    if seen.get(mal_id) in (None, "none") and now_status in ("partial", "dubbed"):
                        fresh.append(row)
                candidates = fresh
            counters["matched"] += len(candidates)
            counters["skipped_cooldown"] += max(0, eligible_all - eligible)
            if has_search:
                counters["skipped_budget"] += max(0, eligible - len(candidates))
            inst_details["matched"] = len(candidates)

            if has_search and params.require.audio_language_any and not dry_run:
                try:
                    warning = _profile_language_warning(await client.list_custom_formats())
                    if warning:
                        inst_details["profile_warning"] = warning
                except Exception:
                    log.debug("custom format probe failed", exc_info=True)

            if dry_run:
                inst_details["would_do"] = [
                    {
                        "source_id": int(r["source_id"]),
                        "title": str(r.get("series_title") or r.get("title") or ""),
                        "actions": sorted({a.type for a in params.actions if a.when == "non_conforming"}),
                    }
                    for r in candidates
                ]
                return 1

            item_ids = [int(r["source_id"]) for r in candidates]
            if has_search and item_ids:
                if entity == "movie":
                    await client.search_movies(item_ids)
                else:
                    await client.search_episodes(item_ids)

                def _write_ledger(session: Any) -> None:
                    for source_id in item_ids:
                        automation_store.upsert_action_ledger(
                            session,
                            instance_name=name,
                            entity_type=entity,
                            source_id=source_id,
                            action_type="search",
                            automation_id=int(automation["id"]),
                            run_id=run_id,
                        )

                await self._run_db(_write_ledger)
                counters["actions"] += len(item_ids)
                inst_details["searched"] = len(item_ids)

            await self._apply_tag_actions(
                client=client, params=params, entity=entity, candidates=candidates,
                counters=counters, inst_details=inst_details,
            )
            await self._apply_monitored_actions(
                client=client, params=params, entity=entity, candidates=candidates,
                runtime=runtime, counters=counters, inst_details=inst_details,
            )
            return 1
        except Exception as exc:
            details["errors"].append(
                {"instance": name, "entity": entity, "phase": "instance", "error": str(exc)}
            )
            log.warning("automation instance failed instance=%s: %s", name, exc)
            return 0
        finally:
            await client.aclose()

    @staticmethod
    def _target_ids(entity: str, candidates: list[dict[str, Any]]) -> set[int]:
        """Item ids for movie rules; owning-series ids for episode rules."""
        if entity == "movie":
            return {int(r["source_id"]) for r in candidates}
        return {int(r["series_source_id"]) for r in candidates}

    async def _apply_tag_actions(
        self, *, client: Any, params: RuleParams, entity: str,
        candidates: list[dict[str, Any]], counters: dict[str, int], inst_details: dict[str, Any],
    ) -> None:
        tag_actions = [a for a in params.actions if a.type == "tag" and a.when == "non_conforming"]
        if not tag_actions:
            return
        desired_ids = self._target_ids(entity, candidates)
        live_rows = await (client.list_movies() if entity == "movie" else client.list_series())
        for action in tag_actions:
            tag_id = await client.ensure_tag_id(action.label or "")
            add: list[int] = []
            remove: list[int] = []
            for row in live_rows:
                raw_id = row.get("id")
                if raw_id is None:
                    continue
                rid = int(raw_id)
                tags = {int(t) for t in (row.get("tags") or []) if t is not None}
                if rid in desired_ids and tag_id not in tags:
                    add.append(rid)
                elif rid not in desired_ids and tag_id in tags:
                    remove.append(rid)
            for ids, op in ((add, "add"), (remove, "remove")):
                if not ids:
                    continue
                if entity == "movie":
                    await client.update_movie_tags(ids, [tag_id], op)
                else:
                    await client.update_series_tags(ids, [tag_id], op)
            counters["actions"] += len(add) + len(remove)
            inst_details[f"tag:{action.label}"] = {"added": len(add), "removed": len(remove)}

    async def _apply_monitored_actions(
        self, *, client: Any, params: RuleParams, entity: str,
        candidates: list[dict[str, Any]], runtime: dict[str, Any],
        counters: dict[str, int], inst_details: dict[str, Any],
    ) -> None:
        monitored_actions = [a for a in params.actions if a.type == "set_monitored"]
        if not monitored_actions:
            return
        live_rows = await (client.list_movies() if entity == "movie" else client.list_series())
        live_monitored = {
            int(row["id"]): bool(row.get("monitored", False))
            for row in live_rows
            if row.get("id") is not None
        }
        for action in monitored_actions:
            if action.when == "conforming":
                # validation guarantees media == movies here
                compiled = compile_candidates(params, "movie", sense="conforming")
                rows = await self._run_db(
                    _select_rows,
                    compiled.select_sql,
                    {**compiled.binds, **runtime, "limit": self.SEARCHLESS_LIMIT},
                )
                target_ids = {int(r["source_id"]) for r in rows}
            else:
                target_ids = self._target_ids(entity, candidates)
            desired = bool(action.value)
            changed = [
                rid for rid in sorted(target_ids)
                if rid in live_monitored and live_monitored[rid] != desired
            ]
            if not changed:
                continue
            if entity == "movie":
                await client.update_movies_monitored(changed, desired)
            else:
                await client.update_series_monitored(changed, desired)
            counters["actions"] += len(changed)
            inst_details[f"monitored:{action.when}"] = len(changed)
```

- [ ] **Step 4: Run tests**

Run: `python -m pytest tests/test_automation_service.py -q` then `python -m pytest tests/ -x -q`
Expected: PASS. (The FakeArrClient in the tests only implements the methods the tested paths touch; if a test trips an unimplemented method, that's a real behavior change — extend the fake deliberately.)

- [ ] **Step 5: Commit**

```bash
git add src/arrsync/services/automation_service.py tests/test_automation_service.py
git commit -m "feat(automations): run executor with budget, cooldown, dry-run, live-diff actions"
```

---

### Task 7: Scheduler + main wiring

**Files:**
- Modify: `src/arrsync/services/scheduler.py`, `src/arrsync/main.py`
- Test: modify `tests/test_scheduler.py`

**Interfaces:**
- Consumes: `automation_store.read_enabled_automation_schedules` (Task 4), `AutomationService.run` (Task 6).
- Produces: `SyncScheduler(..., automation_run_coro: Callable[[int], Awaitable[Any]] | None = None)`; jobs registered with id `automation:{id}`; `AppState.automation_service: AutomationService | None` (consumed by Task 8).

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_scheduler.py`:

```python
class AutomationScheduleFakeSession(ScheduleFakeSession):
    def __init__(self, schedule_rows=None, automation_rows=None) -> None:
        super().__init__(schedule_rows)
        self.automation_rows = automation_rows or []

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> FakeResult:
        sql = " ".join(str(query).lower().split())
        if "select id, cron, timezone from app.automation" in sql:
            self.statements.append((sql, params))
            return FakeResult(rows=self.automation_rows)
        return super().execute(query, params)


@pytest.mark.asyncio
async def test_automation_jobs_registered_per_enabled_row() -> None:
    async def automation_run(automation_id: int) -> None:
        return None

    session = AutomationScheduleFakeSession(
        schedule_rows=[{"mode": "incremental", "cron": "*/30 * * * *"}],
        automation_rows=[
            {"id": 1, "cron": "0 6 */2 * *", "timezone": "UTC"},
            {"id": 2, "cron": "15 6 * * *", "timezone": "Europe/Berlin"},
        ],
    )
    scheduler = _build_scheduler(session, _build_settings(), automation_run_coro=automation_run)
    scheduler.start()
    try:
        job_ids = {job.id for job in scheduler.scheduler.get_jobs()}
        assert {"automation:1", "automation:2"} <= job_ids
    finally:
        scheduler.shutdown()


@pytest.mark.asyncio
async def test_bad_automation_cron_skips_that_job_only() -> None:
    async def automation_run(automation_id: int) -> None:
        return None

    session = AutomationScheduleFakeSession(
        automation_rows=[
            {"id": 1, "cron": "not a cron", "timezone": "UTC"},
            {"id": 2, "cron": "0 6 * * *", "timezone": "UTC"},
        ],
    )
    scheduler = _build_scheduler(session, _build_settings(), automation_run_coro=automation_run)
    scheduler.start()
    try:
        job_ids = {job.id for job in scheduler.scheduler.get_jobs()}
        assert "automation:1" not in job_ids  # no sensible fallback cron exists — skip
        assert "automation:2" in job_ids
    finally:
        scheduler.shutdown()


@pytest.mark.asyncio
async def test_no_automation_query_without_coro() -> None:
    session = AutomationScheduleFakeSession()
    scheduler = _build_scheduler(session, _build_settings())
    scheduler.start()  # must not issue the app.automation select (FakeSession would raise)
    try:
        assert not any("app.automation" in sql for sql, _ in session.statements)
    finally:
        scheduler.shutdown()
```

- [ ] **Step 2: Run to verify failure**

Run: `python -m pytest tests/test_scheduler.py -q`
Expected: new tests FAIL (`unexpected keyword argument 'automation_run_coro'`).

- [ ] **Step 3: Implement scheduler changes**

In `src/arrsync/services/scheduler.py`:

1. Add import: `from arrsync.services.automation_store import read_enabled_automation_schedules`
2. Constructor: add kwarg `automation_run_coro: Callable[[int], Awaitable[Any]] | None = None`, store as `self._automation_run_coro`.
3. In `start()`, after the `coverage_tag_sync` block (before the webhook_drain job), add:

```python
        if self._automation_run_coro is not None:
            for row in self._read_enabled_automations():
                automation_id = int(row["id"])
                cron = str(row["cron"])
                tz = str(row["timezone"] or self.settings.scheduler_timezone)
                try:
                    trigger = CronTrigger.from_crontab(cron, timezone=tz)
                except Exception:
                    # Unlike sync modes there is no env-default cron to fall back to;
                    # skip just this automation instead of killing scheduler start.
                    log.warning(
                        "invalid automation schedule; skipping",
                        extra={"automation_id": automation_id, "cron": cron, "timezone": tz},
                        exc_info=True,
                    )
                    continue
                self.scheduler.add_job(
                    self._make_automation_tick(automation_id),
                    trigger,
                    id=f"automation:{automation_id}",
                    replace_existing=True,
                )
```

4. Add the two helpers next to `_read_schedule_rows`:

```python
    def _read_enabled_automations(self) -> list[dict[str, Any]]:
        with session_scope(self.session_factory) as session:
            return read_enabled_automation_schedules(session)

    def _make_automation_tick(self, automation_id: int) -> Callable[[], Awaitable[None]]:
        async def _tick() -> None:
            log.debug("scheduler tick: automation %s", automation_id)
            assert self._automation_run_coro is not None
            await self._automation_run_coro(automation_id)

        return _tick
```

- [ ] **Step 4: Wire in `src/arrsync/main.py`**

1. Import: `from arrsync.services.automation_service import AutomationService`
2. After `coverage_tag_service = ...` (line ~99): `automation_service = AutomationService(settings, session_factory_holder, event_bus=event_bus)`
3. After `_cron_coverage_tag_sync` (line ~115):

```python
async def _cron_automation(automation_id: int) -> None:
    await automation_service.run(automation_id, reason="cron")
```

4. Pass `automation_run_coro=_cron_automation` to the `SyncScheduler(...)` call (line ~118).
5. `AppState` dataclass: add field `automation_service: AutomationService | None = None`; pass `automation_service=automation_service` in the `AppState(...)` construction (line ~129).
6. In `tests/fakes.py` `FakeAppState.__post_init__`, add `self.automation_service = None` (router tests monkeypatch it; route-table building never calls it).

- [ ] **Step 5: Run tests**

Run: `python -m pytest tests/test_scheduler.py tests/ -x -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/arrsync/services/scheduler.py src/arrsync/main.py tests/test_scheduler.py tests/fakes.py
git commit -m "feat(automations): per-automation cron jobs + service wiring"
```

---
### Task 8: REST router `/api/automations*`

**Files:**
- Create: `src/arrsync/routers/automations.py`
- Modify: `src/arrsync/api.py`, `tests/fixtures/route_table.txt`
- Test: `tests/test_automations_api.py` (create)

**Interfaces:**
- Consumes: `automation_store.*`, `TEMPLATES`/`validate_params`/`compile_candidates`, `app_state.automation_service.run`, `app_state.scheduler.reload()`, `app_state.session_scope()`, `app_state.manual_sync_tasks`.
- Produces routes (consumed by frontend Tasks 9–10):
  - `GET /api/automations` → `{"automations": [...]}`
  - `POST /api/automations` → `{"id": int}` (201-style create; body: `name, template_key, params, cron, timezone?, enabled?, dry_run?, budget_per_run?, cooldown_days?`)
  - `PUT /api/automations/{automation_id}` → `{"status": "ok"}`
  - `DELETE /api/automations/{automation_id}` → `{"status": "ok"}`
  - `GET /api/automations/templates` → `{"templates": [...]}`
  - `POST /api/automations/validate` → `{"valid": bool, "error"?: str, "next_fire_times"?: [...], "match_preview"?: {instance: count} | null, "preview_note"?: str}`
  - `POST /api/automations/{automation_id}/run` → `{"status": "started"}`
  - `GET /api/automations/{automation_id}/runs` → `{"runs": [...]}`
  - `GET /api/automations/runs/{run_id}` → run detail incl. `details` jsonb

- [ ] **Step 1: Write the failing tests**

Create `tests/test_automations_api.py`:

```python
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from arrsync.api import build_router
from arrsync.routers import automations as automations_module
from fakes import FakeAppState, FakeResult, FakeSession


class AutomationApiFakeSession(FakeSession):
    def __init__(self) -> None:
        super().__init__()
        self.automations: list[dict[str, Any]] = []

    def execute(self, query: Any, params: dict[str, Any] | None = None) -> FakeResult:
        sql = " ".join(str(query).lower().split())
        if "app.automation" in sql:
            self.statements.append((sql, params))
            if sql.startswith("insert into app.automation"):
                return FakeResult(scalar_value=42)
            if "from app.automation a" in sql:  # list with lateral last-run join
                return FakeResult(rows=self.automations)
            if "delete from app.automation" in sql:
                return FakeResult(rows=[(1,)])
            if "from app.automation where id" in sql:
                return FakeResult(rows=self.automations[:1])
            if "from app.automation_run" in sql:
                return FakeResult(rows=[])
            return FakeResult(rows=[(1,)])
        return super().execute(query, params)


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    state = FakeAppState()
    state.session = AutomationApiFakeSession()
    reloads = {"count": 0}

    def _reload() -> None:
        reloads["count"] += 1

    state.scheduler = SimpleNamespace(reload=_reload, settings=state.settings)
    state.reloads = reloads
    monkeypatch.setattr(
        automations_module.repo, "list_enabled_integrations", lambda session, source: []
    )
    app = FastAPI()
    app.include_router(build_router(state))
    test_client = TestClient(app)
    test_client.app_state = state  # type: ignore[attr-defined]
    return test_client


VALID_BODY = {
    "name": "dub hunt",
    "template_key": "anime-dub-enforcer",
    "params": {
        "scope": {"media": "both", "anime_only": True},
        "require": {"audio_language_any": ["english", "eng"], "resolution_min": 1080},
        "actions": [{"type": "search_missing"}, {"type": "search_upgrade"}],
        "options": {"mal_dub_gate": True},
    },
    "cron": "0 6 */2 * *",
    "timezone": "UTC",
}


def test_templates_catalog(client: TestClient) -> None:
    resp = client.get("/api/automations/templates")
    assert resp.status_code == 200
    keys = {t["key"] for t in resp.json()["templates"]}
    assert "anime-dub-enforcer" in keys and "custom" in keys


def test_create_valid_automation_reloads_scheduler(client: TestClient) -> None:
    resp = client.post("/api/automations", json=VALID_BODY)
    assert resp.status_code == 200, resp.text
    assert resp.json()["id"] == 42
    assert client.app_state.reloads["count"] == 1  # type: ignore[attr-defined]


def test_create_rejects_bad_cron(client: TestClient) -> None:
    resp = client.post("/api/automations", json={**VALID_BODY, "cron": "nope"})
    assert resp.status_code == 400
    assert "cron" in resp.json()["detail"].lower()


def test_create_rejects_unknown_template(client: TestClient) -> None:
    resp = client.post("/api/automations", json={**VALID_BODY, "template_key": "nope"})
    assert resp.status_code == 400


def test_create_rejects_invalid_params(client: TestClient) -> None:
    body = {**VALID_BODY, "params": {**VALID_BODY["params"], "actions": []}}
    resp = client.post("/api/automations", json=body)
    assert resp.status_code == 400


def test_validate_returns_fire_times_and_preview(client: TestClient) -> None:
    resp = client.post(
        "/api/automations/validate",
        json={"template_key": "custom", "params": VALID_BODY["params"], "cron": "0 6 * * *"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["valid"] is True
    assert len(body["next_fire_times"]) == 3
    assert body["match_preview"] == {}  # no enabled integrations in this fixture


def test_validate_flags_bad_params_without_500(client: TestClient) -> None:
    resp = client.post(
        "/api/automations/validate",
        json={"template_key": "custom", "params": {"actions": []}, "cron": "0 6 * * *"},
    )
    assert resp.status_code == 200
    assert resp.json()["valid"] is False


def test_run_now_starts_background_task(client: TestClient) -> None:
    calls: list[int] = []

    class FakeService:
        async def run(self, automation_id: int, *, reason: str = "cron") -> dict:
            calls.append(automation_id)
            return {"status": "success"}

    client.app_state.automation_service = FakeService()  # type: ignore[attr-defined]
    resp = client.post("/api/automations/5/run")
    assert resp.status_code == 200
    assert resp.json()["status"] == "started"
```

- [ ] **Step 2: Run to verify failure**

Run: `python -m pytest tests/test_automations_api.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'arrsync.routers.automations'`

- [ ] **Step 3: Implement the router**

Create `src/arrsync/routers/automations.py`:

```python
"""Automations REST surface: CRUD, validation + match preview, run-now, history.

Literal paths (/templates, /validate, /runs/{run_id}) are registered before the
/{automation_id} parameterized routes so they can never be shadowed.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from apscheduler.triggers.cron import CronTrigger
from fastapi import APIRouter, HTTPException
from sqlalchemy import text

from arrsync.services import automation_store
from arrsync.services import repository as repo
from arrsync.services.automation_rules import TEMPLATES, compile_candidates, validate_params

_SOURCES_FOR_MEDIA = {"movies": ["radarr"], "series": ["sonarr"], "both": ["radarr", "sonarr"]}
_ENTITY_FOR_SOURCE = {"radarr": "movie", "sonarr": "episode"}


def _cron_or_400(cron: str, timezone: str) -> None:
    try:
        ZoneInfo(timezone)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="timezone must be a valid IANA timezone") from exc
    try:
        CronTrigger.from_crontab(cron, timezone=timezone)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="cron is invalid (expected crontab format)") from exc


def _clamp(value: Any, low: int, high: int, default: int) -> int:
    try:
        return max(low, min(int(value), high))
    except (TypeError, ValueError):
        return default


def _common_fields(payload: dict[str, Any], settings: Any) -> dict[str, Any]:
    name = str(payload.get("name", "")).strip()
    if not name or len(name) > 100:
        raise HTTPException(status_code=400, detail="name must be 1-100 characters")
    template_key = str(payload.get("template_key", ""))
    raw_params = payload.get("params")
    if not isinstance(raw_params, dict):
        raise HTTPException(status_code=400, detail="params must be an object")
    try:
        validate_params(template_key, raw_params)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)[:300]) from exc
    cron = str(payload.get("cron", "")).strip()
    timezone = str(payload.get("timezone") or settings.scheduler_timezone).strip()
    if not cron:
        raise HTTPException(status_code=400, detail="cron is required")
    _cron_or_400(cron, timezone)
    return {
        "name": name,
        "template_key": template_key,
        "params": raw_params,
        "cron": cron,
        "timezone": timezone,
        "enabled": bool(payload.get("enabled", False)),
        "dry_run": bool(payload.get("dry_run", True)),
        "budget_per_run": _clamp(payload.get("budget_per_run", 10), 1, 100, 10),
        "cooldown_days": _clamp(payload.get("cooldown_days", 7), 1, 90, 7),
    }


def build_automations_router(app_state: Any) -> APIRouter:
    router = APIRouter()

    @router.get("/api/automations")
    def list_automations() -> dict[str, Any]:
        with app_state.session_scope() as session:
            return {"automations": automation_store.list_automations(session)}

    @router.get("/api/automations/templates")
    def list_templates() -> dict[str, Any]:
        return {
            "templates": [
                {
                    "key": t.key,
                    "title": t.title,
                    "description": t.description,
                    "default_cron": t.default_cron,
                    "default_params": t.default_params,
                }
                for t in TEMPLATES.values()
            ]
        }

    @router.post("/api/automations/validate")
    def validate_automation(payload: dict[str, Any]) -> dict[str, Any]:
        """Parse problems come back as valid=false with HTTP 200 (as-you-type UX,
        same contract as /api/config/schedules/validate)."""
        template_key = str(payload.get("template_key", "custom"))
        raw_params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
        try:
            params = validate_params(template_key, raw_params)
        except ValueError as exc:
            return {"valid": False, "error": str(exc)[:300]}
        cron = str(payload.get("cron", "")).strip()
        timezone = str(payload.get("timezone") or app_state.settings.scheduler_timezone).strip()
        fire_times: list[str] = []
        if cron:
            try:
                tzinfo = ZoneInfo(timezone)
                trigger = CronTrigger.from_crontab(cron, timezone=timezone)
            except Exception as exc:
                return {"valid": False, "error": str(exc)[:300]}
            previous: datetime | None = None
            now = datetime.now(tzinfo)
            for _ in range(3):
                next_fire = trigger.get_next_fire_time(previous, previous or now)
                if next_fire is None:
                    break
                fire_times.append(next_fire.isoformat())
                previous = next_fire
        if params.scope.tags_any:
            return {
                "valid": True,
                "next_fire_times": fire_times,
                "match_preview": None,
                "preview_note": "preview unavailable for tag-scoped rules (tags resolve live per instance)",
            }
        cooldown_days = _clamp(payload.get("cooldown_days", 7), 1, 90, 7)
        preview: dict[str, int] = {}
        try:
            with app_state.session_scope() as session:
                for source in _SOURCES_FOR_MEDIA[params.scope.media]:
                    compiled = compile_candidates(params, _ENTITY_FOR_SOURCE[source])
                    for inst in repo.list_enabled_integrations(session, source):
                        name = str(inst["name"])
                        if params.scope.instances and name not in params.scope.instances:
                            continue
                        count = session.execute(
                            text(compiled.count_sql),
                            {**compiled.binds, "instance_name": name, "cooldown_days": cooldown_days},
                        ).scalar_one()
                        preview[name] = preview.get(name, 0) + int(count)
        except Exception:
            return {"valid": True, "next_fire_times": fire_times, "match_preview": None,
                    "preview_note": "preview query failed; rule is still valid"}
        return {"valid": True, "next_fire_times": fire_times, "match_preview": preview}

    @router.get("/api/automations/runs/{run_id}")
    def get_run(run_id: int) -> dict[str, Any]:
        with app_state.session_scope() as session:
            run = automation_store.get_automation_run(session, run_id)
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        return run

    @router.post("/api/automations")
    def create_automation(payload: dict[str, Any]) -> dict[str, Any]:
        fields = _common_fields(payload, app_state.settings)
        try:
            with app_state.session_scope() as session:
                new_id = automation_store.create_automation(session, **fields)
        except Exception as exc:
            if "unique" in str(exc).lower():
                raise HTTPException(status_code=409, detail="an automation with that name exists") from exc
            raise
        app_state.scheduler.reload()
        return {"id": new_id}

    @router.put("/api/automations/{automation_id}")
    def update_automation(automation_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        fields = _common_fields(payload, app_state.settings)
        with app_state.session_scope() as session:
            ok = automation_store.update_automation(session, automation_id, fields)
        if not ok:
            raise HTTPException(status_code=404, detail="automation not found")
        app_state.scheduler.reload()
        return {"status": "ok"}

    @router.delete("/api/automations/{automation_id}")
    def delete_automation(automation_id: int) -> dict[str, Any]:
        with app_state.session_scope() as session:
            ok = automation_store.delete_automation(session, automation_id)
        if not ok:
            raise HTTPException(status_code=404, detail="automation not found")
        app_state.scheduler.reload()
        return {"status": "ok"}

    @router.post("/api/automations/{automation_id}/run")
    async def run_automation(automation_id: int) -> dict[str, Any]:
        service = app_state.automation_service
        if service is None:
            raise HTTPException(status_code=503, detail="automation service unavailable")
        task = asyncio.create_task(service.run(automation_id, reason="manual"))
        app_state.manual_sync_tasks.add(task)
        task.add_done_callback(app_state.manual_sync_tasks.discard)
        return {"status": "started"}

    @router.get("/api/automations/{automation_id}/runs")
    def list_runs(automation_id: int, limit: int = 20) -> dict[str, Any]:
        with app_state.session_scope() as session:
            return {"runs": automation_store.list_automation_runs(session, automation_id, limit)}

    return router
```

In `src/arrsync/api.py`: add `from arrsync.routers.automations import build_automations_router` and `router.include_router(build_automations_router(app_state))` after the `build_operator_router` line (before hooks/ui_shell).

- [ ] **Step 4: Update the route-table fixture**

Add these 9 lines to `tests/fixtures/route_table.txt`, keeping the file **sorted** (merge into place, don't append):

```
DELETE /api/automations/{automation_id}
GET /api/automations
GET /api/automations/runs/{run_id}
GET /api/automations/templates
GET /api/automations/{automation_id}/runs
POST /api/automations
POST /api/automations/validate
POST /api/automations/{automation_id}/run
PUT /api/automations/{automation_id}
```

Verify with `python -m pytest tests/test_route_table_snapshot.py -q` — if the sort disagrees, copy the exact diff the test prints.

- [ ] **Step 5: Run tests**

Run: `python -m pytest tests/test_automations_api.py tests/test_route_table_snapshot.py -q` then `python -m pytest tests/ -x -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/arrsync/routers/automations.py src/arrsync/api.py tests/fixtures/route_table.txt tests/test_automations_api.py
git commit -m "feat(automations): REST surface with validation preview and run-now"
```

---
### Task 9: Frontend plumbing (types, api, keys, route, nav)

**Files:**
- Modify: `frontend/src/types.ts`, `frontend/src/api.ts`, `frontend/src/lib/queryKeys.ts`, `frontend/src/routes/paths.ts`, `frontend/src/App.tsx`, `frontend/src/layout/AppLayout.tsx`

**Interfaces:**
- Produces (consumed by Task 10): types `AutomationRow`, `AutomationTemplate`, `AutomationRunRow`, `AutomationRunDetail`, `RuleParams`, `RuleAction`; `api.automations/automationTemplates/createAutomation/saveAutomation/deleteAutomation/validateAutomation/runAutomation/automationRuns/automationRun`; `queryKeys.automations/automationTemplates/automationRuns(id?)`; route `/automations`.

- [ ] **Step 1: Types**

Append to `frontend/src/types.ts`:

```ts
export type RuleAction = {
  type: "search_missing" | "search_upgrade" | "tag" | "set_monitored";
  label?: string | null;
  value?: boolean | null;
  when?: "non_conforming" | "conforming";
};

export type RuleParams = {
  scope?: {
    media?: "movies" | "series" | "both";
    instances?: string[];
    anime_only?: boolean;
    series_type?: string | null;
    genres_any?: string[];
    tags_any?: string[];
    monitored_only?: boolean;
  };
  require?: {
    audio_language_any?: string[];
    resolution_min?: number | null;
    video_codec_any?: string[];
    quality_any?: string[];
  };
  actions?: RuleAction[];
  options?: { mal_dub_gate?: boolean; new_dub_only?: boolean };
};

export type AutomationRow = {
  id: number;
  name: string;
  template_key: string;
  params: RuleParams;
  enabled: boolean;
  dry_run: boolean;
  cron: string;
  timezone: string;
  budget_per_run: number;
  cooldown_days: number;
  created_at: string;
  updated_at: string;
  last_run_id: number | null;
  last_run_status: string | null;
  last_run_started_at: string | null;
  last_run_matched: number | null;
  last_run_actions: number | null;
};

export type AutomationTemplate = {
  key: string;
  title: string;
  description: string;
  default_cron: string;
  default_params: RuleParams;
};

export type AutomationRunRow = {
  id: number;
  automation_id: number;
  started_at: string;
  finished_at: string | null;
  status: "running" | "success" | "partial" | "failed" | "dry_run";
  matched_count: number;
  actions_taken: number;
  skipped_cooldown: number;
  skipped_budget: number;
  error_message: string | null;
};

export type AutomationRunDetail = AutomationRunRow & {
  details: {
    reason?: string;
    dry_run?: boolean;
    daily_cap_clamped?: boolean;
    instances?: Record<
      string,
      Record<
        string,
        {
          matched?: number;
          searched?: number;
          profile_warning?: string;
          would_do?: { source_id: number; title: string; actions: string[] }[];
        } & Record<string, unknown>
      >
    >;
    errors?: { instance?: string; phase?: string; error?: string }[];
  };
};

export type AutomationValidateResponse = {
  valid: boolean;
  error?: string;
  next_fire_times?: string[];
  match_preview?: Record<string, number> | null;
  preview_note?: string;
};

export type AutomationPayload = {
  name: string;
  template_key: string;
  params: RuleParams;
  cron: string;
  timezone?: string;
  enabled?: boolean;
  dry_run?: boolean;
  budget_per_run?: number;
  cooldown_days?: number;
};
```

- [ ] **Step 2: API methods**

In `frontend/src/api.ts`:
1. Widen the method union (line ~37): `type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";`
2. Add the new types to the `import type { ... } from "./types";` list: `AutomationRow, AutomationTemplate, AutomationRunRow, AutomationRunDetail, AutomationValidateResponse, AutomationPayload`.
3. Add to the `api` object (near the schedules group):

```ts
  automations: () => requestJson<{ automations: AutomationRow[] }>("/api/automations"),
  automationTemplates: () =>
    requestJson<{ templates: AutomationTemplate[] }>("/api/automations/templates"),
  createAutomation: (payload: AutomationPayload) =>
    requestJson<{ id: number }>("/api/automations", "POST", payload),
  saveAutomation: (id: number, payload: AutomationPayload) =>
    requestJson<{ status: string }>(`/api/automations/${id}`, "PUT", payload),
  deleteAutomation: (id: number) =>
    requestJson<{ status: string }>(`/api/automations/${id}`, "DELETE"),
  validateAutomation: (payload: Partial<AutomationPayload>) =>
    requestJson<AutomationValidateResponse>("/api/automations/validate", "POST", payload),
  runAutomation: (id: number) =>
    requestJson<{ status: string }>(`/api/automations/${id}/run`, "POST"),
  automationRuns: (id: number) =>
    requestJson<{ runs: AutomationRunRow[] }>(`/api/automations/${id}/runs`),
  automationRun: (runId: number) =>
    requestJson<AutomationRunDetail>(`/api/automations/runs/${runId}`),
```

- [ ] **Step 3: Query keys**

In `frontend/src/lib/queryKeys.ts` add:

```ts
  automations: ["automations"] as const,
  automationTemplates: ["automation-templates"] as const,
```
and with the parameterized factories:
```ts
  automationRuns: (automationId?: number) =>
    automationId !== undefined
      ? (["automation-runs", automationId] as const)
      : (["automation-runs"] as const),
```

- [ ] **Step 4: Route + nav**

`frontend/src/routes/paths.ts`: add `automations: "/automations",` to `PATHS` (after `mal`) and `[PATHS.automations]: "Automations",` to `APP_ROUTE_TITLES`.

`frontend/src/App.tsx`: add lazy import
```tsx
const AutomationsPage = lazy(() => import("./pages/AutomationsPage").then((m) => ({ default: m.AutomationsPage })));
```
and route inside the shell (after the `mal` route, before the `*` catch-all):
```tsx
            <Route path="automations" element={<AutomationsPage />} />
```

`frontend/src/layout/AppLayout.tsx`: add `Wand2` to the lucide import list and append to `NAV_PRIMARY`:
```tsx
  { to: PATHS.automations, label: "Automations", Icon: Wand2 },
```

- [ ] **Step 5: Typecheck (page does not exist yet — create a stub so `tsc` passes)**

Create `frontend/src/pages/AutomationsPage.tsx` as a minimal stub (fully replaced in Task 10):

```tsx
import { usePageTitle } from "../hooks/usePageTitle";

export function AutomationsPage(): JSX.Element {
  usePageTitle("Automations");
  return <div className="space-y-6" />;
}
```

Run: `cd frontend && npx tsc -b && npm run lint && npm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/types.ts frontend/src/api.ts frontend/src/lib/queryKeys.ts frontend/src/routes/paths.ts frontend/src/App.tsx frontend/src/layout/AppLayout.tsx frontend/src/pages/AutomationsPage.tsx
git commit -m "feat(webui): automations route, api client, types"
```

---

### Task 10: Automations page (gallery, list, editor, run detail)

**Files:**
- Replace: `frontend/src/pages/AutomationsPage.tsx`
- Create: `frontend/src/pages/automations/TemplateGallery.tsx`, `frontend/src/pages/automations/AutomationEditor.tsx`, `frontend/src/pages/automations/AutomationList.tsx`, `frontend/src/pages/automations/AutomationRunHistory.tsx`, `frontend/src/pages/automations/TemplateGallery.test.tsx`, `frontend/src/pages/automations/AutomationList.test.tsx`

**Interfaces:**
- Consumes: everything from Task 9; `GlassCard`, `CronPreview`, `QueryErrorNotice`, shadcn `Badge/Button/Checkbox/Input/Label/Skeleton/Card*` primitives; `useActionError().runAction`; `fmtDate` from `../hooks`.
- Produces: `AutomationsPage` (already routed). `TemplateGallery({ templates, onUse })`, `AutomationList({ automations, onEdit, onRun, onDelete, onToggle, onHistory })`, `AutomationEditor({ draft, onChange, onSave, onCancel, saving })` with `AutomationDraft = AutomationPayload & { id?: number }`, `AutomationRunHistory({ automation, onClose })` (run list + expandable per-run detail incl. dry-run `would_do`, profile warnings, errors).

UI behavior (from the spec): template gallery cards with "Use template"; list rows show enabled/dry-run state (dry-run badge), cron + CronPreview, last-run summary, Run now / Edit / Delete; the editor is one generic form for every template (templates only pre-fill values) — name/cron/timezone/budget/cooldown/dry-run/enabled plus scope (media, anime-only, monitored-only, genres, tags), require (languages, resolution floor, codecs, qualities), actions (checkboxes; tag label input; unmonitor-when-done movie-only), MAL dub-gate options; a Validate button shows next fire times + "would match N items now".

- [ ] **Step 1: Write the failing component tests**

`frontend/src/pages/automations/TemplateGallery.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TemplateGallery } from "./TemplateGallery";
import type { AutomationTemplate } from "../../types";

const TEMPLATES: AutomationTemplate[] = [
  {
    key: "anime-dub-enforcer",
    title: "Anime English-dub enforcer",
    description: "Hunts dubs.",
    default_cron: "0 6 */2 * *",
    default_params: { scope: { media: "both" } },
  },
];

describe("TemplateGallery", () => {
  it("renders a card per template and fires onUse", () => {
    const onUse = vi.fn();
    render(<TemplateGallery templates={TEMPLATES} onUse={onUse} />);
    expect(screen.getByText("Anime English-dub enforcer")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /use template/i }));
    expect(onUse).toHaveBeenCalledWith(TEMPLATES[0]);
  });
});
```

`frontend/src/pages/automations/AutomationList.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AutomationList } from "./AutomationList";
import type { AutomationRow } from "../../types";

const ROW: AutomationRow = {
  id: 1,
  name: "dub hunt",
  template_key: "anime-dub-enforcer",
  params: {},
  enabled: true,
  dry_run: true,
  cron: "0 6 */2 * *",
  timezone: "UTC",
  budget_per_run: 10,
  cooldown_days: 7,
  created_at: "2026-07-30T00:00:00Z",
  updated_at: "2026-07-30T00:00:00Z",
  last_run_id: 5,
  last_run_status: "dry_run",
  last_run_started_at: "2026-07-30T06:00:00Z",
  last_run_matched: 12,
  last_run_actions: 0,
};

describe("AutomationList", () => {
  it("shows empty state without rows", () => {
    render(
      <AutomationList
        automations={[]}
        onEdit={vi.fn()}
        onRun={vi.fn()}
        onDelete={vi.fn()}
        onToggle={vi.fn()}
        onHistory={vi.fn()}
      />,
    );
    expect(screen.getByText(/no automations yet/i)).toBeInTheDocument();
  });

  it("renders row with dry-run badge and fires onRun", () => {
    const onRun = vi.fn();
    render(
      <AutomationList
        automations={[ROW]}
        onEdit={vi.fn()}
        onRun={onRun}
        onDelete={vi.fn()}
        onToggle={vi.fn()}
        onHistory={vi.fn()}
      />,
    );
    expect(screen.getByText("dub hunt")).toBeInTheDocument();
    expect(screen.getByText(/dry run/i)).toBeInTheDocument();
    expect(screen.getByText(/matched 12/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /run now/i }));
    expect(onRun).toHaveBeenCalledWith(ROW);
  });
});
```

Run: `cd frontend && npm run test` — expected FAIL (modules missing).

- [ ] **Step 2: Implement `TemplateGallery.tsx`**

```tsx
import type { AutomationTemplate } from "../../types";
import { GlassCard } from "@/components/nebula/GlassCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function TemplateGallery({
  templates,
  onUse,
}: {
  templates: AutomationTemplate[];
  onUse: (template: AutomationTemplate) => void;
}): JSX.Element {
  return (
    <GlassCard>
      <CardHeader>
        <CardTitle>Templates</CardTitle>
        <CardDescription>
          Start from a preset and tweak it. New automations are created in dry-run: they
          report what they would do until you flip them live.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {templates.map((template) => (
            <div key={template.key} className="flex flex-col rounded-xl border border-border bg-muted/40 p-4">
              <div className="flex items-center gap-2">
                <span className="font-medium">{template.title}</span>
                <Badge variant="outline">{template.key}</Badge>
              </div>
              <p className="mt-2 flex-1 text-sm text-muted-foreground">{template.description}</p>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">cron {template.default_cron}</span>
                <Button type="button" size="sm" variant="secondary" onClick={() => onUse(template)}>
                  Use template
                </Button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </GlassCard>
  );
}
```

- [ ] **Step 3: Implement `AutomationList.tsx`**

```tsx
import type { AutomationRow } from "../../types";
import { fmtDate } from "../../hooks";
import { GlassCard } from "@/components/nebula/GlassCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function statusVariant(status: string | null): "default" | "secondary" | "destructive" | "outline" {
  if (status === "failed") return "destructive";
  if (status === "success") return "default";
  return "secondary";
}

export function AutomationList({
  automations,
  onEdit,
  onRun,
  onDelete,
  onToggle,
  onHistory,
}: {
  automations: AutomationRow[];
  onEdit: (row: AutomationRow) => void;
  onRun: (row: AutomationRow) => void;
  onDelete: (row: AutomationRow) => void;
  onToggle: (row: AutomationRow, patch: { enabled?: boolean; dry_run?: boolean }) => void;
  onHistory: (row: AutomationRow) => void;
}): JSX.Element {
  return (
    <GlassCard>
      <CardHeader>
        <CardTitle>Automations</CardTitle>
        <CardDescription>
          Each automation runs on its own cron, capped by its per-run budget, the global
          daily search cap, and a per-item cooldown.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {automations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No automations yet — pick a template below to create your first one.
          </p>
        ) : null}
        {automations.map((row) => (
          <div key={row.id} className="rounded-xl border border-border bg-muted/40 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{row.name}</span>
              <Badge variant="outline">{row.template_key}</Badge>
              {row.dry_run ? <Badge variant="secondary">dry run</Badge> : null}
              {!row.enabled ? <Badge variant="outline">disabled</Badge> : null}
              <span className="ml-auto text-xs text-muted-foreground">
                cron {row.cron} ({row.timezone})
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {row.last_run_status ? (
                <>
                  <Badge variant={statusVariant(row.last_run_status)}>{row.last_run_status}</Badge>
                  <span>
                    matched {row.last_run_matched ?? 0}, actions {row.last_run_actions ?? 0} —{" "}
                    {fmtDate(row.last_run_started_at ?? "")}
                  </span>
                </>
              ) : (
                <span>never run</span>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => onRun(row)}>
                Run now
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => onEdit(row)}>
                Edit
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => onHistory(row)}>
                History
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => onToggle(row, { enabled: !row.enabled })}
              >
                {row.enabled ? "Disable" : "Enable"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => onToggle(row, { dry_run: !row.dry_run })}
              >
                {row.dry_run ? "Go live" : "Back to dry-run"}
              </Button>
              <Button type="button" size="sm" variant="destructive" onClick={() => onDelete(row)}>
                Delete
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </GlassCard>
  );
}
```

- [ ] **Step 4: Implement `AutomationEditor.tsx`**

One generic form for all templates. List-ish params are edited as comma-separated text.

```tsx
import { useState } from "react";
import type { AutomationPayload, AutomationValidateResponse, RuleAction, RuleParams } from "../../types";
import { api } from "../../api";
import { CronPreview } from "@/components/nebula/CronPreview";
import { GlassCard } from "@/components/nebula/GlassCard";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type AutomationDraft = AutomationPayload & { id?: number };

const csv = (values: string[] | undefined): string => (values ?? []).join(", ");
const parseCsv = (raw: string): string[] =>
  raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

function actionOfType(actions: RuleAction[] | undefined, type: RuleAction["type"]): RuleAction | undefined {
  return (actions ?? []).find((action) => action.type === type);
}

export function AutomationEditor({
  draft,
  onChange,
  onSave,
  onCancel,
  saving,
}: {
  draft: AutomationDraft;
  onChange: (next: AutomationDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}): JSX.Element {
  const [cronValid, setCronValid] = useState(true);
  const [preview, setPreview] = useState<AutomationValidateResponse | null>(null);
  const params: RuleParams = draft.params ?? {};
  const scope = params.scope ?? {};
  const require = params.require ?? {};
  const options = params.options ?? {};
  const actions = params.actions ?? [];

  const patchParams = (patch: Partial<RuleParams>): void =>
    onChange({ ...draft, params: { ...params, ...patch } });
  const toggleAction = (type: RuleAction["type"], extra?: Partial<RuleAction>): void => {
    const existing = actionOfType(actions, type);
    const next = existing
      ? actions.filter((action) => action.type !== type)
      : [...actions, { type, when: "non_conforming" as const, ...extra }];
    patchParams({ actions: next });
  };
  const patchAction = (type: RuleAction["type"], patch: Partial<RuleAction>): void =>
    patchParams({
      actions: actions.map((action) => (action.type === type ? { ...action, ...patch } : action)),
    });

  const validate = async (): Promise<void> => {
    try {
      setPreview(await api.validateAutomation(draft));
    } catch {
      setPreview({ valid: false, error: "validation request failed" });
    }
  };

  const tagAction = actionOfType(actions, "tag");
  const monitorAction = actionOfType(actions, "set_monitored");

  return (
    <GlassCard>
      <CardHeader>
        <CardTitle>{draft.id ? `Edit: ${draft.name}` : "New automation"}</CardTitle>
        <CardDescription>
          Items in scope that fail every requirement get the selected actions, within budget
          and cooldown. Rules start in dry-run.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="automation-name" className="text-xs text-muted-foreground">Name</Label>
            <Input id="automation-name" value={draft.name}
              onChange={(e) => onChange({ ...draft, name: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="automation-media" className="text-xs text-muted-foreground">Media</Label>
            <select
              id="automation-media"
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              value={scope.media ?? "both"}
              onChange={(e) =>
                patchParams({ scope: { ...scope, media: e.target.value as "movies" | "series" | "both" } })
              }
            >
              <option value="both">Movies + Series</option>
              <option value="movies">Movies only</option>
              <option value="series">Series only</option>
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="automation-cron" className="text-xs text-muted-foreground">Cron</Label>
            <Input id="automation-cron" value={draft.cron}
              onChange={(e) => onChange({ ...draft, cron: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="automation-tz" className="text-xs text-muted-foreground">Timezone (IANA)</Label>
            <Input id="automation-tz" value={draft.timezone ?? "UTC"}
              onChange={(e) => onChange({ ...draft, timezone: e.target.value })} />
          </div>
        </div>
        <CronPreview cron={draft.cron} timezone={draft.timezone} onValidityChange={setCronValid} />

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="automation-budget" className="text-xs text-muted-foreground">
              Search budget per run (1–100)
            </Label>
            <Input id="automation-budget" type="number" min={1} max={100} value={draft.budget_per_run ?? 10}
              onChange={(e) => onChange({ ...draft, budget_per_run: Number(e.target.value) || 10 })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="automation-cooldown" className="text-xs text-muted-foreground">
              Per-item cooldown (days, 1–90)
            </Label>
            <Input id="automation-cooldown" type="number" min={1} max={90} value={draft.cooldown_days ?? 7}
              onChange={(e) => onChange({ ...draft, cooldown_days: Number(e.target.value) || 7 })} />
          </div>
        </div>

        <fieldset className="grid gap-2 rounded-lg border border-border p-3">
          <legend className="px-1 text-xs text-muted-foreground">Scope</legend>
          {(
            [
              ["anime-only", "Anime only", scope.anime_only ?? false,
                (checked: boolean) => patchParams({ scope: { ...scope, anime_only: checked } })],
              ["monitored-only", "Monitored only", scope.monitored_only ?? true,
                (checked: boolean) => patchParams({ scope: { ...scope, monitored_only: checked } })],
            ] as const
          ).map(([id, label, checked, set]) => (
            <div key={id} className="flex items-center gap-2">
              <Checkbox id={`automation-${id}`} checked={checked}
                onCheckedChange={(value) => set(value === true)} />
              <Label htmlFor={`automation-${id}`} className="text-sm">{label}</Label>
            </div>
          ))}
          <div className="grid gap-1.5">
            <Label htmlFor="automation-genres" className="text-xs text-muted-foreground">
              Genres (any of, comma-separated; empty = all)
            </Label>
            <Input id="automation-genres" value={csv(scope.genres_any)}
              onChange={(e) => patchParams({ scope: { ...scope, genres_any: parseCsv(e.target.value) } })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="automation-tags" className="text-xs text-muted-foreground">
              Sonarr/Radarr tags (any of, comma-separated labels)
            </Label>
            <Input id="automation-tags" value={csv(scope.tags_any)}
              onChange={(e) => patchParams({ scope: { ...scope, tags_any: parseCsv(e.target.value) } })} />
          </div>
        </fieldset>

        <fieldset className="grid gap-2 rounded-lg border border-border p-3">
          <legend className="px-1 text-xs text-muted-foreground">Requirements (item conforms when ALL hold)</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="automation-langs" className="text-xs text-muted-foreground">
                Audio language any-of (e.g. english, eng)
              </Label>
              <Input id="automation-langs" value={csv(require.audio_language_any)}
                onChange={(e) =>
                  patchParams({ require: { ...require, audio_language_any: parseCsv(e.target.value) } })
                } />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="automation-res" className="text-xs text-muted-foreground">
                Minimum resolution (empty = any)
              </Label>
              <Input id="automation-res" type="number" min={240} max={4320}
                value={require.resolution_min ?? ""}
                onChange={(e) =>
                  patchParams({
                    require: {
                      ...require,
                      resolution_min: e.target.value === "" ? null : Number(e.target.value),
                    },
                  })
                } />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="automation-codecs" className="text-xs text-muted-foreground">
                Video codec any-of (e.g. x265, hevc)
              </Label>
              <Input id="automation-codecs" value={csv(require.video_codec_any)}
                onChange={(e) =>
                  patchParams({ require: { ...require, video_codec_any: parseCsv(e.target.value) } })
                } />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="automation-quality" className="text-xs text-muted-foreground">
                Quality name any-of (e.g. WEBDL-1080p)
              </Label>
              <Input id="automation-quality" value={csv(require.quality_any)}
                onChange={(e) =>
                  patchParams({ require: { ...require, quality_any: parseCsv(e.target.value) } })
                } />
            </div>
          </div>
        </fieldset>

        <fieldset className="grid gap-2 rounded-lg border border-border p-3">
          <legend className="px-1 text-xs text-muted-foreground">Actions on non-conforming items</legend>
          <div className="flex items-center gap-2">
            <Checkbox id="automation-search-missing" checked={Boolean(actionOfType(actions, "search_missing"))}
              onCheckedChange={() => toggleAction("search_missing")} />
            <Label htmlFor="automation-search-missing" className="text-sm">Search items with no file</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="automation-search-upgrade" checked={Boolean(actionOfType(actions, "search_upgrade"))}
              onCheckedChange={() => toggleAction("search_upgrade")} />
            <Label htmlFor="automation-search-upgrade" className="text-sm">
              Search upgrades for files failing the requirements
            </Label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Checkbox id="automation-tag" checked={Boolean(tagAction)}
              onCheckedChange={() => toggleAction("tag", { label: "needs-upgrade" })} />
            <Label htmlFor="automation-tag" className="text-sm">Apply tag</Label>
            {tagAction ? (
              <Input className="h-8 w-48" value={tagAction.label ?? ""}
                onChange={(e) => patchAction("tag", { label: e.target.value })} />
            ) : null}
          </div>
          {(scope.media ?? "both") === "movies" ? (
            <div className="flex items-center gap-2">
              <Checkbox id="automation-unmonitor" checked={Boolean(monitorAction)}
                onCheckedChange={() => toggleAction("set_monitored", { value: false, when: "conforming" })} />
              <Label htmlFor="automation-unmonitor" className="text-sm">
                Unmonitor movies once they conform (stop caring when acquired)
              </Label>
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <Checkbox id="automation-dub-gate" checked={options.mal_dub_gate ?? false}
              onCheckedChange={(value) =>
                patchParams({ options: { ...options, mal_dub_gate: value === true } })
              } />
            <Label htmlFor="automation-dub-gate" className="text-sm">
              Skip items MAL dub lists say have no dub (saves indexer quota)
            </Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="automation-new-dub" checked={options.new_dub_only ?? false}
              onCheckedChange={(value) =>
                patchParams({ options: { ...options, new_dub_only: value === true, mal_dub_gate: true } })
              } />
            <Label htmlFor="automation-new-dub" className="text-sm">
              Only act when a dub newly appears (new-dub watcher)
            </Label>
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Checkbox id="automation-enabled" checked={draft.enabled ?? false}
              onCheckedChange={(value) => onChange({ ...draft, enabled: value === true })} />
            <Label htmlFor="automation-enabled" className="text-sm">Enabled (scheduled)</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="automation-dry-run" checked={draft.dry_run ?? true}
              onCheckedChange={(value) => onChange({ ...draft, dry_run: value === true })} />
            <Label htmlFor="automation-dry-run" className="text-sm">Dry-run (simulate only)</Label>
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={() => void validate()}>
            Validate & preview
          </Button>
          <Button type="button" size="sm" disabled={!cronValid || saving} onClick={onSave}>
            {draft.id ? "Save changes" : "Create automation"}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        {preview ? (
          <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
            {preview.valid ? (
              <>
                <p>Rule is valid.</p>
                {preview.match_preview ? (
                  <p>
                    Would match now:{" "}
                    {Object.entries(preview.match_preview)
                      .map(([instance, count]) => `${instance}: ${count}`)
                      .join(", ") || "0 items"}
                  </p>
                ) : (
                  <p>{preview.preview_note ?? "No preview available."}</p>
                )}
              </>
            ) : (
              <p role="alert">Invalid rule: {preview.error}</p>
            )}
          </div>
        ) : null}
      </CardContent>
    </GlassCard>
  );
}
```

- [ ] **Step 4b: Implement `AutomationRunHistory.tsx`**

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { queryKeys } from "../../lib/queryKeys";
import { fmtDate } from "../../hooks";
import type { AutomationRow } from "../../types";
import { GlassCard } from "@/components/nebula/GlassCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function RunDetail({ runId }: { runId: number }): JSX.Element {
  const run = useQuery({
    queryKey: [...queryKeys.automationRuns(), "detail", runId] as const,
    queryFn: () => api.automationRun(runId),
  });
  if (run.isLoading) return <Skeleton className="h-16 w-full" />;
  if (!run.data) return <p className="text-sm text-muted-foreground">Could not load run detail.</p>;
  const details = run.data.details ?? {};
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-sm">
      {details.daily_cap_clamped ? (
        <p className="text-amber-600 dark:text-amber-400">Search budget clamped by the daily cap.</p>
      ) : null}
      {Object.entries(details.instances ?? {}).map(([instance, entities]) =>
        Object.entries(entities).map(([entity, info]) => (
          <div key={`${instance}:${entity}`}>
            <p className="font-medium">
              {instance} / {entity}: matched {info.matched ?? 0}
              {typeof info.searched === "number" ? `, searched ${info.searched}` : ""}
            </p>
            {info.profile_warning ? (
              <p className="text-amber-600 dark:text-amber-400">{info.profile_warning}</p>
            ) : null}
            {(info.would_do ?? []).map((item) => (
              <p key={item.source_id} className="text-muted-foreground">
                would {item.actions.join(" + ")}: {item.title || `#${item.source_id}`}
              </p>
            ))}
          </div>
        )),
      )}
      {(details.errors ?? []).map((err, index) => (
        <p key={index} role="alert" className="text-destructive">
          {err.instance ? `${err.instance}: ` : ""}
          {err.phase ? `[${err.phase}] ` : ""}
          {err.error}
        </p>
      ))}
    </div>
  );
}

export function AutomationRunHistory({
  automation,
  onClose,
}: {
  automation: AutomationRow;
  onClose: () => void;
}): JSX.Element {
  const runs = useQuery({
    queryKey: queryKeys.automationRuns(automation.id),
    queryFn: () => api.automationRuns(automation.id),
  });
  const [openRunId, setOpenRunId] = useState<number | null>(null);
  return (
    <GlassCard>
      <CardHeader>
        <CardTitle>Run history: {automation.name}</CardTitle>
        <CardDescription>
          Dry-run rows list what the rule would have done; live rows list what it did.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {runs.isLoading ? <Skeleton className="h-20 w-full" /> : null}
        {runs.data && runs.data.runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        ) : null}
        {(runs.data?.runs ?? []).map((run) => (
          <div key={run.id} className="rounded-lg border border-border bg-muted/40 p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant={run.status === "failed" ? "destructive" : "secondary"}>{run.status}</Badge>
              <span>{fmtDate(run.started_at)}</span>
              <span className="text-muted-foreground">
                matched {run.matched_count}, actions {run.actions_taken}, cooldown-skipped{" "}
                {run.skipped_cooldown}, budget-skipped {run.skipped_budget}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => setOpenRunId(openRunId === run.id ? null : run.id)}
              >
                {openRunId === run.id ? "Hide detail" : "Detail"}
              </Button>
            </div>
            {run.error_message ? (
              <p role="alert" className="mt-1 text-sm text-destructive">{run.error_message}</p>
            ) : null}
            {openRunId === run.id ? <RunDetail runId={run.id} /> : null}
          </div>
        ))}
        <Button type="button" size="sm" variant="secondary" onClick={onClose}>
          Close history
        </Button>
      </CardContent>
    </GlassCard>
  );
}
```

- [ ] **Step 5: Implement `AutomationsPage.tsx` (replace the stub)**

```tsx
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { usePageTitle } from "../hooks/usePageTitle";
import { useActionError } from "../hooks/useActionError";
import { queryKeys } from "../lib/queryKeys";
import { QueryErrorNotice } from "@/components/nebula/QueryErrorNotice";
import { Skeleton } from "@/components/ui/skeleton";
import type { AutomationRow, AutomationTemplate } from "../types";
import { AutomationEditor, type AutomationDraft } from "./automations/AutomationEditor";
import { AutomationList } from "./automations/AutomationList";
import { AutomationRunHistory } from "./automations/AutomationRunHistory";
import { TemplateGallery } from "./automations/TemplateGallery";

export function AutomationsPage(): JSX.Element {
  usePageTitle("Automations");
  const queryClient = useQueryClient();
  const { runAction } = useActionError();
  const automations = useQuery({ queryKey: queryKeys.automations, queryFn: api.automations });
  const templates = useQuery({ queryKey: queryKeys.automationTemplates, queryFn: api.automationTemplates });
  const [draft, setDraft] = useState<AutomationDraft | null>(null);
  const [historyRow, setHistoryRow] = useState<AutomationRow | null>(null);
  const [saving, setSaving] = useState(false);

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.automations });
  };

  const useTemplate = (template: AutomationTemplate): void =>
    setDraft({
      name: template.key === "custom" ? "" : template.title,
      template_key: template.key,
      params: template.default_params,
      cron: template.default_cron,
      timezone: "UTC",
      enabled: false,
      dry_run: true,
      budget_per_run: 10,
      cooldown_days: 7,
    });

  const editRow = (row: AutomationRow): void =>
    setDraft({
      id: row.id,
      name: row.name,
      template_key: row.template_key,
      params: row.params,
      cron: row.cron,
      timezone: row.timezone,
      enabled: row.enabled,
      dry_run: row.dry_run,
      budget_per_run: row.budget_per_run,
      cooldown_days: row.cooldown_days,
    });

  const saveDraft = async (): Promise<void> => {
    if (!draft) return;
    setSaving(true);
    const ok = await runAction(
      async () => {
        if (draft.id) {
          await api.saveAutomation(draft.id, draft);
        } else {
          await api.createAutomation(draft);
        }
        await invalidate();
      },
      draft.id ? `save automation ${draft.name}` : "create automation",
      { successMessage: draft.id ? "Automation saved" : "Automation created (dry-run)" },
    );
    setSaving(false);
    if (ok) setDraft(null);
  };

  const runNow = (row: AutomationRow): void => {
    void runAction(() => api.runAutomation(row.id), `run automation ${row.name}`, {
      successMessage: `${row.name} started${row.dry_run ? " (dry-run)" : ""}`,
      invalidate: [[...queryKeys.automations]],
    });
  };

  const deleteRow = (row: AutomationRow): void => {
    void runAction(
      async () => {
        await api.deleteAutomation(row.id);
        await invalidate();
      },
      `delete automation ${row.name}`,
      { successMessage: "Automation deleted" },
    );
  };

  const toggleRow = (row: AutomationRow, patch: { enabled?: boolean; dry_run?: boolean }): void => {
    void runAction(
      async () => {
        await api.saveAutomation(row.id, {
          name: row.name,
          template_key: row.template_key,
          params: row.params,
          cron: row.cron,
          timezone: row.timezone,
          enabled: patch.enabled ?? row.enabled,
          dry_run: patch.dry_run ?? row.dry_run,
          budget_per_run: row.budget_per_run,
          cooldown_days: row.cooldown_days,
        });
        await invalidate();
      },
      `toggle automation ${row.name}`,
    );
  };

  return (
    <div className="space-y-6">
      {automations.isError ? (
        <QueryErrorNotice label="automations" retry={() => void automations.refetch()} error={automations.error} />
      ) : null}
      {automations.isLoading ? <Skeleton className="h-32 w-full" /> : null}
      {automations.data ? (
        <AutomationList
          automations={automations.data.automations}
          onEdit={editRow}
          onRun={runNow}
          onDelete={deleteRow}
          onToggle={toggleRow}
          onHistory={setHistoryRow}
        />
      ) : null}
      {historyRow ? (
        <AutomationRunHistory automation={historyRow} onClose={() => setHistoryRow(null)} />
      ) : null}
      {draft ? (
        <AutomationEditor
          draft={draft}
          onChange={setDraft}
          onSave={() => void saveDraft()}
          onCancel={() => setDraft(null)}
          saving={saving}
        />
      ) : null}
      {templates.data ? <TemplateGallery templates={templates.data.templates} onUse={useTemplate} /> : null}
    </div>
  );
}
```

- [ ] **Step 6: Run frontend checks**

Run: `cd frontend && npx tsc -b && npm run lint && npm run test`
Expected: PASS. Fix exact-import/prop mismatches against the real component files (e.g. `fmtDate` export location, `QueryErrorNotice` props) rather than restructuring — check the neighboring pages when in doubt.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/AutomationsPage.tsx frontend/src/pages/automations/
git commit -m "feat(webui): automations page — gallery, list, editor with validate preview"
```

---
### Task 11: Docs + backlog

**Files:**
- Create: `docs/AUTOMATIONS.md`
- Modify: `README.md` (API-surface quick-reference table), `Backlog/V2_BACKLOG.md` (`v2-int-001`, `v2-int-002`)

- [ ] **Step 1: Write `docs/AUTOMATIONS.md`**

```markdown
# Automations

Automations converge your library toward declared preferences ("anime = English dub,
1080p minimum") by periodically triggering Sonarr/Radarr searches and metadata
actions, driven entirely by warehouse data.

## Model

- **Automation** (`app.automation`): a template instance — params (scope /
  requirements / actions), its own cron + timezone, `budget_per_run`,
  `cooldown_days`, `enabled`, `dry_run`. New automations start in **dry-run**:
  runs record what they *would* do; flip the switch per rule to go live.
- **Conformance**: an item conforms when its file satisfies every requirement
  (audio language, resolution floor, codec, quality name). Non-conforming items
  in scope receive the rule's actions.
- **Acquisition model**: Nebularr only sends `*Search` commands; your Arr quality
  profiles and custom formats decide what actually gets grabbed. If a rule
  requires a language and no custom format on the instance scores language/dub,
  the run records a profile warning.

## Rate protection (4 layers)

1. Min interval between Arr command posts (`AUTOMATION_COMMAND_MIN_INTERVAL_SECONDS`, default 2s).
2. Per-run search budget (`budget_per_run`, default 10).
3. Global daily search cap across all automations (`AUTOMATION_MAX_SEARCHES_PER_DAY`, default 100).
4. Per-item cooldown via `app.automation_action_ledger` (default 7 days) — the
   ledger is keyed globally, so two rules can never double-search one item.

## Templates

anime-dub-enforcer (skips MAL `dub_status='none'` items), new-dub-watcher
(searches on `none → partial|dubbed` transitions), resolution-floor,
missing-hunter, codec-preference (tag-only by default), language-audit
(tag-only), custom (condition builder). All compile through the same
whitelist-only SQL compiler — user input is bind values, never SQL text.

## Operations

- Runs are recorded in `app.automation_run`; per-item outcomes live in `details`.
- Concurrency: `app.job_lock` lease `automation:{id}` — a run skips with
  "already running" instead of stacking.
- Tag labels used by an automation are owned by it: the reconcile adds the tag
  to matched items and removes it from unmatched ones on every run.
- Budget/cap apply to searches only; tag/monitored reconciles are idempotent
  diffs against live Arr state.
```

- [ ] **Step 2: README + backlog**

1. `README.md`: find the API-surface quick-reference table and add one row group for `/api/automations*` (list/CRUD/validate/run-now/history, one line each, matching the table's existing style). Mention `docs/AUTOMATIONS.md` in the docs list if the README has one.
2. `Backlog/V2_BACKLOG.md`: mark `v2-int-001` and `v2-int-002` as shipped, referencing this plan file.

- [ ] **Step 3: Commit**

```bash
git add docs/AUTOMATIONS.md README.md
git commit -m "docs: automations engine guide + API surface"
```
(`Backlog/` is gitignored except force-added files; `git add -f Backlog/V2_BACKLOG.md` — it is already tracked, so a plain `git add` also works.)

---

### Task 12: E2E, dist rebuild, final verification

**Files:**
- Modify: `frontend/tests/e2e/critical-flows.spec.ts`, `src/arrsync/web/dist/*` (rebuilt)

- [ ] **Step 1: Extend the e2e spec**

Read `frontend/tests/e2e/critical-flows.spec.ts` first — it runs serially against a real `docker compose up` stack and already handles setup/login. Append a test that reuses the authenticated state established by the earlier tests:

```ts
test("automations: create from template in dry-run", async ({ page }) => {
  await page.goto("/automations");
  await expect(page.getByText("Templates")).toBeVisible();
  await page
    .locator("div", { hasText: "Missing-content hunter" })
    .getByRole("button", { name: /use template/i })
    .first()
    .click();
  await page.getByLabel("Name").fill("e2e missing hunter");
  await page.getByRole("button", { name: /create automation/i }).click();
  await expect(page.getByText("e2e missing hunter")).toBeVisible();
  await expect(page.getByText(/dry run/i).first()).toBeVisible();
});
```

Adjust selectors to what the rendered DOM actually produces (run headed locally if needed); keep the assertions: row appears, dry-run badge visible.

- [ ] **Step 2: Rebuild the committed dist on Node 24**

```bash
docker run --rm -v "$PWD:/repo" -w /repo/frontend node:24 bash -lc "npm ci && npm run build"
git status --short src/arrsync/web/dist | head
```
Expected: dist files changed. (This is the CI freshness gate — the build MUST be Node 24.)

- [ ] **Step 3: Full verification**

```bash
python -m pytest tests/ -q
NEBULARR_TEST_DATABASE_URL=... python -m pytest tests/integration -q
cd frontend && npm run lint && npm run test && cd ..
```
Optionally the full stack smoke: `docker compose up -d --build`, then `cd frontend && npm run test:e2e`, then `docker compose down -v`.

- [ ] **Step 4: Commit**

```bash
git add src/arrsync/web/dist frontend/tests/e2e/critical-flows.spec.ts
git commit -m "feat(webui): automations e2e + rebuilt dist"
```

---

## Task dependency order

1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 (backend, strictly ordered) → 9 → 10 (frontend) → 11 → 12. No parallel-safe splits except 5 (client) which only needs 1; keep the order above for simplicity.

## Out of scope (deliberate, from the spec)

- Nebularr never picks releases (`/api/v3/release` unused); no indexer/download-client integration; no auto-editing of quality profiles; episode-level monitored flips; `when=conforming` actions for series; ledger cooldowns for tag/monitor actions.






