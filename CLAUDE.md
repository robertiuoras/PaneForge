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

A chat visiting from another project (home read off its transcript path) gets a letter
lane, never `main`, unless `main` holds uncommitted work to protect. A `Stop` hook runs
`lane.mjs park` when a turn ends: clean holds are marked, and a parked `main` is handed
to a chat that needs it after 10 minutes - instantly when the holder was a visitor. A
claim by the parked chat clears the mark. `npm run test:lanes` includes
`visitor-park-test.mjs` for all of it.

One engine drives every repo on the machine, not just this one — `lane.mjs --repo <dir>`.
Per-repo config is `.lanes.json` in the repo root, every field optional:

```json
{ "lanes": false, "branch": "main", "release": "merge", "pool": ["main", "a"] }
```

`release` defaults to `"merge"` everywhere except here (merge finished lanes into the
repo's branch and push, never cut a version). This repo's `.lanes.json` says `"version"`.
**The lane chip opens the answer to "what is all this", not just to "merge?".** `LaneDialog`
leads with a plain sentence about folders (the git line `lane-a → main` is below it, for the
reader who wants it) and then lists **every copy of that project on this machine** - the trunk
and each lane - with who has it (a pane number, which is also the Ctrl key that switches
there, and the row switches on a press) and **what it is doing**: the files it has
uncommitted right now and its newest commit's subject, both free and already in the
repository. That list is why two chips on one card (`main checkout`, `lane a`, `lane b`) read
as one pane holding two lanes: they are separate copies of one project and nothing said so.
It is built from BOTH sources on purpose - `lane.mjs`'s ledger, and the panes in this window -
because a lane the app made itself (`main/lanes.ts`, on the second pane in one project) has no
ledger row at all, which a probe hit as an empty list. `laneDoing` in `renderer/src/laneWords.ts`
is the words and is pinned by `npm run test:lanes`' holder test; a lane with neither commits
nor edits says nothing rather than inventing a sentence about somebody else's work.

A repo with no remote, and `claude-memory`, never get lanes. Never leave a lane sitting in
a conflicted merge — it is the one state no other chat is allowed to touch.

`npm run test:lanes` covers the engine, the sweep that deletes worktrees, lane ownership,
and the any-repo contract (a repo that never asked for releases must never cut a version).

## Two desks, one repository

The ledger above is one machine's: `<repo>/.git/paneforge-lanes.json`, never pushed and
never fetched. That is right for nearly all of it. A letter lane is a worktree on a branch
(`lane-a`) that is **local scratch** and is never pushed either, so this desk's `lane-a`
and the other desk's `lane-a` are two unrelated branches in two folders on two disks. They
cannot collide, and coordinating them would cost a network round trip per prompt to
prevent nothing.

Exactly two things collide across devices, and both are the trunk. `main` is not a lane
like the others - it IS the repository, on the branch everybody shares - so two desks
holding it are two chats pushing one branch with neither ledger able to see the other.
And two desks cutting a release is two tags, two GitHub releases and the one-legged feed
this repo has already shipped once.

- **A claim is carried by the ref NAME**, under `refs/paneforge/claims/<device>/<slot>/
  <session>/<millis>`, pointing at a commit origin already has. Reading every device is then
  one `ls-remote` with no fetch and not one object transferred, which is what lets this sit
  in front of a lane claim. Measured against this repo's real origin: a re-claim (the path
  that runs on every prompt) is **0.09-0.11s and touches the network not at all**, because
  a chat that already holds its lane returns long before any of this.
- **Only the trunk asks, and only a chat that does not already have it.** A letter lane
  never publishes and never reads. `PEER_STALE_MS` is 45 minutes: a desk that was switched
  off must not hold the trunk against the desk that is switched on.
- **The heartbeat is a turn ending**, not a timer, and only once the last thing published
  is older than `REFRESH_MS` (10 min) - so an ordinary turn end pushes nothing (0.11s) and
  a publishing one costs 2.17s. It sends the new name up and the name it replaces down in
  ONE push; asking the remote which name to retire is what made that 3.0s.
- **A chat ending gives the trunk back at once**, rather than leaving the other desk
  blocked for the 45 minutes it would take to go stale.
- **The release lock is decided by the SERVER, not by a read.** `refs/paneforge/lock/
  release` is created by a plain, non-forced push of an **orphan commit carrying this
  device's name** - a sha no other machine produces - so the other desk's push is a
  non-fast-forward that git refuses on its own. Read-then-decide has a window both desks
  fit inside. Two versions of this were wrong and both are kept as cases in the test:
  pushing the branch tip is a no-op that SUCCEEDS (both desks are on the same commit, so
  the lock handed itself to everybody), and `--force-with-lease=<ref>:` checks the lease
  against the *pusher's own* remote-tracking ref, so a desk that has never heard of the ref
  believes it absent and takes the lock too. A lock with no timestamped claim beside it is
  one a killed machine left behind, and is cleared.
- **Nothing here may ever block a chat.** No origin, an unreachable origin, a laptop on a
  train: every one falls through to exactly the behaviour this repo had before any of it
  existed. A repo with no remote never asks anybody anything. If the check cannot run,
  `doctor` says so rather than reporting an empty answer as "nobody holds it" - which is
  why `peerRefs()` returns `null` and not `[]`.
- `PF_DEVICE` overrides the hostname, which is the only thing that lets one machine play
  two in a test. `npm run test:lanepeers` is the arithmetic; `npm run test:lanedevice` is
  the plumbing, against a real bare repo and two real clones.

## Releasing happens by itself

One command, and it is not a release:

```
node scripts/lane.mjs ready --repo <dir> --session <id>   # this lane is done and verified
```

`ready` merges master into your lane first, refuses to mark anything while that merge is
dirty, then releases once **no chat is mid-work** - one version bump for everyone, whoever
finishes last. Edit or commit after marking and the mark is dropped, by name. The
measurements behind every number here are in `docs/design-notes.md`.

- **Below 1.0 an automatic release only ever moves the patch.** `bumpFor` still reads the
  commit subjects, and `nextVersion` demotes it: `feat:` is a patch, `feat!:` is the one bump
  a commit may ask for (a minor), anything larger is typed (`lane.mjs ship minor|major`).
  Reading `feat:` as a minor took this repo v0.4.62 to v0.8.0 in one day.
- **Releases batch: one per 2 hours** (`COOLDOWN_MS`). Half an hour batched nothing - 130
  releases in 14 days - because it is shorter than one build-and-verify cycle. On the dev
  channel each release is a build to install and a restart to take it. 130 patches on a 0.x
  is honest: the fix is the rate, never a renumbering.
- `npm version`, `git tag vX` and pushing a version tag by hand are **blocked**. `npm run
  ship` is for a build Robert needs now - say why - and is the one path that skips the two
  checks below, deliberately: a person is watching it.
- **Three things stop an automatic release, all reported by name**: master not typechecking,
  master failing **its own `npm test`** (`suiteFailure` - a typecheck proves the types agree
  and never that the app works), and a lane conflicting with master. The conflicting lane is
  left out; the rest still goes. `rerere` is on and the retry timer re-tries every minute -
  which is why the suite answer is **cached on the COMMIT** in the shared ledger, invalidated
  only by a new commit. **A red answer is therefore asked TWICE before it is written down**:
  a cache the retry timer never re-asks turns one flaky run into a commit that can only be
  released by hand-editing `.git/paneforge-lanes.json`, which nobody would guess to do. This
  repo's own gate did exactly that on 2026-08-22 - two refusals, two different reasons, over
  a suite that passed standalone twice. A genuinely red suite costs one extra run. A suite that could not START is named as this checkout's tooling, is
  not cached, and that sentence decides where the next person looks. `npm run test:gate`.
- Release notes come from Conventional Commit subjects between tags
  (`scripts/release-notes.mjs`, `.github/release-notes.md`, `npm run test:notes`). **Only
  `feat:`, `fix:` and `perf:` reach the page** - the body is public, a `docs:` subject here is
  written for the next session. A release carrying only those falls back to the commit-history
  link; there is no catch-all heading, and adding one back is what made the pages read like a
  diary. The drop used to be SILENT, which is how a real fix vanished from v0.8.92, so
  `unpublished` names a commit that touched `src/` and carries no conventional prefix and
  `doctor` prints it. It reports and never rewrites; a `docs:`/`test:` subject over `src/` is
  dropped on purpose and never named.
- **Actions and this machine can both publish.** Duplicate installers are harmless;
  `latest.yml` is not. `reconcileFeed` on the retry timer compares the feed to the asset it
  names and puts ours back. Never hand-fix a feed without checking the asset's real size -
  v0.4.27 shipped 33 bytes out and looked perfect. `runSafe` quotes its arguments
  (`cmdQuote`, `npm run test:laneargs`): the old poll ran through `shell: true`, where cmd
  read its `&` as a command separator, so it had never worked at all.
- **Every automatic release is a DEV release**, cut as a GitHub prerelease. Stable installs
  resolve `/releases/latest`, which points at the newest PROMOTED release, and promotion
  happens by itself on the big-company shape: the newest dev build that has been on the
  channel `PF_PROMOTE_SOAK_MS` (3 days) auto-promotes from the same minute timer. **The soak
  is that build's own age, not a quiet period across the channel** - requiring the newest
  build to sit untouched froze stable 20 versions back while a Mac could not update out of a
  broken build. Both paths refuse a one-legged release and a feed whose declared size
  disagrees with the asset, then verify `/releases/latest` really moved. Tags stay plain; the
  prerelease FLAG is the channel. `lane.mjs promote [version]` by hand is for "stable needs
  this now", never on a green diff alone. `lane.mjs doctor` lists what waits.
  `npm run test:promote`.

**A release claims the thing is finished.** Never cut one while any next step for that issue
is still open - and **promotion claims it is proved**: the dev channel buys the room to
iterate, and the soak is what turns iteration into proof.

## An update may never need a person

Install once, update from the app, for ever. **A user reinstalling PaneForge by hand is a
defect**, and the only bug class that has ever caused it here is one shape: a promise that
never settles behind a flag saying "already working on it".

- **A release this platform cannot install is skipped, not retried.** A release cut from
  one machine publishes only that platform's assets (v0.8.61: `latest.yml` and the exe,
  no mac zip). The dev channel took the newest tag on faith, `macUpdate` asked for a
  `PaneForge-<v>-arm64.zip` that was never published, and the poll retried the same tag
  for ever — an error card no restart could clear, because nothing in the loop ever
  looked at the release BELOW it. `shared/pickRelease.ts` walks the list for the newest
  release whose assets include the one `assetFor` will ask for; a list where NOTHING is
  installable reports "no update" rather than an error, since that is a fact about the
  releases and not a failure. `npm run test:pickrelease`.
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

- **Nothing is mirrored until it is picked, and a device may not pair with itself.**
  Connecting used to mirror every pane the other machine had and attach to all of them, so
  a link was a decision to watch everything. Worse, `pair` accepted this device's own id: a
  desk here held ITSELF in `peers` at its own tailnet address, so every local pane arrived
  back as `@<self>/<id>` and the whole window listed twice, half the copies refusing every
  action that only works on a local pane. `Remote.probe` refuses an id equal to ours at the
  handshake — the first moment the far end's identity is known, and the only check an
  address test could not make — and `start()` drops one already saved, because a config
  outlives the bug. Mirroring is `peer.watch`, a tick per pane in Devices; a pane opened
  from here and a pane handed off are picked for you, and nothing else is. `test:remote`.
- **The pty never moves.** A mirrored pane's agent, checkout, transcript and worktree stay
  on the device it was opened on. Remote control, not migration. Session ids are the seam:
  a mirrored pane is `@<device>/<id>`, and `remote.owns(id)` in `main/index.ts` routes every
  pane message to the link instead of the pty manager.
- **A mirror BORROWS the terminal's size; it never owns it.** Fitting the font was the
  only lever a mirror had and it cannot win: measured 2026-08-23 the PC's pane was 69x35
  (its window is small - a disconnected RDP session) against room for 152x58 here, so the
  far end's screen was either a block of text in the corner or, once it was allowed to
  grow, enormous. Neither is the screen the agent draws on. So `pty:resize` on a mirrored
  id is sent over the link with `borrowed` - the same contract a phone has with a desk
  pane (`resize(borrowed)` in `main/sessions.ts`): the host bends the pty to the viewer,
  keeps `deskCols/deskRows`, and `returnSize(id)` gives them back on detach, on the guest
  vanishing, or when this desk resizes the pane itself. Per-pane, never `returnSizes()` -
  another device may be watching three panes and stop watching one. The old SIGWINCH
  worry does not apply: a mirror fits itself to its OWN window and asks for that, so it
  never chases the number it was sent. `shared/mirrorFit.ts` is now the FALLBACK for a
  host that has not applied the borrow yet or is an older build, and the leftover slack it
  centres is only split when it is bigger than two cells - inside that, the pane is full
  and belongs flush against the edge the scrollbar hugs.
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

**...and a paired machine says what it is running OUTSIDE its panes.** The sessions list
carries every pane the other device has, which answers "what is open over there". It could
not answer the question actually asked of the machine doing the unattended work: the
`claude -p` a scheduled task fires, the loop wedged since Tuesday, the dev server on a port
nobody can reach. None of that is a pane, so none of it was anywhere in this app - you went
and looked over SSH. `shared/backJobs.ts` is the reading, `main/backJobs.ts` the one process
table it needs, `jobs`/`jobslist` the frame, and `PeerJobs` in `RemoteDialog.tsx` the rows
under a device's pane picker.

- **Three narrow classes, and the narrowness is the feature**: an agent CLI outside a pane
  (`agent`, marked as a *run* when it carries a print/exec flag - the shape a scheduler
  makes, and the one that can fail silently for a week because there is no screen to print
  onto), a dev server (`dev`, borrowed from `devList.ts`), and a script under the projects
  root that has been alive longer than `LOOP_MIN_SECONDS` (`loop`). A process table is ~700
  rows here and a list of 700 answers nothing.
- **Anything under a pane's own tree is left out.** That work already has a card, and
  listing it twice is the duplicate-row bug `shared/desk.ts` documents at length.
- **The age floor belongs to the loop class alone.** Without it the list is mostly Claude
  Code's own hooks, several per prompt, each alive under a second - a list that flickers is
  one nobody trusts. An agent or a dev server two seconds old is exactly what somebody
  opened this to see.
- **The fold is kind-aware, unlike `devList.ts`'s.** `npm run dev` and the `next dev` it
  spawned are one server; a dev server an AGENT started is two different facts, and folding
  it in leaves a card saying an agent is listening on port 5173.
- **A refusal may never share a shape with an empty answer.** `Remote.jobsOn` rejects when
  the device is not connected, because `[]` means "that machine is running nothing" - which
  is the answer being checked - and a failed read wearing it says the PC is idle every time
  the link is down.
- **On demand, never on a tick**: it is a whole `ps -Ao command=` on the other machine.
  `npm run test:backjobs` (the last block reads THIS machine's real table), and the frame
  itself is proved crossing a real socket in `npm run test:remote`.

**A handoff moves the WORK, still never the pty.** `Hand off` on a pane's own card asks
one question — which machine — in a box of its own (`HandoffDialog.tsx`), because the
answer used to be a ghost button on the third row of a card inside Devices, a screen
carrying pairing codes, a QR, a tunnel switch and a per-pane mirror list. It lists the
paired machines, says in words what travels (the repo as an `auto-sync:` commit, the
conversation, the screen, the dev servers) and what a mid-turn pane does — **queued, never
killed**, so pressing it during a turn is the ordinary case rather than a refusal. The
bulk path is unchanged and still lives in Devices as `Hand off all`. `npm run
test:handofffit` measures the box in a real Chrome over the shipped stylesheet: the
answers stay reachable and a machine's NAME is never the string that gets cut. `Hand off`
on a paired device's card in Devices (two presses — the first arms it) pushes each pane's repo as an `auto-sync:` commit,
streams its transcript and screen tail over the link, and the far end pulls the branch,
writes the transcript where its own CLI looks, and starts a fresh pane with `--resume` —
through the same lane split a local launch gets. The sender's pane closes only on the far
end's ack and immediately reappears as a mirror, so the desk that handed off keeps
watching. The receiver never destroys local state: a dirty or unpushed checkout over
there refuses THAT pane by name, and the sender keeps it. Paths map by grafting the
pane's root-relative path onto the receiver's projects root (`shared/handoff.ts`).
`npm run test:handoff`.

## The phone is this window, served

There is no second app. The renderer imports nothing from Electron or Node - it is pure UI
over `window.api` - so a phone client is that object over HTTP: `src/main/phone.ts` serves
the built renderer, `renderer/src/browserApi.ts` supplies the object, and
**`src/shared/surface.ts` is the ONE list** both transports are built from, typed
`{ [K in keyof Api]: SurfaceEntry }` so a method with no channel does not compile. Never add
a channel to a transport; add it there. Detail for every line below: `docs/design-notes.md`.

- `tapIpc()` MUST stay at the top of `index.ts`, above every registration - calls land in
  the app's own `ipcMain` body via `src/main/ipcTap.ts`. Events go down one SSE stream, and
  `phone.broadcast` sits **ahead** of the window check in `send()` so a minimized window
  cannot starve a phone. Sends are queued client-side because they are ordered.
- **Off until Devices is opened, and opening it IS the switch** (there is no separate
  toggle; the QR was what the toggle hid). Unpaired gets the pairing page and not one asset;
  five wrong codes locks that address for a minute. The cookie is `hmac(deviceId, code)` -
  derived, never stored - so rotating the code signs every phone out.
- **Watching and typing are different permissions** (`src/main/passkey.ts`). With
  `phone.typeGate` on, the first keystroke of each 15-minute window costs a passkey touch.
  Three load-bearing details: the gate is on `/pf/send` and `/pf/call` and **never on
  `pty:write`** (the app types into panes itself, from the main process); it arms only over
  TLS, since WebAuthn needs a secure context and arming on plain http would lock out the LAN
  phones; and a 423 refuses the WHOLE batch before anything runs, re-queued at the front,
  because running the ungated half of a batch delivers a word with letters missing.
  `DESK_ONLY` in phone.ts refuses `phone:typeGate` and `phone:forgetKey` over HTTP - a lock
  whose switch is reachable from the thing it locks is not a lock. Every OTHER invoke channel
  in `surface.ts` is phone-reachable; desk-only is a property of the transport, not the surface.
- **Scanning asks; a press on the desk answers.** The QR carries the bare address, `POST
  /pf/ask` raises a card here with four digits on both screens, and Approve mints THAT
  browser a 32-byte token - so nothing on screen can be photographed, and a device can be
  signed out **by name**. One request at a time, five per address per ten minutes, two
  minutes to answer, and it falls back to the fragment-code QR (`phone.ask`). With asking
  off, the code rides in the URL **fragment**, which a browser never sends to a server.
- **Behind a tunnel every client is 127.0.0.1**, so `addressOf` believes `cf-connecting-ip`
  (then `x-forwarded-for`) and does so ONLY from loopback. That string is the ask slot, the
  lockout key and the words the card prints.
- **One row per device, not one per approval** - approval replaces the row with the same
  user-agent and keeps its "signed in since". The panel says who is WATCHING, never who is
  paired: the cookie is derived, so there is no per-device identity and `New code` is the
  only revoke. Each row leads with where the browser came from (`originOf`).
- **The ten-year cookie is watched, never revoked on suspicion** (`shared/deviceWatch.ts`):
  a changed place is recorded and never alarmed on; a changed browser shape and one live
  stream from two origins at once are the marks. A mark is never overwritten or cleared by
  an ordinary arrival, and `phone:clearMark` is `DESK_ONLY`.
- **`SameSite=Lax`, never `Strict`** - every real way this address is opened (a QR, a link
  in Messages, a bookmark) is a cross-site navigation. `Secure` only when the request really
  arrived over TLS.
- **A way in from anywhere**: `main/funnel.ts` (Tailscale Funnel - the hostname never
  changes, so a phone signs in ONCE) is tried first, falling silently through to
  `main/tunnel.ts` (a cloudflared quick tunnel: no account, nothing on the phone, a new
  hostname per run). Never look the hostname up before `Registered tunnel connection` - an
  early query caches NXDOMAIN for 40s. `up` is set by a real HTTPS request returning our own
  bytes. Everything cloudflared says is on **stderr**. Turning it on lengthens the code to 14
  and signs every phone out. The binary is downloaded once through a `.part` name and a rename.
- **The QR leads with the LAN address**, tailnet after it (100.64/10 answers only for a phone
  running Tailscale), and `reachWords` never promises "works anywhere" for an address the
  server marks "this network". The panel folds the codes, addresses, port and `New code` away
  under `Other ways in` / `Pair by hand`: zero of them on screen with the folds closed.
- **A copy made on the phone is the PHONE's clipboard** - `buildApi` lets a transport answer
  a method itself, and `browserApi.ts` answers `copyText`/`readClipboard` locally.
- **The output is also served as TEXT** (`TextSheet.tsx`): a finger cannot select a canvas.
  It reads the transcript off disk (`sessions:log`, up to 8 MB) rather than the 400 KB live
  replay, and it is RENDERED through an off-screen xterm, never stripped - stripping puts
  every repaint frame of a thinking line on its own row.
- **A text field must opt back IN to selection**: `body { user-select: none }` inherits, and
  iOS then refuses the caret loupe. Both spellings, on every input and textarea. And the keys
  a phone keyboard lacks are drawn (`HandheldType`: ⌫ ← → ↑ ↓ esc at 44px, as bytes).
- **The desk OWNS a pane's shape; a phone BORROWS it** (`resize(borrowed)`, `returnSizes`).
  A desk resize during a borrow is REMEMBERED and applied when the phone lets go, because
  showing a pane, toggling the grid and the window's own layout all land in `resize` - each
  one used to snap the pty back under a phone mid-repaint. A phone re-wrapping a pane scrolls
  the old frame away and may never `clear()` it. A COLUMN change clears the buffer and asks
  for a repaint; `clear`, never `reset`.
- **A phone is not a small desktop.** `handheld.ts` + one `@media` block: under 720px, or a
  coarse pointer under 520px tall (a handset in landscape), the list and the panes take turns
  with `display: none`. `100dvh`, never `100vh`. The pane header keeps only what says WHICH
  pane this is; every action moves behind one ⋯ into `PaneMenu.tsx` (52px rows, words,
  destructive last). Back goes to the list via one history entry; the swipe arms anywhere in
  the pane, never at the left edge the browser has already taken. A tap opens from `pointerup`
  so no scroll heuristic can veto the first press. One composer: xterm's helper textarea gives
  up being a field on a coarse pointer, and the typing bar autocorrects (nothing leaves it
  until Send). `isPhoneClient()` gates AUTHORITY only, never layout - the approve card is not
  offered on the screen that cannot compare the digits.
- **Automation opens a pane through `scripts/pf-ctl.mjs`**, never `open --args`: one em dash
  in the argument list makes macOS drop the whole list and exit 0.
- `npm run test:phone` (server + surface parity). `npm run test:phoneview` needs a running
  copy. A pane's text is in `window.__pf[id].term.buffer`, never in the DOM.
- Not built: headless host (B1), phone-first diff (H2).

## A pane can run on somebody else's model

Most of `shared/agents.ts` is one binary pointed somewhere else: Claude Code reads
`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` and nothing else, so "Claude Code on
GLM" is a catalogue entry with two variables set, and every feature in this app that
reads a Claude pane keeps working. Separate ids rather than a switch on `claude`,
because the two have different histories, costs and failure modes and a pane must say
which it is on its card.

- **A provider is an entry in `KEY_PROVIDERS` plus an agent whose `env` names
  `keyVar(id)`.** Settings draws its key field off that list, so a provider added to
  the catalogue reaches the screen by itself; it used to be one hardcoded OpenRouter
  field, which meant a new entry shipped with nowhere to authenticate from.
- **"Anthropic-compatible" is probed, never read.** DeepSeek (`https://api.deepseek.com/
  anthropic`) and Z.ai (`https://api.z.ai/api/anthropic`) both answer a junk-key POST
  with a 401 in Anthropic's own error shape, which is how a real implementation is told
  from a rewrite of chat-completions. **xAI does not have one** — every claim that it
  does traces to a non-xAI page — so Grok is its own CLI entry (`grok`, installed by
  x.ai's script into `~/.grok/bin`, which `which.ts` now hydrates because the script only
  *tries* to symlink onto PATH). Neither base URL carries `/v1`: the CLI appends it.
- **A key pasted in Settings reaches the menu somebody is actually looking at.** The model
  list is per agent for a good reason - `z-ai/glm-5.2` under plain Claude Code is a 401 in a
  healthy-looking pane - but that made the key do nothing VISIBLE: the runner still says
  "Claude Code", so 51 models sat one menu away with nothing on screen saying which menu.
  `siblingModels` borrows another runner's models into this one's dropdown under the
  PROVIDER's heading (`OpenRouter · Free`, never `Claude Code on OpenRouter` - a runner
  name over a model list reads as a second product to choose between, which is the
  confusion the borrowing exists to remove), each row carrying `agent`, so the press
  switches the runner and the model together. Two refusals hold it honest: only a provider whose key is actually SAVED,
  and only a sibling on the same `bin`. `config:set` invalidates the 20s agent cache, or the
  first dialog after pasting the key still shows nothing.
- **A blank key drops the token and KEEPS the base URL.** Dropping both would run plain
  Claude Code inside a pane whose card says GLM — worse than an error, because nothing
  says so. The Settings card names the missing key instead (`missingKeyFor`), which is
  the first use `keyProviderFor` has ever had.
- **`HEADLESS` is keyed by agent id**, so these were silently undrivable while running the
  identical binary. They share `claude`'s entry now. Grok is deliberately absent: its
  headless flags are unverified, and `drivable()` refusing is better than a guess.
- `npm run test:agentenv`.

## ...and the model list is not this build's opinion of what exists

`OPENROUTER_MODELS` was measured on one day in August and a model published after it was
reachable only by typing its id into "Other..." - which is how `stealth/ox-alpha` (free,
1M context, tool calling, published 2026-08-20) was invisible in an app whose whole point
is running a pane on somebody else's model. `main/orModels.ts` keeps a copy of
OpenRouter's own public list on disk and `shared/orCatalogue.ts` turns it into the menu.
`npm run test:orcatalogue`.

- **It may never be in anybody's way.** `listAgents` is synchronous and runs on every
  dialog open, so it reads the catalogue from MEMORY and kicks the fetch with `void`; a
  list that arrives late reaches the next open. Missing, stale, empty, offline, a 502, an
  error page: every one of them leaves the app exactly as it was, a hand-written shortcut
  list plus "Other...". An empty answer is a FAILED answer and is never written over a
  good one - writing it would blank the menu for twelve hours.
- **Only models that can call tools.** A model without them answers the first turn in a
  Claude Code pane and then cannot read a file: a pane that looks perfectly healthy and can
  do nothing. A row that does not declare its parameters is dropped rather than guessed
  at - this is a shortcut list, and everything left out is still one "Other..." away.
- **Nothing is capped, and every row carries BOTH prices.** Free models lead under their
  own heading because that answer is small and is why anybody opens the list; every paid
  tool-capable model follows under one heading. The 25-row cap that used to sit there was
  answering a question `Select` had already solved - it becomes a filter box past eight
  options - and a cap inside a filter box is invisible: you type the model you want, get
  nothing, and cannot tell "OpenRouter does not have it" from "this build chose not to
  show it". `Select` searches the VALUE as well as the label, because `labelFor` strips
  the vendor (`Z.ai: GLM 5.2` -> `GLM 5.2`) and the vendor is what people type. The hint
  is `$in in · $out out /M`: input alone is the cheap-looking half, and an agent pane is
  mostly output. Newest first, in both groups.
- **A stealth model says so in the hint, where the choice is made.** OpenRouter's own
  words: developed and operated by a provider who has chosen to remain anonymous, and
  "prompts and completions are retained by the provider and are not used for training".
  Retained by somebody unnamed is a fact a person needs at the moment they pick it, not in
  a document nobody opens.
- **How a CLI addresses the model is read off its own `env`**, never off a list of ids: an
  agent that authenticates with the OpenRouter key names it bare (`z-ai/glm-5.2`), one that
  passes the key to a provider of its own reaches it through `openrouter/`. So an agent
  added to the catalogue is covered with no edit here.

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

## The sessions list is the whole desk, both machines

There is no Fleet screen any more. It answered "which pane needs me first", which is the
question the sidebar is looked at for, and it answered it somewhere you had to remember to
open - so the sidebar answers it instead: grouped **Your move / Running / Ready / Ended**,
`shared/fleet.ts` still deciding, Ctrl+Shift+F toggling back to the order the cards were
dragged into (kept in `localStorage`, not config - it is a view, and two machines have no
reason to agree about it). While grouped a press is only a press: a drag reorders `order`,
`order` decides nothing in that view, and a row that followed the pointer and then snapped
back to wherever its state puts it reads as a broken list.

**And every pane on a paired machine is in it, without being mirrored.** A pane on the PC
used to be invisible here until somebody picked it in Devices, so "is anything running over
there" was a question you went and asked - no way to watch the machine that is meant to be
doing the work. Nothing new crosses the link for this: `client.panes()` has always held
every pane the far end has, as whole `Session` objects, and `remote/index.ts` was throwing
all but six fields away on the way to the renderer. `RemotePaneInfo` now carries everything
`FleetPane` reads, so a PC pane sorts into `Your move` beside a local one.

- **Listing is not mirroring, and that split is the whole design.** LISTING a remote pane
  costs a few fields on the `remote:changed` message that is already sent whenever anything
  over there moves. MIRRORING one costs a live byte stream and an xterm buffer **on this
  machine, per pane** - which is the one cost a laptop acting as the screen for another
  machine's work cannot pay at scale. So every pane is listed, none is mirrored until it is
  pressed, and `openListed` is what turns one into the other. The agent's own speed is not
  in this trade at all: it runs over there either way.
- **The order inside a group is the sidebar's own numbering, and nothing else.** It used
  to break the tie on how long a row had been in its state, oldest first, which reads well
  and is wrong: the clock a `needsYou` row counts from is `lastOutput`, and a `working` row
  falls back to the same field, so the sort key MOVED every time a pane painted. Eight
  panes printing is eight keys changing several times a second and rows swapping places
  under the pointer - "sessions keep moving up or down randomly". A list only settled while
  nothing is happening cannot be pointed at, and the age it sorted by is on each row's own
  clock anyway.
- **A listed row has no pane NUMBER.** There is nothing on this machine for Ctrl+N to reach
  until it has been opened. The number of a real row still comes off the FULL ordered list,
  never off this screen's order - the device filter is visual, and a number that moved with
  the filter would move the Ctrl key under somebody's finger.
- **A mirrored pane is never listed twice.** Both halves are true for a beat while a mirror
  attaches, and a pane drawn once live and once as an invitation to open it reads as a
  duplicate rather than as a bug.
- **A device that is off, connecting or in error lists nothing.** Its pane list is from
  before it went, and drawing that as live work is worse than drawing nothing.
- **The badge counts both machines.** `fleetWaiting` over the whole list, not over this
  desk's panes - the number sat at zero all day on a laptop whose agents all run on the PC.
- **The device filter offers a machine that is merely CONNECTED**, not only one with a pane
  mirrored: built from mirrored sessions alone it could not name the one machine somebody
  opens the list to look at.
- A question over there cannot be ANSWERED from a row (the buttons need the frame the
  chooser was read off, which needs a mirror), but it is the loudest reason to open one, so
  it ranks the row exactly as a local question does.
- **A group is only worth a heading while its name is TRUE, and two of the three were
  not.** `Running` was `status === 'working'`, and status was set by any output arriving
  at a pane that had ever been asked anything (`engaged`, which is sticky for the life of
  the session) - so the CLI echoing the prompt being TYPED into it moved that pane to
  Running. "It says Running while I am typing this prompt." The honest reading is
  `runSince`: a turn started by the submit keystroke, by the agent's own busy footer, or
  by a shell pane's live command, and ended by `endRun`. And `Ready` was `!engaged`, which
  no pane could ever get back to, so the group held whatever happened never to have been
  typed into: `/clear` now drops `engaged` (`clearsConversation` in `shared/slashTurn.ts`,
  partial forms included - a completion menu turns `/cle` into `/clear`), which is the one
  thing that genuinely puts a pane back where a new one starts. `/compact` and `/resume`
  do not: both leave a conversation somebody may want to read.
- **A shell pane's turn ends with its COMMAND, with no quiet clock in front of it.** The
  backstop that ends a run waits for the pane to go quiet, and a shell echoes every
  keystroke - so a shell pane that had ever submitted anything kept its clock for as long
  as somebody typed at its prompt. POSIX only: there `paneJob` is the tty's own foreground
  process, asked every sweep, and Windows samples a table every 4s where a command would
  read as finished before it is first seen.
- **Your move is STILL once you have arrived at it.** The card's flash on arrival runs
  ONCE (`doneGlow`, 1.9s, and `DONE_GLOW_MS` must stay in step with it) instead of three
  times over 5.2s, and the standing amber marks - the 2px bar and the halo behind the
  Ctrl-N key - no longer breathe at all. Motion is for news; a pane that finished ten
  minutes ago is not news, and four of them pulsing out of step is the "annoying shimmer".
  A red `asking` bar keeps its pulse, because that one is a live question and it stops
  when it is answered.
- `shared/desk.ts` is the arithmetic, out of the component for the same reason `fleet.ts`
  and `place.ts` are. `npm run test:desk`, whose load-bearing half is the negatives and
  whose last block is a SOURCE assertion: a field added to `FleetPane` and not forwarded
  through the peer map still typechecks, still renders, and sorts every remote pane wrong
  for ever.

## Finding a setting

The search box above the rail used to filter the RAIL, so it could only ever say which
PAGE a thing was on - and "close a pane" then meant reading a page of thirty switches. It
now finds the SETTING: the matching rows are tinted on the right, the best one is scrolled
to and edged in the accent, and the rail follows it to that tab. Nothing is hidden, which
is the original rule and still right - a switch read out of the group that explains it is a
switch nobody can judge.

- **The index is GENERATED from the dialog's own source** (`scripts/settings-index.mjs` ->
  `src/shared/settingsIndex.ts`, `npm run gen:settings`). A hand-written one is the obvious
  answer and the wrong one: a setting added later is simply missing from search, silently,
  and the way anybody finds out is by searching for it and being told nothing matches.
  `npm run test:settingsearch` regenerates it in memory and fails on any disagreement.
- **A setting is found by its hint as well as its name.** "Close a pane nobody has touched
  for a while" is not a phrase anybody types; "idle" and "memory" are, and both are in the
  sentence under it. A hit on the LABEL still outranks a hint-only one.
- **The marking is done to the DOM**, not by threading a `highlight` prop through nine tab
  bodies: the thing being marked is a row that already draws its own name, and that name is
  what the index took out of this same file. A live reading in brackets is why the match is
  a prefix test rather than equality.
- `scrollIntoView` is `nearest`, never `center` - a match already on screen must not scroll
  the page out from under somebody reading it. No animation: `test:anim`'s rule.

## A card answers a right-click, and can say what it is

Everything you might do to a pane lived somewhere that was not the card: rename behind a
double-click nobody discovers, hand off / clear / close inside the pane's own header, and
"what IS this, how long has it been open" nowhere at all. `SessionMenu.tsx` is the desktop
context menu on the card - opened at the pointer, clamped on screen after it is measured
(the height depends on which actions that pane offers, so a fixed number is wrong for half
of them), arrow keys and Escape. It is deliberately NOT `PaneMenu.tsx`: that is the phone's
bottom sheet with 52px rows, same actions, other hand.

`SessionInfo.tsx` is the "see info" the card has no room for. **Its clocks are live** -
`Open for` counts from `createdAt` through `useNow` (the app's one shared second timer), so
"can I close this" gets a ticking answer rather than a frozen one. The header's clock is the
TURN and stays that way; the two numbers are different questions. Everything else on it is a
reading the app already holds - last spoke, last typed into, the place, and the pane's real
cost out of `main/usage.ts` - so opening it polls nothing.

## Copying a prompt, or the answer it got

Two copy icons beside every prompt that is on screen: the prompt, and the reply that
followed it. They are drawn for every VISIBLE turn, never for the hovered one.

- **The hover version could not be pressed.** The pair is anchored to the row the turn
  starts on, so reaching for it crosses rows belonging to the turn ABOVE - which is a
  different turn, so the pair moved - and leaving the terminal element at all fired
  `mouseleave` and took it away entirely. A button you have to chase is not a button.
- Placement is `shared/turnCopy.ts` (`npm run test:turncopy`), fed by the same prompt
  marks the rail keeps. Two prompts closer together than one pair is tall: the NEWER one
  keeps the space, because it is the one being read, and the rail still reaches the older.
- Icons rather than the words "Prompt / Reply": this is drawn once per turn rather than
  once per pane, and eight labelled buttons down the side is a second sidebar. 22px for a
  pointer, 30px for a finger, and `TURN_COPY_H` in `TerminalPane.tsx` is the height the
  crowding rule uses - change it with the CSS.
- **A mark keeps two copies of the prompt, and the button copies the one that is not the
  label.** `mark.text` is what the RAIL draws: flattened to one line and `.slice(0, 400)`.
  Copying that is the shape of bug that never announces itself - a 492-character ask came
  back as exactly 400 characters, cut mid-word, with the line breaks of a multi-line prompt
  turned into spaces, and the receipt still said "Prompt copied". `mark.full` is what was
  typed, whole, and is what the clipboard gets.
- **Full strength as soon as the pointer is in the pane.** They were 0.22 idle and 0.6 with
  the pointer in the pane, at 17px, over the agent's own output - which reads as "the icons
  do not show up when I hover". Faint is for a pane nobody is pointing at.
- **Keyed on the mark, never on the buffer row.** A marker's line moves when scrollback is
  trimmed, and a changed React key unmounts the pair - taking the `:hover` and the
  half-finished click of the button being reached for with it.
- `npm run test:turncopyview` is the half `test:turncopy` cannot reach: it needs a window,
  types a 492-character prompt through xterm's own input path, and reads the clipboard back
  (`Emulation.setFocusEmulationEnabled`, so a minimized window can still be asked).
- The reply is the rows after the prompt up to the row before the next one. Off by one in
  either direction and the paste is perfect and wrong.

**Every copy a person asked for says so.** The clipboard gives no feedback, so a copy that
went nowhere and one that worked look identical - "I press copy and nothing tells me it
copied". Ctrl/Cmd+C, the right-click copy, copy mode's `y` and the selection chip all report
in the window's toast with the line count as the receipt (`sayCopied`, one counter in one
place - the right-click path had `sel.split('n')`, counting the letter n). Copy ON SELECT is
the one silent path and deliberately so: nobody pressed anything, and the highlight is its
own feedback.

## A click puts the cursor where you clicked

A CLI's prompt is drawn text and a pty takes keystrokes, so a click cannot place a caret —
it can only be turned into the arrows that would have reached the same cell
(`src/shared/cursorMove.ts`). The trap is that an up-arrow in a plain shell is the previous
command, not a movement, which is why every terminal that ships this hides it behind a
modifier and why this one did too.

- **A bare click is allowed the half that cannot recall anything.** `keysAlongLine` emits
  left and right and nothing else, and the pane only calls it when the click landed on the
  cursor's own logical line — its row, or a row the same input wrapped onto, proved by
  walking xterm's `isWrapped` chain. A wrapped row is `cols` characters, so the arrows
  cross the wrap by themselves. Verified against a real pty: 29 → 23 on one row, and
  (104, row 10) → (10, row 9) across a wrap in a 157-column pane, exact both times.
- **On mouseup, and only when the pointer did not travel.** Swallowing the mousedown would
  take drag-selection with it, and copy-on-select is the more important of the two.
- **The composer a CLI draws is ONE text field, and it is found by its rules, not by its
  frame.** Claude Code 2.1.x draws no frame at all - a rule, `❯ text` with each further row
  indented two spaces, another rule - so `isWrapped` said the rows were unrelated, `sameBox`
  found no box, and every selection spanning two rows deleted a single character: "it
  doesn't delete all the highlighted text". `composerAt` (`shared/promptBox.ts`) walks to
  the rule above and to a rule of the SAME width below and requires a prompt marker on the
  first row; `inputRows` in the pane turns that into spans, and `offsetIn`/`keysForRows`
  (`shared/cursorMove.ts`) count over them. **Crossing a row boundary costs exactly one
  character** - the space the wrapper ate, or a hard newline - and **nothing** when the row
  is drawn out to the full width, because only a word too long for the line is split.
  Measured live at 157 columns: a 244-character prompt draws 242 and is emptied by 244; 300
  unbroken `x` are emptied by 300. A row within a column of the width counts as full on
  purpose - over-counting deletes a character nobody highlighted, under-counting only leaves
  one behind. **The marker is followed by U+00A0, not a space**, which is what made every one
  of these refuse in silence while every test passed: `BLANKS` in `promptBox.ts`.
- **A drawn input box is the one place a bare click may go up and down.** Every agent CLI
  draws a multi-line box, and a second line of a draft is a hard newline rather than a
  wrap - so the `isWrapped` chain called the rows unrelated and a click on line two did
  nothing, which is "the cursor can't select exactly where I want". Inside a box the CLI is
  handling the arrows itself, so they are movements; `shared/promptBox.ts` decides what a
  box is, off the drawn text, and a plain shell draws none. An ASCII `|` is deliberately
  not a frame - a markdown table is not an input box. `npm run test:promptbox`.
- **A selection can be deleted, and typed over.** A highlight lives in this window and the
  far end has never heard of it, which is why no terminal does this: `keysForDelete` walks
  the cursor to the end of the selection and sends one backspace per character. Only on the
  cursor's own line and only across rows the input WRAPPED onto - a selection spanning the
  separate lines of a box is refused, never guessed, because the newline and the frame are
  not `cols` characters. Mod+A highlights the whole input and hands the key back when there
  is nothing to select, so Ctrl+A stays a line editor's "start of line" in a plain shell.
- **The click is swallowed only on its way to an AGENT.** These handlers are capture-phase
  on the pane's host, and an unconditional `stopPropagation` there also robs xterm of the
  mouseup it removes its own drag listeners from — so the selection kept following the
  pointer with no button held. The stop is kept only while the CLI has mouse reporting on,
  which is exactly when xterm has disabled its selection service and has nothing to leak.
  `npm run test:stickyselect`.
- Alt/Option-click still reaches other lines, still refuses more than `rowLimit` rows away,
  and is still the only path that can emit an up or a down OUTSIDE a box.
- The clicked column is clamped to what is written on that row. Without it, a click in the
  empty half of a row is a burst of rights a CLI reading arrows as menu steps acts on.

## A shell pane says what it is running

Every "is this pane working" reading in the app is about an AGENT: `engaged` is a prompt
this app watched being submitted, `busyUntil` is the CLI's own footer saying it is running.
A plain shell pane has neither, so `npm run build` typed into one printed nothing for two
minutes while the card read `ready - type to start` and sat in **Ready** with no clock -
the desk calling a busy machine idle. `shared/paneJob.ts` is the reading and
`npm run test:panejob`.

- **On POSIX it is the pty's own foreground process**, which the tty already knows
  (`tcgetpgrp`, behind node-pty's `IPty.process`). One syscall, no process table, asked on
  the same 1s sweep everything else here runs on. Measured against a real pty: `zsh` at the
  prompt, `sleep` a beat after `sleep 20` was typed.
- **Windows has no such reading, and the failure is a LIE rather than an absence.**
  Measured on the PC: `IPty.process` there returns the TERMINAL NAME - `"xterm-256color"`
  idle and `"xterm-256color"` with a command up - so believing it marks every shell pane on
  that machine working for ever. There the answer comes off the process table instead
  (`jobFromTable`, `WIN_JOB_MS` 4s, only while a shell pane is open, never twice at once):
  the pty pid IS the shell, measured, and the command is its child. That path also knows
  how long the command has been alive, so the pane's clock is its real age rather than the
  moment the app noticed it. An empty table leaves every pane as it was - "the table did
  not answer" may not wear the shape of "nothing is running".
- **It feeds `busyOnScreen`, rather than being a state of its own.** A live command means
  exactly what that flag means everywhere else in `sweepIdle` - the pane is working, do not
  call the turn over - so the pane sorts into **Running** and the backstop that ends a
  silent turn after 4s stands down while the command runs.
- **The clock counts the COMMAND.** A shell pane's `runSince` is otherwise never set by
  anything, and a pane in Running with no clock is half an answer: something is happening
  and not for how long. The row says `running npm`, not `working`.
- **Narrow on purpose, because the expensive failure is a FALSE job**: a pane wrongly
  marked working never goes quiet, so `reclaim.ts` never closes it, the budget never hands
  it off, and its clock is a lie that ticks. So only a pane whose RUNNER is a shell is ever
  spoken about - an agent CLI can report its own foreground as `node`, which would read as
  a job for ever - and a foreground that is itself a shell is a subshell, not work.

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

## A pane opened with a prompt sends it

`queuePrompt` in `src/main/sessions.ts`. A prompt handed to `sessions:start` used to be
written as `prompt + '\r'` on a blind 2500ms timer, and the way that fails is silent:
the pane holds a fully typed prompt nobody sent, idle and green, looking exactly like a
person who walked away mid-sentence. Two #momin bundles sat like that for hours.

- **The readiness signal is an idle COMPOSER, never a clock.** Output stopped AND
  `readsBusy` false — Codex pauses mid-startup on `Starting MCP servers (0/4) … esc to
  interrupt`, and a return sent into that screen cancels the startup instead.
- **The busy read looks at the last thing PAINTED, not at a window of scrollback.** The
  boot's own `esc to interrupt` never leaves the buffer, so a fixed tail calls a pane
  busy for ever and the prompt is never typed at all.
- **The return is a separate write**, a beat after the text: a CLI that is still booting
  replays what arrived into its composer, where a trailing return is one more character
  of the paste.
- **The submit is confirmed, not assumed** — still idle a few seconds later means the
  return was eaten, so another goes, up to three. Everything is capped and every budget
  is an env knob, which is what lets `npm run test:promptsubmit` run in a second.
- Model ids are part of this: a Codex pane started on any `gpt-5.1-codex*` id answers
  `400 … not supported when using Codex with a ChatGPT account` INSIDE a healthy-looking
  pane, so the prompt is burned with nothing done. `agents.ts` lists only ids measured
  answering on a subscription login.

## An agent's question is a row of buttons

A CLI that asks "which of these?" stops until somebody presses return; away from the desk
that is the rest of the run, and the pane goes idle and green looking exactly like one that
finished. `shared/choices.ts` reads the chooser off the pane's own frame, so it covers every
CLI here rather than whichever one has a hook. Why each rule: `docs/design-notes.md`.

**The card is docked to the RIGHT of the question, and does not repeat it.** It used to lie
across the bottom of the pane, which is exactly where a CLI draws its chooser - so the thing
being answered was underneath the thing answering it, and the card carried a second copy of
the question, clamped to two lines, to make up for covering it. Two questions out of one,
and the worse of the two was on top. Docked right (260px, `max-width: calc(100% - 16px)`,
full-width again on a coarse pointer), the CLI's own question stays readable beside it -
measured live at 260 of 1198 with 930px clear. The answers are one per line and all the
same width, so arrowing repaints one border colour instead of reflowing a wrapping row of
pills across the pane: that reflow was the "laggy when I arrow up and down" report, on top
of the render cost the memo below already fixed. `npm run test:askrender` pins the dock,
the absent copy, and the equal button widths.

- **The reading is narrow because the expensive failure is a FALSE question**, not a missed
  one: buttons over a numbered list in an answer would type arrows into somebody's draft.
  Three things must all be true - the CLI's own `Enter to select` footer, options numbered
  1..N with no gaps, and exactly one row carrying the arrow. Both positive fixtures in
  `npm run test:choices` are real frames off this machine.
- **A RULE in the list is read exactly like a blank line.** Claude Code 2.1.235 draws a
  full-width rule before the options it always appends, and treating it as prose stopped the
  walk one option in - so a live 159-column pane with a question plainly on screen read as NO
  question: no buttons, no red card, no Telegram, nothing for `autoAnswer` to press. The box
  gutter down the left is stripped too. The FOOTER is still the load-bearing guard, so this
  cannot admit a false question.
- **Arrows and a return, never the digit** (a chooser that only reads arrows ignores a digit
  silently), spaced `CHOOSE_GAP_MS` apart. It counts from where the arrow is NOW
  (`askSignature` includes it), and a press against a question the pane has left is REFUSED
  rather than walked from a stale position.
- **The reading is on the SESSION, not in the pane** - the phone draws the same buttons and
  `pty:choose` is reachable over the phone server; a mirror is answered over the link.
- **A question is RED, makes its own NOISE, and leaves the machine.** Every idle reading in
  the app says yes about a pane that is only quiet because it is owed an answer, so the card
  glows red down its left edge while `Session.ask` is set (`.row.asking`, 15% and a 3px
  pulsing bar - 7% was a tint you find once you know it exists) and carries the words
  `asks you` with the question on its hover. There is no ring on the pane itself: the same
  fact drawn twice over the agent's live output read as something the agent had printed.
  `sounds.ask` (default `knock`) plays on `sessions:ask`, and `done` is deliberately NOT
  played over it - a finished turn and a stopped one are the two most different outcomes
  there are. `main/askNotify.ts` posts it to Telegram (Settings → "Send a pane's question to
  Telegram"): silent with no `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, one message per
  question (`sameAsk`), never for a mirror, and it posts and stops - a bot token has exactly
  one long-poller and a second STEALS the updates. `scripts/pf-telegram.mjs` is the half that
  turns a TAP back into `pty:choose`, post-only by default. `npm run test:asknotify`.
- **A click on a pane holding a question types NOTHING into it.** Clicking a pane here is not
  passive - a bare click becomes arrows, an Alt-click up and down, a selection delete a run of
  backspaces - and a chooser is the one moment every one of those is an ACTION: measured
  against a real `claude`, 15 right arrows at its `/model` chooser moved it to `max effort`,
  and Claude Code enables no mouse reporting at all, so nothing was being swallowed and the
  pane's own handlers were the only thing typing. `askRef` in `TerminalPane.tsx` refuses all
  three while `Session.ask` is set; the answer is the buttons. `npm run test:askclick` is a
  real mouse through CDP, with the control that the same click with no question must still
  send its arrows. **`window.api` is frozen by the context bridge**, so a test cannot wrap
  `write`: the pane keeps its own list (`window.__pf[id].clickKeys()`).
- `npm run test:choices`. Its load-bearing assertion is on the BYTE
  (`charCodeAt(0) === 27`): the first version lost its escape in the same edit the source
  did, so `'[B' === '[B'` passed while the app would have typed the letters into a chooser.

## Arrowing through a question may not cost the whole desk

The sessions list is ONE array for every pane, rebuilt in main whenever anything about any
pane changes - and a question being arrowed through rebuilds it on every frame. A pane's
render is not cheap either: it re-measures the turn-copy pairs and the prompt rail against
the live xterm buffer. Measured on 2026-08-20 against a real chooser in a dev copy, five
arrow moves cost **34 renders of EVERY pane on the desk**, four of which had no question on
them at all - which is what "the overlay is laggy when I switch my answers" was.
`TerminalPane` is `memo`'d with `samePaneProps`, which compares `ask`, `termTheme`,
`mirror` and `grid` BY VALUE because main sends a fresh object for each of them every time.
After: 5 renders on the pane holding the question and **0** on every other pane.

- **The load-bearing assertion is the bystander's count**, not the question pane's: a memo
  that also skipped the pane holding the question would pass a "renders went down" check
  and break the feature outright. `npm run test:askrender` checks both, and
  `window.__pfRenders` is the per-pane counter it reads.
- A prop added to `Props` without a line in `samePaneProps` is a pane that stops updating
  for it, which is why that function lists them out instead of looping over keys.

## ...and a question with an obvious answer is answered

Buttons fixed "nobody was at the desk". The next cost is at the desk: most of those questions
are the CLI asking whether it may do the thing it was just told to do.
`shared/autoAnswer.ts` presses return instead - **on by default** (Settings → "Answer an
agent's question for me when the answer is obvious"), with the wait beside it and a **five
second** default. It was off for one reason - arriving switched on with an update would
answer a permission prompt on a desk that never asked - and the answer to that is the
countdown, not silence. Detail: `docs/design-notes.md`.

- **It takes the BEST option, not the first one.** Every CLI here marks its own preference
  in the label when it has one - `(recommended)`, `[default]`, `- suggested` - and that is
  the tool STATING the answer rather than this app guessing, so exactly one marked option
  outranks a yes-shaped word and outranks the row the arrow happens to be on, in both
  modes. Two marked options are a tool recommending two things, which is a choice again.
  The marker raises rank and can never lift an option past a refusal.
- **The refusals are the feature.** Exactly ONE option leading with a yes-shaped word is
  answered; two are a choice, none is a decision somebody is being asked to make. And the
  arrow sitting on a REFUSED option is not a licence to take a different one: the CLI's
  preference has been refused and there is no second signal, so the question is a person's
  again (`Keep the current plan` now stops too - the guard read `keep current` and every
  CLI writes `keep the current`). An option
  that WIDENS permission (`don't ask again`, the bare word `always`) is never reachable in
  either mode, and neither is one that stops or answers with a question of its own (`No, tell
  Claude what to do differently` leaves the CLI holding an empty composer). `anyQuestion` is
  the wider setting and takes **the CLI's own default** rather than inventing a preference;
  both refusals still hold over it.
- **The timing is `dueForAuto`, and it takes TWO signatures.** A press waits until the frame
  has sat unchanged for `waitMs`, and that signature includes where the arrow is, so arrowing
  at the desk restarts the wait. But "have I already pressed this one" may NOT ask that
  signature - our own keys move the arrow - so `askKeyOf` is the identity with the arrow left
  out, one press per identity, plus a `PRESS_COOLDOWN_MS` floor of 4s.
- **`maxRun` is given back by the pane going BUSY, and by nothing else.** A chooser
  mid-repaint reads as no question for one frame, so returning the budget on "no question on
  screen" hands it back several times during one question.
- **It says when, and what, before it does it.** `autoAnswerAt` puts the press's own clock on
  the session (`Session.autoAnswerAt` / `autoAnswerN`) under the same guards the presser runs
  under, so a question this will never answer shows no clock at all. It is refreshed from the
  TIMER as well as from a frame: a frame only arrives when the screen changes, so computing it
  there alone meant switching the setting on over a live question showed nothing and then
  pressed out of nowhere.
- **The countdown is a banded row in the pane, a chip on the CARD, and a TICK.** In the pane
  (`AskCountdown`) it is a pill with tabular seconds beside `Answering for you with <option>`,
  and that option's button carries `.auto` - dashed, because `.on` is a different fact (where
  the CLI's arrow is) and the two are often different rows. But the pane holding the question
  is very often not the pane on screen - the grid off, another desktop, a minimised window -
  which is why "I cannot even see the timer counting down" is a true report about a working
  feature. So the card carries the seconds beside its `asks you` chip (`AskClock` in
  `App.tsx`), and `playTick` sounds once a second through the last minute of whichever
  countdown is soonest (one clock, not one per pane, or two panes beat against each other).
  The tick is its own catalogue entry with its own Settings row, a third of an alert's level
  because it fires once a second, and it deliberately bypasses the 900ms alert throttle -
  which would suppress the ticks AND swallow the chime that follows the answer.
  `window.__pfTicks` is what makes it checkable; a probe cannot hear a sound.
- **A changed default cannot reach an existing desk on its own.** `defaults()` is WRITTEN to
  config.json at first launch, so every install carries `enabled: false` explicitly.
  `defaultsV2` separates the two and `migrateAutoAnswer` applies the new defaults once - read
  off the **saved** config, never off the merge, or it answers yes for every config in
  existence and does nothing.
- `npm run test:autoanswer` (25 checks, weight in the negatives) and `npm run test:askrender`,
  which measures the row, the card chip and the ticks in a live window.

## A pane that is still starting says so

Measured on this Mac, 2026-08-15: `sessions:start` returns in **16-40ms**, and the first
byte out of the pty arrives at **~0.5s** for a warm `claude` and **~4.2s** on a cold one -
against 400-460ms for the same binary spawned into a bare pty outside the app, so the app's
own share of "opening a terminal is slow" is the 40ms and nothing else. Six panes started
in one burst all had their first byte by 1.9s; staggering them by 400ms made it *worse*
(4.7s), so `restorePanes` starting the desk in one tick stays as it is.

What was wrong is that nothing said any of it: a pane is a black rectangle until the CLI
prints, so a four-second cold start and a launch that failed look identical. `blank` in
`TerminalPane.tsx` draws one dim `Starting…` line until the first byte - the agent's own
banner or a replayed transcript, whichever comes first. No spinner: it is on screen for
half a second in the ordinary case, and a looping decoration is what `test:anim` exists to
refuse.

## A picture goes in front of the agent

Every agent here reads an image off the DISK, so "look at this screenshot" is a path typed
at the prompt. The bytes are therefore written as a real file **on the machine that owns
the pty**, and the path of that file is what is typed (`shared/attach.ts` for the naming,
`main/attach.ts` for the disk, `pty:attach` / `pty:attachClipboard`).

- **A paste is the one place the ^V is right.** Cmd+V used to write the bytes to disk and
  type the path even for Claude Code, so pasting a screenshot and dropping one gave two
  different things - the drop gave the picture, the paste gave a filename the agent had to
  be asked to open. A clipboard image now goes to an agent that reads the clipboard itself
  as a plain ^V (`[Image #1]`, verified live); every other CLI and every MIRRORED pane still
  gets the file and the path, for the reasons below.
- **Forwarding a raw ^V was the old answer and it only ever worked twice over.** It needs
  an agent that reads the OS clipboard itself - Claude Code does, Codex and the other
  eleven do not - AND it needs that agent to be on the same machine as the clipboard. A
  MIRRORED pane's is not, so the key reached across and read the wrong desk's clipboard.
- **A path is only true on one machine.** A screenshot dragged onto a mirrored pane used to
  type this desk's path at an agent running on the other one, which reads as a missing file
  rather than as an error anybody can act on - that is the whole bug. A plain session id
  still types the path it already has; `@device/id` and a browser (which has no path for a
  dropped file at all) send the bytes over the link instead, and `attachOn` is answered with
  a path that exists over there.
- **The name is TEXT, never a path.** Only the basename survives, both separators, control
  bytes and reserved punctuation gone - a drop can call itself `../../.ssh/authorized_keys`
  and this function is the only thing between that and a write. The extension comes off the
  MAGIC BYTES when they are recognised, because the name is the least trustworthy thing
  about a drop: a clipboard image has none and a browser drag calls itself `download`.
- 5 MB a batch, because base64 over the link's 8 MB frame is 4/3 of the size. A phone
  screenshot is ~200 KB; the cap exists so a video dropped on a pane fails with a sentence
  instead of killing the link. Nothing is submitted for you - the paths land in the input
  box so they can be described first.
- **A dropped file arrives in TWO shapes and only one of them was ever claimed.** The
  pane's `dragover` accepted a drag whose `types` held `Files`, and a macOS screenshot
  dragged off its own preview thumbnail (and a browser image drag) carries `text/uri-list`
  with no File object at all - so nothing called `preventDefault`, no `drop` event was
  delivered here, and Chromium's default action typed the URL into xterm's helper textarea.
  What reached the agent was `file:///var/folders/…/Screenshot%20….png`: a link shaped like
  an attachment, which no agent here can open, reported as "I dropped a screenshot and it
  is not adding as an image, it is still a URL link". `splitDropUris` (`shared/attach.ts`)
  turns a `file://` URI back into the path it is - percent-decoded, Windows' extra leading
  slash gone, a host kept as a UNC path - and an http(s)/data one still goes off to be
  fetched. `text/plain` is deliberately NOT claimed: a dragged word is Chromium's own paste
  into the terminal and is worth keeping. Verified in a real window: a uri-list-only drop
  now claims both events and the pane's log holds the decoded path and no `file:///`.
- `npm run test:attach`. Not covered: pasting an image on the phone client, which has its
  own composer rather than an xterm.

## What a pane costs is measured, not modelled

`capacity.ts` models a pane at 190 MB and answers "is there room for another". The chip in
each pane title and the total beside the Sessions count answer "which one is eating the
machine", and those are readings — `src/shared/usage.ts` (arithmetic) and
`src/main/usage.ts` (the platform commands and the timer).

- A pane is its pty's whole descendant TREE. Counting the pty loses the build the agent
  started, which is the only reading anybody needed.
- CPU is a delta of cumulative counters, never `ps %cpu` (a lifetime average) or a Windows
  perf counter. First sample has no CPU figure at all; a process first seen mid-flight is
  capped at the interval.
- The sampler does not read the process table while the window is hidden or minimised, and
  never has two reads in flight.
- `npm run test:usage`. Detail, and the four traps in full, in `docs/design-notes.md`.

## A reopened pane comes back with what was on its screen

The terminal's own scrollback is renderer memory, so before this every pane reopened blank -
most often right after the app updated itself. `test:restore` is a different promise: it
hands the agent its `--resume`, which brings back the conversation and not one line of the
screen. Why each rule below: `docs/design-notes.md`.

- **Nothing new is stored.** `history.ts` has appended every pane's raw output to
  `userData/history/<id>.log` all along; `tail()` reads the last `BUFFER_LIMIT` of it. The
  missing part was the **id**: a restored pane is a new session, so the desk carries
  `scrollbackId` (`snapshot()`) and `start()` seeds the buffer from it. Save the new id
  there and it restores nothing, silently, for ever.
- `tail` must not strip ANSI (`read` does, for search) and must cut on a line boundary. One
  dim line says where the old output ends, and it resets attributes first. `test:scrollback`.
- **It comes back with its own clock, and finishes the turn it was cut off in.** `snapshot()`
  wrote no fact a PERSON knows, so nine panes restored after an update read `engaged: false`,
  `runSince: null` - which the sidebar draws as no clock at all and a grey "ready" dot, both
  false about a live conversation. `shared/restoreTurn.ts` decides. The display clock is
  `openedAt`, its own field and deliberately NOT `createdAt`: three timers read that as the
  age of THIS PROCESS. A pane the restart caught mid-turn is continued through `queuePrompt`,
  off `runSince`, under the SAME switch as a turn the transport cut in half - and a pane that
  was not mid-turn, or was launched with its own prompt, is left alone. `test:restoreturn`.
- **Which restarts ask is one rule with one switch.** `askAfterUpdate` (Settings → Updates)
  makes an update restart obey the same offer as a quit or a crash. Off by default - asking
  several times a day costs more than the inconsistency - and inert while `restoreAfterUpdate`
  is off.
- **It is replayed at the width it was PAINTED at, and Fix cannot do this job.** Every agent
  CLI here draws in absolute column moves - one real line off this machine's log is
  `Cause:\x1b[10G...` out to `\x1b[143G`, because that pane was 159 columns - and a terminal
  CLAMPS a move past its own last column. Replayed into an 85-column pane the old screen
  therefore piles onto the right-hand edge, one word over the last, which is "the text at the
  top is broken and pressing Fix does not fix it": Fix asks the CLI to repaint the SCREEN, and
  the wreckage is in the scrollback where the agent has nothing to say. So `restoredTail`
  carries the old session's width out with the bytes (`colsOf`, off its history metadata),
  `Session.replayCols` takes it to the pane, and the pane writes that part of the buffer at
  that width and hands the terminal back afterwards - xterm re-wraps what is already in its
  buffer. **Only the part before the restore mark**, and only when the mark is still there: a
  pane that has printed past it holds nothing old, and staging then paints its own output at
  somebody else's width. The resize goes in the write CALLBACK, never after the call - xterm
  parses on its own schedule. Measured with a real headless xterm over the real bytes: at 85
  the sentence is destroyed, at 159-then-85 it reads back whole; and in a live pane 80 columns
  wide, intact. `shared/replayWidth.ts`, `npm run test:replaywidth`.
- **It presses Fix for itself**, which is the OTHER half - a frame drawn at 80x24 before the
  fit landed, not a scrollback painted at another pane's width. The tail was hard-wrapped at the old pty's width and is
  replayed into a terminal xterm opens at 80x24, so the frame that lands is regularly drawn
  at the wrong width. A pane that came back with history runs `repair()` once,
  `RESTORE_FIX_MS` (1.2s) after its output stops. It is `autoFixUi`'s; a mirror is refused; a
  hidden pane is FLAGGED rather than repaired against a 0x0 host. `test:restorefix`, whose
  control half is a brand new pane recording ZERO repairs.
- **The prompt tags come back with it.** The rail is built from KEYSTROKES, so a replay
  registers none. `seedMarks` scans the replayed buffer for the CLI's own `❯ <text>` echo,
  once, and only while the rail is empty. **`❯` only** - `>` starts a quote, a diff line, a
  shell prompt and a blockquote. A rebuilt tag carries no time (`at: 0`). `test:promptecho`.

**And `/clear` no longer takes the previous turn with it.** Three releases of Claude Code
have wiped the screen three different ways (`CSI 2J`+`3J`; an erase-per-row; a bare
cursor-up overdraw that erases nothing at all), so the answer stopped being a list of vendor
bytes:

- **The pane keeps the screen itself, before the CLI has emitted a byte.** `keep.arm()`
  (`shared/keepScrollback.ts`) is called when a submitted line matches `mayClearScreen` and
  RETURNS the scroll - the screen pushed into the scrollback, the cursor homed - which the
  pane writes on the spot. Whatever the CLI does next it does to a blank screen.
- **What was TYPED is not what was SENT**: `/cle` picked from the CLI's completion menu runs
  `/clear`, so a bare slash TOKEN that is a PREFIX of one of those commands arms too. A miss
  destroys the turn somebody is reading; a false arm only scrolls a screen about to be
  repainted, and only the rows holding something are filed (`used()`).
- **The composer is not history.** `keptRows` stops at the composer's top edge, and the
  composer is only believed when the CARET is between its two rules - otherwise a markdown
  separator in an answer swallows every row under it.
- **`arm()` is fed by keystrokes, and a keystroke is one of several ways a clear arrives.**
  The Clear button, the session menu, a phone and every path in main that types for you go
  through `paneArmClear` (TerminalPane) instead.
- **The unarmed case is caught by SHAPE, then by OUTCOME.** The cursor sent to the top of the
  screen with an erase as the first thing there is REPORTED, not acted on - one 8.4 MB pane
  log holds 152 ordinary repaints of that shape. The pane snapshots the screen and
  `shared/screenLoss.ts` decides once the redraw settles: filed only when **80%+ of the screen
  is gone** (a scrolling diff loses 35-44% and is left alone). The `2J`/`3J` rewrite stays for
  a CLI that clears unasked, and stands down for 10s after an armed scroll.
- `npm run test:scrollclear` drives a real headless xterm with a control per shape.

**And a prompt tag survives the CLI repainting over it.** xterm disposes every marker on a
row that `CSI J` blanks - measured by replaying this machine's own logs: Claude Code lost 0
of 278, Codex lost 25-50%. `shared/markAnchor.ts` re-anchors on a deferred callback when the
line is still in the buffer, and ends the tag only when the buffer has genuinely forgotten
it. Line 0 is the one that goes. `npm run test:markanchor`, whose control proves a bare
marker really does die.

## History says what each session was working on

A folder name and a clock do not answer "which of these eleven do I bring back", so every
row carries one line: the first thing that was typed at the agent, plus how many asks
followed.

- **It costs nothing.** No model, no tokens, no request. The line comes from keystrokes the
  app already relays on their way to the pty — the same feed `promptArchive` is built from,
  and for the same reason: it reads what was TYPED, so it works identically for Claude,
  Codex and whatever ships next. `shared/gist.ts` is only the tidy-up.
- **The FIRST ask, not the latest.** The opening ask is what a session was about; the
  twentieth is a follow-up inside it ("now the other file") and reads as nothing once the
  session is closed and its context is gone.
- **Scraping the transcript was tried and abandoned on the evidence**: across this
  machine's own pane logs, not one carried a recognisable prompt echo — a boxed composer is
  redrawn character by character and interleaved with its own repaints, so what lands in
  the log is not the sentence. A session that closed before the app recorded a line gets a
  best-effort one from the prompt archive (same project, inside its own window) and
  otherwise **no line at all**: a confident wrong sentence about which session to bring
  back is worse than none.
- **A session is several jobs, and `/clear` is where one ends.** The first ask describes a
  session that asked one thing, and is the first sentence of a long document for every
  session actually worth finding again: the context is thrown away at a clear and what
  follows is a new subject in the same window. So the ask that opens each CHAPTER is kept -
  the first one, and the first one after each clear (`noteAskInto` in `shared/gist.ts`,
  which reads a clear exactly as `keepScrollback` does, menu completions and all). The row
  shows three and counts the rest; the hover and the opened session print them numbered.
  A clear is a boundary and never a chapter heading, every other slash command (`/model`,
  `/doctor`) heads nothing, and `asks` counts only the ones that were WORK - a count made
  mostly of slash commands says the opposite of what it looks like. Twelve chapters are
  kept and anything past that is counted rather than dropped in silence.
- **What was asked survives a restart.** `recordStart` runs again on the same id when a
  pane comes back, and it used to write a fresh record - so the one kind of session most
  worth finding, a long one the app restarted itself for an update, went back to a folder
  name and a clock.
- **The transcript is RENDERED, not stripped.** A pane's log is a stream of REPAINTS, so
  `stripAnsi` puts every frame of an agent's thinking line on its own line: measured on a
  seeded 4 KB log, the old view was **205 lines of which 200 said `Thinking…`**, against
  **3 lines and none** through a terminal. The bytes go through an off-screen xterm and its
  buffer is what is shown - `renderer/src/termRender.ts`, ONE copy, shared with the phone's
  `TextSheet`, because two surfaces disagreeing about what a session said is the drift
  nobody notices. It is replayed at the width it was WRITTEN at (`cols` on the entry, kept
  in memory per resize and written when the session ends); stripping stays as the fallback,
  since a transcript that will not render is still worth reading.
- It is written outside the prompt-recall gate — that switch is about "you have asked this
  before", and turning it off is not a reason for History to go back to a folder and a
  clock. `npm run test:gist`.

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

## ...and it knows what is serving, and can stop one

"What dev servers are running" had no answer anywhere in this app, and the app already had
most of it: `devServers.ts` reads the process table for a handoff, but its answer is a
package.json SCRIPT - deliberately, because that is what the OTHER machine needs. A person
asking has the two things that throws away in their head: the PORT they cannot reach and
the pane it came out of. `shared/devList.ts` is that answer, `npm run test:devlist`.

- **One server, not one process.** Measured here 2026-08-21: `npm run dev -p 3100` and the
  `node .../next dev -p 3100` it spawned are both real, both recognised and are the SAME
  server - so a bare list said two, and "close the second one" would have killed a child of
  the first. A candidate whose ancestor chain reaches another candidate is folded into that
  ancestor (the thing a person typed, and the one whose kill takes the tree), and what the
  child knew - the port, the path - is folded upward, since npm's own title carries neither.
- **A number is not a port because it is a number.** `--max-old-space-size=4096` is full of
  them and a wrong port is worse than none: it is the one thing somebody acts on. Only
  `-p`/`--port`/`--port=`/`PORT=` count.
- **Attribution is two-legged**, same as the handoff path and for the same measured reason:
  the server on this desk had been reparented onto pid 1 with its npm parent gone, so a
  tree walk from the pane finds nothing. Tree first, then a path test against the pane's
  folder. **A server no pane claims is still listed** - the question is what is running on
  this machine, not what PaneForge owns, and an unclaimed one is the likeliest to be lost.
- **An ambiguous stop prints the list and asks.** "close the dev" with three running names
  none of them, so it picks NONE. Named by port, by pid, by pane, by project, by tool, by
  "the first one", or by "both". A generic label (`dev`, `start`, `serve`) never matches on
  its own - that word is in the question as often as the answer, so matching it made "close
  the dev in pane 2" name every `dev` on the machine.
- **The pid is re-validated in main before anything is signalled.** It came off a list a
  person then read and confirmed, and a pid is reused: one whose command line is no longer a
  dev server is refused out loud. SIGTERM, then SIGKILL for anything still up - a server
  killed outright leaves its port held, which is the failure somebody reboots over.
- The renderer supplies only the ORDER and the words (which pane is 3, what that project is
  called); every fact - the folder, the pty pid - is read in main off the pane's own record,
  so a caller cannot point this at a folder it does not own. Read on demand when the ask box
  opens, never on a timer: it is a whole `ps -Ao command=`.

## The resource ladder has a face

`capacity.ts`, `autoHandoff.ts` and `reclaim.ts` trim, move and close panes on their own, and
their entire output used to be a `console.info` nobody had a window open for.
`shared/mascot.ts` is the mouth, `components/Mascot.tsx` draws it, `npm run test:mascot`.
Full reasoning: `docs/design-notes.md`.

- **It is not a model.** Every sentence is arithmetic over readings the app already holds,
  and every typed command is a small parser over the same list. Nothing leaves the machine,
  so it costs nothing to leave on.
- **What it says names the pane, what that pane was in the middle of, and when.** `Closed a
  pane, about 190 MB back` answers none of the three questions somebody has when a pane they
  were using is gone. `paneWord` is now `taskdriver pane 1` (the project first - the number
  is the Ctrl key, the project is what is in your head), the subject comes off
  `Session.gist` - History's own line, pushed onto the LIVE session because by the time a
  disk read came back the pane it names is closed - and the time is `agoWords`, rebuilt as
  the bubble draws rather than written once, so a report that has sat in the corner for ten
  minutes stops reading as something that just happened. A pane nobody has typed a real ask
  into says nothing about one: a confident wrong subject is worse than none.
- **A bubble takes itself away** (`mascot.hideSeconds`, 60s, 0 = until pressed). Everything
  it says is a READING and a reading left on screen stops being one. The clock restarts on
  every keystroke in the ask box, and a COUNTDOWN is exempt - that bubble has a deadline of
  its own and the press that stops the close is on it, which is the load-bearing case in
  `test:mascot`.
- **A guess is never an action.** "close pane 9" with five panes closes nothing and says how
  many there are; names match longest-first with a contained name dropped (`service` inside
  `service-a`); every destructive intent is OFFERED as a press. `closeable()` is `reclaim.ts`'s
  own refusal set, so it can never suggest something the sweep itself would refuse.
- **A finished turn is the pane this ladder exists for, and for weeks nothing could see one.**
  `fleetState` says `needsYou` both for a live question and for a finished turn, so
  `closeable()` and `CLOSEABLE` - both written as `ready | exited` - refused every pane anybody
  would want closed. The refusal that was meant is the pane's own live question (`asking`, off
  `Session.ask`), never the word for its state.
- **Nothing decides and then reports: it counts down first.** Both sweeps hand their plan to
  `armCloseRef` and the mascot draws `CLOSE_COUNTDOWN_MS` (15s) with the pane named, `Keep it
  open` and `Close now`. Doing nothing still closes it - a sentence with a clock in it, not a
  dialog. `Keep it open` holds those panes for `KEEP_MINUTES` (60). With the mascot hidden
  there is nowhere to draw a count, so it closes on the spot.
- **It speaks unasked once per situation**, and only where the app is otherwise silent: two or
  more finished panes, quiet over an hour, over 1.2 GB, with the idle-close clock OFF. What
  the ladder DID always gets a sentence.
- **There are TEN of them and they cost the same** (`src/shared/pets.ts`). The animation is
  keyed on the SLOT rather than on the animal - `m-arm-*` is a settle on three frames whether
  the pet means a tail, a wing, a claw or a drip, `m-treads-*` is the slow tick - so a new pet
  is ART and nothing else: no keyframes, no timers, no cost. Only the picked one is ever
  mounted, each layer is walked into runs once per app run and cached by identity, and the
  whole rig is `animation-play-state: paused` behind a minimised window. Every pet is on the
  SAME 24x24 grid, which is a decision about PIXELS: drawn at 48 CSS px that is exactly 2
  device pixels a cell and `crispEdges` never has a half pixel to resolve - a "more detailed"
  32x32 pet would be 1.5 and is the blur the grid replaced. Detail comes from layers and
  shades, never from more cells. A pet may leave a slot out and be stiller; what it may not do
  is float, and `test:mascot` fails on a `translateY` anywhere in that stylesheet.
- **It arrives OFF.** A pet is decoration before it is a reading, so it is asked for rather
  than arrived with (Settings -> the ten, under the ladder's own switches). `defaults()` is
  written at first launch, so a desk that already had the robot keeps it: only a new install
  gets the off.
- **It runs about, rarely, and every condition is a refusal** (`dueDash`, `DASH_EVERY_MS` 9
  min): nothing to say, where the app put it, `roam` on, and somebody looking at this window.
  The run is placed at the start line with the transition OFF for one frame (`dash-port`) and
  is then a single `left` transition with a ball ahead of it; without that frame the browser
  coalesces both writes and the pet slides gently to the start instead of appearing there.
- **It can be picked up.** Pointer events, captured, storing the GRAB offset (writing the raw
  pointer teleports it under the cursor); a drop writes `mascot.spot` as a fraction of the
  window and **beats every automatic move**. The pin icon gives it back. Under `DRAG_SLOP` the
  gesture is still the press that opens the bubble, and the click after a real drag is refused
  from a REF.
- **The bubble is placed in the LAYER, in pixels** (`bubbleSpot`), clamped inside the window
  on both axes, above the sprite when there is room and above ANYWAY when there is room for
  neither. As a flex child of the sprite's own centred box it shoved the sprite ~155px
  sideways and hung off the edge. Unmeasured counts as full width.
- **The layer never takes a click**: `z-index: 40`, over the panes and under every dialog,
  `pointer-events: none` except the sprite and its bubble. Never focuses, never raises.
- **Mute by default** - nothing the app decided by itself may make a noise into a room.
- **It never picks which machine**: `hand off pane 2` opens the box with the panes chosen.
- A press closes whichever half is up.

## ...and one card says what this app can even do

Most of what is in this file is invisible from the window: a highlight in a pane can be
DELETED, a phone is this window, a pane can be handed to another machine mid-turn. None of
it is discoverable and none of it is worth a dialog, so it is one quiet card in the
bottom-right - `shared/tips.ts` for the catalogue and every judgement, `components/Tips.tsx`
for the card, `npm run test:tips`.

- **It costs nothing**: a fixed sentence, chosen by arithmetic over what has been seen. No
  model, no request, one minute tick that almost always does nothing.
- **It never interrupts**: silent while any dialog is open, while an update card is up, while
  ANY pane is holding a question, behind a minimised window, and for the first four minutes
  of a session. `FIRST_MS` 4 min, `EVERY_MS` 40 min, and the load-bearing half of the test is
  those negatives.
- **It says how to stop it before anybody has to go looking**: the first card and every fourth
  after it carry the sentence and the button (`offersOff`). Settings is the way back on.
- **It cycles rather than repeating**: every tip is shown once before any is shown twice, and
  `seen` resets rather than going quiet - a tip added in a later version has to be able to
  reach somebody who has already been round.

## A session that clears itself asks first

`claude-config/autoclear.mjs` (a Claude Code Stop hook) decides a session is past its
context line AND that its handoff lists work a fresh session could start, and asks this app
to clear that pane. It used to type `/clear` into the pty itself, so the first anybody knew
was the session already gone.

Now it asks over the phone server (`pane-clear.mjs` -> `autoclear:ask`) and the desk draws a
countdown card: what would be continued, how long is left, **Keep this session** and **Clear
now**. Nobody at the desk means it still happens by itself - that is the point of the
feature, a clear that needs a person is a reminder.

`shared/autoclear.ts` holds every refusal and `main/autoclear.ts` the clock; both are
re-evaluated against a FRESH pane reading each tick, so a pane that starts another turn, is
typed into, exits or disappears drops its countdown. An ask with no open steps is refused at
both ends. A PaneForge older than the channel makes the hook REFUSE rather than fall back to
the instant clear. `npm run test:autoclear`.

## The screen stays on while a pane works

`shared/awake.ts` + `main/awake.ts` hold a `powerSaveBlocker` while any pane has an agent
mid-turn or is sitting on a question, and let go when the desk goes quiet. On this Mac
`displaysleep` was **1 minute** on battery, so a ten-minute turn ran behind a black screen
and the question at the end of it was never seen.

The cap is the load-bearing part: it is on the BUSY STRETCH, not on the hold, so a wedged
pane (which keeps `runSince` for as long as the app is open) cannot keep a laptop lit all
night, and cannot re-arm the hold by ticking. `config.keepDisplayAwake` turns it off.
`npm run test:awake`.

## Checks

`npm run typecheck` before committing, and `npm test` — 81 checks in ~145s, everything in
that list needing no window, no network and no real agent CLI (`scripts/test-all.mjs`). It
is also the release gate's third step: `agentGate.ts` looks for a script called exactly
`test`, and while there wasn't one every lane the app drove reported its suite step as
*skipped*. **A new cheap test goes in that list or it never runs by itself.**

Each row below says what its test PINS. The reasoning - which case is load-bearing, which
control proves the test would fail, what the numbers were - is in `docs/design-notes.md`.

| Command | Covers |
|---|---|
| `npm run smoke` | the pty layer |
| `npm run test:restore` | which conversation a reopened pane goes back into |
| `npm run test:scrollback` | and what is on its screen when it gets there |
| `npm run test:replaywidth` | ...drawn at the width it was drawn at: a real 159-column frame off this machine's log, with the shipped behaviour (write it at 85) kept as the control that must FAIL, and the refusals that stop a pane painting its OWN output at somebody else's width |
| `npm run test:restoreturn` | what else it inherits: the display clock, the engaged flag, and continuing a turn a restart cut in half (with the refusals, and source assertions so a green test over a function nothing calls cannot pass) |
| `npm run test:promptecho` | rebuilding a restored pane's prompt tags from the CLI's own `❯` echo, and the four things that must NOT become tags (a `>` quote, a diff, a shell prompt, the live composer) |
| `npm run test:consoles` | sweeping console hosts left behind |
| `npm run test:strays` | what a PANE left running (real orphans, ~25s) |
| `npm run test:gitpoll` | the badge's `git status` cache, over a fake clock |
| `npm run test:install` | quitting takes the install pty's whole process tree |
| `npm run test:lanes` | lane engine, worktree sweep, ownership, the any-repo release contract |
| `npm run test:laneargs` | what `runSafe` hands a program, through a real cmd.exe |
| `npm run test:laneforeign` | a DIFFERENT repository's clone sitting at a lane's path: named and refused, its commits untouched. The control is that it passes the old `--is-inside-work-tree` test |
| `npm run test:lanepeers` | the arithmetic of the other desk's claim, and the negatives: a desk never blocks itself, an unrefreshed claim stops counting, a letter lane is nobody else's business |
| `npm run test:lanedevice` | the same with real plumbing (a bare repo, two clones, one told it is another machine) - and the two locks that looked right and were not, kept as controls |
| `npm run test:gate` | what stops an automatic release: a chat that said done and kept typing, a red `npm test`, and that the refusal is CACHED on the commit |
| `npm run test:notes` | release-note ranges and both template shapes |
| `npm run test:pickrelease` | the newest release carrying an asset THIS platform can install, so a win-only build is skipped rather than 404'd at for ever |
| `npm run test:promote` | a soaked dev build promoting to stable with a younger one on top of it |
| `npm run test:remote` | the device link end to end over a real loopback socket, including the size BORROW: a mirror lends its grid to the far pty, it arrives flagged as a borrow rather than as an owned resize, a pane this device does not watch is never resized, and looking away returns that pane's size and only that pane's |
| `npm run test:pairask` | six digits that agree between two ends, and DISAGREE through a real relay |
| `npm run test:handoff` | a pane moved whole over a real link and real git, and the refusals (dirty far checkout, unpushed far commits, a folder outside the root) |
| `npm run test:handofffit` | that the hand-off box can still be answered with real machine names in it, measured with a Range over the text |
| `npm run test:theme` | palette derivation + contrast (358 assertions) |
| `npm run test:autoclear` | the countdown in front of an automatic /clear: every refusal (no steps, the pane started a turn, somebody typed into it, the pane went away), that Cancel types NOTHING, and that the three keystroke chunks arrive in order |
| `npm run test:awake` | holding the display awake while a pane works, and letting go: the setting off, the desk quiet, and the CAP on one unbroken busy stretch (which a wedged pane may not re-arm) |
| `npm run test:stashtheme` | that the Stash picks no colour of its own, and asks the theme rather than the OS which way round it is |
| `npm run test:sounds` | the alert catalogue: nothing silent, nothing clipping, uploads |
| `npm run test:blurbs` | the "what this is" note on each feature, and that each is rendered |
| `npm run test:place` | the words a pane's strip prints (56 assertions) |
| `npm run test:surfacereach` | that every method the window exposes has a way IN: for each key of `SURFACE`, a call site under `src/renderer/src`. A handler with no caller passes typecheck, the suite and surface parity - `remote:handoffCancel` and `listJobs` both shipped that way. Four are desk-side on purpose and each names who calls it instead |
| `npm run test:mirrorfit` | how a mirrored pane draws somebody else's grid, and every way that walk fails to converge: the shipped `Math.round` stalls a column short, flooring only the shrink cycles 11/12/11/12 for ever, and the bare font floor leaves a wide grid simply cut off. All three kept as controls. It also pins the other direction - a host grid SMALLER than the room grows past the user's own font up to `MAX_FILL_FONT` (28) and the leftover is split evenly, because a mirror capped at the user's font drew the PC's 69x35 as 518x525 in a 1191x880 pane: a block of text in the top-left corner of a black pane, which reads as broken rather than as small. The no-`fillFont` case is kept as the control that the old behaviour is untouched |
| `npm run test:panejob` | what a shell pane is running, and the refusals that are the feature: a shell at its own prompt, a subshell, an agent CLI reporting its own runtime. The last block asks a REAL pty, which is the half no fixture can check |
| `npm run test:desk` | the sessions list with both machines in it: a device that is offline lists nothing, a mirrored pane is not offered twice, a listed pane carries no Ctrl+N number, and a source assertion that every field `FleetPane` ranks by is actually forwarded from the peer |
| `npm run test:agentenv` | the environment a pane's agent starts with: a provider is a catalogue entry with two variables set, an unanswered placeholder is DROPPED rather than handed over as a credential, and one provider's key cannot fill another's variable |
| `npm run test:orcatalogue` | the live model list: a model with no tool calling never reaches the menu, an empty or broken answer leaves the built-in list exactly as it was, nothing is capped (a cap inside a filter box is a search that silently finds nothing), both prices are on every row, and a stealth model says in the picker that an anonymous provider keeps your prompts |
| `npm run test:devicewatch` | noticing a copied cookie - and the negatives that decide whether the mark is ever read (a phone leaving the house, an iOS bump, a reloaded tab) |
| `npm run test:projects` | which folders are projects and which are copies of one (`service-a` beside `service` stays a project) |
| `npm run test:cardfit` | that a session card can still be read at 190px once a lane loads it up |
| `npm run test:confirmfit` | that the yes/no box can still be answered - the three faults were all the dialog SHELL (a sticky footer, `margin-left: auto` beating the confirm's own `flex-end`, uneven button heights) |
| `npm run test:diff` | reading a repo's changes: `-z` records, renames, patch numbering |
| `npm run test:railplace` | where a prompt tag is drawn (no window) |
| `npm run test:grid` | layout arithmetic, no window needed |
| `npm run test:turncopy` | where a turn's two copy icons go, and the reply range that is off by one in the direction that pastes perfectly and is wrong |
| `npm run test:cursorclick` | the keys a click sends, the clicks refused, and that a BARE click emits no vertical arrow at any input |
| `npm run test:stickyselect` | that a highlight stops moving when the mouse is let go, with the capture-phase `stopPropagation` kept as the control |
| `npm run test:promptbox` | telling a CLI's drawn input box from a zsh prompt, a diff and a markdown table |
| `npm run test:promptsubmit` | that a pane opened WITH a prompt sends it: nothing typed while booting, the return as its own keystroke, re-sent while still idle, never once working |
| `npm run test:choices` | reading a live question off a frame, two real captured shapes, the negatives (a numbered list in an answer, a quoted one, a gap, no arrow) and that the arrows really are escape bytes |
| `npm run test:askclick` | that a click on a pane holding a question types NOTHING - real mouse input through CDP, with the control that the same click with no question still sends its arrows. Needs a window |
| `npm run test:askrender` | the countdown on a real question - drawn in the pane, on the card, and ticking once a second - and what arrowing costs every OTHER pane (the bystander's count is the load-bearing half). Needs a window |
| `npm run test:autoanswer` | which questions may be answered for you: every wording of "and stop asking me", the timing over a fake clock, and source assertions on the state the guards read |
| `npm run test:anim` | what a looping decoration may cost: `transform` and `opacity` only (a `box-shadow` ring measured 136% of a GPU core against 36%) |
| `npm run test:attach` | a picture in front of the agent: bytes land on the machine owning the pty, the extension comes off the magic bytes, an oversized batch writes nothing, and `../../.ssh/authorized_keys` cannot leave the folder |
| `npm run test:asknotify` | a question on its way to Telegram: names the pane, keeps the CLI's numbering, silent with no credentials, and never asks for updates |
| `npm run test:settingsearch` | that a setting is findable by what it DOES - the index is generated from the dialog's source, so one added without regenerating turns this red |
| `npm run test:onestash` | that there is one Stash |
| `npm run test:stashsummon` | that it is not on screen until asked for, and opens at the pointer's own display |
| `npm run test:panesize` | who owns a pane's shape when a desk and a phone both draw it |
| `npm run test:tunnel` | a URL never called up before it resolves, a cloudflared that hangs settling anyway, and the per-platform asset names |
| `npm run test:funnel` | which machine can be funnelled, which refusals mean "quietly use cloudflared", and that stopping SAYS so |
| `npm run test:gist` | the one line History puts under a closed session |
| `npm run test:qr` | the pairing QR, by DECODING it - every version at every mask |
| `npm run test:stash` | what the Stash may cost (no list carries a body), and what follows: search in main, an edit keeping its row |
| `npm run test:conceal` | what the Stash may not remember: markers only, never a guess at secret SHAPES |
| `npm run test:pipe` | the live tee; ANSI stripping across chunk boundaries |
| `npm run test:copymode` | keyboard copy mode arithmetic |
| `npm run test:silence` | the quiet-turn alert; an idle pane is NOT stalled |
| `npm run test:discord` | Rich Presence against a fake Discord over a real named pipe |
| `npm run test:voice` | dictation: which transcriber, and a spoken clip through it |
| `npm run test:recall` | "you have asked this before", and PARITY with the canonical fingerprint |
| `npm run test:rename` | the folder rename, on a throwaway repo |
| `npm run test:dock` | the macOS Dock icon |
| `npm run test:macupdate` / `test:macdownload` / `test:wedge` | replacing our own bundle, every way a download can end, and that no hung promise leaves the updater needing a person |
| `npm run test:history` | what transcripts may cost |
| `npm run test:scrollclear` | that an agent's `/clear` stops destroying the scrollback - all three byte shapes it has had, a sequence torn across chunks, and a control per shape proving a plain terminal loses it |
| `npm run test:markanchor` | that a prompt tag survives the CLI erasing its row, with a bare xterm marker as the control |
| `npm run test:quitwords` | telling a Cmd-Q from an outside kill; the load-bearing case is the false positive |
| `npm run test:recover` | finishing a turn the transport cut in half, and the refusals (a rate limit, an error somebody QUOTED) |
| `npm run test:reclaim` | closing idle panes: pressure is the trigger, a pane waiting for a person is never closed, the window is never emptied |
| `npm run test:capacity` | how many panes a restore starts ticked, red-proofed against the warn branch |
| `npm run test:mascot` | what the mascot may do to somebody's panes, its four silences, and that every pose it defines is drawn |
| `npm run test:autohandoff` | moving a finished pane instead of closing it: mid-turn is QUEUED, a live question is not moved, a queue expires rather than interrupting |
| `npm run test:devlist` | what is serving now and which one a sentence names (a server and its child are ONE; "close the dev" with three running picks none) |
| `npm run test:backjobs` | what a machine runs with no pane on it: a hook alive for 300ms is not a job, a pane's own build is never listed twice, `--max-old-space-size=4096` is not a port, a dev server an agent started is a second fact - and a last block that reads THIS machine's real process table, because the `etime` parsing is the half a fixture cannot check |
| `npm run test:devservers` | turning a running server back into the package.json script that starts it, and the drops |
| `npm run test:macsign` | the signing that stops TCC resetting permissions every release |
| `npm run test:winshortcut` | whether a launch puts the Desktop shortcut back, and the three refusals |
| `npm run test:winfeed` | which release the Windows dev channel may pin its feed at |

Needing a real window (`npm run build && npm run try -- --keep --show
--remote-debugging-port=9333`): `test:view`, `test:stashdrag`, `test:activate`,
`test:turncopyview` (happy minimized), `test:restorefix` (two launches),
`test:askclick`, `test:askrender`, `test:devicesfit`, `test:phoneview`.

`test:devicesfit` measures the Devices panel in the running app: two columns on a window
wide enough, the shell itself never scrolling, and nothing reaching the Close button. Both
faults were real and both were measured at 1500x912 - **1057px of content in an 812px box
with nothing paired**, and a sticky footer with a background but no cover strip above it,
so 228px of content sat under the button. Red-proofed by putting the single column and the
missing `padding-top` back: 4 of its 6 checks fail.

Out of the default suite because they need the network: `test:discordbrand` (asks Discord
what `DISCORD_APP_ID` is called AND whether `PRESENCE_IMAGE`'s asset still exists - the two
halves fail separately), and `node scripts/mac-update-test.mjs --live <version>` (~120 MB).

Other agent-runners are watched by `npm run competitors` (`npm run test:competitors`), which prints only what moved.

## A turn the transport cut in half finishes itself

An agent whose stream dies mid-answer prints an error and returns to its composer. The
session is fine - context intact, CLI healthy, pane idle and green - and the only thing
between it and the rest of its answer is somebody typing `continue`. `shared/recover.ts`
is that decision and nothing else. `npm run test:recover`.

- **It keys on the SECOND sentence.** Measured over the 557 MB of pane logs on this
  machine, five different first sentences have already shipped (connection closed, response
  stalled, connection lost, the response stopped arriving, server error) and every one ends
  `The response above may be incomplete.` That sentence is the CLI stating the precise thing
  that makes resuming safe: cut off rather than refused. The first sentence is a vendor's
  wording and is the wrong half.
- **A rate limit, usage limit, credit balance, auth failure or overload is never
  continued**, even carrying that sentence. The CLI retries what deserves retrying.
- **An error somebody QUOTED is not an error.** Once submitted the CLI echoes it back into
  the transcript with no box around it and the full string intact - this desk's logs hold
  exactly that, twice. What separates them is the marker a CLI draws in front of a person's
  words and never in front of its own errors, so a line starting `> ` is somebody talking. A
  copy still being typed is caught by `promptBox`'s frame instead.
- Three in a row and it stops; only output since the last look is read (the error line
  stays in the buffer for ever); and the send goes through `queuePrompt`, so it waits for an
  idle composer and confirms the return took.

## A full machine gets its panes back

`capacity.ts` gives back scrollback, which is the part the app can return instantly and is
about 5% of the bill: measured here with twelve panes, trimming all of them returns ~74 MB
of the ~1.5 GB they hold, because the cost is the agent CLI inside the pane (~190 MB each,
against 16-17 MB for a Codex one) and not the pane. `shared/reclaim.ts` returns the agent,
by closing the pane. `npm run test:reclaim`.

- **What makes that defensible here and nowhere else**: `kill()` calls `recordEnd`, so a
  closed pane keeps its History row, its `resumeId` and its `scrollbackId`. Reopening
  restores the conversation AND what was on the screen (`test:restore`, `test:scrollback`).
  A closed pane in this app is a minimised pane in any other.
- **Pressure is the trigger, never a clock.** A pane idle six hours on a machine with room
  is costing nobody anything, and closing it is the app tidying up after somebody who did
  not ask. Idle time only breaks ties once the kernel is already objecting.
- **A pane waiting for a person is never closed.** `needsYou` is the one that would feel
  like theft: the agent asked a question, so it is quiet BECAUSE it is owed an answer, and
  every "is it idle" reading in the app says yes about it. Nor is the focused pane, one on
  screen, one that is working or starting or stalled, or a mirror of another device's pty.
- **The window is never emptied.** An app that closes its own last pane under memory
  pressure has removed the reason the window is open.
- **There IS a clock, and it is off.** `reclaim.idleCloseMinutes` closes a pane nobody has
  typed into for that long whatever the memory says; 0 is the default, so the paragraph
  above still describes every desk that has not asked otherwise. The switch sets
  `IDLE_CLOSE_MINUTES`, which is **30 minutes** - it was 120, priced on "being early closes
  a pane somebody was coming back to", which is a click that restores the conversation and
  the screen against ~190 MB of agent doing nothing for two hours. It exists for the second
  machine — a desk driven over the device link, which fills with finished panes and has no
  person to close them. Every refusal above is shared verbatim except **visible**, which it
  cannot keep: on a machine nobody is at, every pane in the grid is "on screen", and
  protecting them means the feature can never fire where it was built to. `idleClosePlan`,
  its own minute timer in `App.tsx` (time passing is the thing it watches, and nothing about
  a quiet pane changes to announce it), `npm run test:reclaim`.

**And a restore is the one moment N agents start in a single tick.** Everything above
gives memory back a pane at a time; the restore dialog was handing it out six at a time
with every box ticked, which on 2026-08-17 produced a desk that came back and would not
accept a keystroke (16 GB, kernel pressure 2, six `claude` CLIs at ~197 MB apiece before
any of them compiled anything). `restorePlan` in `shared/capacity.ts` decides how many
start ticked: everything at normal pressure, **two** at warn, **one** at critical, and
never zero while there is a pane to offer — same rule as the window never being emptied.
The numbers are small on purpose and that is only safe because nothing is lost: an
unticked pane keeps its conversation and its screen and is one click away in History. It
is a **preselect, never a cap** — a restore somebody wants whole is theirs to tick. The
reading comes from `readPressure()` at the moment the offer is built, not from
`lastPressure`, which on a cold launch has not necessarily sampled yet and would report
`normal` on exactly the launch this exists for. The silent paths (an update restart,
`restoreAfterRestart: 'always'`) are deliberately untouched: capping them would drop panes
with nobody asked. `npm run test:capacity`, red-proofed against the warn branch.

## ...and before it closes one, it tries to move it

Closing a finished pane gives the memory back and stops the work. A paired device sitting
idle is the better answer, and every piece of it already existed: `Hand off` moves a pane
whole, `offloadTarget` already knew which peer could take a project. Nothing joined them,
so the app's only automatic answer to a full machine was the destructive one. The ladder is
now four rungs, each firing only where the one above it did not solve it: trim scrollback
(~5%) → start the NEXT pane over there → **move a finished pane over there** → close it.
`shared/autoHandoff.ts` is rung three; `npm run test:autohandoff`.

**...and none of that fires until something has already gone wrong, which is the wrong
moment.** Both triggers were readings about a machine in trouble - the kernel's memory
verdict, or a pane quiet for half an hour - and a laptop that is meant to be the SCREEN for
work running on a second machine is asking a different question: not "am I full" but "how
many agents do I run at all". So `Machine.keepLocal` (`autoHandoff.keepLocal`, **2**) is a
budget, `Verdict.over` is how many panes are past it, and `budgetPlan` moves exactly that
many. Measured on this desk while writing it: pressure `normal`, load 0.53 per core, five
`claude` panes -> `over: 3`, `why: 'budget'`, `offload: true` at `level: 'ok'`.

- **The budget is a policy, so it holds at `ok`** - which is the one sentence in
  `offloadTarget` that had to change. A desk that says it keeps two agents is not in
  trouble with five open; it is three panes past what it asked for, and the launch sends
  the next one over there for that reason alone.
- **It is the only rule allowed to move a pane that is ON SCREEN or MID-TURN.** Those two
  gates only ever meant "there is no emergency" - and with the grid on, `visible` is every
  pane, which is why the pressure sweep could never fire on a one-window desk. Past the
  budget there is no emergency and the move is still right. A busy pane is picked LAST
  (`rank`: quiet-and-offscreen, then quiet, then mid-turn) and goes through the same queue,
  so nothing is killed mid-answer; `queueable` is the wider set `movable` cannot be.
  Everything that could lose work is refused unchanged: the focused pane, a live question,
  a mirror, one already moving, one on a failure cooldown, the last pane on the desk.
- **The number moved is the overshoot, not `maxPerSweep`.** That cap exists so a machine
  under pressure re-reads its own recovery between moves; here the number is not a guess
  about how much would help, and moving two of five per minute while somebody opens panes
  faster than that never converges.
- **Lag is read as well as memory, and the worse of the two decides** (`lagLevel`,
  `worstPressure`). Memory pressure is the kernel admitting it has already lost: this desk
  sat at `warn` for an afternoon with nine agent CLIs up while the load average ran at
  **8.70 on 10 cores**, which is the number that had actually moved. One runnable thread
  per core is `warn`, 1.8 is `critical`. NOT a CPU percentage - the desk that produced
  these figures had 32.73% of its CPU idle at load 105. `os.loadavg()` is 0 on Windows, so
  0 means "nobody measured" and never "idle": an absent signal may not move a pane.
  `watchPressure` watches the lag BAND too, or a desk whose memory is steady while its load
  climbs is never told.
- **Nothing asks any more.** `offloadAsk` defaults off with a one-time `offloadDefaultsV2`
  migration (the `migrateAutoAnswer` shape - read off the SAVED config, or the marker is
  set for everybody and the migration runs on nothing). The dialog was right while the app
  could see the memory and not the reason to keep the pane here; a budget IS that reason,
  given once.
- **A pane is never handed back where it came from**, which is the one failure mode a
  policy has that a pressure reading does not: two desks each keeping two agents are each
  correct about their own budget and would pass one pane between them for ever. The sender
  puts its own id in the payload (`senderDevice`), the receiver stamps it on the pane
  (`arrivedFrom`), and `hostFor` skips that device. A second machine that did not send it
  may still take it - the refusal is about WHERE it came from, not that it arrived.
- Both hardened like `offloadMinutes` and for the same reason - these come off config.json
  and off `pf-ctl call config:set`, so `true` is not a budget of one (`keepLocalOf`).

- **A pane mid-turn is queued, never killed.** A handoff ends in `kill()`, and a pty killed
  mid-answer loses that answer for good: the far end resumes from the transcript file, which
  holds only turns the CLI has already flushed. Refusing a busy pane would be honest and
  useless, since the pane worth moving is usually the one working - so `main/handoffQueue.ts`
  holds it and moves it the instant the turn ends. That is what "hand it off mid-turn" means
  here. A pane that never goes quiet **expires** after `waitMinutes` and stays, said out
  loud; nothing is ever killed to make the queue progress. **And the chip that reports the
  wait is the control that ends it**: `remote:handoffCancel` shipped with the queue and
  nothing in the window ever called it, so the only way off the list was a script - two
  panes sat under a `waiting` chip for 13 and 18 minutes on 2026-08-23 while their own
  turns ran. Pressing the chip, or `Keep it here` in the card menu or the phone's sheet,
  drops the entry; a move already IN FLIGHT has left the queue and says so rather than
  claiming a success it cannot deliver.
- **`undefined` means keep the stamp; only `null` clears it.** `handoffQueuedAt` is what
  makes the chip say `waiting 12m` instead of `moving`, and EVERY entry into a handoff
  paints the pane before it knows which of the two this is - the button, a second press,
  the budget sweep asking again. While `setHandingOff(id, on, queuedAt?)` cleared on an
  absent third argument, any of those silently turned a queued pane into one that reads as
  in transit and never arrives. Measured live 2026-08-23: `handingOff: true`, no
  `handoffQueuedAt`, and `remote:handoffPending` listing that same pane - "I pressed hand
  off, it says moving, and it is not moving". `run()` is the one caller that passes `null`.
- **The turn ending is an EVENT, not something to poll for.** `handoffQueue.poke()` on
  every `sessions` change is what makes "as soon as the turn ends" mean it, instead of up
  to `TICK_MS` (5s) of a finished pane sitting under a `waiting` chip. Free when nothing is
  queued; the tick stays as the backstop, since an expiry has no event to hang off.
- The local half of a move is not where the time goes: measured on this Mac, the whole
  preparation is ~100ms (git `status` and `rev-list` 23-25ms each, the process table 43ms,
  a 2.7 MB transcript read in 3ms), and the push is SKIPPED outright when nothing is
  unpushed - the 1015ms it costs is the one leg worth avoiding, and already is.
- **A pane holding a question is never moved, queued or otherwise.** The chooser is drawn on
  a screen and lives in no transcript. `fleetState` calls both a finished turn and a live
  question `needsYou`, which is why `AutoPane.asking` is separate: a finished turn is the
  best moment to move a pane and a live question is the one moment that must not be.
- Every other refusal is `reclaim.ts`'s, verbatim: pressure is the trigger, the focused pane
  and anything on screen are left alone, a mirror is somebody else's pty, and the window is
  never emptied. A failed move puts that pane on a `cooldownMinutes` hold - a repo that
  cannot be pushed will not become pushable in fifteen seconds.
- **...and those last two refusals are exactly why it could never fire.** `visible` is a
  refusal because moving something off somebody's screen while their machine is busy is
  theft - but with the grid on **every pane is visible**, so on a one-window desk the
  eligible list is empty at every pressure there is, and pressure itself arrives long after
  the lag does. So `idleOffloadPlan` is the opt-in clock beside it
  (`autoHandoff.offloadIdleMinutes`, 0 = off, the switch sets 30), the same shape as
  `reclaim.idleCloseMinutes` and for the same reason: it drops `visible` and the pressure
  gate and **nothing else**. Three times what the pressure sweep waits, because being early
  under pressure costs a reopen and being early here moves work somebody was coming back to.
  Its own minute timer, since the thing it watches is time passing. The load-bearing test is
  a PAIR - the pressure sweep still refuses a visible pane, the clock takes it - because
  either half alone passes while the feature stays dead.
- **`handingOff` is on the Session, and `reclaim.ts` refuses it.** Without it the closing
  sweep and the moving sweep race over the same pane, and closing wins by being faster: the
  same memory back, the work lost. Every exit from a move clears it, refusals included, or
  that pane is one nothing will ever touch again.
- The sweep runs in the renderer beside `reclaim` (it needs `visibleIds`, which main does
  not have) **and on a 60s clock**: a desk that is full and quiet emits no session events,
  and that is precisely the desk this exists for.

**And the dev server travels with it.** `kill()` takes the pty's whole tree, so `npm run
dev` died here and nothing over there brought it back - a pane arriving at a project whose
server is not running reads as the handoff half working. `shared/devServers.ts`,
`npm run test:devservers`.

- **The server is routinely not a descendant of the pane.** Measured here 2026-08-17:
  `node <repo>/node_modules/next/dist/bin/next dev -p 3009` was on **ppid 1**, its npm parent
  long exited, so a walk down the pty's tree finds nothing. A process is attributed by the
  tree OR by its command line naming a path inside the pane's repo, and the second is what
  catches the case that matters.
- **What is running is not what would be typed**, so the observed argv is not what travels.
  Nobody types that line; they type `npm run dev`, and the port came out of the script.
  Re-issuing it hard-codes a port that is taken over there and runs a binary out of a
  `node_modules` the receiver may not have. So an observed process is turned back into a
  package.json **script name**, and the receiver rebuilds the command from its own
  package.json and its own lockfile.
- **The payload therefore cannot name a command, only a script**, re-validated against
  `SCRIPT_NAME` on arrival because a check made on the other machine is a claim. The worst a
  malicious payload can reach is a script that repo's own author wrote. It lands in an
  ordinary `shell` pane - on screen, killed with the pane, already swept by `strays.ts`.
- **An ambiguous match is dropped and named**, never guessed: a tool matching two scripts
  (neither called `dev`) reports which two. `npm run build` and `npm test` are not dev
  scripts and never travel - re-running those on the far end repeats work at best.
- Only long-running script names travel: `DEV_SCRIPT` is `dev|start|serve|watch|preview`,
  with or without a `:suffix`.

## What Windows loses between restarts

Two of them, neither announcing itself, and both read as the app being broken.

- **The Desktop shortcut.** `build/installer.nsh` deleted `$DESKTOP\PaneForge.lnk` on every
  run: `IfFileExists ... 0 +2` skips exactly ONE instruction, so the guard covered the RMDir
  of the portable copy and left the Delete unconditional — and the macro runs from
  `customInit` AND from `customUnInstall`, which is the old version's uninstaller during an
  ordinary update. The guard is fixed, but a guard in the installer can only cover the
  installer, so **the app puts a missing shortcut back on launch** (`main/winShortcut.ts`,
  decision in `shared/winShortcut.ts`). It never rewrites one that is there — admin mode
  repoints these, and rewriting would undo it silently — and it never claims the Desktop
  from a `npm run try` copy, whose folder the next build deletes.
- **The login entry.** `setLoginItemSettings` was only called when the SETTING changed, so
  the HKCU Run value was written once and never checked again. That is "it does not reopen
  after a restart" with the switch still reading On. Re-applied from config on every launch,
  and only when it disagrees.

Both are logged to `updater.log` (`windows ...`), because the answer to "why is there no
shortcut" has to be readable after the fact. `npm run test:winshortcut`.

## The Windows dev channel picks its own release

Measured on the PC 2026-08-18, and the two failures end at one error card.
`GET /repos/robertiuoras/PaneForge/releases` answers **200 with an empty array** —
anonymously AND with the gh CLI token — while `gh release list` (GraphQL) lists everything;
that array is what electron-updater's dev channel chooses from, so its provider gets
`undefined` and throws `Cannot read properties of undefined (reading 'assets')`. And when
the list does answer, the newest release is often one this platform cannot install: a build
cut from the Mac publishes `latest-mac.yml` and two arm64 archives and nothing else, so the
updater asks for `latest.yml` in that tag and throws `Cannot find latest.yml in the release`
on every poll for ever — nothing in its loop looks at the release BELOW the newest.
`pickRelease` answers the second one for the Mac and cannot be reused, because it reads the
same broken list.

So the dev channel stops asking GitHub's API to choose. Tags come from `gh release list`,
each is asked directly whether it carries a `latest.yml` (one request against the public
download URL — no token, no API), and the feed is pinned to the first that does with the
**generic** provider, which reads exactly the file we just proved is there. There is then no
list to be empty and no prerelease flag to interpret, so `allowPrerelease` is stood down
under a live pin. Every failure — no `gh`, no network, nothing installable — leaves the feed
exactly as it was. `PF_NO_WIN_PIN` exists only so `test:blindlist` stays about the blind
list. `npm run test:winfeed`.

## Why the app quit

Electron never says what triggered a quit, and on 2026-08-17 "why did PaneForge close by
itself" could not be answered from anything on the machine: the exit line and the mac swap
script proved only that the quit went through `before-quit` rather than through the last
window closing. So every path that quits on purpose now names itself — `quitting(...)` in
`main/index.ts`, from the single-instance loser, the unopened test copy, the handoff
receiver, the idle clock, an update install and the admin relaunch — and `before-quit`
writes that name to `updater.log` with the pane count. A quit that leaves it empty logs
`nothing in the app asked - Cmd-Q, the app menu, or a signal from the OS`, which is the
answer that was missing: Chromium turns a SIGTERM into exactly this shape of graceful
shutdown, so "nothing in the app asked" and "the window was closed" are different facts
and the log now separates them.

**That sentence named three possibilities and separated none of them**, which is what made
2026-08-21's close unanswerable: nine panes gone, `quit nothing in the app asked ... 9
pane(s) open`, and no way to tell a Cmd-Q from a `pkill` from a logout. A signal still
cannot be caught - Chromium takes SIGTERM below the JS layer and `process.on('SIGTERM')`
never runs, measured - but the three are told apart by **where the screen was**: a Cmd-Q or
an app-menu Quit can only be typed at a frontmost window, while `pkill`, `osascript ...
quit`, a launchd job and a logout all arrive while somebody is looking at something else.
`shared/quitWords.ts` turns the last focus into that sentence. It is evidence and never a
verdict - the useful half is the negative, "this did NOT come from this keyboard", and it
names no culprit. `FROM_KEYBOARD_MS` is a generous 4s because Cmd-Q blurs the window a beat
before `before-quit` runs and calling a real Cmd-Q an outside kill would send the next
person hunting a script that does not exist. `npm run test:quitwords`.

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
