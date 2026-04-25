# Development

## Prerequisites

- **Docker** (and Docker Compose) for the full stack, **or**  
- **Python** 3.11+ and **Node** 18+ for local split development (DB still required)  

## Backend (typical)

```bash
# from repo root — adapt to your venv / uv / poetry workflow
python -m pip install -e ".[dev]"   # if defined in pyproject; see project files
pytest -q
ruff check src tests
mypy src
```

Use the same commands your CI uses (e.g. GitHub Actions) if they differ.

## Frontend

```bash
cd frontend
npm install
npm run lint
npm run test
npm run build
```

`npm run build` must succeed before shipping; the output goes to `src/arrsync/web/dist/`.

## End-to-end (Playwright)

From `frontend/` (see `playwright.config.ts`):

```bash
npm run test:e2e
```

Requires a running app (base URL in config, often `http://localhost:8080`).

## Web UI quality gate

When changing the Web UI, the project [WebUI quality guardian](https://github.com/OWNER/REPO/tree/main/.cursor/skills/webui-quality-guardian) skill documents **lint, unit tests, build, and e2e** as the usual bar. Adjust if your process differs.

## Where to make changes

- **API behavior** — [`src/arrsync/`](https://github.com/OWNER/REPO/tree/main/src/arrsync), especially [`api.py`](https://github.com/OWNER/REPO/blob/main/src/arrsync/api.py)  
- **UI** — [`frontend/src/`](https://github.com/OWNER/REPO/tree/main/frontend/src)  
- **User-facing long-form docs** — [`docs/`](https://github.com/OWNER/REPO/tree/main/docs) and this wiki under [`docs/wiki/`](https://github.com/OWNER/REPO/tree/main/docs/wiki)  

See [Repository map](Repository-map) and [Documentation index](Documentation-index).
