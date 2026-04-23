# Architecture

## Runtime

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

## Sync modes

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

## Locking model

`app.job_lock` uses a lease (`expires_at`) and owner id. Each sync acquires lock by `source:mode`, heartbeats periodically, then releases on completion. Expired locks can be reclaimed by a later process.

```mermaid
flowchart LR
  trigger[Trigger] --> acquire[Try insert/update lease lock]
  acquire -->|acquired| run[Run sync]
  acquire -->|busy| skip[Skip run]
  run --> hb[Heartbeat lock]
  hb --> done[Complete]
  done --> release[Release lock row]
```
