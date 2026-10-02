# Capacity: what panes cost, what they leave running, reclaim and handoff

Verbatim sections moved out of the repo's always-loaded instructions (`AGENTS.md`),
same headings as `docs/design-notes.md` (the why). Paths: `shared/` = `src/shared/`, `main/` =
`src/main/`. `test:x` = `npm run test:x`.

## A shell pane says what it is running

`shared/paneJob.ts`, `test:panejob`. POSIX foreground (`tcgetpgrp`, `IPty.process`, 1s);
Windows `jobFromTable` (`TABLE_JOB_MS` 4s, shell panes; background only when foreground
empty). `reclaim.ts` refuses on `job`; `busyOnScreen`; clock counts COMMAND. RUNNER only.

## ...and an agent pane says what it left running

`paneJob.ts` refuses agents; `shared/paneBackJobs.ts` chip feeds no BUSY (`test:panebackjobs`).
`Session.backJob`/`backJobSince` (`backJobInfo`, `main/usage.ts`) -> `fleetState` `working`,
clock counts the JOB; question outranks, stale bell not. Descendant count isn't the reading
(MCP/`caffeinate` trees 5-9). Separator = shell `-c` vs direct; job = SHELL SUBTREE, never
walked INTO (`LOOP_MIN_SECONDS` 30s). Control keyword owns its line, `do`/`then` prefix; name
= first non-housekeeping `-c` segment; `workName` prefers script.

## What a pane leaves running

Quit `taskkill /F /T <pid>`; `src/main/strays.ts` samples descendants every 30s into
`strays.json` per run; close/quit/next launch kill from it. Records carry creation time,
re-checked; a live app's run is someone else's. `execFile` only; unwaitable -> detached
script. Never asks what the pane RUNS. `test:strays` real orphans, real `spawnDetachedNoWindow`.

## What a pane costs is measured, not modelled

`capacity.ts` models 190 MB/pane; `src/shared/usage.ts`, `src/main/usage.ts` (`test:usage`).
Pane = descendant TREE; CPU = counter delta never `ps %cpu`; sampler skips hidden, one read in
flight; memory at `FOOTPRINT_MS` 20s (`dueForFootprint`), new pane forces one.

## ...and it knows what is serving, and can stop one

`devServers.ts` = SCRIPT; `shared/devList.ts` = PORT + pane (`test:devlist`). One server not
one process; only `-p`/`--port`/`--port=`/`PORT=`. Tree then path; unclaimed listed. Pid
re-validated; SIGTERM then SIGKILL. Facts in main on demand.

## The resource ladder has a face

`capacity.ts`/`autoHandoff.ts`/`reclaim.ts` act; `shared/mascot.ts` speaks,
`components/Mascot.tsx` draws (`test:mascot`). Arithmetic + parser, nothing leaves. `paneWord`
`(1) taskdriver`. `pet: 'none'` = card + pill. `spriteReserve` whole rows on `.xterm`,
`RESERVE_MAX_FRAC` 30%. Pane NUMBER narrows SERVERS. Bubble `mascot.hideSeconds` 60s,
COUNTDOWN exempt. A guess is never an action; destructive intent OFFERED; `closeable()` =
`reclaim.ts` refusals, `asking`. Countdown HEARD (`sounds.move` `bowl`, last ten seconds);
`MoveSoon.tsx` ALWAYS draws it (`armCloseRef`, `Keep it open`/`Close now`); `idleClosePlan`
`lead`, 5s sweep, `countdownEnd` at `dueAt` (`MIN_COUNTDOWN_MS`); `KEEP_MINUTES` 10; hidden ->
closes. Once per situation. Ten pets (`src/shared/pets.ts`), SLOT-keyed 24x24; OFF, `dueDash`
`DASH_EVERY_MS` 9 min; drop -> `mascot.spot`. `z-index: 40`, `pointer-events: none` except
sprite/bubble. Mute; `hand off pane 2` opens the box.

## A dev server nothing can reach is closed, after a countdown

`shared/deadDev.ts`, `main/deadDev.ts`, `StopServer.tsx`; `test:deaddev`. Reading = LISTENING
SOCKET (`listeningPids()`, `lsof -Fp`/`netstat -ano`, DOWN the tree); empty = FAILED, stops
sweep. Refusals: serving, `launchctl list`, `DEAD_AFTER_MS` 90s, kept, pid 1; Windows claims
none supervised. `SWEEP_MS` 60s; deadline 500ms tick; one card, never re-armed; 5s
`config.deadDev`, Settings switch. `stopDevServer` re-validates; bell `stopped`.

## A full machine gets its panes back

`capacity.ts` trims scrollback (~5%); `shared/reclaim.ts` closes (CLI ~190MB, Codex 16-17MB);
`test:reclaim`. Trim is a DELETE; recovery from raw log (`REDRAW_BYTES` 4 MB);
`TRIM_GRACE_MS` 5min, `TRIM_SETTLE_MS` 60s. `kill()` -> `recordEnd` keeps
History/`resumeId`/`scrollbackId`. Pressure triggers, never a clock. Never: needsYou/focused/on-screen/
working/starting/stalled/mirror. `.cap-pop` on verdict CHANGE, `CAPACITY_NOTE_MS` 12s, `over` only, `CAPACITY_QUIET_MS` 10min. `touchPane` clears `closeSoon`; `Session.closeKept` `kept 10m`; `idleCloseAt` clamps,
`sameDeadline`. `ReclaimPane.pinned` (`reclaimPlan`); `keptUntil` 1h. Footer reading
`shared/cloudWork.ts` (`N cloud sessions still
running`/`N shells still running`, `CLOUD_HOLD_MS` 45 min, `test:cloudwork`). `quietSince` =
keystroke/byte/KEYBOARD LEAVING. `shared/away.ts` `AWAY_AFTER_MS` 60s
(`getSystemIdleTime()`, `main/away.ts` 15s, `sawPerson`); `unread` holds CLOCK only. Sleep is OFF by default (2026-09-28: `idleSleepMinutes` 0, `migrateReclaimV5` once per desk; Settings switch turns it back on at `IDLE_SLEEP_MINUTES`): a finished pane closes into Review instead, sooner under pressure (`doneQuietMs` 3m/1m tight/30s over, `docs/agents/pane-lifecycle.md`); `pf tidy` closes them now (`sessions:closeDone`). When on, `idleSleepPlan` runs ONLY under a memory verdict (`pressure` tight/over; `ok` = nothing sleeps, 2026-09-25) and stops agent/keeps card, `asleep 3m`; quiet panes with room close into Review (`sessions:closeIntoReview`). Keep = restart the pane's close clock (`keptUntil` = one close window), no `kept` chip, no bulk Keep-open button (right-click pin stays).
`reclaim.log` source/reason/quiet-vs-threshold/request/refusal/completion/wake;
pid/version/seq; shutdown 250ms; `node scripts/sleep-cause-live.mjs`. Person-woken keeps
clock `WAKE_GRACE_MS` 5 min (`wokeAt`).
Only MEMORY shortens sleep (`sleepPressureOf`). `reclaim.idleCloseMinutes` 0/5. `restorePlan` all/two/one at
normal/warn/critical, never zero (`test:capacity`).

## ...and before it closes one, it tries to move it

Rungs: trim -> start next pane there -> move UNFINISHED agent work -> close. `shared/autoHandoff.ts`
(`automaticWork`: Claude/Codex, a turn running or a verified pane-bound handoff with open steps;
finished/stopped/exited/shell/unverified idle panes never move automatically - Robert 2026-09-29,
replacing the move-finished-panes rule on 2026-10-02)
(`test:autohandoff`). `Machine.keepLocal` (`autoHandoff.keepLocal` 2) budget, `Verdict.over`,
`budgetPlan`. Cost decides: `expensive()` = `AutoPane.job`, `budgetMinMb` 500, `budgetMinCpu`
50%; dearest first; unmeasured = cheap; holds at `ok`. Only rule moving ON SCREEN; busy LAST
(`rank`); `queueable` > `movable`; refused: focused, question, mirror, moving, cooldown, last
pane; moved = overshoot. `Session.stayHere` refuses all; `keepHere` matches lane copies. Lag +
memory, worse wins (`lagLevel`, `worstPressure`: 1 thread/core `warn`, 1.8 `critical`; Windows
loadavg 0 = unmeasured). `MoveSoon.tsx` 15s (z-index 45), ONE line: what + seconds + one Keep, reason in the tooltip (`.move-soon.line`, also `OffloadSoon.tsx`); `Keep here` ONCE
(`handoffBlocked` Infinity, `move-declined`). `AutoPane.ask` via `pinnedByPrompt`.
`AutoPane.machineBound` (`shared/paneBound.ts`: `--remote-debugging-port`/`-pipe`, `--headless`
+ driver); `AutoPane.shareable` (`main/handoff.ts` 5 min; `false` refuses, `undefined`
unasked); `test:panebound`. `keepLocalOf` only override. `suggestMove` (`Move it`/`Keep it
here` -> `autoHandoff.keepHere`). Never back to `senderDevice`/`arrivedFrom` (`hostFor`).
MID-TURN never picked; `main/handoffQueue.ts` moves at turn end, expires `waitMinutes`
(`remote:handoffCancel`); `undefined` keeps stamp, `null` clears; `handoffQueuedAt` `waiting
12m`; `TICK_MS` 5s. `AutoPane.asking` refuses; failed = `cooldownMinutes`. `idleOffloadPlan`
(`offloadIdleMinutes` 0/30). `handingOff` refused by `reclaim.ts`.

Dev server travels (`shared/devServers.ts`, `test:devservers`): tree OR repo-path command ->
script name, rebuilt from receiver lockfile, never argv; `SCRIPT_NAME`; ambiguous dropped;
only `DEV_SCRIPT` (`dev|start|serve|watch|preview[:x]`).

Turn rung `turnsPlan` (3 turns here, verdict not `ok`, past `keepLocal`, `queueable`): same countdown,
ONE per sweep. Mac verdict adds `compressorLevel`, stray `next dev` = `PaneUsage.devMb`
in `paneCost`, dirty same-name copy -> `landingCopy` takes a clean free one. `overlap()` reads
`origin/lane-*`.

Automatic handoff only selects supported Claude/Codex conversations with proven portable
folders and unfinished work. Running turns may queue; delivery waits for drafts, subagents
and background jobs. Idle work requires a fresh pane/native-conversation-bound handoff;
finished, exited, shell and unverified idle panes stay local. Main rechecks that handoff
and new activity before delivery and before ending the source. Receiver closure saves Review first.

## Logs to read when the desk is slow

All under userData (Mac `~/Library/Application Support/claude-orchestrator/`), each size-capped.

- `pressure.log`: one JSON line a minute (`shared/pressureLog.ts`, `main/pressureLog.ts`,
  `test:pressurelog`): kernel flag and compressor verdict apart, load per core, compressor and
  swap MB, per pane RSS/CPU/status, the 5 biggest non-pane processes, `caffeinateChildren`
  (must be 0-2; 20 = the 2026-10-01 leak).
- `awake.log`: every `[awake] caffeinate system|display started/stopping/exited` line
  (`shared/caffeinateHold.ts`: an old child's late `exit` may not clear a newer child's slot).
- `handoff.log` `sweep:` lines: why the move sweep armed nothing, counts per blocker
  (`sweepBlockers`): bgAgent, keepHere, quietTooShort, notExpensive, peerHolds, working... Written
  on change or every 5 min. No `sweep:` line for a minute = the sweep never ran (no `capacity`).
- `offload.log` is where NEW panes were placed, not the idle rung. 2026-09-28..10-01: 175
  `started`, all local ("you chose this machine"). `autoHandoff.offloadIdleMinutes` 0 = idle
  rung off (as configured on this Mac); the background-agent refusal (`runningAgents.ts`)
  measured 54 blocks, median 4.3 min, longest 76 min, 9 over 20 min: not "for hours", so
  unchanged. Re-measure from `sweep:` lines before changing either.
