# Next supervisor integration checkpoint

`server/index.mjs` imports the coherent supervisor closure from `paneforge-next` source `main0af0748`: projects and lanes, durable sessions, SSE, terminal and PC routes, voice transport, workspace actions, and guarded Code execution.

## Runtime contract

- `scripts/start.mjs` serves the owned bundle on loopback port `4321` by default. `PANEFORGE_DATA_DIR` isolates durable state and `PANEFORGE_DIST_DIR` selects the bundle.
- `GET /api/health` returns `{product:"paneforge-next",revision,dataDir}`. Startup remains lazy: state works with zero sessions and does not start a provider, CLI, terminal, PC work, or recovery.
- Registered projects default from `PANEFORGE_PROJECTS_ROOT` or the user's `~/Projects`, never the packaged runtime directory. The fixture MCP reads its harmless packaged fixture from `server/fixtures/research.txt`.

## Conversation, review, and execution

- Reviews persist as `{reviews,persistent:true}`, retain original user text separately from forged prompt text, durable request identity, native identity, and observed lane. They select final output only from the completed matching turn.
- A retained final outcome is an informational claimed result. Missing output remains unverified. Blocked and decision reviews remain attention items. Review acknowledgement or receipt only parks an informational session with no other unread result, blocked, or decision record.
- Review reply requires an exact native identity, refreshes live Codex routing, and uses the normal forge policy. Report/link open validates its target and only reports `opened:true` after the OS opener starts successfully.
- Chat turns and Review replies share the same dispatcher: explicit build replies enter PC Code, while explanations remain Chat. Both paths reject active PC work, pending Code startup, Mac CLI ownership and reconciliation, and input locks. They recheck ownership after asynchronous provider preflight. PC Review replies instead retain their separate remote identity and resume that PC executor.
- Explicit build verbs dispatch through the guarded PC Code route using the saved live-selected model and effort. Chat remains restricted. Active Chat, Mac CLI, PC Code work, renewal, and provisional Code startup are mutually fenced, including restart-conservative PC jobs.
- Direct requests also recognize polite prefixes such as "can you build", "could you please fix", and "I want you to create". Questions asking for explanations, leading negations, quoted commands, and bare verbs stay in Chat. This is bounded phrase recognition, not evidence of general semantic intent classification or a completed real build.
- Mac CLI first releases the App Server lease for the exact native Codex identity, then resumes it with the saved model and effort. On terminal exit, the supervisor reconnects and refreshes that exact thread before Chat input is accepted. A launch failure reacquires the thread rather than leaving the conversation fenced.

## Verification

- `node --test tests/*.test.mjs`: **102 passing** after CLI continuity and migration-integrity checks.
- Isolated server on port `4333`, temporary data profile: `/api/health` and `/api/state` returned cleanly before any session or CLI startup.
- Bounded included-plan Codex journey: live preflight selected `gpt-5.6-sol` at `low`; a read-only first turn completed and stored the exact original prompt plus a claimed final review. A review follow-up was accepted and completed on the same native conversation ID. After restart on the same profile, the idle session and both durable reviews remained present. The receipt was redacted to IDs, status, model/effort, and review counts. A separate headless Chat to Mac CLI to Chat probe selected `gpt-5.6-luna` at `medium`: the first Chat turn, `codex exec resume` on its exact native identity, transcript reconciliation, and final Chat turn all completed, with seven reconciled items. Its temporary native ID is retained only in the local redacted execution receipt.
- Remote PC browser verification was performed by the root worker only: 20 desktop and 20 compact fixture checks passed, plus Review checks. No local browser was used.

## PC execution proof and remaining gap

PC completed requests now retain their original prompt, matching final agent output, and exact remote native identity in the terminal journal. The supervisor captures each completed request into a durable Review card and recovers missing cards after restart. Cards retain the logical conversation ID separately from the PC native ID. Replies to these cards resume the exact PC executor even when the reply is an explanation request; both dispatcher and terminal validate the binding. Capture is idempotent after a conversation rename, and missing final output stays unverified and cannot silently park the session. Existing GuardDeck delivery receives these result records. An isolated supervisor HTTP probe recovered a saved PC result with its remote identity; notifications were disabled for the probe (`/tmp/next-pc-review-recovery.log`). Independent diff review found no blocking issues.

Verification: 135 Next unit tests, TypeScript/Vite build, and minimized parent dev-b build/launch passed. The new lifecycle regression covers completed output, restart recovery, one notification callback, unchanged local native identity, wrong-native rejection, and exact remote resume. This is isolated fixture evidence; installed PC build-to-notification-to-reply acceptance remains unverified. Logs: `/tmp/next-pc-review-unit.log`, `/tmp/next-pc-review-build.log`, `/tmp/next-pc-review-try.log`.

Review report/link and indexed vault opening now select the host opener instead of unconditionally invoking macOS `/usr/bin/open`. Windows uses an encoded PowerShell command with a separately base64-encoded UTF-8 target, without `cmd` expansion or target interpolation into a PowerShell literal. Three command-boundary regressions passed; actual PC PowerShell preserved both a quote-containing file path and a metacharacter-containing URL with `Start-Process` stubbed. Receipt: `/tmp/next-open-target-pc-proof.json`. No window was opened: installed Windows report opening remains unverified.

The polite-request dispatch correction passed all 124 Next unit tests, TypeScript/Vite build, and the required minimized parent dev-b build/launch after independent review. Review cases cover help/ability phrasing, negated tasks and punctuation-only tails. Logs: `/tmp/next-polite-routing-reviewed-unit.log`, `/tmp/next-polite-routing-reviewed-build.log`, `/tmp/next-polite-routing-reviewed-try.log`. The terminal reconciliation fixture now drains its journal before deleting its temporary directory; the full suite had exposed an asynchronous ENOENT during cleanup. No browser was launched locally. These checks do not prove that a substantive user build completes through the installed app.

A real guarded PC Code request completed on DESKTOP-CMSUCM1 using included-plan Codex `gpt-5.6-luna` / `medium`. Exact native thread `01a0bfba-bec3-7170-be87-d89f0175b6ad` recorded `task_complete` and the requested final response `PC_CODE_OK` after reading an isolated non-client fixture. The runner removed API credentials and forced ChatGPT login. Root read retained redacted receipt `/tmp/paneforge-next-pc-code-proof-receipt-20260921.json`; no duplicate job was launched. This proves bounded remote dispatch, routing and native completion, not a substantive build, sustained transport reliability, or installed native-app acceptance. Remote rendering has separate PC fixture evidence.

## Saved-profile startup and Windows Unicode report targets

Startup and terminal launch no longer require the prototype `paneforge-next` project when a conversation belongs to another connected project. Legacy adoption remains limited to the exact canonical checkout when present. An isolated HTTP regression reopens saved conversations without a prototype project, preserves their native IDs and unassigned legacy metadata, and verifies the terminal project mismatch still returns 409. This regression failed against the previous implementation.

PowerShell treats curly apostrophes as string delimiters, so escaping ASCII apostrophes alone was insufficient. A parser check on DESKTOP-CMSUCM1 reproduced the failure; the corrected opener encodes the target independently as UTF-8 data. Actual PC PowerShell with `Start-Process` stubbed preserved a path containing curly apostrophes, ampersand and Japanese characters exactly (`/tmp/next-windows-opener-literal-proof.log`). No browser or native window was opened for this check.

Verification: 136 Next tests passed, PC workspace browser checks passed at desktop and compact sizes (20 each, zero console errors), TypeScript/Vite build passed, and minimized parent dev-b build/launch completed. Logs: `/tmp/next-profile-unit.log`, `/tmp/next-profile-build.log`, `/tmp/next-profile-try.log`. Installed notification and native-app acceptance remain outstanding.

## Real supervisor event stream regression

A real HTTP build-to-review probe exposed an undeclared `match` variable in the imported-history GET matcher. Because the matcher runs before `/api/events`, that endpoint returned HTTP 400 (`match is not defined`) instead of the state stream. The request-scoped declaration is now shared by the GET and mutation routes. The isolated supervisor regression checks imported-history 404 and an actual HTTP 200 `text/event-stream` initial state event; it failed before the repair and passes after. All 136 Next tests, TypeScript/Vite build and minimized dev-b launch passed (`/tmp/next-stream-unit.log`, `/tmp/next-stream-build.log`, `/tmp/next-stream-try.log`).

The first live build probe stopped its own job after the stream failure and retained a remote exit-130 cancellation receipt. A second probe verified the repaired stream but could not prepare the PC checkout: SSH reset the authenticated connection, and a separate hostname probe failed likewise. No build-completion or review-reply acceptance is claimed. Retained receipt: `/tmp/next-real-build-journey-receipt.json`. This is a transport blocker, not permission to run on the Mac.

## Structured PC execution prompts

PC Code turns now apply the shared structured prompt composer before preparing a remote checkout. Original requests remain unchanged in the durable journal and review cards; execution prompts include the completion criteria and PC-only rendering boundary. Oversized composed prompts fail before remote preparation instead of losing requirements. Duplicate request IDs retain their existing receipt, and review replies preserve the exact remote native identity.

Verification: all 136 Next tests, TypeScript/Vite build and minimized dev-b build/launch passed (`/tmp/next-pc-prompt-unit.log`, `/tmp/next-pc-prompt-build.log`, `/tmp/next-pc-prompt-try.log`). Regression assertions cover composition, original-text retention, oversized input without remote side effects, deduplication and exact-native continuation. Live PC acceptance remains blocked by authenticated SSH connection resets. No local rendering fallback was used.

## PC preparation failure recovery

A failed checkout preparation previously left a journaled terminal without job metadata. A later attempt misclassified it as a legacy interactive PC conversation and refused to continue. Preparation now finishes before publishing the terminal, and the first journal record includes its job metadata. No provider turn starts during preparation. The regression reproduces the prior phantom terminal, then verifies failure leaves no terminal, restart preserves that state, and a new attempt starts exactly one provider job. Existing legacy interactive and uncertain-job fences remain intact. This prevents new phantom entries; it does not rewrite earlier terminal journals.

All 137 Next tests, TypeScript/Vite build and minimized dev-b build/launch passed (`/tmp/next-prepare-recovery-unit.log`, `/tmp/next-prepare-recovery-build.log`, `/tmp/next-prepare-recovery-try.log`). This is isolated lifecycle proof, not a live PC transport repair or installed acceptance.
