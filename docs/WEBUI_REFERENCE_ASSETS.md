# WebUI Reference Assets

These assets are generated from the current React WebUI routes/components, using Playwright screenshots of the real app render (not hand-drawn mockups). **Every API call is answered from mocked fixtures** (`frontend/scripts/webui-capture-fixtures.mjs`), so they show the real UI against representative sample data — not a running instance. No request reaches a backend.

## 1:1 Page Images

Stored in `docs/reference/webui-pages/` (dark theme, 1720×1080, healthy scenario):

- Overview: `home.png`
- Library: `library.png`, `library-episodes.png` (a show expanded), `library-all-episodes.png`, `library-movies.png`, `library-detail.png`, `library-compare.png`
- Sync & Queue: `sync-overview.png`, `sync-runs.png`, `sync-webhooks.png`, `sync-manual.png`
- Reports: `reporting.png`, `reporting-storage.png`
- Rules: `automations.png`, `automations-editor.png`, `automations-run-detail.png`
- Anime: `mal.png`
- Setup: `integrations.png`, `artwork.png`, `schedules.png`, `logs.png`
- Sign-in and first run: `login.png`, `setup.png`
- `not-found.png`

A light-theme Overview is in `light/home.png` (`WEBUI_CAPTURE_THEME=light WEBUI_CAPTURE_ONLY=home WEBUI_CAPTURE_OUTPUT_DIR=../docs/reference/webui-pages/light`).

Phone shots (390×844, viewport only) are in `phone/`: `home.png`, `library-episodes.png`, `sync-overview.png`:

```bash
WEBUI_CAPTURE_VIEWPORTS=mobile WEBUI_CAPTURE_FULL_PAGE=0 \
WEBUI_CAPTURE_ONLY=home,library-episodes,sync-overview \
WEBUI_CAPTURE_OUTPUT_DIR=../docs/reference/webui-pages/phone npm run capture:reference
```

## Sample Data

- `docs/reference/sample-data/webui-api-mock.json`
- `docs/reference/sample-data/webui-sample-media.json`
- `docs/reference/sample-data/webui-sample-events.csv`

The `webui-api-mock.json` payloads follow current frontend endpoint/type contracts and are used by the screenshot capture script.

## Regenerate Images

From `frontend/`:

```bash
npm run build && npx vite preview --port 4173
npm run capture:reference   # in a second shell
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
- `WEBUI_CAPTURE_FULL_PAGE=0` — capture the viewport only (use for phone shots; fixed bars otherwise land mid-page in a full-page image).

With more than one theme/viewport/scenario, files are written to `<output>/<scenario>/<theme>/<viewport>/<name>.png`. Fixtures mirror `frontend/src/types.ts` and the backend handlers; update them when an API contract changes.
