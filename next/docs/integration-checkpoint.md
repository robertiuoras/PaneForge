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
- Explicit build verbs dispatch through the guarded PC Code route using the saved live-selected model and effort. Chat remains restricted. Active Chat, Mac CLI, PC Code work, renewal, and provisional Code startup are mutually fenced, including restart-conservative PC jobs.
- Mac CLI first releases the App Server lease for the exact native Codex identity, then resumes it with the saved model and effort. On terminal exit, the supervisor reconnects and refreshes that exact thread before Chat input is accepted. A launch failure reacquires the thread rather than leaving the conversation fenced.

## Verification

- `node --test tests/*.test.mjs`: **102 passing** after CLI continuity and migration-integrity checks.
- Isolated server on port `4333`, temporary data profile: `/api/health` and `/api/state` returned cleanly before any session or CLI startup.
- Bounded included-plan Codex journey: live preflight selected `gpt-5.6-sol` at `low`; a read-only first turn completed and stored the exact original prompt plus a claimed final review. A review follow-up was accepted and completed on the same native conversation ID. After restart on the same profile, the idle session and both durable reviews remained present. The receipt was redacted to IDs, status, model/effort, and review counts. A separate headless Chat to Mac CLI to Chat probe selected `gpt-5.6-luna` at `medium`: the first Chat turn, `codex exec resume` on its exact native identity, transcript reconciliation, and final Chat turn all completed, with seven reconciled items. Its temporary native ID is retained only in the local redacted execution receipt.
- Remote PC browser verification was performed by the root worker only: 20 desktop and 20 compact fixture checks passed, plus Review checks. No local browser was used.

## PC execution proof and remaining gap

A real guarded PC Code request completed on DESKTOP-CMSUCM1 using included-plan Codex `gpt-5.6-luna` / `medium`. Exact native thread `01a0bfba-bec3-7170-be87-d89f0175b6ad` recorded `task_complete` and the requested final response `PC_CODE_OK` after reading an isolated non-client fixture. The runner removed API credentials and forced ChatGPT login. Root read retained redacted receipt `/tmp/paneforge-next-pc-code-proof-receipt-20260921.json`; no duplicate job was launched. This proves bounded remote dispatch, routing and native completion, not a substantive build, sustained transport reliability, or installed native-app acceptance. Remote rendering has separate PC fixture evidence.
