# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
