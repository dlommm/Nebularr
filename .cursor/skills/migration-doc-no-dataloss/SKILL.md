---
name: migration-doc-no-dataloss
description: Enforces migration documentation with no-data-loss procedures whenever changes affect schema, migrations, data models, or persistence behavior. Use when editing alembic revisions, SQL/bootstrap scripts, DB config, or deploy docs tied to database changes.
---

# Migration Documentation Guard (No Data Loss)

## When to Use

Use this skill when any change modifies:
- `alembic/` revisions or migration behavior
- SQL bootstrap/init scripts
- database models or constraints
- runtime database URL/bootstrap flow
- deployment/config docs that change DB rollout steps

If uncertain, treat the change as migration-impacting and document it.

## Required Deliverables

For migration-impacting work, include operator-facing docs that cover:
1. **Scope**: what changed and which environments are affected.
2. **Preflight**: backups/snapshots and compatibility checks.
3. **Execution steps**: exact command/order for safe rollout.
4. **No-data-loss strategy**: handling renames/type changes/backfills/downtime risks.
5. **Verification**: post-migration checks and health criteria.
6. **Rollback/restore**: safe fallback path if verification fails.

## Documentation Placement

Prefer updating existing docs first:
- `docs/DB_BOOTSTRAP.md`
- `README.md` deployment sections
- platform-specific docs (e.g. `deploy/unraid/*`, `docs/wiki/*`)

If existing docs are not a good fit, add a focused migration note under `docs/`.

## Execution Checklist

Copy this checklist during migration-impacting tasks:

- [ ] Identified migration impact and affected operators.
- [ ] Added/updated docs with step-by-step no-data-loss plan.
- [ ] Included backup and restore guidance.
- [ ] Added post-migration verification steps.
- [ ] Called out residual risk or manual follow-ups.

## Final Response Requirement

Before finishing, explicitly state one of:
- "Migration docs updated:" plus file paths
- "No migration docs needed:" plus clear reason (non-schema/non-persistence change)
