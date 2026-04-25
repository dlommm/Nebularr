# Nebularr wiki

Welcome to the wiki for **Nebularr**: a Docker-first service that ingests **Sonarr** and **Radarr** metadata into **PostgreSQL** and exposes a **Web UI** plus JSON APIs for operations and reporting.

> **Note:** In-repo documentation lives under [`docs/`](https://github.com/OWNER/REPO/tree/main/docs) in the main repository. This wiki summarizes how everything fits together and points to those files. Replace `OWNER/REPO` with your GitHub org and repository name when following links, or use the [Documentation index](Documentation-index) page for a full list.

## Quick links

| Topic | Where |
|--------|--------|
| User-facing overview & API table | [README (main repo)](https://github.com/OWNER/REPO/blob/main/README.md) |
| System architecture | [docs/ARCHITECTURE.md](https://github.com/OWNER/REPO/blob/main/docs/ARCHITECTURE.md) |
| **Full doc catalog** (every `docs/*.md`) | [Documentation index](Documentation-index) |
| **Narrative tour** of the system | [Project deep dive](Project-deep-dive) |
| **Roadmap & v1 plan history** | [Roadmap and history](Roadmap-and-history) · [V2_BACKLOG](https://github.com/OWNER/REPO/blob/main/docs/V2_BACKLOG.md) |
| Web UI (React, routes, build) | [Web UI](Web-UI) · [docs/WEBUI_FRAMEWORK.md](https://github.com/OWNER/REPO/blob/main/docs/WEBUI_FRAMEWORK.md) |
| Web UI (multi-agent workflow) | [Web UI — agent workflow](Web-UI-agent-workflow) *(for contributors / large refactors)* |
| Reporting SQL / dashboards | [Reporting system](Reporting-system) · [docs/REPORTING_ARCHITECTURE.md](https://github.com/OWNER/REPO/blob/main/docs/REPORTING_ARCHITECTURE.md) |
| DB, pool, backup | [Data layer and PostgreSQL](Data-layer-and-PostgreSQL) |
| Locks, webhooks, scheduler | [Sync, locking, and webhooks](Sync-locking-and-webhooks) |
| Health, metrics, alerts | [Observability and health](Observability-and-health) |
| Operations & runbook | [docs/OPERATIONS_RUNBOOK.md](https://github.com/OWNER/REPO/blob/main/docs/OPERATIONS_RUNBOOK.md) |
| Secrets & env | [Security, secrets, and configuration](Security-secrets-and-configuration) |
| Migrations & DB | [docs/MIGRATIONS.md](https://github.com/OWNER/REPO/blob/main/docs/MIGRATIONS.md) · [docs/DB_BOOTSTRAP.md](https://github.com/OWNER/REPO/blob/main/docs/DB_BOOTSTRAP.md) |
| Performance | [Performance tuning](Performance-tuning) |
| Unraid / extra deploy | [Unraid and advanced deploy](Unraid-and-advanced-deploy) |
| Branding | [Branding and assets](Branding-and-assets) |

## What to read first

1. **New to the project** — [README](https://github.com/OWNER/REPO/blob/main/README.md) → [Architecture](https://github.com/OWNER/REPO/blob/main/docs/ARCHITECTURE.md)  
2. **Running in production** — [Deployment](Deployment) → [Operations runbook](https://github.com/OWNER/REPO/blob/main/docs/OPERATIONS_RUNBOOK.md)  
3. **Contributing to the app** — [Development](Development) → [Repository map](Repository-map)  
4. **All markdown in `docs/`** — [Documentation index](Documentation-index)  

## Wiki sections

- **[Documentation index](Documentation-index)** — Paraphrased **entry** for every long-form file under `docs/` (excludes the `docs/wiki` mirror itself; see also this folder’s [README](https://github.com/OWNER/REPO/blob/main/docs/wiki/README.md))  
- **[Project deep dive](Project-deep-dive)** — One narrative tying together sync, DB, UI, and reporting  
- **[Roadmap and history](Roadmap-and-history)** — Pointers to `ORIGINAL_PLAN_REFERENCE` and `V2_BACKLOG`  
- **[Repository map](Repository-map)** — Top-level layout of the codebase  
- **Topic pages:** [Data layer and PostgreSQL](Data-layer-and-PostgreSQL) · [Sync, locking, and webhooks](Sync-locking-and-webhooks) · [Reporting system](Reporting-system) · [Observability and health](Observability-and-health) · [Security, secrets, and configuration](Security-secrets-and-configuration) · [Performance tuning](Performance-tuning) · [Branding and assets](Branding-and-assets)  
- **[Web UI](Web-UI)** · **[Web UI — agent workflow](Web-UI-agent-workflow)** (contributors)  
- **[Backend and API](Backend-and-API)** — `api.py`, services, and HTTP surface  
- **[Deployment](Deployment)** — Docker Compose, environment, operations pointers  
- **[Unraid and advanced deploy](Unraid-and-advanced-deploy)** — `deploy/unraid` and special cases  
- **[Development](Development)** — How to build, test, and lint locally  

---

*This page is maintained from [`docs/wiki/Home.md`](https://github.com/OWNER/REPO/blob/main/docs/wiki/Home.md) in the main repository.*
