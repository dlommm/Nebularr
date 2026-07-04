# Original Plan Reference (In-Repo)

This document mirrors the original implementation plan in the repository so it can be maintained over time.

## Plan Metadata

- **Name:** Sonarr/Radarr data strategy
- **Overview:** Docker Compose app + PostgreSQL (`app` + `warehouse` schemas), full/incremental/webhook sync modes, warehouse views for dashboards, and reliability hardening.

## Plan Todo Ledger

Status values below are mirrored from the original plan tracking.

| ID | Status | Scope |
| --- | --- | --- |
| `docker-compose` | completed | default `postgres` + `app` |
| `postgres-schemas` | completed | Alembic schemas/tables + app grants |
| `warehouse-views` | completed | stable analytics views in `warehouse` |
| `full-sync-sonarr` | completed | first/forced Sonarr full sync (series + episodes/files) |
| `full-sync-radarr` | completed | first/forced Radarr full sync (movies/files) |
| `incremental-reconcile` | completed | history polling + reconcile flow |
| `webhooks` | completed | authenticated webhook ingress + queue + targeted fetches |
| `scheduler-ui` | completed | schedule CRUD + manual run actions |
| `webui` | completed | modern multi-view operations UI |
| `metrics-health` | completed | `/metrics`, health, run summary capture |
| `reporting-docs` | completed | reporting and dashboard docs |
| `nfr-secrets` | completed | env/secrets preference + no secret logging + docs |
| `nfr-instance-scope` | completed | v1 multi-instance model |
| `nfr-idempotency` | completed | idempotent upserts + dedupe-safe overlap |
| `nfr-arr-version` | completed | record/show Arr version |
| `nfr-rate-limits` | completed | conservative API concurrency/retry controls |
| `nfr-time-canonical` | completed | UTC/time semantics docs |
| `docs-backup-restore` | completed | backup/restore and credential rotation docs |
| `nfr-observability` | completed | structured logs + request correlation |
| `compose-resource-hints` | completed | CPU/memory recommendations |
| `tests-contract-smoke` | completed | contract tests + optional CI smoke |
| `job-locking` | completed | single-flight lock semantics |
| `data-retention-pruning` | completed | retention and pruning policy |
| `dead-letter-retry-policy` | completed | retry/backoff + dead-letter handling |
| `perf-indexing-plan` | completed | indexing/materialization strategy doc |
| `config-validation` | completed | startup/UI config validation |
| `docs-operations-runbook` | completed | operator runbook |
| `migration-safety-rollforward` | completed | expand/contract, roll-forward guidance |
| `api-capability-detection` | completed | startup API capability probing |
| `alerting-slos` | completed | thresholds + health-state model |
| `data-lineage-audit-columns` | completed | lineage fields in warehouse rows |
| `graceful-shutdown` | completed | signal handling + lock release/drain behavior |
| `http-timeouts-retries` | completed | bounded timeout/retry policy |
| `media-deletes-tombstones` | completed | delete/tombstone propagation |
| `ci-quality-gates` | completed | lint/type/test gates |
| `bootstrap-db-roles` | completed | fresh DB roles/schemas/grants bootstrap |
| `advisory-lock-lease-strategy` | completed | lock model and crash recovery |
| `webhook-http-hardening` | completed | body/auth/parse hardening |
| `postgres-engine-pooling` | completed | pool + timeout guidance |
| `docs-readme-quickstart` | completed | root quickstart flow |
| `build-metadata-health` | completed | version/SHA in status/health surfaces |
| `scheduler-timezone` | completed | scheduler timezone semantics doc |

## Core Plan Summary

- Ingestion path is Sonarr/Radarr REST APIs only.
- PostgreSQL is the only database runtime dependency.
- `warehouse` schema is analytics-facing; `app` schema is operational state.
- Default stack is `app + postgres`.
- Full sync initializes data; incremental polling + webhooks maintain deltas.
- Warehouse views provide stable contracts for reporting queries.

## Architecture Drawings (Consolidated)

The following section consolidates architecture drawings from the original plan and architecture docs.

### Runtime And Trust Boundaries

```mermaid
flowchart TB
  subgraph external [Outside_this_compose]
    sonarr[Sonarr]
    radarr[Radarr]
    browser[Browser]
  end
  subgraph dockerStack [Docker_Compose_default]
    collectorApp[Collector_WebUI]
    postgresDb[(PostgreSQL)]
  end
  sonarr -->|"REST_v3_pull"| collectorApp
  radarr -->|"REST_v3_pull"| collectorApp
  sonarr -->|"Webhooks_POST"| collectorApp
  radarr -->|"Webhooks_POST"| collectorApp
  browser -->|"Web_UI_HTTP"| collectorApp
  collectorApp -->|"app_plus_warehouse_RW"| postgresDb
```

### PostgreSQL Schema Access Model

```mermaid
flowchart LR
  subgraph pg [PostgreSQL_one_database]
    schApp[schema_app]
    schWh[schema_warehouse]
  end
  syncApp[Collector_app]
  syncApp -->|"read_write"| schApp
  syncApp -->|"read_write"| schWh
```

### Sync Lifecycle State Machine

```mermaid
stateDiagram-v2
  [*] --> BootIdle
  BootIdle --> FirstFullSync: warehouse_uninitialized_or_force_full
  BootIdle --> SteadyState: watermarks_and_schema_ok
  FirstFullSync --> SteadyState: full_sync_finished_ok
  SteadyState --> IncrementalSync: cron_or_manual_incremental
  IncrementalSync --> SteadyState: batch_committed
  SteadyState --> WebhookDrain: queue_has_rows
  WebhookDrain --> SteadyState: queue_empty_or_paused
  SteadyState --> ReconcileFull: scheduled_or_manual_reconcile
  ReconcileFull --> SteadyState: reconcile_finished_ok
```

### Webhook Handling Sequence

```mermaid
sequenceDiagram
  participant Arr as Sonarr_or_Radarr
  participant Col as Collector_app
  participant Que as app_webhook_queue
  participant Api as Arr_REST_API
  participant Wh as warehouse_tables

  Arr->>Col: POST_signed_webhook
  Col->>Que: enqueue_payload
  Col-->>Arr: HTTP_2xx_ack
  Col->>Que: claim_next_job
  Col->>Api: GET_minimal_followups
  Api-->>Col: entity_JSON
  Col->>Wh: idempotent_upsert
  Col->>Que: mark_done_or_retry
```

### Job Locking Coordination

```mermaid
flowchart TD
  trig[Trigger_source cron_manual_webhook] --> acquire[Try_db_lock_by_mode_instance]
  acquire -->|lock_granted| run[Execute_sync_job]
  acquire -->|lock_busy| skip[Record_skipped_due_to_lock]
  run --> commit[Commit_upserts_and_state]
  commit --> release[Release_lock]
  run --> fail[Record_failure]
  fail --> release
```

### Error Handling And Dead-Letter Lifecycle

```mermaid
flowchart LR
  recv[Webhook_or_incremental_event] --> q[app_webhook_queue_status_queued]
  q --> work[Worker_attempt]
  work -->|success| done[status_done]
  work -->|transient_error| retry[status_retrying_backoff]
  retry --> work
  work -->|max_attempts_exceeded| dlq[status_dead_letter]
  dlq --> replay[Manual_replay_action]
  replay --> q
```

### Incremental History Poll Sequence

```mermaid
sequenceDiagram
  participant Sch as Scheduler
  participant Col as Collector_app
  participant App as app_sync_state
  participant Api as Arr_REST_API_history
  participant Wh as warehouse_tables

  Sch->>Col: trigger_incremental
  Col->>App: read_watermark
  App-->>Col: since_cursor
  Col->>Api: GET_history_since_cursor
  Api-->>Col: event_batch
  Col->>Wh: targeted_upserts_per_event
  Col->>App: advance_watermark_after_commit
```

### Full Sync Fan-Out

```mermaid
flowchart TD
  start[Start_full_sync] --> list[GET_all_series]
  list --> pool[Bounded_worker_pool]
  pool --> s1[GET_episodes_series_1]
  pool --> s2[GET_episodes_series_N]
  s1 --> upsert[Idempotent_upsert_warehouse]
  s2 --> upsert
  upsert --> moreSeries{More_series}
  moreSeries -->|yes| pool
  moreSeries -->|no| done[Finalize_sync_run]
```

### Capability Probe At Startup

```mermaid
flowchart LR
  boot[App_boot] --> ping[GET_system_status_each_instance]
  ping --> store[Persist_capabilities_in_app_cache]
  store --> workers[Sync_workers_read_cached_shapes]
  workers --> refresh[Optional_refresh_on_config_change]
```

### Graceful Shutdown Sequence

```mermaid
sequenceDiagram
  participant Os as OS_SIGTERM
  participant App as Collector_app
  participant Sch as Scheduler
  participant Wk as Active_worker
  participant Db as PostgreSQL

  Os->>App: SIGTERM
  App->>Sch: stop_new_triggers
  App->>Wk: wait_or_checkpoint_batch
  Wk->>Db: commit_or_rollback_explicit
  App->>Db: release_advisory_locks
  App-->>Os: exit
```

### Delete/Tombstone Propagation

```mermaid
flowchart TD
  src[Source_signal] --> kind{Signal_kind}
  kind -->|webhook_delete_or_file_gone| evt[Map_to_entity_ids]
  kind -->|full_reconcile_diff| diff[Compare_API_ids_to_warehouse_ids]
  evt --> mark[Set_tombstone_or_delete_rows]
  diff --> mark
  mark --> views[Reporting_views_hide_or_show_deleted_flag]
```

### Lock Strategy Decision Aid

```mermaid
flowchart TD
  start[Choose_lock_model] --> tx[Transaction_scoped_advisory_lock]
  start --> sess[Session_scoped_advisory_lock]
  start --> row[Lock_table_row_with_lease]
  tx --> txPros[Pros_auto_release_on_commit]
  tx --> txCons[Cons_needs_short_transactions_or_split_work]
  sess --> sessPros[Pros_covers_multi_statement_jobs]
  sess --> sessCons[Cons_requires_explicit_unlock_on_shutdown]
  row --> rowPros[Pros_watchdog_can_expire_stale_owner]
  row --> rowCons[Cons_more_app_logic_than_pg_advisory]
```

### Trigger Serialization

```mermaid
flowchart LR
  cron[Cron_tick] --> gate[Try_acquire_global_or_per_source_lock]
  manual[UI_Run_now] --> gate
  hook[Webhook_enqueue] --> gate
  gate -->|granted| pipe[Exclusive_sync_runner]
  gate -->|busy| deferredPath[Skip_or_queue_later_with_visible_reason]
  pipe --> db[Postgres_app_and_warehouse]
```

### Webhook Ingress Hardening

```mermaid
flowchart TD
  req[HTTP_POST_webhook] --> size[Reject_if_body_over_limit]
  size --> sig[Verify_shared_secret_constant_time]
  sig -->|bad| err401[Return_401_without_detail]
  sig -->|ok| json[Parse_JSON_bounded_time]
  json -->|fail| err400[Return_400]
  json -->|ok| enqueue[Insert_app_webhook_queue]
```

### Existing Repo Architecture Diagram: Runtime

```mermaid
flowchart TB
  subgraph ext [External]
    sonarr[Sonarr]
    radarr[Radarr]
    browser[Browser]
  end
  subgraph stack [Compose]
    app[Nebularr App]
    pg[(PostgreSQL)]
  end
  sonarr -->|REST API| app
  radarr -->|REST API| app
  sonarr -->|Webhook POST| app
  radarr -->|Webhook POST| app
  browser --> app
  app -->|RW app + warehouse| pg
```

### Existing Repo Architecture Diagram: Sync Modes

```mermaid
stateDiagram-v2
  [*] --> Boot
  Boot --> FullSync: empty database or manual
  Boot --> SteadyState: normal startup
  FullSync --> SteadyState: done
  SteadyState --> Incremental: cron/manual
  Incremental --> SteadyState
  SteadyState --> Reconcile: cron/manual
  Reconcile --> SteadyState
  SteadyState --> WebhookDrain: queue pending
  WebhookDrain --> SteadyState
```

### Existing Repo Architecture Diagram: Locking Model

```mermaid
flowchart LR
  trigger[Trigger] --> acquire[Try insert/update lease lock]
  acquire -->|acquired| run[Run sync]
  acquire -->|busy| skip[Skip run]
  run --> hb[Heartbeat lock]
  hb --> done[Complete]
  done --> release[Release lock row]
```

## Backlog (From Original Plan)

- Web UI authentication for non-homelab exposure.
