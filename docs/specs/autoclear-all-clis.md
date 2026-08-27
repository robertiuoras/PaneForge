# Auto-clear for every CLI kind (claude, codex, antigravity) + promptless cost clears

Date: 2026-08-27. Owner: Robert (approved: "make sure that it can auto clear and continue
itself within paneforge ... work flawlessly with antigravity cli, claude or codex sessions").

## Context (verified facts, do not re-derive)

- The claude path exists: Stop hook `claude-config/autoclear.mjs` decides, `pane-clear.mjs`
  calls the `autoclear:ask` channel, `SessionManager.armAutoClear` (src/main/sessions.ts)
  draws a countdown, queues asks that arrive mid-turn (`autoClearPending`), and types
  `clearChunks(prompt)` from `src/shared/autoclear.ts`.
- The hook side has JUST been changed (already committed in claude-memory, do not edit it):
  - `paneChunks('')` → `['/clear\r']` (promptless), threshold now 150k.
  - A handoff with no actionable Next steps now CLEARS promptlessly (`noResume: true` in the
    `autoclear:ask` payload) instead of idling. Measured 2026-08-26: `no_open_steps` was the
    dominant log line, sessions idling at 185-235k tokens of pure cache-read cost.
- Codex CLI (`codex-cli 0.149.1`): per-session rollout at
  `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl`. JSONL `event_msg` rows with
  `payload.type:"token_count"` carry `payload.info.total_token_usage.{input_tokens,
  cached_input_tokens,...}` and `payload.info.model_context_window`. The first line of a
  rollout is session meta — VERIFY on a real file whether it records `cwd` (expected; use it
  to map pane→rollout). In-CLI `/new` starts a fresh conversation (alias family includes
  `/clear`), `/compact` compacts. Typed pty input works like Claude Code.
- Antigravity CLI (1.1.19): state under `~/.gemini/antigravity-cli/`. NO token fields in its
  transcript files. Context stats arrive ONLY as JSON on stdin to the user's statusline hook
  `~/.gemini/antigravity-cli/statusline.sh`: fields `.context_window.context_window_size`,
  `.context_window.used_percentage`, `.context_window.total_input_tokens`,
  `.context_window.current_usage.{input_tokens,cache_creation_input_tokens,cache_read_input_tokens}`.
  `/clear` is confirmed real (used on this machine). `/compact` does NOT exist (issue #40).

## Build

### 1. shared/autoclear.ts
- `AutoClearAsk` gains `noResume?: boolean`. `readAsk` accepts an EMPTY prompt only when
  `noResume === true` (payload `noResume` must be boolean true; anything else → old rule).
  When `noResume`, `steps` is forced to `[]`.
- `clearChunks(prompt, command = '/clear')`: empty/blank prompt → `[command + '\r']`; else
  `[command + '\r', prompt, '\r']`. Keep the paste-threshold comment; the hook's `paneChunks`
  must stay chunk-for-chunk equal on the claude path (`npm run test:autoclear` pins it).
- `export function clearCommandFor(agent: string): string | null` — `'claude'`-family →
  `/clear`, codex → `/new`, antigravity → `/clear`, unknown → null (never type into a CLI we
  cannot name). Match against the pane `agent` values PaneForge actually stores (check
  `src/shared/types.ts` / where `meta.agent` is set; handle shells returning null).

### 2. sessions.ts
- `armAutoClear` ask gains `noResume` + optional `command`; store `s.meta.autoClearChunks =
  clearChunks(ask.prompt, command)` at arm time and have the timer type THOSE chunks instead
  of recomputing from `autoClearPrompt`. Keep every existing drop/queue rule unchanged.
- Countdown card copy: when `noResume`, the card should read as a cost clear ("nothing open —
  clearing to free ~Nk context") rather than "continuing next steps". Find where the card
  renders (renderer reads `autoClearAt`/`autoClearSteps`) and pass enough meta for that copy;
  keep it minimal.

### 3. NEW src/main/autoclearWatch.ts — pane-side watcher (the codex/antigravity path, and a
belt-and-braces for claude panes whose Stop hook is not installed)
- Every 60s: for each live pane where `clearCommandFor(agent)` is non-null and the pane is
  NOT mid-turn (`status !== 'working'`), estimate context tokens:
  - claude: skip — the Stop hook owns claude panes; only act if env
    `PF_AUTOCLEAR_CLAUDE_WATCH=1` (default off, avoids double-driving).
  - codex: newest rollout file whose session-meta cwd == pane cwd and mtime >= pane
    openedAt; last `token_count` event; context = `total_token_usage.input_tokens +
    total_token_usage.cached_input_tokens` of the LAST event (verify against a real file that
    this tracks context, not cumulative billing; if it is cumulative, use
    `last_token_usage.input_tokens + cached_input_tokens` — pick whichever matches
    `model_context_window` scale and document which).
  - antigravity: read `~/.gemini/antigravity-cli/pf-context.jsonl` (see §4), newest row;
    tokens = `.context_window.total_input_tokens` (fallback: used_percentage ×
    context_window_size). If more than one antigravity pane is open, attribute by the row's
    cwd field if present, else SKIP with one console.info (never guess between two panes).
- Over threshold (config `autoClear.tokens`, default 150_000) → `armAutoClear(id, { steps:
  [], prompt: '', seconds: config seconds, noResume: true, command: clearCommandFor(agent) })`.
  One arm attempt per pane per 30 min (reuse the queue/drop machinery; do not spam).
- Wire in main/index.ts next to the other interval services; clean shutdown.

### 4. Antigravity statusline bridge
- `scripts/antigravity-bridge.mjs` (repo scripts/): idempotently ensures
  `~/.gemini/antigravity-cli/statusline.sh` FIRST tees its stdin to
  `~/.gemini/antigravity-cli/pf-context.jsonl` (append `{ts, ...parsed}` one line, keep last
  200 lines, never break the script's original output). If no statusline.sh exists, create a
  minimal one that echoes nothing but writes the file. Back up the original once
  (`statusline.sh.pf-backup`). The watcher calls this ensure() at app start (main process,
  darwin+win32 guard: antigravity path exists only where installed).

### 5. Config (src/main/config.ts)
- `autoClear: { tokens: 150000, seconds: 15, watchNonClaude: true }` with the usual
  defaulting/merge shape the file already uses. Watcher reads it; `watchNonClaude: false`
  disables §3 entirely.

### 6. Tests
- Extend `scripts/autoclear-test.mjs`: promptless equality (hook `paneChunks('')` ===
  app `clearChunks('')`), `readAsk` noResume acceptance + refusals, `clearCommandFor`
  mapping, and a pure-function test for the watcher's decision (extract `watchDecision({agent,
  status, tokens, threshold, lastArmMs, now})` so it tests without I/O).
- `npm run typecheck` clean, `npm test` green, `npm run test:autoclear` green.

## Verify (all three, report numbers)
1. `npm run typecheck && npm test && npm run test:autoclear` — exit codes.
2. Feed a REAL codex rollout file from ~/.codex/sessions through the codex estimator and
   print the tokens it reads vs the file's last token_count values.
3. Run the antigravity bridge ensure() against a COPY of statusline.sh in /tmp, prove
   idempotency (run twice, identical file) and that piped JSON lands in pf-context.jsonl.

## Do NOT
- Do not edit anything under claude-config (already done).
- Do not release/bump version — commit only (`.lanes.json` release policy is merge; Robert
  tests in dev window first).
- Do not type into any live pane while testing.
