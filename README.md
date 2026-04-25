# Nebularr

![Nebularr banner](docs/readme/nebularr-banner.png)

> **AI-assisted development** — The code, docs, and tooling in this repository were written primarily with AI coding assistants, with human direction and review.

Nebularr is a Docker-first service that ingests Sonarr/Radarr API metadata into PostgreSQL for analytics and the built-in Web UI.

## What it does

- Runs **first full sync** and **incremental sync** (history polling).
- Accepts Sonarr/Radarr **webhooks** and processes a durable queue.
- Stores data in PostgreSQL with two schemas:
  - `app`: config/state/schedules/queue/ops tables.
  - `warehouse`: analytics entities + views (`v_episode_files`, `v_movie_files`, etc.).
- Exposes:
  - `/healthz` with app version and git SHA.
  - `/metrics` (Prometheus text format).
  - Web UI at `/` for operational visibility.

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
| Configuration | `GET/PUT /api/config/integrations/{source}`, `/api/config/webhook`, `/api/config/alert-webhooks`, `/api/config/schedules` | Integrations, webhook verifier, alert targets, cron |
| Sync control | `POST /api/sync/<source>/<mode>` — sources: `sonarr`, `radarr`; modes: `full`, `incremental`, `reconcile` | Manual or scripted runs |
| Webhook ingress | `POST /hooks/sonarr`, `POST /hooks/radarr` | Signed payloads from Arr into the queue |
| Queue admin | `POST /api/webhooks/replay-dead-letter/<source>`, `POST /api/webhooks/requeue/<job_id>` | Recover failed webhook jobs |
| Library UI | `GET /api/ui/*` (shows, episodes, movies, runs, queue, …) | Paged JSON + CSV exports for the SPA |
| Reporting | `GET /api/reporting/dashboards`, `.../{key}`, CSV under panels | Whitelist-only SQL; no ad-hoc SQL from browser |
| Danger zone | `POST /api/admin/reset-data` | Wipe app data (use with care) |

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

More diagrams: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/ORIGINAL_PLAN_REFERENCE.md`](docs/ORIGINAL_PLAN_REFERENCE.md).

## Quickstart

### One-click stack (Postgres + App)

```bash
./scripts/one-click-all-in-one.sh
```

Creates `.env` if needed and starts the core stack (app URL and Postgres port are printed when the script finishes).

### Core stack (Postgres + App only)

1. Copy env defaults:

```bash
cp .env.example .env
```

2. Start stack:

```bash
docker compose up --build
```

3. Validate app is up:

```bash
./scripts/smoke.sh
```

4. Open the Web UI at `http://localhost:8080`, finish setup (integrations, webhook secret, schedules), then trigger initial full sync if you have not already:

```bash
curl -X POST "http://localhost:8080/api/sync/sonarr/full"
curl -X POST "http://localhost:8080/api/sync/radarr/full"
```

5. Use **Reporting** and **Library** views in the Web UI; external BI tools can still connect read-only to Postgres and query `warehouse.v_*` views if you grant a suitable role.

## Webhook setup

Configure Sonarr/Radarr webhook target:

- URL: `http://<your-host>:8080/hooks/sonarr` (or `/hooks/radarr`)
- Header: `x-arr-shared-secret: <WEBHOOK_SHARED_SECRET>`

## Scheduler and timezone

- Incremental and reconcile schedules are stored in the database after Web UI setup (see [`docs/SCHEDULER_TIMEZONE.md`](docs/SCHEDULER_TIMEZONE.md)).
- `SCHEDULER_TIMEZONE` and `APP_TIMEZONE` env vars default to `UTC` and act as fallbacks when a schedule row has no timezone.

## Project layout

- `src/arrsync/`: app code, clients, sync logic, scheduler.
- `alembic/`: DB migrations.
- `docker/`: Postgres bootstrap.
- `docs/`: architecture, operations, backup/restore.
  - `ARCHITECTURE.md`, `REPORTING_ARCHITECTURE.md`, `BRANDING.md`, `LOCKING_AND_DLQ.md`, `MIGRATIONS.md`, `POOLING_AND_TIMEOUTS.md`, `ALERTS_AND_SLOS.md`, `DB_BOOTSTRAP.md`, `BACKUP_RESTORE.md`, `OPERATIONS_RUNBOOK.md`, `COMPOSE_RESOURCE_HINTS.md`, `PERF_INDEXING_PLAN.md`, `SCHEDULER_TIMEZONE.md`, `SECRETS.md`, `WEBUI_FRAMEWORK.md`, `WEBUI_AGENT_WORKFLOW.md`, `ORIGINAL_PLAN_REFERENCE.md`, `V2_BACKLOG.md`

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

For **Docker Hub** releases, prefer **`./scripts/docker-release-build.sh --push`** (Buildx, **no** SLSA provenance or SBOM attestations) so **Docker Scout** on the registry is less likely to show extra packages from attestation metadata. Plain `docker build` still works for local smoke tests; see the script header for trade-offs.

## WebUI docs

- `docs/WEBUI_FRAMEWORK.md`: frontend architecture, contracts, and local workflows.
- `docs/WEBUI_AGENT_WORKFLOW.md`: task tracker + quality guardian gates and completion criteria.

## GitHub wiki (optional)

A companion wiki can track how the code and in-repo docs fit together. **Source files** (including a navigation sidebar) live in [`docs/wiki/`](docs/wiki/); [publish them](docs/wiki/README.md) to the GitHub wiki (separate `*.wiki` git repository) or browse them on the default branch. Replace `OWNER/REPO` in the wiki with your org/repo when forking.

CI runs lint/type/tests on push and pull request. An optional Docker smoke job is available via manual workflow dispatch.
