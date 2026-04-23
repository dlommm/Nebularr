# WebUI Task Tracker

## Purpose

Track execution progress for the Nebularr WebUI rebuild plan and keep todo state accurate.

## Trigger Phrases

- "start webui build"
- "mark todo in progress"
- "what is left"
- "track milestone progress"

## Workflow

1. Load the active plan todo list.
2. Mark only one item as `in_progress` at a time.
3. When implementation is done, record:
   - files changed
   - tests/lint executed
   - known follow-up risks
4. Mark todo as `completed`.
5. Request Quality Guardian validation for the milestone.

## Rules

- Do not mark `completed` until implementation evidence exists.
- If validation fails, move affected todo back to `in_progress`.
- Keep progress updates concise and chronological.
