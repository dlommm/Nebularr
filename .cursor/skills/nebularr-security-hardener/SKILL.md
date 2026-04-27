---
name: nebularr-security-hardener
description: Proactively audits and hardens Nebularr for vulnerabilities with focus on Docker, FastAPI, PostgreSQL, and Python/React dependencies. Security is always priority #1. Auto-applies minimal security fixes, rolls back on verification failure, then iterates until the app stays green. Triggers on changes to Dockerfile, docker-compose, pyproject.toml, frontend deps, or security queries.
---

# Nebularr Security Hardener

## Purpose

Maintain a continuous security-hardening loop for Nebularr with least privilege, minimal attack surface, and defense-in-depth.

## Automatic Triggers

Run this skill when:
- `Dockerfile`, `docker-compose.yml`, `.dockerignore`, or Postgres/bootstrap-related Python (`postgres_bootstrap`, runtime DB URL) changes.
- `pyproject.toml`, `frontend/package.json`, or lockfiles change.
- `requirements*.txt`, `poetry.lock`, `uv.lock`, `package-lock.json`, `npm-shrinkwrap.json`, or `pnpm-lock.yaml` changes.
- Any auth, webhook, secrets, DB role, migration, CI, or deployment config changes.
- User asks for security hardening, vulnerability checks, scan baselines, or release readiness.

## Dependency Drift Auto-Update Rules

When dependency manifests/lockfiles change, the skill must automatically:

1. Detect newly added or upgraded packages.
2. Re-run Python and frontend audits scoped to production and runtime impact first.
3. Update recommended remediation commands to match the package manager and lockfile in use.
4. Rebuild and re-scan the app image if dependency changes can affect runtime layers.
5. Compare scan output against the previous baseline and explicitly report:
   - new findings introduced,
   - findings resolved,
   - severity trend (better/same/worse).

Minimum dependency diff checks:
- Python: compare `pyproject.toml` dependencies and any lockfile deltas.
- Frontend: compare `frontend/package.json` and `frontend/package-lock.json` deltas.
- Image/runtime: verify dependency changes are not accidentally copied into runtime (for example `node_modules`).

## Core Security Principles (Non-Negotiable)

1. Never run app containers as root; use non-root UID/GID (default `1001:1001`).
2. Prefer multi-stage builds and minimal runtime images.
3. Keep runtime image free of build tools, test tooling, and frontend dev artifacts.
4. Enforce least privilege in Docker (`read_only`, `cap_drop: [ALL]`, `no-new-privileges` where feasible).
5. Require explicit secret management (no hardcoded credentials, no default weak secrets in production guidance).
6. Minimize exposed ports/services; make admin tools optional.
7. Pin or tightly constrain dependencies and verify with vulnerability scanners.
8. Apply secure defaults for PostgreSQL roles and migration permissions.

## Nebularr-Specific Hardening Checklist

### Docker / Runtime
- Verify `Dockerfile` has:
  - multi-stage build when practical,
  - explicit non-root `USER`,
  - minimal package install footprint,
  - healthcheck,
  - no unnecessary shell tooling in runtime layer.
- Ensure `.dockerignore` excludes:
  - `.git`, `.venv`, caches, tests artifacts, local env files,
  - `frontend/node_modules`,
  - other non-runtime content.

### Compose / Deployment
- Confirm `docker-compose.yml` uses:
  - non-root `user`,
  - `read_only: true` + `tmpfs` where safe,
  - `cap_drop: [ALL]`,
  - `security_opt: [no-new-privileges:true]`,
  - minimal port exposure.
- Treat pgAdmin/admin surfaces as optional and not internet-exposed by default.

### App / API / Secrets
- Validate webhook secret enforcement and request size limits.
- Check that secrets are not logged and are encrypted/hashed where supported.
- Ensure no hardcoded credentials in config defaults, SQL init files, or docs presented as production-safe.

### PostgreSQL / Alembic
- Prefer separate roles for migration/bootstrap vs runtime if feasible.
- Remove unnecessary global grants (for example broad `CREATE` on database).
- Keep schema/table permissions scoped to required operations only.

### Dependencies / Supply Chain
- Run Python and JS dependency audits.
- Prefer reproducible dependency resolution and update vulnerable components.
- Generate or recommend SBOM generation for release workflows.
- Keep dependency checks incremental: every new package must be scanned before merge.
- Flag packages with known security advisories even if only transitive.

## Mandatory Scan Workflow

1. **Baseline Scan**
   - `trivy fs .`
   - `trivy config .`
   - `trivy secret .` (or fs with secret scanner)
   - `hadolint Dockerfile`
   - `grype dir:.`
   - Python audit (`pip-audit`)
   - Frontend audit (`npm audit --omit=dev`)
   - Optional package-level inventory snapshot (`pip freeze`, `npm ls --omit=dev`) for drift comparison
2. **Categorize Findings**
   - Group by `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`.
   - Focus fixes on exploitable and runtime-impacting issues first.
3. **Auto-fix loop (default when findings exist)**
   - When scans or review identify concrete remediations (Dockerfile `USER`, `.dockerignore`, compose hardening, dependency bumps with lockfile updates, etc.), **apply minimal targeted fixes automatically** rather than only proposing them.
   - **Before changing files**: note current `git status` and changed paths so rollback is exact (prefer a single commit or a named stash: `git stash push -m "nebularr-security-hardener pre-fix"` if the working tree must stay clean).
4. **Verify after every fix batch**
   - Re-run relevant scanners (at least the gates that failed before).
   - Run the full **Verification Gate** below (`ruff`, `mypy`, `pytest`, frontend checks, `docker build`, image Trivy, smoke or compose smoke when applicable).
5. **Rollback on any verification failure**
   - If build, tests, typecheck, lint, smoke, or container startup fails: **immediately revert** the auto-applied changes for that batch (`git restore` / `git checkout --` on affected paths, `git stash pop` undo, or `git revert` on the fix commit).
   - Record in the report: **what was rolled back**, **which command failed**, and **stderr or key log lines** (redact secrets).
6. **Root-cause and second-pass fix**
   - Diagnose why the fix broke the app (common causes: read-only root without `tmpfs`, wrong file ownership for non-root UID, missing writable dirs for uvicorn/sqlite/logs, compose `user` mismatch with image `USER`, DB init permissions, healthcheck path).
   - Re-apply a **smaller or adjusted** fix (for example add `tmpfs` for `/tmp`, `chown` in build stage, separate migration user, profile-gated pgAdmin only).
   - Repeat verify → rollback → refine until the verification gate passes or residual risk is explicitly accepted by the operator.
7. **Re-verify (final)**
   - Re-run scans.
   - Run lint/type/tests/smoke checks.
   - Confirm no regression in startup and key endpoints.

## Post-fix report (required after auto-fix attempts)

After fixes have been applied (whether or not rollbacks occurred), produce a dedicated section **Security hardening outcome** with:

| Category | Content |
|----------|---------|
| **Applied fixes** | Each item: file(s), finding/CVE or rule ID, what changed, verification command that passed. |
| **Rolled back changes** | Each item: file(s), what was reverted, **exact failure** (command + exit reason), hypothesis for breakage. |
| **Final retained state** | What stayed in the repo and why it is safe. |
| **Scan delta** | Before vs after: HIGH/CRITICAL counts for Trivy fs/config/image (and npm/pip-audit if run). |
| **Residual risk** | Findings not fixable without product/ops trade-offs; operator actions. |

This report is **in addition to** the Output Contract below (merge overlap into one deliverable for the user).

## Zero-Install Scan Commands (Containerized)

Use these if local tools are missing:

```bash
docker run --rm -v "$PWD:/src" aquasec/trivy:latest fs --scanners vuln,misconfig,secret --severity HIGH,CRITICAL /src
docker run --rm -v "$PWD:/src" aquasec/trivy:latest config --severity HIGH,CRITICAL /src
docker run --rm -i hadolint/hadolint < Dockerfile
docker run --rm -v "$PWD:/project" -w /project anchore/grype:latest dir:. -o table
docker run --rm -v "$PWD:/src" -w /src python:3.13-slim sh -lc "pip install --no-cache-dir pip-audit && pip-audit"
```

Image scan flow:

```bash
docker build -t nebularr:security-check .
docker save nebularr:security-check -o /tmp/nebularr-security-check.tar
docker run --rm -v /tmp:/tmp aquasec/trivy:latest image --input /tmp/nebularr-security-check.tar --severity HIGH,CRITICAL
```

## Verification Gate (After Hardening)

Run:
- backend quality: `ruff check src tests`, `mypy src`, `pytest -q`
- frontend quality: `npm run lint`, `npm run test`, `npm audit --omit=dev --audit-level=high`
- smoke: `./scripts/smoke.sh`
- hardened run test:

```bash
docker run --rm --read-only --tmpfs /tmp --cap-drop=ALL --security-opt no-new-privileges:true --user 1001:1001 -p 8080:8080 nebularr:security-check
```

## Output Contract

For each run, produce:
1. **Risk summary** (top issues first).
2. **Findings table**: `file/package | severity | CVE/finding | recommended fix`.
3. **Minimal diffs** applied or proposed.
4. **Verification evidence** (command list + pass/fail).
5. **Residual risk/trade-offs** that still require operator decisions.
6. **Dependency delta report**: `added/updated/removed package | risk impact | action taken`.
7. **Security hardening outcome** (see table above): applied fixes, rolled-back changes with reasons, final state, scan delta.

## Guardrails

- Do not accept convenience over security.
- Avoid broad refactors unless needed to remove concrete risk.
- Never leak secrets in logs/output.
- Prefer defaults that are safe for self-hosted deployment, with explicit opt-out.
- **Never leave the repo in a broken state after auto-fix**: if verification fails, rollback that batch before trying the next approach; document every rollback in the outcome report.
- If multiple unrelated fixes are pending, **batch by dependency** (for example Docker-only, then compose-only) so rollback scope stays clear.
