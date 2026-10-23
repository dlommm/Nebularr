# Nebularr

![Nebularr banner](docs/readme/nebularr-banner.png)

[![Release](https://img.shields.io/github/v/release/dlommm/Nebularr?label=release)](https://github.com/dlommm/Nebularr/releases/latest)
[![Docker image](https://img.shields.io/docker/v/dendlomm/nebularr?label=docker&sort=semver)](https://hub.docker.com/r/dendlomm/nebularr)
[![CI](https://github.com/dlommm/Nebularr/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dlommm/Nebularr/actions/workflows/ci.yml)

> [!IMPORTANT]
> **Nebularr 3.0 is a major UI overhaul.** Every screen has been redesigned around
> your own library: posters and fanart from your Sonarr and Radarr, a live Overview,
> season quality grids, 24-hour sync lanes and a reworked Setup. Upgrading is a pull
> and a restart: migrations run automatically, your settings carry over and the API
> is unchanged. Some pages have moved; see [What's new in 3.0](#whats-new-in-30).

<p align="center">
  <img src="docs/reference/webui-pages/home.png" alt="The Nebularr 3.0 Overview: the latest import as full-bleed fanart, a status sentence, recent arrivals and sync lanes" width="900">
</p>

> **AI-assisted development** — The code, docs, and tooling in this repository were written primarily with AI coding assistants, with human direction and review.

Nebularr is a Docker-first service that ingests Sonarr/Radarr API metadata into PostgreSQL for analytics and the built-in Web UI.

**Security:** built-in login (session cookie + optional bearer API token), secrets encrypted at rest with an auto-provisioned key, egress policy for outbound URLs, hardened non-root container. Details, threat model, and vulnerability reporting: **[SECURITY.md](./SECURITY.md)**.

**Supply chain:** releases are cut by the tag-driven **`release.yml`** workflow (multi-arch buildx push with **SBOM + provenance (mode=max)**, so **[Docker Scout](https://scout.docker.com/)** attestation policies pass); `./scripts/docker-release-build.sh --push` is the manual fallback. Image base **`python:3.14-slim`** is digest-pinned; distro CVE rows without patches must wait on Debian/Python image updates. Changes per release: **[CHANGELOG.md](./CHANGELOG.md)**.

## What's new in 3.0

- **Your library, front and centre.** Posters and fanart come from your own Sonarr and
  Radarr. Nebularr fetches them server-side with the stored API key and caches them,
  so your browser never talks to the Arrs. TheTVDB/TMDB fallback stays off unless you
  enable it under **Setup → Artwork**.
- **Overview.** The latest import as a full-bleed hero, a one-sentence health summary,
  recent arrivals, a 24-hour sync lane per source and the things waiting on you.
- **Library.** Poster rows; open a show for a season grid with one cell per episode,
  coloured by quality, with missing episodes outlined.
- **Sync, Reports, Rules and Anime.** Rebuilt around big figures and hairline rows:
  a "running now" panel, quality bands, the rule editor beside its list, and the
  MyAnimeList fetch → match → tag pipeline.
- **Works on phones.** A bottom tab bar, single-row tabs and layouts that fit at 390 px.
- **Dark by default, with a matching light theme.**

### Upgrading from 2.x

1. Pull the new image (`dendlomm/nebularr:3.0.0` or `:latest`) and recreate the
   container. With Compose: `docker compose pull && docker compose up -d`.
2. That's it. Migrations `0016` (artwork schedule) and `0017` (two indexes) run on
   start-up, and the artwork cache warms in the background on the runtime volume.

### Where things moved

| In 2.x | In 3.0 |
|--------|--------|
| Home, Dashboard (`/dashboard`) | **Overview** (`/`; the old path redirects) |
| Automations | **Rules** |
| MyAnimeList | **Anime** |
| Integrations, Schedules, Logs | **Setup →** Integrations, Schedules, Logs |
| (new) | **Setup → Artwork** |
| Sync & Queue → Manual | **Sync → Run by hand** |

## What it does

- Runs **first full sync** and **incremental sync** (history polling).
- Accepts Sonarr/Radarr **webhooks** and processes a durable queue.
- Stores data in PostgreSQL with two schemas:
  - `app`: config/state/schedules/queue/ops tables.
  - `warehouse`: analytics entities + views (`v_episode_files`, `v_movie_files`, etc.).
- Exposes:
  - `/healthz` with app version and git SHA.
  - `/metrics` (Prometheus text format).
  - Web UI at `/` for operational visibility, with posters and fanart cached from your own Sonarr/Radarr.

## Architecture and HTTP API

### Low-level architecture (single process)

- **FastAPI** serves the SPA, JSON APIs, Prometheus metrics, and webhook ingress on one port.
- **SQLAlchemy** sessions run short request-scoped transactions; sync jobs use the same pool with longer statement timeouts where configured.
- **SyncService** pulls from Sonarr/Radarr via **ArrClient**, upserts into `warehouse`, and updates `app` state (watermarks, locks, run summaries).
- **SyncScheduler** triggers incremental/reconcile work from cron rows stored in the database (after setup).
- **Webhook path** validates the shared secret, writes to `app.webhook_queue`, and workers process jobs with retries and dead-letter states.
- **Background tasks** (asyncio): Arr capability probe after startup, periodic health evaluation for outbound alert webhooks.

```mermaid
flowchart TB
  subgraph clients [Clients]
    br[Browser]
    arr[Sonarr / Radarr]
  end
  subgraph neb [Nebularr process]
    mw[HTTP middleware]
    rt[Router handlers in api.py]
    ss[SyncService]
    sc[SyncScheduler]
    ac[ArrClient REST]
    dbw[SQLAlchemy + repository]
    bg[Background tasks: capabilities + health alerts]
    mw --> rt
    rt --> dbw
    rt --> ss
    sc --> ss
    ss --> ac
    ss --> dbw
    bg --> dbw
  end
  pg[(Postgres app + warehouse)]
  dbw --> pg
  br --> mw
  arr --> mw
  arr --> ac
```

### API surface (quick reference)

| Area | Examples | Role |
| --- | --- | --- |
| Observability | `GET /healthz`, `GET /metrics`, `GET /api/status` | Liveness, Prometheus text, derived health |
| Setup | `GET/POST /api/setup/*` | First-run wizard, skip, initial sync |
| Configuration | `GET/PUT /api/config/integrations/{source}`, `POST .../test`, `/api/config/webhook`, `/api/config/alert-webhooks` (+ `POST .../test`), `/api/config/schedules` (+ `POST .../validate`), `/api/config/retention`, `/api/config/queue`, `/api/config/saved-views` | Integrations (+ connection test), webhook verifier, alert targets (+ per-channel test), cron (+ validation/next-run preview), retention & queue policy, saved views |
| Sync control | `POST /api/sync/<source>/<mode>` — sources: `sonarr`, `radarr`; modes: `full`, `incremental`, `reconcile` | Manual or scripted runs |
| Automations | `GET/POST /api/automations`, `GET/PUT /api/automations/{id}`, `DELETE /api/automations/{id}`, `POST /api/automations/{id}/run`, `GET /api/automations/{id}/runs`, `GET /api/automations/runs/{run_id}` (+ `POST .../validate`) | CRUD, validation, manual trigger, run history |
| Webhook ingress | `POST /hooks/sonarr`, `POST /hooks/radarr`, `POST /hooks/<source>/<instance>` | Signed payloads from Arr into the queue (per-instance form for multi-instance setups) |
| Queue admin | `POST /api/webhooks/replay-dead-letter/<source>`, `POST /api/webhooks/requeue/<job_id>`, `POST /api/webhooks/requeue-bulk` | Recover failed webhook jobs (single, per-source, or bulk by status) |
| Library UI | `GET /api/ui/*` (shows, episodes, movies, runs, queue, …) | Paged JSON + streamed CSV exports for the SPA |
| Reporting | `GET /api/reporting/dashboards`, `.../{key}`, CSV under panels | Whitelist-only SQL; no ad-hoc SQL from browser |
| Danger zone | `POST /api/admin/reset-data` | Wipe library/sync/MAL data (auth, webhook secret, and alert/policy settings survive) |

Static assets: `GET /`, `/setup`, `/assets/...`, and the SPA catch-all route for client-side navigation.

### Typical request flows

**Browser → Web UI and JSON APIs**

```mermaid
sequenceDiagram
  participant B as Browser
  participant F as FastAPI
  participant P as PostgreSQL

  B->>F: GET / SPA shell
  B->>F: GET /api/ui/shows or reporting
  F->>P: Parameterized queries
  P-->>F: Rows
  F-->>B: JSON or CSV
```

**Arr → webhook → warehouse**

```mermaid
sequenceDiagram
  participant A as Sonarr or Radarr
  participant H as POST /hooks/source
  participant Q as app.webhook_queue
  participant W as Sync worker
  participant R as Arr REST
  participant WH as warehouse tables

  A->>H: Webhook JSON + x-arr-shared-secret
  H->>Q: Enqueue
  H-->>A: 2xx ACK
  W->>Q: Claim job
  W->>R: Targeted GETs
  R-->>W: Entity JSON
  W->>WH: Idempotent upsert
  W->>Q: Done or retry backoff
```

**Operator → manual full sync**

```mermaid
sequenceDiagram
  participant O as Operator curl or UI
  participant S as POST /api/sync/source/full
  participant L as app.job_lock
  participant Y as SyncService
  participant R as Arr API
  participant W as warehouse

  O->>S: Trigger full sync
  S->>L: Acquire lease
  S->>Y: Run full pipeline
  Y->>R: List series movies etc
  R-->>Y: Batches
  Y->>W: Upserts
  Y->>L: Release on completion
```

More diagrams: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Quickstart

### One-click stack (Postgres + App)

```bash
./scripts/one-click-all-in-one.sh
```

Requires an existing **`.env`** (copy from **`.env.example`** first; the script exits with an error if `.env` is missing—see **docs/SECRETS.md**). Then it starts the core stack (app URL and Postgres lines are printed when the script finishes). The script reads **`NEBULARR_BUNDLED_POSTGRES`** (default `true`) and syncs **`COMPOSE_PROFILES`** so bundled Postgres starts unless you opt out.

### Local Docker testing (auto `.env`)

For quick local runs without preparing **`.env`** by hand:

```bash
./scripts/docker-local-up.sh
```

Creates **`.env` from `.env.example` if missing**, then **`docker compose up -d --build`** using **only** your **`.env`** (no `DATABASE_URL=` / `COMPOSE_PROFILES=` shell overrides). Same bundled-postgres profile merge as the one-click script.

### Bundled Postgres vs external

- **Default (local bundled Postgres):** `.env` from `.env.example` sets `NEBULARR_BUNDLED_POSTGRES=true` and `COMPOSE_PROFILES=nebularr-bundled-postgres`, which starts the `postgres` service in `docker-compose.yml`. The Web UI setup can still use host **`postgres`** on port **5432** (the Docker service name on the compose network).
- **External / existing Postgres:** set **`NEBULARR_BUNDLED_POSTGRES=false`** in `.env` and remove **`nebularr-bundled-postgres`** from **`COMPOSE_PROFILES`** (or rely on `./scripts/one-click-all-in-one.sh`, which strips the profile when bundled is false). Then `docker compose up` runs **app only**; in the first setup step, use your real DB hostname, port, database name, and credentials. **`POSTGRES_*` in `.env` only apply to the bundled image** when that service is enabled.

### Core stack (optional bundled Postgres + App)

1. Copy env defaults:

```bash
cp .env.example .env
```

2. Start stack:

```bash
docker compose up --build
```

(`docker compose` loads `.env` from the project directory, including **`COMPOSE_PROFILES`**, so bundled Postgres starts with the defaults above.)

3. Validate app is up:

```bash
./scripts/smoke.sh
```

4. Open the Web UI at `http://localhost:8080`. If you did not set `DATABASE_URL`, the first step collects Postgres host, database name, and credentials (for bundled Postgres, match your `POSTGRES_*`; for external DB, use that server’s host and credentials), waits until Postgres accepts connections, runs Alembic migrations, then continues with integrations, webhook secret, **admin password (recommended — protects the whole API)**, and schedules. Then trigger initial full sync if you have not already (add `-H "Authorization: Bearer <token>"` when authentication is enabled; generate a token under Integrations → Authentication):

```bash
curl -X POST "http://localhost:8080/api/sync/sonarr/full"
curl -X POST "http://localhost:8080/api/sync/radarr/full"
```

5. Use **Reporting** and **Library** views in the Web UI; external BI tools can still connect read-only to Postgres and query `warehouse.v_*` views if you grant a suitable role.

## Webhook setup

Configure Sonarr/Radarr webhook target:

- URL: `http://<your-host>:8080/hooks/sonarr` (or `/hooks/radarr`)
- Header: `x-arr-shared-secret: <WEBHOOK_SHARED_SECRET>`

Webhooks are refused (403) while `WEBHOOK_SHARED_SECRET` is still the shipped default — set a real secret first.

With multiple instances of the same app, give each its own URL so events land on the right instance:

- URL: `http://<your-host>:8080/hooks/sonarr/<instance-name>` (must match the integration name under Settings → Integrations; the bare `/hooks/sonarr` form targets the `default` instance)

## Scheduler and timezone

- Incremental and reconcile schedules are stored in the database after Web UI setup (see [`docs/SCHEDULER_TIMEZONE.md`](docs/SCHEDULER_TIMEZONE.md)).
- `SCHEDULER_TIMEZONE` and `APP_TIMEZONE` env vars default to `UTC` and act as fallbacks when a schedule row has no timezone.

## Project layout

- `src/arrsync/`: app code — API routers (`routers/`), services, clients, sync logic, scheduler.
  (Naming note: the distribution/package is `nebularr`; the Python module stays `arrsync`
  so deployed `uvicorn arrsync.main:app` entrypoints keep working. A rename is planned for
  a future major release.)
- `alembic/`: DB migrations.
- `docker/`: Postgres bootstrap.
- `docs/`: architecture, operations, backup/restore (canonical; `docs/wiki/` is a synced snapshot for the GitHub wiki).
  - `ARCHITECTURE.md`, `AUTOMATIONS.md`, `REPORTING_ARCHITECTURE.md`, `BRANDING.md`, `LOCKING_AND_DLQ.md`, `MIGRATIONS.md`, `POOLING_AND_TIMEOUTS.md`, `ALERTS_AND_SLOS.md`, `DB_BOOTSTRAP.md`, `BACKUP_RESTORE.md`, `OPERATIONS_RUNBOOK.md`, `COMPOSE_RESOURCE_HINTS.md`, `PERF_INDEXING_PLAN.md`, `SCHEDULER_TIMEZONE.md`, `SECRETS.md`, `WEBUI_FRAMEWORK.md`, `WEBUI_AGENT_WORKFLOW.md`

## Development

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .[dev]
ruff check src tests
mypy src
pytest -q
```

### WebUI development (React + TypeScript)

```bash
cd frontend
npm install
npm run lint
npm run test
npm run build
```

The frontend build is emitted to `src/arrsync/web/dist` and served by FastAPI. The **root `Dockerfile`** copies that tree into the image (it does not run `npm` in Docker), so run `npm run build` in `frontend/` after WebUI changes before `docker build` / `docker compose build`, or use CI that does the same.

For **Docker Hub** releases, prefer **`./scripts/docker-release-build.sh --push`** (Buildx, **linux/amd64** and **linux/arm64** by default, **SBOM + SLSA provenance (mode=max) attached by default**; set `DOCKER_ATTESTATIONS=0` to opt out). Plain `docker build` / `--load` still works for local smoke tests and skips attestations; see the script header for trade-offs.

## WebUI docs

- `docs/WEBUI_FRAMEWORK.md`: frontend architecture, contracts, and local workflows.
- `docs/WEBUI_AGENT_WORKFLOW.md`: task tracker + quality guardian gates and completion criteria.
- `docs/WEBUI_REFERENCE_ASSETS.md`: generated 1:1 page screenshots + sample API/demo data.

## Web UI

The interface is called **Now Showing**. It's built around your own library: condensed
display type, big figures on hairlines, rows instead of cards, and colour used only
for status. Posters and fanart come from **your** Sonarr and Radarr. Nebularr fetches
them server-side with the stored API key and caches them on the runtime volume, so
the browser never talks to the Arrs. TheTVDB/TMDB fallback is off unless you turn it
on under **Setup → Artwork**.

Navigation: **Overview · Library · Sync · Reports · Rules · Anime · Setup**, with a
tab bar on phones.

The screenshots below are renders of the real app against mocked sample data
(regenerate with `npm run capture:reference`; see
[`docs/WEBUI_REFERENCE_ASSETS.md`](docs/WEBUI_REFERENCE_ASSETS.md)).

### Overview

The latest import as full-bleed fanart, a plain-English status sentence, recent
arrivals, a 24-hour sync lane per source (tick per run, ring for a failure, empty lane
when a source goes quiet), library totals, and anything waiting on you.

![Overview](docs/reference/webui-pages/home.png)

The light theme ("Daylight") uses the same layouts:

![Overview in the light theme](docs/reference/webui-pages/light/home.png)

<p>
  <img src="docs/reference/webui-pages/phone/home.png" alt="Overview on a phone" width="260">
  &nbsp;
  <img src="docs/reference/webui-pages/phone/library-episodes.png" alt="A show on a phone" width="260">
  &nbsp;
  <img src="docs/reference/webui-pages/phone/sync-overview.png" alt="Sync on a phone" width="260">
</p>

### Library

Shows as poster rows. Open one to get its fanart, a season grid with one cell per
episode coloured by quality (missing episodes outlined), and the selected episode's
file details. Movies are a poster grid; every view filters, sorts and exports to CSV.

![Library, a show expanded](docs/reference/webui-pages/library-episodes.png)

![Library, movies](docs/reference/webui-pages/library-movies.png)

### Sync & Queue

What's holding the sync lock right now, the sync lanes, webhook queue figures and
recent runs. Separate tabs cover full run history, the webhook job queue (with
requeue), and running syncs, audits and resets by hand.

![Sync & Queue](docs/reference/webui-pages/sync-overview.png)

![Sync & Queue, run by hand](docs/reference/webui-pages/sync-manual.png)

### Reports

Server-defined dashboards straight from the warehouse: big-figure summaries,
quality bands, trends and tables. Every panel exports as CSV.

![Reports](docs/reference/webui-pages/reporting.png)

### Rules

Automations that search, tag or retire. The rule list sits beside its editor; every
new rule starts as a dry run and changes nothing until you take it live (which asks
first).

![Rules, editing a rule](docs/reference/webui-pages/automations-editor.png)

### Anime

MyAnimeList as a pipeline: fetch → match to your library → tag in Sonarr and
Radarr, each stage with its count, last run and its own run button. Unmatched dubbed
titles and job history sit underneath.

![Anime](docs/reference/webui-pages/mal.png)

### Setup

Integrations (Sonarr/Radarr, MyAnimeList, alerts, sign-in, webhook secret, logging),
Artwork, Schedules and Logs, with a readiness count in the header.

![Setup, integrations](docs/reference/webui-pages/integrations.png)

![Setup, artwork](docs/reference/webui-pages/artwork.png)

![Setup, logs](docs/reference/webui-pages/logs.png)

### Sign-in and first run

The sign-in screen shows a different set of your cached posters on each visit. On a
new install the first-run wizard connects Postgres, the Arrs, the webhook secret,
schedules and the admin password.

![Sign-in](docs/reference/webui-pages/login.png)

![First-run setup](docs/reference/webui-pages/setup.png)

## GitHub wiki (optional)

A companion wiki can track how the code and in-repo docs fit together. **Source files** (including a navigation sidebar) live in [`docs/wiki/`](docs/wiki/); [publish them](docs/wiki/README.md) to the GitHub wiki (separate `*.wiki` git repository) or browse them on the default branch. Replace `OWNER/REPO` in the wiki with your org/repo when forking.

CI runs lint/type/tests on push and pull request. An optional Docker smoke job is available via manual workflow dispatch.
