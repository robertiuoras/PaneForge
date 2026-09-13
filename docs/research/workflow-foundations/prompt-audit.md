# Promptlib and Promptlab workflow audit

Checked 2026-09-13. Scope was `claude-config/promptlib`, `promptlab`, and the live hook entrypoints. This excludes the separately assigned instruction-debt F01-F18 and provider-handoff repair work. The three present tests passed: `promptlib.test.mjs` (25 checks, plus a 3/306 replay fire rate), `promptlab/outcome-join.test.mjs`, and `craft.test.py`.

## 1. A craft can finish as “clean” while worsening the only measured objective

**Evidence.** [`craft.py:513-548`](/Users/robertiuoras/Projects/claude-memory/claude-config/promptlab/craft.py:513) recomputes the cost score after every rewrite, but [`craft.py:521-546`](/Users/robertiuoras/Projects/claude-memory/claude-config/promptlab/craft.py:521) stops solely when the structural critic is empty or repeats. It never rejects or rolls back a draft whose `cost_prob` rose. The final output prints the before/after number at [`craft.py:622-626`](/Users/robertiuoras/Projects/claude-memory/claude-config/promptlab/craft.py:622), which makes an increase visible but does not prevent calling that output a finished craft. The README describes the loop as `draft -> score -> diagnose -> lint -> redraft` and says it stops once there is no structural diagnostic.

**Why it matters.** The system’s documented measurable claim is reducing the chance of a monster turn. A structurally valid rewrite can add wording that raises that score. The current loop would log and hand it to a pane anyway, so it cannot establish that crafting improved even its narrow, cost-only proxy.

**Coverage gap.** `craft.test.py` tests `critique_draft` in isolation at [`craft.test.py:51-66`](/Users/robertiuoras/Projects/claude-memory/claude-config/promptlab/craft.test.py:51); it has no mocked two-round `craft()` test where the model returns a clean but higher-risk draft.

**Safest repair.** Keep both score values, add an explicit outcome status such as `improved-proxy`, `unchanged-proxy`, or `regressed-proxy`, and by default return the lower-risk draft when both are structurally acceptable. Do not claim quality improvement from this: the score predicts cost only. Add a pure mocked test covering clean/higher, clean/lower, and unresolved cases.

## 2. Outcome receipts are not unique per craft and can falsely credit a previous craft

**Evidence.** Each craft log ID is deterministic from `kind:intent` at [`craft.py:567-575`](/Users/robertiuoras/Projects/claude-memory/claude-config/promptlab/craft.py:567), while open events only carry `draft_sha1` at [`craft.py:611-616`](/Users/robertiuoras/Projects/claude-memory/claude-config/promptlab/craft.py:611). The outcome join indexes pane receipts by that short draft hash and prompt history by the full prompt fingerprint at [`craft-outcome.mjs:68-103`](/Users/robertiuoras/Projects/claude-memory/claude-config/promptlab/craft-outcome.mjs:68). Thus two crafts producing the same text share the same “sent”, commit, and verification receipt. The test uses one craft and one prompt only at [`outcome-join.test.mjs:34-67`](/Users/robertiuoras/Projects/claude-memory/claude-config/promptlab/outcome-join.test.mjs:34).

**Why it matters.** A later reuse of an identical draft can make an earlier, never-sent craft look sent, shipped, and verified. That invalidates any future comparison of crafted prompts with alternatives. It also means the current report measures prompt-text reuse, not an individual craft attempt.

**Safest repair.** Give every craft invocation a random `craft_run_id`; write it into the base record and `opened` event. On `--open`, persist the resulting pane/session ID as the receipt key. For manually pasted prompts, show `unattributed text match` rather than a per-craft completion claim. Add a fixture with two identical drafts, one opened and one not, which must leave the unopened craft unverified.

## 3. Production hook failures become indistinguishable from a deliberate no-op

**Evidence.** The promptlib hook silently returns on invalid input at [`promptlib-nudge.mjs:165-177`](/Users/robertiuoras/Projects/claude-memory/claude-config/promptlib-nudge.mjs:165), suppresses state and receipt write failures at [`promptlib-nudge.mjs:69-80`](/Users/robertiuoras/Projects/claude-memory/claude-config/promptlib-nudge.mjs:69) and [`promptlib-nudge.mjs:204-222`](/Users/robertiuoras/Projects/claude-memory/claude-config/promptlib-nudge.mjs:204), then swallows every unhandled error at [`promptlib-nudge.mjs:227-233`](/Users/robertiuoras/Projects/claude-memory/claude-config/promptlib-nudge.mjs:227). Promptlab does the same at [`promptlab-nudge.mjs:76-82`](/Users/robertiuoras/Projects/claude-memory/claude-config/promptlab-nudge.mjs:76) and [`promptlab-nudge.mjs:155-160`](/Users/robertiuoras/Projects/claude-memory/claude-config/promptlab-nudge.mjs:155). Neither record contains a version/model/template-library digest for successful fires.

**Why it matters.** If imports, the model file, filesystem, or log storage break, the hooks emit nothing, the same result expected for most prompts. The live outcome data can then appear simply sparse, while no receipt shows whether the policy ran. That defeats the stated aim of detecting stale or weak prompt behaviour.

**Coverage gap.** `promptlib.test.mjs` directly calls `decide()` rather than exercising malformed hook input, missing module/model file, or unwritable receipt storage. `promptlab-nudge.test.mjs` checks routing thresholds, not an observable failure receipt.

**Safest repair.** Keep hooks non-blocking, but append a bounded, redacted failure receipt outside the user prompt stream: hook name, stage, error class, config/model digest, timestamp, and session ID. Add a rate limit to prevent repeated failure spam. Tests should simulate missing `model.json`, an import error, malformed input, and an unwritable log, then assert one diagnostic receipt and no injected context.

## What the current checks do prove

The tests do prove template parsing/matching, current low replay fire rate, structural critique helpers, and the happy-path craft-to-prompt-to-verify join. They do **not** prove a crafted prompt is better than the original, nor that individual craft receipts remain attributable when drafts repeat, nor that a live hook actually ran when it produces no user-visible text.

The lowest-risk order is: first add failure receipts and unique run IDs, then add the proxy-regression guard. Only after sufficient uniquely attributed runs should the product make a comparative effectiveness claim.
