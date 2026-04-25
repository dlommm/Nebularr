# Unraid and advanced deployment

The **default** documented stack is root [`docker-compose.yml`](https://github.com/OWNER/REPO/blob/main/docker-compose.yml) plus [README **Quickstart**](https://github.com/OWNER/REPO/blob/main/README.md#quickstart). This page describes **extra** material for **Unraid** and points to the same operational docs as a generic deploy.

## Unraid templates / compose in repo

Location: [`deploy/unraid/`](https://github.com/OWNER/REPO/tree/main/deploy/unraid) in the main repository. Typical files include:

- **`docker-compose.yml`** — a compose stack tuned for that environment.  
- **`nebularr-app.xml`**, **`nebularr-postgres.xml`** — Unraid “template” style definitions where applicable.  

**Always** compare with the root `docker-compose.yml` and `.env.example` (if present) for **env var** names and version drift. When in doubt, the **default** stack in the repository root is the **reference** behavior.

## Operations and tuning (same for Unraid or not)

- [OPERATIONS_RUNBOOK](https://github.com/OWNER/REPO/blob/main/docs/OPERATIONS_RUNBOOK.md)  
- [COMPOSE_RESOURCE_HINTS](https://github.com/OWNER/REPO/blob/main/docs/COMPOSE_RESOURCE_HINTS.md)  
- [SCHEDULER_TIMEZONE](https://github.com/OWNER/REPO/blob/main/docs/SCHEDULER_TIMEZONE.md)  
- [SECRETS](https://github.com/OWNER/REPO/blob/main/docs/SECRETS.md)  
- [BACKUP_RESTORE](https://github.com/OWNER/REPO/blob/main/docs/BACKUP_RESTORE.md)  

**Wiki:** [Deployment](Deployment) (generic Docker overview).

## Networking and webhooks

On Unraid or any NAT setup, set Sonarr/Radarr **webhook URL** to a host:port that **reaches** Nebularr. Use the same **shared secret** header as in the README.  

**Webhook section:** [README — Webhook setup](https://github.com/OWNER/REPO/blob/main/README.md#webhook-setup).

---

*If this page drifts from `deploy/unraid/`, update both when changing Unraid packaging.*