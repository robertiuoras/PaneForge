# PaneForge

Electron desktop app: one window of real terminal panes, each running a coding agent CLI or a
shell. `package.json` `name` is `claude-orchestrator` on purpose (see Gotchas).

**Short form, loaded every turn. Cap 12,000 tokens for this file + `CLAUDE.md`
(`npm run test:claudemd`). A rule, never its history.** Why: `docs/design-notes.md`, same headings.
Verbatim long forms: `docs/claude-md-full-2026-08-31.md`, `docs/claude-md-full-2026-09-19.md` (every story
cut on 2026-09-19). **Read the matching section there BEFORE CHANGING the thing.** Never re-derive
a recorded decision. A section too long for this file moves verbatim to `docs/agents/<topic>.md`,
linked below. `test:x` = `npm run test:x`. Paths: `shared/` = `src/shared/`, `main/` =
`src/main/`, `*.tsx` components = `src/renderer/src/components/`.

## Rules by topic (read when you touch that area)

- `docs/agents/lanes-and-releases.md`: read when touching `scripts/lane.mjs`, claims/peers, the
  dev-window tour, a version release, the updater, Windows install/feed, or why the app quit.
- `docs/agents/remote-and-phone.md`: read when touching `src/main/remote/`, pairing, remote
  login, offload, screen streaming, the phone/web surface, `pf-ctl`, or touch layout.
- `docs/agents/pane-lifecycle.md`: read when touching prompt sending, restore/scrollback,
  `/clear`, booting, pane width, recovery, auto-close into Review, autoclear, keep-awake, stale
  frames, render watchdog, fault notices.
- `docs/agents/questions-and-agents.md`: read when touching question cards, auto-answer, render
  cost, providers/models, split prompts, `promptForge`, task briefs, interventions.
- `docs/agents/capacity.md`: read when touching usage sampling, shell/agent jobs, strays, dev
  servers, the mascot, reclaim/trim/sleep, or auto-handoff.
- `docs/agents/ui.md`: read when touching theme/contrast, pane names, clocks, the sessions list,
  rail tags, find, settings search, menus, copy, cursor clicks, attach, history, prompt archive,
  dictation, corner cards, activity, tips, or the what's-new card.

## Never close the app you are running inside

Installed `PaneForge` hosts this session: never `npm run setup`, `Stop-Process PaneForge`,
NSIS installer. Copies: `npm run try` (profile via `src/main/profile.ts`: own userData, lock,
config, taskbar; minimized, no focus), `-- --show`, `-- --close`. A `dist/` app hand-opened
with no profile opens `/Applications/PaneForge.app` and quits, whichever newer
(`shared/strayLaunch.ts`, `test:straylaunch`); headless refused; no installed app = left alone.

## Lanes: more than one chat works on this repo

Each chat holds `main` (master) or worktree `PaneForge-a/-b/-c` on `lane-a/-b/-c`; write only
there. `node scripts/lane.mjs status --repo <dir>`. ONE PANE, ONE LANE. Never leave one
conflicted. Same region as another lane's change: message that chat first. The lane hooks that
assign and enforce this are Claude Code hooks (`src/main/laneHooks.ts`); any other agent checks
`status` itself. Full rules: `docs/agents/lanes-and-releases.md`.

## Releasing happens when Robert asks, and not before

`"release": "merge"`: merge to master, push, no version. End of work: build, prove in a copy
(`npm run try -- --keep --remote-debugging-port=9444`, `npm run probe`), report numbers,
stop. `npm run typecheck`/`npm test` gate a commit. `node scripts/lane.mjs ready --repo <dir>
--session <id>` merges master in, refuses dirty. `npm run ship` ONLY when Robert asks.
Dev-window test on both machines first: `npm run try -- --pull --show`.

**NO RELEASE WITHOUT ROBERT'S WORD IN THIS CHAT.** `npm run unreleased` exit 1 is a REPORT;
another chat's release is not yours; yesterday's word is not today's (`test:unreleased`).
Never cut one while a next step is open. Tour, `--show` window, `"release": "version"`,
`npm run release` guard: `docs/agents/lanes-and-releases.md`.

## Never take the screen

Only a click or hotkey earns the foreground. `showInactive()`; `focusWindow()` user-initiated.
`revealPlan()` (`src/main/profile.ts`); self-restart `markQuietRelaunch()`, taskbar flash. No
`dialog.showMessageBox` (`UpdateToast.tsx`), `setAlwaysOnTop`, `moveTop`, `app.focus`.
`spawn`/`Start-Process` `windowsHide: true` (`run-hidden.vbs` on PC). `second-instance` never
raises while `installStarted`. `gameMode.ts` delays, never loses. `test:quiet`.

## Every word on screen is read by somebody who has never used git

lane/checkout/trunk/worktree/slot/merge/conflict/free/stuck stay in code. `copy 2` (folder 1,
lane `a` 2, `w2` 2) never `copy f`; `main copy`; `nobody is using it`.
`copyNumber` (`place.ts`) is the one slot->number. Non-pane chat named via
`LaneBoardEntry.chatTitle` (`lanes:board`, `main/history.ts` `chatNameFor`); no name = nothing
drawn.

## Checks

On the PC in one command: `node scripts/pc-check.mjs typecheck <suite...>` (rbuild, retries,
failures + totals only). `npm run typecheck`, `npm test` (`scripts/test-all.mjs`, no
window/network/CLI; `node scripts/test-all.mjs <name...>` runs a subset). Off Windows it runs
on the PC via `scripts/test-remote.mjs`; exit 3 `Tests deferred:` = PC unreachable, no local
fallback, not a pass. Pins:
`docs/design-notes.md` **Checks — what each suite pins**. Window (`test:x`): autoclearlag,
view, restorefix, askclick, askrender, devicesfit, phoneview, contrast, renderwatchlive,
panefit, railtrack. Network: `test:discordbrand`,
`node scripts/mac-update-test.mjs --live <v>`. `npm run competitors` (`test:competitors`).

## Checking a layout change without screenshots

`--headless` (`headlessMode`) paints offscreen; `scripts/ui-lab.mjs` is the CDP helper for
every window suite:

```
npm run build # --keep skips, else stale build
npm run try -- --headless --remote-debugging-port=9444 # not 9333: Chrome Automation's port
node scripts/ui-lab.mjs eval "<js, awaitPromise>"
node scripts/ui-lab.mjs shot --out /tmp/x.png --selector .dialog --width 1280 --height 560
npm run try -- --close
```

Same answer before/after = nothing rebuilt. Second lane `PF_PORT=9445`. `shot --width/--height`
= device metrics; `window.__pf[sessionId]`. `test:uilab` uses
`window.api.appVisibleNow()`, not `document.visibilityState`.

## Gotchas that look like mistakes

`package.json` `description` = "PaneForge" (exe FileDescription); `name` stays
`claude-orchestrator` (`%APPDATA%\<name>`). Icon `node scripts/make-icon.mjs` (`--size N --out
path`), no blob. Badge `git status` async (`execFile`). `.github/workflows/` needs `workflow`
scope (`gh auth refresh -h github.com -s workflow`).
