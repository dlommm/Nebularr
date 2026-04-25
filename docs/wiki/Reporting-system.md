# Reporting system

Nebularr ships **in-product analytics** (dashboards in the Web UI) without opening an arbitrary SQL path from the browser. This page summarizes the **design**; the full spec is [REPORTING_ARCHITECTURE.md](https://github.com/OWNER/REPO/blob/main/docs/REPORTING_ARCHITECTURE.md). Replace `OWNER/REPO` in links.

## Goals

- Rich **KPI, distribution, and table** views over `warehouse` data.  
- **No** client-composed SQL: the browser only passes **whitelisted** dashboard keys and **bounded** filter parameters.  
- **CSV** exports that stay within the same whitelist and panel scope.

## Components (conceptual)

| Layer | Role |
|--------|------|
| Web UI | Renders **panels**; calls fixed reporting endpoints. |
| Reporting API | Validates **dashboard key** against a **whitelist**; runs **parameterized** SQL **templates** owned by the server. |
| PostgreSQL | Primarily reads from **`warehouse`** views / tables as defined in each template. |

**Diagrams:** see the “Component design” and “Runtime flow” mermaid blocks in the canonical doc.

## Security model (non-negotiables)

- **Fixed keys** only — the client cannot name arbitrary report IDs beyond the catalog.  
- **User input** is limited to vetted filter shapes (e.g. `instance_name`, `limit` with **server bounds**).  
- **CSV** is panel-scoped and also enforced server-side.

**Full list:** [REPORTING_ARCHITECTURE.md — Security model](https://github.com/OWNER/REPO/blob/main/docs/REPORTING_ARCHITECTURE.md#security-model).

## Panel types

- **`stat`** — Single KPI.  
- **`distribution`** — Label/value rows (e.g. bar-style rendering in the UI).  
- **`table`** — Tabular records with column filter UX in the Web UI.  

**Flow:** list dashboards → request one by key with filters → receive typed panel payload. Details in the doc’s “Runtime flow” section.

## Porting and evolution

- New or migrated dashboards are added by extending **server-side** handlers/templates, not by storing SQL in the client.  
- The doc describes **porting** from legacy definitions incrementally.  

**Also read:** [WEBUI_FRAMEWORK.md](https://github.com/OWNER/REPO/blob/main/docs/WEBUI_FRAMEWORK.md) (paged data and CSV for library vs reporting as separate features). [Web-UI](Web-UI) wiki page for routes and build.

## Related in-repo

- [PERF_INDEXING_PLAN](https://github.com/OWNER/REPO/blob/main/docs/PERF_INDEXING_PLAN.md) if reporting queries need indexes.  
- [MIGRATIONS](https://github.com/OWNER/REPO/blob/main/docs/MIGRATIONS.md) when `warehouse` views change.  
