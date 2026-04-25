---
name: github-commit-and-push
description: >-
  Maintains small, well-explained Git commits as work is completed, using
  conventional titles and message bodies. When the user says to push to GitHub
  (or sync the remote), finishes any pending commits safely and runs git push
  to origin. Use when committing, pushing, syncing with GitHub, preparing a
  PR, or the user wants per-task commit messages.
---

# GitHub: incremental commits and push

## Goals

- **As you go:** group related file changes into commits with a **short subject** and optional **body** explaining *what* and *why*.
- **On “push to GitHub” (or “sync to origin”):** ensure the working tree is clean (or commit remaining work in sensible chunks), **pull with rebase** if the branch is behind, then **push** the current branch to `origin`.

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
5. **Do not** `git push --force` or rewrite published history unless the user explicitly requests it and understands the impact.

## If pull fails (diverged history)

- Prefer **rebase** for linear history: `git pull --rebase origin <branch>`.
- If the user’s workflow is merge-only, use `git pull` without rebase and document the merge in the next commit message if needed.

## Output to the user after push

- Short summary: **branch**, **pushed commit range or tip SHA**, and **link pattern** `https://github.com/<org>/<repo>/compare/...` if useful (use known remote URL).

## Relationship to other skills

- [app-version-semver](../app-version-semver/SKILL.md) — when a push **releases** user-visible work, consider a semver bump in the same session before or in the last commit, per that skill.

---

*Optional:* keep **commit messages in complete sentences in the body** (project user preference) while subjects stay short.
