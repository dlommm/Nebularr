# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

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
