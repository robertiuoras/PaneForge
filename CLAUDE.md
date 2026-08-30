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

The installed `PaneForge` is the live app; killing it ends this session mid-turn. To see a
change, open a **second** copy:

```
npm run try                     # builds, opens as its own profile, minimized, no focus
npm run try -- --show           # same, but on screen (still no focus)
npm run try -- --close          # shut that copy down
```

Profiles (`src/main/profile.ts`) give the copy its own userData, single-instance lock, config
and taskbar button. Never `npm run setup`, never `Stop-Process PaneForge`, never run the NSIS
installer — each kills every PaneForge including this session.

## Lanes: more than one chat works on this repo

A hook assigns each session a lane — `main` (this folder, master) or a worktree
`PaneForge-a`/`-b`/`-c` on `lane-a`/`-b`/`-c`. **Work only in the lane you were given**; a
PreToolUse hook refuses writes into another chat's checkout. `node scripts/lane.mjs status
--repo <dir>` says who holds what.

- A visiting chat gets a letter lane, never `main`, unless `main` holds uncommitted work.
- One engine drives every repo: `lane.mjs --repo <dir>`. Per-repo `.lanes.json`, all fields
  optional: `{ "lanes": false, "branch": "main", "release": "merge", "pool": ["main","a"] }`.
- A repo with no remote, and `claude-memory`, never get lanes. Never leave a lane in a
  conflicted merge — the one state no other chat may touch.
- **A lane is reported shipped only once PROVED out.** `landedOnOrigin` checks the lane's
  commit is an ancestor of the branch on origin; a lane that fails is left out of
  `lastShip.lanes`, KEEPS its ready mark, and is named. `null` (no origin/network) is "nobody
  could check" and changes nothing — none of this may block a chat.
- **A lane passed over leaves a note** (`state.passed[id]`, printed by `doctor`): a silent drop
  and a successful merge look identical from outside.
- **A lane holding nothing is kept until quiet for a day** — `SWEEP_GRACE_MS` in
  `main/laneWork.ts` (24h, `PF_SWEEP_GRACE_MS` for tests, read at call time).
- The lane chip opens "what is all this", not just "merge?" — `LaneDialog` +
  `renderer/src/laneWords.ts`, built from BOTH the ledger and this window's panes.
- `npm run test:lanes` covers the engine, the sweep, ownership, and the any-repo contract (a
  repo that never asked for releases must never cut a version).

## Two desks, one repository

The ledger is one machine's (`<repo>/.git/paneforge-lanes.json`, never pushed). Letter lanes
are local scratch and cannot collide; the trunk can, and so can a release cut twice.

- **A claim is carried by the ref NAME**, `refs/paneforge/claims/<device>/<slot>/<session>/<millis>`.
  Reading every device is one `ls-remote` (0.09-0.11s).
- **Only the trunk asks, and only a chat that does not already have it.** `PEER_STALE_MS` 45 min.
- **The heartbeat is a turn ending**, not a timer, and only past `REFRESH_MS` (10 min). A chat
  ending gives the trunk back at once.
- **The release lock is decided by the SERVER** — `refs/paneforge/lock/release` is a plain,
  non-forced push of an orphan commit, so the other desk's push is a non-fast-forward git
  refuses itself. Read-then-decide and `--force-with-lease` were both wrong and are kept as
  test cases. A lock with no timestamped claim beside it is cleared.
- **Nothing here may ever block a chat.** `peerRefs()` returns `null`, not `[]`, so `doctor` can
  say the check could not run.
- `PF_DEVICE` overrides the hostname. `npm run test:lanepeers`, `npm run test:lanedevice`.

## Releasing happens when Robert asks, and not before

**`.lanes.json` says `"release": "merge"`, deliberately.** Finishing work merges into master and
pushes; it does NOT cut a version, publish a build, or move anybody's installed copy. The end of
a piece of work is: build it, prove it in a second copy he can open
(`npm run try -- --keep --remote-debugging-port=9333`, then `npm run probe`), report the numbers,
and stop. `npm run typecheck` and `npm test` still gate a commit.

```
node scripts/lane.mjs ready --repo <dir> --session <id>   # this lane is done and verified
npm run ship                                              # ONLY when Robert asks for a build
```

`ready` merges master into your lane first, refuses to mark while that merge is dirty, then
merges once no chat is mid-work. Edit or commit after marking and the mark is dropped, by name.

What a release does WHEN ASKED FOR (`"release": "version"` restores the automatic path):

- **Below 1.0 an automatic release only moves the patch.** `feat:` is a patch, `feat!:` a minor,
  anything larger is typed (`lane.mjs ship minor|major`).
- **Releases batch: one per 2 hours** (`COOLDOWN_MS`). `npm version`, `git tag vX` and pushing a
  version tag by hand are **blocked**; `npm run ship` is the one path that skips the gate.
- **Three things stop an automatic release, all reported by name**: master not typechecking,
  master failing its own `npm test` (`suiteFailure` — a typecheck never proves the app works), and
  a lane conflicting with master (left out; the rest still goes). The suite answer is cached on
  the COMMIT, and **a red answer is asked TWICE before it is written down**. A suite that could
  not START is named as tooling and is not cached. `npm run test:gate`.
- Release notes come from Conventional Commit subjects between tags (`scripts/release-notes.mjs`).
  **Only `feat:`, `fix:` and `perf:` reach the page**; `unpublished` names a `src/` commit with no
  prefix and `doctor` prints it. `npm run test:notes`.
- **Actions and this machine can both publish.** Duplicate installers are harmless; `latest.yml`
  is not — `reconcileFeed` puts ours back. Never hand-fix a feed without checking the asset's real
  size. `runSafe` quotes its arguments (`npm run test:laneargs`).
- **Every automatic release is a DEV release**, a GitHub prerelease. The newest dev build that has
  been on the channel `PF_PROMOTE_SOAK_MS` (3 days) auto-promotes — **that build's own age, not a
  quiet period**. Both paths refuse a one-legged release and a size-mismatched feed, then verify
  `/releases/latest` moved. Tags stay plain; the prerelease FLAG is the channel.
  `lane.mjs promote [version]`, `lane.mjs doctor`, `npm run test:promote`.

**A release claims the thing is finished.** Never cut one while any next step for that issue is
open — and **promotion claims it is proved**.

## An update may never need a person

Install once, update from the app, for ever. **A user reinstalling by hand is a defect**, and one
shape causes it: a promise that never settles behind a flag saying "already working on it".

- **A release this platform cannot install is skipped, not retried** (`shared/pickRelease.ts`); a
  list where nothing is installable reports "no update", never an error. `npm run test:pickrelease`.
- **A restart nobody asked for waits for the DESK, not for the turn.** `deskBusy`
  (`shared/updateHold.ts`) holds an ENGAGED pane until quiet `DESK_QUIET_MS` (10 min); an engaged
  pane with no timestamps counts as warm. The CLICKED restart is unchanged. `npm run test:updatehold`.
- **The recovery may not live inside the thing that can hang.** A transient phase carries `phaseAt`
  and `busy()` drops one past its budget: `CHECK_BUDGET_MS` 2min, `DOWNLOAD_BUDGET_MS` 45min,
  `PROBE_BUDGET_MS` 5min, env-overridable. The poll is armed BEFORE the await as well as after
  (`POLL_WATCHDOG_MS` 6min).
- **On the way out, the disk beats the badge** — the quit swap is gated on `stagedInstallable()`,
  never `phase === 'ready'`.
- `update-health.json` holds the last good feed answer and every recovered wedge; three days
  without a good check logs `health STALE`. `npm run test:updater`, `npm run test:wedge`.

## ...and a pane that says it is working, on a frame nobody repainted

The busy read comes off the bottom of the pane's own screen (`shared/busy.ts`), which is right
until a CLI torn mid-paint strands its working line on a row nothing overwrites.
`shared/staleFrame.ts`; `npm run test:staleframe`.

- **The pane's own SILENCE is not the tell** — `busyUntil` is renewed and `checkBusy` runs on a 4s
  tick, so a stale pane re-states `true` for ever without printing a byte. What separates stuck
  from slow is the evidence not CHANGING.
- **The signature is the EVIDENCE, never the read window** (`busyEvidence` + `staleSignature`);
  signing the whole window would be reset by other traffic in those rows. For the weakest rule,
  `counter`, the signature IS the number.
- **The recovery is the one Fix already runs**: `sessions.redraw`, a SIGWINCH nudge with no
  keystrokes in it.
- **The refusals are the feature** — the expensive mistake is a needless poke. `STALE_AFTER_MS`
  four minutes of a byte-identical line, `MAX_NUDGES` **2 per stretch**, `NUDGE_EVERY_MS` a minute,
  a mirror judges nothing, `autoFixUi` off means no. The load-bearing test is the CONTROL: a real
  20-minute turn with a ticking counter, nudged **zero** times. `window.__paneBusy[id].stale`.

## A window that stops answering comes back on its own

`shared/renderWatch.ts` (arithmetic) + `main/renderWatch.ts` (plumbing). The main process, every
pty and the desk survive a wedged renderer, so the app stays healthy behind a window nobody can use.

- **`reload()` cannot preempt a spinning renderer** — it is a message to the busy thread. The
  process is killed first (`forcefullyCrashRenderer`) and the reload runs from `render-process-gone`:
  24.3s end to end, against `PROBE_DEAD_MS` 20s plus one 5s tick.
- **Chromium's `unresponsive` is an INPUT hang monitor**, so a renderer nobody is typing into can
  spin for a quarter of an hour without it firing. The second reading is `executeJavaScript('1')`
  every `PROBE_EVERY_MS` (5s), queued on the renderer's own task queue. `GRACE_MS` 10s.
- **The refusals are the feature**: `RELOAD_COOLDOWN_MS` 60s (a window is unresponsive BY
  CONSTRUCTION while it reloads) and `MAX_RELOADS` 3, past which it is LEFT as shipped.
- **A dead renderer is rebuilt, not reloaded**, and `app.on('activate')` asks `alive()` rather than
  `getAllWindows().length` — a window whose renderer died is still in that list.
- **Nothing is lost and nothing is taken**: panes come back from desk.json and `--resume`. No focus,
  no show, no always-on-top.
- **The evidence is `paneforge-errors.log`**, including the renderer's CUMULATIVE cpu out of `ps` —
  `getAppMetrics().cpu.percentCPUUsage` is a delta and reads `0.0%` for a renderer that burned 14 min.
- `npm run test:renderwatch`; `PF_PORT=9334 npm run test:renderwatchlive`.

## A fault the app survived is a fault nobody hears about

`crash.ts` swallows faults so Electron cannot open a modal mid-sentence and `renderWatch.ts`
recovers silently, so the whole record is a log line. `shared/faultNotify.ts` decides,
`main/faultNotify.ts` is the one POST, on `askNotify.ts`'s channel. `npm run test:faultnotify`.

- **Every rule is a REFUSAL** — the expensive failure is a phone buzzing forty times. A **test copy
  pages nobody** (`profileName()`, which is why `startFaultNotify()` runs after `initProfile()`);
  the crash-guard **drill** is not a fault; an unregistered kind is not sent; `MAX_PER_RUN` (5) is
  the whole run's budget, with the last message saying it is the last.
- **Only an ACT is news, never the reading that led to it** — of the eight or nine lines around one
  recovery, only `reload`, `recreate` and `still wedged` leave the machine.
- **The signature blanks the digits**, or two reports of ONE wedge never match and `QUIET_MS`
  (30 min) never fires. That is the control in the test.
- **It is a LISTENER on `crash.ts`, not a call inside it** — that module loads before the profile,
  config and window, so it may not import any of them. `write()` appends the log line first and
  unconditionally, then tells listeners inside a `try`. Source assertion in the test.
- Silent with no `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, and never awaited.

## A restart onto a new build says what changed

One card, bottom-right, z-index 59 — a step below the update prompt, because a newer downloaded
build outranks a summary of the one before. `shared/whatsNew.ts`, `main/whatsNew.ts`,
`WhatsNewCard.tsx`. `npm run test:whatsnew`.

- **The bullets are the release's own notes** from `scripts/release-notes.mjs`, machine half of each
  subject stripped, capped at 6 sentences of 120 characters.
- **The refusals are the feature**: a FRESH INSTALL, an ordinary restart, a ROLLBACK and a body with
  no readable bullets all say nothing.
- **No network says nothing AND does not remember the version**; the two silent paths that DO
  remember have nothing to come back for.
- Not a dialog, no focus, no animation.

## Never take the screen

The app runs all day beside real work. Nothing it does on its own may take focus, raise a window, or
pop a dialog. Only a click or a hotkey earns the foreground.

- `showInactive()` for a window nobody asked for; `focusWindow()` is user-initiated only.
- `revealPlan()` in `src/main/profile.ts` decides the launch reveal per platform. A self-decided
  restart calls `markQuietRelaunch()` first; the new process consumes that marker, starts inactive
  and flashes the taskbar button.
- No `dialog.showMessageBox` for anything the app decided itself — in-renderer cards
  (`UpdateToast.tsx`). No `setAlwaysOnTop`, no `moveTop`, no `app.focus`.
- Every `spawn`/`Start-Process` keeps `windowsHide: true`. (On this PC that flag is ignored for
  detached console spawns — wrap in `run-hidden.vbs`.)
- `second-instance` must not raise the window while `installStarted` is set.
- Game mode may DELAY the window, never lose it (`gameMode.ts`).
- `npm run test:quiet` pins both halves, and SKIPS out loud when a real game is on screen.

## Two machines, one desk

`src/main/remote/` lets a second device drive this one's panes. Both ends are peers.

- **Nothing is mirrored until it is picked, and a device may not pair with itself.** `Remote.probe`
  refuses an id equal to ours at the handshake; `start()` drops one already saved, because a config
  outlives the bug.
- **The pty never moves.** A mirrored pane's agent, checkout, transcript and worktree stay where it
  was opened. Session ids are the seam: `@<device>/<id>`, and `remote.owns(id)` routes every message.
- **A mirror BORROWS the terminal's size; it never owns it** (`resize(borrowed)` in
  `main/sessions.ts`); `returnSize(id)` gives it back per-pane, never `returnSizes()`.
  `shared/mirrorFit.ts` is the FALLBACK for a host that has not applied the borrow yet.
- **Several screens may borrow ONE pty, and the smallest grid wins** (`shared/paneSize.ts`, per axis).
  **The viewer name must be forwarded, never invented at the boundary** — the api object in
  `main/index.ts` is both the phone's surface and the remote host's backend, so hardcoding `'phone'`
  files every device under the phone's slot; a guest is keyed per CONNECTION (`GuestConn.key`).
  **A borrow is a LEASE, not a flag**: `at` renewed by the 30s `pty:visible` tick, expiring after
  `BORROW_TTL_MS` (90s), because a phone that locks never sends `pty:return`. A link viewer is filed
  `at: 0` and ends with the connection. A desk resize under a borrow sweeps first, or a stuck borrow
  is unrecoverable by construction. `npm run test:panesize`.
- **A close takes the row at once, and a link that could not carry it says so.** `Remote.closeOn`
  hides the row the moment the frame is on a live link and gives it back after `CLOSE_ACK_MS` (3s) —
  a refusal may not wear the shape of a close. `RemoteClient.send` answers whether it went
  (`app:error` rather than silence), and `proveAlive` turns the unanswered press into the liveness
  probe instead of waiting for `DEAD_MS` (45s). A link that HAS spoken since is left alone — the
  control in `test:remote`.
- **A mirror never reports the busy footer**, and **frames are decoded where they are consumed**,
  never where they arrive (handshake and first encrypted frame routinely share a TCP segment).

The pairing code is never sent, only proved; traffic keys derive from it (scrypt, then AES-256-GCM
per direction), so rotating it cuts every paired device off. Hosting is off until switched on;
discovery is a UDP broadcast carrying no secret. `npm run test:remote`.

**Pairing can also be a button**, and then six digits derived from an X25519 exchange binding BOTH
public keys are the authentication — a relaying machine cannot make the numbers agree. The card
leads with the number, not the device name. `PROTOCOL` stays 1: an older build does not recognise
`askpair` and refuses, which is correct. `npm run test:pairask`.

**A paired machine also says what it is running OUTSIDE its panes** — `shared/backJobs.ts` reading,
`main/backJobs.ts` process table, `jobs`/`jobslist` frame, `PeerJobs` in `RemoteDialog.tsx`.

- **Three narrow classes, and the narrowness is the feature**: an agent CLI outside a pane (`agent`),
  a dev server (`dev`), and a script under the projects root older than `LOOP_MIN_SECONDS` (`loop`).
- **Anything under a pane's own tree is left out** — that work already has a card.
- **The age floor belongs to the loop class alone**, or the list is mostly sub-second hooks.
- **The fold is kind-aware**: `npm run dev` and its `next dev` child are one server, but a dev server
  an AGENT started is two different facts.
- **A refusal may never share a shape with an empty answer** — `Remote.jobsOn` rejects when the device
  is not connected, because `[]` means "running nothing". On demand, never on a tick.
  `npm run test:backjobs`.

**A handoff moves the WORK, still never the pty.** `HandoffDialog.tsx` asks one question — which
machine — and says what travels (the repo as an `auto-sync:` commit, the conversation, the screen,
the dev servers) and that a mid-turn pane is **queued, never killed**. `Hand off all` in Devices is
the bulk path (two presses). The sender's pane closes only on the far end's ack and reappears as a
mirror. The receiver never destroys local state: a dirty or unpushed checkout refuses THAT pane by
name. Paths map by grafting the root-relative path onto the receiver's projects root
(`shared/handoff.ts`). `npm run test:handoff`, `npm run test:handofffit`.

## The phone is this window, served

There is no second app. The renderer imports nothing from Electron or Node — pure UI over
`window.api` — so a phone client is that object over HTTP: `src/main/phone.ts` serves the built
renderer, `renderer/src/browserApi.ts` supplies the object, and **`src/shared/surface.ts` is the ONE
list** (`SURFACE`) both transports are built from, typed so a method with no channel does not
compile. Never add a channel to a transport; add it there.

- `tapIpc()` MUST stay at the top of `index.ts`, above every registration. Events go down one SSE
  stream, and `phone.broadcast` sits **ahead** of the window check in `send()` so a minimized window
  cannot starve a phone. Sends are queued client-side because they are ordered.
- **Off until Devices is opened, and opening it IS the switch.** Unpaired gets the pairing page and
  not one asset; five wrong codes locks that address for a minute. The cookie is
  `hmac(deviceId, code)` — derived, never stored — so rotating the code signs every phone out.
- **Watching and typing are different permissions** (`src/main/passkey.ts`). With `phone.typeGate`
  on, the first keystroke of each 15-minute window costs a passkey touch. The gate is on `/pf/send`
  and `/pf/call` and **never on `pty:write`**; it arms only over TLS; a 423 refuses the WHOLE batch
  before anything runs, re-queued at the front. `DESK_ONLY` refuses `phone:typeGate` and
  `phone:forgetKey` over HTTP.
- **Scanning asks; a press on the desk answers.** `POST /pf/ask` raises a card here with four digits
  on both screens, and Approve mints THAT browser a 32-byte token — nothing on screen can be
  photographed and a device can be signed out by name. One request at a time, five per address per
  ten minutes, two minutes to answer. With asking off the code rides in the URL **fragment**, which
  a browser never sends to a server.
- **Behind a tunnel every client is 127.0.0.1**, so `addressOf` believes `cf-connecting-ip` (then
  `x-forwarded-for`) and does so ONLY from loopback.
- **One row per device, not one per approval.** The panel says who is WATCHING, never who is paired;
  `New code` is the only revoke.
- **The ten-year cookie is watched, never revoked on suspicion** (`shared/deviceWatch.ts`): a changed
  place is recorded and never alarmed on; a changed browser shape and one live stream from two
  origins at once are the marks. A mark is never cleared by an ordinary arrival; `phone:clearMark` is
  `DESK_ONLY`.
- **`SameSite=Lax`, never `Strict`.** `Secure` only when the request really arrived over TLS.
- **A way in from anywhere**: `main/funnel.ts` (Tailscale Funnel — stable hostname, so a phone signs
  in ONCE) first, falling silently through to `main/tunnel.ts` (cloudflared quick tunnel). Never look
  the hostname up before `Registered tunnel connection` — an early query caches NXDOMAIN for 40s.
  `up` is set by a real HTTPS request returning our own bytes. Everything cloudflared says is on
  **stderr**. Turning it on lengthens the code to 14 and signs every phone out.
- **The QR leads with the LAN address**, tailnet after it; `reachWords` never promises "works
  anywhere" for an address marked "this network".
- **A copy made on the phone is the PHONE's clipboard** — `browserApi.ts` answers
  `copyText`/`readClipboard` locally.
- **The output is also served as TEXT** (`TextSheet.tsx`): a finger cannot select a canvas. Read off
  disk (`sessions:log`, up to 8 MB), RENDERED through an off-screen xterm, never stripped.
- **A text field must opt back IN to selection** — `body { user-select: none }` inherits and iOS then
  refuses the caret loupe. Both spellings, every input and textarea. Keys a phone keyboard lacks are
  drawn (`HandheldType`, 44px, as bytes).
- **The desk OWNS a pane's shape; a phone BORROWS it.** A desk resize during a borrow is REMEMBERED
  and applied when the phone lets go. A COLUMN change clears the buffer and asks for a repaint —
  `clear`, never `reset`.
- **A phone cannot read "the desk is asleep" off its own screen** — its rows carry no clock.
  `shared/linkState.ts` + `LinkBanner`: how long since the desk said ANYTHING, and that the rows below
  are a photograph. It never claims the machine is asleep, so "asleep?" keeps its question mark.
  `LINK_QUIET_MS` 20s. Three sources say so — the stream erroring, the stale timer, and a failed
  `/pf/call` (regularly the FIRST proof, since a suspended EventSource never fires an error). Coming
  back to the tab re-reads the desk on the spot. `npm run test:linkstate`.
- **A phone is not a small desktop.** `handheld.ts` + one `@media` block: under 720px, or a coarse
  pointer under 520px tall, list and panes take turns with `display: none`. `100dvh`, never `100vh`.
  Every pane action moves behind one ⋯ into `PaneMenu.tsx` (52px rows, words, destructive last).
  `isPhoneClient()` gates AUTHORITY only, never layout.
- **Automation opens a pane through `scripts/pf-ctl.mjs`**, never `open --args` (one em dash makes
  macOS drop the whole argument list and exit 0). On PATH as `pf`:
  `pf open <cwd> --prompt "..." [--agent A] [--model M]`, then `pf list` to verify.
- **...and that pane can close itself and say so.** `--close-when-done` (with `--report-to`,
  defaulting to `PF_PANE`). WHEN is the whole rule (`shared/closeWhenDone.ts`): printed at least once,
  out of its turn, no question, no shell command, no background job left — that last read comes off a
  4s process table, so the pane must stay finished `CLOSE_DONE_QUIET_MS` (8s) rather than closing on
  the turn's edge. The opener is told through `queuePrompt` and BEFORE the kill, because `kill()`
  deletes the request that names it. `npm run test:closedone`.
- `npm run test:phone` (server + surface parity); `npm run test:phoneview` needs a running copy. A
  pane's text is in `window.__pf[id].term.buffer`, never in the DOM.
- Not built: headless host (B1), phone-first diff (H2).

## One long ask is several panes

`shared/splitPlan.ts` rules, `main/splitPrompt.ts` reading, `SplitDialog.tsx` screen.
`npm run test:splitplan`.

- **The reading is an agent CLI run ONCE, headlessly, and it is the only agent this app starts outside
  a pane.** `HEADLESS` holds only CLIs measured answering a one-shot prompt; one without is refused,
  never guessed at.
- **It runs in an EMPTY folder under userData**, with `--settings '{"hooks":{},"outputStyle":"default"}'`
  and `--strict-mcp-config`: a headless run loads the settings, hooks and CLAUDE.md of wherever it
  starts, and `--settings` cannot cover a project file.
- **An answer that is not a plan is `null`, never an empty plan** — an empty list shares a shape with
  "this is one job", which is a real answer. The refusal quotes the first 160 characters said.
- **Every `{` is tried when reading the object out of the answer**, not only the first.
- **`MAX_TASKS` is 4 — the lane pool**; everything over it is NAMED in `dropped`.
- **Nothing opens until the rows have been read**: title, folder and whole brief are editable, because
  that brief is the only thing its pane will ever be told.

## A pane can run on somebody else's model

Most of `shared/agents.ts` is one binary pointed somewhere else: Claude Code reads
`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` and nothing else. Separate ids rather than a switch on
`claude` — the two have different histories, costs and failure modes and a pane must say which it is
on its card. `npm run test:agentenv`.

- **A base URL carries NO `/v1`; the CLI appends `/v1/messages` itself.** OpenRouter is
  `https://openrouter.ai/api`. With `/api/v1` the CLI blames the MODEL in a pane whose model is fine.
- **A provider is an entry in `KEY_PROVIDERS` plus an agent whose `env` names `keyVar(id)`** — Settings
  draws its key field off that list.
- **"Anthropic-compatible" is probed, never read.** DeepSeek and Z.ai answer a junk-key POST with a 401
  in Anthropic's own error shape; **xAI does not**, so Grok is its own CLI entry (`~/.grok/bin`,
  hydrated by `which.ts`).
- **A key pasted in Settings reaches the menu somebody is looking at.** `siblingModels` borrows another
  runner's models into this dropdown under the PROVIDER's heading, each row carrying `agent` so the
  press switches runner and model together. Two refusals: only a SAVED key, and only a sibling on the
  same `bin`. `config:set` invalidates the 20s agent cache.
- **A blank key drops the token and KEEPS the base URL** — dropping both runs plain Claude Code in a
  pane whose card says GLM. The Settings card names the missing key (`missingKeyFor`).
- **`HEADLESS` is keyed by agent id.** Grok is deliberately absent — its headless flags are unverified,
  and `drivable()` refusing beats a guess.

**Gemini CLI is not in the catalogue** — Google cut consumer accounts off 2026-06-18 and AI Pro/Ultra
does not entitle it; removed 2026-08-26 as a second, worse way to reach Google's models.
`GEMINI_DEFAULT_AUTH_TYPE` went with it: it is a DEFAULT, and a machine whose `~/.gemini/settings.json`
says `oauth-personal` keeps going to the dead endpoint whatever the environment says.

**Antigravity CLI is where that login WENT** — `agy` (id `antigravity`), a Go binary from Google's own
installer, NOT npm where the name is squatted, landing in `~/.local/bin` or `%LOCALAPPDATA%\agy\bin`,
both hydrated by `which.ts`. Plain Google account signs in; AI Pro/Ultra raises limits rather than
being the price of entry. `--continue` / `--conversation <id>`. **It carries no model list on purpose**:
`agy models` refuses until signed in and Google publishes ids nowhere, so `/model` inside the TUI picks
one. No `uninstall` either — the installer appends a PATH line to five shell profiles.

## ...and the model list is not this build's opinion of what exists

`main/orModels.ts` keeps OpenRouter's own public list on disk beside the hand-written
`OPENROUTER_MODELS` shortcuts; `shared/orCatalogue.ts` turns it into the menu.
`npm run test:orcatalogue`.

- **It may never be in anybody's way.** `listAgents` is synchronous, reads the catalogue from MEMORY
  and kicks the fetch with `void`. Missing, stale, empty, offline, a 502, an error page: each leaves
  the app as it was. **An empty answer is a FAILED answer** and is never written over a good one.
- **Only models that can call tools.** A row not declaring its parameters is dropped, never guessed at;
  everything left out is one "Other..." away.
- **Nothing is capped, and every row carries BOTH prices** — a cap inside a filter box is invisible.
  Free models lead under their own heading. `Select` searches the VALUE as well as the label, because
  `labelFor` strips the vendor and the vendor is what people type. Newest first, in both groups.
- **A stealth model says so in the hint**: an anonymous provider retains prompts and completions.
- **How a CLI addresses the model is read off its own `env`**, never off a list of ids.

## Every colour is derived, and every pane says which project it is in

**There is no palette.** `src/shared/theme.ts` computes one from a single accent; `applyTheme` writes
it as CSS variables onto `:root`. Literals in `styles.css` are the ~40ms fallback before config loads.
Adding a colour means adding it to `paletteFor`, never to a component. The maths is Oklab — hue and
chroma held while lightness sweeps, `inGamut` binary-searching the chroma that fits — because
per-channel RGB clamping hue-shifts rather than desaturates. **Light themes live above ~0.9 on the
depth slider**; Paper is 0.98. Default accent `#f0a868`. `npm run test:theme` is 358 assertions whose
load-bearing half is contrast: 4.5:1 body, 3:1 secondary, every preset and hue at full tint.

**A token that passes is not a component that passes.** `npm run test:contrast` proves the RENDERED
window, both themes, desk plus Settings/Devices/History. What makes it a measurement:

- **The backdrop is SAMPLED, never walked** — every glyph made transparent at once
  (`-webkit-text-fill-color`), ONE screenshot is the backdrop. An ancestor walk reports
  white-on-gradient as white-on-white.
- **The rect is the TEXT NODE's own line boxes**, inset, worst pixel minus the worst 5%. An element
  rect is as wide as its row.
- **A rect inside the viewport is not a rect anybody can see** — five points per box are hit-tested.
  The pet is hidden for the sweep for the same reason.
- **A minimized window parks its animations on the first frame**, so animation and transition are
  killed for the sweep.
- **Secondary text is held to 3:1**, decided by the element's computed colour matching `--muted`; a
  LOGOTYPE is exempt.

`readableOn` sweeps each semantic lightness away from ALL FOUR surfaces **and from each surface tinted
16% with the colour itself**, because every one is drawn on a chip washed with its own colour.

**A `var()` naming a token that does not exist never errors** — in a `color` it inherits something
plausible. Resolve colours in a real window, and check every `var(--x)` against the keys `paletteFor`
returns. Only `--agent`, `--level` and `--mono` are legitimately absent.

**The floating Stash is a second window and obeys the same law** — its own `shelf.css`, colours from
`applyTheme`, plus two shapes the palette does not supply: `--acc-rgb` (the accent as a triplet;
`rgba()` of a hex is dropped in silence) and the `light` class on `:root`, off the luminance of the
derived `--bg`, because *light or dark is the depth slider's answer and never the OS's*.
`npm run test:stashtheme` refuses a colour literal in that file outside a `var()` fallback.

**Every pane says which project it is in.** `src/shared/place.ts` is the only thing allowed to turn a
folder, branch, worktree suffix and lane id into words. `npm run test:place` is 56 assertions.

- The project name is never omitted and never abbreviated; everything else is added only when not
  implied. One pane, one repo, trunk → `PaneForge`.
- A trunk branch is answered ("main checkout"), not hidden. A branch a tool generated to hold a copy
  (`pf/w2`, `lane-a`, `worktree-<slug>`) is dropped — it repeats the copy's own number.
- Two numbers, worded apart: `copy 2` is the second checkout, `pane 3` is the third card and Ctrl+3
  reaches it. Only the pane number is a keystroke, and only chats are named by it.
- `-a` is stripped only when the caller already knows the folder is that lane — `service-a` is a real
  project name. Only `-w<digits>` comes off unasked.
- The sidebar has no `git status` of its own, so it may not assert "not a git checkout".

## A pane says how long it has been open

The header's clock is the TURN and resets when the agent finishes; `.pt-open` is `openedAt ??
createdAt`, beside it, off the header on a phone. History carries the same number frozen at `endedAt`.
`npm run test:elapsed`.

- **A clock is woken no faster than it is READ.** `stepFor` (`shared/elapsed.ts`) is the unit the
  string draws: 1s under an hour, **60s past it**, `Infinity` for a frozen clock. One interval serves
  the whole app.
- **The buckets are measured from the clock's OWN start, never from the wall clock** — a wall-minute
  bucket ticks as rarely and shows the wrong minute for up to 59 seconds of every one. That is the
  CONTROL assertion.
- **The arithmetic lives in `src/shared/elapsed.ts`, not in `Elapsed.tsx`** — a test cannot load JSX
  through node's type stripping. `formatElapsed` carries days.

## The sessions list is the whole desk, both machines

There is no Fleet screen. The sidebar answers "which pane needs me first": grouped **Your move /
Running / Ready / Ended**, `shared/fleet.ts` deciding, Ctrl+Shift+F back to the dragged order (in
`localStorage`, not config — it is a view). `shared/desk.ts` is the arithmetic; `npm run test:desk`,
whose load-bearing half is the negatives and whose last block is a SOURCE assertion: a field added to
`FleetPane` and not forwarded through the peer map still typechecks and sorts every remote pane wrong.

- **Listing is not mirroring, and that split is the whole design.** Listing costs a few fields on the
  `remote:changed` message already sent; mirroring costs a live byte stream and an xterm buffer here,
  per pane. `openListed` turns one into the other.
- **The order inside a group is the sidebar's own numbering, and nothing else** — breaking the tie on
  time-in-state reads well and swaps eight printing panes under the pointer.
- **A listed row has no pane NUMBER**; a real row's number comes off the FULL ordered list.
- **A mirrored pane is never listed twice.** A device that is off, connecting or in error lists nothing.
- **The badge counts both machines.** The device filter offers a machine that is merely CONNECTED.
- **A group is only worth a heading while its name is TRUE.** `Running` is `runSince` — a turn started
  by the submit keystroke, the agent's busy footer, or a shell pane's live command, ended by `endRun` —
  **or a background job the turn left behind** (`FleetPane.backJob`); never `status === 'working'`,
  which any output at an `engaged` pane set. `Ready` is not `!engaged`, which no pane could get back to:
  `/clear` drops `engaged` (`clearsConversation` in `shared/slashTurn.ts`, partial forms included);
  `/compact` and `/resume` do not.
- **A return pressed at an EMPTY composer asked nothing**, so it neither engages a pane nor starts its
  clock. The reading cannot be `typed === ''`: `slashTurn.isBareReturn` reads the same keystrokes a
  second way (`SUBMIT_OPTIONS`: pastes decoded, arrows and Tab setting `certain` false).
  `npm run test:slash`.
- **A shell pane's turn ends with its COMMAND, with no quiet clock in front of it** — a shell echoes
  every keystroke. POSIX only.
- **Your move is STILL once you have arrived at it.** `doneGlow` runs ONCE (1.9s; `DONE_GLOW_MS` must
  stay in step) and the standing amber marks do not breathe. A red `asking` bar keeps its pulse.

## A prompt tag says how long ago it was asked

The rail's hover tip is `echo rail  (5 min ago)`; the hover-HOLD under it is the exact moment. Same
`whenWords` as History's rows.

- **The clock is a minute, never a second.** A pane with no tags subscribes to nothing (`Infinity`).
  The offset is the NEWEST tag's own moment.
- **A tag is never measured against a clock older than itself** — `railNow` only moves on a bucket
  turnover, and `whenWords` answers a negative age with the full calendar date. `Math.max(railNow, m.at)`.
- A tag rebuilt from a restored pane's own output has no clock and says nothing about one.

## Finding something in a pane

Ctrl/Cmd+F, the ⌕ in the pane header, or `Find in this pane` in the phone's ⋯ sheet — all three are
`paneFind`, the map `TerminalPane` registers itself in. Highlights every match, counts them (`3/10`),
steps with ↑ ↓ or Enter / Shift-Enter. It searches the live xterm buffer, so it reaches as far back as
that pane's scrollback and no further.

## Finding a setting

The search box finds the SETTING, not the page: matching rows tinted, the best scrolled to and edged in
the accent, the rail following it to that tab. Nothing is hidden — a switch read out of the group that
explains it is a switch nobody can judge.

- **The index is GENERATED from the dialog's own source** (`scripts/settings-index.mjs` →
  `src/shared/settingsIndex.ts`, `npm run gen:settings`). `npm run test:settingsearch` regenerates it in
  memory and fails on disagreement.
- **A setting is found by its hint as well as its name**; a LABEL hit still outranks a hint-only one.
- **The marking is done to the DOM**, not by threading a `highlight` prop through nine tab bodies.
- `scrollIntoView` is `nearest`, never `center`. No animation (`test:anim`).

## A card answers a right-click, and can say what it is

`SessionMenu.tsx` is the desktop context menu — at the pointer, clamped on screen after it is measured,
arrow keys and Escape. Deliberately NOT `PaneMenu.tsx`, the phone's bottom sheet with 52px rows.

`SessionInfo.tsx` is the "see info" the card has no room for. **Its clocks are live** — `Open for`
counts from `createdAt` through `useNow`; the header's clock stays the TURN. Everything else is a
reading the app already holds, so opening it polls nothing.

## Copying a prompt, or the answer it got

Two copy icons beside every prompt on screen: the prompt, and the reply. Drawn for every VISIBLE turn,
never for the hovered one. Placement is `shared/turnCopy.ts` (`npm run test:turncopy`), fed by the rail's
prompt marks; two prompts closer than one pair is tall, the NEWER keeps the space.

- Icons rather than words; 22px pointer, 30px finger. `TURN_COPY_H` in `TerminalPane.tsx` is the height
  the crowding rule uses — change it with the CSS.
- **A mark keeps two copies of the prompt, and the button copies the one that is not the label.**
  `mark.text` is what the RAIL draws (one line, `.slice(0, 400)`); `mark.full` is what was typed, whole,
  and is what the clipboard gets.
- **Full strength as soon as the pointer is in the pane.**
- **The pair is placed from the frame that has just been DRAWN** — `syncGeom` from `onRender` and
  `onScroll`, never the rail's 250ms-coalesced `syncTotal`. Scroll-to-DOM 303/267/141ms → 4/1/2ms.
- **Keyed on the mark, never on the buffer row** — a marker's line moves when scrollback is trimmed, and
  a changed React key unmounts the pair mid-click.
- The reply is the rows after the prompt up to the row before the next one.
  `npm run test:turncopyview` reads the clipboard back through xterm's own input path.

**Every copy a person asked for says so** — Ctrl/Cmd+C, right-click copy, copy mode's `y` and the
selection chip all report in the toast with the line count as the receipt (`sayCopied`, one counter in
one place). Copy ON SELECT is the one silent path, deliberately.

## A click puts the cursor where you clicked

A CLI's prompt is drawn text and a pty takes keystrokes, so a click can only become the arrows that
would have reached the same cell (`src/shared/cursorMove.ts`). The trap: an up-arrow in a plain shell is
the previous command, not a movement.

- **A bare click is allowed the half that cannot recall anything.** `keysAlongLine` emits left and right
  only, and only when the click landed on the cursor's own logical line — proved by walking xterm's
  `isWrapped` chain. On mouseup, and only when the pointer did not travel.
- **The composer a CLI draws is ONE text field, found by its rules, not by its frame.** `composerAt`
  (`shared/promptBox.ts`) walks to the rule above and a rule of the SAME width below and requires a
  prompt marker on the first row. **Crossing a row boundary costs exactly one character** — the space
  the wrapper ate, or a hard newline — and **nothing** when the row is drawn out to full width; a row
  within a column of the width counts as full on purpose. **The marker is followed by U+00A0, not a
  space** (`BLANKS`). `npm run test:promptbox`.
- **A drawn input box is the one place a bare click may go up and down.** A plain shell draws none, and
  an ASCII `|` is deliberately not a frame.
- **A selection can be deleted, and typed over** — `keysForDelete` sends one backspace per character,
  only on the cursor's own line and only across rows the input WRAPPED onto.
- **The click is swallowed only on its way to an AGENT.** These handlers are capture-phase, and an
  unconditional `stopPropagation` robs xterm of the mouseup it removes its own drag listeners from. The
  stop is kept only while the CLI has mouse reporting on. `npm run test:stickyselect`.
- Alt/Option-click reaches other lines, refuses more than `rowLimit` away, and is the only path that may
  emit an up or down OUTSIDE a box. The clicked column is clamped to what is written on that row.

## A shell pane says what it is running

Every "is this pane working" reading is about an AGENT. `shared/paneJob.ts`; `npm run test:panejob`.

- **On POSIX it is the pty's own foreground process** (`tcgetpgrp`, behind `IPty.process`). One syscall,
  same 1s sweep.
- **Windows has no such reading, and the failure is a LIE rather than an absence**: `IPty.process` there
  returns `"xterm-256color"` idle AND busy. So the answer comes off the process table (`jobFromTable`,
  `TABLE_JOB_MS` 4s, only while a shell pane is open, never twice at once). **An empty table leaves every
  pane as it was.**
- **A BACKGROUND job is invisible to the foreground reading, and that read as idle** — `cmd &` leaves the
  SHELL in front of the tty, so `sweepTableJobs` answers on POSIX too, asked ONLY when the foreground
  reading came back empty.
- **`reclaim.ts` refuses on `job` as well as on `busy`** — different readings, and one of them was wrong.
  The load-bearing test case is `job` refusing ON ITS OWN, with `busy` false.
- **It feeds `busyOnScreen`, rather than being a state of its own.** The clock counts the COMMAND.
- **Narrow on purpose, because the expensive failure is a FALSE job**: only a pane whose RUNNER is a
  shell, and a foreground that is itself a shell is a subshell, not work.

## ...and an agent pane says what it left running

`paneJob.ts` refuses to speak about an agent pane and that refusal is load-bearing. But an agent that
starts work in the BACKGROUND goes quiet the moment the turn ends. `shared/paneBackJobs.ts` is the
cosmetic half — a chip and a hover sentence — and feeds no BUSY reading. `npm run test:panebackjobs`.

**It does rank the row, and only that.** `Session.backJob`/`backJobSince` (from `backJobInfo` in
`main/usage.ts`) reach `fleetState`, where a pane holding one is `working` with its clock counting the
JOB. Out of `busyOnScreen`; a live question still outranks it, a stale bell does not.

- **A count of the pty's descendants is not the reading** — every `claude` pane here permanently holds
  `safaridriver --mcp`, `chrome-devtools-mcp`, `codegraph serve --mcp` and `caffeinate`: trees of 5-9
  with nothing running.
- **What separates them is HOW a process was started, never what it is.** Every command an agent CLI runs
  goes through a shell it spawns with `-c`; MCP servers and `caffeinate` are spawned directly. So a job
  is a SHELL SUBTREE under the pty — no vendor names anywhere in the rule.
- **The age floor is `backJobs.LOOP_MIN_SECONDS`' 30s and for its reason**: a foreground Bash call is a
  shell subtree too. A subtree is never walked INTO, so a `npm run dev` with its own sub-shell is one job.
- **Shell grammar is not a name.** A keyword that HEADS a control structure owns its line
  (`for i in $(seq 1 120)`); a marker between header and work (`do`, `then`) is stepped over like a
  PREFIX word. `ps` prints a newline as `\012`, so that is what a multi-line `eval` splits on.
- **The name comes off the `-c` string, first segment that is not housekeeping** — the LAST segment names
  a `sleep 400; true` job `true`. Oldest live descendant is the fallback; `workName` prefers the script
  over the interpreter.
- **It rides on the sampler that already runs** — `main/usage.ts` reads the table every 4s, so `ps` gained
  `etime=` and `command=` rather than the app gaining a second ~380ms read. `shared/usage.ts` imports the
  rule as a TYPE only, or node's type stripping cannot resolve the extensionless sibling.

## What a pane leaves running

Quitting kills each pty with `taskkill /F /T <pid>`. Two things sit outside it and `src/main/strays.ts` is
both: an orphan whose middle process exited (so `npm run dev` leaves vite behind), and the app dying
without running `shutdown()`. A sampler walks each live pty's descendants every 30s into `strays.json`,
keyed by the app run that owns it; closing a pane, quitting and the next launch all kill from that ledger.

- **A pid is never enough** — every record carries the creation time, re-checked by whatever kills.
- **A run whose app is still alive is somebody else's** — usually the `npm run try` copy.
- **Nothing here may block the main process** — every table read is `execFile`; the two paths that cannot
  wait hand the pids to a detached script.
- It never asks what the pane is RUNNING — a per-CLI hook is out of date the day a new agent ships, and
  silent in the crash case. POSIX needs almost none of this.
- `npm run test:strays` spawns real orphans (~25s) and loads the real `spawnDetachedNoWindow`; stubbing it
  makes every kill silently do nothing.

## A pane opened with a prompt sends it

`queuePrompt` in `src/main/sessions.ts`. A blind timer fails silently: the pane holds a fully typed prompt
nobody sent, idle and green. `npm run test:promptsubmit`.

- **The readiness signal is an idle COMPOSER, never a clock**: output stopped AND `readsBusy` false.
- **The busy read looks at the last thing PAINTED, not at a window of scrollback** — a boot's
  `esc to interrupt` never leaves the buffer, so a fixed tail calls a pane busy for ever.
- **The return is a separate write**, a beat after the text.
- **The submit is confirmed, not assumed** — the proof is a TURN (`runSince` newer than the write), never
  output, because a `/clear` restarts the CLI and its banner paints for seconds. A busy pane is WAITED OUT
  to the deadline rather than counted as a submit; an idle composer with no turn behind it gets another
  return. The old settle-on-busy branch is named as the bug in a source assertion.
- **A `/clear` is not a boot, so it does not get a boot's patience.** The hook chain paints in bursts with
  second-long gaps, so the idle read says ready and the return is eaten. `PROMPT_ENTER_TRIES` is **6** (a
  return at an empty composer is a no-op in every CLI here) and the resume prompt waits on
  `CLEAR_RESUME_BUDGET_MS` (**3 min**) against the launch prompt's 45s, with the handover curtain following
  the same number. All five exit paths write to `autoclear-app.log`, the one that matters saying `UNSENT`.
- **The clear itself is 27s and about a second of that is waste**: 2.4s for the turn to end, 11.4s of
  `ARM_QUIET_MS`, 15.0s of the countdown somebody is meant to be able to stop, 0.9s of arm lead against a
  nominal `ARM_CLEAR_LEAD_MS` of 120ms. Shortening either big number is a decision, not a fix.
- Model ids are part of this: a Codex pane on any `gpt-5.1-codex*` id answers `400 ... not supported when
  using Codex with a ChatGPT account` inside a healthy-looking pane, so `agents.ts` lists only ids measured
  answering on a subscription login.

## An agent's question is a row of buttons

`shared/choices.ts` reads the chooser off the pane's own frame, so it covers every CLI rather than
whichever one has a hook. **The card is docked to the RIGHT of the question and does not repeat it**
(260px, full width on a coarse pointer); answers one per line, all the same width, so arrowing repaints
one border instead of reflowing a row of pills. `npm run test:askrender` pins the dock, the absent copy
and the equal widths.

- **The reading is narrow because the expensive failure is a FALSE question.** Three things must all be
  true: the CLI's own `Enter to select` footer, options numbered 1..N with no gaps, and exactly one row
  carrying the arrow. Both positive fixtures in `npm run test:choices` are real frames.
- **The screen that ENDS a multi-question ask prints no footer.** `REVIEW` is a second anchor sitting
  ABOVE its list so `readReview` walks DOWN, winning only when newer than the last footer. Two refusals
  keep it narrow: 1..N with exactly one `❯`, and **nothing but blanks and rules below it**.
  `submit`/`done`/`finish` join `GOES`; `Submit answers and don't ask again` is refused by `WIDENS`.
- **A RULE in the list is read exactly like a blank line**; the box gutter is stripped. The FOOTER is
  still the load-bearing guard.
- **Arrows and a return, never the digit** (a chooser that only reads arrows ignores a digit silently),
  `CHOOSE_GAP_MS` apart, counted from where the arrow is NOW; a press against a question the pane has
  left is REFUSED.
- **The reading is on the SESSION, not in the pane** — the phone draws the same buttons, `pty:choose` is
  reachable over the phone server, a mirror is answered over the link.
- **A question is RED, makes its own NOISE, and leaves the machine.** `.row.asking` glows down the card's
  left edge while `Session.ask` is set; no ring on the pane itself. `sounds.ask` (default `knock`) plays
  on `sessions:ask` and `done` is deliberately NOT played over it. `main/askNotify.ts` posts to Telegram:
  silent without `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, one message per question (`sameAsk`), never for
  a mirror, and it posts and stops — a bot token has exactly one long-poller. `scripts/pf-telegram.mjs`
  turns a TAP back into `pty:choose`. `npm run test:asknotify`.
- **A click on a pane holding a question types NOTHING into it** — `askRef` refuses the bare click, the
  Alt-click and the selection delete while `Session.ask` is set; the answer is the buttons.
  `npm run test:askclick` is a real mouse through CDP, controlled by the same click with no question still
  sending its arrows. **`window.api` is frozen by the context bridge**, so the pane keeps its own list
  (`window.__pf[id].clickKeys()`).
- `npm run test:choices`; its load-bearing assertion is on the BYTE (`charCodeAt(0) === 27`).

## Arrowing through a question may not cost the whole desk

The sessions list is ONE array rebuilt whenever anything about any pane changes, and a pane's render
re-measures the turn-copy pairs and the rail against the live buffer. `TerminalPane` is `memo`'d with
`samePaneProps`, comparing `ask`, `termTheme`, `mirror` and `grid` BY VALUE because main sends a fresh
object each time. Five arrow moves: 34 renders of every pane → 5 on the question's pane, 0 elsewhere.

- **The load-bearing assertion is the bystander's count**, not the question pane's — a memo that also
  skipped the question pane would pass a "renders went down" check and break the feature.
  `npm run test:askrender`; `window.__pfRenders` is the per-pane counter.
- A prop added to `Props` without a line in `samePaneProps` is a pane that stops updating for it, which is
  why that function lists them out instead of looping over keys.

## ...and a pane that is only PRINTING may not talk to React at all

A memo stops the re-render, not the dispatch. `setState` with the value the state already holds still
costs `requestUpdateLane`, an update object and the eager evaluation before React bails out — and a pane
writes three of those from `onRender`/`onScroll`. Measured over eight shells: the desk's React work was
37ms of a 3-second run over 17 renders while `requestUpdateLane` ALONE was **18-22%** of the profile.

- `useQuietState` (`renderer/src/quietState.ts`) mirrors the value in a ref and compares in FRONT of the
  dispatcher. `geom`, `selChip` and `scrolledUp` are quiet. The updater form is kept — it is how a caller
  says "the same object when nothing moved" — and is evaluated against the ref.
- Keystroke to frame median **297/49/423ms → 40/34/34ms**, p90 **420/420/819ms → 220/42/39ms**, GC
  **26-38% → 4-5%**.
- **The guard is a SOURCE test**, `npm run test:quietstate`, because the fault looks correct from every
  other angle. `npm run type-profile -- --blame yi` is the measurement and asserts nothing.
  `window.__pfDeskRenders` carries `ms` as well as `n`.

## ...and a question with an obvious answer is answered

`shared/autoAnswer.ts` presses return instead — **on by default**, **thirty second** default wait.
`npm run test:autoanswer` (weight in the negatives) and `npm run test:askrender`.

- **It takes the BEST option, not the first one.** A CLI marking its own preference (`(recommended)`,
  `[default]`, `- suggested`) is the tool STATING the answer, so exactly one marked option outranks a
  yes-shaped word and the row the arrow is on. Two marked options are a choice again. The marker raises
  rank and can never lift an option past a refusal.
- **The refusals are the feature.** Exactly ONE option leading with a yes-shaped word is answered. The
  arrow sitting on a REFUSED option is not a licence to take a different one. An option that WIDENS
  permission (`don't ask again`, the bare `always`) is never reachable, nor one that stops or answers with
  a question of its own. `anyQuestion` is the wider setting; both refusals hold over it.
- **The whole wait is spent AWAY from this window.** `holdWhileWatching` (on) stamps `askHold` while the
  app has the keyboard and `startOf` runs the clock from the later of that and `askSince`, so looking away
  starts the full `waitMs` again. Held draws no countdown at all (`autoAnswerHeld`). That is also what
  makes the Telegram buttons reachable. One focus reading: `gameMode.deskFocused()`.
- **Both clocks tick against the DEADLINE, not the wall clock** (`useNow(1000, at)`).
- **The timing is `dueForAuto`, and it takes TWO signatures.** The wait's signature includes the arrow;
  "have I already pressed this one" may NOT (our own keys move it), so `askKeyOf` leaves the arrow out —
  one press per identity, plus a `PRESS_COOLDOWN_MS` floor of 4s.
- **`maxRun` is given back by the pane going BUSY, and by nothing else** — a chooser mid-repaint reads as
  no question for one frame.
- **A hold CLEARS the deadline, it does not move it** — `refreshAutoPlan` writes `autoAnswerAt = 0`,
  because the card's `AskClock` and the desk tick (`soonestAuto`) read the bare number.
- **The countdown is a banded row in the pane, a chip on the CARD, and a TICK.** The chosen option's button
  carries `.auto` — dashed, because `.on` is a different fact. `playTick` sounds once a second through the
  last minute of whichever countdown is soonest (one clock, not one per pane), its own catalogue entry and
  Settings row, a third of an alert's level, deliberately bypassing the 900ms alert throttle.
  `window.__pfTicks` makes it checkable.
- **A changed default cannot reach an existing desk on its own** — `defaults()` is WRITTEN to config.json
  at first launch, so `defaultsV2` + `migrateAutoAnswer` apply the new defaults once, read off the **saved**
  config, never off the merge.

## A pane says what its handoff has left

A pane past the context line writes a handoff, and its `## Next steps` is the only place that answers "is
there work left in there". `shared/handoffSteps.ts` is the reading (a MIRROR of
`claude-memory/claude-config/autoclear.mjs`, as `promptKey.ts` mirrors the prompt fingerprint),
`main/handoffSteps.ts` the disk and the 30s cache. `npm run test:handoffsteps`, whose parity half SKIPS OUT
LOUD when the canonical file is absent.

- **`0` and `undefined` are different answers** — `0` wrote `None` and is finished, `undefined` never wrote
  a handoff. The chip is drawn for neither.
- **It decorates and it REFUSES; it reaches no busy reading** (same contract as `Session.backJob`).
- **The countdown re-reads it at the last moment** — everything in front of `armAutoClear` is a delay and
  the session works through all of it. The file is read again at the arm, and a handoff with nothing open
  refuses with `NOTHING_OPEN`, a string `pane-clear.mjs` carries in its non-overridable list. A
  `--no-resume` cost clear is exempt, and only a handoff that EXISTS may refuse.

## A pane that is still starting says so

`sessions:start` returns in 16-46ms; the first byte arrives ~1.3s warm, ~4.2s cold. `blank` stopped being
the reading the day scrollback came back — a RESTORED pane opens wearing its old screen. `Session.printed`
is the epoch of the FIRST byte out of THIS process, cleared by restart and wake, because only main can tell
replayed bytes from the new process's own.

`PaneBooting` draws one dim line at the BOTTOM (`.pane-booting.over`) while `booting`: **it names the
RUNNER** (`Starting Claude Code…`, off the agent's `label`) and adds a seconds count past `COUNT_AFTER_MS`
(1.2s). No spinner — a looping decoration is what `test:anim` refuses — and its own component, so the shared
tick is subscribed to only while a pane is starting.

`npm run boot-timing --panes 7`: panes back on screen with old output 1.3-2.6s, first byte 2.6-8.8s, a
typable composer 4.1-14.3s, main under 0.5s CPU in the first 30s. The wait is the CLIs (one `claude` alone
reaches a composer in 1.4s). **Staggering the restore was measured and is WORSE** — 300ms apart put the last
composer at 26-29s against 4-16s for one tick — so they still all start in one tick.

## A picture goes in front of the agent

Every agent reads an image off the DISK, so bytes are written as a real file **on the machine that owns the
pty** and that path is typed (`shared/attach.ts` naming, `main/attach.ts` disk). `npm run test:attach`.

- **A paste is the one place the ^V is right** — a clipboard image goes to an agent that reads the clipboard
  itself as a plain ^V; every other CLI and every MIRRORED pane gets the file and the path. Forwarding a raw
  ^V only ever worked with an agent that reads the OS clipboard AND is on the clipboard's own machine.
- **A path is only true on one machine** — `@device/id` and a browser send the bytes over the link, and
  `attachOn` answers with a path that exists over there.
- **The name is TEXT, never a path** — only the basename survives, both separators, control bytes and
  reserved punctuation gone. The extension comes off the MAGIC BYTES when recognised.
- 5 MB a batch (base64 over the 8 MB frame is 4/3). Nothing is submitted for you.
- **A dropped file arrives in TWO shapes** — a macOS screenshot dragged off its preview thumbnail carries
  `text/uri-list` with no File object, so nothing called `preventDefault` and Chromium typed the URL into
  xterm. `splitDropUris` turns a `file://` URI back into a path (percent-decoded, Windows' extra leading
  slash gone, a host kept as UNC); http(s)/data is fetched. `text/plain` is deliberately NOT claimed.
- Not covered: pasting an image on the phone client.

## What a pane costs is measured, not modelled

`capacity.ts` models a pane at 190 MB and answers "is there room for another". The chips answer "which one
is eating the machine" — `src/shared/usage.ts` arithmetic, `src/main/usage.ts` commands and timer.
`npm run test:usage`.

- A pane is its pty's whole descendant TREE — counting the pty loses the build the agent started.
- CPU is a delta of cumulative counters, never `ps %cpu` or a Windows perf counter. The first sample has no
  CPU figure; a process first seen mid-flight is capped at the interval.
- The sampler does not read the table while the window is hidden or minimised, and never has two reads in
  flight.
- **The memory column is read five times more slowly than the rest of the sample.** `top -l 1` costs ~1.0s
  wall of which **0.82-1.04s is SYS**, against 0.03-0.05s for the whole `ps` table, and `-pid` is a display
  FILTER that makes it no cheaper — so at `SAMPLE_MS` the memory chip alone burned a quarter of one core
  inside the kernel. CPU is a delta and must be read every tick; memory is a level. `FOOTPRINT_MS` (20s) is
  the rate, `dueForFootprint` the rule, and a pane that opened since the cached table forces a fresh one
  because a pane's FIRST sample is what the capacity ladder acts on. **16 → 4** `top` launches a minute.

## A reopened pane comes back with what was on its screen

The terminal's scrollback is renderer memory, so before this every pane reopened blank. `test:restore` is a
different promise — it hands the agent its `--resume`, which brings back the conversation and not one line
of the screen.

- **Most of them come back ASLEEP.** A pane can be BORN asleep (`Live.proc` is nullable, `start()` takes
  `asleep`), so the card, its place and its screen arrive with no process and a press wakes it in the
  conversation it was in. **A sleeping pane still has a SHAPE**: `sleep()` gives it `status: 'exited'` and
  `resize()` dropped every call for an exited session, so its grid froze at `START_COLS` and `wake()`
  spawned the CLI at the frozen number. Only a genuinely DEAD pane is dropped now. `restoreAsleep`
  (`shared/restoreTurn.ts`) is the rule and the refusals are the feature: the first pane, a pane launched
  with a prompt, and a pane the restart caught mid-turn all come back running. `npm run test:restoreturn`.
- **Nothing new is stored** — `history.ts` has appended raw output to `userData/history/<id>.log` all along
  and `tail()` reads the last `BUFFER_LIMIT`. The missing part was the **id**: a restored pane is a new
  session, so the desk carries `scrollbackId` and `start()` seeds from it. Save the new id there and it
  restores nothing, silently, for ever.
- `tail` must not strip ANSI (`read` does, for search) and must cut on a line boundary. One dim line says
  where the old output ends, and it resets attributes first. `test:scrollback`.
- **It comes back with its own clock, and finishes the turn it was cut off in.** The display clock is
  `openedAt`, deliberately NOT `createdAt`. A pane caught mid-turn is continued through `queuePrompt`, off
  `runSince`, under the SAME switch as a turn the transport cut in half.
- **Which restarts ask is one rule with one switch** — `askAfterUpdate` (Settings → Updates), off by
  default and inert while `restoreAfterUpdate` is off.
- **It is replayed at the width it was PAINTED at, and Fix cannot do this job.** Agent CLIs draw in absolute
  column moves and a terminal CLAMPS. `restoredTail` carries the old width out with the bytes (`colsOf`),
  `Session.replayCols` takes it to the pane, and the pane writes that part of the buffer at that width and
  hands the terminal back — **only the part before the restore mark**, and only while the mark is there. The
  resize goes in the write CALLBACK, never after the call. `shared/replayWidth.ts`, `npm run test:replaywidth`.
- **It presses Fix for itself** — `repair()` once, `RESTORE_FIX_MS` (1.2s) after output stops. It is
  `autoFixUi`'s; a mirror is refused; a hidden pane is FLAGGED rather than repaired against a 0x0 host.
  `test:restorefix`, whose control is a new pane recording ZERO repairs.
- **The prompt tags come back with it.** The rail is built from KEYSTROKES, so a replay registers none;
  `seedMarks` scans for the CLI's own `❯ <text>` echo, once, only while the rail is empty. **`❯` only** —
  `>` starts a quote, a diff line, a shell prompt and a blockquote. A rebuilt tag carries no time.
  **A row at a time is not enough**: a replayed screen holds every repaint, so `seedPrompts` refuses a row
  carrying a rule or followed by one, refuses one with a non-blank row above it, and keeps ONE tag per
  prompt, on the LAST copy. `test:promptecho`.

**And `/clear` no longer takes the previous turn with it.** Three releases of Claude Code wiped the screen
three different ways, so the answer is not a list of vendor bytes. `npm run test:scrollclear` drives a real
headless xterm with a control per shape.

- **The pane keeps the screen itself, before the CLI has emitted a byte.** `keep.arm()`
  (`shared/keepScrollback.ts`) fires when a submitted line matches `mayClearScreen` and RETURNS the scroll,
  which the pane writes on the spot.
- **What was TYPED is not what was SENT** — `/cle` picked from the completion menu runs `/clear`, so a bare
  slash TOKEN that is a PREFIX of one of those commands arms too. A miss destroys the turn somebody is
  reading; a false arm only scrolls a screen about to be repainted, and only rows holding something are filed.
- **The composer is not history** — `keptRows` stops at the composer's top edge, and the composer is only
  believed when the CARET is between its two rules.
- **`arm()` is fed by keystrokes, and a keystroke is one of several ways a clear arrives** — the Clear
  button, the session menu, a phone and every path in main that types for you go through `paneArmClear`.
- **The unarmed case is caught by SHAPE, then by OUTCOME.** The cursor sent to the top with an erase is
  REPORTED, not acted on; `shared/screenLoss.ts` files it only when **80%+ of the screen is gone** (a
  scrolling diff loses 35-44%). The `2J`/`3J` rewrite stays for a CLI that clears unasked, and stands down
  for 10s after an armed scroll.

**And a prompt tag survives the CLI repainting over it.** xterm disposes every marker on a row that `CSI J`
blanks (Claude Code lost 0 of 278, Codex 25-50%). `shared/markAnchor.ts` re-anchors on a deferred callback
while the line is still in the buffer, and ends the tag only when the buffer has genuinely forgotten it.
`npm run test:markanchor`, whose control proves a bare marker really does die.

## History says what each session was working on

Every row carries one line: the first thing typed at the agent, plus how many asks followed.
`npm run test:gist`.

- **It costs nothing** — no model, no tokens, no request; the line comes from keystrokes the app already
  relays, the same feed `promptArchive` is built from, so it works identically for every CLI.
  `shared/gist.ts` is only the tidy-up.
- **A row says when, as a DISTANCE.** Newest closed at the top (`endedAt ?? startedAt`); inside a day the
  chip is `closed 5 min ago`, past a day the calendar takes over because `31h ago` identifies nothing. One
  minute clock for the whole list, exact moment on the hover.
- **A row says whether it is still OPEN** — green rail plus a green `open since` chip, red rail plus a red
  `closed …` chip, so the answer is never carried by hue alone.
- **`View all` prints every chapter on the row** (`summaryFull`), drawn only where there is more than the
  row already shows, and it costs nothing.
- **The FIRST ask, not the latest.**
- **Scraping the transcript was tried and abandoned on the evidence** — a boxed composer is redrawn
  character by character and interleaved with its own repaints. A session that closed before the app
  recorded a line gets a best-effort one from the prompt archive and otherwise **no line at all**.
- **A session is several jobs, and `/clear` is where one ends.** `noteAskInto` reads a clear exactly as
  `keepScrollback` does. Three shown, the rest counted; a clear is a boundary and never a chapter heading,
  every other slash command heads nothing, and `asks` counts only the ones that were WORK. Twelve chapters
  kept, anything past that counted rather than dropped in silence.
- **What was asked survives a restart** — `recordStart` runs again on the same id.
- **The transcript is RENDERED, not stripped.** A pane's log is a stream of REPAINTS: a seeded 4 KB log was
  205 lines of which 200 said `Thinking…`, against 3 through a terminal. `renderer/src/termRender.ts` is
  ONE copy, shared with the phone's `TextSheet`, replayed at the width it was WRITTEN at.
- It is written outside the prompt-recall gate.

## The app remembers what has been asked

`src/main/promptArchive.ts` answers one question — has this ask been made before — fed from
`shared/draft.ts` on the way to the pty, **not** from any CLI's hook. That is why it works: reading the
bytes covers every agent, including ones that do not exist yet.

- **It never blocks, never types, never cancels** — all that happens is a chip in the pane's corner.
- The quiet window (`QUIET_MS`, 6h) is load-bearing, not the score: a reworded re-send two minutes later is
  the SAME work.
- Only submitted lines are archived, never drafts, and only a capped preview plus the token set.
- **`src/shared/promptKey.ts` is a MIRROR of an algorithm that lives in three places outside this repo**
  (the `claude-memory` hook, the TaskDriver archive server, the Discord bot), sharing one archive. Editing
  one copy splits it in silence. `npm run test:recall` recomputes the canonical file's answers and **skips
  out loud** when that file is not on the machine.
- Not built: nothing watches a pane's repo for the commit an ask turned into, so `outcome` is null.

## Dictation needs nothing installed

The mic on every pane, and Ctrl/Cmd Shift Space into the focused one. `shared/voicePick.ts` picks and
`useVoice.ts` falls down three transcribers: a **whisper CLI on PATH**, otherwise **Whisper in a worker in
this window** (`voiceWorker.ts`, ONNX Runtime wasm), and on a phone **the browser's own recogniser** (the
only one that sends audio off the device). `npm run test:voice`.

- **Feature-detecting `webkitSpeechRecognition` is not enough** — in Electron the constructor is there and
  every session ends `error: "network"`, so `browser` is gated on not being Electron.
- **The 8-bit weights do not run** (`TransposeDQWeightsForMatMulNBits / Missing required scale`); `bnb4` is
  the smallest that works. `shared/voiceModels.ts` carries the sizes.
- **The wasm ships with us**, copied by `electron.vite.config.ts`, which also deletes the 23.5 MB asyncify
  binary the worker never asks for.
- **Nothing on the page may import the worker's module** — one constant took the main chunk from 1.01 MB to
  2.23 MB. Constants live in `shared/voiceModels.ts`.
- **A phone is not a small desktop** — touch, or under 720px, and dictating takes the whole screen
  (`VoiceOverlay.tsx`); the ring IS the input level. It also appears while the model downloads.

## ...and it knows what is serving, and can stop one

`devServers.ts` answers a package.json SCRIPT, which is what the OTHER machine needs. `shared/devList.ts`
answers what a person asking has in their head — the PORT and the pane. `npm run test:devlist`.

- **One server, not one process** — a candidate whose ancestor chain reaches another candidate is folded
  into that ancestor (the thing a person typed, and the one whose kill takes the tree), and what the child
  knew is folded upward.
- **A number is not a port because it is a number** — only `-p`/`--port`/`--port=`/`PORT=` count; a wrong
  port is the one thing somebody acts on.
- **Attribution is two-legged**: tree first, then a path test against the pane's folder (a server reparented
  onto pid 1 defeats a tree walk). **A server no pane claims is still listed.**
- **An ambiguous stop prints the list and asks.** A generic label (`dev`, `start`, `serve`) never matches on
  its own.
- **The pid is re-validated in main before anything is signalled** — one whose command line is no longer a
  dev server is refused out loud. SIGTERM, then SIGKILL.
- The renderer supplies only the ORDER and the words; every fact is read in main off the pane's own record.
  Read on demand when the ask box opens, never on a timer.

## The resource ladder has a face

`capacity.ts`, `autoHandoff.ts` and `reclaim.ts` trim, move and close panes on their own, and their entire
output used to be a `console.info`. `shared/mascot.ts` is the mouth, `components/Mascot.tsx` draws it.
`npm run test:mascot`.

- **It is not a model** — every sentence is arithmetic over readings the app already holds, and every typed
  command is a small parser. Nothing leaves the machine.
- **What it says names the pane, which COPY of the project it is, what that pane was in the middle of, and
  when.** `paneWord` is `(1) taskdriver` / `(3) PaneForge lane a`: the number leads in brackets because a
  sentence naming several panes buries them otherwise, and it is the Ctrl key. `(3)` is also a form
  `paneNumbers` reads, or the pet cannot answer a sentence it printed itself. A pane nobody has typed a real
  ask into says nothing about one.
- **A pet is decoration; the reading is not, and `pet: 'none'` is the difference.** `NO_PET`
  (`shared/pets.ts`) keeps every reading and drops the sprite: the card docks bottom-right, and a pill
  carrying the pane count and total is the press that opens the ask box.
- **It may stand over a pane, but never over a LINE.** `spriteReserve` turns the overlap into bottom
  padding. Three things make it safe: rounded up to a whole ROW, measured against the HOST's box and never
  the drawn screen's (whose height feeds its own input), and a sprite above `RESERVE_MAX_FRAC` (30%)
  reserves NOTHING. The padding goes on `.xterm`, not `.xterm-host` — the fit addon reads the host's
  computed border-box `height`. Measured: 54 rows → 46, screen bottom 748 against sprite top 761.
- **Everything it says is selectable and copyable** — `.mascot-say` opts back in with both spellings, and
  the `⧉` copies `saidText`, the SAME expression the card renders.
- **"What is open" is an answer.** A dev server named beside a pane NUMBER narrows the SERVERS rather than
  handing the sentence to the pane branch. A bare "pane" with no number still means the panes.
- **A bubble takes itself away** (`mascot.hideSeconds`, 60s, 0 = until pressed); the clock restarts on every
  keystroke in the ask box, and a COUNTDOWN is exempt.
- **A guess is never an action** — "close pane 9" with five panes closes nothing and says how many there
  are; names match longest-first with a contained name dropped; every destructive intent is OFFERED as a
  press. `closeable()` is `reclaim.ts`'s own refusal set.
- **A finished turn is the pane this ladder exists for** — `fleetState` says `needsYou` for both a live
  question and a finished turn, so the refusal that is meant is `asking`, off `Session.ask`.
- **The countdown is HEARD, not only drawn** — `sounds.move` (default `bowl`) plays once when a countdown
  arms and the last five seconds tick.
- **Nothing decides and then reports: it counts down first.** Both sweeps hand their plan to `armCloseRef`
  and the mascot draws `CLOSE_COUNTDOWN_MS` (15s) with the pane named, `Keep it open` and `Close now`. Doing
  nothing still closes it. `Keep it open` holds for `KEEP_MINUTES` (10). With the mascot hidden there is
  nowhere to draw a count, so it closes.
- **It speaks unasked once per situation**, and only where the app is otherwise silent.
- **There are TEN of them and they cost the same** (`src/shared/pets.ts`). The animation is keyed on the
  SLOT rather than the animal, so a new pet is ART and nothing else. Only the picked one is mounted, layers
  are cached by identity, and the rig is `animation-play-state: paused` behind a minimised window. Every pet
  is on the SAME 24x24 grid — at 48 CSS px exactly 2 device pixels a cell. Detail comes from layers and
  shades, never more cells. A pet may not float; `test:mascot` fails on a `translateY` in that stylesheet.
- **It arrives OFF.** It runs about rarely and every condition is a refusal (`dueDash`, `DASH_EVERY_MS`
  9 min). It can be picked up, and a drop writes `mascot.spot` as a fraction of the window, **beating every
  automatic move**; the pin gives it back. Under `DRAG_SLOP` the gesture is still the press that opens the
  bubble, and the click after a real drag is refused from a REF.
- **The bubble is placed in the LAYER, in pixels** (`bubbleSpot`), clamped on both axes.
- **The layer never takes a click**: `z-index: 40`, over the panes and under every dialog,
  `pointer-events: none` except the sprite and its bubble.
- **Mute by default. It never picks which machine** — `hand off pane 2` opens the box with the panes chosen.

## ...and one card says what this app can even do

One quiet card bottom-right — `shared/tips.ts` catalogue and judgement, `components/Tips.tsx` the card.
`npm run test:tips`.

- **It costs nothing**: a fixed sentence chosen by arithmetic over what has been seen.
- **It never interrupts**: silent while any dialog is open, while an update card is up, while ANY pane holds
  a question, behind a minimised window, and for the first four minutes. `FIRST_MS` 4 min, `EVERY_MS`
  40 min; the load-bearing half of the test is those negatives.
- **It says how to stop it before anybody has to go looking** — the first card and every fourth after it
  carry the sentence and the button (`offersOff`). Settings is the way back on.
- **It cycles rather than repeating**: every tip shown once before any is shown twice, and `seen` resets
  rather than going quiet.

## A session that clears itself asks first

`claude-config/autoclear.mjs` (a Stop hook) decides a session is past its context line AND that its handoff
lists work a fresh session could start, then asks this app to clear that pane over the phone server
(`pane-clear.mjs` → `autoclear:ask`). The desk draws a countdown card: what would be continued, how long is
left, **Keep this session** and **Clear now**. Nobody at the desk means it still happens by itself.
`npm run test:autoclear`.

**The clear is typed; everything after it is TALKED to.** `/clear` goes out after the arm lead and the
resume prompt goes through `queuePrompt` — which waits for an IDLE COMPOSER rather than a stopwatch. The
blind schedule it replaces typed at a fixed +2500ms and fired two unconditional CRs: a stray Enter into a
live CLI on every clear. `clearChunks` is unchanged, so parity with the hook's `paneChunks` holds;
`CLEAR_SETTLE_MS` and `SUBMIT_RETRIES_MS` stay exported for the hook's own fallback.

`shared/autoclear.ts` holds every refusal and `main/autoclear.ts` the clock; both are re-evaluated against a
FRESH pane reading each tick, so a pane that starts another turn, is typed into, exits or disappears drops
its countdown. An ask with no open steps is refused at both ends. A PaneForge older than the channel makes
the hook REFUSE rather than fall back to the instant clear.

- **Nothing open means no clear, and that promise is made to the session in writing.** `blockMessage` tells
  a session about to write its handoff that `## Next steps` with `None` is respected. A clear exists to
  CONTINUE work.
- **The keeper is fed by KEYSTROKES, and nothing this path sends is one.** The countdown writes straight to
  the pty, so `feedInput` never saw the `/clear` and `keepScrollback` never armed. Main emits `armclear` →
  `pane:armClear` → the pane's own `keep.arm()`, `ARM_CLEAR_LEAD_MS` (120ms) before the command lands.
  Measured: `baseY` 0 → 6 with the emit, 0 without it.

## The screen stays on while a pane works

`shared/awake.ts` + `main/awake.ts` hold a `powerSaveBlocker` while any pane has an agent mid-turn or sits on
a question, and let go when the desk goes quiet. `npm run test:awake`.

The cap is the load-bearing part: it is on the BUSY STRETCH, not on the hold, so a wedged pane cannot keep a
laptop lit all night and cannot re-arm the hold by ticking. `config.keepDisplayAwake` turns it off.

**Holding the MACHINE awake never justified lighting the PANEL.** The lid guard's `pmset -a disablesleep 1`
makes the kernel ignore the lid OUTRIGHT, backlight included. `screenUnseen` drops the screen hold alone —
the system hold, the panes and the turn in flight are untouched. It is narrower than "the lid is shut" on
purpose: clamshell driving an external monitor reports the lid shut too, so Electron's own display list has
to say the builtin is the only screen. A reading that FAILED counts as false, and the control in
`test:awake` is the same desk with the lid up, still lit.

## A pane's two ends open at the same width

Everything an agent CLI prints is absolute column moves, and a terminal CLAMPS a column it cannot reach. So a
pane has exactly one rule: the grid it is drawn into may never be narrower than the width its bytes were
painted for. `src/shared/paneGrid.ts` is that one number, read by BOTH ends. `npm run test:panegrid`, whose
load-bearing half is the CONTROL — one line painted into a narrower grid MUST still tear across several rows,
because a clamp wraps rather than deletes.

- The pty spawned at 120 while xterm opened at its library default of 80, and a `claude --resume` dumps the
  whole conversation at once, so every answer drawn to column 119 was torn apart permanently (xterm can unwrap
  a row it wrapped itself and can never undo a clamp). NOT `shared/replayWidth.ts`'s bug, which is a RESTORED
  pane's old bytes; this is the pane's own live output, on every launch.
- **Fix now repairs the scrollback, not only the live frame.** `redrawHistory` re-renders from the raw byte
  stream at `max(pane now, replayCols, START_COLS)`, then hands the width back. User-initiated only.
  `window.__pf[id].redraw()` is the same thing for a probe.

## Checks

`npm run typecheck` before committing, and `npm test` — 81 checks in ~145s, everything needing no window, no
network and no real agent CLI (`scripts/test-all.mjs`). It is also the release gate's third step:
`agentGate.ts` looks for a script called exactly `test`. **A new cheap test goes in that list or it never runs
by itself.**

Each suite's one-line "what it pins" table lives in `docs/design-notes.md` under **Checks — what each suite
pins**; `npm run` lists the commands. Read that table before changing or deleting a suite, and add a row when
you add one.

Needing a real window (`npm run build && npm run try -- --keep --show --remote-debugging-port=9333`):
`test:view`, `test:stashdrag`, `test:activate`, `test:turncopyview`, `test:restorefix` (two launches),
`test:askclick`, `test:askrender`, `test:devicesfit`, `test:phoneview`, `test:contrast` (~90s, both themes),
`test:renderwatchlive` (spins the renderer on purpose, ~25s).

Out of the default suite because they need the network: `test:discordbrand` (asks Discord what
`DISCORD_APP_ID` is called AND whether `PRESENCE_IMAGE`'s asset still exists — the two halves fail
separately), and `node scripts/mac-update-test.mjs --live <version>` (~120 MB).

Other agent-runners are watched by `npm run competitors` (`npm run test:competitors`), which prints only what
moved.

## A turn the transport cut in half finishes itself

An agent whose stream dies mid-answer prints an error and returns to its composer. `shared/recover.ts` is
that decision. `npm run test:recover`.

- **It keys on the SECOND sentence.** Five different first sentences have shipped and every one ends
  `The response above may be incomplete.` — the CLI stating the precise thing that makes resuming safe.
- **A rate limit, usage limit, credit balance, auth failure or overload is never continued**, even carrying
  that sentence.
- **An error somebody QUOTED is not an error** — once submitted the CLI echoes it back with the full string
  intact; what separates them is the marker a CLI draws in front of a person's words, so a line starting
  `> ` is somebody talking. A copy still being typed is caught by `promptBox`.
- Three in a row and it stops; only output since the last look is read; the send goes through `queuePrompt`.

## A full machine gets its panes back

`capacity.ts` gives back scrollback (~5% of the bill); `shared/reclaim.ts` returns the agent by closing the
pane — the cost is the CLI inside it (~190 MB each, against 16-17 MB for Codex). `npm run test:reclaim`.

- **A trim is a DELETE.** Lowering xterm's `scrollback` discards lines and raising it back restores none, so
  the recovery is a re-render from main's raw log (`REDRAW_BYTES` 4 MB, 45-147 ms of parse on the UI thread).
  So `trimPlan` takes a clock: `TRIM_GRACE_MS` (5 min) keeps the lines of a pane the keyboard has only just
  left, `TRIM_SETTLE_MS` (60s, longer than the 15s poll) makes a trim wait for its verdict to HOLD. **Growth
  is never delayed.** Both optional — a caller with no clock gets the plan this always made, the control in
  `test:capacity`.
- **What makes closing defensible here**: `kill()` calls `recordEnd`, so a closed pane keeps its History row,
  its `resumeId` and its `scrollbackId`. A closed pane here is a minimised pane in any other app.
- **Pressure is the trigger, never a clock** — idle time only breaks ties once the kernel is already objecting.
- **Never closed**: a pane waiting for a person (`needsYou` is quiet BECAUSE it is owed an answer), the
  focused pane, one on screen, one working or starting or stalled, a mirror. **The window is never emptied.**
- **The reading of the machine is a card that ARRIVES and LEAVES, never a strip.** `.cap-pop` is armed by the
  verdict CHANGING into something worth saying and takes itself away after `CAPACITY_NOTE_MS` (12s). **Only
  `over` arms it**, never `tight`, and never more than one per `CAPACITY_QUIET_MS` (10 min). The desk total
  is drawn only while `capacity.level !== 'ok'`.
- **A press on a pane takes its countdown with it** — `touchPane` drops `closeSoon` when the countdown names
  that pane. Other panes in the same plan are re-decided by the next sweep.
- **A HOLD is not a countdown, and the chip must not wear the same word.** `Session.closeKept` says which of
  the two numbers it is; the card says `kept 10m` with no red last-minute alert. A countdown card naming the
  pane still wins.
- **A deadline in the past is a STATE, not a number.** `idleCloseAt` clamps an overdue pane to `now` and
  `sameDeadline` stops republishing it — without it three overdue panes cost **3138 `setClosing` writes and
  2061 whole-window renders in five seconds**, against **0 and 0**. `window.__pfClosePublish` counts them.
- **A pane can be taken off the clock for good** — `ReclaimPane.pinned` is refused by `onTheClock` AND by
  `reclaimPlan`'s filter. `keptUntil` (an hour) stays the answer for "not now".
- **Looking at a pane is USING it, at BOTH ends of the visit.** `quietSince` is the latest of a keystroke, a
  printed byte and the moment the KEYBOARD LEFT — stamped when focus leaves AND when it arrives, plus
  `touchPane` on the press. One reading, so the sweep and the card cannot disagree.
- **The clock counts time a person could have acted in, not wall time.** `shared/away.ts` freezes it while
  `powerMonitor.getSystemIdleTime()` says nobody is here (`AWAY_AFTER_MS` 60s); `main/away.ts` polls every 15s
  and pushes `system:away` on a CHANGE. A second desk is refused by `sawPerson`, not by a setting. **Only the
  clock pauses.**
- **A turn nobody has READ has no countdown in front of it** — `unread` refuses `onTheClock`, holds the CLOCK
  only, and is gated on `Away.sawPerson`.
- **The rung above closing is SLEEPING, and it is ON.** `idleSleepPlan` (`reclaim.idleSleepMinutes`, 30 min)
  stops the agent and keeps the card, its place, its screen and its conversation. It shares `onTheClock`
  verbatim and drops the two rules that are about closing: it keeps no pane back and is not capped by
  `maxPerSweep`. No countdown, and the card says `asleep 3m`.
- **There IS a close clock, and it is off.** `reclaim.idleCloseMinutes`, 0 by default; the switch sets 5 min.
  It exists for a desk driven over the link with no person to close its finished panes. Every refusal above is
  shared verbatim except **visible**. Its own minute timer in `App.tsx`.

**And a restore is the one moment N agents start in a single tick.** `restorePlan` (`shared/capacity.ts`):
everything at normal pressure, **two** at warn, **one** at critical, never zero while there is a pane to
offer. A **preselect, never a cap** — an unticked pane keeps its conversation and its screen. It reads
`readPressure()` when the offer is built, not `lastPressure`, which on a cold launch may not have sampled. The
silent paths (an update restart, `restoreAfterRestart: 'always'`) are deliberately untouched.
`npm run test:capacity`.

## ...and before it closes one, it tries to move it

Four rungs, each firing only where the one above did not solve it: trim scrollback (~5%) → start the NEXT pane
over there → **move a finished pane over there** → close it. `shared/autoHandoff.ts` is rung three;
`npm run test:autohandoff`.

**And none of that fires until something has already gone wrong.** `Machine.keepLocal`
(`autoHandoff.keepLocal`, **2**) is a budget, `Verdict.over` is how many panes are past it, and `budgetPlan`
moves exactly that many.

- **Past the budget the question is what a pane COSTS, never how many there are.** `expensive()`: a live
  shell/dev-server job (`AutoPane.job`, outranking both numbers), or `budgetMinMb` (500), or `budgetMinCpu`
  (50% of one core). Dearest first, then quiet-and-off-screen. **An unmeasured pane is not expensive** — the
  sampler does not read the table behind a hidden window. A desk far over budget with nothing expensive on it
  moves NOTHING and stays over, which is the honest answer.
- **The budget is a policy, so it holds at `ok`.**
- **It is the only rule allowed to move a pane that is ON SCREEN or MID-TURN.** Those two gates only ever
  meant "there is no emergency", and with the grid on `visible` is every pane. A busy pane is picked LAST
  (`rank`) and goes through the same queue; `queueable` is the wider set `movable` cannot be. Everything that
  could lose work is refused unchanged: the focused pane, a live question, a mirror, one already moving, one
  on a failure cooldown, the last pane on the desk.
- **The number moved is the overshoot, not `maxPerSweep`** — that cap exists so a machine under pressure
  re-reads its own recovery between moves.
- **Lag is read as well as memory, and the worse of the two decides** (`lagLevel`, `worstPressure`). One
  runnable thread per core is `warn`, 1.8 is `critical` — NOT a CPU percentage. `os.loadavg()` is 0 on
  Windows, so 0 means "nobody measured" and never "idle".
- **Nothing moves without a countdown anybody can see.** The 15s count used to be the mascot's, and the mascot
  ARRIVES OFF, so `MoveSoon.tsx` draws the same `CloseSoon` as a plain corner card whenever there is no sprite,
  calling the same two actions. z-index 45, no animation.
- **Two things are asked BEFORE a pane is picked, not discovered by moving it.** `AutoPane.machineBound`
  (`shared/paneBound.ts`) is work that would not exist over there — a browser being driven on THIS desk. It may
  never key on a browser NAME: every `claude` pane holds `safaridriver --mcp` and `chrome-devtools-mcp` from
  launch, so the reading is the automation FLAGS a driven browser carries (`--remote-debugging-port`/`-pipe`,
  `--headless`) plus a driver binary that is not an MCP server. Measured: 3 of 11 bound, 8 movable.
  `AutoPane.shareable` is the other leg — a git repo under the projects root with an origin remote
  (`shareable()` in `main/handoff.ts`, cached 5 min). Only an explicit `false` refuses; `undefined` is "nobody
  asked" and must not switch the ladder off on a slow first read. `npm run test:panebound`.
- **Nothing asks any more** — `offloadAsk` defaults off with a one-time `offloadDefaultsV2` migration (the
  `migrateAutoAnswer` shape, read off the SAVED config).
- **The pressure card OFFERS the move.** `suggestMove` names the dearest movable pane and its destination, and
  `.cap-pop` carries `Move it` / `Keep it here`. `Keep it here` adds the PROJECT to `autoHandoff.keepHere`,
  which every rung refuses (a pane's id dies with the pane; "this project is Mac-only" survives a restart).
- **A pane is never handed back where it came from** — two desks each keeping two agents are each correct and
  would pass one pane between them for ever. `senderDevice` in the payload, `arrivedFrom` stamped on arrival,
  `hostFor` skips that device. A second machine that did not send it may still take it.
- Both hardened like `offloadMinutes` (`keepLocalOf`) — these come off config.json and `config:set`, so `true`
  is not a budget of one.
- **A pane mid-turn is queued, never killed** — a pty killed mid-answer loses that answer for good, since the
  far end resumes from the transcript. `main/handoffQueue.ts` moves it the instant the turn ends; a pane that
  never goes quiet **expires** after `waitMinutes` and stays, said out loud. **And the chip that reports the
  wait is the control that ends it** (`remote:handoffCancel`); a move already IN FLIGHT has left the queue and
  says so.
- **`undefined` means keep the stamp; only `null` clears it** — `handoffQueuedAt` is what makes the chip say
  `waiting 12m` instead of `moving`. `run()` is the one caller that passes `null`.
- **The turn ending is an EVENT, not something to poll for** — `handoffQueue.poke()` on every `sessions`
  change; the `TICK_MS` (5s) tick stays as the backstop for expiry.
- The local half of a move is ~100ms; the push is SKIPPED when nothing is unpushed.
- **A pane holding a question is never moved, queued or otherwise** — `AutoPane.asking` is separate from
  `needsYou` for exactly this. Every other refusal is `reclaim.ts`'s verbatim; a failed move gets a
  `cooldownMinutes` hold.
- **...and those last two refusals are why it could never fire.** `idleOffloadPlan` is the opt-in clock beside
  it (`autoHandoff.offloadIdleMinutes`, 0 = off, the switch sets 30): it drops `visible` and the pressure gate
  and **nothing else**. Its own minute timer. The load-bearing test is a PAIR — the pressure sweep still
  refuses a visible pane, the clock takes it.
- **`handingOff` is on the Session, and `reclaim.ts` refuses it**, or the closing sweep and the moving sweep
  race over the same pane and closing wins by being faster. Every exit from a move clears it, refusals included.
- The sweep runs in the renderer beside `reclaim` (it needs `visibleIds`) **and on a 60s clock**: a desk that
  is full and quiet emits no session events.

**And the dev server travels with it.** `kill()` takes the pty's whole tree. `shared/devServers.ts`,
`npm run test:devservers`.

- **The server is routinely not a descendant of the pane** (a `next dev` on ppid 1 with its npm parent exited),
  so a process is attributed by the tree OR by its command line naming a path inside the pane's repo.
- **What is running is not what would be typed** — re-issuing the observed argv hard-codes a port and runs a
  binary out of a `node_modules` the receiver may not have. An observed process is turned back into a
  package.json **script name** and the receiver rebuilds the command from its own package.json and lockfile.
- **The payload cannot name a command, only a script**, re-validated against `SCRIPT_NAME` on arrival. The
  worst a malicious payload reaches is a script that repo's own author wrote, in an ordinary `shell` pane
  already swept by `strays.ts`.
- **An ambiguous match is dropped and named.** `npm run build` and `npm test` never travel; only `DEV_SCRIPT`
  (`dev|start|serve|watch|preview`, with or without a `:suffix`) does.

## What Windows loses between restarts

- **The Desktop shortcut.** `build/installer.nsh` deleted `$DESKTOP\PaneForge.lnk` on every run:
  `IfFileExists ... 0 +2` skips exactly ONE instruction, and the macro runs from `customInit` AND
  `customUnInstall`. The guard is fixed, but a guard in the installer only covers the installer, so **the app
  puts a missing shortcut back on launch** (`main/winShortcut.ts`, decision in `shared/winShortcut.ts`). It
  never rewrites one that is there, and never claims the Desktop from a `npm run try` copy.
- **The login entry.** `setLoginItemSettings` was only called when the SETTING changed, so the HKCU Run value
  was written once and never checked. Re-applied from config on every launch, and only when it disagrees.

Both logged to `updater.log` (`windows ...`). `npm run test:winshortcut`.

## The Windows dev channel picks its own release

`GET /repos/robertiuoras/PaneForge/releases` answers **200 with an empty array** (anonymously AND with the gh
CLI token) while `gh release list` lists everything, so electron-updater's dev channel gets `undefined` and
throws. And when the list does answer, the newest release is often one this platform cannot install, and
nothing in its loop looks at the release BELOW the newest. `pickRelease` cannot be reused — it reads the same
broken list.

So the dev channel stops asking GitHub's API to choose: tags come from `gh release list`, each is asked
directly whether it carries a `latest.yml` (one public download request, no token, no API), and the feed is
pinned to the first that does with the **generic** provider. There is then no list to be empty and no
prerelease flag to interpret, so `allowPrerelease` is stood down under a live pin. Every failure leaves the
feed exactly as it was. `PF_NO_WIN_PIN` exists only so `test:blindlist` stays about the blind list.
`npm run test:winfeed`.

## Why the app quit

Electron never says what triggered a quit. Every path that quits on purpose names itself — `quitting(...)` in
`main/index.ts`, from the single-instance loser, the unopened test copy, the handoff receiver, the idle clock,
an update install and the admin relaunch — and `before-quit` writes that name to `updater.log` with the pane
count. A quit that leaves it empty logs `nothing in the app asked`.

A signal cannot be caught (Chromium takes SIGTERM below the JS layer), but the unnamed cases are told apart by
**where the screen was**: a Cmd-Q or app-menu Quit can only be typed at a frontmost window, while `pkill`,
`osascript ... quit`, a launchd job and a logout all arrive while somebody is looking elsewhere.
`shared/quitWords.ts` turns the last focus into that sentence. It is evidence and never a verdict — the useful
half is the negative, "this did NOT come from this keyboard". `FROM_KEYBOARD_MS` is a generous 4s because
Cmd-Q blurs the window a beat before `before-quit` runs. `npm run test:quitwords`.

## Gotchas that look like mistakes

- `package.json` `description` is the bare word "PaneForge" — electron-builder writes it into the exe's
  FileDescription, which is the name Windows Task Manager shows.
- `package.json` `name` stays `claude-orchestrator` — Electron builds `%APPDATA%\<name>` from it.
- The icon is **generated**: `node scripts/make-icon.mjs` writes `icon.png` / `icon.svg` and `build/icon.png`,
  so the `.ico` and `.icns` need no configuration. Do not check in a blob — there is no ImageMagick and no
  sharp on this machine. `--size N --out path` renders any single size.
- `git status` for the pane badges must stay async (`execFile`, never `spawnSync`) — a blocked main process is
  the Windows busy cursor.
- `.github/workflows/` edits need `workflow` scope on the gh token
  (`gh auth refresh -h github.com -s workflow`); without it the push is rejected after `lane.mjs` has already
  tagged the release.

## Checking a layout change without screenshots

```
npm run build                    # --keep SKIPS the build; without this you measure the last one
npm run try -- --keep --remote-debugging-port=9333
npm run probe -- --height 560 "(() => { const r=document.querySelector('.dialog').getBoundingClientRect(); return { fits: r.bottom <= innerHeight } })()"
npm run try -- --close
```

A probe answering exactly what it answered before your edit is the tell that nothing was rebuilt. The port is
per checkout — a second lane probes with `PF_PORT=9334` and launches with the matching flag.
`--height`/`--width` drive Chromium's device metrics override and put the size back afterwards. The expression
is evaluated in the renderer with `awaitPromise`, so an async arrow that clicks through a dialog and then
measures works as one argument. `window.__pf[sessionId]` gives a pane's live `term` and `fit`.

## An iPhone is not a Mac, and a phone control is 44px

`npm run test:phonetouch`.

- **`navigator.userAgent.includes('Mac')` is TRUE on an iPhone** — iOS says `(iPhone; CPU iPhone OS 18_5 like
  Mac OS X)` and an iPad says `(Macintosh; ...)` outright, so every shortcut this app prints went out as `⌘ T`
  to a device with no ⌘ key. `isMac` refuses an iOS agent AND a touch device with no fine pointer; the hints
  are hidden on a handheld outright.
- **The coarse block had only ever been written for a PANE**, and on a handset the sessions list is the home
  screen: 31 controls under 44px there, plus all three of the pane screen's own. Now 1 and 0 — the survivor is
  a row's close at 40x40, chosen deliberately. Nothing a pointer sees changed.
- **Two specificity ties decided it, which is why the test reads the BUILT stylesheet.** `html.handheld
  .pt-more` (0,2,0) loses to the header's own later `.pane-title .icon` (0,2,0). And `.icon.help` carries its
  own `min-width` at equal specificity and later ON PURPOSE, to keep the two brand buttons the same size, so
  it has to be named separately.
