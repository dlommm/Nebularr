# WebUI Quality Guardian

## Purpose

Protect stability during the Nebularr WebUI rebuild by validating milestones and blocking regressions.

## Trigger Phrases

- "validate milestone"
- "quality gate"
- "regression check"
- "guardian pass"

## Validation Checklist

1. Frontend checks:
   - `npm run lint`
   - `npm run test`
   - `npm run build`
2. Backend checks (if API changed):
   - `pytest -q`
   - `ruff check src tests`
   - `mypy src`
3. Runtime smoke checks (if deploy/runtime touched):
   - app health endpoint
   - key WebUI routes render
4. Critical flows:
   - library pagination/sort/filter
   - sync run/progress visibility
   - integration/schedule save paths
   - CSV export links

## Decision Rules

- Fail the gate if any required check fails.
- Provide exact failing command and error summary.
- Approve only when all milestone checks are green.
