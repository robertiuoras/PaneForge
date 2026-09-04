# PaneForge

Electron app that hosts coding agents in panes. It hosts the chat you are reading this in,
which shapes every rule below.

**This file is the short form, and it is loaded on every turn in this repo.** It has a
12,000-token cap and drifted to 39,000 once, so: **a rule, never its history.**

- Why a rule exists — the measurement, the trap, the hours it cost — is in
  `docs/design-notes.md`, one section per heading below, same titles.
- The full long form this file was trimmed from on 2026-08-31 is
  `docs/claude-md-full-2026-08-31.md`, verbatim, same headings.
- **Read the matching section there BEFORE CHANGING the thing.** The rule alone is enough to
  work beside it. Never re-derive a decision either file already records.
- Anything you would add here that reads as a story goes in `docs/design-notes.md` instead.

## Never close the app you are running inside

The installed `PaneForge` is the live app; killing it ends this session mid-turn. Open a second
copy to see a change:

```
npm run try                     # own profile, minimized, no focus
npm run try -- --show           # on screen, still no focus
npm run try -- --close
```

Profiles (`src/main/profile.ts`) give the copy its own userData, single-instance lock, config,
taskbar button. Never `npm run setup`, `Stop-Process PaneForge`, or the NSIS installer.

## Lanes: more than one chat works on this repo

Hook assigns each session a lane — `main` (master) or worktree `PaneForge-a`/`-b`/`-c` on
`lane-a`/`-b`/`-c`. Only write in your lane; PreToolUse refuses elsewhere. `node
scripts/lane.mjs status --repo <dir>` shows who holds what.

- Visiting chat gets a letter lane, never `main`, unless it has uncommitted work.
- One engine: `lane.mjs --repo <dir>`. `.lanes.json`: `{ "lanes": false, "branch": "main",
  "release": "merge", "pool": ["main","a"] }`.
- No-remote repos, `claude-memory`: no lanes. Never leave one conflicted.
- Shipped only once `landedOnOrigin` proves it; failed lane stays out of `lastShip.lanes`.
- `state.passed[id]` logs a passed lane. Empty kept a day (`SWEEP_GRACE_MS` 24h).
- ONE PANE HOLDS ONE LANE. A claim drops every other hold wearing the same `PF_PANE`, so a
  chat that cleared itself (new session id, same pane) stops being drawn as a second chat
  in a second copy. A hold with no pane id - claimed by hand, or from outside the app - is
  left alone.
- `npm run test:lanes`.
- Your first edit of a file another lane has already changed is told so, with that lane's
  line ranges (`guard` exits 0 with text). Same region: message that chat before editing.
  `npm run test:laneoverlap`.

## Two desks, one repository

Ledger is one machine's (`<repo>/.git/paneforge-lanes.json`, never pushed). Letter lanes are
local scratch, cannot collide; trunk can, and a release can cut twice.

- Claim carried by ref name `refs/paneforge/claims/<device>/<slot>/<session>/<millis>`; reading
  every device is one `ls-remote`.
- Only trunk asks, only a chat lacking it. `PEER_STALE_MS` 45 min.
- Heartbeat is a turn ending, not a timer, past `REFRESH_MS` (10 min); ending gives trunk back.
- Release lock decided by server: `refs/paneforge/lock/release` is a plain non-forced push of an
  orphan commit. Lock with no timestamped claim is cleared.
- `peerRefs()` returns `null`, not `[]` — never blocks a chat.
- `PF_DEVICE` overrides hostname. `npm run test:lanepeers`, `npm run test:lanedevice`.

## Releasing happens when Robert asks, and not before

`.lanes.json` says `"release": "merge"`: merges into master, pushes; no version cut, no publish.
End of work: build, prove in a second copy (`npm run try -- --keep
--remote-debugging-port=9333`, then `npm run probe`), report numbers, stop. `npm run
typecheck`/`npm test` gate a commit.

```
node scripts/lane.mjs ready --repo <dir> --session <id>
npm run ship   # ONLY when Robert asks
```

`ready` merges master in, refuses while dirty.

**NO RELEASE WITHOUT ROBERT'S WORD IN THIS CHAT** (2026-09-04: "no more releases without
my permission ... stop releasing so many broken builds without testing"). This reverses
the 2026-09-01 standing order. `npm run unreleased` exiting 1 is a REPORT, never a
go-ahead; a release another chat is cutting is not yours to join; "make the dev release"
said yesterday does not cover today. `npm run test:unreleased`.

The dev window's tour (`shared/tour.ts`, `TourCard.tsx`) turns every `feat:`/`fix:`/`perf:`
commit since the installed build into a step: a NAME in the words of the thing on screen
(`A session's header`), the commit's own sentence under it, a ring around the control, and
the commit's own `scripts/<x>-test.mjs` RUN on the card with the result. The name comes
from the commit's SCOPE first (`fix(header):` -> `SCOPE_PLACES`) and only then off the
files touched - a header fix editing nothing but `src/shared/headerFit.ts` read as
`inside the app, nothing to click` (Robert 2026-09-04, step 4 of 30). A step about a pane
OPENS one: the pane on the desk is brought forward, or one plain SHELL pane is opened in
this checkout - never an agent CLI, so it costs nothing and leaves no conversation. Every
suite a step ran is ONE verdict line with the counts added up (`checkedAll`); two rows
saying `Checked - 34 things proved` over `Checked - 38 things proved` read as the card
disagreeing with itself. Next ticks the step it leaves off once the tour is STARTED, so a
step that waits for you still counts; Previous ticks nothing. It WAITS to be started and then plays itself - opens each
step's surface, counts down visibly (`dwellFor`) and ticks the step off on its way out;
only Pause stops it, Previous and Next steer and it carries on from where they left it
(Robert 2026-09-04: "its just to go to the next thing"). A step with something to DO on it - a surface
opened, a control ringed - has NO clock (`waitsForYou`) and holds until Done or Next.
A step about something AUDIBLE plays it as the step arrives (`demoFor`, `previewSound` -
countdown gets the bowl, a question the knock, anything else the chime; a step about
nothing audible plays nothing). The bar under the header is one SEGMENT per step, lit as
it is ticked. STARTING IS THE APPROVAL: from that press each step's suites run as it arrives, streaming
their counted lines onto the card (`TourProgress`, `app:tourCheckLine`), and a check in
flight holds the tour where it is (Robert 2026-09-04: "if we doing tour then it should do
everything itself", reversing his own earlier per-step approval). Nothing runs before that
press, and after it NO button asks again - a step reached by Next, or sat on while paused,
runs its own checks too (`started`, never `playing`); a running suite shows a discrete
`steps()` pulse, its tally and its last printed line. Progress SURVIVES a reopen: ticks in `tour.done` and every verdict in `tour.checks`, both
localStorage on the dev profile, written the moment a check lands - a step that already
answered arrives wearing `kept from an earlier run` and is not re-run, with `Check again`
for when the thing it proved has just changed. A suite that prints one summary line
(`sounds: 829 checks passed`) is counted from that sentence (`summaryCount`), and a check
with no number says `Checked`, never `0 things proved`. The list holds only commits that touched
`src/`, deduplicated by subject, two `See:` lines each, and no npm script name reaches the
card (`checkWords`, never `checkName`). No pane is opened and no prompt is
typed (Robert 2026-09-04: "i dont want the try in pane testing helper"), so a `Try:` line
in a commit body is read by nothing. Every such commit body carries `See: <what Robert
should see on screen>` lines, one per thing; without them the card shows the body's first
paragraph. `npm run test:tour`.

A dev window opened with `--show` is one a person is watching, so nothing else closes it:
`npm run try -- --show` records its pid and `closeTestApps` spares that process and its
children. Only `--close` and the next `npm run try` take it (`force`). Before this, any
other chat's `npm test`, any window suite and every `lane.mjs ready` shot it - three quits
in 26 minutes on 2026-09-04, each logged as "something asked from outside".
`npm run test:devkeep`.

A change is tested in a DEV WINDOW before anyone asks for a release, on both machines:
`npm run try -- --pull --show` fast-forwards that checkout to origin, builds, and opens
the copy on screen without focus. Merged from the PC and wanted on the Mac: open a pane
on the Mac (New session, "Where it runs") with that command; the reverse the same way.

When asked for (`"release": "version"`):

- Below 1.0, patch only: `feat:` patch, `feat!:` minor, larger typed (`ship minor|major`).
- One release/2h (`COOLDOWN_MS`); manual `npm version`/`git tag`/tag push blocked; `npm run ship`
  skips the gate.
- Stops release, named: master not typechecking, `npm test` failing (`suiteFailure`), conflict.
  `npm run test:gate`.
- Notes from commit subjects between tags (`scripts/release-notes.mjs`); only
  `feat:`/`fix:`/`perf:` reach the page. `npm run test:notes`.
- Check asset size before fixing `latest.yml` (`reconcileFeed`). `npm run test:laneargs`.
- The tag push publishes it: the `Release` workflow builds mac AND win. `npm run release` is
  `scripts/release.mjs`, a GUARD and not the publisher - it refuses to publish over a release
  already carrying every asset for this platform, refuses BEFORE the build when there is no
  `GH_TOKEN`, refuses when GitHub cannot be asked, and holds the served bytes against `dist/`
  afterwards. `npm run release:verify` is that last check on its own; the feed is judged by
  the rows it declares, never by its own byte count. `npm run test:release`.
- Never reach past the guard to `electron-builder --publish always`: a second publisher left
  v0.8.183 serving 22,020,096 bytes of a 167,357,224-byte zip, with a `latest-mac.yml`
  recording the truncated size and its sha512 - a feed and a corpse that agree look healthy
  from every angle except `dist/`. An asset size that is an exact power of two is a partial
  upload, never a build.
- Auto release = dev prerelease; auto-promotes after `PF_PROMOTE_SOAK_MS` (3d). `lane.mjs
  promote`, `lane.mjs doctor`, `npm run test:promote`.

Never cut one while a next step is open.

## An update may never need a person

Install once, update from app; hand-reinstall = defect.

- Unsupported: skip not retry (`shared/pickRelease.ts`); none installable -> "no update". `npm
  run test:pickrelease`.
- Restart: `deskBusy` (`shared/updateHold.ts`) till `DESK_QUIET_MS` 10min. `npm run
  test:updatehold`.
- `phaseAt`/phase; `CHECK_BUDGET_MS` 2min, `DOWNLOAD_BUDGET_MS` 45min, `PROBE_BUDGET_MS` 5min,
  `POLL_WATCHDOG_MS` 6min. Quit gated `stagedInstallable()`, never `phase==='ready'`.
- `update-health.json`: feed+wedges; 3d->`STALE`. `npm run test:updater`, `npm run test:wedge`.

## ...and a pane that says it is working, on a frame nobody repainted

Busy read is the bottom of the pane's screen (`shared/busy.ts`); a torn mid-paint CLI strands
its line. `shared/staleFrame.ts`; `npm run test:staleframe`.

- Silence not the tell — `busyUntil` renewed, `checkBusy` on a 4s tick.
- Signature=evidence (`busyEvidence` + `staleSignature`).
- Recovery: `sessions.redraw`, SIGWINCH nudge, no keystrokes.
- `STALE_AFTER_MS` 4min, `MAX_NUDGES` 2/stretch, `NUDGE_EVERY_MS` 1min, mirror judges nothing,
  `autoFixUi` off = no. `window.__paneBusy[id].stale`.

## A window that stops answering comes back on its own

`shared/renderWatch.ts` + `main/renderWatch.ts`. Main, pty, desk survive a wedged window.

- `reload()` can't preempt it: `forcefullyCrashRenderer` kills first, reload from
  `render-process-gone` (`PROBE_DEAD_MS` 20s + one 5s tick).
- `executeJavaScript('1')` per `PROBE_EVERY_MS` 5s, `GRACE_MS` 10s.
- `RELOAD_COOLDOWN_MS` 60s, `MAX_RELOADS` 3, then left shipped.
- Dead renderer rebuilt; `activate` asks `alive()`.
- Panes return via desk.json + `--resume`; no focus/show/top.
- Evidence: `paneforge-errors.log`; cpu via `getAppMetrics().cpu.percentCPUUsage` (delta).
- `npm run test:renderwatch`; `PF_PORT=9334 npm run test:renderwatchlive`.

## A fault the app survived is a fault nobody hears about

`crash.ts` swallows faults, `renderWatch.ts` recovers silently. `shared/faultNotify.ts` decides,
`main/faultNotify.ts` posts on `askNotify.ts`'s channel. `npm run test:faultnotify`.

- Test copy pages nobody (`profileName()`); drill isn't a fault; unregistered kind not sent;
  `MAX_PER_RUN` (5) per run.
- Only `reload`, `recreate`, `still wedged` leave the machine.
- Signature blanks digits; `QUIET_MS` (30 min) per wedge.
- Listener on `crash.ts`, not a call inside it.
- Silent with no `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`; never awaited.

## A restart onto a new build says what changed

One card, bottom-right, z-index 59, below the update prompt. `shared/whatsNew.ts`,
`main/whatsNew.ts`, `WhatsNewCard.tsx`. `npm run test:whatsnew`.

- Bullets from `scripts/release-notes.mjs`, machine half of each subject stripped, capped at 6
  sentences of 120 characters.
- Refusals: fresh install, ordinary restart, rollback, body with no readable bullets say nothing.
- No network says nothing, does not remember version; the silent paths that do remember have
  nothing to come back for.
- Not a dialog, no focus, no animation.

## Never take the screen

Nothing the app does on its own may take focus, raise a window, or pop a dialog. Only a click or
hotkey earns the foreground.

- `showInactive()` for a window nobody asked for; `focusWindow()` user-initiated only.
- `revealPlan()` in `src/main/profile.ts` decides launch reveal per platform. Self-decided restart
  calls `markQuietRelaunch()` first; new process starts inactive, flashes taskbar.
- No `dialog.showMessageBox` for app-decided anything — use `UpdateToast.tsx`. No `setAlwaysOnTop`,
  `moveTop`, `app.focus`.
- Every `spawn`/`Start-Process` keeps `windowsHide: true` (PC ignores for detached spawns; wrap in
  `run-hidden.vbs`).
- `second-instance` must not raise the window while `installStarted` is set.
- Game mode may delay, never lose, the window (`gameMode.ts`). `npm run test:quiet` pins both.

## Two machines, one desk

`src/main/remote/` lets a second device drive this one's panes. Both ends are peers.

- No self-pair: `Remote.probe` refuses id==ours; `start()` drops one already saved.
- A pane started over the link is told where the asking desk's Chrome is:
  `PF_CHROME_CDP=http://<address it connected from>:9333` (`shared/peerChrome.ts`, host stamps
  `fromAddress` on `start`). The Mac serves its CDP port on the tailnet (`tailscale serve --bg
  --tcp 9333`); claude-config's `browser/chrome-devtools-mcp.mjs`, `cdp-bg-tab.mjs` and
  `chrome-automation.sh` probe it before use, and `wrong-machine.mjs` (PC PreToolUse) queues a
  pane back through `remote:handoff` when a call needs the Mac. `npm run test:peerchrome`.
- Pty never moves: agent, checkout, transcript, worktree stay put. Session id `@<device>/<id>`;
  `remote.owns(id)` routes every message.
- A borrow says whether a PERSON is at the screen holding it (`Borrow.person`,
  `shared/paneSize.ts`). `watched` - the one "somebody is looking" reading a headless desk
  has - counts only borrows with somebody there, so a mirror on an empty desk no longer
  holds the owner's pane off its idle clock for the life of the link (2026-09-04: three PC
  panes idle against a 5-minute clock, no close, no countdown). Absent means yes; the
  borrowing desk re-states it on every `away` change (`Remote.presenceChanged`). The
  deadline itself is still published by the OWNER (`closingAt`), so both machines draw the
  same countdown.
- Mirror borrows terminal size, never owns it (`resize(borrowed)`, `main/sessions.ts`);
  `returnSize(id)` per-pane, never `returnSizes()`. Smallest grid wins across borrowers
  (`shared/paneSize.ts`, per axis); borrow = lease, `at` renewed by 30s `pty:visible`, expires
  `BORROW_TTL_MS` (90s). `npm run test:panesize`.
- `Remote.closeOn` hides a closed row on a live link, restores after `CLOSE_ACK_MS` (3s);
  `proveAlive` treats an unanswered press as the liveness probe instead of `DEAD_MS` (45s). Mirror
  never reports the busy footer.

Pairing code never sent, only proved; keys derive from it (scrypt, AES-256-GCM). Hosting off till
switched on; discovery = UDP broadcast, no secret. Or a button: six digits from an X25519
exchange. `PROTOCOL` stays 1: older build refuses `askpair`. `npm run test:remote`, `npm run
test:pairask`.

Paired machine says what's running outside panes (`shared/backJobs.ts`, `main/backJobs.ts`,
`jobs`/`jobslist` frame, `PeerJobs`): agent CLI (`agent`), dev server (`dev`), script older than
`LOOP_MIN_SECONDS` (`loop`); pane's own tree left out. `npm run dev`+`next dev` child = one server;
agent-started dev server differs. `Remote.jobsOn` rejects when disconnected (`[]` = "running
nothing"). `npm run test:backjobs`.

Handoff moves the WORK, never the pty. `HandoffDialog.tsx` asks which machine; travels: repo as
`auto-sync:` commit, conversation, screen, dev servers; mid-turn pane queued, never killed. Sender
closes only on far end's ack, reappears as a mirror. Dirty/unpushed checkout refuses that pane by
name; paths graft onto receiver's root (`shared/handoff.ts`). `npm run test:handoff`, `npm run
test:handofffit`.

## A password gets typed on the machine that needs it

A scheduled job on the other desk cannot type. `pf needs-login <site> --url <url> [--host
user@ip] [--port 9333] [--machine WORDS]` puts a card up here; pressing it splits the
window - chat left, that machine's automation Chrome live on the right - and the person
signs in. `shared/remoteLogin.ts` is the arithmetic, `main/remoteLogin.ts` the ssh tunnel
and the CDP socket, `RemoteLoginView.tsx` the picture, `LoginCard.tsx` the card.
`npm run test:remotelogin`.

- ONE frame in flight, never a queue: `Page.screencastFrame` -> paint -> `login:ack` ->
  `Page.screencastFrameAck`, which is what asks Chrome for the next. A slow link loses
  frame RATE and never grows a backlog. A frame arriving mid-paint REPLACES the one
  waiting, so what is drawn next is the present.
- `STEPS` is the ladder (quality 60/40/30 at 1440/960/720). Median rtt over `RTT_WINDOW`
  (20) past `LAGGY_MS` (250) drops one rung, past `SLOW_MS` (600) goes straight to the
  last; `GOOD_RUN` (20) frames under `GOOD_MS` (150) buys one back. Every change is a line
  in `remote-login.log`. `PF_REMOTE_LOGIN_FAKE_LAG_MS` stubs lag into the ack path.
- The tunnel is `ssh -N -L <free>:127.0.0.1:<port> <host>` with `BatchMode=yes` and
  `ExitOnForwardFailure=yes`: Chrome's debugger refuses a non-loopback Host, and both ends
  of the forward are 127.0.0.1, so nothing on the far machine is reconfigured. The local
  port comes from a `net.createServer` probe; 15s to answer, then the ssh stderr is on the
  card in full.
- Coordinates are converted in MAIN, off the frame metadata (`toRemotePoint`) - the
  renderer sends its own canvas point and size. Cmd is carried across as Ctrl against a
  Windows Chrome (`mapMetaToCtrl`); Cmd/Ctrl+W, +Q and +N are never forwarded; paste is
  one `Input.insertText`.
- `login:need`, `login:open` and `login:input` are GATED (passkey); `login:list` and the
  view's housekeeping sends are reviewed-safe. The renderer never speaks CDP.
- Chrome and the tab stay up when the view closes - the signed-in session IS the point.
  `shutdownLogins()` on quit, so no ssh child outlives the app.
- Related, NOT this: `shared/peerChrome.ts` shares the MAC's Chrome with PC panes. Do not
  merge them.

## A new pane starts where the work can run

`shared/offloadFirst.ts` decides BEFORE a pty exists, in `startOrSend` above `laneFor`
(`main/index.ts`), for + button, `pf open`, split and phone alike. Every answer is a sentence in
`offload.log`; a fallback says so in a toast. The New session dialog offers the pick while a
peer is online (`StartSessionRequest.where`: `local` is final, `remote` beats every refusal
about the PERSON, never one about reach). An APP-decided move is announced first:
`OffloadSoon.tsx` counts `OFFLOAD_ASK_MS` (8s) with `Keep it here`; nobody pressing = it
goes (`offload:answer`). `offloadAsk` is the pressure path's dialog. `npm run test:offloadfirst`.

- Refusals first, above `always`: `never`, `keepHere`, `machineBound`; NO PROMPT (a person about
  to type - the Mac is the desk, a bare + never leaves it); `resumes`; `pinnedByPrompt` (a path
  outside the project, localhost/port/dev server, screenshot/browser, "on my mac"/"locally"/"here");
  a dev server already serving the project here; unmeasured or unshareable folder; no live peer;
  peer at `PEER_FULL_PANES` (8).
- Then `auto`: remote only when this machine is MEASURED under pressure (memory verdict or lag
  band, `worstPressure`). Never a pane count, never the battery - both sent every briefed pane
  off the Mac (2026-09-03).
- Pinning local is the cheap mistake; a pane on the PC told to open a Mac-only file is the dear one.

## The phone is this window, served

Renderer imports nothing from Electron/Node — pure UI over `window.api`, so phone client = that
object over HTTP: `src/main/phone.ts` serves the renderer, `renderer/src/browserApi.ts` supplies
it, `src/shared/surface.ts`'s `SURFACE` = the one list both build from (no channel = no compile).
Add channels there only.

- `tapIpc()` at top of `index.ts`, above every registration; one SSE stream, `phone.broadcast`
  ahead of the window check in `send()`. Off until Devices opened; unpaired → pairing page only,
  wrong codes lock the address. Cookie `hmac(deviceId, code)`, derived not stored.
- Watching/typing differ (`src/main/passkey.ts`): `phone.typeGate` costs a passkey touch per
  15-min window, on `/pf/send`/`/pf/call`, never `pty:write`, TLS only, 423 refuses the whole
  batch. `DESK_ONLY` refuses `phone:typeGate`/`phone:forgetKey`.
- Scan asks, desk answers: `POST /pf/ask` → card, digits both screens; Approve mints a 32-byte
  token; asking off puts the code in the URL fragment. Behind a tunnel every client is 127.0.0.1:
  `addressOf` trusts `cf-connecting-ip` (then `x-forwarded-for`) only from loopback; one
  row/device, `New code` is the only revoke.
- Ten-year cookie never revoked on suspicion (`shared/deviceWatch.ts`); `phone:clearMark` is
  `DESK_ONLY`. `SameSite=Lax` never `Strict`; `Secure` only w/ TLS.
- Reach: `main/funnel.ts` (Tailscale) first, `main/tunnel.ts` (cloudflared) fallback.
- Phone copy = phone's clipboard (`browserApi.ts` `copyText`/`readClipboard`); output also served
  as TEXT (`TextSheet.tsx`, off-screen xterm, ≤8 MB, never stripped). Text opts into selection
  (`user-select: none`); keys a phone lacks drawn (`HandheldType`, 44px).
- Desk owns pane shape; phone borrows, remembered across resize; column change clears buffer,
  repaints (`clear`, never `reset`). `shared/linkState.ts`+`LinkBanner`: phone can't read "desk
  asleep" off its rows. `LINK_QUIET_MS` 20s. `npm run test:linkstate`.
- Not a small desktop: `handheld.ts`+`@media` <720px or coarse <520px tall → list/panes via
  `display: none`; `100dvh` not `100vh`; actions behind ⋯ → `PaneMenu.tsx`; `isPhoneClient()`
  gates authority only.
- Automation via `scripts/pf-ctl.mjs`, never `open --args`: `pf open <cwd> --prompt "..."
  [--agent A] [--model M]`, `pf list` to verify. Pane closes itself: `--close-when-done`
  (`--report-to`, default `PF_PANE`); `shared/closeWhenDone.ts`: no shell/background job left,
  `CLOSE_DONE_QUIET_MS` (8s). `npm run test:closedone`.
- `npm run test:phone`,`npm run test:phoneview`. Text: `window.__pf[id].term.buffer`
- Not built: headless host(B1), phone diff(H2)

## One long ask is several panes

`shared/splitPlan.ts` rules, `main/splitPrompt.ts` reading, `SplitDialog.tsx` screen.
`npm run test:splitplan`.

- The reading is an agent CLI run ONCE, headlessly; the only agent this app starts outside a pane.
  `HEADLESS` holds only CLIs measured answering a one-shot prompt; one without is refused.
- Runs in an EMPTY folder under userData, with `--setting-sources ""`, `--strict-mcp-config` and
  `--settings '{"hooks":{},"outputStyle":"default"}'`. `--settings` MERGES into the user's settings
  and never covered CLAUDE.md: with it alone the desk's Stop hook blocked, the CLI answered again,
  and `-p` printed only that second message — the plan was thrown away. `--setting-sources ""` loads
  none of user/project/local. `--bare` also works and cannot be used: it answers `Not logged in`.
- An answer that is not a plan is `null`, never an empty plan — refusal quotes the first 160 chars said.
- Every `{` is tried when reading the object out of the answer, not only the first.
- `MAX_TASKS` is 4 — the lane pool; everything over it is NAMED in `dropped`.
- Nothing opens until the rows have been read: title, folder and whole brief are editable.

## A pane can run on somebody else's model

`shared/agents.ts`: one binary pointed elsewhere. Claude Code reads `ANTHROPIC_BASE_URL`/
`ANTHROPIC_AUTH_TOKEN` only; separate ids, not a switch on `claude`. `npm run test:agentenv`.

- Base URL carries NO `/v1`; CLI appends `/v1/messages`. OpenRouter: `https://openrouter.ai/api`.
- Provider = entry in `KEY_PROVIDERS` + agent whose `env` names `keyVar(id)`.
- "Anthropic-compatible" probed, never read: DeepSeek/Z.ai 401 in Anthropic's shape; xAI doesn't — Grok
  is its own CLI (`~/.grok/bin`, via `which.ts`).
- `siblingModels` borrows sibling models under the PROVIDER heading; only SAVED key, same `bin`.
  `config:set` invalidates the 20s cache.
- Blank key drops token, keeps base URL (`missingKeyFor`).
- `HEADLESS` keyed by agent id; Grok absent, `drivable()` refuses.

Gemini CLI removed 2026-08-26. `GEMINI_DEFAULT_AUTH_TYPE`: `oauth-personal` in
`~/.gemini/settings.json` keeps hitting the dead endpoint.

Antigravity (`agy`, id `antigravity`): Go binary, `~/.local/bin` or `%LOCALAPPDATA%\agy\bin`.
`--continue`/`--conversation <id>`. No model list; `/model` in TUI picks one. No `uninstall`.
It asks `Yes, I trust this folder` in any folder absent from `trustedWorkspaces` in
`~/.gemini/antigravity-cli/settings.json` - no flag, no trust-all, and `toolPermission`
answers something else. `main/agyTrust.ts` puts the pane's folder there before spawn;
`shared/agyTrust.ts` holds the refusals (no settings file, unparseable file, relative path,
folder already listed - each writes nothing). `npm run test:agytrust`.

## ...and the model list is not this build's opinion of what exists

`main/orModels.ts` keeps OpenRouter's own public list on disk beside hand-written `OPENROUTER_MODELS`
shortcuts; `shared/orCatalogue.ts` turns it into the menu. `npm run test:orcatalogue`.

- `listAgents` is synchronous, reads the catalogue from MEMORY, kicks the fetch with `void`. Missing,
  stale, empty, offline, 502, error page: each leaves the app as it was. An empty answer is a FAILED
  answer, never written over a good one.
- Only models that can call tools; a row not declaring parameters is dropped.
- Nothing capped; every row carries both prices. Free models lead under their own heading. `Select`
  searches the VALUE too (`labelFor` strips the vendor). Newest first, both groups.
- A stealth model says so in the hint: anonymous provider retains prompts/completions.
- How a CLI addresses the model is read off its own `env`, never a list of ids.

## Every colour is derived, and every pane says which project it is in

No palette. `src/shared/theme.ts` computes one from a single accent; `applyTheme` writes CSS variables
onto `:root`. Colours added via `paletteFor` only. Oklab: hue/chroma held, lightness sweeps, `inGamut`
binary-searches chroma. Light themes above ~0.9 depth; Paper 0.98. Default accent `#f0a868`.
`npm run test:theme`: 4.5:1 body, 3:1 secondary.

`npm run test:contrast` proves the RENDERED window, both themes, desk + Settings/Devices/History:
backdrop SAMPLED not walked, rect is TEXT NODE line boxes (worst pixel minus worst 5%, five points
hit-tested), pet hidden, animation killed, secondary held to 3:1 vs `--muted` (LOGOTYPE exempt).
`readableOn` sweeps each lightness from all four surfaces plus each tinted 16% with the colour itself.

`var()` naming a missing token never errors — check against `paletteFor`'s keys; only `--agent`,
`--level`, `--mono` absent. Stash (`shelf.css`) adds `--acc-rgb` and `light` class off `--bg`
luminance; `npm run test:stashtheme` refuses a colour literal outside `var()`.

Every pane says which project it is in: `src/shared/place.ts` turns folder, branch, worktree suffix,
lane id into words. `npm run test:place`, 56 assertions.

- Project name never omitted/abbreviated. One pane, one repo, trunk → `PaneForge`.
- Trunk branch answered; generated copy branch (`pf/w2`, `lane-a`, `worktree-<slug>`) dropped.
- `copy 2` = second checkout, `pane 3` = third card, Ctrl+3 reaches it.
- `-a` stripped only when caller knows lane; `-w<digits>` off unasked.
- Sidebar has no `git status`.

## Every word on screen is read by somebody who has never used git

The reader is a vibe coder. Machinery words - lane, checkout, trunk, worktree, slot, merge,
conflict, free, stuck - stay in the code and the comments; the screen says what the thing IS.
A copy of a project folder is `copy 2` (the project's own folder is 1, so lane `a` is 2 and
legacy `w2` is 2), never `copy f`. `main copy`, never `main checkout`. `Other copies`, never
`Lanes elsewhere`. `nobody is using it`, never `free`.

- `copyNumber` in `src/shared/place.ts` is the one place a slot becomes a number.
- A row about a chat that is not a pane here names that chat: `LaneBoardEntry.chatTitle`,
  joined in `index.ts`'s `lanes:board` from `main/history.ts` `chatNameFor` on the
  conversation id. No name on disk = nothing drawn, never a guess.
- `npm run test:laneplain` pins all of it, including "no heading calls a copy a lane".

## A pane says which client it is working for

Every pane in a client tree was called `clients`. `shared/clientName.ts` rules, `main/clients.ts`
disk, `ClientToast.tsx` card. `npm run test:clientname`.

- Roster recognised by SHAPE - `clients/<who>/README.md`, walking UP from folder; name is README's
  first heading, contact stripped. A parenthetical is dropped UNLESS it is a person (2-3 capitalised
  latin words, no business furniture, initials not the outer name spelled out) - `A4 Advocate (Adie
  Bradley)` is `Adie Bradley`; `PIA Team (Property Investors Alliance)` stays `PIA Team`. A trailing
  or leading `Client` word comes off.
- Slug is client only when roster says so; prompt name must match ONE client, word boundary,
  `MIN_ALIAS` chars, unique, not `GENERIC`.
- A subject already on a card is replaced only by a STRONG reading - `topicReading` marks
  `repeatedTopic` strong and a first-ask phrase a guess - so the errand the first asks were
  about cannot hold the card through the job that follows. `/clear` empties `topicAsks`, so
  the next three agreeing asks re-name the pane; the old name stands until they do.
- Other panes get SUBJECT of first ask (`topicTitle`) - a phrase, `Set Up Meta Ads`, not a keyword;
  nothing replaces client/typed title. `mayTopicName` is true inside a client tree AND in a folder
  that names no project (`Desktop`, `Downloads`, the projects root); a real repo keeps its own name
  until three asks agree (`repeatedTopic`), which then names it off the EARLIEST of those asks.
- Rename happens, THEN reports; `Cancel` restores folder name, sets `clientOff`.
- An ask that POINTS at its subject (`$50 task`, `task from yesterday`, `that client`) is named
  off the REPLY: `shared/resolvedName.ts` reads the handle off the ask (`handleOf`) and the first
  reply line `<handle> = Name` / `is` / `:` / `->` (`resolvedName`); `sweepResolved` in
  `main/sessions.ts` reads only output since that ask, once, and only while the card still wears
  an app-given name. Toast says `The agent found what you meant.` `npm run test:resolvedname`.

## A pane says how long it has been open

Header clock is the TURN, resets when agent finishes; `.pt-open` is `openedAt ?? createdAt`, off
header on phone. History carries the same number frozen at `endedAt`. `npm run test:elapsed`.

- Clock woken no faster than READ. `stepFor` (`shared/elapsed.ts`): 1s under an hour, 60s past it,
  `Infinity` for a frozen clock. One interval serves the app.
- Buckets measured from the clock's OWN start, never wall clock.
- Arithmetic in `src/shared/elapsed.ts`, not `Elapsed.tsx` (test can't load JSX). `formatElapsed`
  carries days.

## The sessions list is the whole desk, both machines

No Fleet screen. Sidebar groups Your move / Running / Ready / Ended (`shared/fleet.ts`),
Ctrl+Shift+F back to dragged order (`localStorage`). `shared/desk.ts` arithmetic. `npm run
test:desk`.

- Listing (fields on `remote:changed`) vs mirroring (byte stream + xterm buffer); `openListed`
  turns one into the other.
- Order in a group is sidebar's own numbering. A listed row has no pane NUMBER; a real row's
  number comes off the full ordered list.
- Mirrored pane never listed twice; device off/connecting/error lists nothing. Badge counts both
  machines.
- `Running` = `runSince` (submit keystroke, busy footer, shell command), ended by `endRun`, or a
  background job (`FleetPane.backJob`); never `status === 'working'`. `Ready` is not `!engaged`:
  `/clear` drops `engaged`; `/compact`/`/resume` don't.
- Return at EMPTY composer engages nothing: `slashTurn.isBareReturn` reads keystrokes, not
  `typed === ''`. `npm run test:slash`.
- Shell pane's turn ends with its COMMAND, no quiet clock. POSIX only.
- `doneGlow` runs ONCE (1.9s, `DONE_GLOW_MS`).

## A prompt tag says how long ago it was asked

Rail hover tip: `echo rail  (5 min ago)`; hover-HOLD shows exact moment. Same `whenWords` as
History's rows.

- Clock is a minute, never a second. No tags subscribes to nothing (`Infinity`). Offset is the
  NEWEST tag's own moment.
- `railNow` only moves on a bucket turnover; `whenWords` answers negative age with full calendar
  date. `Math.max(railNow, m.at)`.
- A tag rebuilt from a restored pane's output has no clock, says nothing about one.

## Finding something in a pane

Ctrl/Cmd+F, ⌕ in pane header, or phone's `Find in this pane` — all `paneFind`, map `TerminalPane`
registers in. Highlights matches, counts them (`3/10`), steps ↑ ↓ or Enter/Shift-Enter. Searches
live xterm buffer only, to that pane's scrollback.

## Finding a setting

Search box finds the SETTING, not the page: matching rows tinted, best scrolled to and edged in
accent, rail follows to that tab. A switch stays in the group that explains it.

- Index GENERATED from dialog's own source (`scripts/settings-index.mjs` →
  `src/shared/settingsIndex.ts`, `npm run gen:settings`). `npm run test:settingsearch` regenerates
  in memory, fails on disagreement.
- Found by hint as well as name; LABEL hit outranks hint-only.
- Marking done to the DOM, not a `highlight` prop threaded through tab bodies.
- `scrollIntoView` is `nearest`, never `center`. No animation.

## A card answers a right-click, and can say what it is

`SessionMenu.tsx` is the desktop context menu — at pointer, clamped on screen, arrow keys, Escape.
Not `PaneMenu.tsx`, the phone's bottom sheet with 52px rows.

`SessionInfo.tsx` is "see info" the card lacks room for. `Open for` counts from `createdAt`
through `useNow`; header clock stays the TURN. Rest is a reading already held; opens poll
nothing.

## Copying a prompt, or the answer it got

One copy button in the pane header beside ⌕, never a floating one: it opens a menu -
`Last reply`, `Last prompt`, `Last prompt + reply`, `Everything on screen` - each row with a
one-line preview of what it would put on the clipboard. Right-click on a rail tag gives the
same menu for THAT turn (`Copy this prompt / Copy its reply / Copy both / Go to it`); the tag is
the turn's stable handle. `CopyMenu.tsx`; `.copy-menu` follows `design-vault/linear.app.md`.

- `shared/replyText.ts` `cleanReply` drops the CLI's chrome before the clipboard: composer box,
  rules, `esc to interrupt`/`? for shortcuts` footers, spinner rows; `⏺`/`⎿` rows keep their
  text, marker stripped. Fixtures are real history-log rows. `npm run test:replytext`.
- Reply = rows after the prompt tag to the row before the next tag (`rowsOf`), then
  `unwrapCopy`'s join.
- Ctrl/Cmd+Shift+C (`copyReply`) copies a live highlight first, else the last reply; phone's
  ⋯ sheet and the card's right-click carry `Copy last reply`.

Every copy reports in toast with line count (`sayCopied`): Ctrl/Cmd+C, right-click, copy `y`,
selection chip. Copy on select is silent.

## A click puts the cursor where you clicked

A click can only become arrows reaching the same cell (`src/shared/cursorMove.ts`). Trap:
up-arrow in a plain shell is the previous command, not a movement.

- `keysAlongLine` sends left/right only, on the cursor's own line, on mouseup, only if the pointer
  did not travel.
- `composerAt` (`shared/promptBox.ts`) needs a rule above, one of SAME width below, a marker
  followed by U+00A0 (`BLANKS`). `npm run test:promptbox`.
- Only a drawn input box lets a bare click go up/down; plain shell draws none. `keysForDelete`
  sends one backspace per character, cursor's own line, wrapped rows only.
- Click swallowed only en route to an AGENT (`stopPropagation`, kept only while CLI mouse
  reporting on). `npm run test:stickyselect`.
- Alt/Option-click reaches other lines, refuses beyond `rowLimit`; column clamped to that row.

## A shell pane says what it is running

"Is this pane working" is about an AGENT. `shared/paneJob.ts`; `npm run test:panejob`.

- POSIX: pty's foreground process (`tcgetpgrp`, `IPty.process`), 1s sweep. Windows:
  `IPty.process` lies idle/busy alike; `jobFromTable` reads the process table instead
  (`TABLE_JOB_MS` 4s, shell panes only); covers a BACKGROUND job the foreground read misses,
  only when that read was empty.
- `reclaim.ts` refuses on `job` as well as `busy`; feeds `busyOnScreen`, clock counts COMMAND.
- Only a shell RUNNER counts; shell foreground is a subshell

## ...and an agent pane says what it left running

`paneJob.ts` refuses to speak about an agent pane; a background job goes quiet at turn end.
`shared/paneBackJobs.ts` (chip+hover) feeds no BUSY reading. `npm run test:panebackjobs`.

`Session.backJob`/`backJobSince` (`backJobInfo` in `main/usage.ts`) reach `fleetState`: a pane holding
one is `working`, clock counts the JOB, out of `busyOnScreen`. Live question outranks it, stale bell not.

- Descendant count isn't the reading: MCP servers/`caffeinate` leave idle trees of 5-9.
- Separator is HOW a process started: agent commands run through a shell spawned `-c`; MCP/`caffeinate`
  spawn directly. Job = SHELL SUBTREE under the pty; never walked INTO (`backJobs.LOOP_MIN_SECONDS` 30s
  floor), so `npm run dev`'s sub-shell is one job.
- Shell grammar isn't a name: control keyword owns its line, `do`/`then` are PREFIX words. Name = `-c`
  string's first non-housekeeping segment; `workName` prefers script over interpreter.

## What a pane leaves running

Quitting kills each pty with `taskkill /F /T <pid>`. `src/main/strays.ts` covers what's outside it: an
orphan whose middle process exited (`npm run dev` leaves vite behind), and the app dying without
`shutdown()`. A sampler walks each pty's descendants every 30s into `strays.json`, keyed by the owning
app run; closing a pane, quitting, next launch all kill from that ledger.

- A pid alone is never enough: every record carries creation time, re-checked by whatever kills.
- A run whose app is still alive is somebody else's, usually `npm run try`'s copy.
- Nothing may block main: reads are `execFile`; unwaitable paths hand pids to a detached script.
- Never asks what the pane RUNS: a per-CLI hook goes stale, silent on crash.
- `npm run test:strays` spawns real orphans, loads real `spawnDetachedNoWindow`; stubbing it makes
  kills do nothing.

## A pane opened with a prompt sends it

`queuePrompt` in `src/main/sessions.ts`. A blind timer fails silently — typed prompt, unsent, idle and
green. `npm run test:promptsubmit`.

- Readiness = idle COMPOSER: output stopped AND `readsBusy` false, off last PAINTED, not scrollback.
- Return is a separate write, a beat later; submit confirmed by a TURN (`runSince` newer than the
  write), never output. A busy pane WAITS to the deadline; an idle composer with no turn gets another
  return.
- `/clear` gets no boot patience: bursty paint gaps make idle read say ready, return gets eaten.
  `PROMPT_ENTER_TRIES` 6; resume waits `CLEAR_RESUME_BUDGET_MS` (3 min) vs launch's 45s; `autoclear-app.log`
  logs `UNSENT` on failure. `ARM_QUIET_MS`, a 15s countdown, `ARM_CLEAR_LEAD_MS` (120ms) gate the clear.
- Codex on `gpt-5.1-codex*` answers `400 not supported`; `agents.ts` lists only ids measured working.

## An agent's question is a row of buttons

`shared/choices.ts` reads the chooser off the pane's own frame. Card docks RIGHT, no repeat (260px,
full width coarse); answers one per line, equal widths. `npm run test:askrender`.

- Three must hold: CLI's `Enter to select` footer, options 1..N with no gaps, one row with the arrow.
- Ending screen of a multi-question ask prints no footer; `REVIEW` anchors ABOVE its list, `readReview`
  walks DOWN. Refusals: 1..N with one `❯`, only blanks/rules below; `don't ask again` refused by
  `WIDENS`. A RULE reads as blank.
- Arrows and return, never the digit, `CHOOSE_GAP_MS` apart; a left question REFUSES the press.
- On the SESSION not the pane: `pty:choose` answers a phone or mirror.
- Question is RED, NOISY, leaves the machine: `.row.asking` glows while `Session.ask` set; `sounds.ask`
  (`knock`) fires on `sessions:ask`, not `done`. `main/askNotify.ts` posts to Telegram (silent without
  `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, one per question, never a mirror); `pf-telegram.mjs` maps a
  TAP to `pty:choose`. `npm run test:asknotify`.
- Click on a question pane types NOTHING: `askRef` refuses bare click, Alt-click, selection delete
  while `Session.ask` set. `npm run test:askclick`, `npm run test:choices`.

## Arrowing through a question may not cost the whole desk

Sessions list is ONE array rebuilt whenever any pane changes; a pane's render re-measures turn-copy
pairs and rail against the live buffer. `TerminalPane` is `memo`'d with `samePaneProps`, comparing `ask`,
`termTheme`, `mirror`, `grid` BY VALUE. Five arrow moves: 34 renders of every pane → 5 on the question's
pane, 0 elsewhere.

- Load-bearing assertion is the bystander's count, not the question pane's. `npm run test:askrender`;
  `window.__pfRenders` per-pane counter.
- A prop added to `Props` without a line in `samePaneProps` stops updating for it.

## ...and a pane that is only PRINTING may not talk to React at all

A memo stops the re-render, not the dispatch. `setState` with the value it already holds still costs
`requestUpdateLane`, an update object, eager evaluation before React bails out; a pane writes three of
those from `onRender`/`onScroll`. Over eight shells: desk's React work was 37ms of a 3s run over 17
renders, `requestUpdateLane` alone 18-22% of the profile.

- `useQuietState` (`renderer/src/quietState.ts`) mirrors the value in a ref, compares in FRONT of the
  dispatcher. `geom`, `selChip`, `scrolledUp` are quiet. Updater form kept, evaluated against the ref.
- Keystroke to frame median 297/49/423ms → 40/34/34ms, p90 420/420/819ms → 220/42/39ms, GC 26-38% → 4-5%.
- Guard is a SOURCE test, `npm run test:quietstate`. `npm run type-profile -- --blame yi` is the
  measurement only. `window.__pfDeskRenders` carries `ms` and `n`.

## ...and a question with an obvious answer is answered

`shared/autoAnswer.ts` presses return instead — on by default, 30s wait. `npm run test:autoanswer`,
`npm run test:askrender`.

- Takes BEST option: `(recommended)`/`[default]`/`- suggested` outranks a yes-shaped word/arrow's row;
  two marked = a choice again; never lifts past a refusal.
- Refusals: exactly ONE yes-shaped option answered; arrow on REFUSED ≠ another; `don't ask again`/bare
  `always`/self-questioning, never reachable. `anyQuestion` wider; refusals hold over it.
- Wait spent AWAY from window: `holdWhileWatching` stamps `askHold` while focused; `startOf` clocks
  from later of that and `askSince` — looking away restarts `waitMs`. Held: no countdown
  (`autoAnswerHeld`). Clocks tick against DEADLINE (`useNow(1000, at)`).
- `dueForAuto`: two signatures — wait's includes arrow, "already pressed" doesn't (`askKeyOf` drops it). One press/identity, `PRESS_COOLDOWN_MS` 4s floor. `maxRun` clears only on BUSY. A hold CLEARS the
  deadline (`refreshAutoPlan` sets `autoAnswerAt = 0`).
- Countdown: banded row, card chip, `playTick` once/sec last min; button carries `.auto`.
  `window.__pfTicks` checkable. New default: `defaultsV2` + `migrateAutoAnswer` apply once.

## A pane says what its handoff has left

A pane past the context line writes a handoff; its `## Next steps` answers "is there work left in
there". `shared/handoffSteps.ts` reads it (mirrors `claude-memory/claude-config/autoclear.mjs`),
`main/handoffSteps.ts` the disk and 30s cache. `npm run test:handoffsteps` skips out loud when the
canonical file is absent.

- `0` and `undefined` differ: `0` wrote `None`, finished; `undefined` never wrote a handoff. Chip drawn
  for neither.
- Decorates and refuses; reaches no busy reading (same contract as `Session.backJob`).
- Countdown re-reads it at the arm: a handoff with nothing open refuses with `NOTHING_OPEN` (string
  `pane-clear.mjs` carries in its non-overridable list). A `--no-resume` cost clear is exempt; only a
  handoff that EXISTS may refuse.

## A pane that is still starting says so

A RESTORED pane opens wearing its old screen, so `blank` is not the booting reading. `Session.printed`
is the epoch of the FIRST byte out of THIS process, cleared by restart and wake — only main can tell
replayed bytes from the new process's own.

`PaneBooting` draws one dim line at the BOTTOM (`.pane-booting.over`) while `booting`: names the RUNNER
(`Starting Claude Code…`, off agent's `label`), adds a seconds count past `COUNT_AFTER_MS` (1.2s). No
spinner (`test:anim` refuses a looping decoration); its own component, tick subscribed only while
starting.

`npm run boot-timing --panes 7` measures it. Staggering the restore is WORSE than starting all panes in
one tick.

## A picture goes in front of the agent

Every agent reads an image off DISK: file written on the pty's machine, path typed
(`shared/attach.ts`,`main/attach.ts`). `npm run test:attach`.

- Paste ^V raw only for agent reading OS clipboard on its own machine; else file+path.
- Path true on one machine only: `@device/id`/browser send bytes over link; `attachOn` answers local.
- Name is TEXT not path: basename only, punctuation/control gone; ext off MAGIC BYTES.
- 5MB/batch, never auto-submitted.
- macOS screenshot drop: `text/uri-list`, no File; `splitDropUris` rebuilds `file://`→path, fetches
  http(s)/data; `text/plain` unclaimed. Uncovered: phone paste.

## What a pane costs is measured, not modelled

`capacity.ts` models a pane at 190 MB; chips answer "which is eating the machine" —
`src/shared/usage.ts`, `src/main/usage.ts`; `npm run test:usage`.

- A pane is its pty's descendant TREE, not the pty alone.
- CPU: delta of cumulative counters, never `ps %cpu`; mid-flight process caps at interval.
- Sampler skips table while hidden/minimised; never two reads in flight
- Memory read far slower than CPU (`top -l 1` mostly SYS time): CPU every tick, memory only at
  `FOOTPRINT_MS` (20s, `dueForFootprint`); new pane forces a fresh read.

## A reopened pane comes back with what was on its screen

Scrollback is renderer memory; `test:restore` hands the agent `--resume` (conversation only).

- Most come back ASLEEP: `Live.proc` nullable, `start()` takes `asleep`; arrives with no process, press
  wakes it. `sleep()` sets `status: 'exited'`, `resize()` drops calls so grid freezes at `START_COLS`;
  `wake()` spawns CLI there. Only a DEAD pane drops. `restoreAsleep` (`shared/restoreTurn.ts`) refuses:
  first pane, prompt-launched, mid-turn come back running. `npm run test:restoreturn`.
- `history.ts` appends to `userData/history/<id>.log`, `tail()` reads last `BUFFER_LIMIT`. Desk carries
  `scrollbackId` — skip it, restore is silently empty forever. `tail`: no ANSI-strip, cut on a line
  boundary. `test:scrollback`.
- Display clock is `openedAt` not `createdAt`; mid-turn pane continues via `queuePrompt`, off
  `runSince`. `askAfterUpdate` picks which restarts ask, off by default.
- Replayed at PAINTED width (Fix can't do this): `restoredTail` carries old width (`colsOf`),
  `Session.replayCols` writes that buffer part at that width — only before the restore mark. Resize in
  write CALLBACK. `shared/replayWidth.ts`, `npm run test:replaywidth`.
- Presses Fix for itself: `repair()` once, `RESTORE_FIX_MS` (1.2s) after output stops; mirror refused,
  hidden pane FLAGGED not repaired. `test:restorefix`.
- Prompt tags: rail is KEYSTROKES so replay registers none; `seedMarks` scans for `❯ <text>` echo once
  while rail empty; keeps ONE tag per prompt. `test:promptecho`.

`/clear` no longer takes the previous turn. `npm run test:scrollclear`.

- `keep.arm()` (`shared/keepScrollback.ts`) fires when a submitted line matches `mayClearScreen`,
  RETURNS the scroll before the CLI emits a byte. A slash TOKEN that's a PREFIX of `/clear` (e.g. `/cle`
  from completion) arms too.
- `keptRows` stops at composer's top edge, believed only when CARET is between its two rules; `arm()`
  fed by keystrokes from Clear button, session menu, phone, any path — via `paneArmClear`.
- Cursor-to-top-with-erase REPORTED not acted on; `shared/screenLoss.ts` files only at 80%+ loss; `2J`/
  `3J` rewrite covers an unasked clear, stands down 10s after an armed scroll.

`shared/markAnchor.ts` re-anchors a prompt tag on a deferred callback while its line is in buffer, ends
it once forgotten. `npm run test:markanchor`.

## History says what each session was working on

Each row: first thing typed at the agent, plus how many asks followed. `npm run test:gist`.

- Costs nothing: line comes from keystrokes already relayed, same feed as `promptArchive`. `shared/gist.ts` tidies.
- Newest closed at top (`endedAt ?? startedAt`); inside a day `closed 5 min ago`, past a day calendar date.
- Green rail + `open since` chip if open; red rail + `closed …` chip if not.
- `View all` prints every chapter (`summaryFull`) when there's more than shown.
- The FIRST ask, not the latest.
- Session closed before recording: best-effort line from prompt archive, else none.
- `/clear` ends a job (`noteAskInto` reads it like `keepScrollback`). Three shown, rest counted; `asks` counts only WORK. Twelve chapters kept.
- Survives restart: `recordStart` reruns on same id.
- Transcript RENDERED not stripped: `renderer/src/termRender.ts`, shared with phone's `TextSheet`, replayed at written width.

## The app remembers what has been asked

`src/main/promptArchive.ts` answers: has this ask been made before — fed from `shared/draft.ts` on the way to the pty, not from a CLI hook, covering every agent.

- Never blocks, never types, never cancels — only a chip in the pane's corner.
- Quiet window (`QUIET_MS`, 6h) is load-bearing, not the score: a reworded re-send is the SAME work.
- Only submitted lines archived, never drafts; capped preview plus token set only.
- `src/shared/promptKey.ts` MIRRORS an algorithm in three other places (claude-memory hook, TaskDriver archive server, Discord bot), one shared archive — editing one copy splits it silently. `npm run test:recall` recomputes the canonical file's answers, skips out loud if absent.
- Not built: nothing watches a pane's repo for the commit an ask became, so `outcome` is null.

## Dictation needs nothing installed

Mic on every pane, Ctrl/Cmd Shift Space into focused one. `shared/voicePick.ts` picks; `useVoice.ts` falls: whisper CLI on PATH, else Whisper worker (`voiceWorker.ts`, ONNX wasm), else phone's browser recogniser. `npm run test:voice`.

- `webkitSpeechRecognition` exists in Electron but ends `error: "network"`; gated on not-Electron.
- 8-bit weights fail; `bnb4` smallest that works.
- Wasm ships via `electron.vite.config.ts`, deletes unused asyncify binary.
- Phone: dictating takes whole screen (`VoiceOverlay.tsx`); ring IS input level.

## ...and it knows what is serving, and can stop one

`devServers.ts` answers a package.json SCRIPT. `shared/devList.ts` answers PORT and pane. `npm run test:devlist`.

- One server not one process: candidate whose ancestor reaches another folds into it.
- Only `-p`/`--port`/`--port=`/`PORT=` count as a port.
- Attribution: tree first, path test against pane's folder. Server no pane claims still listed.
- Pid re-validated before signalling; stale one refused. SIGTERM then SIGKILL.
- Renderer supplies order/words only; facts read in main off pane's record, on demand.

## The resource ladder has a face

`capacity.ts`, `autoHandoff.ts`, `reclaim.ts` trim/move/close panes on their own. `shared/mascot.ts` is the mouth, `components/Mascot.tsx` draws it. `npm run test:mascot`.

- Not a model: arithmetic over readings already held; typed commands are a small parser; nothing leaves the machine.
- Names the pane, which COPY, what it was doing, when. `paneWord`: `(1) taskdriver`; number leads in brackets, is the Ctrl key.
- `pet: 'none'` keeps every reading, drops sprite: card docks bottom-right, pill with count/total opens ask box.
- `spriteReserve` turns overlap into bottom padding, rounded to a whole row; sprite over `RESERVE_MAX_FRAC` (30%) reserves nothing; padding on `.xterm`, not `.xterm-host`.
- Dev server named beside a pane NUMBER narrows the SERVERS; bare "pane" means the panes.
- Bubble self-dismisses (`mascot.hideSeconds`, 60s, 0=until pressed); clock restarts on ask-box keystroke; COUNTDOWN exempt.
- A guess is never an action: "close pane 9" with five panes closes nothing, says how many exist; destructive intent OFFERED as a press. `closeable()` is `reclaim.ts`'s refusal set; refusal meant is `asking`, off `Session.ask`.
- Countdown HEARD (`sounds.move`, default `bowl`, once on arm, ticks last ten seconds); sweeps hand plan to `armCloseRef`; `MoveSoon.tsx` ALWAYS draws it (never the mascot bubble - one clock, one face) naming pane, `Keep it open`/`Close now`; doing nothing still closes it. Armed BEFORE the deadline: `idleClosePlan` takes a `lead`, the idle sweep runs every 5s, `countdownEnd` ends the count at the plan's own `dueAt` so the card's number only goes down (floor `MIN_COUNTDOWN_MS`). `Keep it open` holds `KEEP_MINUTES` (10). Mascot hidden → closes.
- Speaks unasked once per situation, only where app is silent.
- Ten pets, same cost (`src/shared/pets.ts`); animation keyed on SLOT not animal, same 24x24 grid.
- Arrives OFF, runs rarely, every condition a refusal (`dueDash`, `DASH_EVERY_MS` 9 min); can be picked up, drop writes `mascot.spot` as window fraction, beats automatic move.
- Layer never takes a click: `z-index: 40`, over panes, under every dialog, `pointer-events: none` except sprite/bubble.
- Mute by default; never picks machine — `hand off pane 2` opens box with panes chosen.

## ...and a card nobody touched goes away by itself

`shared/cardIdle.ts` (`CARD_IDLE_MS` 5 min), bound by `renderer/src/idleDismiss.ts`.
A pointer resting on it, or focus inside it, HOLDS it - `idleLeft` answers `null`, never a
paused number - and letting go restarts the clock. One timeout, no tick: nothing is drawn
from it. Only for a card that SAYS something and wants nothing back (`WhatsNewCard`);
a card asking or counting down to an action - `MoveSoon`, `OffloadSoon`, `AutoClearToast`,
`StopServer`, `LoginCard`, `UpdateToast`, `TourCard` - ends at its own deadline by doing
the thing, and `npm run test:cardidle` names each one.

## Every card the app puts in the corner is in ONE column

`.corner-stack` in `App.tsx`/`styles.css`. `.move-soon`, `.client-toast`, `.update-toast`
(+`.whatsnew`,`.autoclear`) and `.tip-toast` were separate `position: fixed` cards at the same
`right: 18px; bottom: 18px`, told apart only by z-index - so two up at once drew one UNDER the
other, buttons and all. `npm run test:activity`.

- `column-reverse`: FIRST child is the corner one and never moves when a card arrives above it.
  DOM order is urgency - AutoClear, MoveSoon, ClientToast, Update, WhatsNew, Tips.
- Children go `position: static` inside it; a new corner card is added HERE, never fixed itself.
- `.beside-pet` steps the whole stack up once (108px); the per-card version must stay `auto`.
- Layer is `pointer-events: none`, cards `auto`; `max-height` so the top card cannot go off-screen.

## A dev server nothing can reach is closed, after a countdown

`shared/deadDev.ts` judges, `main/deadDev.ts` reads, `StopServer.tsx` is the card.
`npm run test:deaddev`.

- The reading is a LISTENING SOCKET, never a pane, never a clock: a dev server holding no
  connection cannot be what anyone is looking at, whoever started it. `listeningPids()`
  (`lsof -Fp` / `netstat -ano`), resolved DOWN the tree - `npm run dev` never holds the
  socket its child bound, and `devList.ts` reports the ancestor.
- An empty socket reading is a FAILED reading and stops the sweep. It must never read as
  "nothing is listening", which would take every dev server on the desk.
- Refusals: anything serving, anything `launchctl list` names (a supervised job comes
  straight back), `DEAD_AFTER_MS` (90s, a cold `next dev` binds late), one somebody kept,
  pid 1. Windows claims no supervised pids rather than guessing.
- `SWEEP_MS` 60s for the readings; the deadline gets its own 500ms tick that reads
  nothing - a card saying 5s may not act a minute later.
- One card at a time; a countdown already armed is never re-armed, so the number only
  goes down. Default 5s, `config.deadDev`, switch in Settings beside the idle-close one.
- The kill goes through `stopDevServer`, which re-validates the pid against the live
  table - a pid is reused. Closing writes a `stopped` row on the bell.

## ...and what it did on its own is a list, not just a card that vanished

Bell in the sidebar's quick row, `ActivityFlyout.tsx`; `shared/activity.ts` judges, `main/activity.ts`
holds `activity.json` under userData (main, so a reload/wedge/restart does not lose it).

- Fed by the existing `reclaim:log` line, `clientNamed` and `armclear` - one wiring point each, and
  the log files stay the place a week-old close is reconstructed from.
- `armed` is NOT a row: the countdown card is already on screen and can still be kept open.
- The row's left column carries the verb (`KIND_WORDS`); the sentence must not repeat it.
- A READING: nothing in it can be pressed, so no veil, no dimming, no dialog. Opening it marks
  everything seen; the dot counts what arrived while nobody looked.
- `activity:list`/`activity:seen` are `REVIEWED_SAFE` in `scripts/passkey-test.mjs`.

## ...and one card says what this app can even do

One quiet card bottom-right — `shared/tips.ts` catalogue/judgement, `components/Tips.tsx` the card. `npm run test:tips`.

- Costs nothing: fixed sentence chosen by arithmetic over what's been seen.
- Never interrupts: silent while any dialog open, while an update card is up, while ANY pane holds a question, behind a minimised window, first four minutes. `FIRST_MS` 4 min, `EVERY_MS` 40 min.
- First card and every fourth after carry the stop sentence and button (`offersOff`). Settings is the way back on.
- Cycles rather than repeats: every tip shown once before any twice; `seen` resets rather than going quiet.

## A session that clears itself asks first

`claude-config/autoclear.mjs` (Stop hook): past context + handoff has open work → asks the app to clear the pane (`pane-clear.mjs` → `autoclear:ask`). Countdown card: what continues, time left, `Keep this session`/`Clear now`; unattended = still happens. `npm run test:autoclear`.

`shared/autoclear.ts` holds refusals, `main/autoclear.ts` the clock, re-checked each tick: a pane starting a turn, typed into, exited or gone drops its countdown; a no-open-steps ask is refused; old PaneForge refuses, no fallback to instant clear.

- `blockMessage`: `## Next steps: None` is respected — no clear.
- `/clear` typed after arm lead; resume via `queuePrompt`, waits on IDLE COMPOSER (`CLEAR_SETTLE_MS`, `SUBMIT_RETRIES_MS` for the fallback).
- `armclear` → `pane:armClear` → `keep.arm()`, `ARM_CLEAR_LEAD_MS` (120ms) before it lands.

## The screen stays on while a pane works

`shared/awake.ts` + `main/awake.ts` hold a `powerSaveBlocker` while any pane is mid-turn or on a question,
letting go when the desk goes quiet. `npm run test:awake`.

- Cap is on the BUSY STRETCH, not the hold: a wedged pane cannot keep a laptop lit, cannot re-arm by ticking.
  `config.keepDisplayAwake` turns it off.
- Holding the machine awake does not light the panel. Lid guard's `pmset -a disablesleep 1` ignores the lid
  outright, backlight included. `screenUnseen` drops the screen hold alone — system hold, panes, turn in
  flight untouched.
- Narrower than "lid is shut": clamshell + external monitor also reports lid shut, so Electron's display
  list must say the builtin is the only screen. A failed reading counts as false.

## A pane's two ends open at the same width

An agent CLI prints absolute column moves; a terminal clamps a column it cannot reach. Rule: a pane's grid
may never be narrower than the width its bytes were painted for. `src/shared/paneGrid.ts` is that number,
read by both ends. `npm run test:panegrid` — control: a line painted into a narrower grid must tear across
rows, since a clamp wraps rather than deletes.

- Pty spawned at 120, xterm opened at default 80; `claude --resume` dumps the whole conversation at once,
  tearing every answer at column 119 permanently (a clamp cannot be undone). Not `shared/replayWidth.ts`'s
  bug (restored pane's old bytes) — this is live output, every launch.
- Fix repairs scrollback too, not only the live frame: `redrawHistory` re-renders from the raw byte stream
  at `max(pane now, replayCols, START_COLS)`, hands width back. User-initiated only.
  `window.__pf[id].redraw()` for a probe.

## Every prompt this app writes says what done means

`src/shared/promptForge.ts` is the one place a prompt is built - task, anchors, scope, done,
exemplars. The `Done means:` block is unconditional and LAST; over `MAX_PROMPT_CHARS` (6000) the
examples go first, then the guidance, then the task tail, never the done block. Exemplars come from
`claude-config/promptlib` (`main/promptForge.ts` reads it, `PF_PROMPTLIB` overrides), at most
`MAX_EXAMPLES` (2) of `EXAMPLE_CHARS` (600). No library = a prompt with no example, never no prompt.
`npm run test:promptforge`.

- Who uses it: `splitInstruction` (`SPLIT_BUDGET_CHARS` 40,000 - a headless CLI arg, not a pane),
  `paneBrief` (the row SplitDialog draws, idempotent - a model's own `Done means:` is lifted, not
  doubled), `resumeBrief` (`shared/autoclear.ts`, anchored on the handoff's own path, done = its
  open steps; a `noResume` clear forges nothing).
- `claude-config/promptlib/harvest.mjs` feeds the library back: prompts from runs the ledger
  MEASURED as shipped, `MIN_FIELDS` 3 of promptlib's four, and no promptlab `no_anchor`/`multi_item`.
  Today that is 0 of 215, which is the finding.
- Which prompt sites carry which item, and the numbers: `docs/prompt-review-2026-09-02.md`.

## A pane opened on a task is briefed from the task

`pf open <cwd> --task <backlog-id>`. `shared/taskBrief.ts` decides, `main/backlogStore.ts` reads
`claude-config/ledger/backlog.jsonl` (`PF_BACKLOG` overrides). READ ONLY - the backlog has one
writer. `npm run test:taskbrief`.

- The `Done means:` block is the item's own `success` line plus its gates, so the pane is judged by
  the criterion it was given.
- Attempts and the last refusal are carried; three refusals say the approach is what to change, the
  same reading `next-action.mjs` takes.
- Refusals open NO pane, because the lookup is before the pane: unknown id, ambiguous prefix (named),
  finished item, no title, no backlog, `--task` with `--prompt`.

## ...and the app counts how often a person had to step in

`shared/interventions.ts` judges, `main/interventions.ts` tallies onto `Session.interventions` and
appends `interventions.log`. One line on `SessionInfo.tsx`. No dashboard.
`npm run test:interventions`.

- An `app` write NEVER counts, refused first: a queued prompt, an autoclear, an auto-answered
  question. `choose()` takes the hand and passes it to `write()`; the auto-answer path sends `'app'`.
- Typing without sending is not a separate intervention; a bare return sent nothing.
- What is next on this ladder, and what is refused by name: `docs/agentic-backlog-2026-09-02.md`.

## Checks

`npm run typecheck`, `npm test` — 149 checks, no window/network/real CLI (`scripts/test-all.mjs`); release
gate step 3 (`agentGate.ts`) needs a script named `test`.

Suite pin table: `docs/design-notes.md`, **Checks — what each suite pins**.

Needs a window: `test:view`, `test:stashdrag`, `test:activate`, `test:restorefix`,
`test:askclick`, `test:askrender`, `test:devicesfit`, `test:phoneview`, `test:contrast`,
`test:renderwatchlive`.

Needs network: `test:discordbrand`, `node scripts/mac-update-test.mjs --live <v>`.

`npm run competitors` (`npm run test:competitors`) prints what moved.

## A turn the transport cut in half finishes itself

An agent whose stream dies mid-answer prints an error, returns to its composer. `shared/recover.ts` decides.
`npm run test:recover`.

- Keys on the SECOND sentence: five different first sentences ship, all end `The response above may be
  incomplete.`
- A rate limit, usage limit, credit balance, auth failure or overload is never continued, even with that
  sentence.
- An error somebody QUOTED is not an error — once submitted the CLI echoes it back whole; a line starting
  `> ` is someone talking. A copy still being typed is caught by `promptBox`.
- Three in a row and it stops; only output since the last look is read; send goes through `queuePrompt`.

## A full machine gets its panes back

`capacity.ts` gives back scrollback (~5%); `shared/reclaim.ts` returns the agent by closing the pane — cost
is the CLI inside (~190 MB each, vs 16-17 MB Codex). `npm run test:reclaim`.

- Trim is a DELETE: lowering xterm's `scrollback` discards lines, raising it restores none. Recovery
  re-renders from main's raw log (`REDRAW_BYTES` 4 MB). `TRIM_GRACE_MS` (5 min) keeps lines just left,
  `TRIM_SETTLE_MS` (60s) waits for verdict to hold. Growth never delayed.
- `kill()` calls `recordEnd`: closed pane keeps History row, `resumeId`, `scrollbackId`.
- Pressure is the trigger, never a clock.
- Never closed: pane waiting for a person (`needsYou`), focused/on-screen/working/starting/stalled, a
  mirror.
- Card ARRIVES/LEAVES, never a strip. `.cap-pop` arms on verdict CHANGING, leaves after
  `CAPACITY_NOTE_MS` (12s); only `over` arms it, max one per `CAPACITY_QUIET_MS` (10 min).
- Press on a pane drops its countdown (`touchPane` clears `closeSoon`); others re-decided next sweep.
- HOLD is not a countdown: `Session.closeKept` says which number; card says `kept 10m`, no red alert.
- `idleCloseAt` clamps overdue pane to `now`, `sameDeadline` stops republishing.
- `ReclaimPane.pinned` takes a pane off the clock, refused by `onTheClock` and `reclaimPlan`'s filter.
  `keptUntil` (an hour) answers "not now".
- `quietSince` is latest of a keystroke, printed byte, or KEYBOARD LEAVING — stamped on both.
- `shared/away.ts` freezes the clock while `powerMonitor.getSystemIdleTime()` says nobody's here
  (`AWAY_AFTER_MS` 60s); `main/away.ts` polls 15s, refused by `sawPerson`.
- `unread` refuses `onTheClock`, holds CLOCK only, gated on `sawPerson`.
- `idleSleepPlan` (`reclaim.idleSleepMinutes`, 30 min) stops agent, keeps card/place/screen/conversation;
  drops closing-only rules. No countdown; card says `asleep 3m`.
- `reclaim.idleCloseMinutes` 0 by default, switch sets 5 min.

Restore: `restorePlan` starts all at normal, two at warn, one at critical, never zero while a pane is
offered — a preselect, never a cap. `npm run test:capacity`.

## ...and before it closes one, it tries to move it

Four rungs: trim scrollback -> start next pane there -> move a finished pane there -> close it.
`shared/autoHandoff.ts` is rung three; `npm run test:autohandoff`.

`Machine.keepLocal` (`autoHandoff.keepLocal`, 2) is a budget, `Verdict.over` = panes past it, `budgetPlan`
moves exactly that many.

- Cost decides, never count. `expensive()`: live shell/dev-server job (`AutoPane.job`, outranks both),
  `budgetMinMb` (500), or `budgetMinCpu` (50% of one core). Dearest first, then quiet-and-off-screen.
  Unmeasured (hidden) = not expensive. Budget holds at `ok`.
- Only rule allowed to move a pane ON SCREEN or MID-TURN. Busy pane picked LAST (`rank`); `queueable`
  wider than `movable`. Refused: focused pane, live question, mirror, one already moving, one on a
  failure cooldown, the last pane on the desk. Moved count = overshoot, not `maxPerSweep`.
- Lag read as well as memory, worse decides (`lagLevel`, `worstPressure`): 1 runnable thread/core =
  `warn`, 1.8 = `critical`, not CPU%. `os.loadavg()` 0 on Windows = "nobody measured".
- 15s countdown always shown: `MoveSoon.tsx` (z-index 45, no animation), pane named.
- Checked before picking: `AutoPane.machineBound` (`shared/paneBound.ts`), keyed on automation flags
  (`--remote-debugging-port`/`-pipe`, `--headless`) plus a non-MCP driver binary. `AutoPane.shareable` —
  git repo under projects root with origin remote (`main/handoff.ts`, cached 5 min); `false` refuses,
  `undefined` = "nobody asked". `npm run test:panebound`.
- The app never asks where a pane runs; `keepLocalOf` (config.json/`config:set`) is the only override.
- Pressure card offers the move: `suggestMove` names dearest pane + destination; `.cap-pop` has
  `Move it` / `Keep it here` (adds PROJECT to `autoHandoff.keepHere`, every rung refuses it).
- Never handed back where it came from: `senderDevice`/`arrivedFrom` in payload, `hostFor` skips it.
- A pane MID-TURN is never picked at all: `queueable` refuses `working`/`stalled` like `movable` does (2026-09-04, it armed on a chat with a prompt queued and a command running). The queue is for a pane that goes quiet between the decision and the move. `main/handoffQueue.ts` moves it when the turn ends; one that never
  goes quiet expires after `waitMinutes`, said out loud (`remote:handoffCancel` chip ends it); a move
  already in flight has left the queue. `undefined` keeps the stamp, only `null` clears it —
  `handoffQueuedAt` makes chip say `waiting 12m` not `moving`. `TICK_MS` (5s) is expiry backstop.
- `AutoPane.asking` refuses a question pane. Other refusals = `reclaim.ts`; failed move gets
  `cooldownMinutes` hold.
- `idleOffloadPlan` clock (`autoHandoff.offloadIdleMinutes`, 0=off, switch sets 30): drops
  `visible`/pressure gate, nothing else.
- `handingOff` on the Session, `reclaim.ts` refuses it (closing wins a race with moving).

Dev server travels with it: `kill()` takes the pty's whole tree. `shared/devServers.ts`,
`npm run test:devservers`. Attributed by tree OR command line naming a repo path; turned into a
package.json script name, rebuilt from receiver's own package.json/lockfile, never re-issues argv.
Payload names only a script, re-validated against `SCRIPT_NAME`. Ambiguous match dropped, named; only
`DEV_SCRIPT` (`dev|start|serve|watch|preview`, w/wo `:suffix`) travels.

## What Windows loses between restarts

- The Desktop shortcut. `build/installer.nsh` deleted `$DESKTOP\PaneForge.lnk` on every run; guard fixed,
  but the app also puts a missing shortcut back on launch (`main/winShortcut.ts`, decision in
  `shared/winShortcut.ts`). Never rewrites one that is there, never claims the Desktop from a
  `npm run try` copy.
- The login entry. `setLoginItemSettings` re-applied from config on every launch, only when it disagrees.

Both logged to `updater.log` (`windows ...`). `npm run test:winshortcut`.

## The Windows dev channel picks its own release

`GET /repos/robertiuoras/PaneForge/releases` answers 200 with an empty array (anonymously and with the gh
CLI token) while `gh release list` lists everything, so electron-updater's dev channel gets `undefined` and
throws; newest release is often one this platform cannot install. `pickRelease` cannot be reused — same
broken list.

Dev channel stops asking GitHub's API: tags come from `gh release list`, each asked directly whether it
carries a `latest.yml` (public download request, no token, no API), feed pinned to the first that does,
generic provider. `allowPrerelease` stood down under a live pin. Every failure leaves the feed unchanged.
`PF_NO_WIN_PIN` exists so `test:blindlist` stays about the blind list. `npm run test:winfeed`.

## Why the app quit

Electron never says what triggered a quit. Every purposeful quit names itself — `quitting(...)` in
`main/index.ts`: single-instance loser, unopened test copy, handoff receiver, idle clock, update install,
admin relaunch — `before-quit` writes that name to `updater.log` with the pane count. Empty logs
`nothing in the app asked`.

A signal cannot be caught (Chromium takes SIGTERM below the JS layer); unnamed cases told apart by where
the screen was — Cmd-Q/app-menu Quit only typed at a frontmost window, `pkill`/`osascript ... quit`/a
launchd job/a logout arrive while somebody looks elsewhere. `shared/quitWords.ts` turns last focus into
that sentence: evidence not a verdict — useful half is "did NOT come from this keyboard".
`FROM_KEYBOARD_MS` 4s. `npm run test:quitwords`.

## Gotchas that look like mistakes

- `package.json` `description` is the bare word "PaneForge" — becomes the exe's FileDescription, the
  name Task Manager shows.
- `package.json` `name` stays `claude-orchestrator` — Electron builds `%APPDATA%\<name>` from it.
- Icon generated: `node scripts/make-icon.mjs` writes `icon.png`/`icon.svg`/`build/icon.png`; no
  ImageMagick/sharp here, don't check in a blob. `--size N --out path` renders one size.

- `git status` for pane badges stays async (`execFile`, never `spawnSync`) — blocked main is the Windows
  busy cursor.
- `.github/workflows/` edits need `workflow` gh token scope (`gh auth refresh -h github.com -s
  workflow`) or the push is rejected after `lane.mjs` tagged the release.

## Checking a layout change without screenshots

```
npm run build                    # skip w/ --keep or you measure the last build
npm run try -- --keep --remote-debugging-port=9333
npm run probe -- --height 560 "(() => { const r=document.querySelector('.dialog').getBoundingClientRect(); return { fits: r.bottom <= innerHeight } })()"
npm run try -- --close
```

Same probe answer before/after = nothing rebuilt. Port per checkout: second lane uses `PF_PORT=9334` +
launch flag. `--height`/`--width` drive Chromium's device metrics override, restore after. Evaluated with
`awaitPromise`: async arrow clicking a dialog then measuring works as one argument.
`window.__pf[sessionId]` gives a pane's live `term`/`fit`

## An iPhone is not a Mac, and a phone control is 44px

`npm run test:phonetouch`.

- `navigator.userAgent.includes('Mac')` is TRUE on an iPhone (`(iPhone; CPU iPhone OS 18_5 like Mac OS X)`)
  and outright on iPad, so every shortcut printed `⌘ T` to a device with no ⌘ key. `isMac` refuses an iOS
  agent AND a touch device with no fine pointer; hints hidden on a handheld.
- Coarse block was only written for a PANE; on a handset the sessions list is the home screen: 31
  controls under 44px, plus all three on the pane screen. Now 1 and 0 — survivor is a row's close at
  40x40.
- Two specificity ties decided it, test reads the BUILT stylesheet: `html.handheld .pt-more` (0,2,0)
  loses to the header's later `.pane-title .icon` (0,2,0). `.icon.help` carries its own `min-width` at
  equal specificity, later, to keep both brand buttons the same size — named separately.
