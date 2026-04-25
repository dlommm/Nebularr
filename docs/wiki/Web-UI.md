# Web UI

The Web UI is a **React 18** + **TypeScript** + **Vite** single-page app in [`frontend/`](https://github.com/OWNER/REPO/tree/main/frontend). The production bundle is built into [`src/arrsync/web/dist`](https://github.com/OWNER/REPO/tree/main/src/arrsync/web/dist) and served by FastAPI at `/` with a catch-all for client-side routes.

## Quick facts

- **Routing** — `react-router-dom`: Home (`/`), Dashboard (`/dashboard`), Library, Reporting, Integrations, Schedules, webhooks, actions, logs, setup wizard (`/setup`).  
- **Data** — `@tanstack/react-query` for caching and polling; heavy views use paged server APIs.  
- **In-repo spec** — [docs/WEBUI_FRAMEWORK.md](https://github.com/OWNER/REPO/blob/main/docs/WEBUI_FRAMEWORK.md)  

## Important paths in the tree

| Path | Role |
|------|------|
| [`frontend/src/App.tsx`](https://github.com/OWNER/REPO/blob/main/frontend/src/App.tsx) | Top-level routes and lazy page loading |
| [`frontend/src/layout/AppLayout.tsx`](https://github.com/OWNER/REPO/blob/main/frontend/src/layout/AppLayout.tsx) | Shell: sidebar, top bar, command palette, `<Outlet />` |
| [`frontend/src/pages/`](https://github.com/OWNER/REPO/tree/main/frontend/src/pages) | One module per main screen |
| [`frontend/src/styles.css`](https://github.com/OWNER/REPO/blob/main/frontend/src/styles.css) | Global styles (incl. glass / cosmic theme tokens) |
| [`.cursor/skills/webui-quality-guardian/`](https://github.com/OWNER/REPO/tree/main/.cursor/skills/webui-quality-guardian) | Quality checklist for Web UI (lint, test, build, e2e) |

## Commands (from `frontend/`)

```bash
npm install
npm run lint
npm run test
npm run build
npm run test:e2e
```

## Related docs

- [WEBUI_FRAMEWORK](https://github.com/OWNER/REPO/blob/main/docs/WEBUI_FRAMEWORK.md) — contracts for library pagination, CSV exports, UX features  
- [WEBUI_AGENT_WORKFLOW](https://github.com/OWNER/REPO/blob/main/docs/WEBUI_AGENT_WORKFLOW.md) — agent workflow notes  
- [Repository map](Repository-map) — how `frontend/` connects to the Python server  
