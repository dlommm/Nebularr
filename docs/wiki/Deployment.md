# Deployment

Nebularr is **Docker-first**: the app and PostgreSQL are typically run with Compose or an equivalent (e.g. Unraid template).

## Default Compose

- Root [`docker-compose.yml`](https://github.com/OWNER/REPO/blob/main/docker-compose.yml) — `postgres` + `app` services, env-file friendly.  
- [`.env` example or docs](https://github.com/OWNER/REPO/blob/main/README.md) — see main README for variables and quick start.  

## Additional material

| Doc / path | Topic |
|------------|--------|
| [`deploy/unraid/`](https://github.com/OWNER/REPO/tree/main/deploy/unraid) | Unraid-oriented compose and notes (if present) |
| [docs/OPERATIONS_RUNBOOK.md](https://github.com/OWNER/REPO/blob/main/docs/OPERATIONS_RUNBOOK.md) | Day-2 operations |
| [docs/COMPOSE_RESOURCE_HINTS.md](https://github.com/OWNER/REPO/blob/main/docs/COMPOSE_RESOURCE_HINTS.md) | Resource hints for Compose |
| [docs/SECRETS.md](https://github.com/OWNER/REPO/blob/main/docs/SECRETS.md) | Secrets and `APP_ENCRYPTION_KEY` style concerns |
| [docs/BACKUP_RESTORE.md](https://github.com/OWNER/REPO/blob/main/docs/BACKUP_RESTORE.md) | Backup/restore |
| [Dockerfile](https://github.com/OWNER/REPO/blob/main/Dockerfile) | Image build arguments and stages |

## Build arguments

The main **Dockerfile** and Compose often pass `APP_VERSION` and git SHA for labels and the Web UI. Match what your CI or `docker build` provides.

## Health and metrics

- `GET /healthz` — liveness and version info  
- `GET /metrics` — Prometheus text format  

Point monitors and load balancers at these paths on the app port (default in compose often **8080**).
