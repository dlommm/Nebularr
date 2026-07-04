# Contributing to Nebularr

## Development setup

Backend (Python ≥ 3.11, tested on 3.14):

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e .[dev]
cp .env.example .env   # backend reads .env from the working directory outside Docker
```

Frontend (Node 24):

```bash
cd frontend
npm ci
npm run dev            # Vite dev server (proxy your own backend or use the capture mocks)
```

## Test matrix

| What | Command |
| ---- | ------- |
| Backend lint | `ruff check src tests` |
| Backend types | `mypy src` |
| Backend unit tests | `pytest -q` |
| Backend integration tests (real Postgres) | `NEBULARR_TEST_DATABASE_URL=postgresql+psycopg://user:pass@localhost:5432/testdb pytest tests/integration -q` |
| Frontend lint | `cd frontend && npm run lint` |
| Frontend unit tests | `cd frontend && npm test` |
| Frontend build | `cd frontend && npm run build` |
| E2E (needs a fresh compose stack on :8080) | `cd frontend && npm run test:e2e` |
| Shell scripts | `docker run --rm -v "$PWD:/mnt" koalaman/shellcheck:v0.11.0 scripts/*.sh` |

The API route surface is snapshot-tested (`tests/fixtures/route_table.txt`); if you add
or change a route, update the fixture in the same commit and mention it in the PR.

## Frontend build → committed dist

The built SPA is **committed** at `src/arrsync/web/dist/` (the Dockerfile copies it, and
`pip install` from git works without Node). After any WebUI change:

```bash
cd frontend && npm run build
git add ../src/arrsync/web/dist
```

CI fails if the committed dist does not match the source.

## Conventions

- Python: `ruff` + `mypy` clean; raw SQL uses bound parameters; secrets never logged.
- New API handlers go in the matching `src/arrsync/routers/` module.
- UI components use Tailwind + the shadcn primitives in `frontend/src/components/ui`;
  `frontend/src/styles.css` is reserved for the reporting dashboard/log-viewer CSS.
- Commit messages: conventional-ish prefix (`feat:`, `fix:`, `chore:`, `docs:`, ...).

## Release procedure

1. `./scripts/bump-version.sh X.Y.Z` (updates every hardcoded version; verify with
   `./scripts/check-version-sync.sh`).
2. Update `CHANGELOG.md`.
3. Rebuild the frontend and commit the refreshed dist.
4. Merge to `main`, then tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
5. The `release.yml` workflow verifies the tag, runs the full test matrix, pushes the
   multi-arch image (`dendlomm/nebularr:X.Y.Z` + `:latest`, SBOM + provenance), and
   creates the GitHub Release. Requires `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` secrets.
   (Manual fallback: `./scripts/docker-release-build.sh --push`.)
