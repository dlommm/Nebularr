---
name: run-local-docker
description: >-
  Runs or redeploys the Nebularr stack with Docker Compose using the project .env
  on disk only—no shell overrides for DATABASE_URL or COMPOSE_PROFILES. Use when the
  user asks to run local Docker, redeploy local docker, docker compose up locally,
  start the stack, or local Docker testing for this repository.
---

# Run local Docker (Nebularr)

## Goals

- Use **only** the project **`.env`** file: Docker Compose reads it from disk for `${VAR}` substitution. **Do not** prefix commands with `DATABASE_URL=` or `COMPOSE_PROFILES=` unless the user explicitly asks for a one-off workaround.
- Keep **secrets out of the image**, **out of git**, and **out of chat** (no pasting `.env` contents).

## Default command (local testing)

From the repository root:

```bash
./scripts/docker-local-up.sh
```

This script:

1. **Creates `.env` from `.env.example` if it is missing** (so local testing does not require manually creating `.env` first). The file stays **gitignored**.
2. Loads only **`NEBULARR_BUNDLED_POSTGRES`**, **`COMPOSE_PROFILES`**, **`APP_PORT`**, and **`POSTGRES_PORT`** via **`scripts/export-compose-relevant-env.sh`** (a small Python line parser). It does **not** `source` the whole **`.env`**—cron lines like **`INCREMENTAL_CRON=*/30 * * * *`** would break bash if sourced.
3. Runs **`docker compose up -d --build`**. Compose still reads the **full** **`.env`** from disk for **`${VAR}`** interpolation (including **`DATABASE_URL`** passed into the app container).

If the app exits with **password authentication failed for user "arrapp"** on a **new** Postgres volume, clear **`DATABASE_URL`** in **`.env`** (or use the superuser from **`POSTGRES_*`**) until the Web UI setup has created **`arrapp`**—the agent should not “fix” this by overriding **`DATABASE_URL`** in the shell when following this skill.

## If the user insists on raw Compose

```bash
cd /path/to/Nebularr && docker compose up -d --build
```

Compose still loads **`.env`** automatically from the project directory. If **`.env` is missing**, `docker compose` alone will not create it—use **`./scripts/docker-local-up.sh`** instead for frictionless local testing.

## Bundled Postgres

- **`COMPOSE_PROFILES`** in **`.env`** should include **`nebularr-bundled-postgres`** when using the bundled `postgres` service (default in **`.env.example`**). The helper script merges that profile when **`NEBULARR_BUNDLED_POSTGRES`** is true, matching values already intended in **`.env`**—not a separate policy.

## First-time DB / `DATABASE_URL`

- **`.env.example`** leaves **`DATABASE_URL`** empty so a copied **`.env`** starts the app in setup mode. If **`.env`** sets **`DATABASE_URL`** to **`arrapp`** before that role exists, the app will fail at startup—fix by clearing **`DATABASE_URL`** in **`.env`** (user edits file) or completing setup once; the agent should **not** strip it via the shell when following this skill.

## Security checklist (agent)

- Do **not** `git add .env` or paste secrets into chat/commits.
- Do **not** `COPY` **`.env`** into any image stage.

## After deploy

- Smoke: `curl -fsS http://localhost:${APP_PORT:-8080}/healthz`

## Reference

- `docs/SECRETS.md`, `README.md` (Quickstart, bundled Postgres).
