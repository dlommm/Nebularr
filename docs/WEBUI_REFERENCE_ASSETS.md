# WebUI Reference Assets

These assets are generated from the current React WebUI routes/components, using Playwright screenshots of the real app render (not hand-drawn mockups). **Every API call is answered from mocked fixtures** (`frontend/scripts/webui-capture-fixtures.mjs`), so they show the real UI against representative sample data — not a running instance. No request reaches a backend.

## 1:1 Page Images

Stored in `docs/reference/webui-pages/`:

- `home.png`
- `dashboard.png`
- `reporting.png`
- `library.png`
- `sync-overview.png`
- `sync-runs.png`
- `sync-webhooks.png`
- `sync-manual.png`
- `integrations.png`
- `schedules.png`
- `logs.png`
- `setup.png`
- `not-found.png`
- `library-episodes.png`, `library-all-episodes.png`, `library-movies.png`, `library-detail.png`, `library-compare.png`
- `reporting-storage.png`
- `automations.png`, `automations-editor.png`, `automations-run-detail.png`
- `mal.png`, `login.png`

## Sample Data

- `docs/reference/sample-data/webui-api-mock.json`
- `docs/reference/sample-data/webui-sample-media.json`
- `docs/reference/sample-data/webui-sample-events.csv`

The `webui-api-mock.json` payloads follow current frontend endpoint/type contracts and are used by the screenshot capture script.

## Regenerate Images

From `frontend/`:

```bash
npm run dev -- --host 127.0.0.1 --port 4173
npm run capture:reference
```

Capture script location:

- `frontend/scripts/capture-webui-reference.mjs`

Optional environment variables:

- `WEBUI_CAPTURE_BASE_URL` — server to capture against (default `http://127.0.0.1:4173`).
- `WEBUI_CAPTURE_OUTPUT_DIR` — where PNGs are written (default `docs/reference/webui-pages`).
- `WEBUI_CAPTURE_THEME` — `light`, `dark` or `light,dark` (default `dark`).
- `WEBUI_CAPTURE_VIEWPORTS` — any of `reference` (1720×1080, default), `desktop` (1440×900), `large` (1920×1080), `tablet` (768×1024), `mobile` (390×844).
- `WEBUI_CAPTURE_SCENARIOS` — any of `healthy` (default), `degraded` (critical health, backlog, dead letters, failed runs), `empty` (nothing synced yet).
- `WEBUI_CAPTURE_ONLY` — comma list of capture names.
- `WEBUI_CAPTURE_DENSITY=compact` — capture compact density.

With more than one theme/viewport/scenario, files are written to `<output>/<scenario>/<theme>/<viewport>/<name>.png`. Fixtures mirror `frontend/src/types.ts` and the backend handlers; update them when an API contract changes. See `docs/DESIGN_LANGUAGE.md` for the review checklist.
