# Pane lifecycle: sending, restoring, clearing, closing, recovering

Verbatim sections moved out of the repo's always-loaded instructions (`AGENTS.md`),
same headings as `docs/design-notes.md` (the why). Paths: `shared/` = `src/shared/`, `main/` =
`src/main/`. `test:x` = `npm run test:x`.

## ...and a pane that says it is working, on a frame nobody repainted

Busy read = bottom of screen (`shared/busy.ts`). `shared/staleFrame.ts`, `test:staleframe`:
`busyUntil` renewed, `checkBusy` 4s; `busyEvidence`+`staleSignature`; recovery
`sessions.redraw` + SIGWINCH, no keystrokes. `STALE_AFTER_MS` 4min, `MAX_NUDGES` 2,
`NUDGE_EVERY_MS` 1min; mirror judges nothing; `autoFixUi` off = no. `window.__paneBusy[id].stale`.

## A window that stops answering comes back on its own

`shared/renderWatch.ts` + `main/renderWatch.ts`. `forcefullyCrashRenderer`, reload from
`render-process-gone` (`PROBE_DEAD_MS` 20s + 5s). `executeJavaScript('1')` per
`PROBE_EVERY_MS` 5s, `GRACE_MS` 10s; `RELOAD_COOLDOWN_MS` 60s, `MAX_RELOADS` 3. Dead renderer
rebuilt; `activate` asks `alive()`; panes return via desk.json + `--resume`, no focus.
`paneforge-errors.log`; cpu = `getAppMetrics().cpu.percentCPUUsage` delta. `test:renderwatch`;
`PF_PORT=9334 npm run test:renderwatchlive`.

## A fault the app survived is a fault nobody hears about

`crash.ts` swallows; `shared/faultNotify.ts` decides, `main/faultNotify.ts` posts on
`askNotify.ts`'s channel (`test:faultnotify`). Test copy pages nobody (`profileName()`); drill
isn't a fault; unregistered kind not sent; `MAX_PER_RUN` 5; only `reload`/`recreate`/`still
wedged` leave; digits blanked; `QUIET_MS` 30 min. Listener on `crash.ts`. Silent without
`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`; never awaited.

## A pane opened with a prompt sends it

`queuePrompt` (`src/main/sessions.ts`, `test:promptsubmit`). Ready = idle COMPOSER (output
stopped, `readsBusy` false, last PAINTED). Return separate; submit confirmed by TURN (`runSince`
newer); busy waits; idle with no turn gets another return. `/clear` no boot patience;
`PROMPT_ENTER_TRIES` 6; `CLEAR_RESUME_BUDGET_MS` 3 min vs 45s; `autoclear-app.log` `UNSENT`;
`ARM_QUIET_MS` 15s, `ARM_CLEAR_LEAD_MS` 120ms. Codex `gpt-5.1-codex*` = `400 not supported`.

## A pane says what its handoff has left

`## Next steps`: `shared/handoffSteps.ts` (mirrors `claude-config/autoclear.mjs`),
`main/handoffSteps.ts` 30s cache; `test:handoffsteps` skips out loud if absent. `0` = `None`,
`undefined` = no handoff; chip for neither; no busy reading. Arm re-reads: nothing open ->
`NOTHING_OPEN` (`pane-clear.mjs`); `--no-resume` exempt.

## A pane that is still starting says so

`blank` is not booting. `Session.printed` = first byte from THIS process, cleared by
restart/wake. `PaneBooting` one dim BOTTOM line (`.pane-booting.over`): `Starting Claude
Code…` (agent `label`), seconds past `COUNT_AFTER_MS` 1.2s; no spinner (`test:anim`). `npm run
boot-timing --panes 7`; staggering is WORSE.

## A reopened pane comes back with what was on its screen

`test:restore` hands `--resume`. Most return ASLEEP: `Live.proc` nullable, `start()` `asleep`;
`sleep()` = `status: 'exited'`, grid frozen at `START_COLS`; `wake()` spawns; only DEAD drops.
`restoreAsleep` (`shared/restoreTurn.ts`) refuses first pane, prompt-launched, mid-turn
(`test:restoreturn`). `history.ts` -> `userData/history/<id>.log`, `tail()` `BUFFER_LIMIT`, no
ANSI-strip; desk must carry `scrollbackId` (`test:scrollback`). Clock `openedAt`; mid-turn
via `queuePrompt`; `askAfterUpdate` off. PAINTED size: `max(recorded, paintedWidth(bytes))`
and the recorded ROWS (`sizeOf`, `replayRows`) -> staged before the restore mark, resize in
write CALLBACK; Fix writes through
the same stage (`writeStaged` - raw); a pane
with no rows on disk is torn once, the bytes carry no height (`shared/replayWidth.ts`,
`test:replaywidth`). Self-Fix `repair()` once, `RESTORE_FIX_MS` 1.2s; mirror refused, hidden
FLAGGED (`test:restorefix`). Rail = KEYSTROKES; `seedMarks` scans `❯ <text>` once
(`test:promptecho`). Reply mark per CLI (Claude `"type":"assistant"`, antigravity
`"type":"PLANNER_RESPONSE"`, `hasReply`); wrong = `conversation-unverified`, never sleeps;
refusal hold doubles `sleepHoldMs` 10 min -> 2 h (`test:sleep`). Asleep pane claims its
conversation in `start()` BEFORE the early return (`noteSession`, `resumeIdFor`). Nothing
inferred = `claimFromCli` reads the CLI's `~/.claude/sessions/<pid>.json` (`test:cliclaim`).

`/clear` keeps the previous turn (`test:scrollclear`): `keep.arm()` (`shared/keepScrollback.ts`)
on `mayClearScreen` or a slash PREFIX of `/clear` RETURNS scroll before any byte; `keptRows`
to composer top when CARET between its rules; fed via `paneArmClear`. Erase REPORTED;
`shared/screenLoss.ts` at 80%+; `2J`/`3J` rewrite covers unasked clear, down 10s after an
armed one. `shared/markAnchor.ts` re-anchors tags (`test:markanchor`).

## A finished pane closes itself into Review

`shared/doneClose.ts` (`test:doneclose`), `main/doneClose.ts`, 15s timer; `config.autoCloseDone`
on. Closes when: agent pane, turn over (`footerEndedAt`), not ACTIVE (`sessions:active`),
`AUTO_CLOSE_QUIET_MS` 3 min past turn end AND last key, `doneEnough`, reply read off
transcript (`shared/replyRead.ts`, `test:replyread`), no running subagent, reply not ending
`?`, `actionableNextSteps` empty. Writes `result`/`unverified` review `done_<pane>_<turn s>`
(`recordReview`, idempotent), then `closeAfterResult`; each `personOwnedSteps` step becomes a
GuardDeck notice, `spoolNotice`'s gate. Opener told once: `finishedDigest.ts`. Review = ONE list (`ReviewDialog.tsx`,
`shared/reviewList.ts`, `test:reviewlist`): Needs you/Done/All, row = number+project+ask+
result, expand = full reply + Reopen (`--resume`) + Copy; shell/bare-slash rows hidden. Idle
shell undrawn (`fleet.ts` `idleShell`) till pressed/run; idle countdown still takes it.

## A session that clears itself asks first

`scripts/autoclear-hook.mjs` (Stop/SessionStart; installer `main/autoclearHooks.ts`, a
foreign autoclear left alone) -> `<userData>/autoclear-requests/<pane>.json` ->
`main/autoclearRequests.ts` -> `autoClearAsk` = `autoclear:ask` (`test:autoclearhook`).
`Keep this session`/`Clear now`; unattended proceeds (`test:autoclear`).
`shared/autoclear.ts` refusals; `main/sessions.ts` re-checks (`dropFor`) each tick. `## Next steps:
None` respected. Resume: `queuePrompt` on IDLE COMPOSER; `keep.arm()` 120ms.

## The screen stays on while a pane works

`shared/awake.ts` + `main/awake.ts` `powerSaveBlocker` while mid-turn/asking (`test:awake`).
Cap on BUSY STRETCH; `config.keepDisplayAwake`. `screenUnseen` drops screen hold only;
clamshell + monitor: builtin must be the only screen; failed read = false.

## A pane's two ends open at the same width

Grid never narrower than painted width: `src/shared/paneGrid.ts` (`test:panegrid`). Pty 120 vs
xterm 80 tore `claude --resume` at 119. Fix `redrawHistory` at `max(pane now, replayCols,
START_COLS)`, user-initiated; `window.__pf[id].redraw()`.

## A turn the transport cut in half finishes itself

`shared/recover.ts` (`test:recover`) keys on `The response above may be incomplete.`; never
after rate/usage limit, credit, auth, overload; `> ` quoted error is talk (`promptBox`); three
in a row stops; new output only; sends via `queuePrompt`.
