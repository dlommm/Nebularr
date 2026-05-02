# Agent and publish hygiene (Nebularr)

This file is **tracked in Git** so every clone (and CI bots) agrees on boundaries. Cursor may also apply **local-only** rules under `.cursor/rules/`; those must **never** replace or contradict the policies below for anything that touches remotes.

## `.cursor/` — never on Git hosts or OCI images

- **Never** commit, stage, or push anything under `.cursor/` to GitHub (or other Git remotes). The whole directory is IDE/agent/workspace state (`rules`, `skills`, transcripts, plans, MCP config, caches, hooks, etc.).
- **`.gitignore`** must ignore **`.cursor/`** with **no exceptions** (`git ls-files .cursor` should be empty before push).
- **`.dockerignore`** must list **`.cursor/`** so no image recipe ever copies IDE metadata into Docker layers.

Before `git push`, verify:

```bash
if [ -z "$(git ls-files .cursor 2>/dev/null)" ]; then echo OK_no_cursor_paths_tracked; else echo FAIL_remove_cursor_paths; exit 1; fi
```

## Commit only deliberate paths

- Do not use careless `git add .` unless you have inspected `git status` and excluded local env keys, caches, transcripts, screenshots, PEMs, and `.cursor/`.
- Keep secrets out of commits (`README`, `Dockerfile`, and compose conventions document production-safe posture).

## Forbidden: Cursor `Co-authored-by` trailers

The following **must never** appear on commits that reach `origin` / GitHub:

- `Co-authored-by: Cursor`
- `Co-authored-by: Cursor <cursoragent@cursor.com>`
- Any `Co-authored-by` line containing **`cursoragent`**

Before **every** push, scan outbound commits on the pushing branch:

```bash
if { git log @{upstream}..HEAD --format=%B 2>/dev/null || git log main..HEAD --format=%B; } \
  | rg -q 'Co-authored-by:.*Cursor|cursoragent'; then
  echo "FAIL: remove Cursor Co-authored-by trailers before push"
  exit 1
else
  echo OK_commit_msgs
fi
```

If there is any match: **rewrite** those commits (`git rebase -i …` / `--reword`, `git commit --amend`, etc.) until the trailer is gone. Do not “fix forward” while leaving polluted history unless the branch was never pushed.

## Automated strip (recommended for each clone)

This repository ships **`.githooks/commit-msg`**, which removes forbidden Cursor attribution lines whenever Git records a commit. Point Git at it once:

```bash
./scripts/configure-git-hooks.sh
# or: git config core.hooksPath .githooks && chmod +x .githooks/commit-msg
```

`core.hooksPath` is **local** (never committed); run the script again after cloning on a new machine.
