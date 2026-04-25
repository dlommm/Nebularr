---
name: github-commit-and-push
description: >-
  Maintains small, well-explained Git commits as work is completed, using
  conventional titles and message bodies. When the user says to push to GitHub
  (or sync the remote), finishes any pending commits safely and runs git push
  to origin. After a successful main-repo push, can sync the canonical wiki
  Markdown under docs/wiki/ to the separate GitHub Wiki git repository
  (create/update pages on the GitHub Wiki tab). Use when committing, pushing,
  syncing with GitHub, preparing a PR, per-task commit messages, or publishing
  wiki changes from docs/wiki.
---

# GitHub: incremental commits and push

## Goals

- **As you go:** group related file changes into commits with a **short subject** and optional **body** explaining *what* and *why*.
- **On “push to GitHub” (or “sync to origin”):** ensure the working tree is clean (or commit remaining work in sensible chunks), **pull with rebase** if the branch is behind, then **push** the current branch to `origin`.
- **Wiki (Nebularr):** the canonical source for GitHub Wiki content lives in the main repo at **`docs/wiki/*.md`**. The GitHub **Wiki** tab is a **separate** git remote (`https://github.com/<owner>/<repo>.wiki.git`), not part of a normal `git push` to `origin`. When appropriate, **sync** that folder to the wiki remote after the main push (see below).

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
2. `git remote -v` and current branch (usually `main`).
3. If **behind** `origin`:** `git pull --rebase origin <branch>`** (or merge if rebase is impossible and the user allows merge). Resolve conflicts, continue rebase, then continue.
4. `git push origin <branch>`.
5. **Do not** `git push --force` or rewrite published history on **origin** unless the user explicitly requests it and understands the impact.
6. **GitHub Wiki (optional, from `docs/wiki/`):** if this repo has `docs/wiki/` and the user asked to **include wiki**, **push wiki**, or the commits being pushed **touch `docs/wiki/`**, then after step 4 succeeds, run the **GitHub Wiki sync** section below. Skip if the user said **code only** or **no wiki**, or if Wikis are disabled for the repository.

## GitHub Wiki sync (from `docs/wiki/`)

**Why:** Git stores wiki pages in a **second** repository, not the default `origin`. Pushing `main` does not update the Wiki tab. Nebularr keeps the **source of truth** for wiki Markdown in **`docs/wiki/`** in the main repo; publishing means copying that tree into the **`.wiki` git repo** and pushing it.

**Prerequisites**

- **Wikis** enabled in the GitHub repo settings (Settings → General → **Wikis**).
- The machine running git has **permission** to push to `https://github.com/<owner>/<repo>.wiki.git` (or the SSH form `git@github.com:<owner>/<repo>.wiki.git`), using the same credentials as for `origin`.

**Derive the wiki URL**

- From `git remote get-url origin`: for `https://github.com/OWNER/REPO.git` or `git@github.com:OWNER/REPO.git`, the wiki remote is `https://github.com/OWNER/REPO.wiki.git` or `git@github.com:OWNER/REPO.wiki.git` (same host and auth style as `origin`).

**Procedure (agent executes when step 6 applies)**

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

## If pull fails (diverged history)

- Prefer **rebase** for linear history: `git pull --rebase origin <branch>`.
- If the user’s workflow is merge-only, use `git pull` without rebase and document the merge in the next commit message if needed.

## Output to the user after push

- Short summary: **branch**, **pushed commit range or tip SHA**, and **link pattern** `https://github.com/<org>/<repo>/compare/...` if useful (use known remote URL).
- If wiki sync ran: add **wiki** status (synced or skipped) and the wiki home URL.

## Relationship to other skills

- [app-version-semver](../app-version-semver/SKILL.md) — when a push **releases** user-visible work, consider a semver bump in the same session before or in the last commit, per that skill.

---

*Optional:* keep **commit messages in complete sentences in the body** (project user preference) while subjects stay short.
