# Database Bootstrap

## First-boot sequence

```mermaid
sequenceDiagram
  participant PG as PostgreSQL container
  participant Init as docker/postgres/init SQL
  participant App as Nebularr app
  participant Alb as Alembic

  PG->>Init: run 00_roles.sql (arrapp role)
  App->>Alb: upgrade head on startup
  Alb->>PG: create app + warehouse schemas/tables
  App->>PG: normal read/write as arrapp
```

On fresh startup, the stack creates:

- role (`arrapp`) via `docker/postgres/init/00_roles.sql`
- schemas and tables via Alembic migrations

## First-run permissions

- App uses `arrapp` credentials in `DATABASE_URL`.

## Verification SQL

```sql
\du
\dn
select count(*) from warehouse.sync_run;
```
