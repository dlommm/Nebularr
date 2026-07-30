# Automations Engine — Design Spec

Date: 2026-07-29
Status: Approved design, pre-implementation
Backlog refs: `v2-int-001` (outbound automation hooks), `v2-int-002` (pluggable rules engine)

## 1. Goal

Let the user declare what their library should look like ("anime = English dub, 1080p minimum, prefer x265") and have Nebularr converge the library toward that state automatically: periodic, rate-limited searches and metadata actions against Sonarr/Radarr, driven entirely by data already synced into PostgreSQL.

Non-goals (v1):
- Nebularr never picks or pushes specific releases (`/api/v3/release` is out of scope). It triggers *arr search commands; the *arr quality profiles and custom formats decide what gets grabbed.
- No download-client or indexer integration.
- No auto-editing of *arr quality profiles (informational audit only).
- No user-authored SQL. All predicates compile from whitelisted fields through a server-side compiler, consistent with the existing reporting-registry invariant.

## 2. Decisions (locked during brainstorming)

| Question | Decision |
| --- | --- |
| How releases are acquired | Trigger *arr search commands; *arr profiles decide grabs |
| Rule actions (v1) | Search missing, search upgrade, apply tags, flip monitored |
| Safety model | New automations start in dry-run; per-rule switch to live; no per-item approvals |
| Engine architecture | Template-instance engine: code-authored whitelisted SQL templates + structured condition builder for custom rules |

## 3. Data model (migration `0012_automations`, chained off `0011_reporting_correctness`)

### 3.1 `app.automation`

One row per user automation.

| column | type | notes |
| --- | --- | --- |
| `id` | bigserial PK | |
| `name` | text unique not null | |
| `template_key` | text not null | e.g. `anime-dub-enforcer`, `resolution-floor`, `custom` |
| `params` | jsonb not null | validated server-side by per-template pydantic model |
| `enabled` | boolean default false | |
| `dry_run` | boolean default true | new rules simulate until user flips |
| `cron` | text not null | validated like `sync_schedule` (croniter + next-fires preview) |
| `timezone` | text not null | IANA, validated |
| `budget_per_run` | int default 10 | clamp 1–100; max actions per run |
| `cooldown_days` | int default 7 | per-item re-action cooldown |
| `state` | jsonb default '{}' | per-automation watermarks (e.g. new-dub watcher's last-seen dub statuses) |
| `created_at` / `updated_at` | timestamptz | |

### 3.2 `app.automation_run`

Run history, same spirit as `app.mal_job_run`.

Columns: `id`, `automation_id` FK, `started_at`, `finished_at`, `status` CHECK in `running | success | partial | failed | dry_run`, `matched_count`, `actions_taken`, `skipped_cooldown`, `skipped_budget`, `details jsonb` (per-item outcomes, per-phase errors, would-do list for dry runs).

### 3.3 `app.automation_action_ledger`

Cooldown memory + idempotency, modeled on `mal.tag_apply_state`.

PK `(instance_name, entity_type, source_id, action_type)` where `entity_type ∈ movie | series | episode` and `action_type ∈ search | tag | monitor`. Columns: `last_fired_at`, `last_automation_id`, `last_run_id`.

The key is **global (not per-automation)** on purpose: two rules matching the same movie must not double-search it inside the cooldown window. Ledger also backs the global daily search cap (count of `action_type='search'` rows with `last_fired_at >= now() - interval '1 day'`).

### 3.4 Column promotion

Add `video_resolution int` (nullable) to `warehouse.movie_file` and `warehouse.episode_file`:
- Backfill in the migration from `payload -> 'mediaInfo'`: parse `mediaInfo.resolution` (e.g. `1920x1080` → 1080) with a fallback regex on the `quality` name (`…-1080p` → 1080); NULL when neither yields a value.
- Populated on upsert going forward in `repository.upsert_episode_file` / `upsert_movie_file`.
- Indexed; makes `resolution_min` predicates cheap. Items at or above the floor (e.g. existing 4K movies vs a 1080p floor) are conforming and never actioned.

## 4. Rule semantics and custom-rule schema

An item is **conforming** when it satisfies every `require` clause. Non-conforming items in scope are candidates for actions, subject to cooldown and budget. Conforming items can optionally receive `when: "conforming"` actions (e.g. unmonitor once the desired version is on disk).

Custom template `params` shape (what the builder UI produces; server compiles to parameterized SQL over whitelisted fields only):

```json
{
  "scope": {
    "media": "movies | series | both",
    "instances": ["sonarr-main"],
    "series_type": "anime",
    "genres_any": [],
    "tags_any": [],
    "monitored_only": true
  },
  "require": {
    "audio_language_any": ["english", "eng"],
    "resolution_min": 1080,
    "video_codec_any": ["x265", "hevc"],
    "quality_any": []
  },
  "actions": [
    { "type": "search_missing" },
    { "type": "search_upgrade" },
    { "type": "tag", "label": "needs-upgrade" },
    { "type": "set_monitored", "value": false, "when": "conforming" }
  ]
}
```

Whitelisted predicate fields (v1): media kind, instance, `seriesType`, genres, tags, monitored, has-file, `audio_languages`, `subtitle_languages`, `video_codec`, `audio_codec`, `quality` name, `video_resolution`, `customFormatScore` (payload), MAL `dub_status`. Operators per field type: any-of / none-of for arrays and enums, min/max for numerics, boolean equals. No free-form SQL, no free-form JSON paths.

Missing vs upgrade: `search_missing` targets scope items with no file; `search_upgrade` targets items whose file fails `require`. Both emit the same *arr search command; whether the grab replaces an existing file is the *arr profile's upgrade/cutoff decision (per the locked acquisition model).

## 5. Built-in templates (v1)

Each template is a code-authored predicate builder plus pre-filled params and default cron; the user tweaks parameters and saves an instance. All compile through the same predicate compiler.

1. **Anime English-dub enforcer** — scope anime series (`seriesType='anime'`) and MAL-linked movies; require English audio + resolution floor. Joins `mal.anime.dub_status`: items with `dub_status = 'none'` are skipped (no dub exists anywhere; searching burns indexer quota), only `dubbed`/`partial` are hunted. Default cron: every 2 days.
2. **New-dub watcher** — items whose `dub_status` transitioned `none → partial | dubbed` since the last run. Detection: the automation's `state jsonb` stores the map of `mal_id → dub_status` seen at the end of each run; the next run diffs current statuses against it and searches only the transitions. Turns the MAL dub dataset into proactive grabs. Default: daily.
3. **Resolution floor** — anything in scope below the resolution param (default 1080) gets an upgrade search. Default: weekly.
4. **Missing-content hunter** — monitored items with no file get a missing search. Default: weekly.
5. **Codec preference** — files not matching the codec list (default x265/hevc) at the target resolution get **tag-only** action by default (`x264-candidate`); the user can switch the action to search. Reflects "prefer x265 but not required."
6. **Language audit tagger** — tags/reports non-English-audio items; no searches. Pure visibility rule.
7. **Custom** — the full builder from §4.

## 6. Execution engine

### 6.1 Scheduler integration

- One APScheduler job per enabled automation, id `automation:{id}`, using the row's cron + timezone. `SyncScheduler.start()` reads `app.automation` alongside `app.sync_schedule`; the existing thread-safe `reload()` picks up creates/edits/deletes (config endpoints already call it).
- Cross-process safety via the existing `app.job_lock` lease (`lock_name = automation:{id}`) with heartbeat, identical to sync runs.

### 6.2 Run pipeline (`AutomationService`, skeleton copied from `CoverageTagSyncService`)

1. Acquire lock, insert `automation_run` row (`running`).
2. Compile predicate → one SQL select of non-conforming (and, for conforming-actions, conforming) items; left-join `automation_action_ledger` to exclude items inside the cooldown window; order never-actioned first, then stalest `last_fired_at`; limit `budget_per_run`. Record `matched_count`, `skipped_cooldown`, `skipped_budget`.
3. Dry-run: write the would-do list into `details`, finish run as `dry_run`. Live: execute actions through `ArrClient` with throttling (§6.3), collecting per-item outcomes and per-phase errors.
4. Upsert ledger rows for fired actions; finish run row (`success | partial | failed`); emit SSE event on the existing `EventBus`; send alert webhook on failure if configured.

### 6.3 Rate limiting (three layers + cooldown)

1. **Per-command throttle** — min-interval gate between `/api/v3/command` posts (pattern copied from `MalApiClient._throttle()`); default 2s, settings knob `automation_command_min_interval_seconds`.
2. **Per-run budget** — `budget_per_run` on each automation (default 10).
3. **Global daily cap** — `automation_max_searches_per_day` (default 100) enforced from ledger counts across all automations; runs that hit the cap record `skipped_budget` and finish `partial`.
4. **Per-item cooldown** — `cooldown_days` via the ledger (default 7); an item is never re-searched by any automation inside its window.

### 6.4 Profile sanity check

When a rule requires a language, the run fetches `/api/v3/qualityprofile` (+ custom formats) once and surfaces a UI warning if no custom format appears to score language/dub attributes: "searches will fire, but your profile may grab non-dub releases." Informational only; no auto-fix in v1.

## 7. ArrClient additions

- `POST /api/v3/command` wrappers: `MoviesSearch {movieIds}`, `SeriesSearch {seriesId}`, `EpisodeSearch {episodeIds}`, `MissingEpisodeSearch`. All go through the existing retry/backoff transport and the new command throttle.
- Monitored flips reuse the existing `PUT /series/editor` / `PUT /movie/editor` bulk endpoints (they accept `monitored`), chunked at the existing 100.
- Tags reuse `ensure_tag_id` + editor endpoints unchanged.
- `GET /api/v3/qualityprofile` + `GET /api/v3/customformat` for the profile sanity check.

## 8. API surface (`routers/automations.py`)

- `GET /api/automations` — list with last-run summaries.
- `POST /api/automations` / `PUT /api/automations/{id}` / `DELETE /api/automations/{id}` — CRUD; server-side pydantic validation per template; mutations call `scheduler.reload()`.
- `POST /api/automations/validate` — cron validity + next fire times (reuses schedule validation) + params check + **match preview**: "would match N items now" via a cheap count of the compiled predicate.
- `POST /api/automations/{id}/run` — manual run-now (async, lock-guarded).
- `GET /api/automations/{id}/runs` — run history; `GET /api/automations/{id}/runs/{run_id}` — per-item detail.
- `GET /api/automations/templates` — template catalog (key, title, description, default params, param schema for form rendering).

Route-table snapshot fixture (`tests/fixtures/route_table.txt`) must be regenerated.

## 9. WebUI

New **Automations** page in primary nav:

- **Template gallery** — cards for the seven templates; "Use template" opens the editor pre-filled.
- **Rule list** — name, enabled + dry-run toggles (dry-run rows visually badged), cron with `CronPreview`, last-run summary (matched / acted / skipped), Run Now. Layout modeled on `SchedulesPage`.
- **Rule editor** — structured form per template; the custom template renders the condition builder (field/operator/value rows over the §4 whitelist). Genre/tag/instance option lists come from existing warehouse queries. Save path runs `validate` first and shows the match-preview count.
- **Run detail sheet** — per-run item list with outcomes (`searched | tagged | monitored | skipped_cooldown | would_do`), reusing `MediaDetailSheet` patterns.

Mechanical steps per `docs/WEBUI_FRAMEWORK.md`: `PATHS` + title, lazy route, nav entry, `api.ts` methods + `types.ts`, `queryKeys` entry, page + components, `npm run build` (Node 24) to refresh `src/arrsync/web/dist`.

## 10. Settings

Env-tier (`config.py` defaults): `automation_command_min_interval_seconds` (2.0), `automation_max_searches_per_day` (100), default cooldown/budget clamps. No new DB feature-flag store needed — enable/dry-run live per-row on `app.automation`.

## 11. Testing

- **Unit**: predicate compiler (params → SQL text snapshots incl. cooldown join and budget ordering); `AutomationService` with `FakeSession` + arr fakes covering budget exhaustion, cooldown skips, dry-run, partial failures, daily-cap; per-template pydantic validation; scheduler registration of `automation:{id}` jobs and reload behavior.
- **Integration (real Postgres)**: predicate correctness against seeded warehouse rows — dual-audio `["jpn","eng"]`, NULL `audio_languages`, 4K-above-floor exemption, MAL `dub_status` join, resolution backfill correctness.
- **Frontend**: vitest for condition builder and rule list; route snapshot regenerated.
- **E2E**: extend `critical-flows.spec.ts` — create automation from template, observe dry-run results.

## 12. Mechanical gates checklist

- [ ] Alembic revision `0012_automations` chained off `0011_reporting_correctness` (raw DDL, no autogenerate).
- [ ] `tests/fixtures/route_table.txt` regenerated for new routes.
- [ ] `src/arrsync/web/dist` rebuilt on Node 24 (CI freshness diff).
- [ ] README API-surface table + mermaid diagram extended; new doc `docs/AUTOMATIONS.md`.
- [ ] `Backlog/V2_BACKLOG.md` items `v2-int-001` / `v2-int-002` marked in-progress → done.
