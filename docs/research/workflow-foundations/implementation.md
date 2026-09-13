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

Reconciled on 13 September 2026. The original Linux CI failure and subsequent
Windows fixture failure are resolved; no production app release is part of this task.

- The original failure was a hard-coded Mac import and executable path in
  `promptlab/outcome-join.test.mjs`. The existing portable fix derives both from
  the test module. It was already published by another workflow session; the
  stale Mac copy was aligned rather than inventing a second implementation.
- Fresh native Windows verification found `cwd_and_backend_keys_are_not_inherited`
  inspected the PowerShell wrapper arguments instead of the wrapped Codex arguments.
  Reusing the existing `underlying_argv` helper fixes the fixture without changing
  the subscription runner or weakening the credential-isolation assertions.
- Published shared-source commit: `84fdff21211018108e7b86dddf3f7250508fa5f5`.
  [GitHub compatibility run 34754726375](https://github.com/robertiuoras/claude-memory/actions/runs/34754726375)
  passed both `handoff-contract` on Linux and the new `windows-research-contract`.
  The latter now exercises the native Windows wrapper offline on every matching
  push/PR. This is a working CI improvement, not a proposed schedule.
- Mac: all ten command groups in the compatibility/repair verification passed on
  an isolated checkout at `a25dbbdbb`; the changed research fixture was rerun and
  passed after the Windows correction. The installed Mac outcome test also passed.
- Native PC: provider handoff tests passed, followed by research, prompt library,
  hook receipts, both nudges, outcome attribution, craft and vault tests. The vault
  suite reports 43 passing tests. Python checks used the already-installed Python
  3.12 executable because `python` in SSH resolved to the Windows Store alias.
  No Python installation or global PATH change was needed for these checks.
- The PC fast-forwarded to the published commit and the test's Git blob was verified
  against that commit. Mac local alignment commits are `802820e52` and `0ecccf1d2`;
  unrelated dirty files and divergent shared-repo history were preserved. This
  reconciliation does not claim the entire Mac shared checkout is synchronized.

The checks are offline fixtures and bounded local process tests, with no paid model
calls. They establish repair regression coverage, not real subscription login,
perfect second-brain retrieval, full Windows app parity or an autonomous improvement
system. The next connected Mac slice still needs a real subscription qualification
and end-to-end task/recovery evidence.
