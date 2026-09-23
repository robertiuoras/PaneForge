# Lanes, releases, updates and Windows install

Verbatim sections moved out of the repo's always-loaded instructions (`AGENTS.md`),
same headings as `docs/design-notes.md` (the why). Paths: `shared/` = `src/shared/`, `main/` =
`src/main/`. `test:x` = `npm run test:x`.

## Lanes: more than one chat works on this repo

Hook assigns `main` (master) or worktree `PaneForge-a/-b/-c` on `lane-a/-b/-c`; write only
there, PreToolUse refuses elsewhere. `node scripts/lane.mjs status --repo <dir>`.

- Visitor gets a letter lane, not `main`, unless dirty.
- Hand-typed `/clear` returns the lane only when QUIET; mid-turn stays (`laneWentQuiet`,
  `moveTo` restarts the CLI). `shared/laneReturn.ts` `mayReturnLane`; `test:lanereturn`.
- One engine `lane.mjs --repo <dir>`. `.lanes.json` `{ "lanes": false, "branch": "main",
  "release": "merge", "pool": ["main","a"] }`. No-remote repos, `claude-memory`: no lanes.
  Never leave one conflicted.
- Shipped once `landedOnOrigin` proves it; failed lane out of `lastShip.lanes`; `state.passed`.
- ONE PANE, ONE LANE: a claim drops other holds with the same `PF_PANE`; no pane id = kept.
- Trunk = `.lanes.json` `branch`, else origin/HEAD, else main/master, never the root's
  checkout (`trunkName`); `trunkHome` moves a parked root back or ship refuses (`test:lanetrunk`).
- `sweep [--dry-run]` removes a copy ONLY when `unmergedWork` is null (0 ahead of
  `origin/<trunk>`, clean); any work = kept forever. Lane folder at once, other 3d idle,
  none in use. Run by `ready`/`release`/`retry` 6h and the app
  (`sweepCopies`); `paneforge-sweep.lock`; doctor `CLEANED UP` (`test:lanesweepfolders`).
- Sidebar lists no copies; `copiesNotice` draws one line only for an untaken clash or work
  held 6h (`test:laneplain`).
- Lane hooks install only from the installed app (`installLaneHooks(stable)`, `node scripts/lane-hooks-test.mjs`).
- Roster asks `status --held` (`test:lanes`). First edit of a file another lane changed is
  told with line ranges (`guard` exits 0 with text); same region: message that chat first
  (`node scripts/lane-overlap-test.mjs`).

## Two desks, one repository

Ledger per machine `<repo>/.git/paneforge-lanes.json`, never pushed. Claim = ref
`refs/paneforge/claims/<device>/<slot>/<session>/<millis>`, one `ls-remote`. Only trunk asks,
only a chat lacking it; `PEER_STALE_MS` 45 min. Heartbeat = turn ending past `REFRESH_MS` 10
min; ending returns trunk. Release lock `refs/paneforge/lock/release` = non-forced push of an
orphan commit; no timestamped claim = cleared. `peerRefs()` returns `null` not `[]`.
`PF_DEVICE` overrides hostname. `test:lanepeers`, `test:lanedevice`.

## Releasing happens when Robert asks, and not before

`"release": "merge"`: merge to master, push, no version. End of work: build, prove in a copy
(`npm run try -- --keep --remote-debugging-port=9444`, `npm run probe`), report numbers,
stop. `npm run typecheck`/`npm test` gate a commit. `node scripts/lane.mjs ready --repo <dir>
--session <id>` merges master in, refuses dirty. `npm run ship` ONLY when Robert asks.

**NO RELEASE WITHOUT ROBERT'S WORD IN THIS CHAT.** `npm run unreleased` exit 1 is a REPORT;
another chat's release is not yours; yesterday's word is not today's (`test:unreleased`).
Never cut one while a next step is open.

**Dev-window tour** (`shared/tour.ts`, `TourCard.tsx`, `shared/lookCheck.ts`; `test:tour`,
`test:look`): each `feat:`/`fix:`/`perf:` commit since the installed build touching `src/`,
deduped by subject, is a step. Card = NAME in screen words (SCOPE via `SCOPE_PLACES`, then
files), ONE sentence, ring, the commit's `scripts/<x>-test.mjs` RUN with result; off: commit
sentence, `See:` bullets, passing look via `checkWords`; live line
BOTTOM. Pane step opens the desk's pane or one SHELL pane, never an agent. Suites = ONE verdict
(`checkedAll`, `summaryCount`; no number = `Checked`). STARTING IS THE APPROVAL: nothing before,
everything on arrival after (`started` not `playing`; `TourProgress`, `app:tourCheckLine`; check in
flight holds). Plays itself (`dwellFor`); Pause stops; Previous/Next
steer; a DO step has NO clock (`waitsForYou`); Next ticks the step it leaves. Sound on arrival
(`demoFor`, `previewSound`). Done tick 16px `accent-color: #3d8bfd` stays put; PLAYING moves
after `DONE_BEAT_MS`; one bar SEGMENT per step. Survives reopen (`tour.done`, `tour.checks`;
`kept from an earlier run`, `Check again`). ONE SIZE 520px, 2x2 buttons, Next disabled not
removed. `Try:` body line = `Do this:`; bodies carry `See: <what Robert sees>` lines.
`SPOT_MAX_FRAC` 0.45; pane step needs a LIVE process.

`--show` window is watched: pid recorded, `closeTestApps` spares it; only `--close`/next `npm
run try` take it (`force`; `test:devkeep`). Dev-window test on both machines first: `npm run
try -- --pull --show`.

`"release": "version"`: below 1.0 patch (`feat:`), `feat!:` minor, `ship minor|major`. One per
2h (`COOLDOWN_MS`); manual `npm version`/`git tag`/tag push blocked; `npm run ship` skips the
gate. Stops named: typecheck, `npm test` (`suiteFailure`), conflict (`test:gate`). Notes =
subjects between tags (`scripts/release-notes.mjs`, `test:notes`). Asset size before fixing
`latest.yml` (`reconcileFeed`, `test:laneargs`). Tag push runs `Release` (mac AND win). `npm
run release` (`scripts/release.mjs`) is a GUARD: refuses over a complete release, before the
build without `GH_TOKEN`, when GitHub cannot be asked; holds served bytes against `dist/`
(`npm run release:verify`; feed judged by declared rows). Never `electron-builder --publish
always`; power-of-two asset size = partial upload. `test:release`. Auto = dev prerelease,
promotes after `PF_PROMOTE_SOAK_MS` 3d (`lane.mjs promote|doctor`, `test:promote`).

## Updates wait for the user to restart

Install once, update from app. Unsupported: skip not retry (`shared/pickRelease.ts`,
`test:pickrelease`). Background download, then Restart now / Later; only explicit Restart now
or a normal quit installs; no timed restart/escalation/retry (`test:updatehold`). A STAGED
BUILD MAY SIT FOR DAYS: the rule working. `src/main` never consumes
`onUpdateIgnored`/`READY_HOLD_MS`. `phaseAt`; `CHECK_BUDGET_MS` 2min, `DOWNLOAD_BUDGET_MS`
45min, `PROBE_BUDGET_MS` 5min, `POLL_WATCHDOG_MS` 6min; quit gated `stagedInstallable()`.
`update-health.json`, 3d = `STALE` (`test:updater`, `test:wedge`). "Never finished" at 10-17
min = laptop ASLEEP: `shared/wakeWatch.ts` (5s tick, >30s gap) writes `slept`,
`health.sleeps`, defers `WAKE_SETTLE_MS` 20s; `net::ERR_TIMED_OUT` = one `late answer` line.

## A restart onto a new build says what changed

Card bottom-right, z-index 59 (`shared/whatsNew.ts`, `main/whatsNew.ts`, `WhatsNewCard.tsx`,
`test:whatsnew`). Bullets from `scripts/release-notes.mjs`, 6 x 120 chars. Silent on fresh
install, ordinary restart, rollback, no bullets, no network. No dialog/focus/animation.

## What Windows loses between restarts

Desktop shortcut (`build/installer.nsh` guard; `main/winShortcut.ts`/`shared/winShortcut.ts`
restore, never rewrite, never from a try copy); login entry (`setLoginItemSettings` when it
disagrees). `updater.log` `windows ...`. `test:winshortcut`.

## The Windows dev channel picks its own release

`GET /repos/robertiuoras/PaneForge/releases` answers `[]`; `pickRelease` unusable. Tags from
`gh release list`, each asked for `latest.yml`, feed pinned to the first, generic provider,
`allowPrerelease` down; failures leave the feed unchanged. `PF_NO_WIN_PIN` for
`test:blindlist`. `test:winfeed`.

## Why the app quit

`quitting(...)` in `main/index.ts` names every purposeful quit; `before-quit` logs to
`updater.log` with pane count; empty = `nothing in the app asked`. Signals uncatchable;
`shared/quitWords.ts` reads last focus (`FROM_KEYBOARD_MS` 4s): evidence, not verdict.
`test:quitwords`.
