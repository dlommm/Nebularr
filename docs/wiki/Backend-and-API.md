# Backend and API

The server is a **FastAPI** application that bundles:

- **Static Web UI** — built React app from `frontend/` (output under `src/arrsync/web/dist`), plus SPA catch-all for client routes  
- **JSON APIs** — `/api/ui/*`, `/api/config/*`, `/api/sync/*`, `/api/setup/*`, reporting, admin, etc.  
- **Webhooks** — e.g. `POST /hooks/sonarr`, `POST /hooks/radarr` with shared secret  
- **Observability** — `GET /healthz`, `GET /metrics` (Prometheus)  

## Pointers in this repo

| Resource | Link |
|----------|------|
| Main router and route table | [`src/arrsync/api.py`](https://github.com/OWNER/REPO/blob/main/src/arrsync/api.py) (large file; use editor search for `@router` / `def`) |
| README API quick reference | [README — API surface](https://github.com/OWNER/REPO/blob/main/README.md#api-surface-quick-reference) |
| Architecture (runtime, sync modes) | [docs/ARCHITECTURE.md](https://github.com/OWNER/REPO/blob/main/docs/ARCHITECTURE.md) |
| Reporting system | [docs/REPORTING_ARCHITECTURE.md](https://github.com/OWNER/REPO/blob/main/docs/REPORTING_ARCHITECTURE.md) |
| Webhooks, locking, DLQ | [docs/LOCKING_AND_DLQ.md](https://github.com/OWNER/REPO/blob/main/docs/LOCKING_AND_DLQ.md) |
| Pooling & timeouts | [docs/POOLING_AND_TIMEOUTS.md](https://github.com/OWNER/REPO/blob/main/docs/POOLING_AND_TIMEOUTS.md) |

## Typical flows

- **Operator → Web UI** — Browser loads `/`, React app calls `/api/ui/*` and related endpoints.  
- **Arr → webhooks** — Sonarr/Radarr POST to `/hooks/*`, jobs persist and workers drain the queue.  
- **Sync** — `SyncService` + `ArrClient` call Sonarr/Radarr REST, upsert into the **warehouse** schema.  

Mermaid diagrams and sequence flows are in the main [README](https://github.com/OWNER/REPO/blob/main/README.md) and [ARCHITECTURE](https://github.com/OWNER/REPO/blob/main/docs/ARCHITECTURE.md).
