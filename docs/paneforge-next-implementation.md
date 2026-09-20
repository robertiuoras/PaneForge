# PaneForge Next: Stage 1 checkpoint

Accepted contract: [voice-first contract](paneforge-next-voice-first-contract.md), all 479 lines read on 2026-09-20. Robert narrowed this task to **Stage 1 only**. The requested milestone is complete at fixture level; stop here.

## Ownership and scope

- Pane `s16-mu9f6fdf`; native Codex conversation `01a0bd72-282f-7040-8520-c4eccb43033e`.
- Assigned checkout `/Users/robertiuoras/Projects/PaneForge-b`, branch `lane-b`.
- No model or effort override requested by this task. Native `turn_context` confirmed `gpt-6-astra` / `xhigh` for the implementation session.
- `next/` is a separate React/TypeScript fixture preview. It does not replace current PaneForge or run a new supervisor. Its retained renderer/voice foundation came from prototype commit `0af0748c0978797463a631ef6cbb79d053626381`.
- All changes are reversible and confined to new `next/` files and these two checkpoint documents. Existing PaneForge source, sessions, provider authentication and stored data are unchanged.
- Pre-scope-narrowing backend, migration and host experiments are retained only under ignored `next/.local/deferred-pre-stage1/`. They are not part of this milestone and must not be resumed without new scope.
- Release batch `PF-20260920-01` authorizes finishing checks, a lane commit and the supplied lane-ready command. The batch owner cuts the dev release. This session must not cut a release or modify lane C.

## Completed checklist

- [x] Verify pane, assigned cwd, native conversation, actual model and confirmed effort; initial lane worktree clean.
- [x] Build a distinct Live rail, objective-grouped agent field, selected-agent timeline and identity/evidence inspector.
- [x] Keep raw-terminal takeover collapsed, load it on demand, replay the existing terminal and require explicit control ownership before input.
- [x] Keep typed global control alongside Live; both enter the existing controller interaction path. Label the preview and simulated voice honestly.
- [x] Reuse existing supervisor state, event, session, turn, stop, resume, steer, approval, terminal and workspace-ack routes. Add no replacement supervisor to the product.
- [x] Preserve separate workspace/native IDs, cwd, project, lane, model/effort requests and confirmations, permissions and existing session data in the renderer projection. Never promote proof because execution ended.
- [x] Retain drafts and selection across reload/reconnect; keep rejected creation briefs visible under the exact created identity without retrying creation.
- [x] Use neutral surfaces, compact controls, visible focus and one live-state accent; support reduced motion and compact desktop dimensions.
- [x] Pass 17 headless checks at 1440×1000 and 17 at 900×800. Clean flows have no console or uncaught page errors. Separate fault injection captures one expected HTTP 409 console entry per size.
- [x] Build/type-check the preview; verify current PaneForge opens from this lane using actual profile `dev-b`, then close only that test copy.
- [x] Save four review images, interaction report, rollback smoke result, build/test output and tested source hashes under `next/evidence/stage1/`.

Commit identity and lane-ready outcome belong in the batch receipt after the commit, avoiding a circular commit hash in tracked evidence. See [evidence and exact commands](paneforge-next-evidence.md).

## Resume boundary

Do not advance to Stages 2–7. No real GPT Live speech, real provider dispatch, durable idempotency/restart recovery, migration, installed Tauri host, Windows runtime or battery result is proven by this checkpoint. Those remain separate gated work.

For review, read `next/README.md` and the evidence log, inspect `git status`, then run `npm ci --ignore-scripts --no-audit --no-fund`, `npm run build` and `npm test` in `next/`. The headless test requires installed Google Chrome and owns an isolated browser context and fixture server. `npm run dev` serves only the built fixture preview on loopback. Do not point it at real session data.
