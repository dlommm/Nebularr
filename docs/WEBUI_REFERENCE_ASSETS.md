# WebUI Reference Assets

These assets are generated from the current React WebUI routes/components, using Playwright screenshots of the live app render (not hand-drawn mockups).

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
- `WEBUI_CAPTURE_THEME` — `light` or `dark` to force a theme (default: app default, dark).
