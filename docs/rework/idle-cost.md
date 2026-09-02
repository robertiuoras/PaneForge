# What the app costs when nothing is happening - measure, cut nothing

Read `docs/rework/README.md` first. Robert: "any features/optimisations more that you can do
that are measurably going to help?" The honest answer needs a number nobody has read: the
app's OWN idle cost with N quiet panes, split by sampler.

Samplers that tick on a quiet desk (grep each): `main/usage.ts` (CPU every tick, memory at
`FOOTPRINT_MS` 20s), `main/strays.ts` (30s descendant walk), `main/deadDev.ts` (`SWEEP_MS`
60s `lsof`), `paneJob.ts` (1s `tcgetpgrp`, `TABLE_JOB_MS` 4s on Windows), `backJobs` table
reads, `handoffSteps` 30s, `away.ts` 15s, renderWatch 5s `executeJavaScript`, the 4s session
sweep in `main/sessions.ts`, `orModels` fetch, git status badges.

## Do

1. `npm run build`, `npm run try -- --keep --remote-debugging-port=9333`, open 6 shell panes
   (`node scripts/pf-ctl.mjs open <dir> --agent shell` if that exists, else the + button
   via `npm run probe`), leave them idle.
2. Ten minutes of `getAppMetrics()` deltas (main, renderer, gpu, utility) via `npm run
   probe`, plus `top -l 1` of the PaneForge processes, plus per-sampler wall time: wrap
   each sampler's tick with `performance.now()` behind `PF_TIMING=1` (a log line, no
   behaviour change) and read `updater.log`/stdout. `npm run try -- --close` after.
3. Table: sampler, period, ms per tick, % of one core at 6 panes, and the same at 0 panes.
4. Write it to `docs/rework/idle-cost.result.md`. Name the top two. Propose the cut for
   each in one line, with the number it would save. **Change no behaviour** - the timing
   log behind `PF_TIMING` is the only code that lands.

Rules: never launch a second copy without `--keep --remote-debugging-port`; close it after.
`npm run typecheck`, `npm test`. Commit on your lane, `lane.mjs ready`. No release.
