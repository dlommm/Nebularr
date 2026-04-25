---
name: app-version-semver
description: >-
  Decides whether and how to bump Nebularr `app_version` using semantic
  versioning (major.minor.patch) from the scope of changes, user goals, and
  conversation context; updates every in-repo version location together. Use when
  finishing substantive work, preparing a release, the user asks about version,
  semver, tagging, or changelog, or when changes could affect operators or
  integrators.
---

# Nebularr app version (semver)

Nebularr uses **`MAJOR.MINOR.PATCH`** everywhere `app_version` is surfaced (health, Web UI, Docker metadata).

## When to apply this skill

- After **meaningful** edits (code, API, schema, default config, or operator-facing behavior)—evaluate whether a bump is due before ending the turn or suggesting merge.
- When the user **asks** for a release, version number, tag, or “should we bump?”
- When the user **names** a bump type (“this is a breaking change”, “just a hotfix”, “new feature”).

**Do not** treat every typo-only or internal-comment edit as requiring a version bump. **Do** re-evaluate when a session accumulates many small fixes that together warrant **PATCH** (or **MINOR** if behavior changed).

## Decision rules (infer from diffs + user intent)

### MAJOR (`x+1.0.0`) — breaking or incompatible

Bump MAJOR when something **existing consumers or deploys** may rely on is removed, renamed, or made incompatible without a migration path, including:

- **API contract**: removed JSON fields, changed types, new required request params, stricter HTTP status/behavior, removed routes.
- **Config/env**: removed env vars, changed semantics of existing vars so old `.env` values misbehave, required new vars with no default.
- **Database**: migrations that need **manual** operator steps before/after (destructive, non-expand contract), or dropped columns/views used outside Nebularr.
- **Webhooks** from Sonarr/Radarr: changed verification, path, or required headers such that old app configs break.
- **Intentional** removal of features or endpoints.

If the user says **“breaking”** or **“major”**, treat that as a strong signal to use MAJOR unless the change is clearly not breaking.

### MINOR (`x.y+1.0`) — backward compatible additions

Bump MINOR for **new capabilities** that **do not break** old clients or existing configs:

- New API routes, new optional response fields, new optional query parameters.
- New Web UI pages, major UX areas, or new first-class **features** (e.g. new integration type).
- New env vars with **safe defaults**; new scheduled jobs; new metrics (additive).
- **Alembic migrations** that are roll-forward, expand-only, and keep prior app versions working with the *previous* DB state until upgraded (typical add-column).
- Bumping **dependencies** for features or when behavior changes are user-visible but not “breaking the contract”.

If the user says **“feature”**, **“release”** (colloquially), or **“minor”**, prefer MINOR when nothing falls under MAJOR.

### PATCH (`x.y.z+1`) — fixes and safe refinements

Bump PATCH for **fixes** and small improvements that preserve contracts:

- Bug fixes, performance fixes, log message clarity, UI polish without new product surface.
- **Security patches** that don’t require operators to reconfigure (otherwise consider MINOR if new required settings).
- Docs/README/wiki that **correct** wrong operational behavior (still PATCH unless bundled with a feature release—then MINOR with the feature).
- Internal refactors: **no** bump if zero operator-visible change; **PATCH** if you fixed subtle runtime/health/sync behavior.

### No bump (usually)

- Whitespace, comments-only, non-user-facing renames, dev-only test fixtures with no release artifact change.
- Purely **cosmetic** doc tweaks where behavior is already correct.

**If uncertain:** prefer **PATCH** for small risk; ask once if the user is preparing a **tagged** release and MAJOR vs MINOR is ambiguous (e.g. large refactor with no API change).

## How to use “what the user asked”

- Explicit **target version** (“set to 2.0.0”) → apply that version (still sanity-check it matches the described breaking vs non-breaking work).
- **“Don’t bump”** / **“skip version”** → respect unless a MAJOR security issue requires a visible patch number for audit trails (then say why).
- Vague request (“improve the dashboard”) → classify from **files changed** and **behavioral delta**, then pick MINOR vs PATCH.
- A **single session** with mixed changes → use the **highest** appropriate segment (e.g. one breaking API + one fix → **MAJOR** for the whole bump, or split work across PRs; if splitting is impossible, document MAJOR).

## Files to update together (single new version string)

Read current version from `pyproject.toml` (`[project].version`) or `src/arrsync/config.py` default, then set **all** of these to the **same** `MAJOR.MINOR.PATCH`:

| File | What to set |
|------|-------------|
| `pyproject.toml` | `[project].version` |
| `src/arrsync/__init__.py` | `__version__` |
| `src/arrsync/config.py` | `app_version` default |
| `Dockerfile` | `ARG APP_VERSION=...` |
| `docker-compose.yml` | `APP_VERSION` build-arg default |
| `frontend/package.json` | `"version"` |
| `frontend/package-lock.json` | root package `name` / `version` (run `npm install` in `frontend/` after `package.json`) |
| `.env.example` | `APP_VERSION=...` |

**Optional:** if the user keeps `APP_VERSION` in local `.env`, offer to update it; do not assume `.env` is committed.

**Out of scope for file edits** unless asked: `deploy/unraid` image tags, Git tags, GitHub releases—**mention** they should align after merge.

## Workflow (agent)

1. Summarize **what changed** and **user intent** in one or two lines.
2. Classify: **MAJOR** / **MINOR** / **PATCH** / **no bump** using the rules above.
3. If bump: compute the next version from the current one (increment the correct segment, reset lower segments to 0 as per semver).
4. Apply the table above; run `npm install` in `frontend/` to refresh the lockfile root version.
5. Tell the user the **bump type**, **old → new** version, and **why** in plain language.

## Quick examples (Nebularr-flavored)

- Remove `GET /api/foo` → **MAJOR**  
- Add `GET /api/reporting/exports` (new) → **MINOR**  
- Fix off-by-one in pagination; health still same → **PATCH**  
- Add optional `?format=` to an existing export URL with default = previous behavior → **MINOR** (feature) or **PATCH** (arguably a fix); default to **MINOR** if the feature is user-visible.  
- Require `NEW_SECRET` with no default → **MAJOR** (or MINOR if old deploys can still start with a documented grace path—rare; prefer MAJOR for “must set new secret”)

---

*This skill complements [v2-backlog-maintainer](../v2-backlog-maintainer/SKILL.md) (roadmap text) and release hygiene; it does not replace git tags or CI.*
