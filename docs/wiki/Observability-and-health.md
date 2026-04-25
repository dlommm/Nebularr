# Observability and health

Nebularr is meant to run **unattended**; operators rely on **HTTP health**, **Prometheus metrics**, and optional **alert webhooks**. This page **summarizes** [ALERTS_AND_SLOS.md](https://github.com/OWNER/REPO/blob/main/docs/ALERTS_AND_SLOS.md) and ties in the README. Replace `OWNER/REPO` in links.

## Endpoints (quick reference)

| Endpoint | Role |
|----------|------|
| `GET /healthz` | Liveness; app version, git SHA, DB check as implemented |
| `GET /metrics` | **Prometheus** exposition format |
| `GET /api/status` | Derived **health** and operational snapshot used by the Web UI |

**Table in README:** [API surface](https://github.com/OWNER/REPO/blob/main/README.md#api-surface-quick-reference).

## How “health” is thought about

- Inputs include **webhook queue depth** (and related states) and **sync lag** since last successful incremental watermark vs **thresholds** (env-configurable, see [docker-compose / README](https://github.com/OWNER/REPO/blob/main/README.md)).  
- A **state machine** (`ok` / `warning` / `critical`) drives operator understanding; **outbound alert webhooks** fire on **transitions** (e.g. ok→warning) to reduce flapping, as documented.  

**Diagrams, metric names, suggested alert thresholds:** [ALERTS_AND_SLOS.md](https://github.com/OWNER/REPO/blob/main/docs/ALERTS_AND_SLOS.md).

## Suggested Prometheus-style alerts (examples in doc)

- Webhook **queue** depth high (`arrsync_webhook_queue_depth` or equivalent naming — see live `/metrics`).  
- **Sync lag** for Sonarr/Radarr over a threshold.  
- **Failed sync runs** rate increase over a window.  

Exact names evolve with the codebase; always verify against a running instance’s **metrics** text.

## Operational “SLO” style targets

The doc lists **soft targets** (e.g. incremental freshness, DLQ trends, reconcile on schedule). Use them as a baseline, not a guarantee, unless you add SLO error budgets in your org.

## Runbook tie-in

When something looks wrong, follow: healthz → metrics → Web UI (runs, queue) → optional SQL, as in [OPERATIONS_RUNBOOK.md](https://github.com/OWNER/REPO/blob/main/docs/OPERATIONS_RUNBOOK.md).

**Related wiki:** [Deployment](Deployment) · [Development](Development) (local smoke).  

---

*Canonical doc: [docs/ALERTS_AND_SLOS.md](https://github.com/OWNER/REPO/blob/main/docs/ALERTS_AND_SLOS.md).*