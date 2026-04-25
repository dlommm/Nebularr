# Nebularr GitHub wiki (source files)

This folder contains markdown prepared for the **[GitHub wiki](https://docs.github.com/en/communities/documenting-your-project-with-wikis/about-wikis)**. Wikis are stored in a **separate Git repository** (`<repo>.wiki.git`), not on the default branch. Keep these files in the main repo so they are versioned with the project; **publish** them to the wiki with the steps below.

## Enable the wiki

1. On GitHub: **Repository → Settings → General → Features** → enable **Wikis**.

## Publish (one-time or when wiki pages change)

```bash
# Use your repository URL (SSH or HTTPS)
export WIKI_URL="https://github.com/OWNER/REPO.wiki.git"
# or: export WIKI_URL="git@github.com:OWNER/REPO.wiki.git"

cd /tmp
git clone "$WIKI_URL" nebularr-wiki
cd nebularr-wiki
cp -f /path/to/Nebularr/docs/wiki/*.md .
git add -A
git status
git commit -m "Sync wiki from docs/wiki"
git push
```

After the first push, you can also edit pages in the browser (**Wiki** tab) and later pull/merge to avoid overwriting local changes.

## Before publishing: replace links (optional)

Some pages use a placeholder for links into the main repo. Search and replace in the copied `*.md` files if needed:

- `OWNER/REPO` → your `org/repository` string (e.g. `dlomm/Nebularr`).

Or leave placeholders and replace once in the wiki clone before `git push`.

## Files in this directory

| File | GitHub wiki page |
|------|------------------|
| `Home.md` | Default landing page |
| `_Sidebar.md` | Left navigation (if the theme supports it) |
| `README.md` | This file (how to publish; not a wiki page) |
| `Documentation-index.md` | Master catalog: every `docs/*.md` in the main repo (paraphrased) |
| `Project-deep-dive.md` | Narrative tour tying together major subsystems |
| `Roadmap-and-history.md` | Pointers to `ORIGINAL_PLAN_REFERENCE` and `V2_BACKLOG` |
| `Repository-map.md` | Where code and docs live in the tree |
| `Backend-and-API.md` | FastAPI entry points and API surface |
| `Web-UI.md` | SPA, routes, build |
| `Web-UI-agent-workflow.md` | Multi-agent Web UI process (contributors) |
| `Data-layer-and-PostgreSQL.md` | Bootstrap, migrations, backup, pooling (synthesis) |
| `Sync-locking-and-webhooks.md` | Locks, queue/DLQ, scheduler (synthesis) |
| `Reporting-system.md` | Whitelisted SQL and dashboards (synthesis) |
| `Observability-and-health.md` | Health, metrics, alerting (synthesis) |
| `Security-secrets-and-configuration.md` | Secret handling and config (synthesis) |
| `Performance-tuning.md` | Pooling, indexing, host resources (synthesis) |
| `Branding-and-assets.md` | Name and assets (synthesis) |
| `Deployment.md` | Docker, compose, environment |
| `Unraid-and-advanced-deploy.md` | `deploy/unraid` and Unraid-specific notes |
| `Development.md` | Local run, tests, quality checks |

`Home.md` should exist for a useful default; `_Sidebar.md` is optional but recommended for navigation.
