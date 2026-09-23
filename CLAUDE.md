# PaneForge

**Short form, loaded every turn. Cap 12,000 tokens (`npm run test:claudemd`). A rule, never
its history.** Why: `docs/design-notes.md`, same headings. Verbatim long forms:
`docs/claude-md-full-2026-08-31.md`, `docs/claude-md-full-2026-09-19.md` (every story cut on
2026-09-19). **Read the matching section there BEFORE CHANGING the thing.** Never re-derive a
recorded decision. `test:x` = `npm run test:x`.

## Never close the app you are running inside

Installed `PaneForge` hosts this session: never `npm run setup`, `Stop-Process PaneForge`,
NSIS installer. Copies: `npm run try` (profile via `src/main/profile.ts`: own userData, lock,
config, taskbar; minimized, no focus), `-- --show`, `-- --close`. A `dist/` app hand-opened
with no profile opens `/Applications/PaneForge.app` and quits, whichever newer
(`shared/strayLaunch.ts`, `test:straylaunch`); headless refused; no installed app = left alone.

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
- Lane hooks install only from the installed app (`installLaneHooks(stable)`, `test:lanehooks`).
- Roster asks `status --held` (`test:lanes`). First edit of a file another lane changed is
  told with line ranges (`guard` exits 0 with text); same region: message that chat first
  (`test:laneoverlap`).

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

## A restart onto a new build says what changed

Card bottom-right, z-index 59 (`shared/whatsNew.ts`, `main/whatsNew.ts`, `WhatsNewCard.tsx`,
`test:whatsnew`). Bullets from `scripts/release-notes.mjs`, 6 x 120 chars. Silent on fresh
install, ordinary restart, rollback, no bullets, no network. No dialog/focus/animation.

## Never take the screen

Only a click or hotkey earns the foreground. `showInactive()`; `focusWindow()` user-initiated.
`revealPlan()` (`src/main/profile.ts`); self-restart `markQuietRelaunch()`, taskbar flash. No
`dialog.showMessageBox` (`UpdateToast.tsx`), `setAlwaysOnTop`, `moveTop`, `app.focus`.
`spawn`/`Start-Process` `windowsHide: true` (`run-hidden.vbs` on PC). `second-instance` never
raises while `installStarted`. `gameMode.ts` delays, never loses. `test:quiet`.

## Two machines, one desk

`src/main/remote/`, peers. No self-pair (`Remote.probe`, `start()`). Link pane gets
`PF_CHROME_CDP=http://<fromAddress>:9333` (`shared/peerChrome.ts`); Mac `tailscale serve --bg
--tcp 9333`; claude-config `browser/chrome-devtools-mcp.mjs`, `cdp-bg-tab.mjs`,
`chrome-automation.sh` probe it; `wrong-machine.mjs` queues via `remote:handoff`
(`test:peerchrome`). Pty never moves; id `@<device>/<id>`, `remote.owns(id)`.

- Borrow carries `Borrow.person` (`shared/paneSize.ts`); `watched` counts only those; absent =
  yes; `Remote.presenceChanged` on `away`. OWNER publishes `closingAt`.
- Mirror borrows size (`resize(borrowed)`, `returnSize(id)` never `returnSizes()`); smallest
  grid per axis; lease by 30s `pty:visible`, `BORROW_TTL_MS` 90s (`test:panesize`).
- `Remote.closeOn` hides a closed row, `CLOSE_ACK_MS` 3s; `proveAlive` uses an unanswered press
  over `DEAD_MS` 45s. Mirror never reports busy footer.
- Pairing code proved never sent (scrypt, AES-256-GCM); hosting off; UDP discovery; or six
  X25519 digits. `PROTOCOL` 1 (`askpair` refused by older). `test:remote`, `test:pairask`.
- Peer jobs (`shared/backJobs.ts`, `main/backJobs.ts`, `jobs`/`jobslist`, `PeerJobs`): `agent`,
  `dev`, `loop` (`LOOP_MIN_SECONDS`); own tree excluded; `Remote.jobsOn` rejects when
  disconnected (`test:backjobs`).
- Handoff moves WORK not pty (`HandoffDialog.tsx`, `shared/handoff.ts`): repo as `auto-sync:`
  commit, conversation, screen, dev servers; mid-turn queued; sender closes on ack, becomes
  mirror; dirty/unpushed refused by name; paths grafted (`test:handoff`, `test:handofffit`).

## A password gets typed on the machine that needs it

`pf needs-login <site> --url <url> [--host user@ip] [--port 9333] [--machine WORDS]` -> card;
press splits the window, that machine's Chrome right. `shared/remoteLogin.ts`,
`main/remoteLogin.ts`, `RemoteLoginView.tsx`, `LoginCard.tsx`; `test:remotelogin`. ONE frame
in flight (`Page.screencastFrame` -> paint -> `login:ack` -> `Page.screencastFrameAck`);
mid-paint frame REPLACES. `STEPS` 60/40/30 at 1440/960/720; rtt median over `RTT_WINDOW` 20
past `LAGGY_MS` 250 drops a rung, `SLOW_MS` 600 to last; `GOOD_RUN` 20 under `GOOD_MS` 150
buys back; `remote-login.log`; `PF_REMOTE_LOGIN_FAKE_LAG_MS`. Tunnel `ssh -N -L
<free>:127.0.0.1:<port> <host>` `BatchMode=yes` `ExitOnForwardFailure=yes`, port from
`net.createServer`, 15s then stderr on card. Coordinates in MAIN (`toRemotePoint`);
`mapMetaToCtrl`; Cmd/Ctrl+W/+Q/+N never forwarded; paste = `Input.insertText`.
`login:need`/`open`/`input` GATED, `login:list` safe; renderer never speaks CDP. Chrome stays
up; `shutdownLogins()` on quit. NOT `peerChrome.ts`.

## A new pane starts where the work can run

`shared/offloadFirst.ts` decides BEFORE a pty in `startOrSend` above `laneFor`
(`main/index.ts`); `offload.log`; fallback toasts. `StartSessionRequest.where`: `local` final,
`remote` beats PERSON refusals. App-decided move: `OffloadSoon.tsx`, `OFFLOAD_ASK_MS` 8s, `Keep
it here` (`offload:answer`); `offloadAsk` = pressure dialog. Refusals above `always`: `never`,
`keepHere`, `machineBound`, NO PROMPT, `resumes`, `pinnedByPrompt` (outside path,
localhost/port/dev server, screenshot/browser, "on my mac"/"locally"/"here"), dev server
here, unmeasured/unshareable, no peer, `PEER_FULL_PANES` 8. Then `auto` under MEASURED
pressure only (`worstPressure`); never pane count/battery. `test:offloadfirst`.

## The phone is this window, served

Renderer = pure UI over `window.api`; `src/main/phone.ts` serves, `renderer/src/browserApi.ts`
supplies, `src/shared/surface.ts` `SURFACE` is the one channel list. `tapIpc()` top of
`index.ts`; one SSE, `phone.broadcast` before the window check in `send()`. Off until Devices
opened; unpaired = pairing page; wrong codes lock; cookie `hmac(deviceId, code)`.

- `src/main/passkey.ts`: `phone.typeGate` one touch/15 min on `/pf/send`/`/pf/call`, never
  `pty:write`, TLS only, 423; `DESK_ONLY` refuses `phone:typeGate`/`phone:forgetKey`.
- `POST /pf/ask` -> card, digits both screens, 32-byte token; asking off = code in fragment.
  `addressOf` trusts `cf-connecting-ip`/`x-forwarded-for` from loopback only; one row/device;
  `New code` only revoke. Ten-year cookie never revoked on suspicion (`shared/deviceWatch.ts`,
  `phone:clearMark` `DESK_ONLY`). `SameSite=Lax`; `Secure` w/ TLS.
- Reach `main/funnel.ts` (Tailscale) then `main/tunnel.ts` (cloudflared).
- Copy = phone clipboard (`copyText`/`readClipboard`); TEXT via `TextSheet.tsx` (<=8 MB);
  `user-select: none`; `HandheldType` 44px keys.
- Desk owns shape; phone borrows; `clear` never `reset`. `shared/linkState.ts`, `LinkBanner`,
  `LINK_QUIET_MS` 20s (`test:linkstate`). `handheld.ts` + `@media` <720px or coarse <520px;
  `100dvh`; `PaneMenu.tsx`; `isPhoneClient()` gates authority only.
- Automation `scripts/pf-ctl.mjs`, never `open --args`: `pf open <cwd> --prompt "..." [--agent
  A] [--model M]`, `pf list` verifies; `--close-when-done` (`--report-to` default `PF_PANE`;
  `shared/closeWhenDone.ts`, `CLOSE_DONE_QUIET_MS` 8s, `test:closedone`).
- Quiet result delivery: `pf-ctl review <review.json>` for a completed result/update/
  decision/blocker (`docs/reviews-runtime-contract.md`); save request+evidence+identity
  before an evidence-gated close; quiet time/sleep/exit never means done; reports persist
  after closing; reading one never approves it.
- `test:phone`, `test:phoneview`; `window.__pf[id].term.buffer`. Not built: B1, H2.

## One long ask is several panes

`shared/splitPlan.ts`, `main/splitPrompt.ts`, `SplitDialog.tsx`; `test:splitplan`. One headless
CLI run (`HEADLESS` only), EMPTY folder under userData, `--setting-sources ""`,
`--strict-mcp-config`, `--settings '{"hooks":{},"outputStyle":"default"}'` (`--settings` alone
MERGES; `--bare` = `Not logged in`). Not a plan = `null`, quotes 160 chars; every `{` tried.
`MAX_TASKS` 4, overflow in `dropped`. Nothing opens until rows edited.

## A pane can run on somebody else's model

`shared/agents.ts` (`test:agentenv`): `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` only; base
URL NO `/v1` (OpenRouter `https://openrouter.ai/api`). Provider = `KEY_PROVIDERS` + `env`
naming `keyVar(id)`. Probed: DeepSeek/Z.ai 401 in Anthropic shape; xAI no; Grok own CLI
(`~/.grok/bin`, `which.ts`). `siblingModels` under PROVIDER, SAVED key, same `bin`;
`config:set` clears 20s cache; blank key drops token (`missingKeyFor`). `HEADLESS` by id; Grok
absent, `drivable()` refuses. Gemini CLI removed (`GEMINI_DEFAULT_AUTH_TYPE: oauth-personal`
in `~/.gemini/settings.json` dead). Antigravity `agy` (`~/.local/bin` /
`%LOCALAPPDATA%\agy\bin`; `--continue`/`--conversation <id>`; `/model` in TUI; no `uninstall`)
asks `Yes, I trust this folder` unless in `trustedWorkspaces` of
`~/.gemini/antigravity-cli/settings.json`: `main/agyTrust.ts` writes it pre-spawn,
`shared/agyTrust.ts` refusals write nothing (`test:agytrust`).

## ...and the model list is not this build's opinion of what exists

`main/orModels.ts` keeps OpenRouter's list on disk beside `OPENROUTER_MODELS`;
`shared/orCatalogue.ts` (`test:orcatalogue`). `listAgents` sync from MEMORY, fetch via `void`;
any failure leaves the app as is; empty = FAILED. Tool-calling only; both prices; free first;
`Select` searches VALUE (`labelFor`); newest first; stealth says so. Model addressed via the
CLI's own `env`.

## Every colour is derived, and every pane says which project it is in

`src/shared/theme.ts` from one accent, `applyTheme` -> `:root`, `paletteFor` only; Oklab,
`inGamut`; light >~0.9, Paper 0.98; default `#f0a868`. `test:theme` 4.5:1/3:1.
`test:contrast` proves the RENDERED window both themes (SAMPLED backdrop, TEXT NODE boxes,
worst pixel minus 5%, pet hidden, animation killed, 3:1 vs `--muted`, LOGOTYPE exempt,
`readableOn`). `var()` on a missing token never errors: `test:tokens` (only `--agent`,
`--level`, `--mono` absent); `shelf.css` `--acc-rgb`, `light` (`test:stashtheme`).

`src/shared/place.ts` (`test:place`): project name never omitted; trunk -> `PaneForge`;
generated branch (`pf/w2`, `lane-a`, `worktree-<slug>`) dropped; `copy 2` = second checkout,
`pane 3` = third card (Ctrl+3); `-a` stripped only when lane known; no `git status`.

## Every word on screen is read by somebody who has never used git

lane/checkout/trunk/worktree/slot/merge/conflict/free/stuck stay in code. `copy 2` (folder 1,
lane `a` 2, `w2` 2) never `copy f`; `main copy`; `Other copies`; `nobody is using it`.
`copyNumber` (`place.ts`) is the one slot->number. Non-pane chat named via
`LaneBoardEntry.chatTitle` (`lanes:board`, `main/history.ts` `chatNameFor`); no name = nothing
drawn. `test:laneplain`.

## A pane says which client it is working for

`shared/clientName.ts`, `main/clients.ts`; `test:clientname`. Roster =
`clients/<who>/README.md` walking UP; first heading, contact stripped; parenthetical kept
only for a person, not an org; `Client` off. Prompt name matches ONE client, word boundary,
`MIN_ALIAS`, not `GENERIC`. Replace only on STRONG reading (`topicReading`, `repeatedTopic`);
`/clear` empties `topicAsks`. Others get `topicTitle` where `mayTopicName` (client tree,
`Desktop`/`Downloads`/root); real repo waits three agreeing asks, EARLIEST names. Rename is
SILENT: no card, Activity row only (`test:activity`). Pointing ask (`$50 task`) named off the REPLY
(`shared/resolvedName.ts` `handleOf`/`resolvedName`, `sweepResolved` once, app-given names
only; `The agent found what you meant.`; `test:resolvedname`).

## A pane says how long it has been open

Header clock = TURN; `.pt-open` = `openedAt ?? createdAt` (off on phone); History freezes at
`endedAt`. `stepFor` (`src/shared/elapsed.ts`) 1s/<1h, 60s, `Infinity`; one interval; buckets
from the clock's OWN start; not in `Elapsed.tsx`; `formatElapsed` carries days. `test:elapsed`.

## The sessions list is the whole desk, both machines

Your move / Running / Ready / Ended (`shared/fleet.ts`), Ctrl+Shift+F dragged order;
`shared/desk.ts`; `test:desk`. Listing (`remote:changed`) vs mirroring; `openListed`. Listed
row has no NUMBER; real panes all wear one (`.num.far`); grid fits 440x240 tiles
(`gridRoom`/`gridPick`: needs-you first, asleep last, active always), counts the rest. Mirror
listed once; device off/connecting/error = nothing; badge counts both. `Running` = `runSince`
(submit, busy footer, shell command) until `endRun`, or `FleetPane.backJob`; never `status ===
'working'`. `Ready` ≠ `!engaged` (`/clear` drops it; `/compact`/`/resume` don't). Empty Return
engages nothing (`slashTurn.isBareReturn`, `test:slash`). Shell turn ends with its COMMAND,
POSIX. `doneGlow` once (`DONE_GLOW_MS` 1.9s).

## A prompt tag says how long ago it was asked

Rail tip `echo rail  (5 min ago)`, hover-HOLD exact; `whenWords`. Minute clock; no tags =
`Infinity`; offset = NEWEST; `railNow` on bucket turnover; negative = date; `Math.max(railNow,
m.at)`. Restored tag: no clock. Prompts list keeps position. Codex seeding: `›` on
indexed-235, wrapped joined, composer/quotes excluded. Remote history: `replay` (<=4 MiB) then
deltas, both peers; 400 KB buffer fast path; `paneLog` alone never resets. Typed events wait
for output parse; no duplicate to submitter.

## Finding something in a pane

Ctrl/Cmd+F, ⌕, phone `Find in this pane` -> `paneFind`; `3/10`, ↑ ↓, Enter/Shift-Enter; live
buffer only.

## Finding a setting

Finds the SETTING (rows tinted, best edged, rail follows); switch stays in its group. Index
generated (`scripts/settings-index.mjs` -> `src/shared/settingsIndex.ts`, `npm run
gen:settings`; `test:settingsearch`). Hint matches, LABEL outranks; DOM marking;
`scrollIntoView` `nearest`; no animation.

## A card answers a right-click, and can say what it is

`SessionMenu.tsx` desktop menu (pointer, clamped, arrows, Escape); `PaneMenu.tsx` phone sheet
52px. `SessionInfo.tsx` `Open for` from `createdAt` (`useNow`); header stays TURN; polls
nothing. Right-click never wakes (`e.button !== 2` into `touchPane`; `test:autohandoff`).

## Copying a prompt, or the answer it got

Header button beside ⌕: `Last reply`/`Last prompt`/`Last prompt + reply`/`Everything on
screen` with previews; rail-tag right-click = same for THAT turn + `Go to it`. `CopyMenu.tsx`,
`.copy-menu` per `design-vault/linear.app.md`. `shared/replyText.ts` `cleanReply` drops chrome
(`⏺`/`⎿` keep text); real-log fixtures (`test:replytext`). Reply = `rowsOf` + `unwrapCopy`;
left-margin text = paragraphs. Ctrl/Cmd+Shift+C `copyReply` highlight first; `Copy last
reply` on phone/right-click. Every copy toasts a line count (`sayCopied`); select silent.

## A click puts the cursor where you clicked

Click -> arrows to the same cell only (`src/shared/cursorMove.ts`); shell up-arrow is history.
`keysAlongLine` left/right, own line, mouseup, no travel. `composerAt` (`shared/promptBox.ts`):
rule above, SAME-width rule below, marker + U+00A0 (`BLANKS`); `test:promptbox`; only a drawn
box allows up/down. `keysForDelete` one backspace/char, wrapped rows. Swallowed only toward an
AGENT with mouse reporting (`test:stickyselect`). Alt-click other lines, `rowLimit`, clamped.

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

## A pane opened with a prompt sends it

`queuePrompt` (`src/main/sessions.ts`, `test:promptsubmit`). Ready = idle COMPOSER (output
stopped, `readsBusy` false, last PAINTED). Return separate; submit confirmed by TURN (`runSince`
newer); busy waits; idle with no turn gets another return. `/clear` no boot patience;
`PROMPT_ENTER_TRIES` 6; `CLEAR_RESUME_BUDGET_MS` 3 min vs 45s; `autoclear-app.log` `UNSENT`;
`ARM_QUIET_MS` 15s, `ARM_CLEAR_LEAD_MS` 120ms. Codex `gpt-5.1-codex*` = `400 not supported`.

## An agent's question is a row of buttons

`shared/choices.ts`; card RIGHT 260px (full width coarse); `test:askrender`. Needs `Enter to
select` footer, options 1..N, one arrow row. Multi-question end: no footer, `REVIEW` above,
`readReview` DOWN. Refusals: one `❯` over blanks/rules, `don't ask again` (`WIDENS`); RULE =
blank. Arrows + return never digit, `CHOOSE_GAP_MS`; left question REFUSES. `pty:choose` on
the SESSION. RED, NOISY: `.row.asking`, `sounds.ask` `knock` on `sessions:ask`;
Questions: desk + GuardDeck, NEVER Telegram; `askNotify.ts` = stopping ERRORS
(`telegramAsk`). Click types NOTHING (`askRef`; `test:askclick`, `test:choices`).

## Arrowing through a question may not cost the whole desk

One sessions array; `TerminalPane` `memo` + `samePaneProps` (`ask`, `termTheme`, `mirror`,
`grid` BY VALUE). Assertion = BYSTANDER count (`test:askrender`, `window.__pfRenders`). New
`Props` need a `samePaneProps` line.

## ...and a pane that is only PRINTING may not talk to React at all

Same-value `setState` still costs `requestUpdateLane`. `useQuietState`
(`renderer/src/quietState.ts`) compares in a ref before dispatch; `geom`, `selChip`,
`scrolledUp`. Source test `test:quietstate`; `npm run type-profile -- --blame yi`;
`window.__pfDeskRenders`.

## ...and a question with an obvious answer is answered

`shared/autoAnswer.ts`, on, 30s (`test:autoanswer`). BEST: `(recommended)`/`[default]`/`-
suggested` > yes-shaped/arrow; two marked = choice; never past a refusal. Refusals: exactly
ONE yes-shaped, arrow on REFUSED, `don't ask again`/`always`/self-questioning; `anyQuestion`
wider. AWAY wait: `holdWhileWatching` `askHold`, `startOf` = later of it and `askSince`; held
= no countdown (`autoAnswerHeld`); `useNow(1000, at)`. `dueForAuto` two signatures
(`askKeyOf`); one press/identity, `PRESS_COOLDOWN_MS` 4s; `maxRun` clears on BUSY; hold sets
`autoAnswerAt = 0`. Countdown row/chip, `playTick`, `.auto`, `window.__pfTicks`; `defaultsV2`
+ `migrateAutoAnswer` once.

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

## A picture goes in front of the agent

Image off DISK on the pty's machine, path typed (`shared/attach.ts`, `main/attach.ts`,
`test:attach`). ^V raw only same-machine; `@device/id`/browser send bytes; `attachOn`. Name =
clean basename, ext from MAGIC BYTES; 5MB/batch; never auto-submitted. macOS drop
`text/uri-list` (`splitDropUris`; `text/plain` unclaimed). Uncovered: phone paste.

## What a pane costs is measured, not modelled

`capacity.ts` models 190 MB/pane; `src/shared/usage.ts`, `src/main/usage.ts` (`test:usage`).
Pane = descendant TREE; CPU = counter delta never `ps %cpu`; sampler skips hidden, one read in
flight; memory at `FOOTPRINT_MS` 20s (`dueForFootprint`), new pane forces one.

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

## History says what each session was working on

Row = FIRST ask + count (`shared/gist.ts`, `test:gist`) from relayed keystrokes. Newest closed
top (`endedAt ?? startedAt`); `closed 5 min ago`/date; green `open since`, red `closed …`.
`View all` = `summaryFull`. Closed before recording = archive line or none. `/clear` ends a
job (`noteAskInto`); three shown, WORK asks counted, twelve chapters; `recordStart` reruns.
Transcript RENDERED (`renderer/src/termRender.ts`).

## The app remembers what has been asked

`src/main/promptArchive.ts` fed from `shared/draft.ts`. Chip only; `QUIET_MS` 6h is the rule;
submitted lines only. `src/shared/promptKey.ts` MIRRORS three copies (claude-memory hook,
TaskDriver, Discord bot); `test:recall` recomputes canonical answers. `outcome` null.

## Dictation needs nothing installed

Mic per pane, Ctrl/Cmd Shift Space. `shared/voicePick.ts`; `useVoice.ts`: whisper CLI ->
Whisper worker (`voiceWorker.ts`, ONNX wasm) -> phone recogniser (`test:voice`).
`webkitSpeechRecognition` in Electron = `error: "network"`; `bnb4`; wasm via
`electron.vite.config.ts`. Phone `VoiceOverlay.tsx`, ring = level.

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

## ...and a card nobody touched goes away by itself

`shared/cardIdle.ts` `CARD_IDLE_MS` 5 min, `renderer/src/idleDismiss.ts`; pointer/focus HOLDS
(`idleLeft` `null`); one timeout. Only `WhatsNewCard`; `MoveSoon`, `OffloadSoon`,
`AutoClearToast`, `StopServer`, `LoginCard`, `UpdateToast`, `TourCard` end at their own
deadline. `test:cardidle`.

## Every card the app puts in the corner is in ONE column

`.corner-stack` (`App.tsx`/`styles.css`, `test:activity`): `column-reverse`, FIRST = corner;
AutoClear, MoveSoon, Update, WhatsNew, Tips; children `position: static`;
`.beside-pet` lifts 108px once; `pointer-events: none`, `max-height`.

## A dev server nothing can reach is closed, after a countdown

`shared/deadDev.ts`, `main/deadDev.ts`, `StopServer.tsx`; `test:deaddev`. Reading = LISTENING
SOCKET (`listeningPids()`, `lsof -Fp`/`netstat -ano`, DOWN the tree); empty = FAILED, stops
sweep. Refusals: serving, `launchctl list`, `DEAD_AFTER_MS` 90s, kept, pid 1; Windows claims
none supervised. `SWEEP_MS` 60s; deadline 500ms tick; one card, never re-armed; 5s
`config.deadDev`, Settings switch. `stopDevServer` re-validates; bell `stopped`.

## ...and what it did on its own is a list, not just a card that vanished

Bell -> `ActivityFlyout.tsx`; `shared/activity.ts`, `main/activity.ts` `activity.json`. Fed by
`reclaim:log`, `clientNamed`, `armclear`; `armed` not a row; verb column `KIND_WORDS`; a
READING, nothing pressable; opening marks seen. `activity:list`/`seen` `REVIEWED_SAFE`
(`scripts/passkey-test.mjs`).

## ...and one card says what this app can even do

`shared/tips.ts`, `components/Tips.tsx`, `test:tips`. Silent during dialog/update/question/
minimised/`FIRST_MS` 4 min; `EVERY_MS` 40 min; first and every fourth `offersOff` (Settings
re-enables); each once before any twice; `seen` resets.

## A finished pane closes itself into Review

`shared/doneClose.ts` (`test:doneclose`), `main/doneClose.ts`, 15s timer; `config.autoCloseDone`
on. Closes when: agent pane, turn over (`footerEndedAt`), not ACTIVE (`sessions:active`),
`AUTO_CLOSE_QUIET_MS` 3 min past turn end AND last key, `doneEnough`, reply read off
transcript (`shared/replyRead.ts`, `test:replyread`), no running subagent, reply not ending
`?`, `actionableNextSteps` empty. Writes `result`/`unverified` review `done_<pane>_<turn s>`
(`recordReview`, idempotent), then `closeAfterResult`; each `personOwnedSteps` step becomes a
GuardDeck notice, `spoolNotice`'s gate. Review = ONE list (`ReviewDialog.tsx`,
`shared/reviewList.ts`, `test:reviewlist`): Needs you/Done/All, row = number+project+ask+
result, expand = full reply + Reopen (`--resume`) + Copy; shell/bare-slash rows hidden. Idle
shell undrawn (`fleet.ts` `idleShell`) till pressed/run; idle countdown still takes it.

## A session that clears itself asks first

`scripts/autoclear-hook.mjs` (Stop/SessionStart; installer `main/autoclearHooks.ts`, a
foreign autoclear left alone) -> `<userData>/autoclear-requests/<pane>.json` ->
`main/autoclearRequests.ts` -> `autoClearAsk` = `autoclear:ask` (`test:autoclearhook`).
`Keep this session`/`Clear now`; unattended proceeds (`test:autoclear`).
`shared/autoclear.ts` refusals; `main/autoclear.ts` re-checks each tick. `## Next steps:
None` respected. Resume: `queuePrompt` on IDLE COMPOSER; `keep.arm()` 120ms.

## The screen stays on while a pane works

`shared/awake.ts` + `main/awake.ts` `powerSaveBlocker` while mid-turn/asking (`test:awake`).
Cap on BUSY STRETCH; `config.keepDisplayAwake`. `screenUnseen` drops screen hold only;
clamshell + monitor: builtin must be the only screen; failed read = false.

## A pane's two ends open at the same width

Grid never narrower than painted width: `src/shared/paneGrid.ts` (`test:panegrid`). Pty 120 vs
xterm 80 tore `claude --resume` at 119. Fix `redrawHistory` at `max(pane now, replayCols,
START_COLS)`, user-initiated; `window.__pf[id].redraw()`.

## Every prompt this app writes says what done means

`src/shared/promptForge.ts`: task, anchors, scope, done, exemplars; `Done means:` LAST; over
`MAX_PROMPT_CHARS` 6000 drop examples, guidance, tail, never done. Exemplars from
`claude-config/promptlib` (`main/promptForge.ts`, `PF_PROMPTLIB`), `MAX_EXAMPLES` 2 x
`EXAMPLE_CHARS` 600. Users `splitInstruction` (`SPLIT_BUDGET_CHARS` 40,000), `paneBrief`
(idempotent), `resumeBrief` (`noResume` forges nothing). `claude-config/promptlib/harvest.mjs`
(`MIN_FIELDS` 3, no `no_anchor`/`multi_item`). `docs/prompt-review-2026-09-02.md`. `test:promptforge`.

## A pane opened on a task is briefed from the task

`pf open <cwd> --task <id>`: `shared/taskBrief.ts`, `main/backlogStore.ts` reads
`claude-config/ledger/backlog.jsonl` (`PF_BACKLOG`) READ ONLY (`test:taskbrief`). `Done
means:` = `success` + gates; attempts/last refusal carried. No pane on
unknown/ambiguous/finished/no title/no backlog/`--task`+`--prompt`.

## ...and the app counts how often a person had to step in

`shared/interventions.ts`, `main/interventions.ts` -> `Session.interventions`,
`interventions.log`, one `SessionInfo.tsx` line (`test:interventions`). `app` writes never
count (`choose()` -> `write()`, auto-answer `'app'`); unsent typing is nothing.
`docs/agentic-backlog-2026-09-02.md`.

## The other machine's screen is one click away

Quick button beside Review (`shared/screenView.ts`, `main/screenView.ts`; `test:screenview`)
starts Moonlight at the paired peer, online first else configured. Drawn only w/ viewer+peer
(`screenCan`); refusals toast `app:error`; one viewer at a time; `screen-view.log`;
`screen:*` `DESK_ONLY`. Title = MACHINE, not protocol. Native in-app
stream (WebRTC) designed in
`docs/superpowers/specs/2026-09-23-pc-screen-design.md`, not built.

## Checks

On the PC in one command: `node scripts/pc-check.mjs typecheck <suite...>` (rbuild, retries, failures + totals only).
`npm run typecheck`, `npm test` (`scripts/test-all.mjs`, no window/network/CLI); gate step 3
(`agentGate.ts`) needs `test`. Pins: `docs/design-notes.md` **Checks — what each suite pins**.
Window (`test:x`): autoclearlag, view, stashdrag, activate, restorefix, askclick, askrender,
devicesfit, phoneview, contrast, renderwatchlive, panefit, railtrack. Network:
`test:discordbrand`, `node scripts/mac-update-test.mjs --live <v>`. `npm run competitors`
(`test:competitors`).

## A turn the transport cut in half finishes itself

`shared/recover.ts` (`test:recover`) keys on `The response above may be incomplete.`; never
after rate/usage limit, credit, auth, overload; `> ` quoted error is talk (`promptBox`); three
in a row stops; new output only; sends via `queuePrompt`.

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

## Gotchas that look like mistakes

`package.json` `description` = "PaneForge" (exe FileDescription); `name` stays
`claude-orchestrator` (`%APPDATA%\<name>`). Icon `node scripts/make-icon.mjs` (`--size N --out
path`), no blob. Badge `git status` async (`execFile`). `.github/workflows/` needs `workflow`
scope (`gh auth refresh -h github.com -s workflow`).

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

## An iPhone is not a Mac, and a phone control is 44px

`test:phonetouch`. `navigator.userAgent.includes('Mac')` is TRUE on iPhone/iPad: `isMac`
refuses iOS and coarse-only; hints hidden. Handset home = sessions list, controls 44px (row
close 40x40). Reads BUILT css, FIRST `@media (pointer: coarse)` block; `html.handheld .pt-more`
loses to later `.pane-title .icon`; `.icon.help` own `min-width`.
