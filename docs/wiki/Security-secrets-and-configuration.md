# Security, secrets, and configuration

This page **summarizes** [SECRETS.md](https://github.com/OWNER/REPO/blob/main/docs/SECRETS.md). For **environment variables** used in Compose, see the root [README](https://github.com/OWNER/REPO/blob/main/README.md) and [docker-compose.yml](https://github.com/OWNER/REPO/blob/main/docker-compose.yml). Replace `OWNER/REPO` in links.

## Principles

- **No hardcoded secrets** in the repository.  
- Prefer **environment variables** or **Docker secrets** for: Sonarr/Radarr API keys, **webhook shared secret**, **Postgres** credentials in `DATABASE_URL`, and similar.  
- **Logging** must not emit API keys, DB passwords, webhook secrets, or raw webhook bodies at chatty levels.

## At-rest design (high level)

- Integration **API keys** may be stored encrypted in the database when `APP_ENCRYPTION_KEY` (or project-specific equivalent) is configured—see the canonical doc for the **Fernet** model.  
- The **webhook verifier** uses a **one-way hash** for the shared secret (not reversible for logging).  
- **Alert webhook URLs** may be encrypted at rest when encryption is enabled.

**Diagram (secret flow):** [SECRETS.md](https://github.com/OWNER/REPO/blob/main/docs/SECRETS.md).

## What operators should do

- Restrict **network** access to Postgres and the app port.  
- Treat **DB backups** as sensitive (they may contain integration keys).  
- Rotate credentials using the **Web UI** or config surfaces described in the runbook when applicable.  

## Related documentation

- [BACKUP_RESTORE](https://github.com/OWNER/REPO/blob/main/docs/BACKUP_RESTORE.md) — backup copies are sensitive.  
- [OPERATIONS_RUNBOOK](https://github.com/OWNER/REPO/blob/main/docs/OPERATIONS_RUNBOOK.md) — operational steps.  
- [LOCKING_AND_DLQ](https://github.com/OWNER/REPO/blob/main/docs/LOCKING_AND_DLQ.md) — webhook queue security is also about **authentic** inbound hooks.  

**Full reference:** [SECRETS.md](https://github.com/OWNER/REPO/blob/main/docs/SECRETS.md).
