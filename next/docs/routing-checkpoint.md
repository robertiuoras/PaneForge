# Routing checkpoint

Observed locally on 2026-09-21: `codex-cli 0.155.1`; `account/read` returned
`account.type: chatgpt` and `planType: pro`. `model/list` returned `data` model rows
with `id`, `defaultReasoningEffort`, and `supportedReasoningEfforts[].reasoningEffort`.
`account/rateLimits/read` returned `ordinaryUsageAllowed`, `rateLimits`, including
`spendControlReached` and `rateLimitReachedType`.

The router accepts only those observed fields. It defers provider start until an explicit
session creation or turn, selects only current catalogue values, and refuses unknown or
unavailable included usage while preserving the submitted draft at the client. It has no
API-key or credit fallback. Prompt composition is a portable generated copy of the shared
pure function, pinned to its source SHA-256 for builds that have the source checkout.

Build prompts explicitly require browser and video rendering through the established PC
`rbuild`/SSH path, including a PC-availability check and actual remote-result evidence.
