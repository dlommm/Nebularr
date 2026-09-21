# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [2.9.3] - 2026-09-21

A hotfix for v2.9.2. The multi-episode orphan fix shipped a join the planner cannot
index, and on a real library it took every query that reads an episode with its file
past the statement timeout — automations, reports and the library listing alike.
Migration **0015** runs automatically and also reclaims what 0013 and 0014 left
behind; no re-sync, no manual step.

### Fixed
- **Series completeness, episode reports and the library listing no longer time
  out.** v2.9.2 joined an episode to its file through a `CASE`, which is opaque to
  the query planner: it cannot push either branch down to an index, so the join
  degraded to a materialised scan of the whole `episode_file` table replayed once
  per episode row. Rewritten as an `OR` of two equalities, which lets the planner
  `BitmapOr` the `episode_file` primary key against
  `idx_episode_file_episode_instance`. The rows it matches are identical — the
  fallback arm stays guarded on `episode_file_id is null`, so the two arms remain
  mutually exclusive exactly as the `CASE` made them.

  Measured on a 133k-episode / 111k-file library, against the shipped rule
  *"Retire finished shows"*:

  | Query | v2.9.2 | v2.9.3 |
  | --- | --- | --- |
  | Series-completeness count | timed out (>180s) | 470 ms |
  | Episode inventory (reports + library) | timed out (120s) | 472 ms |

  Worth stating plainly, because it was checked: **no amount of database tuning
  fixes this.** Re-measured with a 16x larger buffer pool, `random_page_cost` set
  for SSD, zero table bloat and a warm cache, the v2.9.2 query still exceeded 180
  seconds. A `CASE` join is unindexable by construction.

- **The join now has one definition instead of five.** It had been hand-copied into
  the rule compiler, both library listings and both reporting queries, and all five
  copies carried the same defect. They now read `warehouse_sql.EPISODE_FILE_JOIN`,
  and a test fails the build if any source file spells the predicate out again.

### Changed
- **Migration 0015 reclaims the heap 0013 and 0014 left behind.** Both bulk-rewrote
  an entire table, and an `UPDATE` leaves the old tuple dead — autovacuum frees that
  space for reuse but cannot return it to the filesystem, so each table stayed at
  roughly twice its necessary size. Measured with `pgstattuple` before the
  migration: `episode` 420 MB holding 186 MB of live tuples (55.1% free),
  `episode_file` 430 MB holding 188 MB (54.0% free). `VACUUM FULL ANALYZE` on both
  took **1031 MB to 583 MB in under 8 seconds** on that library. The `ANALYZE` also
  supplies statistics 0013 and 0014 never refreshed after their bulk updates. A
  one-time correction, not a scheduled job — ordinary sync churn under a healthy
  autovacuum does not bloat these tables.
- **Seven indexes nothing reads are dropped**, each verified at `idx_scan = 0` over
  statistics that had never been reset. Three could never have been used at all:
  `ix_episode_episode_file_id` (added by 0014) indexes the driving side of the join
  rather than the side looked up, and the `video_resolution` and `quality` indexes
  are defeated by their own predicates, which wrap the column in `coalesce()`. None
  was free — every one was maintained on every upsert, and a full reconcile upserts
  133k episodes and 111k files. `idx_episode_file_size` and `idx_movie_file_size`
  are kept; the large-files view still uses them.
- **The bundled Postgres is no longer left at stock defaults.** Both compose files
  now pass a tuned `command:`, every value overridable from `.env`
  (`POSTGRES_SHARED_BUFFERS`, `POSTGRES_WORK_MEM`, `POSTGRES_RANDOM_PAGE_COST` and
  the rest), plus `shm_size` so parallel workers do not die on Docker's 64 MB
  `/dev/shm`. Stock `shared_buffers` is 128 MB against ~850 MB of hot tables, which
  measured a **10.9% cache hit ratio**; healthy is above 95%. Defaults here suit
  about 8 GB of RAM — see `docs/DATABASE-TUNING.md` for the per-RAM table and for
  how to confirm the change took.

### Added
- `docs/DATABASE-TUNING.md` — what to set, why each setting matters to this
  workload, how to size it to your host, and how to verify it worked. Includes what
  tuning will *not* fix, since Postgres has no auto-indexing and autovacuum already
  handles what it handles.

## [2.9.2] - 2026-09-20

Two more reasons a completeness rule read the wrong state, plus the scope-staleness
work. Migration 0014 runs automatically and needs no re-sync.

### Fixed
- **A file shared by several episodes no longer orphans all but one.** A double
  episode ("S02E01-E02") is one file that Sonarr returns on both episode records,
  but `warehouse.episode_file` is keyed on the file and carries a single
  `episode_source_id` — so upserting it for E1 then E2 left one row linked to
  whichever was written last. The other episode reported `hasFile: true` with no
  file row and read as a *missing file*, which under series completeness
  disqualified the whole show. `warehouse.episode` now carries `episode_file_id`
  (migration **0014**, backfilled from the retained payload), and the rule
  compiler, both library listings and both reporting queries join on it. Measured
  on a real library: 131 orphaned episodes against 123 multi-episode files, and 7
  of 340 sampled ended shows blocked solely by this — Mr. Robot, Heroes, Star Trek:
  Voyager among them.
- **Upgrades no longer leave a stale file row behind.** An upgrade arrives as a new
  `episodeFile`/`movieFile` id, so upserting it alone left the row it replaced live
  and the item presenting two files, one gone from disk — and conformance counts
  every live row. Both the episode and movie webhook paths now tombstone the
  superseded row (movies had the identical bug), keyed on a file actually written
  rather than on absence, since `list_episodes` only requests `includeEpisodeFile`
  where supported.
- **The editor's live preview counted the wrong set.** It used the compiler's
  default sense, so a retirement rule reported the shows that *fail* its spec —
  the opposite of what it acts on. `primary_sense()` is now shared by the executor
  and the preview. Previews and run details also state what the number counts,
  since a completeness query returns shows rather than episodes.

### Added
- **Scope refresh on every incremental tick.** The incremental pass is
  history-driven, and an Arr's history records grabs, imports and deletions — never
  a monitor toggle. Unmonitoring a show in Sonarr produced no event, the series was
  never refetched, and `warehouse.series.monitored` stayed wrong until the next full
  sync; on a real library that left ~520 series stale, and `monitored` is the flag
  automations scope on. One list call per instance now re-reads
  `monitored`/`status`/`path`/genres. Upsert-only by design — a short list response
  must never read as "these were deleted" — so removals stay the full/reconcile
  pass's business. Disable with `INCREMENTAL_SCOPE_REFRESH=false`.
- A separate opt-in **`full`** sync schedule, seeded *disabled* at weekly with its
  own `FULL_SYNC_CRON`. Reconcile already performs the same full sync, so enabling
  both runs two of them.

### Changed
- The seeded **reconcile** schedule is now **daily** (was weekly). It is a full sync
  under another name, and was the only pass that noticed a monitor toggle — weekly
  meant up to seven days of drift, and a restart across the scheduled minute bought
  another seven, since a missed cron does not backfill. Existing installs keep
  whatever is already in `app.sync_schedule`.

## [2.9.1] - 2026-09-20

Fixes the resolution comparison that made 2.9.0's series-completeness rules
exclude finished shows. One additive migration (0013) runs automatically and
needs no re-sync.

### Fixed
- **`resolution_min` now means the quality tier, not the literal frame height.**
  A letterboxed 1080p release is 1920x960 (2:1) or 1920x800 (2.39:1), and 0012
  stored `video_resolution` height-first — so those read as 960 and 800 and failed
  a `resolution_min: 1080` floor, despite being 1080p to both the Arr and the
  operator. Latent until 2.9.0: on its own a wrong height mis-sorts one file, but
  under series completeness one failing episode disqualifies an entire show, so it
  swallowed complete series wholesale. Measured on a real library (one `ended` TV
  library, specials excluded): 9,443 episodes failed a 1080 floor against 4,374 at
  720 — the ~5,000 difference being 1080p-tier files whose stored height was
  800–1000.
- `video_resolution` is now derived from the Arr's own
  `quality.quality.resolution` (the number its UI shows), then the quality name,
  then frame **width** mapped to a tier (1920 wide is 1080p whatever the crop),
  then height as a last resort. Migration **0013** re-derives every existing row
  from the retained payload — no re-sync required, and a row that yields nothing
  keeps the value it had.

## [2.9.0] - 2026-09-20

Automations release: rules can now act on the set of items that *pass*, which is
what makes "this show is finished, retire it" expressible. Adds per-library
folder scoping, series completeness, six templates aimed at gaps neither Sonarr
nor Radarr fills, and a rebuilt automations page. No DB migration.

### Added
- **Series completeness.** A series conforms when *no* aired in-scope episode
  fails — compiled as an anti-join, deliberately not a rollup of conforming
  episodes, since a show with one good episode out of forty conforms to nothing.
  A missing episode and an out-of-spec file disqualify a show through the same
  predicate, so "do I have every episode, all in spec" is one question. This is
  what made series-level `when=conforming` unsafe before now, and why it was
  restricted to movies.
- **Tag actions can target the conforming set** (`when=conforming`), and tag /
  monitor reconciles resolve one row set per `when` — so one rule can tag the
  finished shows and what still needs fixing without either borrowing the
  other's set.
- **Scope: series status** (`series_status_any`, e.g. ended), plus
  `include_specials` and `include_unmonitored_episodes`. The latter two exist
  for the two ways a show reads as unfinished for the wrong reason: a missing
  season-0 special, and a gap that was papered over by unmonitoring it.
- **Requirement: subtitle language** (`subtitle_language_any`), for libraries
  where no dub exists and English subtitles are the actual requirement — a
  question neither Arr can answer.
- **Scope: folder location** (`root_folders_any`), matched against synced
  library paths so per-library specs are one rule each. Episodes inherit their
  series' folder. Options come from `GET /api/automations/root-folders`, derived
  from the warehouse rather than a live Arr call, so a saved folder the library
  no longer reports stays selected instead of vanishing.
- **Six templates** for what both Arrs lack — both reason per-episode, and
  neither ever stops monitoring something it has satisfied:
  `complete-series-tagger` (tag finished, in-spec shows),
  `series-done-unmonitor` (and retire them), `movie-done-unmonitor`,
  `series-spec-audit` (tag what is not in spec, with reasons),
  `incomplete-ended-series` (a gap in a running show is normal; in an ended one
  it is permanent), and `foreign-subs-audit`.
- **Failure reasons in run details.** `failure_reasons` and `failure_worst`
  answer "what has to be fixed before this show can retire", derived from
  columns the candidate select already returns — no extra query. Series rules
  group by show: the fault sits on an episode, the show is what you act on.

### Changed (web UI)
- The automations page is a list of rules worked on in a right-hand sheet, so
  the list never reflows underneath you. Each row carries one primary action
  (Run now) with the rest behind an overflow menu; templates appear inside the
  sheet when creating rather than permanently on the page.
- The editor leads with the rule as a sentence and validates live, reporting how
  many items it would act on right now. A conforming clause states the condition
  it compiles to — "where every aired episode is english and eng audio and 1080p
  or better" — rather than "once it conforms", which would hide that conformance
  is asked of every episode and answered about the show. Series actions say "the
  show", never "it".
- Going live and deleting confirm first. Leaving dry-run is the only control
  that converts a simulation into real indexer traffic; every other toggle is
  reversible and stays one click.
- Run detail renders failure reasons as a sentence plus a what-to-fix-first
  list. An unrecognised reason code is shown verbatim rather than guessed at.

### Fixed
- Rule validity no longer leaks between rules: opening a second rule in the
  sheet could inherit the first one's validity state.
- The editor's tag control edits only the action it is bound to. A rule may
  carry a conforming and a non-conforming tag at once, and editing the label
  would otherwise collapse both onto one label.
- The media switch no longer strips conforming actions when leaving movies
  (they now work for series, so stripping would delete the rule); it drops
  `series_status_any` when entering movies instead, which the backend rejects.

### Security
- `react-router-dom` 6.30.4 → 7.18.2, closing three advisories (open redirect
  and injection). The v6 patch range was EOL.
- Two rounds of transitive npm bumps clearing HIGH advisories in build/test
  dependencies: `browserslist`, `fast-uri`, `js-yaml`, `hono`, `qs` and others.
  Lockfile only, no overrides.

## [2.8.0] - 2026-07-30

Automations engine. Backfilled entry — this release shipped without changelog
notes; reconstructed from git history and `docs/AUTOMATIONS.md`.

### Added
- **Automations engine.** Rule templates with their own cron and timezone,
  per-rule `budget_per_run`, `cooldown_days`, `enabled` and `dry_run`. New rules
  start in dry-run: runs record what they *would* do until you flip the switch.
- Whitelist-only SQL predicate compiler — user params contribute bind values,
  never SQL text — plus a rule schema and template registry.
- Run executor with per-run search budget, per-item cooldown ledger, dry-run
  fidelity, and actions diffed against live Arr state before any mutation, so a
  stale warehouse snapshot can never drive a write.
- Four layers of rate protection: minimum interval between Arr command posts, a
  per-run search budget, a global daily search cap, and a per-item cooldown
  keyed globally so two rules can never double-search one item.
- Arr client: search commands, monitored editors, quality-profile and
  custom-format reads, and a command throttle.
- REST surface with a validation preview and run-now; per-automation cron jobs;
  automation / run / action-ledger store; run history in the web UI.
- Migration 0012: automations tables, action ledger, and `video_resolution`
  columns on the file tables, promoted into the sync upserts.

### Fixed
- The MAL dub gate joins via a single-row lateral, not a plain join:
  `mal.warehouse_link` is not unique on `warehouse_source_id`, so one series
  split across several `mal_id`s would otherwise fan out and duplicate
  candidate rows.
- Search budget depletes across instances within a run rather than resetting
  per instance; tag and monitor targets are unbudgeted (they are idempotent
  live-state diffs, not searches).
- Dub observations are buffered per instance and discarded if that instance's
  search phase fails, so a none→dubbed transition is never watermarked as seen
  against a search that never fired.
- Failure alerting for automation runs; 409 on rename collision in the update
  endpoint.

## [2.7.0] - 2026-07-18

Security-and-correctness release from a third full-application audit: two
critical fixes (unauthenticated asset path traversal, a setup-bootstrap gap),
a round of sync/webhook-queue correctness fixes, reporting-accuracy
corrections, and a webui overhaul. One additive DB migration (0011) runs
automatically.

### Security
- **Asset path traversal fixed.** `/assets/{path}` allowed unauthenticated
  arbitrary file reads from the host filesystem. If an instance was ever
  reachable from the internet, upgrade immediately and rotate
  `APP_ENCRYPTION_KEY` and your database credentials — treat any secrets that
  instance held as compromised.
- **Setup bootstrap token.** While setup is incomplete and auth is
  unconfigured, all mutating `/api/setup/*` endpoints (including
  `/api/setup/skip`) now require an `X-Setup-Token` header. The token is
  printed at `WARNING` in the container log at startup, and the setup wizard
  prompts for it. The token is excluded from the in-app log buffer
  (`/api/ui/logs`) — it only ever appears on container stdout.
- **`/metrics` now requires the bearer API token when auth is enabled**
  (previously open to anyone who could reach the port). An escape hatch,
  `app.metrics_public=true`, restores the old unauthenticated behavior for
  scrapers that can't send a token; the setting survives `reset-data`. Open
  as before when auth is disabled entirely.
- **`APP_ENCRYPTION_KEY` present-but-invalid now fails startup loudly**
  (previously: silent fallback to plaintext storage, with an empty string
  where the decrypted value should be).
- Key files are written atomically (0600, `O_EXCL`) — no more world-readable
  window during creation.
- Login with a non-ASCII password and `AUTH_RECOVERY_PASSWORD` set no longer
  500s and now counts toward lockout as intended; the rate-limiter's map
  eviction no longer wipes every existing lockout when the map fills up.

### Fixed
- **Postgres setup bootstrap** (`initialize-postgres`/`bootstrap-database`)
  was broken under psycopg3 — `CREATE`/`ALTER ROLE` don't accept bound
  parameters. It now composes a safely quoted literal instead.
- **Webhook queue claims carry a 120s visibility timeout.** Overlapping
  drains could previously double-process an in-flight job, inflate its
  attempt count, or dead-letter it prematurely.
- **Per-source advisory locks serialize full-sync tombstoning against
  webhook/incremental writers** on Postgres (SQLite was already
  single-writer, so it needed no change).
- **A misconfigured Arr base URL that returns HTML or another non-list 200
  now fails the sync loudly** (`ArrResponseError`) instead of "succeeding"
  with zero rows and tombstoning the whole library. Separately, an empty
  fetch against a non-empty warehouse now refuses to tombstone and fails the
  run rather than wiping it.
- **Sonarr `SeriesDelete` webhooks no longer dead-letter** (episode refetch
  was happening before delete handling, so the referenced series was already
  gone); episode/file delete handlers now read the real `episodes[]` array
  payload shape instead of assuming a different structure.
- **History paged fallback no longer skips events that share the exact
  watermark timestamp**; transient errors no longer permanently disable
  `history/since` (only a real 404/405 does that now).
- **Webhook jobs for a missing or disabled integration fail visibly**
  instead of silently syncing from the default env client under that
  instance's name.
- **Sync-run summaries update by row id**, so overlapping runs of the same
  (source, mode, instance) can no longer finish each other's summary rows.
- **Health lag is computed per (source, instance) with max-per-source** — a
  single stalled instance can no longer be masked by healthy ones; instances
  that have never synced report unknown lag, not zero.
- **Dead-letter replay and single-job requeue now trigger an immediate
  drain** (previously they sat queued until unrelated activity nudged the
  worker).
- **`reset-data` also truncates `warehouse.library_stat_snapshot` and
  `app.integrity_audit_run`**, so stale dashboards can no longer resurface
  after a reset; the confirm dialog's keep-list is accurate and now also
  covers queue/alert/retention/auth/webhook-secret/metrics settings.
- **MAL tag/coverage runs that fail on every instance are now marked
  failed** (previously reported success).
- `mal.dub_list_fetch` raw payloads are now pruned by the retention sweep
  (kept newest 5 per source; previously unbounded growth).
- **Reporting correctness:** "Episodes With No Subtitle Languages" and both
  unmonitored-audit panels no longer count episodes with no file at all;
  the missing-English-audio stat and its table now agree (view rebuilt in
  migration 0011); the large-files panel joins by source id instead of
  title (duplicate titles no longer multiply rows); lag panels honor the
  instance filter; webhook cards are labeled "(all instances)".
- **Reporting CSV panel export executes exactly that one panel's query**
  (previously it ran the whole dashboard).
- **Unsuffixed `/hooks/{source}` with multiple enabled integrations now
  returns 409** instead of attributing the event to a phantom "default"
  instance; single-integration deployments are unaffected.
- **Event-loop hygiene:** roughly 40 handlers, scrypt password hashing,
  egress DNS checks, and MAL ingest DB writes moved off the event loop — the
  UI/SSE no longer stall during logins, config saves, or MAL ingests.
- **Cold-loading the app with an already-expired session now reaches the
  login page again** (the session-expiry dialog is mounted app-wide, not
  just on authenticated routes).

### Fixed (web UI)
- Session expiry shows a re-login dialog instead of hard-redirecting and
  destroying unsaved form edits; the session-expired latch resets on
  `/login` so the dialog can't reopen right after you sign back in.
- Saving one integration/schedule row no longer wipes unsaved edits in
  other rows; queue-policy drafts survive failed saves; MAL settings save no
  longer overwrites toggles while config is still loading.
- Library: switching shows resets the stale season filter; episode CSV
  export uses the on-screen sort; the instance filter is hidden where it did
  nothing (drilldown); row keys are instance-qualified; there's an empty
  state on all-episodes.
- Reporting: query failures render an error with retry (previously a blank
  page); changing one panel's filter no longer resets every other panel's
  pagination; back/forward navigation no longer resurrects stale filters.
- MAL: pipeline buttons show a busy state and can't double-fire; the
  WorkStatusPanel is embedded for live progress.
- Setup wizard: labeled inputs, an editable port field (no more snap-to-5432),
  Skip reachable from step 1, and a bootstrap-token prompt.
- SSE: reconnects immediately when the tab becomes visible; invalidations
  are debounced (no refetch storms during queue drains); finished syncs
  refresh library views; drilldown views refresh on webhook processing.
- Error boundary recovers via navigation ("Go home" works); setup-status
  failures show retry instead of an infinite spinner; the command palette is
  keyboard-accessible (focus trap, arrow keys, filter); the nav sidebar no
  longer remounts on every keystroke; the `/` shortcut no longer steals
  focus from other inputs; saved views survive rapid save/delete
  (optimistic update plus a live-cache base); tables keep their previous
  data while paging instead of flashing blank.
- v2.6.0 leftover: the reset-data confirm dialog now enumerates the
  truncate/keep lists accurately.

### Changed
- `clamp_limit(0)`-class inputs return the per-endpoint default instead of a
  50k-row maximum; CSV exports keep full-dataset semantics (the cap is
  unchanged at 100k).
- Library pagination tiebreaks on `(instance_name, source_id)` for stable
  ordering with multiple instances.
- New indexes: `sync_run(started_at desc)`, `webhook_queue(received_at desc,
  id desc)` (migration 0011).
- `GET /api/setup/initial-sync-status` now returns per-source `results`
  (plus an optional `error`); a failed source no longer aborts the remaining
  sources.
- `?wait=false` sync-trigger 409 detail text is simplified; the `reset-data`
  response message text is updated to match its accurate keep-list.

## [2.6.0] - 2026-07-15

Bug-fix and operator-experience release from a second full-application audit:
14 fixes (including three v2.5.0 regressions) plus ten improvements. No DB
migration — all new settings live in `app.settings`.

### Fixed
- **Scheduling honors per-schedule timezones.** The scheduler read only the cron
  expression, so a schedule set to e.g. `America/New_York` still fired on the
  server's timezone. It now uses each row's own timezone.
- **Disabling the incremental/reconcile schedules actually stops them.** They
  were added to the scheduler unconditionally and silently reverted to the
  env-default cron when toggled off. All schedules are now gated on their enabled
  row. Webhook *retry* draining moved to its own always-on 5-minute job, so
  retrying jobs never stall regardless of which schedules are enabled.
- **Library browsing and CSV exports no longer stall the server.** The library
  endpoints ran blocking queries on the event loop, and CSV exports buffered up
  to 100k rows in memory. They now run off-loop and stream the CSV in chunks.
- **SIGTERM no longer leaves phantom "running" jobs.** Queued syncs and the MAL
  backlog get a grace period on shutdown, their finalizers survive cancellation,
  and a startup sweep marks any leftover `running` rows failed.
- **Sonarr incremental deletes tombstone episode files too** (previously only the
  series and episodes were marked deleted, so orphaned file rows kept counting
  toward totals until the next full sync).
- **The legacy `/hooks/{source}` URL works again for renamed integrations.** A
  v2.5.0 change required an integration literally named `default`; single-instance
  users who renamed theirs got a 403. The unsuffixed route now accepts any enabled
  integration and attributes the event to it.
- **Header search keeps your Library view.** Searching from the top bar preserved
  neither the current mode (shows/episodes/movies) nor filters; it now carries
  them through.
- **Live event stream backs off and prompts re-login.** On an expired session the
  SSE stream reconnected every 5s forever; it now uses exponential backoff (to
  60s) and, after repeated failures, checks auth and redirects to login.
- **Reporting "Export CSV" exports the full dataset** (it was silently capped at
  the on-screen row limit).
- **Applying a saved "default" view now resets filters** instead of doing nothing;
  the reporting table pagination resets when toggling "Ignore Season 0"; the
  webhook-jobs pager no longer shows "1–0" or pages past the end; the setup wizard
  no longer reverts field edits when you move between steps.
- **The MAL ingest lock heartbeat runs off the event loop** (it briefly blocked
  it every 5 minutes).

### Added
- **Test-connection button for Sonarr/Radarr integrations** — verify base URL and
  API key before saving, with an inline version/error result.
- **Cron validation with a next-run preview** on the Schedules page and setup
  wizard: typos are caught as you type and Save is blocked while invalid.
- **Bulk webhook requeue** (`POST /api/webhooks/requeue-bulk`) plus real
  pagination with totals on the webhook-jobs table.
- **Per-channel notification tests** — test each Discord/Slack/ntfy webhook and
  email target individually, with per-target results.
- **First-run onboarding checklist** on the Dashboard (connect Arr → full sync →
  schedules → optional webhook secret), dismissable and auto-hiding when done.
- **Server-side saved views** (`GET/PUT /api/config/saved-views`) so views survive
  a browser change; existing localStorage views migrate automatically.
- **Configurable queue policy** (`GET/PUT /api/config/queue`): batch size, max
  attempts, and retry backoff, previously hardcoded.
- Reporting tables gain an "Export view" button for exactly the rows as filtered
  on screen, alongside the full-dataset export.

### Changed
- **`POST /api/admin/reset-data` now preserves auth, the webhook secret, and
  alert/retention/queue settings.** Previously it wiped `app.settings` wholesale,
  silently disabling authentication while leaving integration API keys intact.
  The confirm dialog now enumerates exactly what is wiped versus kept.
- Alert notification delivery no longer holds its lock across network I/O, so a
  slow or unreachable webhook can't block config saves.
- `GET /api/ui/webhook-jobs?paged=true` returns `{items, total, limit, offset}`;
  the bare-list form remains the default for existing callers.
- `POST /api/config/alert-webhooks/test` now returns a per-target `results` array
  (the `status` field is preserved for older callers).

## [2.5.0] - 2026-07-14

Polish and hardening release from a full-application audit: incremental sync
now actually ingests data, long operations run as background jobs the UI can
follow live, tag sync can no longer overwrite edits made in Sonarr/Radarr, and
a set of security, performance, and UX fixes land across the stack. One
additive DB migration (0010) runs automatically.

### Fixed
- **Incremental sync now ingests changes.** It previously fetched history,
  counted events, and advanced a watermark without writing a single row (and
  queried `/api/v3/history` with a `since` parameter the Arr apps ignore).
  It now uses `GET /api/v3/history/since?date=<watermark>` (with a bounded
  newest-first page walk as fallback for older Arr builds, chosen via a new
  capability probe), re-fetches every referenced series/movie, upserts it with
  its episodes/files, tombstones children a refresh no longer returns, and
  advances the watermark only after a successful ingest. Warehouse freshness
  between weekly full syncs no longer depends solely on webhooks.
- **Tag sync no longer clobbers Sonarr/Radarr edits.** The MAL dub tag sync and
  the coverage tag sync used to PUT the last-synced warehouse payload back to
  the Arr apps, silently reverting any monitored/profile/path change made since
  the previous sync. Both now diff desired tags against live Arr state and
  apply deltas via the bulk tag editor endpoints (`/series/editor`,
  `/movie/editor`) — only tags can change.
- **Long jobs no longer fake-fail in the UI.** Every browser request aborted at
  30s while full syncs and MAL backlog imports ran inside that same HTTP
  request — the UI reported a timeout while the server kept working. Manual
  syncs from the UI now queue as background tasks (202) with live progress via
  the existing work-status/SSE panel; `POST /api/sync/{source}/{mode}` keeps
  its blocking behavior by default for scripts (`?wait=false` opts out). The
  unbounded MAL "import all" runs as a tracked `ingest_backlog` job — no more
  "keep the tab open".
- **Job locks survive long runs**: the sync and MAL-ingest locks are now
  re-leased every 5 minutes for the whole run, so a sync longer than the 30-min
  lease can no longer be joined by a duplicate concurrent run.
- Webhook payloads with JSON `null` for `series`/`episode`/`movie` no longer
  crash the queue worker into retry/dead-letter.
- Header search now works when the Library page is already open; the logs view
  only auto-scrolls while you are at the bottom; the Library "Export CSV"
  button is disabled until a show is selected in drilldown mode; `fmtDate` no
  longer renders "Invalid Date"; Setup/Login pages get a proper error boundary
  instead of a blank page on render errors.
- The Unraid compose template no longer pins the four-releases-old `2.0.0`
  image tag; the version-sync gate and `bump-version.sh` now cover it so it
  cannot drift again, and the template requires `POSTGRES_PASSWORD` instead of
  defaulting to a known value.

### Added
- **Per-instance webhooks**: `POST /hooks/{source}/{instance}` attributes
  events to the named integration (the bare route keeps targeting `default`),
  the instance is stamped into the payload before deduplication, and unknown or
  webhook-disabled instances are rejected. Multi-instance setups no longer
  apply every webhook to the default instance.
- **Request-time egress enforcement**: outbound Arr and alert-webhook requests
  re-resolve and re-check the target against the egress policy on every call
  (previously config-time only), closing the DNS-rebinding gap.
- **Session revocation**: session cookies embed an epoch that bumps on every
  password change, so old sessions die immediately (existing sessions survive
  the upgrade itself).
- `TRUSTED_PROXIES` (IPs/CIDRs): when set, the login rate limiter keys on the
  real client from `X-Forwarded-For` instead of the reverse proxy's address.
- Webhooks are refused (403) while the shared secret is still the shipped
  default `changeme`.
- Success toasts for manual actions (syncs, requeues, resets, replays), and
  destructive resets now refresh the Library/MAL views immediately.
- Migration 0010: join indexes on `warehouse.episode_file`/`movie_file` and
  partial instance indexes on `series`/`movie` for the hot library queries;
  webhook dedupe narrowed to open jobs so re-sent payloads re-queue after
  completion; `ingest_backlog` job type.
- Release workflow scans the image (Trivy, same policy as CI) before anything
  is pushed to Docker Hub; CI runs with least-privilege `contents: read` and
  the compose+Playwright smoke now also runs on PRs that touch the stack.

### Changed
- `/api/status` serves a short-TTL cached health payload refreshed by the
  60s background loop instead of re-running ~8 queries per poll; MAL/Jikan
  clients reuse one HTTP client across retries; dead-letter webhook rows are
  now pruned by the retention job (they previously accumulated forever);
  4xx responses from Arr are no longer pointlessly retried.

## [2.4.1] - 2026-07-08

### Fixed
- **Dual-audio files were counted as non-English**: Sonarr/Radarr join
  multi-track `mediaInfo.audioLanguages` with slashes (e.g. `jpn/eng`), but the
  sync parser only split on commas, so a dual-audio file whose release-parsed
  language was Japanese ended up stored as `["japanese", "jpn/eng"]` and failed
  the English match — flagging fully dubbed dual-audio seasons as
  `partial-english` and inflating the "Episodes Missing English Audio" report.
  The parser now splits audio and subtitle language strings on `/`, `,`, and
  `|`. **After upgrading, run a Reconcile (or Full) sync** so stored episode/
  movie file rows are re-parsed, then run the coverage tag sync; affected
  series flip to `fully-english`.

## [2.4.0] - 2026-07-08

Dubbed-anime curation release: a multi-source English-dub database and
episode-level coverage tags that surface, inside Sonarr/Radarr, which series
actually have all-English files. One additive DB migration (0009) runs
automatically.

### Added
- **Multi-source dub database**: ingest now reads MAL-Dubs' previously ignored
  `incomplete` array and adds [MyDubList](https://mydublist.com) (CC BY 4.0,
  MAL-id keyed, configurable confidence tier `low|normal|high|very-high`) as a
  second source. Per-source membership is stored in `mal.anime_dub_source`
  (migration 0009) so the union and per-title source agreement stay queryable;
  each source is individually toggleable under Integrations → MyAnimeList and
  fetches skip unchanged lists per source (SHA-256). A single source failing no
  longer fails the ingest run.
- **English coverage tags** (`fully-english` / `partial-english`): a new
  `coverage_tag_sync` job computes per-series English-audio coverage from your
  own episode files (view `warehouse.v_anime_series_english_coverage`, scoped
  to monitored, already-aired episodes of `seriesType: anime`) and reconciles
  the two mutually exclusive tags in Sonarr. `fully-english` means every
  monitored aired episode is downloaded with an English audio track;
  `partial-english` means at least one downloaded file lacks one (empty audio
  metadata counts as lacking, consistent with the language audit). Radarr anime
  movies (MAL-linked or `anime` genre) get the same tags via
  `warehouse.v_anime_movie_english_coverage`. Off by default — enable under
  Integrations → MyAnimeList; runs at 04:30 UTC after the dub tag sync, or on
  demand via `POST /api/mal/coverage-tag-sync` / the MAL page button.
- **English Dub Coverage dashboard** (`english-dub-coverage`): per-series
  "N non-English of M aired" table with dub-list fixability (dubbed / partial /
  not-listed + how many sources agree), the same for movies, an episode-level
  "files to replace" drilldown, and stat tiles for fully/partially covered
  series and movies. CSV export works like every other panel.
- `GET /api/mal/overview` now reports `partial_total`, per-source id counts,
  and coverage tallies; `GET /api/mal/job-runs` accepts
  `job_type=coverage_tag_sync`; the MAL page shows partial-dub counts and the
  MAL-Dubs / MyDubList attribution.

### Changed
- `mal.anime.is_english_dubbed` is now derived from the union of enabled
  sources (dubbed **or** partially dubbed counts). Titles that are only
  partially dubbed or only known to MyDubList now receive the
  `English-Dubbed-Anime` tag and enter the MAL/Jikan enrichment backlog —
  expect a one-time backlog bump after upgrading. A new `mal.anime.dub_status`
  (`none|partial|dubbed`) and `dub_source_count` record the distinction. An id
  now loses the flag only when **no** enabled source lists it.

## [2.3.0] - 2026-07-06

Operator-experience release: near-real-time webhook processing, a dedicated
MyAnimeList page, dead-letter management, data-integrity audits, retention
policies, and new notification channels. One additive DB migration (0008) runs
automatically.

### Added
- **Near-real-time webhook processing**: incoming Sonarr/Radarr webhooks now
  wake a debounced background drain (~2s) instead of waiting for the next
  incremental cron tick (previously up to 30 minutes). The cron drain remains as
  a safety net, and a new `webhook.processed` SSE event refreshes the UI within
  seconds of processing.
- **MyAnimeList page** (`/mal`): dub-pipeline overview stats (dubbed totals,
  fetch progress, link coverage), the ingest/matcher/tag-sync runners with
  structured result rendering (moved from Sync & Queue → Manual), job-run
  history from `app.mal_job_run` with a type filter, and an "unmatched dubbed
  anime" table linking out to MAL. New read routes `GET /api/mal/job-runs` and
  `GET /api/mal/overview`.
- **Data-integrity audit**: compares cheap Sonarr/Radarr API aggregates
  (series/movie counts, file counts, sizes) against warehouse counts per
  instance and records drift in a new `app.integrity_audit_run` table
  (migration 0008). Run on demand from Sync & Queue → Manual
  (`POST /api/operator/integrity-audit`), on an opt-in `integrity_audit`
  schedule (seeded disabled, default weekly), and surfaced as an "Integrity
  Audits" panel on the Sync Operations dashboard. Detected drift degrades the
  sync health dimension to warning (`integrity_drift:<sources>`).
- **Webhook queue management**: the Sync & Queue → Webhooks tab gained a status
  filter, pagination, a per-row **Requeue** button for dead-letter/retrying
  jobs (wiring the previously unused `POST /api/webhooks/requeue/{id}`), and
  bulk replay-dead-letter actions.
- **Retention policies**: `warehouse.sync_run` and
  `warehouse.library_stat_snapshot` previously grew forever; the cleanup pass
  now prunes them per a configurable policy (defaults: 90 days of run history,
  365 days of storage snapshots, 30 days of processed queue rows; 0 = keep
  forever). Editable under Schedules → Data retention via new
  `GET/PUT /api/config/retention` routes. Synced library data is never pruned.
- **Email (SMTP) and ntfy notifications**: alert notifications can now also go
  to email (STARTTLS or implicit TLS on port 465; password encrypted at rest)
  and ntfy (auto-detected for ntfy.sh, `ntfy://host/topic` for self-hosted),
  alongside Discord/Slack/generic webhooks, honoring the same per-event
  toggles and minimum state.
- **Logout button**: the header now shows a logout action when authentication
  is enabled (the endpoint existed; the UI never called it).
- **Logs page**: minimum-level filter, text search, and download/copy of the
  visible lines.
- **Scheduled full syncs**: the `full` schedule mode was accepted by the API
  but never registered with the scheduler — saving an enabled full-sync cron
  now actually fires (opt-in; no seeded row).

### Changed
- **Library page fixes**: the shows list and the episodes table no longer share
  one pagination offset (paging one used to page the other); the episodes panel
  gained its own sort control; sort options now match what each tab's backend
  accepts (movies sort by year, not air date); the instance filter is a
  dropdown of known instances instead of free text; all library queries render
  an error state with retry instead of a silent empty list.
- **Media detail sheet** is now a proper dialog: Escape closes it, focus is
  trapped, and clicking the backdrop dismisses it; library table rows are
  keyboard-activatable.
- **Destructive actions** (reset data, reset MAL data, clear stuck state, full
  syncs, MAL import-all) use styled confirmation dialogs with typed
  confirmation phrases instead of `window.confirm`/`window.prompt`.
- Webhook receiver now honors the per-integration `webhook_enabled`/`enabled`
  flags (previously stored but ignored); disabled sources get `403`.
- Developer-facing copy in the UI ("from /api/status", "DL: 0", endpoint paths
  in descriptions) rewritten in user terms.

### Fixed
- `PUT /api/config/schedules/full` no longer silently creates a cron that never
  fires (see scheduled full syncs above).

## [2.2.0] - 2026-07-05

Performance and feature release: faster syncs, a responsive server during heavy
work, live UI updates, notifications, and new analytics. Existing stacks upgrade
with zero config changes (one additive DB migration runs automatically).

### Added
- **Live updates (SSE)**: new `GET /api/ui/events` server-sent-events stream
  (sync progress/completion, dead-letter transitions, health changes). The UI
  subscribes automatically and relaxes its polling from 2s–15s to a 30s–60s
  safety net while connected; polling cadence returns on disconnect.
- **Discord/Slack notifications**: alert webhooks now auto-detect Discord and
  Slack URLs and send natively formatted messages (generic URLs keep the old
  payload). New per-event toggles (health changes, sync failures, dead-letter
  jobs) on the Integrations page, a "Send test notification" button, and a
  `POST /api/config/alert-webhooks/test` route. Sync failures and dead-lettered
  webhook jobs now notify, not just health transitions.
- **Storage & Growth dashboard**: library size over time (stacked area chart),
  storage share by quality, top series by disk usage, and largest movie files.
  Backed by a new `warehouse.library_stat_snapshot` table (migration 0007), a
  daily `stats_snapshot` schedule, and an automatic snapshot after the first
  successful full/reconcile sync each day. New `timeseries` reporting panel kind.
- **Media detail sheet**: clicking a library row now opens a designed
  Overview/File/Media/Schedule detail panel (path, size, quality, release group,
  custom-format score, codecs, language badges) with raw JSON tucked behind a
  disclosure. Compare mode renders both selections field-by-field with
  differences highlighted.
- **Saved views + shareable links**: Library and Reporting filter state now
  lives in the URL; a "Views" menu saves named snapshots and copies deep links.
- Coverage reporting: `pytest-cov` and `@vitest/coverage-v8` wired into CI
  (report-only, no threshold gate).

### Changed
- **Full syncs are much faster**: Sonarr per-series episode fetches now run
  concurrently (bounded by `HTTP_MAX_PARALLEL_REQUESTS`), and all sync database
  writes moved off the event loop into worker threads with per-chunk commits —
  the API and UI stay responsive during a full sync. A full sync is no longer
  one single transaction; chunks commit as they complete (upserts are
  idempotent, and tombstones still only run after a complete pass).
- Arr HTTP clients (and their connection pools) are now cached per integration
  across sync runs and webhook jobs instead of being rebuilt each run.
- Reporting dashboard queries run in worker threads instead of blocking the
  event loop.
- Reporting tables: memoized filtering/column options with deferred filter
  input (smooth typing on large result sets); the "Unlimited" page size is now
  "All (first 500)" with a CSV-export notice; charts and tooltips use the theme
  tokens (fixes hard-coded dark colors in light mode).
- Compact density is preserved via design tokens; the legacy `styles.css`
  (724 lines) is fully retired — reporting and log views now render on the
  shared design system.

### Fixed
- An interrupted full sync (for example a container stop mid-run) could
  soft-delete every not-yet-fetched series/episode/movie because tombstones ran
  against a partial seen-set. Tombstones are now skipped when a run is
  interrupted.
- Reporting pie-chart tooltips and slice colors were unreadable in light mode.

## [2.1.1] - 2026-07-04

### Changed
- Reporting table column filters are now proper multi-select dropdowns
  (searchable checkbox list with a selected-count trigger and one-click clear)
  instead of always-open native multi-select listboxes. Filtering semantics
  and saved state are unchanged.

## [2.1.0] - 2026-07-04

Web UI redesign. No API, schema, or configuration changes; existing stacks
upgrade with zero config changes.

### Added
- **Light theme**: the UI now fully supports light mode — every component reads
  from the shared design tokens, so the existing theme toggle produces a usable
  light UI instead of dark-hardcoded fragments.
- Screenshot capture script options: `WEBUI_CAPTURE_THEME`,
  `WEBUI_CAPTURE_OUTPUT_DIR` (and documented `WEBUI_CAPTURE_BASE_URL`).

### Changed
- **Design system rebuilt on one token set** (`index.css`): restrained indigo
  accent, flat card surfaces, semantic `ok`/`warn`/`critical` status colors, and
  consistent radii/typography across light and dark.
- **App chrome**: single-row 56px header (page title, compact health pill with
  per-subsystem detail on hover, scoped library search, icon actions) replaces
  the stacked title + status-chip rows + full-width search bar; sidebar uses a
  solid surface with a primary-tint active state; command palette restyled with
  grouped sections.
- **Pages**: hero banners on Home/Dashboard replaced with compact action bars;
  proper button hierarchy (primary/secondary/outline/ghost/destructive) now that
  the legacy global gradient no longer repaints every control; Library show
  cards, episode tables, Reporting toolbar/stat cards/tabs, and Sync & Queue
  panels restyled on tokens.
- Legacy `styles.css` no longer styles bare `button`/`input`/`select`/`table`
  elements globally; remaining reporting/log-viewer classes consume the design
  tokens.

### Fixed
- Reporting toolbar no longer overlaps the dashboard header content below it
  (sticky offset removed).
- Status badges, health pills, security banner, and diagnostics panel are
  readable in both themes (previously dark-only hardcoded colors).

## [2.0.0] - 2026-07-03

Backwards compatible with 1.9.x deployments: an existing stack upgrades with zero
config changes. The major bump reflects the scale of the security and internal changes.

### Added
- **Authentication** (opt-in for existing installs): session-cookie login page,
  optional bearer API token, login rate limiting, `AUTH_ENABLED` /
  `AUTH_RECOVERY_PASSWORD` recovery overrides, and an admin-password step in the
  setup wizard. Existing installs stay open but warn at startup, on `/healthz`,
  and via a UI banner until auth is enabled.
- **Encryption at rest by default**: when `APP_ENCRYPTION_KEY` is unset, a key is
  generated and persisted under `NEBULARR_RUNTIME_DIR`; new secret writes are always
  encrypted (existing plaintext values keep working).
- **Egress policy** (`EGRESS_POLICY=lan|strict|open`, default `lan`) for integration
  and alert-webhook URLs; blocks link-local/cloud-metadata ranges by default.
- Postgres-backed integration test suite (migrations, repositories, all reporting
  dashboards) wired into CI; route-table snapshot test; Playwright e2e rewritten to
  walk the real setup wizard.
- Release automation (`release.yml`): tag-driven multi-arch image push with
  SBOM + provenance and a generated GitHub Release. Dependabot for pip/npm/actions/docker.
- `SECURITY.md`, `CONTRIBUTING.md`, this changelog, and version-sync tooling
  (`scripts/bump-version.sh`, `scripts/check-version-sync.sh`).

### Changed
- `api.py` (4,400 lines) split into focused `arrsync.routers.*` modules; shared
  helpers promoted to `routers/shared.py` and `services/settings_store.py`
  (route surface unchanged — snapshot-verified).
- Web UI styling unified on Tailwind + shadcn: Integrations, Schedules, and the setup
  wizard match the rest of the app; Integrations/Schedules gained loading skeletons
  and error/retry states; secret inputs are masked everywhere; legacy `styles.css`
  reduced to reporting/log-viewer component CSS.
- Arr HTTP clients now reuse pooled connections across a sync run and are closed
  deterministically; FastAPI lifecycle migrated from deprecated `on_event` to lifespan.
- Reporting row cap reduced from 1,000,000 (via `limit=0`) to 50,000; CSV export cap
  centralized at 100,000.
- Deploy hardening: Unraid compose template now matches the root compose (non-root,
  read-only, cap_drop ALL, no-new-privileges), no longer publishes Postgres to the
  host by default, and pins the image tag. Base image digest-pinned; CI scanners
  version-pinned; `one-click-all-in-one.sh` generates a random `POSTGRES_PASSWORD`
  when the placeholder default is detected.

### Fixed
- **All application and uvicorn logging silently stopped after startup migrations**:
  Alembic's `fileConfig` disabled every existing logger and replaced the JSON stdout
  handler. Migrations no longer touch logging when run by the app.
- Webhook body-size limit is enforced on received bytes (previously bypassable via
  chunked transfer; malformed `Content-Length` caused a 500).
- `ops-overview` reporting dashboard crashed (HTTP 500) on fresh installs and
  multi-instance sync state.
- One malformed history date from Sonarr/Radarr no longer fails an entire
  incremental sync run.
- Health alerts no longer double-fire from `/api/status` polls (untracked task leak).
- Sync & Queue page no longer crashes when operator/stuck-state payloads are partial.
- Library sort options were mislabeled ("Operations (title)" / "Media forensics" /
  "Language audit" → "Title" / "File size" / "Air date").

### Deprecated
- The `changeme` default webhook secret is still accepted but warned about; a future
  major release will reject it. The `arrsync` Python module name (import path and
  `uvicorn arrsync.main:app` entrypoint) is kept for deployment compatibility and will
  be renamed in a future major release.

## [1.9.3] - 2026-05-02

Last 1.x release: hardened CI image scanning, moved to Python 3.14-slim, enabled
image SBOM/provenance in the release script. See git history for details.
