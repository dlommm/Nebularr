---
name: v2-backlog-maintainer
description: Maintains the v2 roadmap backlog in docs/V2_BACKLOG.md by capturing new feature improvements, reliability ideas, and platform enhancements discovered during implementation or review. Use when the user mentions v2, backlog, roadmap, improvements, enhancements, future work, follow-ups, or asks what should be done next.
---
# V2 Backlog Maintainer

Use this skill to keep `docs/V2_BACKLOG.md` up to date as code evolves.

## Primary Objective

Continuously capture high-value post-v1 improvements so v2 planning stays current.

## Trigger Scenarios

Apply this workflow whenever:

- The user asks for v2 ideas, roadmap items, enhancements, or future work.
- You discover non-blocking improvements while implementing any task.
- You identify missing tests, scalability gaps, or operational risks that are not required for the current request.
- You finish a feature and spot logical next-step improvements.

## Update Workflow

1. Read `docs/V2_BACKLOG.md`.
2. Identify candidate items discovered from current work.
3. Add only meaningful, non-duplicate improvements.
4. Assign an ID in the existing convention:
   - `v2-rel-*`, `v2-perf-*`, `v2-sec-*`, `v2-ui-*`, `v2-int-*`, `v2-plat-*`, `v2-test-*`
5. Default new items to `proposed` unless the user explicitly prioritizes them.
6. Keep entries concise and outcome-focused (one line each).
7. If work starts or completes for an existing item, update status (`planned`, `in_progress`, `done`, or `deferred`).

## Guardrails

- Do not add items that are already completed in v1 unless there is a clearly distinct v2 upgrade.
- Do not add low-value micro-tasks that belong in regular implementation commits.
- Do not remove historical ideas; update status instead.
- Keep terminology consistent with existing sections in `docs/V2_BACKLOG.md`.

## Output Expectations

When you update the backlog, report:

- Which items were added or changed.
- Why they were added (short rationale).
- Current total count by status (if the user asks for tracking).

## Item Writing Template

Use the style in [ITEM_TEMPLATE.md](ITEM_TEMPLATE.md).
