# PaneForge

Electron app that hosts coding agents in panes. It hosts the chat you are reading this in,
which shapes every rule below.

**Every rule here is the short form.** Why each one exists — the measurements, the traps,
the hours they cost — is in `docs/design-notes.md`, one section per heading below, same
titles. Read that section before CHANGING the thing; the rule alone is enough to work
beside it. Do not re-derive a decision it already records.

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

One engine drives every repo on the machine, not just this one — `lane.mjs --repo <dir>`.
Per-repo config is `.lanes.json` in the repo root, every field optional:

```json
{ "lanes": false, "branch": "main", "release": "merge", "pool": ["main", "a"] }
```

`release` defaults to `"merge"` everywhere except here (merge finished lanes into the
repo's branch and push, never cut a version). This repo's `.lanes.json` says `"version"`.
A repo with no remote, and `claude-memory`, never get lanes. Never leave a lane sitting in
a conflicted merge — it is the one state no other chat is allowed to touch.

`npm run test:lanes` covers the engine, the sweep that deletes worktrees, lane ownership,
and the any-repo contract (a repo that never asked for releases must never cut a version).

## Releasing happens by itself

One command, and it is not a release:

```
node scripts/lane.mjs ready --repo <dir> --session <id>   # this lane is done and verified
```

`ready` merges master into your lane first, refuses to mark anything while that merge is
dirty, then releases once **no chat is mid-work** — one version bump for everyone, whoever
finishes last. If another chat is still editing it says so and does nothing; wait rather
than shipping again. Edit or commit after marking and the mark is dropped, by name.

- **Below 1.0 an automatic release only ever moves the patch.** It still reads its own bump
  off the commit subjects since the last tag (`bumpFor` in `scripts/release-notes.mjs`, the
  same source the notes come from), but `nextVersion` in that file demotes it: a `feat:` is
  a patch like everything else, `feat!:` is the one bump a commit may still ask for and it
  gets a minor, and a minor or a major otherwise has to be typed — `node scripts/lane.mjs
  ship minor` / `ship major`. Reading `feat:` as a minor is right for a released product and
  wrong here: below 1.0 nearly every commit adds something, so the minor stopped meaning "a
  batch of work landed" and started meaning "a session happened" (v0.4.62 → v0.8.0 in one
  day over six releases carrying seven commits). At 1.0 the ordinary semver reading comes
  back on its own. A bump named on the command line is always obeyed as given.
- Releases batch: one per 30 minutes (`COOLDOWN_MS`). Inside that window the work sits on
  master for the next `ready`. Do not "fix" that with `npm run ship`.
- `npm version`, `git tag vX` and pushing a version tag by hand are **blocked**.
  `npm run ship` exists for a build Robert needs in his hands now — say why.
- Two things stop a release, both reported by name: master not typechecking, and a lane
  conflicting with master. A conflicting lane is left out; the rest still goes out.
  `rerere` is on, and the retry timer re-tries recorded conflicts every minute.
- Release notes come from Conventional Commit subjects between version tags
  (`scripts/release-notes.mjs`, template `.github/release-notes.md`). `npm run test:notes`.
  **Only `feat:`, `fix:` and `perf:` reach the page** — the release body is public and is
  read by somebody deciding whether to take the update, while a `docs:` subject here is
  written for the next session in this repo. Everything else, and every subject with no
  conventional prefix, is dropped; a release carrying only those falls back to the
  commit-history link rather than heading an empty section. There is no catch-all
  heading, and adding one back is what made the pages read like a diary.
- Actions and this machine can BOTH publish a release. The duplicate installers are
  harmless; `latest.yml` is not, because the loser's feed names the winner's file.
  `reconcileFeed` on the retry timer compares the feed to the asset it names and puts ours
  back. Never hand-fix a feed without checking the asset's real size — v0.4.27 shipped
  33 bytes out and looked perfect. Until v0.4.32 it happened on EVERY release and the
  stated cause — "the 45s poll missed a run that was merely slow" — was wrong: the poll
  never worked at all. Its `?event=push&per_page=10` went through `shell: true`, where cmd
  reads the `&` as a command separator, so it ran as two commands and reported the second
  one's failure. `runSafe` quotes its arguments now (`cmdQuote`); `npm run test:laneargs`
  round-trips them through a real cmd.exe. Assume nothing about an argument.

**A release claims the thing is finished.** Never cut one while any next step for that
issue is still open.

## An update may never need a person

Install once, update from the app, for ever. **A user reinstalling PaneForge by hand is a
defect**, and the only bug class that has ever caused it here is one shape: a promise that
never settles behind a flag saying "already working on it".

- **The recovery may not live inside the thing that can hang.** Settling every path in our
  own download code fixes one promise and leaves the shape; `electron-updater`'s check and
  download are not ours to settle at all. So a transient phase carries `phaseAt`, and
  `busy()` — which every path asks before starting over — drops one that has outlived its
  budget, whatever wedged it. `CHECK_BUDGET_MS` 2min, `DOWNLOAD_BUDGET_MS` 45min,
  `PROBE_BUDGET_MS` 5min, all overridable by env so the test takes 150ms.
- **The poll is armed BEFORE the await as well as after it.** `arm()` from `finally` alone
  meant one hung turn ended the background poll for the life of the process — nothing was
  left to notice the wedge or undo it. `POLL_WATCHDOG_MS` 6min; a healthy turn's `finally`
  replaces it, so nothing polls faster than it did.
- **On the way out, the disk beats the badge.** The quit swap is gated on a staged bundle
  existing and being newer (`stagedInstallable()`), never on `phase === 'ready'`. A phase is
  a live flag a stalled download can hold for ever; a staged bundle is a fact.
- `update-health.json` holds the last time the feed answered and every recovered wedge.
  An empty `updater.log` is evidence, not an absence of it — three days without a good
  check logs `health STALE`.
- `npm run test:updater` (its second half is `npm run test:wedge`) hangs the stub on
  purpose and proves each of those recovers unattended.

## Never take the screen

The app runs all day beside real work. Nothing it does on its own may take focus, raise a
window, or pop a dialog. Only a click or a hotkey earns the foreground.

- `showInactive()` for a window nobody asked for. `focusWindow()` is user-initiated only.
- `revealPlan()` in `src/main/profile.ts` decides the launch reveal per platform. A
  self-decided restart (update, admin relaunch) calls `markQuietRelaunch()` first; the new
  process consumes that marker, starts inactive and flashes the taskbar button.
- No `dialog.showMessageBox` for anything the app decided itself — in-renderer cards
  (`UpdateToast.tsx`). No `setAlwaysOnTop`, no `moveTop`, no `app.focus`.
- Every `spawn`/`Start-Process` keeps `windowsHide: true`. A console flash is a focus steal.
  (On this PC that flag is ignored for detached console spawns — wrap in `run-hidden.vbs`.)
- `second-instance` must not raise the window while `installStarted` is set: mid-update the
  installer's launch of the new exe arrives on that event.
- Game mode may DELAY the window, never lose it. `gameMode.ts` asks the foreground window's
  process directly at the launch reveal and for already-deferred work, so alt-tabbing out of
  a game is enough. That query costs ~600ms, which is why the 15s poller still uses
  `tasklist` and this is asked only while something is held.
- `npm run test:quiet` pins both halves of the reveal, and SKIPS out loud when a real game
  is on screen.

## Two machines, one desk

`src/main/remote/` lets a second device drive this one's panes. Both ends are peers — each
can host and each can connect out. Three decisions not to re-litigate:

- **The pty never moves.** A mirrored pane's agent, checkout, transcript and worktree stay
  on the device it was opened on. Remote control, not migration. Session ids are the seam:
  a mirrored pane is `@<device>/<id>`, and `remote.owns(id)` in `main/index.ts` routes every
  pane message to the link instead of the pty manager.
- **The host owns the terminal's size.** A mirror draws at the far end's cols/rows
  (`Session.cols/rows`) and shrinks its own font. Two windows sizing one pty trade
  SIGWINCHes forever.
- **A mirror never reports the busy footer**, and **frames are decoded where they are
  consumed**, never where they arrive (the last handshake frame and the first encrypted one
  routinely land in one TCP segment).

The pairing code is never sent, only proved; traffic keys derive from it (scrypt, then
AES-256-GCM per direction), so rotating it cuts every paired device off. Hosting is off
until switched on; discovery is a UDP broadcast carrying no secret. `npm run test:remote`.

**Pairing can also be a button, and then the six digits are the authentication.** Tap a
discovered device and it asks; the other machine raises a card and both screens show six
digits derived from an X25519 exchange that binds BOTH public keys — so a machine relaying
the exchange holds two secrets and cannot make the numbers agree. The person compares them;
the button on its own proves nothing, which is why the card leads with the number and not
with the device name (anybody on the network picks their own name). On Approve the host
seals the ordinary pairing code to that secret and the joiner reconnects through the normal
path, so stored peers, reconnects and `New code` are untouched. `PROTOCOL` stays 1: an
older build does not recognise `askpair` and refuses, which is correct — it has no card to
show. `npm run test:pairask`, whose load-bearing case is a real relay proving the two
numbers differ.

## The phone is this window, served

There is no second app. The renderer imports nothing from Electron and nothing from Node -
it is pure UI over `window.api` - so a phone client is that object over HTTP:
`src/main/phone.ts` serves the built renderer, `renderer/src/browserApi.ts` supplies the
object, and **`src/shared/surface.ts` is the ONE list** both transports are built from,
typed `{ [K in keyof Api]: SurfaceEntry }` so a method with no channel does not compile.
Never add a channel to a transport; add it there. The preload is 38 lines and names no
channel of its own.

- Calls land in the app's own `ipcMain` body via `src/main/ipcTap.ts`, so `tapIpc()` MUST
  stay at the top of `index.ts`, above every registration.
- Events go down one SSE stream; `phone.broadcast` sits **ahead** of the window check in
  `send()` so a minimized window does not starve a phone. `send`s are queued client-side
  because they are ordered.
- **Off by default, and it stays that way.** Serving grants a browser a pane, which is
  commands on this machine. Unpaired gets the pairing page and not one asset; five wrong
  codes locks that address for a minute. The cookie is `hmac(deviceId, code)` - derived,
  never stored - so rotating the code signs every phone out.
- **Pairing is a camera, not a keyboard.** Settings draws `<address>/#<code>` as a QR
  (`shared/qr.ts`, no dependency, byte mode / level M / versions 1-6) and the pairing page
  posts a code it finds in the fragment. A **fragment** because a browser never sends one
  to the server: the code stays out of the access log and out of every `Referer`. The
  typed field is still there for a phone with no camera. OAuth and email were considered
  and refused - both move the secret through a third party and off this network to save
  six keystrokes on a link that is otherwise entirely local.
- **The panel says who is watching, never who is paired.** The cookie is derived, so every
  phone that ever typed the code holds the same one and there is no per-device identity to
  keep — which means there can be no per-device sign-out, and a `Disconnect` button beside
  a row would be a lie (the stream returns at once, the cookie is still good). `New code`
  is the only revoke and it takes all of them. Each row leads with **where the browser came
  from** (`originOf` in `shared/net.ts`), because "somebody is watching" reads one way for
  a phone in this room and another for an address off the internet. The same function
  labels each offered address with what it reaches, so the panel can never promise
  "works anywhere" for an address the server would then mark "this network".
- **A way in from anywhere is `cloudflared`, and the URL is not the claim.** `main/tunnel.ts`
  runs a Cloudflare quick tunnel so a phone on any network reaches this desk with no
  account, no VPN and nothing installed on the phone. Tailscale is the wrong answer to
  ship: it needs an account, an app on the phone and an install on the desk.
  - **Never look the hostname up before the tunnel has registered.** `*.trycloudflare.com`
    is not a wildcard, so an early query gets NXDOMAIN and the resolver **caches it** —
    measured 40 unbroken seconds of `getaddrinfo ENOTFOUND` while 1.1.1.1 had been
    answering since t=8s, against an instant resolve on the next run that waited. The
    tunnel was healthy both times. Hence the `Registered tunnel connection` gate.
  - `up` is set by a real HTTPS request coming back with this desk's own bytes, never by
    the URL line appearing. Measured: hostname 3–6s, public DNS 8–13s, first 200 ~1s later.
  - Everything cloudflared says is on **stderr**; its stdout was 0 bytes on every run.
  - Turning it on **lengthens the pairing code to 14** and signs every phone out. Six
    characters is a LAN number: 387M combinations, and on a public address the per-address
    lockout stops mattering because attempts come from as many addresses as the attacker
    likes. Nobody types it — the QR carries it — so the longer one costs nothing.
  - The binary is downloaded once (19–54 MB), never bundled, through a `.part` name and a
    rename. Quitting kills it — it is not a pty, so `strays.ts` has never heard of it.
  - `npm run test:tunnel` drives all of it against a stub that prints what the real program
    prints, with every budget overridable by env.
- **A phone is not a small desktop.** Under 720px the list and the panes take turns
  (`handheld.ts` + one `@media` block); the list is the home screen and a tapped pane gets
  the display. `display: none`, never a 0px xterm.
- The pty never moves, same as Devices.
- `npm run test:phone` (server + surface parity, no browser). `npm run test:phoneview`
  needs a running copy: `npm run build && npm run try -- --keep --show`, then
  `node scripts/phone-view-test.mjs --port <port> --code <code>`. A pane's text is in
  `window.__pf[id].term.buffer`, never in the DOM - xterm draws to a canvas.
- Not built: headless host (B1 - the app must be running), phone-first diff (H2).

## Every colour is derived, and every pane says which project it is in

**There is no palette.** `src/shared/theme.ts` computes one from a single accent;
`applyTheme` writes it as CSS variables onto `:root`. The literals in `styles.css` are the
~40ms fallback before a config loads, not the source. Adding a colour means adding it to
`paletteFor`, never to a component. The maths is Oklab — hue and chroma held while
lightness sweeps, `inGamut` binary-searching the chroma that fits — because per-channel RGB
clamping hue-shifts rather than desaturates. **Light themes live above ~0.9 on the depth
slider**; Paper is 0.98. Default accent `#f0a868`; the sidebar mark is the icon's own
geometry in `currentColor`. `npm run test:theme` is 358 assertions whose load-bearing half
is contrast: 4.5:1 body and 3:1 secondary, for every preset and every hue at full tint.

**The floating Stash is a second window and it obeys the same law.** It keeps its own
rules (`shelf.css` — 140KB of app CSS to draw a 172x38 pill is the thing being avoided)
and takes its colours from `applyTheme`, called there exactly as in the main window. Two
shapes the palette does not supply: `--acc-rgb`, the derived accent as a triplet, because
eight rules want it at an alpha and `rgba()` of a hex is dropped in silence — and the
`light` class on `:root`, off the luminance of the derived `--bg`, because *light or dark
is the depth slider's answer and never the operating system's*. `npm run test:stashtheme`
refuses a colour literal anywhere in that file outside a `var()` fallback.

**Every pane says which project it is in.** `src/shared/place.ts` is the only thing allowed
to turn a folder, a branch, a worktree suffix and a lane id into words.

- The project name is never omitted and never abbreviated; everything else is added only
  when it is not implied. One pane, one repo, trunk → `PaneForge` and nothing else.
- A trunk branch is answered ("main checkout"), not hidden. A branch some tool generated to
  hold a copy (`pf/w2`, `lane-a`, Claude Code's `worktree-<slug>`) is dropped — it repeats
  the copy's own number.
- Two numbers, worded apart on purpose: `copy 2` is the second checkout of that project,
  `pane 3` is the third card in the sidebar and Ctrl+3 reaches it. They are independent.
  Only the pane number is a keystroke, and only chats are named by it.
- `-a` is stripped only when the caller already knows the folder is that lane — `service-a`
  is a real project name. Only `-w<digits>` comes off unasked.
- The sidebar has no `git status` of its own on purpose, so it may not assert "not a git
  checkout": an absent fact and a known-negative fact are not the same thing.
- `npm run test:place` is 56 assertions on the strings themselves.

## What a pane leaves running

Quitting kills each pty with `taskkill /F /T <pid>`, a walk over live `ParentProcessId`
links at the moment of the kill. Two ordinary things sit outside it and `src/main/strays.ts`
is both: an orphan whose middle process exited (with that row gone there is nothing joining
the pty to the leaf, so `npm run dev` leaves vite behind), and the app dying without running
`shutdown()` at all. Neither link is recoverable afterwards, so a sampler walks each live
pty's descendants every 30s into `strays.json` under userData, keyed by the app run that
owns it. Closing a pane, quitting and the next launch all kill from that ledger.

- **A pid is never enough.** Every record carries the process's creation time, re-checked by
  whatever does the killing — a ledger written before a reboot names pids a browser now has.
- **A run whose app is still alive is somebody else's** — usually the `npm run try` copy.
- **Nothing here may block the main process.** Every process-table read is `execFile`; the
  two paths that cannot wait (a pane closing, the app exiting) hand the pids to a detached
  script instead of reading the table at all.
- It never asks what the pane is RUNNING — a per-CLI hook would be out of date the day a
  new agent ships, and silent in the crash case. POSIX needs almost none of this (node-pty's
  child is a session leader, so one `kill(-pid)` reaps the group).
- `npm run test:strays` spawns real orphans and takes ~25s. It loads the real
  `spawnDetachedNoWindow`; stubbing it with a plain detached `spawn` makes every kill
  silently do nothing.

## A reopened pane comes back with what was on its screen

The terminal's own scrollback is renderer memory, so before this every pane reopened blank —
most often right after the app updated itself, which is the restart nobody asked for.
`test:restore` is a different promise: it hands the agent its `--resume`, which brings back
the conversation and not one line of the screen.

- **Nothing new is stored.** `history.ts` has appended every pane's raw output to
  `userData/history/<id>.log` all along; `tail()` reads the last `BUFFER_LIMIT` of it, and
  the cap and the pruning are that file's, already pinned by `test:history`.
- The missing part was the **id**. A restored pane is a new session, so the desk carries
  `scrollbackId` (`snapshot()` in `sessions.ts`) and `start()` seeds the pane's buffer from
  it. Save the new id there and it restores nothing, silently, forever.
- `tail` must not strip ANSI (`read` does, for search) and must cut on a line boundary — a
  cut inside an escape sequence prints its tail as literal text across the first line.
- One dim line says where the old output ends, and it resets attributes first: the tail is
  cut mid-run, so whatever was in force at the cut would otherwise bleed into everything
  after it. `npm run test:scrollback`.

## The app remembers what has been asked

`src/main/promptArchive.ts` answers one question — has this ask been made before — and it is
fed from `shared/draft.ts`, on the way to the pty, **not** from any CLI's hook. That is the
whole reason it works: Claude Code can already warn itself, Codex cannot, and neither can the
next agent on the list of thirteen. Reading the bytes means every agent is covered, including
ones that do not exist yet.

- **It never blocks, never types, never cancels.** A repeat is often deliberate. All that
  happens by itself is a chip in the pane's corner, on the same contract as Improve beside
  it, and being wrong therefore costs a glance.
- The quiet window (`QUIET_MS`, 6h) is load-bearing, not the score: a reworded re-send two
  minutes later is the SAME work — a retry, a follow-up — and warning there is what would
  make somebody switch the feature off.
- Only submitted lines are archived, never drafts, and only a capped preview plus the token
  set — never the full text.
- **`src/shared/promptKey.ts` is a MIRROR of an algorithm that lives in three places outside
  this repo** (Robert's `claude-memory` hook, the TaskDriver archive server, the Discord
  bot), which share one archive. Editing one copy splits that archive in silence — no error,
  just a lookup that quietly stops finding things. `npm run test:recall` recomputes the
  canonical file's answers and asserts ours agree, and **skips out loud** when that file is
  not on the machine.
- Not built yet, and the UI does not pretend otherwise: nothing watches a pane's repo for the
  commit an ask turned into, so `outcome` is null for everything this app records. The
  outcomes that do appear come from an external archive that already stamps them.

## Dictation needs nothing installed

The mic on every pane, and Ctrl/Cmd Shift Space into the focused one. `shared/voicePick.ts`
picks between three transcribers and `useVoice.ts` falls down them when one fails:
a **whisper CLI on PATH** when there happens to be one (fastest, offline, never demanded),
otherwise **Whisper in a worker in this window** (`voiceWorker.ts`, ONNX Runtime wasm,
nothing to install), and on a phone **the browser's own recogniser** (instant, no
download, and the only one that sends audio off the device).

- **Feature-detecting `webkitSpeechRecognition` is not enough.** In Electron the
  constructor is there and every session ends `error: "network"` - no Google key in an
  Electron build. `browser` is gated on not being Electron.
- **The 8-bit weights do not run.** `q8`/`int8`/`uint8` download and then fail with
  `TransposeDQWeightsForMatMulNBits / Missing required scale`. `bnb4` is the smallest
  that works and is what ships; `shared/voiceModels.ts` carries the sizes.
- **The wasm ships with us**, copied by `electron.vite.config.ts`, which also deletes
  the 23.5 MB asyncify binary vite emits and the worker never asks for.
- **Nothing on the page may import the worker's module** - one constant took the main
  chunk from 1.01 MB to 2.23 MB. Constants live in `shared/voiceModels.ts`.
- **A phone is not a small desktop.** Touch, or under 720px, and dictating takes the
  whole screen (`VoiceOverlay.tsx`); the ring IS the input level, so a mic nobody is
  hearing shows it by not moving. It also appears while the model downloads.
- `npm run test:voice`.

## The app can run a lane itself

`docs/agentic.md` is the plan; I1–I4 of it are built. A lane the app drives is a **headless
CLI whose `stream-json` we parse** (`shared/agentic.ts`), never a pty scraped by
`readsBusy()`. Panes stay ptys. It produces a branch and a diff and **merges nothing** —
`lane.mjs ready` is still a person's word.

- **A run that changed nothing is a failure**, not a pass. The gate's first step is the
  diffstat and `noOp` calls two lines or fewer nothing. Same rule for a CLI that exits 0
  having printed nothing: that is `silent`, not `done`.
- **`diffSince` runs `git add -A --intent-to-add` first.** Without it `git diff` cannot see
  a file the agent created and never added, and a lane whose deliverable is one new file
  reports itself as idle.
- **The gate is diffstat → typecheck → suite → reviewer**, cheapest first. A missing step
  says *skipped*; it never reads as a pass. `parseVerdict` fails closed — a reviewer that
  crashed or answered prose has not passed the lane.
- **The reviewer runs in an empty directory**, not the lane: it is started with the same
  permissions as the agent it judges and would otherwise be able to edit the branch to
  agree with itself.
- **The retry prompt is a local, never the lane's `note`** — `note` is the board's line and
  every tool call overwrites it.
- The budget timer is armed before the first await, not in a `finally`. Two retries then
  stop. Three lanes at a time, 900ms apart.
- **The app says what a driven lane may do, and the words are derived from the arguments
  it passes.** Every entry in `HEADLESS` starts its CLI with the permission prompt off, and
  that is deliberate — an agent that stops to ask is one that hangs until its budget kills
  it. `unattended()` finds the flag in the args we really send, so the chip on the board,
  the line above Drive and the refusal all name the same string the process carries; make a
  posture stricter and every one of them falls silent rather than claiming otherwise.
  `driveUnattended` in config may refuse the whole thing, by name, at both doors
  (`drive:start` and `goal:add`). `npm run test:unattended`.
- **Quitting kills the driven agents** (`stopAllDrives`, on `before-quit` AND `hardExit`).
  They are detached, in their own process group, and are not ptys — `strays.ts` has never
  heard of them, so without that line the app leaves an agent editing a worktree with
  nothing left to stop it.
- **A goal outlives the window** (I4, `main/goals.ts` + `shared/goals.ts`). Drive it queues
  one rather than starting it on the spot: it is in `goals.json` under userData, written
  through a temp file and a rename, and **one runs at a time** — a second press lines up
  behind the first instead of handing two runs the same worktree pool.
  - **A goal caught running by a restart is `interrupted`, never `done` and never re-run
    by itself.** Its agents died with the process, so the branch holds whatever had been
    written by then; calling that a pass puts unread work on a board saying "ready to
    review", and re-queueing it starts a second agent over a worktree nobody has looked at.
    Retry is a press.
  - **The queue is what finally fills `promptArchive`'s `outcome`.** `recordOutcome` stamps
    the row an ask already has — `<repo> <branch@sha> verified, N files` — and never
    creates one, because that archive is fed from bytes on their way to a pty and a mission
    typed into a dialog is not one of those.
  - One lane throwing may not take the run with it: `driveLane` is wrapped, and before that
    a malformed plan reached `void drive(...)` as an unhandled rejection that killed every
    other lane and left them reading `working` for ever.
- `npm run test:agentic` spawns real stubs into real repositories, including one that hangs
  and must be killed and one that fails its own gate and then fixes it. No CLI needed.
  `npm run test:goals` does the same for the queue: a goal read back after a simulated
  kill, and a second goal that starts because the first one ended.

## Checks

`npm run typecheck` before committing, and `npm test` — 43 checks in ~50s, everything
below that needs no window, no network and no real agent CLI (`scripts/test-all.mjs`).
It is also the gate's third step: `agentGate.ts` looks for a script called exactly
`test`, and while there wasn't one every lane the app drove reported its suite step as
*skipped*. A new cheap test goes in that list or it never runs by itself.

| Command | Covers |
|---|---|
| `npm run smoke` | the pty layer |
| `npm run test:restore` | which conversation a reopened pane goes back into |
| `npm run test:scrollback` | and what is on its screen when it gets there |
| `npm run test:consoles` | sweeping console hosts left behind |
| `npm run test:strays` | what a PANE left running (real orphans, ~25s) |
| `npm run test:gitpoll` | the badge's `git status` cache, over a fake clock |
| `npm run test:install` | quitting takes the install pty's whole process tree |
| `npm run test:lanes` | lane engine, worktree sweep, ownership, any-repo release contract |
| `npm run test:laneargs` | what `runSafe` hands a program, through a real cmd.exe |
| `npm run test:notes` | release-note ranges and both template shapes |
| `npm run test:remote` | the device link end to end over a real loopback socket |
| `npm run test:pairask` | pairing with no code typed: the six digits agree between the two ends, and — the case the whole design exists for — a real relay in the middle makes them DISAGREE |
| `npm run test:theme` | palette derivation + contrast (358 assertions) |
| `npm run test:stashtheme` | that the floating Stash picks no colour of its own, and asks the theme rather than the OS which way round it is |
| `npm run test:sounds` | the alert catalogue: nothing silent, nothing clipping, uploads |
| `npm run test:blurbs` | the "what this is" note on each feature, and that each is rendered |
| `npm run test:place` | the words a pane's strip prints (56 assertions) |
| `npm run test:diff` | reading a repo's changes: `-z` records, renames, patch numbering |
| `npm run test:railplace` | where a prompt tag is drawn: never off the rail, never far from the thumb it points at (no window) |
| `npm run test:grid` | layout arithmetic, no window needed |
| `npm run test:split` | task splitting; overlapping file claims are REFUSED, never repaired |
| `npm run test:agentic` | the app driving a lane: a hung turn killed by its budget, a run that changed nothing refused, a failed gate retried |
| `npm run test:goals` | the queue that outlives the window: a goal read back after a kill, the next one starting by itself, `outcome` stamped |
| `npm run test:unattended` | that the app says what a driven lane may do: every agent in `HEADLESS` has a nameable permission flag, the words are DERIVED from the arguments the run carries, and a stricter posture silences the claim instead of keeping it |
| `npm run test:cursorclick` | Alt-click placing the CLI's cursor: the keys it sends, and the clicks it refuses to answer |
| `npm run test:onestash` | that there is one Stash: the overlay is a pill while the window is showing the list |
| `npm run test:phone` | the phone client's server: nothing served before the code, calls landing in the app's own handlers, bytes surviving JSON — and PARITY, that one list feeds both transports and every line of it has a handler |
| `npm run test:tunnel` | the way in from anywhere: a URL that never resolves is never called up, a cloudflared that says nothing or hangs settles anyway, and the per-platform asset names a wrong guess would 404 on |
| `npm run test:qr` | the pairing QR, by DECODING it: format bits, zig-zag, de-interleave, every Reed-Solomon syndrome zero, payload back out — every version at every mask. Nothing less catches a symbol that is drawn perfectly and reads nowhere |
| `npm run test:stash` | what the Stash may cost — no list leaving main carries a body; and what follows from that: search runs in main (a word past the preview is still found) and an edit keeps its row's place, its pin, and no second row saying the same thing |
| `npm run test:conceal` | what the Stash may not remember: the copying app's concealed marker, and the user's own deny rules. Markers only — never a built-in guess at secret SHAPES, because copying an API key to paste it at an agent is an everyday move here |
| `npm run test:pipe` | the live tee; ANSI stripping across chunk boundaries |
| `npm run test:copymode` | keyboard copy mode arithmetic |
| `npm run test:silence` | the quiet-turn alert; an idle pane is NOT stalled |
| `npm run test:discord` | Rich Presence against a fake Discord over a real named pipe |
| `npm run test:improve` | prompt improvement, model-free (incl. the exact typed byte stream) |
| `npm run test:voice` | dictation: which transcriber, and a spoken clip through it |
| `npm run test:recall` | "you have asked this before" — and PARITY with the canonical fingerprint |
| `npm run test:rename` | the folder rename, on a throwaway repo |
| `npm run test:dock` | the macOS Dock icon (no `visibleOnFullScreen` without the skip) |
| `npm run test:macupdate` | the app replacing its own bundle |
| `npm run test:macdownload` | every way a mac download can end — none of them a hang |
| `npm run test:wedge` | that no hung promise can leave the updater needing a person |
| `npm run test:history` | what transcripts may cost: the age cutoff and the size cap |
| `npm run test:macsign` | the signing that stops TCC resetting permissions every release |

Needing a real window up (`npm run build && npm run try -- --keep --show
--remote-debugging-port=9333`): `test:view` (grid + find bar), `test:stashdrag`,
`test:activate`, `test:improveview`, and `test:phoneview` (a real headless Chrome at
414x896 against that copy — it skips out loud with no Chrome and no server).

Out of the default suite on purpose because they need the network: `test:discordbrand`,
which asks Discord what the shipped `DISCORD_APP_ID` is called AND whether it still has
the art asset `PRESENCE_IMAGE` names — it passes now, and the two halves fail separately,
because a correct name with no asset is a card with no logo on it; and
`node scripts/mac-update-test.mjs --live <version>` (~120 MB).

The research pipeline's gate is `npm run test:research`, and
`scripts/capability-ingest.mjs` is the ONLY door into the catalogue — see
`RESEARCH-POLICY.md`. That pipeline researches *techniques*; the other agent-runners are
watched separately by `npm run competitors` (`npm run test:competitors`), which diffs the
repos in `competitors.json` against the checked-in `docs/competitors.state.json` and prints
only what moved. It is deliberately quiet: sub-5% star drift says nothing, and a changed
README is the one line that means go re-read a feature list into `TODO.md`.

## Gotchas that look like mistakes

- `package.json` `description` is the bare word "PaneForge" — electron-builder writes it
  into the exe's FileDescription, which is the name Windows Task Manager shows.
- `package.json` `name` stays `claude-orchestrator` — Electron builds `%APPDATA%\<name>`
  from it, so changing it moves the installed app's config, workspaces and instance lock.
- The icon is **generated**: `node scripts/make-icon.mjs` writes `icon.png` / `icon.svg` and
  `build/icon.png` (electron-builder's buildResources default), so the `.ico` and `.icns`
  need no configuration. Do not check in a blob — there is no ImageMagick and no sharp on
  this machine. `--size N --out path` renders any single size. The gap between panes is
  0.043 of the canvas because that is what still reads as three panes at 24px.
- `git status` for the pane badges must stay async (`execFile`, never `spawnSync`) — a
  blocked main process is the Windows busy cursor.
- `.github/workflows/` edits need `workflow` scope on the gh token
  (`gh auth refresh -h github.com -s workflow`); without it the push is rejected after
  `lane.mjs` has already tagged the release.

## Checking a layout change without screenshots

```
npm run build                    # --keep SKIPS the build; without this you measure the last one
npm run try -- --keep --remote-debugging-port=9333
npm run probe -- --height 560 "(() => { const r=document.querySelector('.dialog').getBoundingClientRect(); return { fits: r.bottom <= innerHeight } })()"
npm run try -- --close
```

A probe answering exactly what it answered before your edit is the tell that nothing was
rebuilt. The port is per checkout — a second lane probes with `PF_PORT=9334` and launches
with the matching flag. `--height`/`--width` drive Chromium's device metrics override and
put the size back afterwards. The expression is evaluated in the renderer with
`awaitPromise`, so an async arrow that clicks through a dialog and then measures works as
one argument. `window.__pf[sessionId]` gives a pane's live `term` and `fit`.
