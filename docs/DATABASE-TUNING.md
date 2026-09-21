# Database Tuning

Postgres ships defaults sized for a machine far smaller than the one Nebularr
usually runs on. They are not a starting point that grows with you — they are a
floor, and nothing in Postgres raises them on your behalf. This page is the set of
values worth changing, why each one matters to this workload, and how to confirm it
worked.

Everything here is a server setting, so it lives in compose (and therefore `.env`),
not in a migration. Schema-level maintenance — reclaiming bloat, dropping dead
indexes — is automated in migration `0015` and needs nothing from you.

## Why the defaults hurt this workload

Nebularr's hot path is two tables: `warehouse.episode` and
`warehouse.episode_file`. Every automation, every report and every library listing
joins them. On a real 133k-episode / 111k-file library they are roughly 850 MB
together — against a stock `shared_buffers` of **128 MB**.

Measured on that library before tuning:

| Table | Cache hit ratio | Blocks read from disk (lifetime) |
| --- | --- | --- |
| `warehouse.episode` | **10.9%** | 46.3 billion |
| `warehouse.episode_file` | **10.8%** | 45.6 billion |

A healthy table sits above 95%. At 11% nearly every read is a disk read, because
neither table can stay resident in a 128 MB pool. That single setting dominates
everything else on this list.

## What to set

Add these to `.env`. The compose files read every one, so a value you leave out
keeps the default shown in the last column.

```dotenv
POSTGRES_SHARED_BUFFERS=8GB
POSTGRES_EFFECTIVE_CACHE_SIZE=24GB
POSTGRES_WORK_MEM=64MB
POSTGRES_MAINTENANCE_WORK_MEM=1GB
POSTGRES_RANDOM_PAGE_COST=1.1
POSTGRES_EFFECTIVE_IO_CONCURRENCY=200
POSTGRES_MAX_WAL_SIZE=4GB
POSTGRES_STATISTICS_TARGET=200
POSTGRES_SHM_SIZE=1gb
```

| Setting | What it does here | Default if unset |
| --- | --- | --- |
| `POSTGRES_SHARED_BUFFERS` | The buffer pool. Wants to hold both hot tables at once. The single highest-impact value on this page. | `2GB` |
| `POSTGRES_EFFECTIVE_CACHE_SIZE` | Not an allocation — what the planner *believes* is cacheable between Postgres and the OS. Too low and it avoids index scans that would in fact be cheap. | `6GB` |
| `POSTGRES_WORK_MEM` | Per sort/hash node, and a query can use several at once. Too low and joins spill to temp files on disk. | `32MB` |
| `POSTGRES_MAINTENANCE_WORK_MEM` | Used by `VACUUM`, `ANALYZE` and index builds — including migration 0015's rewrite. | `512MB` |
| `POSTGRES_RANDOM_PAGE_COST` | The planner's guess at random-vs-sequential read cost. The stock `4.0` describes a spinning disk and biases against exactly the index scans this workload depends on. | `1.1` |
| `POSTGRES_EFFECTIVE_IO_CONCURRENCY` | How many concurrent reads the storage can serve. SSDs and NVMe do far more than the stock `1`. | `200` |
| `POSTGRES_MAX_WAL_SIZE` | WAL allowed between checkpoints. Raising it spreads write spikes from a full reconcile over more time. | `4GB` |
| `POSTGRES_STATISTICS_TARGET` | Histogram detail per column. More detail means better row estimates on the skewed `series -> episode` fan-out. | `200` |
| `POSTGRES_SHM_SIZE` | Docker caps `/dev/shm` at 64 MB, which parallel workers use to exchange tuples. Too small and a parallel scan dies with "could not resize shared memory segment". | `1gb` |

### Sizing to your host

`shared_buffers` is conventionally 25% of RAM and `effective_cache_size` about 75%.
Those are shares of what you are willing to give the *database*, not of the whole
machine — on a NAS also running media services, budget from the slice Postgres gets.

| RAM available to Postgres | `SHARED_BUFFERS` | `EFFECTIVE_CACHE_SIZE` | `WORK_MEM` | `MAINTENANCE_WORK_MEM` |
| --- | --- | --- | --- | --- |
| 4 GB | `1GB` | `3GB` | `16MB` | `256MB` |
| 8 GB | `2GB` | `6GB` | `32MB` | `512MB` |
| 16 GB | `4GB` | `12GB` | `48MB` | `1GB` |
| 32 GB | `8GB` | `24GB` | `64MB` | `1GB` |
| 64 GB | `16GB` | `48GB` | `96MB` | `2GB` |

Past roughly 16 GB of `shared_buffers` the returns flatten for a database this
size — once both hot tables are fully resident, more pool buys nothing. A 1 GB
database does not need 16 GB of buffers; if your library is this size, `8GB` is
already generous and the rest is better left to the OS page cache.

`work_mem` is the one to be careful with: it is per sort or hash node, so the
worst case is roughly `max_connections` × nodes-per-query × `work_mem`. With
`SQLALCHEMY_POOL_SIZE=10` and `SQLALCHEMY_MAX_OVERFLOW=20` the app opens at most 30
connections, so `64MB` tops out near 2 GB under pathological load. Keep it well
under the RAM you have spare.

## Applying it

```bash
docker compose down
# edit .env
docker compose up -d
```

`shared_buffers` needs a full restart — `docker compose restart` will not pick it
up, because the setting is read at postmaster start.

## Confirming it worked

Read the values back:

```bash
docker exec nebularr-postgres psql -U arradmin -d arranalytics -c \
  "select name, setting, unit from pg_settings
   where name in ('shared_buffers','effective_cache_size','work_mem','random_page_cost')"
```

Then let it run for a day and check the cache hit ratio:

```bash
docker exec nebularr-postgres psql -U arradmin -d arranalytics -c \
  "select relname,
          round(100.0*heap_blks_hit/nullif(heap_blks_hit+heap_blks_read,0),1) as cache_hit_pct
   from pg_statio_user_tables where schemaname='warehouse'
   order by heap_blks_read desc limit 5"
```

These counters are cumulative since the database was created, so a long-running
instance will take a while to drag the average up even after the fix. To judge the
change on its own, reset them first with
`select pg_stat_reset();` and read the ratio the next day.

## What tuning will not fix

A query the planner cannot index is not a tuning problem. The series-completeness
timeout in v2.9.2 came from a `CASE` in a join condition, which is opaque to the
planner — it cannot push either branch to an index. Re-measured on the real library
with `shared_buffers=2GB`, `random_page_cost=1.1`, zero bloat and a warm cache, that
query **still exceeded 180 seconds**; rewritten as an `OR` of two equalities it runs
in 470 ms. Reach for `EXPLAIN (ANALYZE, BUFFERS)` before reaching for a knob:
`Materialize` under a nested loop, or `Rows Removed by Join Filter` in the hundreds
of thousands, means the join shape is wrong and no amount of memory will save it.

Postgres also has no auto-indexing. Nothing will notice a missing index and create
it, and nothing rewrites a bad plan. Autovacuum is the only thing that maintains
itself, and it already works — on the library measured here it had run 54–59 times
on the big tables with the most recent pass minutes old. Do not add a scheduled
`VACUUM` job; you would only be doing worse what the daemon already does well.

## Related

- `docs/POOLING_AND_TIMEOUTS.md` — connection pool and statement timeout sizing
- `docs/COMPOSE_RESOURCE_HINTS.md` — CPU and memory limits for the app container
- `docs/MIGRATIONS.md` — how migrations run at startup, including 0015's reclaim
