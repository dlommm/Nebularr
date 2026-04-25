# Data layer and PostgreSQL

Synthesis of in-repo database documentation, with **canonical** detail in the linked files. Replace `OWNER/REPO` in GitHub links.

## Why two schemas (conceptual)

- **`app`** — Control plane: integrations, **schedules**, **webhook queue**, **job locks**, run metadata, app settings, encrypted or hashed fields as designed.  
- **`warehouse`** — Analytical: normalized Sonarr/Radarr-derived entities, **views** for stable reporting contracts.

## First boot: roles and Alembic

1. Postgres starts; init scripts under [`docker/postgres/init`](https://github.com/OWNER/REPO/tree/main/docker/postgres) (e.g. `00_roles.sql`) create the DB role used in `DATABASE_URL`.  
2. The application runs **Alembic** to **create/update** `app` and `warehouse` objects.  

**Full reference:** [DB_BOOTSTRAP.md](https://github.com/OWNER/REPO/blob/main/docs/DB_BOOTSTRAP.md) (sequence diagram, verification SQL).

## Migrations: roll forward, expand/contract

- Production deploys use **roll-forward** migrations only.  
- **Expand** first (new nullable columns, new tables), deploy compatible app, **backfill**, then **contract** in a *later* migration.  
- **Views:** consumers should use **`warehouse.v_*`**; breaking changes may require new view names or coordinated app + SQL updates.  

**Full reference:** [MIGRATIONS.md](https://github.com/OWNER/REPO/blob/main/docs/MIGRATIONS.md).

## Backup and restore

- **Logical** dumps (`pg_dump` / `psql`) and **volume**-level copies are both discussed with **compose**-friendly examples.  
- After restore, run **`alembic upgrade head`** and check **`/healthz`**.  

**Full reference:** [BACKUP_RESTORE.md](https://github.com/OWNER/REPO/blob/main/docs/BACKUP_RESTORE.md).

## Connection pooling and query timeouts

- `SQLALCHEMY_POOL_SIZE`, `SQLALCHEMY_MAX_OVERFLOW`, `SQLALCHEMY_POOL_RECYCLE`, and **`SQL_STATEMENT_TIMEOUT_MS`** control pool behavior and server-side **statement** limits.  
- Sync workloads vs interactive Web UI reads have **different** tuning guidance.  

**Full reference:** [POOLING_AND_TIMEOUTS.md](https://github.com/OWNER/REPO/blob/main/docs/POOLING_AND_TIMEOUTS.md).

## Indexing and query performance (warehouse + reporting)

- When queries are slow: **`EXPLAIN ANALYZE`**, check predicates, add indexes (often **`instance_name`**, **`deleted`**, time columns) per the plan doc.  
- Baseline and **recommended** indexes are listed in [PERF_INDEXING_PLAN.md](https://github.com/OWNER/REPO/blob/main/docs/PERF_INDEXING_PLAN.md).

**Related wiki:** [Performance-tuning](Performance-tuning) (pools + perf + host resources in one place).

## Related

- [Sync-locking-and-webhooks](Sync-locking-and-webhooks) — what lands in `app` tables for queues and locks.  
- [Reporting-system](Reporting-system) — how `warehouse` is queried safely for dashboards.  
