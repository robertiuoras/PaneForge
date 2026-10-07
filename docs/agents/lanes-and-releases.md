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
- A committed snapshot that lives outside the configured pool is not merged by name.
  `status` inventories the bounded `origin/lane-<slot>-<name>`,
  `origin/wip/lane-<slot>-<name>`, and `origin/park/lane-<slot>-<name>` conventions,
  plus local `*-wip` branches, for explicit inspection. Discovery never changes a lane.
  Register reviewed work with `park --ref <branch> --lane <empty slot> --session <id>`;
  the pinned commit remains visible even when its ref moves or vanishes. Resume through an
  ordinary claimed lane and its normal validation before `ready` (`node scripts/lane-parked-test.mjs`).
- Shipped once `landedOnOrigin` proves it; failed lane out of `lastShip.lanes`; `state.passed`.
- ONE PANE, ONE LANE: a claim drops other holds with the same `PF_PANE`; no pane id = kept.
- A prompt returning to its original letter checkout may relinquish an unused fallback
  only when both checkouts are empty and the original is unheld. Startup can reclaim an
  empty former app owner's checkout only when the all-copy native inventory includes the
  requesting conversation and excludes the former one. Unknown inventory, external owners,
  sleeping panes and unfinished work remain protected (`test:lanecleared`).
- An exact native resume stays in its original checkout. If another chat holds that
  checkout, refuse before allocating a replacement. Preserve dirty files and coordinate
  release at the occupying chat's task boundary. Never use `moveTo` to recover a
  conversation: it starts fresh. Duplicate live native owners must be reconciled before
  `pf continue` sends anything (`test:reopenhold`, `test:pfcontinue`).
- Trunk = `.lanes.json` `branch`, else origin/HEAD, else main/master, never the root's
  checkout (`trunkName`); `trunkHome` moves a parked root back or ship refuses (`test:lanetrunk`).
- `sweep [--dry-run]` removes a copy ONLY when `unmergedWork` is null (0 ahead of
  `origin/<trunk>`, clean); any work = kept forever. Lane folder at once, other 3d idle,
  none in use. Run by `ready`/`release`/`retry` 6h and the app
  (`sweepCopies`); `paneforge-sweep.lock`; doctor `CLEANED UP` (`test:lanesweepfolders`).
- Sidebar lists no copies; `copiesNotice` draws one line only for an untaken clash or work
  held 6h (`test:laneplain`).
- Lane hooks install only from the installed app (`installLaneHooks(stable)`, `node scripts/lane-hooks-test.mjs`).
- The app's retry clock visits every known ledger under the project roots, including repos
  with no open panes, one at a time in fair order. Installed recovery prefers its bundled
  engine; `PANEFORGE_ENGINE` still overrides it and development falls back to the checkout.
  A semantic conflict whose chat went quiet raises ONE GuardDeck card per episode
  (`clashCards`, `c.card.since`), never a resolver pane; the take-over line reaches only the
  lane's own chat (hook `stuck`, LaneStrip `laneOwner`). Temp-folder repos never notify.
  Authorized guarded edits renew the resolver's lease and preserve its open merge
  (`test:laneowner`, `test:lanedispatch`).
- `ready` that took master in re-runs the lane's typecheck before marking it
  (`laneTypecheckFailure`). Every merge (catch-up and release) renumbers a lane's
  `migrations/` file that took a number the other side also added (`renumberMigrations`,
  amends the merge commit; `test:lanemergeitself`).
- The same clock visits empty boards. Unready abandoned dirty or clean-ahead work gets one
  completion owner per repo. `paneforge-recovery.json` stores the reservation separately
  from ordinary lane writes; an exclusive directory lock serializes recovery transactions.
  Atomic stale-lock takeover retains a nonempty tombstone to protect a newer owner. Unknown
  native/process inventory (including unavailable Windows process cwd inventory) or Git state
  stops adoption; an ordinary stopped turn does not prove its owner
  ended. Guard-only first claims enter the hook registry so SessionEnd can mark them ended.
  The dispatcher preserves files and staging, including empty-index, missing and foreign
  worktrees; subfolder panes/processes protect the whole checkout. Claims preserve unready
  clean-ahead HEAD/index until explicit adoption; damaged recovery folders require backup
  and diagnosis before claim. It never auto-stages deletions or reconstructs folders, except
  finishing a half-made copy under the proof below (`test:lanecompletion`). A worktree missing more than half of its HEAD files reads
  `damaged` in `status`/`doctor` and is never handed to a chat, not even one standing in it
  (`test:lanedamaged`).
  If a completion pane ends before adopting a native owner, the pinned task becomes
  durably blocked for explicit delivery/intent inspection. An unconfirmed launch is not
  completion and does not trigger another automatic replay.
- A lane copy is created `worktree add --no-checkout --lock` (reason `paneforge: copy still
  being made`), then `finishCopy` writes its files under `CHECKOUT_TIMEOUT_MS`; a failure in
  that call removes only what the call made. A copy a kill left half made (gitdir `locked` =
  git's `initializing` or ours, no index: `halfMade`, `status.halfMade`) is finished by claim,
  the completion clock or `lane.mjs finish-copy --lane <x>` ONLY when: no fresh index.lock,
  HEAD = lane branch tip, no open recovery item, nothing on disk outside HEAD, every present
  file = HEAD. It holds index.lock (marked with its pid: a dead run's lock is taken over at
  once) from the file check on, writes ONLY the missing files into the gitdir and links each in
  whole (a kill never leaves a cut-off file), creates empty submodule folders, installs the
  index through the lock, then drops `locked` (a whole copy still `locked` by a kill there gets
  it dropped: `dropFinishedLock`). A refusal over contents is remembered against file sizes and
  times (`paneforge-refused`; 4.4s to re-read 4,879 files). Any doubt: left as is, `damaged`
  (`test:lanehalfmade`; taskdriver.ai d/f 2026-10-07).
- `recover --key <pinned-key> --session <native-id> --disposition begin [--lane <slot>]`
  binds an actual ordinary claim. `verified --receipt <json>` needs the current commit,
  nonempty successful `{command, exitCode: 0}` checks and accepted independent
  `{reviewer, result: "accepted"}` review. Normal `ready` then integrates; `complete`
  proves inclusion in the remote trunk. `blocked`/`reviewed` receipts require a reason and
  persist for the pinned snapshot so an ambiguous ref does not reopen on every tick.
  Recovery never publishes a version; that remains Robert's publisher's action.
  A lane item another owner left unfinished closes as `reviewed` ("included by trunk
  ancestry") when the chat now holding the lane runs `ready` or ends, but only if its pinned
  commit (and receipt commit) is in trunk, it was not pinned for uncommitted changes
  (`dirty`), and the checkout has no hand edits (`closeShippedRecovery`, `test:lanecompletion`).
  `doctor` says when parked work is done, blocked, or left by a chat that is gone, and a recovery
  item that lost the active slot is revisited and blocked, not left dispatched (`test:lanecompletion`).
- Recovery takeovers (`test:lanecompletion`): (A) `claim --prefer <lane>` lets the pane an item was
  dispatched to (`dispatched`, no owner, same `PF_PANE`) swap into that lane though it holds a preserved
  item; no catch-up or reset, so `begin` still sees the pinned HEAD. Another pane or an owned item gets
  no swap. (B) a release never merges trunk into a lane holding a preserved item (a ledger error skips
  every lane). (C) `recover --key K --session S --disposition adopt` moves an `owned`/`verified` lane
  item from a dead owner to S when S holds the lane, the old owner holds no lane, the inventory does
  not show it living, and the lane HEAD equals or descends from the pinned commit; status resets to
  `owned` so the adopter re-verifies. (D) `claim` closes the requested lane's items whose pinned commit
  trunk already holds (`closeShippedRecovery`), so a blocked dead-owner item no longer bars the lane.
  (E) a chat whose start gave it `main` while standing in that lane's folder moves to the lane on `claim --prefer`
  when it could dispatch-begin at the pinned HEAD or adopt the lane's item (`adoptRefusal`), main has no hand
  edits or Git operation open, and the lane is healthy, free, unconflicted and unsquatted. Main is not
  marked ready and keeps its commits.
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

**A push of master needs a passing suite on the exact tree it pushes** (`test:pushgate`).
`installPushGate` writes a git pre-push hook that runs `lane.mjs prepush`, which asks
`treeVerdict` (the ledger's suite records, matched by tree) about every `refs/heads/master`
push; other refs are never gated. `ship()` run by `autoship` re-tests the merged tree with
`pushedTreeFailure` before pushing and resets to the pre-merge commit when it is red. A hand
`ship` and a version release record `pushOk` for their tree and go through. `--no-verify` is
a deliberate bypass. The refusal names master's own `lane.mjs` by absolute path (a lane's copy can be
older and lack the gate): `ready` for lane work, `autoship` when master already holds the merged
work. Every PC typecheck/suite job is keyed on the folder's COMMITTED tree (`headTree`) and, when
the folder is dirty, ships a `git archive` copy of that tree (`submitPcTree`): rbuild uploads the
folder as it stands, and a verdict on another chat's uncommitted edits matched no pushed commit,
so master sat unpushed while main was being edited (2026-10-07, `test:lanetypecheckjob` v).

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
gate. Stops named: typecheck, `npm test` (`suiteFailure`), conflict (`test:gate`). The suite runs
as its own detached `suite-job` (one per tree, `state.suiteRun`); a clock tick (`retry`, `release --gone`)
never waits on it, a chat's `ready` does (`test:lanesuiterun`). Notes =
subjects between tags (`scripts/release-notes.mjs`, `test:notes`). Asset size before fixing
`latest.yml` (`reconcileFeed`, `test:laneargs`). Tag push runs `Release` (mac AND win). `npm
run release` (`scripts/release.mjs`) is a GUARD: refuses over a complete release, before the
build without `GH_TOKEN`, when GitHub cannot be asked; holds served bytes against `dist/`
(`npm run release:verify`; feed judged by declared rows). Never `electron-builder --publish
always`; power-of-two asset size = partial upload. `test:release`. Auto = dev prerelease,
promotes after `PF_PROMOTE_SOAK_MS` 3d (`lane.mjs promote|doctor`, `test:promote`).

## Updates wait for the user to restart

Install once, update from app. Unsupported: skip not retry (`shared/pickRelease.ts`,
`test:pickrelease`). Background download, then Restart now / Later; installs on Restart now,
a normal quit, or an IDLE DESK (2026-09-24, Robert): `idleInstallCheck` every 60s asks
`idleInstallBlocker` (`shared/updateHold.ts`) - nobody touched the computer 10 min, no pane
printed/typed 10 min, none mid-turn/asking/drafting/back job, restore after update on, no
game. No countdown/escalation/retry (`test:updatehold`). Restore off = no self-install ever:
the card stops promising one (`selfInstallOff`), the hold line names every half (`idleHoldLine`). A staged build on a busy desk may
still sit for days: the rule working. `src/main` never consumes
`onUpdateIgnored`/`READY_HOLD_MS`. `phaseAt`; `CHECK_BUDGET_MS` 2min, `DOWNLOAD_BUDGET_MS`
45min, `PROBE_BUDGET_MS` 5min, `POLL_WATCHDOG_MS` 6min; quit gated `stagedInstallable()`.
`update-health.json`, 3d = `STALE` (`test:updater`, `test:wedge`). "Never finished" at 10-17
min = laptop ASLEEP: `shared/wakeWatch.ts` (5s tick, >30s gap) writes `slept`,
`health.sleptAt`, defers `WAKE_SETTLE_MS` 20s; `net::ERR_TIMED_OUT` = one `late answer` line.
Health `sleptAt` = dated sleeps, launch line says only the last 24h (old `sleeps` total ignored).
A drop (`dropRequest`) closes the `electron-updater` session so the dead request fails and the next
check is fresh; its error is a `late answer` by promise identity (`dropped`), not the 60s window.
A poll after a wake flurry waits `BURST_SETTLE_MS`, at most `MAX_POLL_DEFERS` times (`awakeFor`,
`test:wakewatch`).
An install that came back on the old version is never silent: `install-attempt.json` older
than `app.getVersion()` = `UpdateState.installFailed`, card with that version's installer +
Try again. Windows install waits for pane pids (5s) and the installer stops everything run
from `$INSTDIR` (`scripts/win-free-install-dir.ps1`, 10s) - `shared/installWedge.ts`,
`test:installwedge` (2026-09-24, friend stuck on v0.8.179).

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
