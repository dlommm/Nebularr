# Project deep dive (everything in one narrative)

This page **does not replace** the canonical docs in [`docs/`](https://github.com/OWNER/REPO/tree/main/docs). It **ties them together** so you can understand the full picture before opening each file. Replace `OWNER/REPO` in links as usual.

## What Nebularr is

Nebularr is a **long-running service** (typically in Docker) that:

1. **Pulls** series/movie and file metadata from **Sonarr** and **Radarr** via their REST APIs.  
2. **Accepts** real-time **webhooks** from those apps, queues them, and performs **targeted fetches** to stay current.  
3. **Persists** normalized data in **PostgreSQL** in two logical areas: **`app`** (configuration, schedules, watermarks, webhook queue, job locks, runs) and **`warehouse`** (analytical entities and **`v_*` views** for reporting and external BI).  
4. **Serves** a **Web UI** and JSON **APIs** for operators (library browser, run history, integrations, reporting dashboards, admin actions).  
5. Exposes **health** and **Prometheus metrics** for monitoring.

The main [README](https://github.com/OWNER/REPO/blob/main/README.md) has the API quick-reference table and mermaid diagrams for request flows; [ARCHITECTURE](https://github.com/OWNER/REPO/blob/main/docs/ARCHITECTURE.md) goes deeper on sync mode states and runtime.

## The two database roles (`app` vs `warehouse`)

- **`app`** — Operational: integration rows, schedule definitions, **webhook queue** (with retries and dead letter), **job locks** for single-flight sync, run summaries, settings.  
- **`warehouse`** — Analytical: upserted series/episodes/movies/files for analytics. External tools and the reporting API prefer **`warehouse.v_*` views** so schema evolution can be managed via migrations and view versions.

[DB_BOOTSTRAP](https://github.com/OWNER/REPO/blob/main/docs/DB_BOOTSTRAP.md) describes first-time creation; [MIGRATIONS](https://github.com/OWNER/REPO/blob/main/docs/MIGRATIONS.md) how you evolve schema safely; [BACKUP_RESTORE](https://github.com/OWNER/REPO/blob/main/docs/BACKUP_RESTORE.md) for durability.

## How sync and webhooks interact

- **Full sync** — Large initial or forced backfill.  
- **Incremental** — Regular polling of history/change windows.  
- **Reconcile** — Broader consistency passes on a schedule.  
- **Webhooks** — Asynchronous: POST to Nebularr → **queue** → worker claims job → **Arr REST** → **upsert** warehouse.

**Locks** prevent two jobs of the same `source:mode` from trampling each other; **leases** expire if a process dies. [LOCKING_AND_DLQ](https://github.com/OWNER/REPO/blob/main/docs/LOCKING_AND_DLQ.md) is the full story.

**Cron** for incremental/reconcile lives in the DB; timezone rules are in [SCHEDULER_TIMEZONE](https://github.com/OWNER/REPO/blob/main/docs/SCHEDULER_TIMEZONE.md).

## The Web UI and reporting

The SPA (see [WEBUI_FRAMEWORK](https://github.com/OWNER/REPO/blob/main/docs/WEBUI_FRAMEWORK.md)) calls **server-defined** endpoints only. **Reporting** does **not** allow arbitrary SQL from the browser: dashboard keys are **whitelisted** and map to **parameterized** server queries over `warehouse` views. See [REPORTING_ARCHITECTURE](https://github.com/OWNER/REPO/blob/main/docs/REPORTING_ARCHITECTURE.md).

## Observability and operations

- `/healthz`, `/api/status` — Liveness and derived health.  
- `/metrics` — Prometheus text.  
- Alert webhooks and **state transitions** are documented in [ALERTS_AND_SLOS](https://github.com/OWNER/REPO/blob/main/docs/ALERTS_AND_SLOS.md).

[OPERATIONS_RUNBOOK](https://github.com/OWNER/REPO/blob/main/docs/OPERATIONS_RUNBOOK.md) is the step-by-step operator guide (bring-up, triage, replay DLQ, danger zone).

## Security and configuration

[SECRETS](https://github.com/OWNER/REPO/blob/main/docs/SECRETS.md) documents env, optional encryption at rest for some fields, and **no secrets in logs**.

## Performance and scale

- [POOLING_AND_TIMEOUTS](https://github.com/OWNER/REPO/blob/main/docs/POOLING_AND_TIMEOUTS.md) — DB pool and statement timeouts.  
- [PERF_INDEXING_PLAN](https://github.com/OWNER/REPO/blob/main/docs/PERF_INDEXING_PLAN.md) — Indexes and `EXPLAIN` workflow.  
- [COMPOSE_RESOURCE_HINTS](https://github.com/OWNER/REPO/blob/main/docs/COMPOSE_RESOURCE_HINTS.md) — CPU/memory.  

## Roadmap and history

- [V2_BACKLOG](https://github.com/OWNER/REPO/blob/main/docs/V2_BACKLOG.md) — What might come after v1.  
- [ORIGINAL_PLAN_REFERENCE](https://github.com/OWNER/REPO/blob/main/docs/ORIGINAL_PLAN_REFERENCE.md) — Original plan checklist and design ledger.  

## Finding “everything”

1. [Documentation index](Documentation-index) — **per-file** descriptions of every `docs/*.md` (except files under `docs/wiki/`, which describe the wiki itself).  
2. [Roadmap and history](Roadmap-and-history) — **V2 backlog** and **original plan** links.  
3. [Repository map](Repository-map) — **where code** lives.  
4. [README](https://github.com/OWNER/REPO/blob/main/README.md) — **default quickstart and API table**.  

---

*Maintained in-repo at [`docs/wiki/Project-deep-dive.md`](https://github.com/OWNER/REPO/blob/main/docs/wiki/Project-deep-dive.md).*
