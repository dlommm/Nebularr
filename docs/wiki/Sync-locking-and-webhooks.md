# Sync, locking, and webhooks

This page **summarizes** how concurrent sync work and **inbound** Arr webflows interact. The **authoritative** diagrams and state lists are in [LOCKING_AND_DLQ.md](https://github.com/OWNER/REPO/blob/main/docs/LOCKING_AND_DLQ.md) and [SCHEDULER_TIMEZONE.md](https://github.com/OWNER/REPO/blob/main/docs/SCHEDULER_TIMEZONE.md). Replace `OWNER/REPO` in links.

## Job locks (single-flight)

- **Purpose:** only one *owner* at a time for a given logical sync “lane” (e.g. `sonarr:incremental`), implemented via `app.job_lock` with `lock_name`, `owner_id`, **heartbeat**, `expires_at`.  
- **Recovery:** if a process dies, the **lease** can expire so another worker can **reclaim**.  
- **Behavior:** start → try acquire; long jobs **heartbeat**; finish path releases lock.

**Details & diagrams:** [LOCKING_AND_DLQ.md](https://github.com/OWNER/REPO/blob/main/docs/LOCKING_AND_DLQ.md) (lock lifecycle, field list).

## Webhook queue and dead letter

- Inbound HTTP from Sonarr/Radarr → **validate** (shared secret) → **dedupe/queue** in `app.webhook_queue`.  
- States typically include **queued** → **retrying** (with backoff) → **done** or **dead_letter** after max attempts.  
- **Replay** of dead letters is a deliberate operator action via API; see [OPERATIONS_RUNBOOK](https://github.com/OWNER/REPO/blob/main/docs/OPERATIONS_RUNBOOK.md).

**Details & diagrams:** [LOCKING_AND_DLQ.md](https://github.com/OWNER/REPO/blob/main/docs/LOCKING_AND_DLQ.md) (queue states, retry, DLQ, replay path).

## Scheduler and cron

- Schedules for incremental/reconcile (and MAL-related modes when enabled) are stored per **row** in the database with a **5-field** cron and optional **per-row timezone**.  
- If the row has no timezone, the scheduler uses env fallbacks such as `SCHEDULER_TIMEZONE` / `APP_TIMEZONE` (see doc).  
- **Recommendation:** keep scheduler DB rows in **UTC** for predictability; present local times in UI if needed.  

**Full reference:** [SCHEDULER_TIMEZONE.md](https://github.com/OWNER/REPO/blob/main/docs/SCHEDULER_TIMEZONE.md).

## Where to read in code

- **HTTP surface:** [`api.py`](https://github.com/OWNER/REPO/blob/main/src/arrsync/api.py) (webhook routes, sync POST routes, UI APIs).  
- **README** table: [API surface (quick reference)](https://github.com/OWNER/REPO/blob/main/README.md#api-surface-quick-reference).  

**Related:** [Backend-and-API](Backend-and-API) · [Observability-and-health](Observability-and-health) (queue depth in health/metrics).
