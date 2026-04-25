---
name: github-commit-and-push
description: >-
  Maintains small, well-explained Git commits as work is completed, using
  conventional titles and message bodies.   When the user says to push to GitHub
  (or sync the remote), always runs the app-version-semver check before
  git push, then pushes to origin, then always publishes the app image to
  Docker Hub with the latest tag plus the current semver (unless the user
  opts out or Docker is unavailable). After that, can sync docs/wiki/ to the
  GitHub Wiki remote. Use when committing, pushing, syncing with GitHub,
  preparing a PR, per-task commit messages, or publishing wiki changes.
---

# GitHub: incremental commits and push

## Goals

- **As you go:** group related file changes into commits with a **short subject** and optional **body** explaining *what* and *why*.
- **On “push to GitHub” (or “sync to origin”):** after commits are in order, **run the app version (semver) gate** (see below), then **pull with rebase** if the branch is behind, then **push** the current branch to `origin`, then by default **build and push** the Nebularr app image to **Docker Hub** with **`latest`** and **`$APP_VERSION`** tags (see **Docker Hub publish**). Wiki sync remains a separate optional step.
- **Wiki (Nebularr):** the canonical source for GitHub Wiki content lives in the main repo at **`docs/wiki/*.md`**. The GitHub **Wiki** tab is a **separate** git remote (`https://github.com/<owner>/<repo>.wiki.git`), not part of a normal `git push` to `origin`. When appropriate, **sync** that folder to the wiki remote after the main push and Docker step (see below).
- **Docker Hub (Nebularr, default for “push to GitHub”):** after a successful **`git push`**, **always** run the **Docker Hub publish** procedure for the app image, unless a listed exception applies. The image should match what was just pushed: **`latest`** plus the current **`app_version`** semver. Requires a working **Docker** CLI and a logged-in **Docker Hub** account (`docker login`); do not put credentials in commands or the chat log.

## Commit style (Nebularr)

- **Subject:** imperative, ~72 chars, optional `type:` prefix — `feat:`, `fix:`, `db:`, `docs:`, `chore:`, `test:`, `refactor:`, `deploy:`.
- **Body:** separate paragraphs or `-` bullets for distinct concerns (e.g. migration purpose, API change, follow-up risk).
- **One logical change per commit** when practical; if a session mixed topics, **split** by `git add` path before committing.

## During implementation (as changes occur)

1. After a coherent slice (e.g. one migration, one service, one page), **stage only those paths** and commit.
2. If the user asks to “save progress” or “commit this,” run `git status`, summarize staged vs unstaged, then commit with a message that lists the slice.
3. **Never** add `.env` or other ignored secrets; rely on `.gitignore`.
4. If only **formatting** or **generated** output would mix with a feature, prefer a separate `chore:` commit (e.g. lockfile only after `package.json` change).

## When the user says “push to GitHub” (or equivalent)

1. `git status` — if there are uncommitted changes, **commit them** in one or more logical commits (or ask once if the split is unclear).
2. **App version (semver) — required before push (Nebularr):** **Read and follow** [app-version-semver](../app-version-semver/SKILL.md). Do not skip this step.
   - Review the **scope of work** about to be pushed (commits, diff, and anything already merged on the branch) and apply that skill’s **MAJOR / MINOR / PATCH / no-bump** rules.
   - If a version **bump is warranted**, update **every** in-repo `app_version` / package version location listed in that skill, run `npm install` in `frontend/` when `package.json` changes, and **add a commit** (e.g. `chore: bump version to x.y.z` or `chore: release x.y.z`) so the new version is **on the branch you are about to push**.
   - If the correct decision is **no bump** (typo-only, comments-only, or otherwise per that skill), **say so in one line** in your reply to the user (e.g. “No version bump: internal-only change”) so the check is visible.
   - If the user explicitly says **do not bump**, **skip version**, or **version already done**, do **not** change version files; still **state** that the semver pass was honored via their instruction.
3. `git remote -v` and current branch (usually `main`).
4. If **behind** `origin`:** `git pull --rebase origin <branch>`** (or merge if rebase is impossible and the user allows merge). Resolve conflicts, continue rebase, then continue. *If a version bump was committed in step 2, rebase may replay it — resolve normally.*
5. `git push origin <branch>`.
6. **Do not** `git push --force` or rewrite published history on **origin** unless the user explicitly requests it and understands the impact.
7. **Docker Hub — required for “push to GitHub” (Nebularr app image):** immediately after step **5** succeeds, run the **Docker Hub publish** section below. **Do not skip** this step for a normal “push to GitHub” / “push to origin” / “sync the repo” request.
   - **Skip only** if: the user said **no docker**, **GitHub only**, **skip image**, **don’t push to Docker Hub**, or the environment has **no Docker** / **no registry access** (in that case, **state clearly** that the image was not published and why).
   - If **build or push fails** (e.g. not logged in to Docker Hub, network error), **report the error**, suggest `docker login` and retry, and **do not** claim the image is published.
   - **Never** embed registry passwords in commands; use **`docker login`** (or credential helper) as already configured on the machine.
8. **GitHub Wiki (optional, from `docs/wiki/`):** if this repo has `docs/wiki/` and the user asked to **include wiki**, **push wiki**, or the commits being pushed **touch `docs/wiki/`**, then after step **7** (Docker Hub) finishes or is skipped, run the **GitHub Wiki sync** section below. Skip if the user said **code only** or **no wiki**, or if Wikis are disabled for the repository.

## GitHub Wiki sync (from `docs/wiki/`)

**Why:** Git stores wiki pages in a **second** repository, not the default `origin`. Pushing `main` does not update the Wiki tab. Nebularr keeps the **source of truth** for wiki Markdown in **`docs/wiki/`** in the main repo; publishing means copying that tree into the **`.wiki` git repo** and pushing it.

**Prerequisites**

- **Wikis** enabled in the GitHub repo settings (Settings → General → **Wikis**).
- The machine running git has **permission** to push to `https://github.com/<owner>/<repo>.wiki.git` (or the SSH form `git@github.com:<owner>/<repo>.wiki.git`), using the same credentials as for `origin`.

**Derive the wiki URL**

- From `git remote get-url origin`: for `https://github.com/OWNER/REPO.git` or `git@github.com:OWNER/REPO.git`, the wiki remote is `https://github.com/OWNER/REPO.wiki.git` or `git@github.com:OWNER/REPO.wiki.git` (same host and auth style as `origin`).

**Procedure (agent executes when step 8 applies)**

1. **Clone or update** the wiki repo in a throwaway directory (e.g. next to the project or under `/tmp`), not inside the main repo as a subfolder to avoid nested-repo confusion.
   - First time: `git clone <wiki-url> <dir>` (empty wiki may have no default branch; create `master` or `main` with an initial commit if GitHub has never had wiki content—otherwise clone works as usual).
2. **Copy** (mirror) all `*.md` from the main repo’s **`docs/wiki/`** into the root of the wiki clone, preserving filenames. GitHub Wiki expects pages as top-level `Page-Name.md` (Nebularr’s `docs/wiki` layout is already flat with names like `Home.md`, `_Sidebar.md`).
3. In the wiki clone: `git status` → `git add -A` → `git commit -m "docs: sync from docs/wiki"` (skip commit if there is **nothing to commit**).
4. **Push** the wiki clone to its remote. Default branch is often **`master`** for GitHub wikis: `git push origin master` (or `main` if that is the only branch). Use **`git push --force`** to the **wiki** remote only if the user explicitly needs to overwrite divergent wiki history and understands the loss of divergent edits made only on GitHub; otherwise prefer normal merge or pull-rebase in the wiki clone first.

**Notes**

- Edits made **only** in the GitHub web UI will be **overwritten** the next time a full file mirror replaces those paths; treat **`docs/wiki/`** as canonical or merge carefully.
- If the wiki has **no** `master` branch yet, the first `git push -u origin master` after the first local commit is common.

**Output to the user after wiki push**

- Note whether the wiki was **skipped** (not requested / no `docs/wiki` changes) or **synced**, and the wiki’s web URL: `https://github.com/<owner>/<repo>/wiki`.

## Docker Hub publish (`latest` + semver)

**When:** **By default, every** successful **“push to GitHub”** (after `git push` in step 5) — see **step 7** in the main procedure. The goal is a registry that matches **`origin`**: **`IMAGE:latest`** and **`IMAGE:$APP_VERSION`**.

**Default image name in this repo:** deploy examples use **`dendlomm/nebularr`** (see `deploy/unraid/docker-compose.yml`). If the user’s namespace differs, substitute **`DOCKERHUB_USER/nebularr`** (or the image they maintain).

**Prerequisites**

- Docker with **`docker build`** and **`docker push`** available (on Linux/macOS; Docker Desktop on macOS/Windows is fine).
- **Authenticated** to Docker Hub: `docker login` (or already logged in). Do not pass passwords on the command line in chat logs.
- The local repo **build context** is the one that was just pushed to GitHub (same commit).

**Build arguments (Nebularr `Dockerfile`)**

- **`APP_VERSION`** — must match the **released** `app_version` in `pyproject.toml` / [app-version-semver](../app-version-semver/SKILL.md) for this push (usually from step 2).
- **`GIT_SHA`** — use `$(git rev-parse --short HEAD)` for traceability (image metadata / debugging).

**Procedure (agent executes when step 7 applies)**

1. Read **`APP_VERSION`** from `pyproject.toml` `[project].version` (or the single source of truth after the semver step).
2. From the **repository root** (where the root `Dockerfile` lives), **build** the app image with two tags: **`latest`** and **`$APP_VERSION`** (semver).
3. **Push** both tags to Docker Hub.

**Preferred (Nebularr):** from the repository root, use the release script so the image is built **without** SLSA provenance / SBOM attestations, which **reduces inflated Docker Hub Scout** counts (see `scripts/docker-release-build.sh` header). Ensure `cd frontend && npm run build` has been run if the WebUI changed.

```bash
./scripts/docker-release-build.sh --push
# Optional: IMAGE=youruser/nebularr ./scripts/docker-release-build.sh --push
```

**Alternative (plain `docker build`)** for local testing only: same args, but Hub Scout may show more notional packages. Use `read_text()` (not `read_bytes()`) for `tomllib` on Python 3.14+.

```bash
export APP_VERSION="$(python3 -c "import tomllib, pathlib; print(tomllib.loads(pathlib.Path('pyproject.toml').read_text())['project']['version'])")"
export GIT_SHA="$(git rev-parse --short HEAD)"
export IMAGE="dendlomm/nebularr"

docker buildx build --provenance=false --sbom=false -f Dockerfile \
  --build-arg "APP_VERSION=${APP_VERSION}" \
  --build-arg "GIT_SHA=${GIT_SHA}" \
  -t "${IMAGE}:latest" \
  -t "${IMAGE}:${APP_VERSION}" \
  --push \
  .
```

- **Multi-arch** (e.g. `linux/amd64` and `linux/arm64`): only if the user asked or their CI usually builds multi-platform; use `docker buildx build --platform ... --push` and ensure a buildx builder exists. If unsure, the single-arch **build + push** above is enough for many operators.

- **pgAdmin** or other **secondary** images in this repo: only build and push if the user asked for them explicitly; the default is **Nebularr app only** (`uvicorn` service).

**Output to the user after Docker push**

- Image name(s), tags pushed (**`latest`** and **`x.y.z`**), and **`APP_VERSION` / `GIT_SHA`** used in the build.

## If pull fails (diverged history)

- Prefer **rebase** for linear history: `git pull --rebase origin <branch>`.
- If the user’s workflow is merge-only, use `git pull` without rebase and document the merge in the next commit message if needed.

## Output to the user after push

- Short summary: **branch**, **pushed commit range or tip SHA**, and **link pattern** `https://github.com/<org>/<repo>/compare/...` if useful (use known remote URL).
- **Docker Hub:** by default, confirm **image**, **`latest`** and **semver** tags, and build **metadata** (version + git sha), or explain **skip** / **failure** and next steps.
- If wiki sync ran: add **wiki** status (synced or skipped) and the wiki home URL.

## Relationship to other skills

- [app-version-semver](../app-version-semver/SKILL.md) — **not optional** for “push to GitHub” on Nebularr: the agent must run the decision in that file **before** `git push` (see **step 2** above). The semver skill still allows **no bump** when the change set does not warrant it; the agent must make that decision explicitly rather than skipping the read.
- **Docker Hub** — **not optional** for a normal “push to GitHub” on Nebularr: the agent must run **Docker Hub publish** after a successful `git push` (see **step 7**), unless a skip reason applies. That keeps `latest` on the registry aligned with the branch you just pushed.

---

*Optional:* keep **commit messages in complete sentences in the body** (project user preference) while subjects stay short.
