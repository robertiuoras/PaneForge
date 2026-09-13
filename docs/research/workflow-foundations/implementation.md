# Workflow repairs, 2026-09-13

Scope: implement the confirmed backend workflow defects before further successor
planning. Shared runtime source is `/Users/robertiuoras/Projects/claude-memory`.
The app renderer and design prototypes are unchanged by this repair batch.

## Changes

- Prompt hooks record redacted local failure classes and successful configuration
  digests. Missing state on first use stays normal; actual state/config/log errors
  remain nonblocking but observable. Receipt logging cannot block a prompt.
- Craft attempts have unique run IDs. Reusing identical prompt text no longer
  credits an unopened attempt with another attempt's completion. Legacy text
  matches are explicitly unattributed; per-run shipping/verification stays unknown
  until the downstream system supplies an attributable receipt.
- Rewrites explicitly report whether the cost proxy improved, stayed the same or
  regressed. This is not a quality score or proof of token savings.
- The existing prompt library now contains `define-goal`, with outcome, inputs,
  scope, authority, checks and recovery. `promptlib/WORKFLOW.md` centralises the
  entry points. The wording linter recognises explicit scope exclusions and saved
  evidence references; it remains a heuristic.
- Codex startup marks a truncated index, including a final line with no newline.
  Vault packages expose incomplete excerpts and full-source references, including
  truncation from the remaining package budget. This does not automatically
  retrieve or apply every relevant correction.
- The affected offline regression tests are added to existing compatibility CI.

## Evidence discipline

The earlier plan's D3 claim of hourly Codex research runs contradicts its own
`workflow-usage-evidence.md`: hourly readings were selected by time buckets, not
proof of a scheduler. No scheduler is changed on that premise. D7 auto-harvesting
from verified crafts is deferred because per-run delivery evidence is still
incomplete. Automatic cross-provider memory-use measurement needs its own bounded
canary task; these source fixes do not establish that result.

## Review material

Latest comparable demos: [three layouts](../../design/successor-layouts/index.html).
Earlier visual direction: [Ember Studio](../../design/paneforge-directions/studio.html).
Both are local prototypes, not connected agent execution.

## Verification and rollout

Implementation checkpoint, not a completion receipt. Mac checks passed in the
implementation session; GitHub CI exposed a machine-specific test import that
still needs correction. PC verification and the final verification receipt remain
pending. No production app release is part of this task.
