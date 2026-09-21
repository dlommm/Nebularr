# Automations

Automations converge your library toward declared preferences ("anime = English dub,
1080p minimum") by periodically triggering Sonarr/Radarr searches and metadata
actions, driven entirely by warehouse data.

## Model

- **Automation** (`app.automation`): a template instance — params (scope /
  requirements / actions), its own cron + timezone, `budget_per_run`,
  `cooldown_days`, `enabled`, `dry_run`. New automations start in **dry-run**:
  runs record what they *would* do; flip the switch per rule to go live.
- **Scope**: which items a rule considers — media type, instances, anime-only,
  genres, Arr tags, monitored-only, series status, and **folder location**. Folder
  scoping matches `warehouse.movie.path` / `warehouse.series.path` against the
  selected root folders (an item at the folder itself, or anywhere beneath it).
  Episodes inherit their series' folder. The picker's options come from
  `GET /api/automations/root-folders`, derived from synced library paths rather
  than a live Arr call — so it only ever offers folders that hold items, and a
  saved folder the library no longer reports stays selected instead of being
  silently dropped.
- **Conformance**: an item conforms when its file satisfies every requirement
  (audio language, subtitle language, resolution floor, codec, quality name).
  Actions fire on the non-conforming set by default, or on the conforming set with
  `when=conforming`.
- **`resolution_min` is a quality tier, not a pixel height.** `1080` means "the
  Arr calls this 1080p", so a letterboxed release — a 2:1 show delivered as
  1920x960, or 2.39:1 as 1920x800 — satisfies a 1080 floor, because it is a 1080p
  file to both Sonarr and you. `warehouse.{movie,episode}_file.video_resolution`
  stores that tier, derived in this order: the Arr's own
  `quality.quality.resolution`, then the quality name ("WEBDL-1080p"), then frame
  **width** mapped to a tier (1920 wide is 1080p whatever the crop), then frame
  height as a last resort. Before 0013 the height came first, which read a
  letterboxed 1080p file as 960 and — since one failing episode disqualifies a
  whole show — hid thousands of complete series. `repository._extract_video_resolution`
  and the 0013 SQL implement the same precedence; keep them in step.
- **Series completeness**: a series conforms when *no* aired in-scope episode
  fails — an anti-join, not a rollup of conforming episodes, since a show with one
  good episode out of forty conforms to nothing. A missing episode and a 720p file
  disqualify a show the same way, so "do I have every episode, all in spec" is one
  question. Two scope knobs exist for the ways a show reads as unfinished for the
  wrong reason: `include_specials` (default on, for backward compatibility — the
  completeness templates turn it off, since a missing season-0 special is the most
  common false gap) and `include_unmonitored_episodes` (default off; on means an
  episode you already unmonitored still counts as a gap, which is what a
  completeness check wants). Unaired episodes are always out of scope, and a show
  with nothing aired is never "complete".
- **Per-library specs**: one rule per root folder is the intended shape. A library
  whose content has no English dub keeps its original audio as the requirement and
  checks English *subtitles* instead (`foreign-subs-audit`). Note that Arrs report
  a mix of ISO-639-2 codes and full names for the same language, sometimes within
  one library — always list both spellings (`["english", "eng"]`), which is why the
  shipped templates do.
- **Why an item failed**: each run records per-reason counts and a bounded
  worst-offenders list in `details` (`failure_reasons`, `failure_worst`), derived
  from columns the candidate select already returns — so "what has to be fixed
  before this show can retire" costs no extra query. Series rules group by show:
  the fault sits on an episode, the show is what you act on.
- **Acquisition model**: Nebularr only sends `*Search` commands; your Arr quality
  profiles and custom formats decide what actually gets grabbed. If a rule
  requires a language and no custom format on the instance scores language/dub,
  the run records a profile warning.

## Rate protection (4 layers)

1. Min interval between Arr command posts (`AUTOMATION_COMMAND_MIN_INTERVAL_SECONDS`, default 2s).
2. Per-run search budget (`budget_per_run`, default 10).
3. Global daily search cap across all automations (`AUTOMATION_MAX_SEARCHES_PER_DAY`, default 100).
4. Per-item cooldown via `app.automation_action_ledger` (default 7 days, **search actions only**) — the
   ledger is keyed globally, so two rules can never double-search one item. Tag and monitor
   reconciles are idempotent live-state diffs with no cooldown.

## Templates

anime-dub-enforcer (skips MAL `dub_status='none'` items), new-dub-watcher
(searches on `none → partial|dubbed` transitions), resolution-floor,
missing-hunter, codec-preference (tag-only by default), language-audit
(tag-only), custom (condition builder). All compile through the same
whitelist-only SQL compiler — user input is bind values, never SQL text.

Retirement and audit templates — the things neither Arr can express, because both
reason per-episode and neither ever stops monitoring something it has satisfied:

- **complete-series-tagger** — tags finished shows that are wholly in spec. Tag
  only; the tag is the deliverable, so you can sort by it and retire in bulk.
- **series-done-unmonitor** — the same, with the unmonitor applied. Cuts what
  Sonarr refreshes and RSS-scans forever after a show has ended.
- **movie-done-unmonitor** — Radarr's minimum availability decides when to start
  looking, never when to stop; this stops.
- **series-spec-audit** — tags what is *not* in spec and records why.
- **incomplete-ended-series** — a gap in a running show is normal; a gap in an
  ended one is permanent. Tag-only: hunt it or drop it, per show.
- **foreign-subs-audit** — original audio + English subtitles, for libraries where
  a dub does not exist.

A rule may carry both senses at once ("tag the finished shows, tag what still
needs fixing"); each action reconciles against its own set.

## WebUI

The page is a list of rules; a single automation is worked on in a right-hand
sheet, so the list never reflows underneath you. Each row carries one primary
action (**Run now**) with the rest behind an overflow menu.

- The editor leads with the rule stated as a sentence ("Every Saturday at 05:00,
  look at monitored movies — for anything that isn't 1080p or better, search for
  an upgrade") and validates live, reporting how many items it would act on
  right now. `frontend/src/pages/automations/automationSummary.ts` owns that
  phrasing; anything it cannot phrase safely (an exotic cron) falls back to the
  raw value rather than guessing.
- **Go live** and **Delete** confirm first. Leaving dry-run is the only control
  that converts a simulation into real indexer traffic; every other toggle is
  reversible and stays one click.
- Templates appear inside the sheet when creating, not permanently on the page.

## Freshness

Automations read the warehouse, so a rule is only as correct as the last sync that
touched the rows it scopes on.

- **Incremental (every 30 min by default)** is history-driven: it asks the Arr for
  history since a watermark and refetches only the series/movies those events name.
  An Arr's history records grabs, imports and deletions — **never a monitor
  toggle** — so before the scope-refresh pass existed, unmonitoring a show in
  Sonarr's UI produced no event, the series was never refetched, and
  `warehouse.series.monitored` stayed wrong until the next full sync. On a real
  library that left ~520 series with a stale flag, and `monitored` is the flag rules
  scope on: a show stuck at a stale `monitored=false` is invisible to every rule
  that sets `monitored_only`.
- **Scope refresh** now runs on every incremental tick: one list call per instance
  re-reads each series/movie's `monitored`, `status`, `path` and genres. Upsert-only
  and deliberately so — a list call that came back short must never be read as
  "these items were deleted", so removals stay the full/reconcile pass's business
  (it has a mass-tombstone guard). Disable with `INCREMENTAL_SCOPE_REFRESH=false`.
- **Reconcile** is a *full* sync under another name (same code path), seeded
  **daily** at 04:00. It was weekly, which meant up to seven days of monitor drift —
  and a container restart across the scheduled minute silently bought another seven,
  since a missed cron does not backfill. Existing installs keep whatever is already
  in `app.sync_schedule`; the new default only seeds new ones.
- **Full** is a separate, opt-in schedule, seeded **disabled** at weekly. Reconcile
  already performs the same full sync, so enabling both simply runs two of them. It
  has its own cron (`FULL_SYNC_CRON`) so changing reconcile's cadence cannot move it.
- **Webhooks** write the item they name, and now tombstone the file row an upgrade
  replaced. An upgrade arrives as a *new* `episodeFile`/`movieFile` id, so upserting
  it alone left the previous row live and the item presenting two files — one of
  which is gone from disk. Conformance reads every live row, so the stale one counted
  as real, and under series completeness one such row disqualified an entire show.
  The tombstone is keyed on a file that was actually written: `list_episodes` only
  requests `includeEpisodeFile` where supported and falls back without it, so an
  absent file in the payload can mean "not included" rather than "none exists", and
  acting on absence would delete live rows for files still on disk.

## Operations

- Runs are recorded in `app.automation_run`; per-item outcomes live in `details`.
- Concurrency: `app.job_lock` lease `automation:{id}` — a run skips with
  "already running" instead of stacking.
- Tag labels used by an automation are owned by it: the reconcile adds the tag
  to matched items and removes it from unmatched ones on every run. That is what
  makes the retirement workflow safe to trust — a finished show that later gains
  an episode, or whose file is replaced by a worse one, loses its
  `ready-to-unmonitor` tag by itself on the next run.
- Removals are skipped (adds still applied) when a candidate set hits
  `SEARCHLESS_LIMIT`: stripping a label off a truncated view could unlabel items
  that still belong in the set.
- Budget/cap apply to searches only; tag/monitored reconciles are idempotent
  diffs against live Arr state.
