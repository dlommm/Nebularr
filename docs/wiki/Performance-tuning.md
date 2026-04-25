# Performance tuning (DB, queries, and host resources)

This wiki page groups three in-repo guides that together cover **most** performance work: connection pools, **SQL** timeouts, **indexing**, and **Docker resource** hints. Always confirm with **`EXPLAIN ANALYZE`** and real metrics on your hardware.

## 1. Connection pool and statement timeouts

- **`SQLALCHEMY_POOL_SIZE`**, **`SQLALCHEMY_MAX_OVERFLOW`**, **`SQLALCHEMY_POOL_RECYCLE`** — how many DB connections the app holds and how aggressively they are recycled.  
- **`SQL_STATEMENT_TIMEOUT_MS`** — server-side cap on how long a single statement may run; **sync** jobs vs **interactive** API may need different effective behavior (longer for batch upserts, shorter for UI).  

**Starting points and tuning narrative:** [POOLING_AND_TIMEOUTS.md](https://github.com/OWNER/REPO/blob/main/docs/POOLING_AND_TIMEOUTS.md).

## 2. Indexes and warehouse/reporting queries

- **Workflow:** slow query → `EXPLAIN ANALYZE` → check filters (`instance_name`, `deleted`, time columns) → add **btree/GIN** per pattern → re-measure **p95** and full-sync impact.  
- **Baseline** indexes from migrations and **recommended next** indexes are listed in the plan.  
- Prefer stable **`warehouse.v_*` view** contracts when building reporting; see [MIGRATIONS](https://github.com/OWNER/REPO/blob/main/docs/MIGRATIONS.md) when changing views.  

**Full reference:** [PERF_INDEXING_PLAN.md](https://github.com/OWNER/REPO/blob/main/docs/PERF_INDEXING_PLAN.md).

## 3. CPU and memory (Docker / Compose)

- **Full sync** can **spike** CPU and memory; **webhook bursts** stress the app; **steady** incremental work is lighter.  
- Example **Compose** `deploy.resources` (noted as Swarm-oriented; plain Compose may use different constraints).  
- Leave headroom for **Postgres** buffer cache.  

**Full reference:** [COMPOSE_RESOURCE_HINTS.md](https://github.com/OWNER/REPO/blob/main/docs/COMPOSE_RESOURCE_HINTS.md).

## 4. Reporting and Web UI

- Reporting uses **whitelisted** SQL; performance issues may be **index** issues on the underlying warehouse queries—cross-check with the perf plan.  
- The Web UI’s heavy tables use **server pagination**; see [WEBUI_FRAMEWORK](https://github.com/OWNER/REPO/blob/main/docs/WEBUI_FRAMEWORK.md).  

**Related:** [Data-layer-and-PostgreSQL](Data-layer-and-PostgreSQL) · [Reporting-system](Reporting-system).
