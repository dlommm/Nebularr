# Automations

Automations converge your library toward declared preferences ("anime = English dub,
1080p minimum") by periodically triggering Sonarr/Radarr searches and metadata
actions, driven entirely by warehouse data.

## Model

- **Automation** (`app.automation`): a template instance — params (scope /
  requirements / actions), its own cron + timezone, `budget_per_run`,
  `cooldown_days`, `enabled`, `dry_run`. New automations start in **dry-run**:
  runs record what they *would* do; flip the switch per rule to go live.
- **Conformance**: an item conforms when its file satisfies every requirement
  (audio language, resolution floor, codec, quality name). Non-conforming items
  in scope receive the rule's actions.
- **Acquisition model**: Nebularr only sends `*Search` commands; your Arr quality
  profiles and custom formats decide what actually gets grabbed. If a rule
  requires a language and no custom format on the instance scores language/dub,
  the run records a profile warning.

## Rate protection (4 layers)

1. Min interval between Arr command posts (`AUTOMATION_COMMAND_MIN_INTERVAL_SECONDS`, default 2s).
2. Per-run search budget (`budget_per_run`, default 10).
3. Global daily search cap across all automations (`AUTOMATION_MAX_SEARCHES_PER_DAY`, default 100).
4. Per-item cooldown via `app.automation_action_ledger` (default 7 days, **search actions only**) — the
   ledger is keyed globally, so two rules can never double-search one item. Tag and monitor
   reconciles are idempotent live-state diffs with no cooldown.

## Templates

anime-dub-enforcer (skips MAL `dub_status='none'` items), new-dub-watcher
(searches on `none → partial|dubbed` transitions), resolution-floor,
missing-hunter, codec-preference (tag-only by default), language-audit
(tag-only), custom (condition builder). All compile through the same
whitelist-only SQL compiler — user input is bind values, never SQL text.

**Note:** Tag actions with `when=conforming` are rejected by validation in v1
(not supported for live-state reconciles; use `when=nonconforming` instead).

## Operations

- Runs are recorded in `app.automation_run`; per-item outcomes live in `details`.
- Concurrency: `app.job_lock` lease `automation:{id}` — a run skips with
  "already running" instead of stacking.
- Tag labels used by an automation are owned by it: the reconcile adds the tag
  to matched items and removes it from unmatched ones on every run.
- Budget/cap apply to searches only; tag/monitored reconciles are idempotent
  diffs against live Arr state.
