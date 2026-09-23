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
(`getSystemIdleTime()`, `main/away.ts` 15s, `sawPerson`); `unread` holds CLOCK only. `idleSleepPlan` (`reclaim.idleSleepMinutes` 30) stops agent/keeps card, `asleep 3m`.
`reclaim.log` source/reason/quiet-vs-threshold/request/refusal/completion/wake;
pid/version/seq; shutdown 250ms; `node scripts/sleep-cause-live.mjs`. Person-woken keeps
clock `WAKE_GRACE_MS` 5 min (`wokeAt`).
Only MEMORY shortens sleep (`sleepPressureOf`). `reclaim.idleCloseMinutes` 0/5. `restorePlan` all/two/one at
normal/warn/critical, never zero (`test:capacity`).

## ...and before it closes one, it tries to move it

Rungs: trim -> start next pane there -> move finished pane -> close. `shared/autoHandoff.ts`
(`test:autohandoff`). `Machine.keepLocal` (`autoHandoff.keepLocal` 2) budget, `Verdict.over`,
`budgetPlan`. Cost decides: `expensive()` = `AutoPane.job`, `budgetMinMb` 500, `budgetMinCpu`
50%; dearest first; unmeasured = cheap; holds at `ok`. Only rule moving ON SCREEN; busy LAST
(`rank`); `queueable` > `movable`; refused: focused, question, mirror, moving, cooldown, last
pane; moved = overshoot. `Session.stayHere` refuses all; `keepHere` matches lane copies. Lag +
memory, worse wins (`lagLevel`, `worstPressure`: 1 thread/core `warn`, 1.8 `critical`; Windows
loadavg 0 = unmeasured). `MoveSoon.tsx` 15s (z-index 45); `Keep it here` ONCE
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
