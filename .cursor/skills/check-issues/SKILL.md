---
name: check-issues
description: >-
  Runs Docker Scout on the Nebularr image, attempts vulnerability remediations in
  an isolated git worktree (never the user’s primary checkout first), rebuilds and
  re-scans until acceptance criteria are met, runs lint/tests/build in that
  sandbox, then merges to the main branch and runs push-to-GitHub + Docker Hub
  only if everything passes. If any step fails, removes the sandbox and leaves
  the original files unchanged. Use when the user says "check issues", "scout
  check", "fix vulnerabilities then push", or similar.
---

# Check issues (Scout + sandbox + optional push)

## Hard rules

1. **Do not** edit, stage, or commit in the user’s **primary** working tree (the repo root the user has open) until the **entire** sandbox pipeline below succeeds. All dependency and Dockerfile changes happen **only** in the sandbox (see [Sandbox setup](#sandbox-setup)).
2. If **any** required step **fails** (Scout over threshold, `docker build`, frontend/backend tests, or merge), **stop**. Remove the worktree, delete the temporary branch, and **do not** apply the experimental changes to the main checkout. Report what failed and what was **not** changed.
3. **Never** pass registry passwords in chat. Use existing `docker login` / credentials on the machine.
4. Pushing to GitHub and Docker Hub happens **only** after a successful merge from the sandbox branch into the branch the user is shipping (usually `main`) and only by following [github-commit-and-push](../github-commit-and-push/SKILL.md) (including [app-version-semver](../app-version-semver/SKILL.md)).

## Trigger phrases

Treat as this workflow when the user says things like: **"check issues"**, **"run scout and fix"**, **"vulnerability check then push"**, or **"security sandbox then GitHub"**.

## Acceptance criteria (default)

Configurable if the user names different thresholds; otherwise use:

- **Docker Scout** on the **candidate image** built from the sandbox: **0 Critical, 0 High** (per the `Overview` / summary line in `docker scout cves` or `docker scout quickview`). **Medium and Low** may remain; note them in the final summary.
- **Build:** from the sandbox repo root, prefer **`./scripts/docker-release-build.sh --load`** (or `docker buildx build --provenance=false --sbom=false … --load`) so the scan matches the **Hub**-recommended **no-attestation** build. A plain `docker build` is OK for a quick smoke test but can disagree with **Docker Hub** Scout totals (see [Hub vs local Scout](#docker-hub-vs-local-scout)).
- **Frontend:** from `frontend/`: `npm run lint` and `npm test` (or project-standard scripts) succeed; `npm run build` succeeds.
- **Backend:** if the repo defines them (e.g. `pytest`, `ruff check`), run the same commands as in CI / README. If no tests, state that and require at least **lint + build** green.

If remediations **cannot** reach 0C/0H after **reasonable** attempts (e.g. base image digest bump, safe `npm` updates, Dockerfile `apt` refresh), **stop without merging** and explain the remaining findings.

## Docker Hub vs local Scout

- **hub.docker.com** (Docker Scout UI) can show **more** total CVEs than a minimal runtime (e.g. **layer breakdown**, **base image**, **and** attestation / SBOM metadata on tagged images). **Pushes** from this repo should use **`./scripts/docker-release-build.sh --push`** so images are **not** decorated with SLSA provenance / full SBOM by default; that **reduces** spurious package rows. Trade-off: less supply-chain attestation on the image.
- A **`golang` / `stdlib`** row on a **Python-only** `Dockerfile` is often **attribution noise** in Scout, not a Go runtime inside the container. Reconcile with `docker scout cves --only-severity high` on an image built with **`--provenance=false`**, and treat remaining rows against **debian** / **PyPI** as the actionable set.

## Procedure

### 1) Preconditions

- **Docker** with `docker build` and **`docker scout`** available.
- **Git** with `git worktree` support.
- **Clean or stashable** state: if `git status` is not clean, **stash** with user consent (or **abort** and ask to commit/stash first). The sandbox is created from **current HEAD**; uncommitted work in the primary tree is **not** in the worktree unless stashed and reapplied in the worktree (prefer: clean tree).

### 2) Baseline (informational)

- `docker pull` the published image if useful (e.g. `dendlomm/nebularr:latest`) and run `docker scout quickview` / `docker scout cves` once to record **before** counts (optional but useful in the user summary).

### 3) Sandbox setup

From the **primary** repo (parent of `.git`):

1. Create a **unique** path, e.g. `SANDBOX="$TMPDIR/nebularr-scout-$$"` (or `../nebularr-scout-check-<shortsha>` under the same parent as the clone).
2. `git worktree add -b tmp/check-issues/<timestamp-or-random> "$SANDBOX" HEAD`
3. **All subsequent edits, builds, and tests** use **`cd "$SANDBOX"`** only.

If `git worktree` is impossible (rare), fallback: `git clone` the repo to `$SANDBOX` on a new branch; same rule: no edits in the original directory until success.

### 4) Remediate (sandbox only)

In `$SANDBOX`, iteratively:

- Prefer **low-risk** fixes: newer **`python:3.13-slim` image digest** (as in the current `Dockerfile`), `apt-get upgrade` in the Dockerfile when appropriate, **npm/pip** updates that fix Scout **without** breaking the Web UI (run **lint, test, `npm run build`** after `package.json` changes).
- Avoid **high-risk** jumps (e.g. **Alpine** base switch) unless the user explicitly allows them; if required for 0C/0H, **stop** and do not merge (report instead).
- After each material change: **`./scripts/docker-release-build.sh --load`** with a unique tag, or `docker buildx build --provenance=false --sbom=false … -t nebularr:scout-candidate --load .`, then `docker scout cves nebularr:scout-candidate` (or `quickview`).

**Stop condition for fixes:** 0 Critical, 0 High **or** user-defined threshold met.

**Record work in git (sandbox only):** When the candidate build and first Scout re-scan look good, **`git add` / `git commit`** in `$SANDBOX` (conventional subject/body) so promotion is a normal **`git merge`** of a real branch, not a manual file copy.

### 5) Test (sandbox only)

In `$SANDBOX`:

- `frontend/`: `npm install` as needed, then `npm run lint`, `npm test`, `npm run build`.
- Root/backend: run tests and checks defined by the project.

If anything fails, go to [Failure](#failure) — do not touch the primary tree.

### 6) Promote to primary (only after 5) succeeds)

1. `cd` to the **primary** repo (not the worktree).
2. `git fetch` and ensure the **target branch** (e.g. `main`) is current.
3. `git merge --no-ff tmp/check-issues/<...>` (or `git cherry-pick` the sandbox commits) into the current branch, resolving conflicts. If merge fails, go to [Failure](#failure) without partial applies of unreviewed file copies.
4. If `frontend/package.json` or lockfile changed, run `npm install` in `frontend/` in the **primary** tree; rebuild `src/arrsync/web/dist` if the project commits embedded assets (`npm run build` from `frontend/`).
5. **Version bump:** follow [app-version-semver](../app-version-semver/SKILL.md) (typically at least a **PATCH** for dependency/Docker hardening). Update **all** version locations that skill lists; run `npm install` in `frontend/` if package version changes.

### 7) Push

Follow [github-commit-and-push](../github-commit-and-push/SKILL.md): commit, semver, `git push`, **Docker Hub** `dendlomm/nebularr` with `latest` and `$APP_VERSION`, unless the user said **no docker** / **GitHub only**.

### 8) Cleanup (success)

- `git worktree remove "$SANDBOX"` and delete the local branch `tmp/check-issues/...` if not merged, or after merge as appropriate.
- Prune: `git worktree prune` if needed.

## Failure

If Scout never meets the bar, build fails, tests fail, or merge into primary fails:

1. `cd` to primary repo; **do not** keep partial file edits that weren’t produced by a successful merge.
2. `git worktree remove --force "$SANDBOX"` (if the worktree still exists), then `git branch -D tmp/check-issues/...` if that branch is only for this attempt.
3. Tell the user: **no changes were applied** to their branch (or only what was **already** committed before the run, if you didn’t merge).

## Output to the user

- **Baseline** Scout summary (if run).
- **Sandbox path** used.
- **What changed** in the merge (brief).
- **Final** Scout summary on the candidate **and** (after push) on `dendlomm/nebularr:latest` if you pushed a new image.
- **Tests** that ran and passed, or the exact **failure** and **remediation** hints.

## Relationship to other skills

- [github-commit-and-push](../github-commit-and-push/SKILL.md) — publish step after successful merge; do not skip Docker Hub for a standard push unless the user opts out.
- [app-version-semver](../app-version-semver/SKILL.md) — version bump before `git push` when the merged work warrants it.
- [v2-backlog-maintainer](../v2-backlog-maintainer/SKILL.md) — optional: open a **v2** note if a **major** upgrade (e.g. Vite 6) was **deferred** to clear remaining MEDIUMs.

---

*Rationale: isolating in a worktree prevents half-applied `package.json` / `Dockerfile` changes in the main tree if the image or tests fail; merging only when green matches “test a sandbox version … only make changes if build is good.”*
