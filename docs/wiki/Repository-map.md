# Repository map

High-level map of the **Nebularr** repository. Paths are relative to the repository root. Replace `OWNER/REPO` in links with your GitHub org and repo name.

## Top level

| Path | Purpose |
|------|---------|
| [`README.md`](https://github.com/OWNER/REPO/blob/main/README.md) | Project overview, architecture summary, API quick reference |
| [`Dockerfile`](https://github.com/OWNER/REPO/blob/main/Dockerfile) | App container image build |
| [`docker-compose.yml`](https://github.com/OWNER/REPO/blob/main/docker-compose.yml) | Local / default stack (Postgres + app) |
| [`deploy/`](https://github.com/OWNER/REPO/tree/main/deploy) | Extra deployment examples (e.g. Unraid) |
| [`docker/`](https://github.com/OWNER/REPO/tree/main/docker) | Postgres init and related assets |
| [`docs/`](https://github.com/OWNER/REPO/tree/main/docs) | In-repo documentation (see [Documentation index](Documentation-index)) |
| [`docs/wiki/`](https://github.com/OWNER/REPO/tree/main/docs/wiki) | **Source files** for this GitHub wiki (publish separately; see [README](https://github.com/OWNER/REPO/blob/main/docs/wiki/README.md)) |
| [`frontend/`](https://github.com/OWNER/REPO/tree/main/frontend) | React + TypeScript + Vite Web UI (build → `src/arrsync/web/dist`) |
| [`src/arrsync/`](https://github.com/OWNER/REPO/tree/main/src/arrsync) | Main Python application package |
| [`tests/`](https://github.com/OWNER/REPO/tree/main/tests) | Pytest (and other backend tests, if present) |

## Python application (`src/arrsync/`)

| Area | Role |
|------|------|
| [`api.py`](https://github.com/OWNER/REPO/blob/main/src/arrsync/api.py) | FastAPI router: HTTP, SPA shell, webhooks, `/api/*` |
| Config / settings | App configuration, env binding |
| Sync / repository / models | Ingest, warehouse writes, state |
| [`web/`](https://github.com/OWNER/REPO/tree/main/src/arrsync/web) | **Built** static UI (`dist/`) and static assets served at `/` |

## Frontend (`frontend/`)

| Path | Role |
|------|------|
| [`package.json`](https://github.com/OWNER/REPO/blob/main/frontend/package.json) | npm scripts, React deps |
| [`src/`](https://github.com/OWNER/REPO/tree/main/frontend/src) | `App`, routes, `pages/`, `layout/`, styles |
| Vite build output | Emitted to `../src/arrsync/web/dist` (see `vite.config.ts`) |

## How this maps to runtime

- One process: **FastAPI** serves the React SPA, JSON APIs, metrics, and webhook routes on one port.  
- The browser loads the SPA; client-side routes are handled by the SPA; the server’s catch-all returns `index.html` for non-API paths.  

See [Backend and API](Backend-and-API) and [Web UI](Web-UI) for details.
