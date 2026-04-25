# Complete documentation index

This is the **master catalog** of all long-form documentation in the main repository at [`docs/`](https://github.com/OWNER/REPO/tree/main/docs). It is meant to be the first stop when the wiki is used as a **map of everything** the project documents.  
Replace `OWNER/REPO` in links with your GitHub organization and repository name.

**Legend:** each row summarizes the *purpose* and *contents* of the file so you can decide whether to open it without guessing from the filename.

---

## Core architecture and planning

| Document | What it covers (detailed) |
|----------|---------------------------|
| [**ARCHITECTURE.md**](https://github.com/OWNER/REPO/blob/main/docs/ARCHITECTURE.md) | **Runtime and integration shape:** how Sonarr, Radarr, the browser, and PostgreSQL connect to the single Nebularr process. Describes **sync modes** (full vs steady state, incremental, reconcile, webhook drain) with state and sequence diagrams. Covers the **locking model** at a high level (job locks, single-flight behavior). This is the primary “how does the system hang together” doc after the README. |
| [**ORIGINAL_PLAN_REFERENCE.md**](https://github.com/OWNER/REPO/blob/main/docs/ORIGINAL_PLAN_REFERENCE.md) | **Historical plan ledger:** mirrors the original implementation plan with todo IDs (e.g. `docker-compose`, `warehouse-views`, `webhooks`, `nfr-secrets`) and their completion status. Useful for **why** a feature exists, **scope** boundaries, and tracing decisions back to the original v1 spec. Can be long; use search within the file for a specific area. |
| [**V2_BACKLOG.md**](https://github.com/OWNER/REPO/blob/main/docs/V2_BACKLOG.md) | **Post–v1 roadmap:** backlog workflow, status legend (`proposed` → `done`), and **V2 goals** (reliability, large libraries, security, multi-tenant ideas). Itemized **backlog entries** with IDs (e.g. `v2-rel-001`) for integrity audits, watermark repair, idempotency, etc. The living list of “what we might do next,” maintained during reviews and implementation. |

**Wiki:** [Roadmap-and-history](Roadmap-and-history) (short intro + links to the two files above).

---

## Web UI and agents

| Document | What it covers (detailed) |
|----------|---------------------------|
| [**WEBUI_FRAMEWORK.md**](https://github.com/OWNER/REPO/blob/main/docs/WEBUI_FRAMEWORK.md) | **Frontend stack and contracts:** React + Vite + TanStack Query; build output path into `src/arrsync/web/dist`. Documents **paged API contracts** for library endpoints (`/api/ui/shows`, episodes, movies) including query params, envelope shape, and **CSV export** URLs. Lists **advanced UX** (local storage, command palette, keyboard shortcuts, compare mode, detail drawer, diagnostics). Essential for anyone changing the Web UI or API surface used by it. |
| [**WEBUI_AGENT_WORKFLOW.md**](https://github.com/OWNER/REPO/blob/main/docs/WEBUI_AGENT_WORKFLOW.md) | **Process for multi-agent Web UI work:** defines **Task Tracker** vs **Quality Guardian** roles, handoff gates, and when to re-run tests before marking milestones done. Relevant to teams (or agents) using structured rebuild workflows—not required for end users, but important for **repeatable quality** on large UI changes. |

**Wiki pages:** [Web-UI](Web-UI) (summary + file map) · [Web-UI-agent-workflow](Web-UI-agent-workflow) (multi-agent process for large UI work; optional for most readers).

---

## Reporting and analytics

| Document | What it covers (detailed) |
|----------|---------------------------|
| [**REPORTING_ARCHITECTURE.md**](https://github.com/OWNER/REPO/blob/main/docs/REPORTING_ARCHITECTURE.md) | **Reporting subsystem end-to-end:** goal (analytics in the Web UI without unsafe SQL in the browser). **Security model:** fixed dashboard keys, whitelist-only server SQL, parameterized filters, no ad-hoc SQL from clients. **Flow:** catalog → `GET /api/reporting/dashboards/{key}` → panel types (`stat`, `distribution`, `table`). **Porting strategy** for legacy dashboard definitions. Read this before adding dashboards or changing reporting APIs. |

**Wiki mirror page:** [Reporting-system](Reporting-system) (synthesis + links).

---

## Database: bootstrap, migrations, backup

| Document | What it covers (detailed) |
|----------|---------------------------|
| [**DB_BOOTSTRAP.md**](https://github.com/OWNER/REPO/blob/main/docs/DB_BOOTSTRAP.md) | **First boot:** Postgres start, **Alembic upgrade** on app startup, Web UI / API **database bootstrap** for the `arrapp` role, encrypted URL on disk, and which schemas/tables appear. Includes **verification SQL** (`\du`, `\dn`, sample counts). |
| [**MIGRATIONS.md**](https://github.com/OWNER/REPO/blob/main/docs/MIGRATIONS.md) | **Schema change policy:** **roll-forward** only for production-style environments; **expand/contract** pattern (nullable columns, dual-write, backfill, then drop old shape). **View contracts**—consumers should use `warehouse.v_*` views; breaking changes need coordinated migrations. **Safe deployment order:** migrate first, then deploy app, then verify. |
| [**BACKUP_RESTORE.md**](https://github.com/OWNER/REPO/blob/main/docs/BACKUP_RESTORE.md) | **Backup/restore procedures:** logical (`pg_dump`) vs physical (volume tarball) with example **docker** commands. **Restore** flow, then **`alembic upgrade head`**, and **healthz** verification. Critical for operational continuity and disaster recovery. |
| [**POOLING_AND_TIMEOUTS.md**](https://github.com/OWNER/REPO/blob/main/docs/POOLING_AND_TIMEOUTS.md) | **SQLAlchemy pool** and **Postgres `statement_timeout`:** env vars (`SQLALCHEMY_*`, `SQL_STATEMENT_TIMEOUT_MS`), recommended defaults for small/medium deploys, and **timeout policy** differences between **sync workers** and **Web UI** requests. Tuning under load. |

**Wiki mirror page:** [Data-layer-and-PostgreSQL](Data-layer-and-PostgreSQL) (narrative + links).

---

## Sync, locks, queues, scheduler

| Document | What it covers (detailed) |
|----------|---------------------------|
| [**LOCKING_AND_DLQ.md**](https://github.com/OWNER/REPO/blob/main/docs/LOCKING_AND_DLQ.md) | **Job locks:** `app.job_lock` lifecycle, `lock_name` pattern (`{source}:{mode}`), acquire / heartbeat / reclaim on expiry. **Webhook queue** states (`queued` → `retrying` → `done` or `dead_letter`), **retry/backoff**, and **manual replay** via API. The authoritative reference for concurrency and failure handling around sync and webhooks. |
| [**SCHEDULER_TIMEZONE.md**](https://github.com/OWNER/REPO/blob/main/docs/SCHEDULER_TIMEZONE.md) | **Cron interpretation:** 5-field crontab, per-row `timezone` vs `SCHEDULER_TIMEZONE` / `APP_TIMEZONE` fallbacks. **Recommendations** (often UTC in DB, display in UI). How warehouse timestamps relate (UTC, `airDateUtc` vs `airDate` for Sonarr). |

**Wiki mirror page:** [Sync-locking-and-webhooks](Sync-locking-and-webhooks) (synthesis + links).

---

## Observability, health, and alerts

| Document | What it covers (detailed) |
|----------|---------------------------|
| [**ALERTS_AND_SLOS.md**](https://github.com/OWNER/REPO/blob/main/docs/ALERTS_AND_SLOS.md) | **Health state machine** and how derived health flows to **outbound alert webhooks** (transition-based to avoid noise). Suggested **Prometheus** alert conditions (queue depth, sync lag, failed runs). **Operational targets** (freshness, DLQ, reconcile). Links metrics on `/metrics` to operator expectations. |
| (Metrics also described in) [**README.md**](https://github.com/OWNER/REPO/blob/main/README.md) | **Quick API table** including `/healthz`, `/metrics`, `/api/status`. |

**Wiki mirror page:** [Observability-and-health](Observability-and-health) (synthesis + links).

---

## Security and configuration

| Document | What it covers (detailed) |
|----------|---------------------------|
| [**SECRETS.md**](https://github.com/OWNER/REPO/blob/main/docs/SECRETS.md) | **Secret flow:** env and optional Docker secrets → app; **optional encryption** for integration API keys and settings blobs; **one-way hash** for webhook shared secret. **Logging policy** (no credentials in logs). **At-rest** notes for DB access and backups. The security baseline for deployers. |

**Wiki mirror page:** [Security-secrets-and-configuration](Security-secrets-and-configuration) (synthesis + links).

---

## Operations and deployment

| Document | What it covers (detailed) |
|----------|---------------------------|
| [**OPERATIONS_RUNBOOK.md**](https://github.com/OWNER/REPO/blob/main/docs/OPERATIONS_RUNBOOK.md) | **Runbook:** greenfield bring-up, **incident triage** (healthz → metrics → Web UI → SQL). First run, **normal operation**, **force full sync** curl examples, **replay dead letter**, when to **reset** data (danger), and pointers for DB / integration checks. The main operator guide. |
| [**COMPOSE_RESOURCE_HINTS.md**](https://github.com/OWNER/REPO/blob/main/docs/COMPOSE_RESOURCE_HINTS.md) | **Resource sizing** for Docker: CPU/memory for full-sync spikes vs steady state, example `deploy.resources` (Swarm), and keeping headroom for Postgres. |
| **Deploy samples in repo** | [`deploy/unraid/`](https://github.com/OWNER/REPO/tree/main/deploy/unraid) (compose, XML templates for Unraid). Complements root [`docker-compose.yml`](https://github.com/OWNER/REPO/blob/main/docker-compose.yml). |

**Wiki pages:** [Deployment](Deployment), [Unraid-and-advanced-deploy](Unraid-and-advanced-deploy). Root **README** [Quickstart](https://github.com/OWNER/REPO/blob/main/README.md#quickstart) for default stack.

---

## Performance and indexing

| Document | What it covers (detailed) |
|----------|---------------------------|
| [**PERF_INDEXING_PLAN.md**](https://github.com/OWNER/REPO/blob/main/docs/PERF_INDEXING_PLAN.md) | **v1 indexing strategy:** when to add indexes (decision flow from `EXPLAIN ANALYZE`), **query patterns** (instance, `deleted`, time columns, file analytics), **existing baseline** indexes, and **recommended** btree/GIN additions with migration safety (concurrent where possible). Materialized view notes if present later in the file. |

**Wiki mirror page:** [Performance-tuning](Performance-tuning) (pools + perf + compose resources).

---

## Branding and product

| Document | What it covers (detailed) |
|----------|---------------------------|
| [**BRANDING.md**](https://github.com/OWNER/REPO/blob/main/docs/BRANDING.md) | **Product name** (Nebularr), **asset map** (icon, logo, README banner), **brand intent** (nebula + arr naming, dark control-plane feel). Path references under `src/arrsync/web/assets/`. |

**Wiki mirror page:** [Branding-and-assets](Branding-and-assets).

---

## How this index is maintained

When you add, rename, or remove a `*.md` file under `docs/`, **update this wiki page** (in `docs/wiki/Documentation-index.md` on the default branch) and re-publish the wiki so GitHub and the tree stay aligned.

For a **narrative tour** of the whole project (not file-by-file), see [Project-deep-dive](Project-deep-dive).
