# PaneForge

Electron app that hosts coding agents in panes. It hosts the chat you are reading this in,
which shapes every rule below.

**Every rule here is the short form.** Why each one exists — the measurements, the traps,
the hours they cost — is in `docs/design-notes.md`, one section per heading below, same
titles. Read that section before CHANGING the thing; the rule alone is enough to work
beside it. Do not re-derive a decision it already records. **Keep this file short: a rule,
never its history.** Anything that reads as a story belongs in `docs/design-notes.md`.

## Never close the app you are running inside

`PaneForge.exe` under `AppData\Local\Programs\claude-orchestrator` is the live app and
killing it ends this session mid-turn. To see a change, open a **second** copy:

```
npm run try                     # builds, opens as its own profile, minimized, no focus
npm run try -- --show           # same, but on screen (still no focus)
npm run try -- --close          # shut that copy down
```

Profiles (`src/main/profile.ts`) give the copy its own userData, single-instance lock,
config and taskbar button. Never `npm run setup`, never `Stop-Process PaneForge`, never
run the NSIS installer — each kills every PaneForge.exe including this session.

## Lanes: more than one chat works on this repo

A hook assigns each session a lane — `main` (this folder, master) or a worktree
`PaneForge-a` / `-b` / `-c` on `lane-a` / `-b` / `-c`. **Work only in the lane you were
given**; writing into another chat's checkout is refused by a PreToolUse hook.

```
node scripts/lane.mjs status --repo <dir>      # who holds what
```

- A chat visiting from another project gets a letter lane, never `main`, unless `main`
  holds uncommitted work to protect.
- A `Stop` hook runs `lane.mjs park` when a turn ends: clean holds are marked, a parked
  `main` is handed on after 10 minutes (instantly when the holder was a visitor), and a
  claim by the parked chat clears the mark.
- One engine drives every repo on the machine: `lane.mjs --repo <dir>`. Per-repo config is
  `.lanes.json`, every field optional:
  `{ "lanes": false, "branch": "main", "release": "merge", "pool": ["main", "a"] }`.
  `release` defaults to `"merge"` everywhere.
- A repo with no remote, and `claude-memory`, never get lanes. Never leave a lane sitting
  in a conflicted merge — the one state no other chat may touch.
- **The lane chip opens "what is all this", not just "merge?".** `LaneDialog` leads with a
  plain sentence about folders (the git line `lane-a → main` sits below it) and lists every
  copy of that project on this machine — trunk and each lane — with who has it (a pane
  number, which is also its Ctrl key; the row switches on a press) and what it is doing
  (uncommitted files, newest commit subject). It is built from BOTH `lane.mjs`'s ledger and
  this window's panes, because a lane the app made itself (`main/lanes.ts`) has no ledger
  row. `laneDoing` in `renderer/src/laneWords.ts` is the words; a lane with neither commits
  nor edits says nothing rather than inventing a sentence about somebody else's work.
- `npm run test:lanes` (which includes `visitor-park-test.mjs`) covers the engine, the
  worktree sweep, ownership, and the any-repo contract (a repo that never asked for releases must never cut a version).

## Two desks, one repository

The ledger is one machine's (`<repo>/.git/paneforge-lanes.json`, never pushed). A letter
lane is local scratch on a local branch, so two desks' `lane-a` cannot collide. Exactly two
things do collide, and both are the trunk: `main` IS the shared branch, and a release cut
twice is two tags and a one-legged feed.

- **A claim is carried by the ref NAME**, under
  `refs/paneforge/claims/<device>/<slot>/<session>/<millis>`, pointing at a commit origin
  already has. Reading every device is one `ls-remote`, no fetch, no objects: 0.09-0.11s,
  and a chat that already holds its lane returns before any of it.
- **Only the trunk asks, and only a chat that does not already have it.** A letter lane
  never publishes and never reads. `PEER_STALE_MS` is 45 minutes.
- **The heartbeat is a turn ending**, not a timer, and only once the last publish is older
  than `REFRESH_MS` (10 min): an ordinary turn end pushes nothing (0.11s), a publishing one
  costs 2.17s. It sends the new name up and the old one down in ONE push.
- **A chat ending gives the trunk back at once.**
- **The release lock is decided by the SERVER.** `refs/paneforge/lock/release` is created by
  a plain, non-forced push of an orphan commit carrying this device's name, so the other
  desk's push is a non-fast-forward git refuses on its own. Read-then-decide has a window
  both desks fit inside; pushing the branch tip is a no-op that SUCCEEDS; and
  `--force-with-lease=<ref>:` checks the lease against the pusher's own remote-tracking ref,
  so a desk that never heard of the ref takes the lock too. Both are kept as test cases. A
  lock with no timestamped claim beside it was left by a killed machine and is cleared.
- **Nothing here may ever block a chat.** No origin, unreachable origin, a laptop on a
  train: each falls through to the behaviour this repo had before any of it. If the check
  cannot run, `doctor` says so — which is why `peerRefs()` returns `null`, not `[]`.
- `PF_DEVICE` overrides the hostname. `npm run test:lanepeers` is the arithmetic;
  `npm run test:lanedevice` the plumbing, against a real bare repo and two clones.

## Releasing happens when Robert asks, and not before

**`.lanes.json` says `"release": "merge"`, deliberately.** Finishing work merges into master
and pushes; it does NOT cut a version, publish a build, or move anybody's installed copy.
The end of a piece of work is: build it, prove it in a second copy he can open
(`npm run try -- --keep --remote-debugging-port=9333`, then `npm run probe`), report the
numbers, and stop. `npm run typecheck` and `npm test` still gate a commit.

```
node scripts/lane.mjs ready --repo <dir> --session <id>   # this lane is done and verified
npm run ship                                              # ONLY when Robert asks for a build
```

`ready` merges master into your lane first, refuses to mark anything while that merge is
dirty, then merges once no chat is mid-work. Edit or commit after marking and the mark is
dropped, by name.

Everything below describes what a release does WHEN ONE IS ASKED FOR; flipping
`.lanes.json` to `"release": "version"` restores the automatic path.

- **Below 1.0 an automatic release only ever moves the patch.** `bumpFor` reads commit
  subjects and `nextVersion` demotes: `feat:` is a patch, `feat!:` the one bump a commit may
  ask for (a minor), anything larger is typed (`lane.mjs ship minor|major`).
- **Releases batch: one per 2 hours** (`COOLDOWN_MS`). Each dev release is a build to
  install and a restart to take it.
- `npm version`, `git tag vX` and pushing a version tag by hand are **blocked**.
  `npm run ship` is the one path that skips the two checks below, deliberately.
- **Three things stop an automatic release, all reported by name**: master not typechecking,
  master failing its own `npm test` (`suiteFailure` — a typecheck proves the types agree,
  never that the app works), and a lane conflicting with master. The conflicting lane is
  left out; the rest still goes. `rerere` is on and the retry timer runs every minute, so
  the suite answer is cached on the COMMIT in the shared ledger, invalidated only by a new
  commit — and **a red answer is asked TWICE before it is written down**, or one flaky run
  produces a commit releasable only by hand-editing `.git/paneforge-lanes.json`. A suite
  that could not START is named as this checkout's tooling and is not cached.
  `npm run test:gate`.
- Release notes come from Conventional Commit subjects between tags
  (`scripts/release-notes.mjs`, `.github/release-notes.md`, `npm run test:notes`). **Only
  `feat:`, `fix:` and `perf:` reach the page**; a release carrying only other prefixes falls
  back to the commit-history link, and there is no catch-all heading. The drop is reported:
  `unpublished` names a commit that touched `src/` with no conventional prefix and `doctor`
  prints it. It never rewrites, and never names a deliberate `docs:`/`test:` drop.
- **Actions and this machine can both publish.** Duplicate installers are harmless;
  `latest.yml` is not. `reconcileFeed` on the retry timer compares the feed to the asset it
  names and puts ours back. Never hand-fix a feed without checking the asset's real size.
  `runSafe` quotes its arguments (`cmdQuote`, `npm run test:laneargs`).
- **Every automatic release is a DEV release**, cut as a GitHub prerelease. Stable installs
  resolve `/releases/latest`; the newest dev build that has been on the channel
  `PF_PROMOTE_SOAK_MS` (3 days) auto-promotes from the minute timer. **The soak is that
  build's own age, not a quiet period across the channel.** Both paths refuse a one-legged
  release and a feed whose declared size disagrees with the asset, then verify
  `/releases/latest` really moved. Tags stay plain; the prerelease FLAG is the channel.
  `lane.mjs promote [version]` is for "stable needs this now". `lane.mjs doctor` lists what
  waits. `npm run test:promote`.

**A release claims the thing is finished.** Never cut one while any next step for that issue
is still open — and **promotion claims it is proved**.

## An update may never need a person

Install once, update from the app, for ever. **A user reinstalling PaneForge by hand is a
defect**, and one shape has ever caused it: a promise that never settles behind a flag
saying "already working on it".

- **A release this platform cannot install is skipped, not retried.**
  `shared/pickRelease.ts` walks the list for the newest release whose assets include the one
  `assetFor` asks for; a list where nothing is installable reports "no update" rather than an
  error. `npm run test:pickrelease`.
- **The recovery may not live inside the thing that can hang.** A transient phase carries
  `phaseAt`, and `busy()` — asked before every restart — drops one past its budget, whatever
  wedged it. `CHECK_BUDGET_MS` 2min, `DOWNLOAD_BUDGET_MS` 45min, `PROBE_BUDGET_MS` 5min, all
  env-overridable.
- **The poll is armed BEFORE the await as well as after it** (`POLL_WATCHDOG_MS` 6min); a
  healthy turn's `finally` replaces it, so nothing polls faster than before.
- **On the way out, the disk beats the badge.** The quit swap is gated on
  `stagedInstallable()`, never on `phase === 'ready'`.
- `update-health.json` holds the last good feed answer and every recovered wedge. An empty
  `updater.log` is evidence: three days without a good check logs `health STALE`.
- `npm run test:updater` (second half `npm run test:wedge`) hangs the stub on purpose.

## Never take the screen

The app runs all day beside real work. Nothing it does on its own may take focus, raise a
window, or pop a dialog. Only a click or a hotkey earns the foreground.

- `showInactive()` for a window nobody asked for. `focusWindow()` is user-initiated only.
- `revealPlan()` in `src/main/profile.ts` decides the launch reveal per platform. A
  self-decided restart calls `markQuietRelaunch()` first; the new process consumes that
  marker, starts inactive and flashes the taskbar button.
- No `dialog.showMessageBox` for anything the app decided itself — in-renderer cards
  (`UpdateToast.tsx`). No `setAlwaysOnTop`, no `moveTop`, no `app.focus`.
- Every `spawn`/`Start-Process` keeps `windowsHide: true`. (On this PC that flag is ignored
  for detached console spawns — wrap in `run-hidden.vbs`.)
- `second-instance` must not raise the window while `installStarted` is set.
- Game mode may DELAY the window, never lose it. `gameMode.ts` asks the foreground window's
  process directly at the launch reveal and for deferred work (~600ms), which is why the 15s
  poller still uses `tasklist`.
- `npm run test:quiet` pins both halves, and SKIPS out loud when a real game is on screen.

## Two machines, one desk

`src/main/remote/` lets a second device drive this one's panes. Both ends are peers. Five
decisions not to re-litigate:

- **Nothing is mirrored until it is picked, and a device may not pair with itself.**
  `Remote.probe` refuses an id equal to ours at the handshake — the first moment the far
  end's identity is known — and `start()` drops one already saved, because a config outlives
  the bug. Mirroring is `peer.watch`, a tick per pane in Devices; a pane opened from here and
  a pane handed off are picked for you, nothing else is. `test:remote`.
- **The pty never moves.** A mirrored pane's agent, checkout, transcript and worktree stay on
  the device it was opened on. Session ids are the seam: a mirrored pane is `@<device>/<id>`,
  and `remote.owns(id)` in `main/index.ts` routes every pane message to the link.
- **A mirror BORROWS the terminal's size; it never owns it.** `pty:resize` on a mirrored id
  is sent over the link with `borrowed` — the same contract a phone has (`resize(borrowed)`
  in `main/sessions.ts`): the host bends the pty to the viewer, keeps `deskCols/deskRows`,
  and `returnSize(id)` gives them back on detach, on the guest vanishing, or when this desk
  resizes the pane. Per-pane, never `returnSizes()`. `shared/mirrorFit.ts` is the FALLBACK
  for a host that has not applied the borrow yet; leftover slack is only split when it is
  bigger than two cells.
- **Several screens may borrow ONE pty, and the smallest grid wins.** `shared/paneSize.ts`
  holds a borrow PER VIEWER and lends them all the smallest grid asked for, each axis
  separately. A viewer looking away drops only its own borrow (`returnSize(id, viewer)`).
  **The viewer name must be forwarded, never invented at the boundary**: the api object in
  `main/index.ts` is both the phone's surface and the remote host's backend, so hardcoding
  `'phone'` files every paired device under the phone's slot. A guest is keyed per
  CONNECTION (`GuestConn.key`). **A borrow is a LEASE, not a flag**: it carries `at`,
  renewed by the `pty:visible` tick every screen already sends every 30s, and expires after
  `BORROW_TTL_MS` (90s) - a phone that locks, backgrounds or walks out of range never sends
  `pty:return`, and behind a tunnel its stream stays nominally open, so announcement is not
  a signal that exists. A viewer over the device LINK is filed `at: 0` and never expires on
  a clock; its borrow ends with the connection. And a desk resize under a borrow sweeps
  first: "remembered, not obeyed" made a stuck borrow unrecoverable by construction, so
  dragging the window could not repair it either. `npm run test:panesize`.
- **A mirror never reports the busy footer**, and **frames are decoded where they are
  consumed**, never where they arrive (the last handshake frame and the first encrypted one
  routinely land in one TCP segment).

The pairing code is never sent, only proved; traffic keys derive from it (scrypt, then
AES-256-GCM per direction), so rotating it cuts every paired device off. Hosting is off
until switched on; discovery is a UDP broadcast carrying no secret. `npm run test:remote`.

**Pairing can also be a button, and then the six digits are the authentication.** Tap a
discovered device and it asks; the other machine raises a card and both screens show six
digits derived from an X25519 exchange that binds BOTH public keys, so a relaying machine
cannot make the numbers agree. The card leads with the number, not the device name. On
Approve the host seals the ordinary pairing code to that secret and the joiner reconnects
through the normal path. `PROTOCOL` stays 1: an older build does not recognise `askpair` and
refuses, which is correct. `npm run test:pairask`.

**A paired machine also says what it is running OUTSIDE its panes** — the `claude -p` a
scheduled task fires, the wedged loop, the dev server on an unreachable port.
`shared/backJobs.ts` is the reading, `main/backJobs.ts` the process table, `jobs`/`jobslist`
the frame, `PeerJobs` in `RemoteDialog.tsx` the rows.

- **Three narrow classes, and the narrowness is the feature**: an agent CLI outside a pane
  (`agent`, marked a *run* when it carries a print/exec flag), a dev server (`dev`, from
  `devList.ts`), and a script under the projects root alive longer than `LOOP_MIN_SECONDS`
  (`loop`). A process table is ~700 rows here.
- **Anything under a pane's own tree is left out** — that work already has a card.
- **The age floor belongs to the loop class alone**, or the list is mostly Claude Code's own
  sub-second hooks. An agent or dev server two seconds old is exactly what somebody opened
  this to see.
- **The fold is kind-aware**, unlike `devList.ts`'s: `npm run dev` and its `next dev` child
  are one server, but a dev server an AGENT started is two different facts.
- **A refusal may never share a shape with an empty answer.** `Remote.jobsOn` rejects when
  the device is not connected, because `[]` means "that machine is running nothing".
- **On demand, never on a tick.** `npm run test:backjobs`; the frame crosses a real socket in
  `npm run test:remote`.

**A handoff moves the WORK, still never the pty.** `Hand off` on a pane's own card asks one
question — which machine — in a box of its own (`HandoffDialog.tsx`): the paired machines,
what travels (the repo as an `auto-sync:` commit, the conversation, the screen, the dev
servers) and what a mid-turn pane does — **queued, never killed**. The bulk path is
`Hand off all` in Devices (two presses; the first arms it): each pane's repo is pushed as an
`auto-sync:` commit, its transcript and screen tail stream over the link, and the far end
pulls the branch, writes the transcript where its own CLI looks, and starts a fresh pane with
`--resume` through the same lane split a local launch gets. The sender's pane closes only on
the far end's ack and immediately reappears as a mirror. The receiver never destroys local
state: a dirty or unpushed checkout refuses THAT pane by name. Paths map by grafting the
pane's root-relative path onto the receiver's projects root (`shared/handoff.ts`).
`npm run test:handoff`; `npm run test:handofffit` measures the box in a real Chrome so a
machine's NAME is never the string that gets cut.

## The phone is this window, served

There is no second app. The renderer imports nothing from Electron or Node — it is pure UI
over `window.api` — so a phone client is that object over HTTP: `src/main/phone.ts` serves
the built renderer, `renderer/src/browserApi.ts` supplies the object, and
**`src/shared/surface.ts` is the ONE list** (`SURFACE`) both transports are built from, typed
`{ [K in keyof Api]: SurfaceEntry }` so a method with no channel does not compile. Never add
a channel to a transport; add it there.

- `tapIpc()` MUST stay at the top of `index.ts`, above every registration - calls land in
  the app's own `ipcMain` body via `src/main/ipcTap.ts`. Events go down one
  SSE stream, and `phone.broadcast` sits **ahead** of the window check in `send()` so a
  minimized window cannot starve a phone. Sends are queued client-side because they are
  ordered.
- **Off until Devices is opened, and opening it IS the switch.** Unpaired gets the pairing
  page and not one asset; five wrong codes locks that address for a minute. The cookie is
  `hmac(deviceId, code)` — derived, never stored — so rotating the code signs every phone out.
- **Watching and typing are different permissions** (`src/main/passkey.ts`). With
  `phone.typeGate` on, the first keystroke of each 15-minute window costs a passkey touch.
  The gate is on `/pf/send` and `/pf/call` and **never on `pty:write`**; it arms only over
  TLS (WebAuthn needs a secure context); and a 423 refuses the WHOLE batch before anything
  runs, re-queued at the front. `DESK_ONLY` refuses `phone:typeGate` and `phone:forgetKey`
  over HTTP. Every other invoke channel in `surface.ts` is phone-reachable.
- **Scanning asks; a press on the desk answers.** The QR carries the bare address,
  `POST /pf/ask` raises a card here with four digits on both screens, and Approve mints THAT
  browser a 32-byte token, so nothing on screen can be photographed and a device can be signed
  out by name. One request at a time, five per address per ten minutes, two minutes to answer,
  falling back to the fragment-code QR (`phone.ask`). With asking off the code rides in the
  URL **fragment**, which a browser never sends to a server.
- **Behind a tunnel every client is 127.0.0.1**, so `addressOf` believes `cf-connecting-ip`
  (then `x-forwarded-for`) and does so ONLY from loopback.
- **One row per device, not one per approval** — approval replaces the row with the same
  user-agent and keeps its "signed in since". The panel says who is WATCHING, never who is
  paired; `New code` is the only revoke. Each row leads with `originOf`.
- **The ten-year cookie is watched, never revoked on suspicion** (`shared/deviceWatch.ts`): a
  changed place is recorded and never alarmed on; a changed browser shape and one live stream
  from two origins at once are the marks. A mark is never cleared by an ordinary arrival, and
  `phone:clearMark` is `DESK_ONLY`.
- **`SameSite=Lax`, never `Strict`.** `Secure` only when the request really arrived over TLS.
- **A way in from anywhere**: `main/funnel.ts` (Tailscale Funnel — stable hostname, so a phone
  signs in ONCE) is tried first, falling silently through to `main/tunnel.ts` (a cloudflared
  quick tunnel). Never look the hostname up before `Registered tunnel connection` — an early
  query caches NXDOMAIN for 40s. `up` is set by a real HTTPS request returning our own bytes.
  Everything cloudflared says is on **stderr**. Turning it on lengthens the code to 14 and
  signs every phone out. The binary is downloaded once through a `.part` name and a rename.
- **The QR leads with the LAN address**, tailnet after it, and `reachWords` never promises
  "works anywhere" for an address marked "this network". Codes, addresses, port and
  `New code` fold away under `Other ways in` / `Pair by hand`.
- **A copy made on the phone is the PHONE's clipboard** — `buildApi` lets a transport answer
  a method itself, and `browserApi.ts` answers `copyText`/`readClipboard` locally.
- **The output is also served as TEXT** (`TextSheet.tsx`): a finger cannot select a canvas. It
  reads the transcript off disk (`sessions:log`, up to 8 MB) and is RENDERED through an
  off-screen xterm, never stripped.
- **A text field must opt back IN to selection**: `body { user-select: none }` inherits, and
  iOS then refuses the caret loupe. Both spellings, on every input and textarea. Keys a phone
  keyboard lacks are drawn (`HandheldType`: ⌫ ← → ↑ ↓ esc at 44px, as bytes).
- **The desk OWNS a pane's shape; a phone BORROWS it** (`resize(borrowed)`, `returnSizes`). A
  desk resize during a borrow is REMEMBERED and applied when the phone lets go. A phone
  re-wrapping a pane scrolls the old frame away and may never `clear()` it; a COLUMN change
  clears the buffer and asks for a repaint — `clear`, never `reset`.
- **A phone cannot read "the desk is asleep" off its own screen.** Its panes come from the
  last session list it was sent and that list carries no clock, so a sleeping Mac leaves
  every row frozen at whatever it was doing - a desk of finished turns reads as a desk of
  dead sessions. `shared/linkState.ts` is the reading and `LinkBanner` in `App.tsx` draws
  it: how long since the desk said ANYTHING, plus the note that the rows below are a
  photograph. It never claims the machine is asleep - this screen cannot tell that from a
  dropped tunnel or a handset with no signal, so "asleep?" carries its question mark.
  `LINK_QUIET_MS` (20s) is the floor, because an ordinary handset reconnect is not an
  outage. The transport says so from three places: the stream erroring, the stale timer,
  and a failed `/pf/call` - which on a phone is regularly the FIRST proof, since a
  suspended EventSource never fires an error at all. Coming back to the tab (`visibility
  change`/`pageshow`/`online`) re-reads the desk on the spot rather than waiting for a
  throttled timer. `npm run test:linkstate`.
- **A phone is not a small desktop.** `handheld.ts` + one `@media` block: under 720px, or a
  coarse pointer under 520px tall, the list and the panes take turns with `display: none`.
  `100dvh`, never `100vh`. The pane header keeps only what says WHICH pane this is; every
  action moves behind one ⋯ into `PaneMenu.tsx` (52px rows, words, destructive last). Back
  goes to the list via one history entry; the swipe arms anywhere in the pane, never at the
  left edge. A tap opens from `pointerup`. One composer: xterm's helper textarea gives up
  being a field on a coarse pointer, and the typing bar autocorrects. `isPhoneClient()` gates
  AUTHORITY only, never layout.
- **Automation opens a pane through `scripts/pf-ctl.mjs`**, never `open --args`: one em dash
  makes macOS drop the whole argument list and exit 0.
- `npm run test:phone` (server + surface parity). `npm run test:phoneview` needs a running
  copy. A pane's text is in `window.__pf[id].term.buffer`, never in the DOM.
- Not built: headless host (B1), phone-first diff (H2).

## A pane can run on somebody else's model

Most of `shared/agents.ts` is one binary pointed somewhere else: Claude Code reads
`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` and nothing else. Separate ids rather than a
switch on `claude`, because the two have different histories, costs and failure modes and a
pane must say which it is on its card.

- **A base URL carries NO `/v1`; the CLI appends `/v1/messages` itself.** OpenRouter is
  `https://openrouter.ai/api`. With `/api/v1` the CLI prints `There's an issue with the
  selected model (<id>)...` — a sentence about the MODEL in a pane whose model is fine.
- **A provider is an entry in `KEY_PROVIDERS` plus an agent whose `env` names `keyVar(id)`.**
  Settings draws its key field off that list, so a provider added to the catalogue reaches
  the screen by itself.
- **"Anthropic-compatible" is probed, never read.** DeepSeek (`https://api.deepseek.com/
  anthropic`) and Z.ai (`https://api.z.ai/api/anthropic`) answer a junk-key POST with a 401 in
  Anthropic's own error shape. **xAI does not have one**, so Grok is its own CLI entry
  (`grok`, installed by x.ai's script into `~/.grok/bin`, which `which.ts` hydrates).
- **A key pasted in Settings reaches the menu somebody is looking at.** `siblingModels`
  borrows another runner's models into this one's dropdown under the PROVIDER's heading
  (`OpenRouter · Free`, never `Claude Code on OpenRouter`), each row carrying `agent`, so the
  press switches runner and model together. Two refusals: only a provider whose key is
  actually SAVED, and only a sibling on the same `bin`. `config:set` invalidates the 20s agent
  cache.
- **A blank key drops the token and KEEPS the base URL** — dropping both would run plain
  Claude Code in a pane whose card says GLM. The Settings card names the missing key
  (`missingKeyFor`).
- **`HEADLESS` is keyed by agent id**; these share `claude`'s entry. Grok is deliberately
  absent — its headless flags are unverified, and `drivable()` refusing beats a guess.
- `npm run test:agentenv`.

**Gemini CLI no longer has a login of its own.** Google cut consumer accounts off on
**2026-06-18** (announced 2026-05-19; Gemini CLI is being folded into Antigravity CLI), and
this machine hit it on 2026-08-23 - the date below is when it was NOTICED, not when it broke,
and rollout was uneven enough that people were still filing fresh bugs in July. **Google AI
Pro/Ultra does not entitle Gemini CLI at all any more**; only a Code Assist Standard/Enterprise
licence keeps an OAuth login, and everyone else pays per token on an API key. So: every launch dies `IneligibleTierError ... UNSUPPORTED_CLIENT`, inside a
pane that otherwise looks healthy. So `google` (AI Studio) is a `KEY_PROVIDERS` entry, the
agent's `env` names `keyVar('google')`, and `keyProviderFor` reads `GEMINI_API_KEY`.
`GEMINI_DEFAULT_AUTH_TYPE` is set beside it and is NOT enough on its own: a machine whose
`~/.gemini/settings.json` says `oauth-personal` keeps going to the dead endpoint, and nothing
in the environment can overrule it.

## ...and the model list is not this build's opinion of what exists

`main/orModels.ts` keeps a copy of OpenRouter's own public list on disk, beside the
hand-written `OPENROUTER_MODELS` shortcuts in `agents.ts`, and
`shared/orCatalogue.ts` turns it into the menu. `npm run test:orcatalogue`.

- **It may never be in anybody's way.** `listAgents` is synchronous, so it reads the
  catalogue from MEMORY and kicks the fetch with `void`. Missing, stale, empty, offline, a
  502, an error page: every one leaves the app as it was. An empty answer is a FAILED answer
  and is never written over a good one.
- **Only models that can call tools.** A model without them answers the first turn and then
  cannot read a file. A row that does not declare its parameters is dropped rather than
  guessed at; everything left out is one "Other..." away.
- **Nothing is capped, and every row carries BOTH prices.** Free models lead under their own
  heading; every paid tool-capable model follows under one heading. A cap inside a filter box
  is invisible. `Select` searches the VALUE as well as the label, because `labelFor` strips
  the vendor and the vendor is what people type. The hint is `$in in · $out out /M`. Newest
  first, in both groups.
- **A stealth model says so in the hint**: an anonymous provider retains prompts and
  completions — a fact needed at the moment of choosing.
- **How a CLI addresses the model is read off its own `env`**, never off a list of ids: an
  agent authenticating with the OpenRouter key names it bare (`z-ai/glm-5.2`), one passing the
  key to a provider of its own reaches it through `openrouter/`.

## Every colour is derived, and every pane says which project it is in

**There is no palette.** `src/shared/theme.ts` computes one from a single accent;
`applyTheme` writes it as CSS variables onto `:root`. The literals in `styles.css` are the
~40ms fallback before a config loads. Adding a colour means adding it to `paletteFor`, never
to a component. The maths is Oklab — hue and chroma held while lightness sweeps, `inGamut`
binary-searching the chroma that fits — because per-channel RGB clamping hue-shifts rather
than desaturates. **Light themes live above ~0.9 on the depth slider**; Paper is 0.98.
Default accent `#f0a868`; the sidebar mark is the icon's own geometry in `currentColor`.
`npm run test:theme` is 358 assertions whose load-bearing half is contrast: 4.5:1 body and
3:1 secondary, for every preset and hue at full tint.

**A `var()` naming a token that does not exist never errors** — in a `color` it inherits
something plausible. Before trusting any colour, resolve it in a real window, and check every
`var(--x)` in the stylesheets against the keys `paletteFor` returns. Only `--agent`,
`--level` and `--mono` are legitimately absent (the first two are set inline; every `--mono`
use carries a font-family fallback).

**The floating Stash is a second window and obeys the same law.** It keeps its own rules
(`shelf.css`) and takes its colours from `applyTheme`. Two shapes the palette does not
supply: `--acc-rgb`, the derived accent as a triplet (`rgba()` of a hex is dropped in
silence), and the `light` class on `:root`, off the luminance of the derived `--bg`, because
*light or dark is the depth slider's answer and never the operating system's*.
`npm run test:stashtheme` refuses a colour literal in that file outside a `var()` fallback.

**Every pane says which project it is in.** `src/shared/place.ts` is the only thing allowed
to turn a folder, branch, worktree suffix and lane id into words.

- The project name is never omitted and never abbreviated; everything else is added only when
  not implied. One pane, one repo, trunk → `PaneForge`.
- A trunk branch is answered ("main checkout"), not hidden. A branch a tool generated to hold
  a copy (`pf/w2`, `lane-a`, `worktree-<slug>`) is dropped — it repeats the copy's own number.
- Two numbers, worded apart: `copy 2` is the second checkout, `pane 3` is the third card and
  Ctrl+3 reaches it. Only the pane number is a keystroke, and only chats are named by it.
- `-a` is stripped only when the caller already knows the folder is that lane — `service-a` is
  a real project name. Only `-w<digits>` comes off unasked.
- The sidebar has no `git status` of its own, so it may not assert "not a git checkout".
- `npm run test:place` is 56 assertions on the strings.

## A pane says how long it has been open

The header's clock is the TURN and resets whenever the agent finishes; `/clear` throws the
conversation away without touching the pty. So nothing on screen answered "how long has
this window been open" but the info sheet. `.pt-open` is that reading, from
`openedAt ?? createdAt`, beside the turn clock and off the header on a phone. History
carries the same number as an `open 12h 03m` chip, frozen at `endedAt`.

- **A clock is woken no faster than it is READ.** `stepFor` (`shared/elapsed.ts`) is the
  unit the string actually draws: 1s under an hour, **60s past it**, and `Infinity` - no
  subscription at all - for a frozen clock. One interval still serves the whole app; a tick
  is delivered only when that subscriber's bucket turns over. A day-old pane costs 60
  renders an hour instead of 3600, per pane, for ever.
- **The buckets are measured from the clock's OWN start, never from the wall clock.** A
  wall-minute bucket ticks exactly as rarely - so a test that counts wakeups passes - and
  shows the wrong minute for up to 59 seconds of every one: a pane opened at :30 turns its
  displayed minute over at :30. That is the CONTROL assertion in the test.
- **The arithmetic lives in `src/shared/elapsed.ts`, not in `Elapsed.tsx`**, because a test
  cannot load JSX through node's type stripping and these rules were unchecked.
  `formatElapsed` carries days (`7d 03h`), since this clock is routinely overnight.
- `npm run test:elapsed`.

## The sessions list is the whole desk, both machines

There is no Fleet screen. The sidebar answers "which pane needs me first": grouped
**Your move / Running / Ready / Ended**, `shared/fleet.ts` deciding, Ctrl+Shift+F toggling
back to the dragged order (kept in `localStorage`, not config — it is a view). While grouped
a press is only a press: a drag reorders `order`, `order` decides nothing in that view.

**Every pane on a paired machine is in it, without being mirrored.** `client.panes()` has
always held every pane the far end has as whole `Session` objects; `RemotePaneInfo` now
carries everything `FleetPane` reads, so a PC pane sorts into `Your move` beside a local one.

- **Listing is not mirroring, and that split is the whole design.** Listing costs a few
  fields on the `remote:changed` message already sent; mirroring costs a live byte stream and
  an xterm buffer on THIS machine, per pane. `openListed` turns one into the other.
- **The order inside a group is the sidebar's own numbering, and nothing else.** Breaking the
  tie on how long a row had been in its state reads well and is wrong: the clock counts from
  `lastOutput`, so eight printing panes swap places under the pointer.
- **A listed row has no pane NUMBER** — there is nothing for Ctrl+N to reach until it is
  opened. A real row's number comes off the FULL ordered list, never off this screen's order.
- **A mirrored pane is never listed twice** — both halves are true for a beat while a mirror
  attaches.
- **A device that is off, connecting or in error lists nothing.** Its pane list is from before
  it went.
- **The badge counts both machines** — `fleetWaiting` over the whole list.
- **The device filter offers a machine that is merely CONNECTED**, not only one with a pane
  mirrored.
- A question over there cannot be ANSWERED from a row (the buttons need the frame a mirror
  carries), but it ranks the row exactly as a local question does.
- **A group is only worth a heading while its name is TRUE.** `Running` is `runSince` — a turn
  started by the submit keystroke, by the agent's busy footer, or by a shell pane's live
  command, ended by `endRun` — never `status === 'working'`, which any output at an `engaged`
  pane set, so the CLI echoing the prompt being TYPED moved that pane to Running. And `Ready`
  is not `!engaged`, which no pane could get back to: `/clear` drops `engaged`
  (`clearsConversation` in `shared/slashTurn.ts`, partial forms included). `/compact` and
  `/resume` do not — both leave a conversation somebody may want to read.
- **A return pressed at an EMPTY composer asked nothing**, so it neither engages a pane nor
  starts its clock. Claude Code's completion menu takes the FIRST return of a `/clear`, so the
  return that runs it is a second keypress at a composer this app has already emptied. The
  reading cannot be `typed === ''`: `SLASH_OPTIONS` is blind to a paste and a history recall
  on purpose. `slashTurn.isBareReturn` reads the same keystrokes a second way
  (`SUBMIT_OPTIONS`: pastes decoded, arrows and Tab setting `certain` false) and is true only
  for an empty line the parser followed every edit of. If a bare return answered a chooser,
  the agent's busy footer starts the turn a moment later. `npm run test:slash`.
- **A shell pane's turn ends with its COMMAND, with no quiet clock in front of it** — a shell
  echoes every keystroke. POSIX only: there `paneJob` is the tty's own foreground process.
- **Your move is STILL once you have arrived at it.** The card's flash runs ONCE (`doneGlow`,
  1.9s; `DONE_GLOW_MS` must stay in step), and the standing amber marks do not breathe. A red
  `asking` bar keeps its pulse — that one is a live question and it stops when answered.
- `shared/desk.ts` is the arithmetic. `npm run test:desk`, whose load-bearing half is the
  negatives and whose last block is a SOURCE assertion: a field added to `FleetPane` and not
  forwarded through the peer map still typechecks and sorts every remote pane wrong for ever.

## Finding something in a pane

Ctrl/Cmd+F, the ⌕ in the pane header, or `Find in this pane` in the phone's ⋯ sheet - all
three are `paneFind`, the map `TerminalPane` registers itself in. The bar highlights every
match, counts them (`3/10`) and steps with ↑ ↓ or Enter / Shift-Enter. It searches the live
xterm buffer, so it reaches as far back as that pane's scrollback and no further.

## Finding a setting

The search box finds the SETTING, not the page: matching rows are tinted, the best is
scrolled to and edged in the accent, and the rail follows it to that tab. Nothing is hidden —
a switch read out of the group that explains it is a switch nobody can judge.

- **The index is GENERATED from the dialog's own source** (`scripts/settings-index.mjs` →
  `src/shared/settingsIndex.ts`, `npm run gen:settings`). A hand-written one goes silently
  stale. `npm run test:settingsearch` regenerates it in memory and fails on disagreement.
- **A setting is found by its hint as well as its name**; a LABEL hit still outranks a
  hint-only one.
- **The marking is done to the DOM**, not by threading a `highlight` prop through nine tab
  bodies. A live reading in brackets is why the match is a prefix test rather than equality.
- `scrollIntoView` is `nearest`, never `center`. No animation (`test:anim`).

## A card answers a right-click, and can say what it is

`SessionMenu.tsx` is the desktop context menu on the card — opened at the pointer, clamped on
screen after it is measured (its height depends on which actions that pane offers), arrow keys
and Escape. Deliberately NOT `PaneMenu.tsx`, which is the phone's bottom sheet with 52px rows.

`SessionInfo.tsx` is the "see info" the card has no room for. **Its clocks are live** —
`Open for` counts from `createdAt` through `useNow`. The header's clock is the TURN and stays
that way. Everything else is a reading the app already holds — last spoke, last typed into,
the place, and the pane's real cost out of `main/usage.ts` — so opening it polls nothing.

## Copying a prompt, or the answer it got

Two copy icons beside every prompt on screen: the prompt, and the reply. Drawn for every
VISIBLE turn, never for the hovered one — a hover pair anchored to the turn's first row is
crossed by reaching for it, and leaving the terminal element takes it away entirely.

- Placement is `shared/turnCopy.ts` (`npm run test:turncopy`), fed by the prompt marks the
  rail keeps. Two prompts closer than one pair is tall: the NEWER keeps the space.
- Icons rather than words: this is drawn once per turn, and eight labelled buttons down the
  side is a second sidebar. 22px for a pointer, 30px for a finger; `TURN_COPY_H` in
  `TerminalPane.tsx` is the height the crowding rule uses — change it with the CSS.
- **A mark keeps two copies of the prompt, and the button copies the one that is not the
  label.** `mark.text` is what the RAIL draws — flattened to one line and `.slice(0, 400)`.
  `mark.full` is what was typed, whole, and is what the clipboard gets.
- **Full strength as soon as the pointer is in the pane.** Faint is for a pane nobody is
  pointing at.
- **Keyed on the mark, never on the buffer row** — a marker's line moves when scrollback is
  trimmed, and a changed React key unmounts the pair mid-click.
- `npm run test:turncopyview` types a 492-character prompt through xterm's own input path and
  reads the clipboard back (`Emulation.setFocusEmulationEnabled`).
- The reply is the rows after the prompt up to the row before the next one. Off by one either
  way and the paste is perfect and wrong.

**Every copy a person asked for says so.** Ctrl/Cmd+C, the right-click copy, copy mode's `y`
and the selection chip all report in the window's toast with the line count as the receipt
(`sayCopied`, one counter in one place). Copy ON SELECT is the one silent path, deliberately:
nobody pressed anything, and the highlight is its own feedback.

## A click puts the cursor where you clicked

A CLI's prompt is drawn text and a pty takes keystrokes, so a click can only become the arrows
that would have reached the same cell (`src/shared/cursorMove.ts`). The trap is that an
up-arrow in a plain shell is the previous command, not a movement.

- **A bare click is allowed the half that cannot recall anything.** `keysAlongLine` emits left
  and right only, and the pane calls it only when the click landed on the cursor's own logical
  line — its row, or a row the same input wrapped onto, proved by walking xterm's `isWrapped`
  chain.
- **On mouseup, and only when the pointer did not travel** — swallowing mousedown would take
  drag-selection with it.
- **The composer a CLI draws is ONE text field, found by its rules, not by its frame.**
  `composerAt` (`shared/promptBox.ts`) walks to the rule above and a rule of the SAME width
  below and requires a prompt marker on the first row; `inputRows` turns that into spans, and
  `offsetIn`/`keysForRows` count over them. **Crossing a row boundary costs exactly one
  character** — the space the wrapper ate, or a hard newline — and **nothing** when the row is
  drawn out to full width. A row within a column of the width counts as full on purpose:
  over-counting deletes a character nobody highlighted, under-counting leaves one behind.
  **The marker is followed by U+00A0, not a space** (`BLANKS` in `promptBox.ts`).
- **A drawn input box is the one place a bare click may go up and down** — inside a box the CLI
  handles the arrows itself, so they are movements. A plain shell draws none, and an ASCII `|`
  is deliberately not a frame. `npm run test:promptbox`.
- **A selection can be deleted, and typed over.** `keysForDelete` walks the cursor to the end
  of the selection and sends one backspace per character. Only on the cursor's own line and
  only across rows the input WRAPPED onto. Mod+A highlights the whole input and hands the key
  back when there is nothing to select.
- **The click is swallowed only on its way to an AGENT.** These handlers are capture-phase on
  the pane's host, and an unconditional `stopPropagation` robs xterm of the mouseup it removes
  its own drag listeners from. The stop is kept only while the CLI has mouse reporting on.
  `npm run test:stickyselect`.
- Alt/Option-click reaches other lines, refuses more than `rowLimit` rows away, and is the only
  path that may emit an up or down OUTSIDE a box.
- The clicked column is clamped to what is written on that row.

## A shell pane says what it is running

Every "is this pane working" reading is about an AGENT, so `npm run build` in a shell pane
printed nothing for two minutes while the card read `ready`. `shared/paneJob.ts` is the
reading; `npm run test:panejob`.

- **On POSIX it is the pty's own foreground process** (`tcgetpgrp`, behind node-pty's
  `IPty.process`). One syscall, on the same 1s sweep.
- **Windows has no such reading, and the failure is a LIE rather than an absence**:
  `IPty.process` there returns `"xterm-256color"` idle AND busy. So the answer comes off the
  process table (`jobFromTable`, `TABLE_JOB_MS` 4s, only while a shell pane is open, never twice
  at once): the pty pid IS the shell and the command is its child. That path knows how long the
  command has been alive, so the clock is its real age. An empty table leaves every pane as it
  was — "the table did not answer" may not wear the shape of "nothing is running".
- **A BACKGROUND job is invisible to the foreground reading, and that read as idle.** `cmd &`
  leaves the SHELL in front of the tty, so `paneJob` says nothing, `runSince` is never set,
  and `reclaim.ts` saw `busy: false` on a pane with two monitors running in it and started the
  idle countdown. So the same table answers on POSIX too (`sweepTableJobs`), asked ONLY for a
  shell pane whose foreground reading already came back empty — the tty answer is exact and
  free, and paying for a `ps` to repeat it is the waste this narrowness avoids.
- **`reclaim.ts` refuses on `job` as well as on `busy`.** They are set by different readings and
  one of them was wrong; the load-bearing test case is `job` refusing ON ITS OWN, with `busy`
  false, because that is the exact shape the bug had.
- **It feeds `busyOnScreen`, rather than being a state of its own**, so the pane sorts into
  Running and the 4s silent-turn backstop stands down.
- **The clock counts the COMMAND** — the row says `running npm`, not `working`.
- **Narrow on purpose, because the expensive failure is a FALSE job**: only a pane whose RUNNER
  is a shell is spoken about, and a foreground that is itself a shell is a subshell, not work.

## ...and an agent pane says what it left running

`shared/paneJob.ts` refuses to speak about an agent pane and that refusal is load-bearing -
it feeds `busyOnScreen`, so a false job there is a pane the idle sweep never closes, the
budget never moves and whose clock is a lie that ticks. But an agent that starts work in the
BACKGROUND (a `run_in_background` shell, a Monitor loop, a build) goes quiet the moment the
turn ends: the footer stops, `engaged` drops, the card reads finished, and the work is still
going. `shared/paneBackJobs.ts` is the cosmetic half - a chip on the card's clock line and a
sentence on its hover - and feeds NOTHING. `npm run test:panebackjobs`.

- **A count of the pty's descendants is not the reading, and the measurement is why.**
  Every `claude` pane here holds, permanently and from launch: `safaridriver --mcp`,
  `chrome-devtools-mcp` (plus a node child), `codegraph serve --mcp` (plus three) and
  `caffeinate -i -t 300`. Measured 2026-08-24 over four live panes: trees of 5, 7, 9 and 9
  with nothing whatever running, so "descendants minus the CLI" is 3-8 on an idle pane and
  the chip is on for ever.
- **What separates them is HOW a process was started, never what it is.** Every command an
  agent CLI runs goes through a shell it spawns with `-c`; an MCP server and `caffeinate`
  are spawned directly. So a job is a SHELL SUBTREE under the pty and the machinery is
  everything else - no vendor names anywhere in the rule. Against the same four panes the
  only shell subtrees in the set were the two real background tasks.
- **The age floor is `backJobs.LOOP_MIN_SECONDS`' 30s and for its reason**: a foreground
  Bash call is a shell subtree too, and this repo fires several per prompt - measured at
  00:00 and 00:02 against the real one's 39:10. A shell subtree is never walked INTO, so a
  `npm run dev` that spawned its own sub-shell is one job and not two.
- **The name comes off the `-c` string, first segment that is not housekeeping.** The leaf
  is regularly a runtime: `npm run dev` is `node .../next dev` three processes down, which
  prints as `node`. Taking the LAST segment reads correctly against the measured prelude
  (`source <snapshot> ... || true && <command>`) and names a live `sleep 400; true` job
  `true`, which is what a probe caught. The oldest live descendant is the fallback, and
  `workName` prefers the script over the interpreter.
- **It rides on the sampler that already runs.** `main/usage.ts` reads the process table
  every 4s for the memory chip, so `ps` gained `etime=` and `command=` rather than the app
  gaining a second ~380ms read for a chip. `shared/usage.ts` imports the rule as a TYPE
  only - `scripts/usage-test.mjs` loads that file into node with type stripping, where a
  value import of an extensionless sibling does not resolve - and `main/usage.ts` attaches
  the answer after `summarise`.
- Proved in a live window: a background shell under a pane is absent at 14s and reads
  `sleep` at 42s, with the pane's own `procs` at 3.

## What a pane leaves running

Quitting kills each pty with `taskkill /F /T <pid>`. Two things sit outside it and
`src/main/strays.ts` is both: an orphan whose middle process exited (so `npm run dev` leaves
vite behind), and the app dying without running `shutdown()`. A sampler walks each live pty's
descendants every 30s into `strays.json` under userData, keyed by the app run that owns it;
closing a pane, quitting and the next launch all kill from that ledger.

- **A pid is never enough** — every record carries the creation time, re-checked by whatever
  kills.
- **A run whose app is still alive is somebody else's** — usually the `npm run try` copy.
- **Nothing here may block the main process.** Every process-table read is `execFile`; the two
  paths that cannot wait hand the pids to a detached script.
- It never asks what the pane is RUNNING — a per-CLI hook is out of date the day a new agent
  ships, and silent in the crash case. POSIX needs almost none of this.
- `npm run test:strays` spawns real orphans (~25s). It loads the real
  `spawnDetachedNoWindow`; stubbing it makes every kill silently do nothing.

## A pane opened with a prompt sends it

`queuePrompt` in `src/main/sessions.ts`. A blind 2500ms timer fails silently: the pane holds a
fully typed prompt nobody sent, idle and green.

- **The readiness signal is an idle COMPOSER, never a clock**: output stopped AND `readsBusy`
  false.
- **The busy read looks at the last thing PAINTED, not at a window of scrollback** — a boot's
  `esc to interrupt` never leaves the buffer, so a fixed tail calls a pane busy for ever.
- **The return is a separate write**, a beat after the text.
- **The submit is confirmed, not assumed** — still idle a few seconds later means the return
  was eaten, so another goes, up to three. Every budget is an env knob
  (`npm run test:promptsubmit`).
- Model ids are part of this: a Codex pane on any `gpt-5.1-codex*` id answers `400 ... not
  supported when using Codex with a ChatGPT account` inside a healthy-looking pane, so
  `agents.ts` lists only ids measured answering on a subscription login.

## An agent's question is a row of buttons

`shared/choices.ts` reads the chooser off the pane's own frame, so it covers every CLI rather
than whichever one has a hook.

**The card is docked to the RIGHT of the question and does not repeat it** (260px,
`max-width: calc(100% - 16px)`, full width again on a coarse pointer). The answers are one per
line and all the same width, so arrowing repaints one border colour instead of reflowing a
wrapping row of pills. `npm run test:askrender` pins the dock, the absent copy, and the equal
button widths.

- **The reading is narrow because the expensive failure is a FALSE question.** Three things
  must all be true: the CLI's own `Enter to select` footer, options numbered 1..N with no gaps,
  and exactly one row carrying the arrow. Both positive fixtures in `npm run test:choices` are
  real frames.
- **The screen that ENDS a multi-question ask prints no footer.** `REVIEW` is a second anchor
  sitting ABOVE its list, so `readReview` walks DOWN, and it wins only when newer than the last
  footer. Two refusals keep it as narrow: 1..N with exactly one `❯`, and **nothing but blanks
  and rules below it**. `submit`/`done`/`finish` join `GOES`; `Submit answers and don't ask
  again` is still refused by `WIDENS`.
- **A RULE in the list is read exactly like a blank line** (Claude Code 2.1.235 draws one
  before the options it always appends). The box gutter is stripped too. The FOOTER is still
  the load-bearing guard.
- **Arrows and a return, never the digit** (a chooser that only reads arrows ignores a digit
  silently), spaced `CHOOSE_GAP_MS` apart. It counts from where the arrow is NOW
  (`askSignature` includes it), and a press against a question the pane has left is REFUSED.
- **The reading is on the SESSION, not in the pane** — the phone draws the same buttons and
  `pty:choose` is reachable over the phone server; a mirror is answered over the link.
- **A question is RED, makes its own NOISE, and leaves the machine.** The card glows red down
  its left edge while `Session.ask` is set (`.row.asking`, 15% and a 3px pulsing bar) and
  carries `asks you` with the question on hover. There is no ring on the pane itself.
  `sounds.ask` (default `knock`) plays on `sessions:ask`, and `done` is deliberately NOT played
  over it. `main/askNotify.ts` posts it to Telegram: silent with no
  `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, one message per question (`sameAsk`), never for a
  mirror, and it posts and stops — a bot token has exactly one long-poller.
  `scripts/pf-telegram.mjs` turns a TAP back into `pty:choose`. `npm run test:asknotify`.
- **A click on a pane holding a question types NOTHING into it.** A bare click becomes arrows,
  an Alt-click up and down, a selection delete a run of backspaces — and Claude Code enables no
  mouse reporting, so nothing is swallowed. `askRef` in `TerminalPane.tsx` refuses all three
  while `Session.ask` is set; the answer is the buttons. `npm run test:askclick` is a real
  mouse through CDP, with the control that the same click with no question still sends its
  arrows. **`window.api` is frozen by the context bridge**, so the pane keeps its own list
  (`window.__pf[id].clickKeys()`).
- `npm run test:choices`. Its load-bearing assertion is on the BYTE (`charCodeAt(0) === 27`).

## Arrowing through a question may not cost the whole desk

The sessions list is ONE array for every pane, rebuilt whenever anything about any pane
changes, and a pane's render re-measures the turn-copy pairs and the prompt rail against the
live xterm buffer. `TerminalPane` is `memo`'d with `samePaneProps`, which compares `ask`,
`termTheme`, `mirror` and `grid` BY VALUE because main sends a fresh object each time. Five
arrow moves went from 34 renders of every pane to 5 on the question's pane and 0 elsewhere.

- **The load-bearing assertion is the bystander's count**, not the question pane's: a memo that
  also skipped the question pane would pass a "renders went down" check and break the feature.
  `npm run test:askrender`; `window.__pfRenders` is the per-pane counter.
- A prop added to `Props` without a line in `samePaneProps` is a pane that stops updating for
  it, which is why that function lists them out instead of looping over keys.

## ...and a question with an obvious answer is answered

`shared/autoAnswer.ts` presses return instead — **on by default**, with a **thirty second**
default wait (Settings → "Answer an agent's question for me when the answer is obvious").

- **It takes the BEST option, not the first one.** Every CLI marks its own preference in the
  label when it has one — `(recommended)`, `[default]`, `- suggested` — and that is the tool
  STATING the answer, so exactly one marked option outranks a yes-shaped word and outranks the
  row the arrow is on, in both modes. Two marked options are a choice again. The marker raises
  rank and can never lift an option past a refusal.
- **The refusals are the feature.** Exactly ONE option leading with a yes-shaped word is
  answered. The arrow sitting on a REFUSED option is not a licence to take a different one
  (`Keep the current plan` stops too). An option that WIDENS permission (`don't ask again`, the
  bare word `always`) is never reachable, and neither is one that stops or answers with a
  question of its own. `anyQuestion` is the wider setting and takes the CLI's own default;
  both refusals still hold over it.
- **The whole wait is spent AWAY from this window.** `holdWhileWatching` (on) stamps
  `askHold` for as long as the app has the keyboard, and `startOf` runs the clock from the
  later of that and `askSince` — so nothing is pressed while somebody is reading the
  question, and looking away starts the full `waitMs` again rather than resuming a
  part-spent one. Held draws no countdown at all (`autoAnswerHeld`, a `hold` row naming the
  option): a deadline that restarts the moment the window is left is not a countdown. That
  is also what makes the Telegram buttons reachable — the question only ever reaches a phone
  with this window in the background, which is why the default is 30s and not 5.
  The one focus reading is `gameMode.deskFocused()`; a second probe is how two answers to
  "is this window focused" end up disagreeing.
- **Both clocks tick against the DEADLINE, not the wall clock.** `useNow(1000, at)` in
  `AskCountdown` and `AskClock`: with wall-aligned buckets the last step before a press was
  whatever fraction of a second happened to be left, which reads as a number that sits and
  then skips one.
- **The timing is `dueForAuto`, and it takes TWO signatures.** A press waits until the frame has
  sat unchanged for `waitMs`, and that signature includes the arrow, so arrowing at the desk
  restarts the wait. But "have I already pressed this one" may NOT ask that signature — our own
  keys move the arrow — so `askKeyOf` is the identity with the arrow left out, one press per
  identity, plus a `PRESS_COOLDOWN_MS` floor of 4s.
- **`maxRun` is given back by the pane going BUSY, and by nothing else** — a chooser mid-repaint
  reads as no question for one frame.
- **It says when, and what, before it does it.** `autoAnswerAt` puts the press's clock on the
  session under the same guards the presser runs under, refreshed from the TIMER as well as
  from a frame.
- **A hold CLEARS the deadline, it does not move it.** `refreshAutoPlan` writes
  `autoAnswerAt = 0` while held: the pane reads `held`, but the card's `AskClock` and the
  desk-wide tick (`soonestAuto`) read the bare number, so a hold that merely pushed the
  deadline out left the card counting and the tick sounding at somebody who had just clicked
  onto the pane to answer it.
- **The countdown is a banded row in the pane, a chip on the CARD, and a TICK.** In the pane
  (`AskCountdown`) it is a pill with tabular seconds beside `Answering for you with <option>`,
  and that option's button carries `.auto` — dashed, because `.on` is a different fact. The
  card carries the seconds beside its `asks you` chip (`AskClock` in `App.tsx`), and `playTick`
  sounds once a second through the last minute of whichever countdown is soonest (one clock,
  not one per pane). The tick is its own catalogue entry with its own Settings row, a third of
  an alert's level, and deliberately bypasses the 900ms alert throttle. `window.__pfTicks` is
  what makes it checkable.
- **A changed default cannot reach an existing desk on its own.** `defaults()` is WRITTEN to
  config.json at first launch. `defaultsV2` separates the two and `migrateAutoAnswer` applies
  the new defaults once, read off the **saved** config, never off the merge.
- `npm run test:autoanswer` (weight in the negatives) and `npm run test:askrender`.

## A pane that is still starting says so

`sessions:start` returns in 16-40ms; the first byte out of the pty arrives at ~0.5s warm and
~4.2s cold. Six panes started in one burst all had their first byte by 1.9s, and staggering
them by 400ms made it worse (4.7s), so `restorePanes` starting the desk in one tick stays.

What was missing is that nothing said any of it. `blank` in `TerminalPane.tsx` draws one dim
`Starting…` line until the first byte. No spinner — it is on screen for half a second in the
ordinary case, and a looping decoration is what `test:anim` refuses.

## A picture goes in front of the agent

Every agent reads an image off the DISK, so the bytes are written as a real file **on the
machine that owns the pty** and that path is typed (`shared/attach.ts` naming,
`main/attach.ts` disk, `pty:attach` / `pty:attachClipboard`).

- **A paste is the one place the ^V is right.** A clipboard image goes to an agent that reads
  the clipboard itself as a plain ^V; every other CLI and every MIRRORED pane gets the file and
  the path.
- **Forwarding a raw ^V only ever worked twice over** — it needs an agent that reads the OS
  clipboard (Claude Code does, the other twelve do not) AND that agent on the same machine as
  the clipboard.
- **A path is only true on one machine.** A plain session id types the path it has; `@device/id`
  and a browser send the bytes over the link, and `attachOn` answers with a path that exists
  over there.
- **The name is TEXT, never a path.** Only the basename survives, both separators, control bytes
  and reserved punctuation gone. The extension comes off the MAGIC BYTES when recognised.
- 5 MB a batch (base64 over the link's 8 MB frame is 4/3 of the size). Nothing is submitted for
  you — the paths land in the input box so they can be described first.
- **A dropped file arrives in TWO shapes.** A macOS screenshot dragged off its preview thumbnail
  carries `text/uri-list` with no File object, so nothing called `preventDefault` and Chromium
  typed the URL into xterm. `splitDropUris` turns a `file://` URI back into the path —
  percent-decoded, Windows' extra leading slash gone, a host kept as a UNC path — and an
  http(s)/data one is fetched. `text/plain` is deliberately NOT claimed.
- `npm run test:attach`. Not covered: pasting an image on the phone client.

## What a pane costs is measured, not modelled

`capacity.ts` models a pane at 190 MB and answers "is there room for another". The chip in each
pane title and the total beside the Sessions count answer "which one is eating the machine" —
`src/shared/usage.ts` (arithmetic) and `src/main/usage.ts` (platform commands and the timer).

- A pane is its pty's whole descendant TREE. Counting the pty loses the build the agent started.
- CPU is a delta of cumulative counters, never `ps %cpu` or a Windows perf counter. The first
  sample has no CPU figure; a process first seen mid-flight is capped at the interval.
- The sampler does not read the process table while the window is hidden or minimised, and never
  has two reads in flight.
- `npm run test:usage`.

## A reopened pane comes back with what was on its screen

The terminal's scrollback is renderer memory, so before this every pane reopened blank.
`test:restore` is a different promise: it hands the agent its `--resume`, which brings back
the conversation and not one line of the screen.

- **Nothing new is stored.** `history.ts` has appended every pane's raw output to
  `userData/history/<id>.log` all along; `tail()` reads the last `BUFFER_LIMIT`. The missing
  part was the **id**: a restored pane is a new session, so the desk carries `scrollbackId`
  (`snapshot()`) and `start()` seeds the buffer from it. Save the new id there and it restores
  nothing, silently, for ever.
- `tail` must not strip ANSI (`read` does, for search) and must cut on a line boundary. One dim
  line says where the old output ends, and it resets attributes first. `test:scrollback`.
- **It comes back with its own clock, and finishes the turn it was cut off in.**
  `shared/restoreTurn.ts` decides. The display clock is `openedAt`, its own field and
  deliberately NOT `createdAt` (three timers read that as the age of THIS PROCESS). A pane the
  restart caught mid-turn is continued through `queuePrompt`, off `runSince`, under the SAME
  switch as a turn the transport cut in half; a pane that was not mid-turn, or was launched
  with its own prompt, is left alone. `test:restoreturn`.
- **Which restarts ask is one rule with one switch.** `askAfterUpdate` (Settings → Updates)
  makes an update restart obey the same offer as a quit or a crash. Off by default, and inert
  while `restoreAfterUpdate` is off.
- **It is replayed at the width it was PAINTED at, and Fix cannot do this job.** Agent CLIs
  draw in absolute column moves and a terminal CLAMPS a move past its last column, so an old
  159-column screen replayed into 85 columns piles onto the right edge permanently. Fix asks
  the CLI to repaint the SCREEN, and the wreckage is in the scrollback. So `restoredTail`
  carries the old session's width out with the bytes (`colsOf`), `Session.replayCols` takes it
  to the pane, and the pane writes that part of the buffer at that width and hands the terminal
  back — **only the part before the restore mark**, and only while the mark is still there. The
  resize goes in the write CALLBACK, never after the call. `shared/replayWidth.ts`,
  `npm run test:replaywidth`.
- **It presses Fix for itself** — the other half: a frame drawn at 80x24 before the fit landed.
  A pane that came back with history runs `repair()` once, `RESTORE_FIX_MS` (1.2s) after its
  output stops. It is `autoFixUi`'s; a mirror is refused; a hidden pane is FLAGGED rather than
  repaired against a 0x0 host. `test:restorefix`, whose control is a new pane recording ZERO
  repairs.
- **The prompt tags come back with it.** The rail is built from KEYSTROKES, so a replay
  registers none. `seedMarks` scans the replayed buffer for the CLI's own `❯ <text>` echo, once,
  and only while the rail is empty. **`❯` only** — `>` starts a quote, a diff line, a shell
  prompt and a blockquote. A rebuilt tag carries no time (`at: 0`).
  **A row at a time is not enough**: a replayed screen holds every repaint of the prompt
  block, so `seedPrompts` refuses a row carrying a rule or followed by one (a torn
  repaint), refuses one with a non-blank row above it (an echo painted over tool output),
  and keeps ONE tag per prompt, on the LAST copy - the one still in the place the reader is
  looking at. Measured over this desk's own history logs: four tags for one ask, three of
  them wrong. `test:promptecho`.

**And `/clear` no longer takes the previous turn with it.** Three releases of Claude Code have
wiped the screen three different ways, so the answer is not a list of vendor bytes:

- **The pane keeps the screen itself, before the CLI has emitted a byte.** `keep.arm()`
  (`shared/keepScrollback.ts`) is called when a submitted line matches `mayClearScreen` and
  RETURNS the scroll — the screen pushed into scrollback, the cursor homed — which the pane
  writes on the spot.
- **What was TYPED is not what was SENT**: `/cle` picked from the completion menu runs `/clear`,
  so a bare slash TOKEN that is a PREFIX of one of those commands arms too. A miss destroys the
  turn somebody is reading; a false arm only scrolls a screen about to be repainted, and only
  rows holding something are filed (`used()`).
- **The composer is not history.** `keptRows` stops at the composer's top edge, and the composer
  is only believed when the CARET is between its two rules.
- **`arm()` is fed by keystrokes, and a keystroke is one of several ways a clear arrives.** The
  Clear button, the session menu, a phone and every path in main that types for you go through
  `paneArmClear`.
- **The unarmed case is caught by SHAPE, then by OUTCOME.** The cursor sent to the top with an
  erase is REPORTED, not acted on. The pane snapshots the screen and `shared/screenLoss.ts`
  decides once the redraw settles: filed only when **80%+ of the screen is gone** (a scrolling
  diff loses 35-44%). The `2J`/`3J` rewrite stays for a CLI that clears unasked, and stands down
  for 10s after an armed scroll.
- `npm run test:scrollclear` drives a real headless xterm with a control per shape.

**And a prompt tag survives the CLI repainting over it.** xterm disposes every marker on a row
that `CSI J` blanks (Claude Code lost 0 of 278, Codex 25-50%). `shared/markAnchor.ts`
re-anchors on a deferred callback when the line is still in the buffer, and ends the tag only
when the buffer has genuinely forgotten it. Line 0 is the one that goes.
`npm run test:markanchor`, whose control proves a bare marker really does die.

## History says what each session was working on

Every row carries one line: the first thing typed at the agent, plus how many asks followed.

- **It costs nothing.** No model, no tokens, no request — the line comes from keystrokes the app
  already relays, the same feed `promptArchive` is built from, so it works identically for every
  CLI. `shared/gist.ts` is only the tidy-up.
- **A row says when, as a DISTANCE.** Newest closed at the top (`endedAt ?? startedAt`, in
  `main/history.ts`), and inside a day the chip is `closed 5 min ago` rather than a wall-clock
  stamp the reader has to subtract from their own status bar; past a day the calendar takes back
  over, because `31h ago` identifies nothing. `whenWords` in `shared/elapsed.ts`, one minute clock
  for the whole list, the exact moment on the hover. `npm run test:elapsed`.
- **A row says whether it is still OPEN.** Green rail plus a green `open since` chip for a
  session with no `endedAt`, red rail plus a red `closed …` chip for every other row, so
  the answer is never carried by hue alone.
- **`View all` prints every chapter on the row**, out of `summaryFull`, replacing the
  clipped two-line gist. Drawn only where there is more than the row already shows (more
  than one chapter, or `dropped`), and it costs nothing — the chapters are on the entry.
- **The FIRST ask, not the latest.** The twentieth is a follow-up inside it and reads as nothing
  once the session is closed.
- **Scraping the transcript was tried and abandoned on the evidence** — a boxed composer is
  redrawn character by character and interleaved with its own repaints. A session that closed
  before the app recorded a line gets a best-effort one from the prompt archive and otherwise
  **no line at all**.
- **A session is several jobs, and `/clear` is where one ends.** The ask that opens each CHAPTER
  is kept — the first, and the first after each clear (`noteAskInto`, which reads a clear exactly
  as `keepScrollback` does). The row shows three and counts the rest; the hover and the opened
  session print them numbered. A clear is a boundary and never a chapter heading, every other
  slash command heads nothing, and `asks` counts only the ones that were WORK. Twelve chapters
  are kept and anything past that is counted rather than dropped in silence.
- **What was asked survives a restart** — `recordStart` runs again on the same id.
- **The transcript is RENDERED, not stripped.** A pane's log is a stream of REPAINTS: a seeded
  4 KB log was 205 lines of which 200 said `Thinking…`, against 3 lines and none through a
  terminal. `renderer/src/termRender.ts` is ONE copy, shared with the phone's `TextSheet`. It is
  replayed at the width it was WRITTEN at (`cols` on the entry); stripping stays as the fallback.
- It is written outside the prompt-recall gate. `npm run test:gist`.

## The app remembers what has been asked

`src/main/promptArchive.ts` answers one question — has this ask been made before — and is fed
from `shared/draft.ts`, on the way to the pty, **not** from any CLI's hook. That is why it
works: reading the bytes covers every agent, including ones that do not exist yet.

- **It never blocks, never types, never cancels.** All that happens is a chip in the pane's
  corner, on the same contract as Improve beside it.
- The quiet window (`QUIET_MS`, 6h) is load-bearing, not the score: a reworded re-send two
  minutes later is the SAME work.
- Only submitted lines are archived, never drafts, and only a capped preview plus the token set.
- **`src/shared/promptKey.ts` is a MIRROR of an algorithm that lives in three places outside this
  repo** (the `claude-memory` hook, the TaskDriver archive server, the Discord bot), which share
  one archive. Editing one copy splits it in silence. `npm run test:recall` recomputes the
  canonical file's answers and **skips out loud** when that file is not on the machine.
- Not built: nothing watches a pane's repo for the commit an ask turned into, so `outcome` is
  null for everything this app records.

## Dictation needs nothing installed

The mic on every pane, and Ctrl/Cmd Shift Space into the focused one. `shared/voicePick.ts`
picks between three transcribers and `useVoice.ts` falls down them: a **whisper CLI on PATH**
when there is one, otherwise **Whisper in a worker in this window** (`voiceWorker.ts`, ONNX
Runtime wasm), and on a phone **the browser's own recogniser** (the only one that sends audio
off the device).

- **Feature-detecting `webkitSpeechRecognition` is not enough** — in Electron the constructor is
  there and every session ends `error: "network"`. `browser` is gated on not being Electron.
- **The 8-bit weights do not run** (`TransposeDQWeightsForMatMulNBits / Missing required scale`).
  `bnb4` is the smallest that works; `shared/voiceModels.ts` carries the sizes.
- **The wasm ships with us**, copied by `electron.vite.config.ts`, which also deletes the 23.5 MB
  asyncify binary the worker never asks for.
- **Nothing on the page may import the worker's module** — one constant took the main chunk from
  1.01 MB to 2.23 MB. Constants live in `shared/voiceModels.ts`.
- **A phone is not a small desktop.** Touch, or under 720px, and dictating takes the whole screen
  (`VoiceOverlay.tsx`); the ring IS the input level. It also appears while the model downloads.
- `npm run test:voice`.

## ...and it knows what is serving, and can stop one

`devServers.ts` answers a package.json SCRIPT, which is what the OTHER machine needs.
`shared/devList.ts` answers what a person asking has in their head — the PORT and the pane.
`npm run test:devlist`.

- **One server, not one process.** A candidate whose ancestor chain reaches another candidate is
  folded into that ancestor (the thing a person typed, and the one whose kill takes the tree),
  and what the child knew — the port, the path — is folded upward.
- **A number is not a port because it is a number.** Only `-p`/`--port`/`--port=`/`PORT=` count;
  a wrong port is the one thing somebody acts on.
- **Attribution is two-legged**: tree first, then a path test against the pane's folder (a server
  reparented onto pid 1 defeats a tree walk). **A server no pane claims is still listed** — the
  question is what is running on this machine.
- **An ambiguous stop prints the list and asks.** Named by port, pid, pane, project, tool, "the
  first one", or "both". A generic label (`dev`, `start`, `serve`) never matches on its own.
- **The pid is re-validated in main before anything is signalled** — one whose command line is no
  longer a dev server is refused out loud. SIGTERM, then SIGKILL for anything still up.
- The renderer supplies only the ORDER and the words; every fact is read in main off the pane's
  own record. Read on demand when the ask box opens, never on a timer.

## The resource ladder has a face

`capacity.ts`, `autoHandoff.ts` and `reclaim.ts` trim, move and close panes on their own, and
their entire output used to be a `console.info`. `shared/mascot.ts` is the mouth,
`components/Mascot.tsx` draws it, `npm run test:mascot`.

- **It is not a model.** Every sentence is arithmetic over readings the app already holds, and
  every typed command is a small parser over the same list. Nothing leaves the machine.
- **What it says names the pane, which COPY of the project it is, what that pane was in the
  middle of, and when.** `paneWord` is `(1) taskdriver` and `(3) PaneForge lane a`: the number
  leads in brackets because a sentence naming several panes buries them otherwise, and it is the
  Ctrl key; the lane is `place.ts`'s own `role` and is added ONLY for a lane, because a bare
  project name already means the trunk. `(3)` is also a form `paneNumbers` reads, or the pet
  cannot answer a sentence it printed itself. The subject comes off `Session.gist` pushed onto
  the LIVE session, and the time is `agoWords`, rebuilt as the bubble draws. A pane nobody has
  typed a real ask into says nothing about one.
- **A pet is decoration; the reading is not, and `pet: 'none'` is the difference.** Turning the
  mascot OFF was the only way to say "no animal", and it took the ladder's only voice with it.
  `NO_PET` in `shared/pets.ts` keeps every reading and drops the sprite: the card docks
  bottom-right (`position: fixed`, no walk, no dash, no blink), and a pill carrying the pane
  count and the total is the press that opens the ask box, since there is no sprite to click.
- **Everything it says is selectable and copyable.** `body { user-select: none }` inherits, so
  `.mascot-say` and `.mascot-count-say` opt back in with both spellings, and one `⧉` in the
  tools copies `saidText`, the SAME expression the card renders, so a reading that goes stale
  (`agoWords`, the countdown) cannot be copied from a different moment than the one being read.
- **"What is open" is an answer.** Every other command needs a pane named or described first, so
  the most obvious opening sentence anybody types fell through to "I only know this machine". A
  dev server named beside a pane NUMBER (`stop the dev server in pane 2`) narrows the SERVERS
  rather than handing the sentence to the pane branch: answering it with "close pane 2?" offers
  the larger of the two things asked for. A bare "pane" with no number still means the panes, and
  two servers with nothing to separate them is still a question.
- **A bubble takes itself away** (`mascot.hideSeconds`, 60s, 0 = until pressed): a reading left on
  screen stops being one. The clock restarts on every keystroke in the ask box, and a COUNTDOWN
  is exempt.
- **A guess is never an action.** "close pane 9" with five panes closes nothing and says how many
  there are; names match longest-first with a contained name dropped (`service` inside
  `service-a`); every destructive intent is OFFERED as a press. `closeable()` (and `CLOSEABLE`) is `reclaim.ts`'s own refusal set.
- **A finished turn is the pane this ladder exists for.** `fleetState` says `needsYou` for both a
  live question and a finished turn, so the refusal that is meant is the pane's own live question
  (`asking`, off `Session.ask`), never the word for its state.
- **The countdown is HEARD, not only drawn.** `sounds.move` (default `bowl`, its own Settings row)
  plays once when a countdown arms and the last five seconds tick — the only alert here that is
  the app announcing itself.
- **Nothing decides and then reports: it counts down first.** Both sweeps hand their plan to
  `armCloseRef` and the mascot draws `CLOSE_COUNTDOWN_MS` (15s) with the pane named, `Keep it open`
  and `Close now`. Doing nothing still closes it. `Keep it open` holds those panes for
  `KEEP_MINUTES` (60). With the mascot hidden there is nowhere to draw a count, so it closes.
- **It speaks unasked once per situation**, and only where the app is otherwise silent: two or more
  finished panes, quiet over an hour, over 1.2 GB, with the idle-close clock OFF.
- **There are TEN of them and they cost the same** (`src/shared/pets.ts`). The animation is keyed
  on the SLOT rather than the animal, so a new pet is ART and nothing else. Only the picked one is
  mounted, each layer is walked into runs once per app run and cached by identity, and the rig is
  `animation-play-state: paused` behind a minimised window. Every pet is on the SAME 24x24 grid —
  at 48 CSS px that is exactly 2 device pixels a cell and `crispEdges` never has a half pixel.
  Detail comes from layers and shades, never more cells. A pet may not float, and `test:mascot`
  fails on a `translateY` anywhere in that stylesheet.
- **It arrives OFF** — a pet is decoration before it is a reading. Only a new install gets the off.
- **It runs about, rarely, and every condition is a refusal** (`dueDash`, `DASH_EVERY_MS` 9 min):
  nothing to say, where the app put it, `roam` on, and somebody looking at this window. The run is
  placed at the start line with the transition OFF for one frame (`dash-port`), then a single
  `left` transition with a ball ahead of it.
- **It can be picked up.** Pointer events, captured, storing the GRAB offset; a drop writes
  `mascot.spot` as a fraction of the window and **beats every automatic move**. The pin icon gives
  it back. Under `DRAG_SLOP` the gesture is still the press that opens the bubble, and the click
  after a real drag is refused from a REF.
- **The bubble is placed in the LAYER, in pixels** (`bubbleSpot`), clamped inside the window on
  both axes. Unmeasured counts as full width.
- **The layer never takes a click**: `z-index: 40`, over the panes and under every dialog,
  `pointer-events: none` except the sprite and its bubble.
- **Mute by default.** **It never picks which machine**: `hand off pane 2` opens the box with the
  panes chosen. A press closes whichever half is up.

## ...and one card says what this app can even do

One quiet card in the bottom-right — `shared/tips.ts` for the catalogue and every judgement,
`components/Tips.tsx` for the card, `npm run test:tips`.

- **It costs nothing**: a fixed sentence chosen by arithmetic over what has been seen.
- **It never interrupts**: silent while any dialog is open, while an update card is up, while ANY
  pane is holding a question, behind a minimised window, and for the first four minutes.
  `FIRST_MS` 4 min, `EVERY_MS` 40 min; the load-bearing half of the test is those negatives.
- **It says how to stop it before anybody has to go looking**: the first card and every fourth
  after it carry the sentence and the button (`offersOff`). Settings is the way back on.
- **It cycles rather than repeating**: every tip is shown once before any is shown twice, and
  `seen` resets rather than going quiet.

## A session that clears itself asks first

`claude-config/autoclear.mjs` (a Stop hook) decides a session is past its context line AND that
its handoff lists work a fresh session could start, then asks this app to clear that pane over
the phone server (`pane-clear.mjs` → `autoclear:ask`). The desk draws a countdown card: what
would be continued, how long is left, **Keep this session** and **Clear now**. Nobody at the desk
means it still happens by itself.

`shared/autoclear.ts` holds every refusal and `main/autoclear.ts` the clock; both are
re-evaluated against a FRESH pane reading each tick, so a pane that starts another turn, is typed
into, exits or disappears drops its countdown. An ask with no open steps is refused at both ends.
A PaneForge older than the channel makes the hook REFUSE rather than fall back to the instant
clear. `npm run test:autoclear`.

## The screen stays on while a pane works

`shared/awake.ts` + `main/awake.ts` hold a `powerSaveBlocker` while any pane has an agent
mid-turn or is sitting on a question, and let go when the desk goes quiet.

The cap is the load-bearing part: it is on the BUSY STRETCH, not on the hold, so a wedged pane
cannot keep a laptop lit all night and cannot re-arm the hold by ticking.
`config.keepDisplayAwake` turns it off. `npm run test:awake`.

## A pane's two ends open at the same width

Everything an agent CLI prints is absolute column moves, and a terminal CLAMPS a column it cannot
reach. So a pane has exactly one rule: the grid it is drawn into may never be narrower than the
width its bytes were painted for. `src/shared/paneGrid.ts` is that one number, read by BOTH ends.

- The pty spawned at 120 while xterm opened at its library default of 80, and a `claude --resume`
  dumps the whole conversation at once — so every answer drawn out to column 119 was torn apart
  permanently (xterm can unwrap a row it wrapped itself and can never undo a clamp). This is NOT
  `shared/replayWidth.ts`'s bug, which is a RESTORED pane's old bytes; this one is the pane's own
  live output, on every launch.
- **Fix now repairs the scrollback, not only the live frame.** `redrawHistory` re-renders the pane
  from the raw byte stream main is holding at `max(pane now, replayCols, START_COLS)`, then hands
  the width back. User-initiated only: it reads the capped buffer, so older scrollback does not
  come back. `window.__pf[id].redraw()` is the same thing for a probe.
- `npm run test:panegrid`. Its load-bearing half is the CONTROL — one line painted into a narrower
  grid MUST still tear across several rows, because a clamp wraps rather than deletes.

## Checks

`npm run typecheck` before committing, and `npm test` — 81 checks in ~145s, everything needing no
window, no network and no real agent CLI (`scripts/test-all.mjs`). It is also the release gate's
third step: `agentGate.ts` looks for a script called exactly `test`. **A new cheap test goes in
that list or it never runs by itself.**

Each row says what its test PINS; the reasoning is in `docs/design-notes.md`.

| Command | Covers |
|---|---|
| `npm run smoke` | the pty layer |
| `npm run test:restore` | which conversation a reopened pane goes back into |
| `npm run test:scrollback` | and what is on its screen when it gets there |
| `npm run test:replaywidth` | ...drawn at the width it was drawn at, with the shipped behaviour kept as the control that must FAIL |
| `npm run test:panegrid` | that the pty and the terminal open on the SAME width (the old 80-column default is the control that must still tear), and that Fix re-renders from raw bytes |
| `npm run test:claim` | which conversation a pane may claim when three lanes share one project folder: somebody else's launch refused, the pane's own taken, and the pane following its own `/clear` kept as the control |
| `npm run test:restoreturn` | the display clock, the engaged flag, continuing a cut-off turn, plus source assertions so a green test over a function nothing calls cannot pass |
| `npm run test:promptecho` | rebuilding prompt tags from the `❯` echo, and the four things that must NOT become tags |
| `npm run test:consoles` | sweeping console hosts left behind |
| `npm run test:strays` | what a PANE left running (real orphans, ~25s) |
| `npm run test:gitpoll` | the badge's `git status` cache, over a fake clock |
| `npm run test:install` | quitting takes the install pty's whole process tree |
| `npm run test:lanes` | lane engine, worktree sweep, ownership, the any-repo release contract |
| `npm run test:laneargs` | what `runSafe` hands a program, through a real cmd.exe |
| `npm run test:laneforeign` | a foreign clone at a lane's path: named and refused, commits untouched (control: it passes the old `--is-inside-work-tree` test) |
| `npm run test:lanepeers` | the other desk's claim arithmetic and its negatives |
| `npm run test:lanedevice` | the same with real plumbing, and the two locks that looked right and were not |
| `npm run test:gate` | what stops an automatic release, and that the refusal is CACHED on the commit |
| `npm run test:notes` | release-note ranges and both template shapes |
| `npm run test:pickrelease` | the newest release carrying an asset THIS platform can install |
| `npm run test:promote` | a soaked dev build promoting with a younger one on top of it |
| `npm run test:remote` | the device link end to end over a real loopback socket, including the size BORROW and its refusals |
| `npm run test:pairask` | six digits that agree between two ends, and DISAGREE through a real relay |
| `npm run test:handoff` | a pane moved whole over a real link and real git, and the refusals |
| `npm run test:handofffit` | that the hand-off box can still be answered with real machine names in it |
| `npm run test:theme` | palette derivation + contrast (358 assertions) |
| `npm run test:autoclear` | the countdown in front of an automatic /clear, every refusal, and that Cancel types NOTHING |
| `npm run test:awake` | holding the display awake, letting go, and the CAP on one busy stretch |
| `npm run test:stashtheme` | that the Stash picks no colour of its own and asks the theme, not the OS |
| `npm run test:sounds` | the alert catalogue: nothing silent, nothing clipping, uploads |
| `npm run test:blurbs` | the "what this is" note on each feature, and that each is rendered |
| `npm run test:place` | the words a pane's strip prints (56 assertions) |
| `npm run test:elapsed` | what a clock prints, and how rarely it may wake the app to print it - with the wall-clock bucket kept as the control that must FAIL |
| `npm run test:surfacereach` | that every method the window exposes has a call site under `src/renderer/src`; four are desk-side on purpose and each names who calls it |
| `npm run test:mirrorfit` | how a mirrored pane draws somebody else's grid, with all three failed walks kept as controls, and growth past the user's font up to `MAX_FILL_FONT` (28) |
| `npm run test:panebackjobs` | what an AGENT pane left running: real trees off this machine as fixtures, every permanent MCP server and `caffeinate` refused, the naive descendant count kept as the control, and a last block over this machine's own live table |
| `npm run test:panejob` | what a shell pane is running, its refusals, and a last block asking a REAL pty |
| `npm run test:desk` | the sessions list with both machines in it, plus a source assertion that every ranked field is forwarded from the peer |
| `npm run test:agentenv` | the environment a pane's agent starts with, and that one provider's key cannot fill another's variable |
| `npm run test:orcatalogue` | the live model list: no tool calling never reaches the menu, a broken answer changes nothing, nothing is capped, both prices, and the stealth warning |
| `npm run test:devicewatch` | noticing a copied cookie, and the negatives that decide whether the mark is read |
| `npm run test:projects` | which folders are projects and which are copies of one |
| `npm run test:cardfit` | that a session card can still be read at 190px |
| `npm run test:confirmfit` | that the yes/no box can still be answered |
| `npm run test:diff` | reading a repo's changes: `-z` records, renames, patch numbering |
| `npm run test:railplace` | where a prompt tag is drawn (no window) |
| `npm run test:grid` | layout arithmetic, no window needed |
| `npm run test:turncopy` | where a turn's two copy icons go, and the reply range that is off by one |
| `npm run test:cursorclick` | the keys a click sends, the clicks refused, and that a BARE click emits no vertical arrow |
| `npm run test:stickyselect` | that a highlight stops moving when the mouse is let go |
| `npm run test:promptbox` | telling a CLI's drawn input box from a zsh prompt, a diff and a markdown table |
| `npm run test:promptsubmit` | that a pane opened WITH a prompt sends it, and never once working |
| `npm run test:choices` | reading a live question off a frame, two real shapes, the negatives, and that the arrows really are escape bytes |
| `npm run test:askclick` | that a click on a pane holding a question types NOTHING (needs a window) |
| `npm run test:askrender` | the countdown drawn in the pane, on the card, ticking — and what arrowing costs every OTHER pane (needs a window) |
| `npm run test:autoanswer` | which questions may be answered for you, the timing over a fake clock, and source assertions on the state the guards read |
| `npm run test:anim` | what a looping decoration may cost: `transform` and `opacity` only |
| `npm run test:attach` | bytes landing on the machine owning the pty, the extension off magic bytes, an oversized batch writing nothing, and no escape from the folder |
| `npm run test:asknotify` | a question on its way to Telegram, silent with no credentials, never asking for updates |
| `npm run test:settingsearch` | that a setting is findable by what it DOES (the index is generated from the dialog's source) |
| `npm run test:onestash` | that there is one Stash |
| `npm run test:stashsummon` | that it is not on screen until asked for, and opens at the pointer's own display |
| `npm run test:panesize` | who owns a pane's shape when several screens borrow one pty, and that a borrow whose screen went quiet expires - with a mirror's leaseless borrow, and a desk resize under a LIVE borrow, kept as the controls |
| `npm run test:linkstate` | what a phone says when the desk stops answering, and the ordinary reconnects it must stay quiet through |
| `npm run test:tunnel` | a URL never called up before it resolves, a hanging cloudflared settling anyway, per-platform asset names |
| `npm run test:funnel` | which machine can be funnelled, which refusals mean "quietly use cloudflared", and that stopping SAYS so |
| `npm run test:gist` | the one line History puts under a closed session |
| `npm run test:qr` | the pairing QR, by DECODING it — every version at every mask |
| `npm run test:stash` | what the Stash may cost, search in main, an edit keeping its row |
| `npm run test:conceal` | what the Stash may not remember: markers only, never a guess at secret SHAPES |
| `npm run test:pipe` | the live tee; ANSI stripping across chunk boundaries |
| `npm run test:copymode` | keyboard copy mode arithmetic |
| `npm run test:silence` | the quiet-turn alert; an idle pane is NOT stalled |
| `npm run test:discord` | Rich Presence against a fake Discord over a real named pipe |
| `npm run test:voice` | dictation: which transcriber, and a spoken clip through it |
| `npm run test:recall` | "you have asked this before", and PARITY with the canonical fingerprint |
| `npm run test:rename` | the folder rename, on a throwaway repo |
| `npm run test:dock` | the macOS Dock icon |
| `npm run test:macupdate` / `test:macdownload` / `test:wedge` | replacing our own bundle, every way a download can end, and that no hung promise needs a person |
| `npm run test:history` | what transcripts may cost |
| `npm run test:scrollclear` | all three byte shapes of an agent's `/clear`, a sequence torn across chunks, and a control per shape |
| `npm run test:markanchor` | that a prompt tag survives the CLI erasing its row |
| `npm run test:quitwords` | telling a Cmd-Q from an outside kill; the load-bearing case is the false positive |
| `npm run test:recover` | finishing a turn the transport cut in half, and the refusals |
| `npm run test:reclaim` | closing idle panes: pressure is the trigger, a pane waiting for a person is never closed, the window is never emptied |
| `npm run test:capacity` | how many panes a restore starts ticked, red-proofed against the warn branch |
| `npm run test:mascot` | what the mascot may do to somebody's panes, its four silences, and that every pose it defines is drawn |
| `npm run test:autohandoff` | moving a finished pane instead of closing it, and what the BUDGET rung may move at all (red-proofed) |
| `npm run test:devlist` | what is serving now and which one a sentence names |
| `npm run test:backjobs` | what a machine runs with no pane on it, plus a last block reading THIS machine's real process table |
| `npm run test:devservers` | turning a running server back into the package.json script that starts it, and the drops |
| `npm run test:macsign` | the signing that stops TCC resetting permissions every release |
| `npm run test:winshortcut` | whether a launch puts the Desktop shortcut back, and the three refusals |
| `npm run test:winfeed` | which release the Windows dev channel may pin its feed at |

Needing a real window (`npm run build && npm run try -- --keep --show
--remote-debugging-port=9333`): `test:view`, `test:stashdrag`, `test:activate`,
`test:turncopyview` (happy minimized), `test:restorefix` (two launches), `test:askclick`,
`test:askrender`, `test:devicesfit`, `test:phoneview`.

`test:devicesfit` measures the Devices panel in the running app: two columns on a wide window,
the shell never scrolling, nothing reaching the Close button. Red-proofed by putting the single
column and the missing `padding-top` back — 4 of its 6 checks fail.

Out of the default suite because they need the network: `test:discordbrand` (asks Discord what
`DISCORD_APP_ID` is called AND whether `PRESENCE_IMAGE`'s asset still exists — the two halves
fail separately), and `node scripts/mac-update-test.mjs --live <version>` (~120 MB).

Other agent-runners are watched by `npm run competitors` (`npm run test:competitors`), which
prints only what moved.

## A turn the transport cut in half finishes itself

An agent whose stream dies mid-answer prints an error and returns to its composer. The session is
fine and the only thing between it and the rest of its answer is somebody typing `continue`.
`shared/recover.ts` is that decision. `npm run test:recover`.

- **It keys on the SECOND sentence.** Five different first sentences have already shipped and
  every one ends `The response above may be incomplete.` — the CLI stating the precise thing that
  makes resuming safe. The first sentence is a vendor's wording and is the wrong half.
- **A rate limit, usage limit, credit balance, auth failure or overload is never continued**, even
  carrying that sentence.
- **An error somebody QUOTED is not an error.** Once submitted the CLI echoes it back with the
  full string intact; what separates them is the marker a CLI draws in front of a person's words,
  so a line starting `> ` is somebody talking. A copy still being typed is caught by `promptBox`.
- Three in a row and it stops; only output since the last look is read; and the send goes through
  `queuePrompt`.

## A full machine gets its panes back

`capacity.ts` gives back scrollback, ~5% of the bill (twelve panes: ~74 MB of ~1.5 GB), because
the cost is the agent CLI inside the pane (~190 MB each, against 16-17 MB for Codex).
`shared/reclaim.ts` returns the agent, by closing the pane. `npm run test:reclaim`.

- **What makes that defensible here**: `kill()` calls `recordEnd`, so a closed pane keeps its
  History row, its `resumeId` and its `scrollbackId`. A closed pane in this app is a minimised
  pane in any other.
- **Pressure is the trigger, never a clock.** Idle time only breaks ties once the kernel is
  already objecting.
- **A pane waiting for a person is never closed.** `needsYou` is quiet BECAUSE it is owed an
  answer. Nor is the focused pane, one on screen, one working or starting or stalled, or a mirror.
- **The window is never emptied.**
- **The reading of the machine is a card that ARRIVES and LEAVES, never a strip.** The
  sidebar's `.capacity` line was on screen for as long as the reading held, which is most
  of a working day on a full desk, and a line that is always there is a line nobody reads.
  `.cap-pop` is armed by the verdict CHANGING into something worth saying (`level|why`,
  cleared when the desk goes back to ok) and takes itself away after `CAPACITY_NOTE_MS`
  (12s), carrying the exact figures with it. The desk TOTAL beside the pane count went with
  it: it is drawn only while `capacity.level !== 'ok'`, because it is a pressure reading.
- **A press on a pane takes its countdown with it.** `touchPane` drops `closeSoon` when the
  countdown names that pane (and gives `handoffSweeping` back for a move). The "went back to
  work" effect keys on `stillCloseable`, which a click does not change - so before this,
  clicking the pane restarted its idle clock and published a new deadline on its card while
  the 15s count ran on underneath. Other panes in the same plan are re-decided by the next
  sweep: nobody arrived at those.
- **A pane can be taken off the clock for good.** `ReclaimPane.pinned` - "Keep this pane
  open" on the card's right-click, `kept open` where its countdown would have been - is
  refused by `onTheClock` AND by `reclaimPlan`'s filter: somebody who said keep this one did
  not mean unless memory is tight. `keptUntil` stays the answer for "not now" (an hour).
- **Looking at a pane is USING it, at BOTH ends of the visit.** `quietSince` is the latest of a keystroke, a printed byte and
  the moment the KEYBOARD LEFT (`ReclaimPane.lastFocus`, threaded in from the renderer, which is
  the only side that knows which pane is focused) - stamped when focus LEAVES and when it
  ARRIVES, plus `touchPane` on the press itself, or a pane picked up while its chip said
  `closes 1:12` kept that deadline for the whole visit and went straight back to it. Without it a pane read for ten minutes was
  already past a five-minute deadline the instant it was switched away from, and its card's first
  word about it was a red `closes 0:01` — a countdown nobody can act on. One reading, so the sweep
  and the card cannot disagree.
- **The clock counts time a person could have acted in, not wall time.** `shared/away.ts`
  freezes it at the moment the machine's last input happened while
  `powerMonitor.getSystemIdleTime()` says nobody is here (`AWAY_AFTER_MS`, 60s), and it
  carries on from there when they come back — ten minutes away costs a pane nothing.
  `main/away.ts` polls every 15s and pushes `system:away` on a CHANGE. The second desk is
  refused by `sawPerson`, not by a setting: a machine no person has ever touched has nobody
  to be away, so it behaves exactly as before. **Only the clock pauses** — `reclaimPlan`,
  which fires on real pressure, is untouched, so a laptop left open all night is still
  protected by the reading that was always the honest trigger.
- **There IS a clock, and it is off.** `reclaim.idleCloseMinutes` closes a pane nobody has typed
  into for that long whatever the memory says; 0 is the default. The switch sets
  `IDLE_CLOSE_MINUTES` = **30 minutes**. It exists for the second machine — a desk driven over the
  link, which fills with finished panes and has no person to close them. Every refusal above is
  shared verbatim except **visible**, which it cannot keep: on a machine nobody is at, every pane
  in the grid is "on screen". `idleClosePlan`, its own minute timer in `App.tsx`.

**And a restore is the one moment N agents start in a single tick.** `restorePlan` in
`shared/capacity.ts` decides how many start ticked: everything at normal pressure, **two** at
warn, **one** at critical, and never zero while there is a pane to offer. That is safe only
because nothing is lost — an unticked pane keeps its conversation and its screen. It is a
**preselect, never a cap**. The reading comes from `readPressure()` at the moment the offer is
built, not from `lastPressure`, which on a cold launch may not have sampled. The silent paths (an
update restart, `restoreAfterRestart: 'always'`) are deliberately untouched.
`npm run test:capacity`, red-proofed against the warn branch.

## ...and before it closes one, it tries to move it

The ladder is four rungs, each firing only where the one above did not solve it: trim scrollback
(~5%) → start the NEXT pane over there → **move a finished pane over there** → close it.
`shared/autoHandoff.ts` is rung three; `npm run test:autohandoff`.

**And none of that fires until something has already gone wrong.** `Machine.keepLocal`
(`autoHandoff.keepLocal`, **2**) is a budget, `Verdict.over` is how many panes are past it, and
`budgetPlan` moves exactly that many.

- **Past the budget the question is what a pane COSTS, never how many there are.** The budget rung
  filters by `expensive()`: a live shell/dev-server job (`AutoPane.job`, which outranks both
  numbers), or `budgetMinMb` (500), or `budgetMinCpu` (50% of one core). Dearest first, then the
  quiet-and-off-screen order. **An unmeasured pane is not expensive** — the sampler does not read
  the process table behind a hidden window. A desk far over budget with nothing expensive on it
  moves NOTHING and stays over, which is the honest answer. The pressure sweep and the idle clock
  are untouched, and `test:autohandoff` keeps a cheap pane under pressure as its control.
- **The budget is a policy, so it holds at `ok`** — the one sentence in `offloadTarget` that had to
  change.
- **It is the only rule allowed to move a pane that is ON SCREEN or MID-TURN.** Those two gates
  only ever meant "there is no emergency", and with the grid on `visible` is every pane. A busy
  pane is picked LAST (`rank`: quiet-and-offscreen, then quiet, then mid-turn) and goes through the
  same queue; `queueable` is the wider set `movable` cannot be. Everything that could lose work is
  refused unchanged: the focused pane, a live question, a mirror, one already moving, one on a
  failure cooldown, the last pane on the desk.
- **The number moved is the overshoot, not `maxPerSweep`** — that cap exists so a machine under
  pressure re-reads its own recovery between moves.
- **Lag is read as well as memory, and the worse of the two decides** (`lagLevel`,
  `worstPressure`). One runnable thread per core is `warn`, 1.8 is `critical` — NOT a CPU
  percentage. `os.loadavg()` is 0 on Windows, so 0 means "nobody measured" and never "idle".
  `watchPressure` watches the lag BAND too.
- **Nothing asks any more.** `offloadAsk` defaults off with a one-time `offloadDefaultsV2`
  migration (the `migrateAutoAnswer` shape — read off the SAVED config).
- **The pressure card OFFERS the move.** `suggestMove` names the dearest movable pane and the
  machine it would go to, and `.cap-pop` carries `Move it` / `Keep it here` - the card said
  memory was tight and left the reader to work out which of eleven panes to act on.
  `Keep it here` adds the PROJECT to `autoHandoff.keepHere`, which every rung refuses (a
  pane's id dies with the pane; "this project is Mac-only" survives a restart). Settings
  lists them and a press takes one off.
- **A pane is never handed back where it came from** — two desks each keeping two agents are each
  correct and would pass one pane between them for ever. The sender puts its own id in the payload
  (`senderDevice`), the receiver stamps it (`arrivedFrom`), and `hostFor` skips that device. A
  second machine that did not send it may still take it.
- Both hardened like `offloadMinutes` (`keepLocalOf`): these come off config.json and
  `pf-ctl call config:set`, so `true` is not a budget of one.
- **A pane mid-turn is queued, never killed.** A pty killed mid-answer loses that answer for good,
  since the far end resumes from the transcript file. `main/handoffQueue.ts` holds it and moves it
  the instant the turn ends. A pane that never goes quiet **expires** after `waitMinutes` and stays,
  said out loud. **And the chip that reports the wait is the control that ends it**: pressing the
  chip, or `Keep it here` in the card menu or the phone's sheet, drops the entry
  (`remote:handoffCancel`); a move already IN FLIGHT has left the queue and says so.
- **`undefined` means keep the stamp; only `null` clears it.** `handoffQueuedAt` is what makes the
  chip say `waiting 12m` instead of `moving`, and every entry into a handoff paints the pane before
  it knows which of the two this is. `run()` is the one caller that passes `null`.
- **The turn ending is an EVENT, not something to poll for.** `handoffQueue.poke()` on every
  `sessions` change; the `TICK_MS` (5s) tick stays as the backstop for expiry.
- The local half of a move is ~100ms; the push is SKIPPED when nothing is unpushed.
- **A pane holding a question is never moved, queued or otherwise.** `AutoPane.asking` is separate
  from `needsYou` for exactly this.
- Every other refusal is `reclaim.ts`'s verbatim. A failed move puts that pane on a
  `cooldownMinutes` hold.
- **...and those last two refusals are why it could never fire.** So `idleOffloadPlan` is the
  opt-in clock beside it (`autoHandoff.offloadIdleMinutes`, 0 = off, the switch sets 30): it drops
  `visible` and the pressure gate and **nothing else**. Three times what the pressure sweep waits.
  Its own minute timer. The load-bearing test is a PAIR — the pressure sweep still refuses a
  visible pane, the clock takes it.
- **`handingOff` is on the Session, and `reclaim.ts` refuses it**, or the closing sweep and the
  moving sweep race over the same pane and closing wins by being faster. Every exit from a move
  clears it, refusals included.
- The sweep runs in the renderer beside `reclaim` (it needs `visibleIds`) **and on a 60s clock**: a
  desk that is full and quiet emits no session events.

**And the dev server travels with it.** `kill()` takes the pty's whole tree.
`shared/devServers.ts`, `npm run test:devservers`.

- **The server is routinely not a descendant of the pane** (a `next dev` on ppid 1 with its npm
  parent exited). A process is attributed by the tree OR by its command line naming a path inside
  the pane's repo.
- **What is running is not what would be typed.** Re-issuing the observed argv hard-codes a port
  and runs a binary out of a `node_modules` the receiver may not have. So an observed process is
  turned back into a package.json **script name**, and the receiver rebuilds the command from its
  own package.json and lockfile.
- **The payload cannot name a command, only a script**, re-validated against `SCRIPT_NAME` on
  arrival. The worst a malicious payload reaches is a script that repo's own author wrote. It lands
  in an ordinary `shell` pane, already swept by `strays.ts`.
- **An ambiguous match is dropped and named.** `npm run build` and `npm test` never travel. Only
  `DEV_SCRIPT` (`dev|start|serve|watch|preview`, with or without a `:suffix`) does.

## What Windows loses between restarts

- **The Desktop shortcut.** `build/installer.nsh` deleted `$DESKTOP\PaneForge.lnk` on every run:
  `IfFileExists ... 0 +2` skips exactly ONE instruction, and the macro runs from `customInit` AND
  `customUnInstall` (the old version's uninstaller during an ordinary update). The guard is fixed,
  but a guard in the installer only covers the installer, so **the app puts a missing shortcut back
  on launch** (`main/winShortcut.ts`, decision in `shared/winShortcut.ts`). It never rewrites one
  that is there (admin mode repoints these), and never claims the Desktop from a `npm run try` copy.
- **The login entry.** `setLoginItemSettings` was only called when the SETTING changed, so the HKCU
  Run value was written once and never checked. Re-applied from config on every launch, and only
  when it disagrees.

Both are logged to `updater.log` (`windows ...`). `npm run test:winshortcut`.

## The Windows dev channel picks its own release

`GET /repos/robertiuoras/PaneForge/releases` answers **200 with an empty array** (anonymously AND
with the gh CLI token) while `gh release list` lists everything, so electron-updater's dev channel
gets `undefined` and throws. And when the list does answer, the newest release is often one this
platform cannot install, and nothing in its loop looks at the release BELOW the newest.
`pickRelease` cannot be reused, because it reads the same broken list.

So the dev channel stops asking GitHub's API to choose: tags come from `gh release list`, each is
asked directly whether it carries a `latest.yml` (one public download request, no token, no API),
and the feed is pinned to the first that does with the **generic** provider. There is then no list
to be empty and no prerelease flag to interpret, so `allowPrerelease` is stood down under a live
pin. Every failure leaves the feed exactly as it was. `PF_NO_WIN_PIN` exists only so
`test:blindlist` stays about the blind list. `npm run test:winfeed`.

## Why the app quit

Electron never says what triggered a quit. Every path that quits on purpose now names itself —
`quitting(...)` in `main/index.ts`, from the single-instance loser, the unopened test copy, the
handoff receiver, the idle clock, an update install and the admin relaunch — and `before-quit`
writes that name to `updater.log` with the pane count. A quit that leaves it empty logs `nothing
in the app asked`.

**That sentence named three possibilities and separated none.** A signal cannot be caught
(Chromium takes SIGTERM below the JS layer, measured), but the three are told apart by **where the
screen was**: a Cmd-Q or app-menu Quit can only be typed at a frontmost window, while `pkill`,
`osascript ... quit`, a launchd job and a logout all arrive while somebody is looking elsewhere.
`shared/quitWords.ts` turns the last focus into that sentence. It is evidence and never a verdict —
the useful half is the negative, "this did NOT come from this keyboard". `FROM_KEYBOARD_MS` is a
generous 4s because Cmd-Q blurs the window a beat before `before-quit` runs.
`npm run test:quitwords`.

## Gotchas that look like mistakes

- `package.json` `description` is the bare word "PaneForge" — electron-builder writes it into the
  exe's FileDescription, which is the name Windows Task Manager shows.
- `package.json` `name` stays `claude-orchestrator` — Electron builds `%APPDATA%\<name>` from it.
- The icon is **generated**: `node scripts/make-icon.mjs` writes `icon.png` / `icon.svg` and
  `build/icon.png`, so the `.ico` and `.icns` need no configuration. Do not check in a blob — there
  is no ImageMagick and no sharp on this machine. `--size N --out path` renders any single size.
  The gap between panes is 0.043 of the canvas because that is what still reads as three panes at
  24px.
- `git status` for the pane badges must stay async (`execFile`, never `spawnSync`) — a blocked main
  process is the Windows busy cursor.
- `.github/workflows/` edits need `workflow` scope on the gh token
  (`gh auth refresh -h github.com -s workflow`); without it the push is rejected after `lane.mjs`
  has already tagged the release.

## Checking a layout change without screenshots

```
npm run build                    # --keep SKIPS the build; without this you measure the last one
npm run try -- --keep --remote-debugging-port=9333
npm run probe -- --height 560 "(() => { const r=document.querySelector('.dialog').getBoundingClientRect(); return { fits: r.bottom <= innerHeight } })()"
npm run try -- --close
```

A probe answering exactly what it answered before your edit is the tell that nothing was rebuilt.
The port is per checkout — a second lane probes with `PF_PORT=9334` and launches with the matching
flag. `--height`/`--width` drive Chromium's device metrics override and put the size back
afterwards. The expression is evaluated in the renderer with `awaitPromise`, so an async arrow that
clicks through a dialog and then measures works as one argument. `window.__pf[sessionId]` gives a
pane's live `term` and `fit`.
