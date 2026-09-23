# Brief: sessions that do not need the laptop move to the PC during the session

Robert, 2026-09-23, verbatim: "do u see taskdriver sessions running/memory going up now
shouldve been suggested to move session to pc already since doesnt evn need to be on this
laptop right? need more allocation to remote pc properly. automatically after a few turns if
it should? issue is needs contast communication with other lanes so they dont duplicate work
since not on same device as well."

Earlier the same day: "dont ever force at a new session open randomly to pc. i said during the
session not at start if i have this laptop selected." Start stays local (fixed in 36d23570).
This brief is about moving DURING a session.

## What was measured (2026-09-23 ~05:35Z, Mac, installed 0.8.222)

- 8 agent panes on the Mac, 5 of them taskdriver.ai (`taskdriver.ai`, `-a`, `-b`, `-c`,
  `-d`), all `working`. Each claude process 150-265 MB. Four `next dev` servers for
  taskdriver (ports 3006-3009), next-server 56-642 MB each, ~1.3 GB total.
- `top`: PhysMem 15G used, 6470M in the compressor, **139M unused**. But
  `kern.memorystatus_vm_pressure_level` = **1** (normal) and `memory_pressure` says 42% free.
  The hook read level 2 a few minutes earlier, so the reading flips.
- `autoHandoffPlan` (`src/shared/autoHandoff.ts` ~542) returns `[]` at level `ok`, so nothing
  was considered. Even at `warn`, `budgetPlan` only takes `queueable` panes quiet for
  `BUDGET_QUIET_MS`, so a desk of constantly busy panes never moves.
- `handoff.log` since 04:44Z: only refusals for running background agents (`subagent`).
- `handoff.log` 03:08-03:38Z (0.8.221): three moves reached the PC and were **refused over
  there** because the PC's same-named checkout was dirty: `taskdriver.ai-a has 2 unpushed
  commit(s) on lane-a`, `assistant-c has uncommitted work`, `claude-memory has uncommitted
  work`. The receiver refuses instead of taking another clean copy.
- Config: `autoHandoff.keepLocal` 2, `budgetMinMb` 180, `offloadIdleMinutes` 0,
  `keepHere` = PaneForge copies + assistant-a.

## Decisions (made for Robert; the question round was not available)

1. **Read memory honestly.** Add a compressor/unused signal to the Mac memory verdict
   (`src/main/memory.ts`, `shared/capacity.ts` `worstPressure`): a desk with the compressor
   holding a large share of RAM and almost nothing unused is `warn` whatever the kernel's flag
   says. Choose the thresholds from the numbers above and the ones already recorded at the top
   of `shared/capacity.ts` (15G used / 122M unused / 6321M compressor = level 2). Put them in
   named constants with the measurement in a comment.
2. **The trigger is turn count, not idle time.** New rung: when a pane's turn ENDS, and it has
   finished at least 3 turns on this machine, and it can travel (`travels`, not `machineBound`,
   `shareable !== false`, not `stayHere`, not `keepHere`, not `pinnedByPrompt`, no running
   subagent/back job, no question), and this desk runs more than `keepLocal` agent panes, and
   the memory verdict is `warn` or worse → arm the existing move countdown (`MoveSoon.tsx`,
   `Keep it here` once = `handoffBlocked`). No press = it moves. Never mid-turn. The dearest
   pane goes first (`paneCost`), one per sweep. A pane still running background agents waits
   for them (existing `queueVerdict` `wait`).
3. **The receiver takes a clean copy instead of refusing.** When the PC's same-named checkout
   has uncommitted or unpushed work, the move lands in a free, clean lane copy of that repo on
   the PC (the lane engine `scripts/lane.mjs` pool: `-a/-b/-c/...`, created if missing), with
   the paths grafted as `shared/handoff.ts` already does. Refuse only when no clean copy can
   be had, and say which.
4. **No duplicated work across the two machines.** Check what "Two desks, one repository"
   (PaneForge CLAUDE.md: claim refs `refs/paneforge/claims/<device>/...`, `peerRefs()`)
   already gives. A moved pane must claim its lane on the PC and release the Mac's lane in
   the same move. The first-edit overlap warning (`guard`, `test:laneoverlap`) must also see
   files changed by the other machine's lanes (their pushed lane branches). Build only the
   missing part, and keep it small.

5. **Dev servers count and travel.** Robert: "memory stats maybe wrong all spawning next dev
   thats a lot of memory used?" Each taskdriver pane started its own `next dev` (4 at once,
   ~1.3 GB). A pane's cost (`paneCost`, descendant tree) must include the dev server it
   started, so the pane that owns a 600 MB next-server is the first one moved, and the move
   carries the server (`shared/devServers.ts`) and stops the Mac copy. Check whether
   `claude-config/devserver-reaper.mjs --cap-only` (running on the Mac) caps these at all, and
   say what it did at 05:35Z.

## Constraints

- Follow PaneForge `CLAUDE.md`: read the design-notes section for "before it closes one, it
  tries to move it" before changing the ladder. Work only in your lane. `npm run typecheck` +
  `npm test` before a commit. NO release without Robert's word.
- The Mac is short on memory: run heavy commands through
  `node ~/.claude/rbuild.mjs --session <id> --repo <dir> -- <cmd>`, one command per call.
- Pure logic in `shared/`, with a `test:*` suite whose fixtures copy the real log lines above.

## Done means

- A pure test replays the 05:35Z desk (8 busy panes, the memory numbers above) and shows the
  pane that finishes its 3rd turn armed for the PC. The same desk at genuinely low use arms
  nothing.
- A pure test shows a dirty same-named PC copy leading to a clean lane copy, not a refusal.
- `npm run typecheck`, `npm test` and `test:autohandoff`, `test:handoff`, `test:lanepeers`
  pass. Merged via `node scripts/lane.mjs ready`, no release.
- If a live move Mac→PC cannot be proved from the pane, say "changed but unverified" and
  name the exact log lines that would prove it.
