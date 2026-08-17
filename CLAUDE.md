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

- **Every automatic release is a DEV release.** It is cut as a GitHub prerelease:
  installs opted into the dev channel (Settings → Updates → "Dev channel", config
  `devUpdates`) take it within the half hour, while every stable install resolves
  `/releases/latest`, which GitHub keeps pointed at the newest PROMOTED release.
  Nothing reaches a stable app until a build is promoted — and promotion happens **by
  itself**, on the big-company channel shape (Chrome, VS Code): the newest dev build
  that has been on the channel `PF_PROMOTE_SOAK_MS` (3 days) auto-promotes, from the
  same minute timer as everything else (`autoPromote` in `lane.mjs retry`). The soak IS
  the proof: dev-channel installs ran that build three days and nothing needed a fix,
  and it carries every skipped version with it in one update. **The soak is that
  build's own age, not a quiet period across the channel.** Requiring the NEWEST build
  to sit untouched sounds stricter and really promises that stable never moves: this
  repo ships most days, every release reset the clock, and on 2026-08-14 that had
  produced 20 unpromoted dev builds with stable still on v0.8.32 — a Mac on stable
  could not update out of a broken build no matter how often it restarted, because
  there was never a newer stable one to find. `npm run test:promote` covers a soaked
  build promoting with a younger one sitting on top of it. `node scripts/lane.mjs promote
  [version]` by hand is for "stable needs this now" (a bad build already reached
  stable) — never promote a build by hand on a green diff alone. Both paths refuse
  a one-legged release (either platform's feed missing) and a feed whose declared size
  disagrees with the asset being served, then verify `/releases/latest` really moved.
  `lane.mjs doctor` lists what waits and when it auto-promotes. Tags stay plain
  (`v0.8.29`) — the prerelease FLAG is the channel, so stable gets exactly the tested
  bytes. `npm run test:promote`.

**A release claims the thing is finished.** Never cut one while any next step for that
issue is still open — and **promotion claims it is proved**: the dev channel buys the
room to iterate, and the soak is what turns iteration into proof.

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

**A handoff moves the WORK, still never the pty.** `Hand off` on a paired device's card
(two presses — the first arms it) pushes each pane's repo as an `auto-sync:` commit,
streams its transcript and screen tail over the link, and the far end pulls the branch,
writes the transcript where its own CLI looks, and starts a fresh pane with `--resume` —
through the same lane split a local launch gets. The sender's pane closes only on the far
end's ack and immediately reappears as a mirror, so the desk that handed off keeps
watching. The receiver never destroys local state: a dirty or unpushed checkout over
there refuses THAT pane by name, and the sender keeps it. Paths map by grafting the
pane's root-relative path onto the receiver's projects root (`shared/handoff.ts`).
`npm run test:handoff`.

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
- **Off until the Devices panel is opened — and opening it is the switch.** Serving
  grants a browser a pane, which is commands on this machine, so the app never listens
  on its own; but opening Devices IS the intent to pair, so the panel starts serving on
  mount and the QR is on screen the moment the panel is. There is no separate toggle any
  more (v0.8.36: the toggle was where the QR hid, and the QR is the whole setup). `Stop
  serving` lives in the fold and holds until the panel is next opened. Unpaired gets the
  pairing page and not one asset; five wrong codes locks that address for a minute. The
  cookie is `hmac(deviceId, code)` - derived, never stored - so rotating the code signs
  every phone out.
- **Watching a pane and typing into one are different permissions** (`src/main/passkey.ts`).
  With `phone.typeGate` on, a browser may watch freely but the first keystroke of each
  15-minute window costs a passkey touch — Face ID, Windows Hello — so a stolen cookie is a
  viewer rather than a shell. Three things about it are load-bearing and easy to undo by
  accident:
  - **The gate is on `/pf/send` and `/pf/call`, NEVER on `pty:write`.** The app types into
    panes itself — `recover`'s queued "continue", the prompt `sessions:start` hands a new
    pane — and those are raised in the main process, so a gate at the HTTP boundary exempts
    them by construction. Move it nearer the pty and both break, silently. If it ever has to
    move, the seam is one `from: 'user' | 'app'` parameter on `SessionManager.write`.
  - **It arms only over TLS** (`x-forwarded-proto: https`, same loopback-only trust rule as
    `addressOf`). WebAuthn does not exist outside a secure context, so arming on the
    plain-http LAN path would lock out the phones that cannot satisfy it. `test:passkey`
    pins this in both directions because it is the check most likely to silently invert.
  - **A 423 refuses the whole batch before anything runs**, and the client re-queues it at
    the front. Keystrokes are ordered: running the ungated half of a batch delivers a word
    with letters missing.
  `DESK_ONLY` in phone.ts refuses `phone:typeGate` and `phone:forgetKey` over HTTP with the
  same answer as a channel that does not exist — a lock whose switch is reachable from the
  thing it locks is not a lock. Note that **every other invoke channel in `surface.ts` is
  phone-reachable**; desk-only is a property of the transport, not of the surface.
- **The QR leads with an address a plain phone can reach.** `phoneUrls()` puts the LAN
  address first and the tailnet one after it: 100.64/10 answers only for a phone running
  Tailscale, and leading with it made the QR a dead link on every ordinary phone the
  moment this desk had a tailscale interface up. `reachWords` says "needs Tailscale on
  the phone" for it, never "works anywhere" — only the tunnel earns that. Pinned by
  `test:phone`, which feeds `phoneUrls` a mixed interface set.
- **The tunnel never asks the system resolver for a name public DNS does not carry yet.**
  `waitUntilServing` gates the probe on a DNS-over-HTTPS answer (cloudflare-dns.com,
  which bypasses the local cache) and only then touches the hostname — probing straight
  after `Registered` was the cached-NXDOMAIN trap in slow motion, 40s of ENOTFOUND
  against a serving tunnel. The gate falls through after `PF_TUNNEL_RESOLVE_MS` (30s) so
  a blocked DoH endpoint delays the probe, never defeats it. And the 20 MB binary is
  prefetched when serving starts, so the switch costs seconds, not a download.
- **Scanning asks; a press on the desk answers.** The QR carries the bare address, not the
  code: the phone opens it, `POST /pf/ask` raises a card here with four digits that are on
  both screens, and Approve mints THAT browser a 32-byte token of its own. So there is no
  secret on screen to photograph, and — the part the code could never do — a device can be
  signed out **by name**, because `who()` looks its token up on every request. `New code`
  still exists and still signs out everything that typed one. One request at a time, five
  per address per ten minutes, two minutes to answer, and the whole thing is a switch
  (`phone.ask`) that falls back to the fragment-code QR. Nothing is granted by the asking.
  `npm run test:phone` covers approve, the cookie arriving on the POLL (the only door back
  to that browser), and that a signed-out cookie stops working on the next request.
- **"One request at a time, five per address" needs the address to be real, and behind the
  tunnel it is not.** cloudflared holds the phone's TLS connection and re-issues the request
  locally, so every device on earth arrives as 127.0.0.1. That string is the ask slot, the
  lockout key and the words the card prints, so believing the socket meant a second phone was
  handed the first one's request and its four digits, five scans from anywhere shut the door
  for ten minutes, and a phone on a train was labelled "this machine", which is exactly the
  label that turns the card's internet warning off. `addressOf` believes `cf-connecting-ip`
  (then `x-forwarded-for`) and does so ONLY from loopback, which is the one hop we put there
  ourselves; a local process could spoof it and gains nothing, being already able to read the
  pairing code out of config.json. Shape-checked before it is printed.
- **The approve card belongs to the desk, and this UI also runs on the phone.** Drawn there
  it is a full-screen veil over whatever that phone was doing, thrown up by any device
  asking to get in, offering Approve to the one screen that cannot compare the digits with
  the desk. `isPhoneClient()` (`renderer/src/client.ts`, set by `browserApi.ts`) is the only
  thing that may gate on which copy is running, and it is for authority, never for layout:
  a narrow window is `handheld.ts`'s question.
- **Pairing is a camera, not a keyboard.** With asking off, Settings draws `<address>/#<code>` as a QR
  (`shared/qr.ts`, no dependency, byte mode / level M / versions 1-6) and the pairing page
  posts a code it finds in the fragment. A **fragment** because a browser never sends one
  to the server: the code stays out of the access log and out of every `Referer`. The
  typed field is still there for a phone with no camera. OAuth and email were considered
  and refused - both move the secret through a third party and off this network to save
  six keystrokes on a link that is otherwise entirely local.
- **So the picture is the panel, and everything it is made of is folded.** Devices leads
  with the phone, above the desktop card, and the phone panel shows a 168px QR and one
  line of words; the address list, the code, the port and `New code` live under
  `Other ways in`, and the desktop card's own code, addresses and port under
  `Pair by hand`. Measured with both folds closed: **zero** codes, addresses and New code
  buttons on screen, against 2 codes / 4 addresses / 2 New code buttons before. None of
  that is wrong — it is what you reach for when the camera did not work — but all of it
  at once, twice over, is what buried the one step that finishes the job.
- **The panel says who is watching, never who is paired.** The cookie is derived, so every
  phone that ever typed the code holds the same one and there is no per-device identity to
  keep — which means there can be no per-device sign-out, and a `Disconnect` button beside
  a row would be a lie (the stream returns at once, the cookie is still good). `New code`
  is the only revoke and it takes all of them. Each row leads with **where the browser came
  from** (`originOf` in `shared/net.ts`), because "somebody is watching" reads one way for
  a phone in this room and another for an address off the internet. The same function
  labels each offered address with what it reaches, so the panel can never promise
  "works anywhere" for an address the server would then mark "this network".
- **A phone signs in ONCE, and what makes that true is the address, not the auth.** The
  cookie is ten years, HttpOnly and revocable by name — and every one of those was already
  true while phones were being re-approved on the desk every launch, because a cloudflared
  quick tunnel mints a NEW hostname per run and a cookie belongs to an origin. So
  `main/funnel.ts` is tried before cloudflared whenever the machine can: Tailscale Funnel
  serves public HTTPS on `<machine>.<tailnet>.ts.net`, which is this machine's own name and
  is the same string after a reboot, an update and a network change. Nothing is installed
  on the phone (Funnel is the public internet, not the tailnet) and nothing is downloaded
  on the desk. Measured: up in under a second against cloudflared's ~20s. Every refusal —
  no Tailscale, `tailscaled` stopped, a tailnet without the funnel attribute, no HTTPS
  certs — falls silently through to cloudflared, because the person flipping the switch
  asked for a way in and not for a provider. `TunnelState.stable` is the one word the panel
  needs; `funnel --bg` is a setting tailscaled keeps, not a child process, so `stop()` has
  to say so or a public address outlives the app. `npm run test:funnel`.
- **`SameSite=Lax`, never `Strict`.** Strict withholds the cookie on a cross-site
  navigation, and every real way this address is opened is one: a QR scanned in the Camera
  app, a link tapped in Messages, a bookmark from another app's browser. The desk then sees
  no cookie, calls a signed-in phone a stranger and serves the pairing page. `Secure` is
  added only when the request really arrived over TLS (`x-forwarded-proto`), since on plain
  http over the LAN it is a cookie the browser stores and never sends back.
- **The cookie lasts ten years, so a copy of it has to be VISIBLE.** Expiring it is the
  wrong answer twice over: a phone that loses its cookie needs somebody standing at the
  desk to approve it again, which is the manual step this whole path exists to delete. So
  `shared/deviceWatch.ts` watches instead, and it never refuses a request — a watcher that
  revokes on suspicion locks Robert out from a train, which is the failure that makes the
  feature not worth having. It marks the row; `Sign out` is still a press.
  - **A signal that fires on ordinary life is not a signal.** A phone leaving the house
    changes its address and its origin every day, so a changed PLACE is recorded and never
    alarmed on. What is left is the two things a phone does not do by itself: turn into a
    different browser (compared on a version-stripped `uaShape`, because an iOS upgrade
    rewrites the numbers and marking every device the morning after a release is how a
    warning stops being read), and hold a live stream from two origins at once — one
    sign-in is one browser, so that is a copied cookie even when the user-agent matches.
  - **An existing mark is never overwritten and never cleared by an ordinary arrival.**
    The browser holding the stolen cookie is making requests too, so a later innocent one
    wiping the mark means nobody ever sees it. `phone:clearMark` is the only eraser and it
    is in `DESK_ONLY`: a warning a stolen cookie can dismiss about ITSELF is not a warning.
  - `npm run test:devicewatch`, whose load-bearing half is the negative cases.
- **One row per device, not one per approval.** A phone re-asks whenever its cookie is
  gone, and appending each time is what made this desk's list nine rows for three phones —
  at which point `Sign out`, which is per row, stops meaning anything. Approval replaces the
  row with the same user-agent (the only thing about a browser that survives losing the
  cookie) and keeps its original "signed in since"; a list written before that is collapsed
  once on the way up, conservatively, by kind and place.
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
- **A copy made on the phone is the PHONE's clipboard.** `copyText` is an ordinary channel,
  so over HTTP it ran `clipboard.writeText` in the main process - on the desk. Every copy
  from a phone (a pane's "Copy output", a selection, a prompt) landed on the Mac and the
  phone's clipboard never moved, which reads as "I can't copy text from the output on
  mobile": the button worked, the bytes went to the wrong machine. `buildApi` now lets a
  transport answer a method ITSELF, and `browserApi.ts` answers this one and
  `readClipboard` locally - `navigator.clipboard`, falling back to the `execCommand`
  textarea on the plain-http LAN path, where there is no secure context. Still one list:
  the channel is still declared in `surface.ts` and the desk still uses it.
- **A finger cannot select a canvas, so the output is also served as TEXT.** xterm draws to
  a canvas and implements selection on MOUSE events; a finger dragged across it is a
  scroll, so no gesture on a phone could pick out a line of an answer. `TextSheet.tsx` is
  the pane's output as a `<pre>` - native selection, native loupe, one Copy all - and it is
  where the DEPTH problem is answered too: the live replay is capped at 400 KB
  (`BUFFER_LIMIT`), which for an agent whose "thinking" line repaints many times a second
  is minutes rather than turns, so a phone could not reach what the desk still had in its
  terminal. `paneLog` (`sessions:log`) reads the transcript off disk instead, up to 8 MB.
  **Rendered, never stripped**: `strip()` would put every repaint frame on its own line -
  the "it spams the thinking info" complaint written down as a document - so the bytes go
  through a real xterm off-screen at the pane's own width and its BUFFER is what is shown.
  Measured at 414x896: 400,000 bytes live against 529,160 characters / 20,008 lines in the
  sheet, all of it selectable.
- **A text field is the one place selection must survive `body { user-select: none }`.**
  That rule inherits, and WebKit takes it literally: on iOS a field under an inherited
  `-webkit-user-select: none` still types but will not raise the caret loupe, place the
  caret mid-word, or select a word on a double tap. That is "let me select in the prompt
  and change it - I can't even edit it on mobile". Both spellings, on every input and
  textarea.
- **...and the keys a phone keyboard does not have are drawn.** Once words are in the CLI's
  own input box they belong to the pty, and every way of changing them - caret left, rub
  out, escape - is a key that keyboard has no room for, so the bar could add to a prompt
  and never edit one. `HandheldType` draws ⌫ ← → ↑ ↓ esc at 44px, as bytes (`DEL` 0x7f for
  backspace, which is what a terminal sends). Tapping the terminal already moves the CLI's
  cursor; these are the rest.
- **A desk resize may not snap the pty out from under a phone.** The desk OWNS the size and
  a phone BORROWS it - but "the desk takes it back on the spot" was written for a borrow
  that had outlived the phone, and the desk does not only resize when a window is dragged:
  showing a pane, toggling the grid and the window's own layout all refit and land in
  `resize`. Each one pulled the pty back to 157 columns underneath a phone drawing 50, and
  a CLI repaints by counting rows in the width it believes it has - so every "thinking"
  frame landed under the last one instead of over it. That is "the output is very buggy on
  mobile, it spams the Claude thinking info". A desk resize during a borrow is now
  REMEMBERED (`deskCols/deskRows`) and applied when the phone lets go; the desk draws the
  borrowed grid meanwhile (`grid` on `TerminalPane`, the same fit a mirror uses, without a
  mirror's other refusals). `npm run test:panesize`.
- **A phone's `100vh` is not its screen.** It is the LARGE viewport - the one you get with
  the toolbars scrolled away - so `.app` at `100vh` laid the app out taller than the glass
  and its last ~60px sat under Safari's bottom bar, taking the typing bar with it. That is
  "it shows type to this pane, it needs to be moved up so you can tap on it".
  `html.handheld .app` is `100dvh`, and the bar clears the home indicator by 8px on top of
  the inset. Measured at 414x896: the input is 44px tall, ends 12px above the viewport,
  and `elementFromPoint` at its centre returns the input.
- **A phone re-wrapping a pane SCROLLS the old frame away; it may never clear it.**
  `t.clear()` was in that path and it is why a pane opened on a phone was blank: the
  buffer it dropped was the one `getBuffer` had replayed into that browser a beat earlier,
  so every pane seeded its history and then deleted it 400ms later. A screenful of
  newlines puts the mis-wrapped frame into the scrollback instead - where it can be read -
  and the redraw paints the live frame under it. `test:phoneview` proves the history
  survives AND that the re-wrap really happened (`__pf[id].rewraps()`): without the second
  half the check passes by never having run.
- **The desk owns a pane's shape; a phone borrows it.** One pty cannot be 50 columns and
  157 at once, and both windows fit their own screen and say so - so whoever spoke last
  won, and a phone that looked at a pane left the DESK drawing a full-width pane whose
  every line wrapped a third of the way across, for as long as it took somebody to resize
  the window by hand. Measured minutes after the phone was closed: desk terminal 157x57,
  pty 50x50. `resize` takes a `borrowed` flag; `returnSizes` puts every borrowed pty back
  and runs when the phone leaves the pane (`pty:return`, from `showList`) and when the
  last phone stream closes (`onIdle`). A desk resize takes ownership back on the spot, so
  a phone that borrowed hours ago can never snap a window the user has since resized.
  `npm run test:panesize`.
- **What was on screen was drawn at the other width, so the phone drops it.** The CLI
  hard-wrapped those lines itself; re-wrapping 157-column box drawing at 50 is not history,
  it is soup - which is what "I open a pane and it is all messed up, I have to clear it"
  was. On a phone, a COLUMN change clears the buffer and asks for a repaint. `clear`, never
  `reset`: it keeps the line the cursor is on, so a plain shell is left holding its prompt
  rather than a blank pane. Only columns, because the keyboard opening takes rows and
  nothing re-wraps.
- **A phone is not a small desktop.** Under 720px the list and the panes take turns
  (`handheld.ts` + one `@media` block); the list is the home screen and a tapped pane gets
  the display. `display: none`, never a 0px xterm. The pane's own header is made to FIT
  rather than to scroll: measured at 414px it wanted 458px of the 404 it had, so Close was
  off the edge entirely and Clear and Fix were 27x23 and 30x19 against a 44px finger. The
  path goes (the list said it), the folder and editor buttons go (`desk-only` - they open a
  window on the machine you are not holding), and what is left is 36px.
- **...and that was not enough, so the header stopped carrying actions at all.** With those
  hidden it still measured 486px of content in a 404px box: restart, Fix and Close drawn from
  x=417 to x=491, past the right edge with nothing to scroll them back, and `.pt-name` squeezed
  to **0px** paying for them - "can't drag menu where the clear button is and can't see on the
  right side all options". Five 36px targets, a ~150px agent picker and an 86px branch badge do
  not go into 404 however they are trimmed. The row now keeps only what says WHICH pane this is
  and every action moves behind one ⋯ into `PaneMenu.tsx`, the ordinary phone action sheet:
  full-width rows with a WORD on them, >=52px, destructive ones last. After: scrollWidth 404
  against clientWidth 404, and the name is back. `probe.mjs --touch` is what makes any of this
  checkable - half of what this app does on a phone is decided by `pointer: coarse`, which a
  device-metrics override does not supply.
- **A phone turned sideways is still a phone.** The handheld rule was width-only, so an iPhone
  in landscape (932x430) got the 282px sidebar beside a pane - a layout holding neither the Back
  chip nor the swipe, which is why "swipe left doesn't always work" was true in one orientation
  and not the other. `HANDHELD_QUERY` also matches a coarse pointer under 520px tall: a handset
  in landscape and nothing else, since a tablet held sideways is 820px tall. Same string in
  `styles.css`, and a copy that drifts is a layout with no rules.
- **The phone's own Back goes back to the list**, not out of the page: opening a pane pushes one
  history entry, `popstate` returns, and the chip unwinds that same entry so the stack cannot
  grow a step per pane opened.
- **The swipe back arms anywhere in the pane, never at the left edge.** That edge is the one
  strip a phone browser has already taken for its OWN back gesture, so the app was listening for
  the swipe it was least likely to be handed. It fires on clearly sideways and clearly more
  sideways than up (`dx > 60, dy < 70, dx > dy * 1.6`); a terminal's own scrolling is vertical,
  so there is nothing to take from it.
- **One composer, not two.** xterm's helper textarea is a text field to a phone, so tapping the
  terminal raised the keyboard with its own caret beside the app's typing bar. On a coarse
  pointer that textarea keeps its keydown handling (a paired hardware keyboard still types) and
  gives up being a field: `readOnly`, `inputMode: none`, out of the tab order. Gated on
  `pointer: coarse` and NOT on the handheld width - a narrow desktop window's terminal must stay
  typeable.
- **The typing bar autocorrects.** It was written as a stand-in for that textarea and inherited
  its `autoCorrect="off"`, which is right for bytes going straight to a pty and wrong here:
  nothing leaves the bar until Send, so the substitution has already happened before any byte
  moves, and what is typed there is a sentence to an agent, not a shell command.
- **A tap opens a pane on the first press.** A finger is never still, and a mobile browser
  throws the `click` away the moment it decides the gesture was a scroll - so the first tap
  was spent proving it was a tap. A touch that did not become a drag opens the row from
  `pointerup` instead, which no scroll heuristic gets to veto; a `pointercancel` and a
  finger that travelled more than `TAP_SLOP` still open nothing.
- **Automation opens a pane through `scripts/pf-ctl.mjs`, never through `open --args`.**
  On a Mac `open -na PaneForge --args --open <dir> --prompt <text>` drops the WHOLE
  argument list when any argument holds an em dash, exits 0 with empty stderr, and the
  app quits having found no request - five #momin bundles reported "session spawned" with
  no pane. pf-ctl posts JSON to the phone server and `sessions:start` answers with the
  pane's id, so the caller checks `sessions:list` instead of trusting a launcher.
  `--open` on the command line is for a person typing it.
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

A CLI that asks "which of these?" stops until somebody arrows to a row and presses
return. At the desk that is two seconds; away from it, it is the rest of the run - the
pane goes idle and green and looks exactly like one that finished. `shared/choices.ts`
reads the chooser off the pane's own frame, so it covers every CLI here rather than
whichever one has a hook.

- **The reading is narrow because the expensive failure is a FALSE question**, not a
  missed one: buttons drawn over a numbered list in an answer would type arrow keys into
  a composer holding somebody's draft. Three things must all be true - the CLI's own
  `Enter to select` / `Enter to confirm` footer, options numbered 1..N with no gaps, and
  exactly one row carrying the arrow. Both positive fixtures in `npm run test:choices`
  are real frames off this machine's pane logs, because the AskUserQuestion widget puts a
  paragraph under each option and the built-in resume prompt does not - a parser written
  against either alone reads the other as no question at all.
- **Arrows and a return, never the digit.** A chooser that only reads the arrows ignores
  a digit silently, and the two are indistinguishable from the frame. Spaced
  `CHOOSE_GAP_MS` apart for the same reason `queuePrompt` sends its return separately: a
  burst in one write reaches a widget that has not redrawn between the keys.
- **It counts from where the arrow is NOW**, so the frame is re-reported when the
  selection moves (`askSignature` includes it). Without that, somebody arrowing at the
  desk leaves a phone's button picking a row the distance they moved it away. A press
  against a question the pane has left is REFUSED, never walked from a stale position.
- **The reading is on the SESSION, not in the pane**, because the surfaces that are not
  the desk are the point: the phone client draws the same buttons and `pty:choose` is
  reachable over the phone server. A mirrored pane is answered by writes over the link,
  keyed off the frame that came with the session list.
- `scripts/pf-telegram.mjs` posts a question to Telegram with one button per option.
  **It is post-only by default and that is load-bearing**: a bot token has exactly one
  long-poller, and a second does not share the updates, it STEALS them and breaks the
  first with `409 Conflict` - measured against the live bot on the first run. Taps arrive
  by being handed to a loopback endpoint; `--poll` is opt-in and only correct for a token
  nothing else reads.
- `npm run test:choices`. The load-bearing assertion is on the BYTE
  (`charCodeAt(0) === 27`): the first version of that test lost its escape in the same
  edit the source did, so `'[B' === '[B'` passed while the app would have typed the
  letters into a chooser.

## ...and a question with an obvious answer is answered

Buttons fixed "nobody was at the desk". The next cost is at the desk: most of those
questions are the CLI asking whether it may do the thing it was just told to do, and the
person presses return. `shared/autoAnswer.ts` presses it instead — off by default
(Settings → "Answer an agent's question for me when the answer is obvious"), because every
question it goes through is one a CLI chose to ask and arriving switched on with an update
would answer a permission prompt on a desk that never asked for that.

- **The refusals are the feature.** Exactly ONE option leading with a yes-shaped word is
  answered. Two are a choice between them; none is a decision somebody is being asked to
  make. An option that WIDENS permission (`don't ask again`, the bare word `always`) is
  never reachable in either mode — it is the one press that cannot be undone by noticing a
  second later — and neither is one that stops or answers with a question of its own
  (`No, tell Claude what to do differently` leaves the CLI holding an empty composer, so a
  pane that was merely waiting is now waiting AND has lost its question).
- `anyQuestion` is the wider setting and it takes **the CLI's own default**, the row its
  arrow is already on, rather than inventing a preference. The two refusals above still
  hold over it.
- **The timing is `dueForAuto`, and it takes TWO signatures of the same question on
  purpose.** A press waits until the frame has sat unchanged for `waitMs` (1.2s — the
  window in which somebody who disagrees can reach the pane) and that signature includes
  where the arrow is, so moving it at the desk restarts the wait. But "have I already
  pressed this one" may NOT be asked of that signature: our own keys move the arrow, so a
  press restarts its own settle clock and a second sequence interleaves with the first,
  arrows landing between each other and the wrong row committed. `askKeyOf` is the
  question's identity with the arrow left out, one press per identity, plus a
  `PRESS_COOLDOWN_MS` floor of 4s so nothing can be pressed while its own keys are still
  landing.
- **`maxRun` is given back by the pane going BUSY, and by nothing else.** A chooser
  mid-repaint reads as no question for one frame, so returning the budget on "no question
  on screen" hands it back several times during a single question and the cap bounds
  nothing. A busy pane is the only evidence that an answer went in and work resumed.
- The keys go through `choose`, which re-checks the question before every one of them.
- `npm run test:autoanswer` — 21 checks, weight in the negatives: every wording of "and
  stop asking me" (not the two strings this desk has captured), the timing behaviourally
  over a fake clock, and source assertions on the STATE the guards read, because a test
  that only matches the comparison lets the assignment making it true be deleted.

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

**And `/clear` no longer takes the previous turn with it.** A CLI clearing its screen sends
`CSI 2 J` *and* `CSI 3 J`, and the second deletes this window's scrollback — measured across
the 128 pane logs on this machine: 73 of each, always paired, and no other erase-in-display
in the set. So `shared/keepScrollback.ts` sits in front of every write: the wipe is dropped,
and the erase becomes a scroll (cursor to the bottom row, one newline per row, saved and
restored around it) — a newline at the bottom row scrolls, and a scroll puts a line into the
scrollback instead of deleting it. The alternate screen is left alone; vim clears constantly
and has no scrollback to protect. It is stateful because a four-byte sequence is routinely
torn across two chunks from the pty, so there is one per pane and every write site uses it.
`npm run test:scrollclear` drives a real headless xterm and its control case proves a plain
terminal loses the lines.

- **Then Claude Code stopped sending either of them, twice, and the answer stopped being a
  rewrite at all.** Measured 2026-08-13: v2.1.229 emits ZERO `2J` and ZERO `3J` in 4 MB and
  erases a row at a time instead (`ESC[H ESC[2K` then `(ESC[1B ESC[2K)` per row), which
  blanks the screen in place — a blanked line is never pushed into the scrollback the way a
  scrolled one is. Measured 2026-08-15 at the banner v2.1.233 draws for `/clear`, the whole
  clear is `ESC[53D ESC[4B \r ESC[6A` and then the banner: **a cursor-up and an overdraw,
  with no erase of any kind to catch** (the nearest erase-per-row was 12,590 bytes earlier
  and belonged to an ordinary repaint). That is "the claude avatar hides the previous
  output" — the last turn is painted over where it sat and nothing reaches the scrollback.
- **So the pane keeps the screen itself, before the CLI has emitted a byte.** `keep.arm()`
  is called when a submitted line matches `mayClearScreen` (`/clear`, `/compact`, `/new`,
  `/reset`) and RETURNS the scroll — the screen pushed into the scrollback and the cursor
  homed — which the pane writes on the spot. Whatever the CLI does next it does to a blank
  screen, so this needs to know nothing about any CLI and cannot go dead the next release;
  homing the cursor is what puts the banner back at the top rather than under forty blank
  rows. The intent still comes from keystrokes the app is relaying anyway, never from
  guessing which repaint is a clear — that guess is what the erase-per-row detection was,
  and it was silently a no-op the release after it shipped.
- **What was TYPED is not what was SENT, and reading the line literally missed half the
  clears.** Typing `/cle` opens the CLI's own command menu with `/clear` highlighted and
  Enter runs the highlighted row, so the pane saw four characters matching nothing, never
  armed, and the banner was drawn over the last turn exactly as before. Measured in a real
  pane: `/clear` typed whole keeps the previous answer (2 marker rows before, 2 after), the
  same clear picked from the menu after `/cle` destroys it (2 before, 0 after). So
  `mayClearScreen` arms on a bare slash TOKEN that is a prefix of one of those commands as
  well - the two mistakes are not the same size, since a miss destroys the turn somebody is
  reading and a false arm only scrolls a screen the CLI is about to repaint. `/co` arms as
  `/compact`'s prefix even when the menu was showing `/code-review`; a command typed whole
  (`/doctor`) and one carrying an argument (`/model opus`) are read literally and do not.
  What makes a false arm cheap is that only the rows holding something are filed: the pane
  passes `used()` and the scroll is that many newlines, not a screenful.
- The `2J`/`3J` rewrite stays for
  a CLI that clears unasked, and stands down for 10s after an armed scroll so a `2J` that
  follows one cannot file a screenful of blanks in front of the turn being kept.

**And a prompt tag survives the CLI repainting over it.** The rail's tags are xterm markers,
and xterm disposes every marker on a row that `CSI J` blanks (`eraseInDisplay` →
`_resetBufferLine` → `Buffer.clearMarkers`, read off a stack trace taken from inside the
disposal). Claude Code repaints with erase-in-LINE, which touches no marker; Codex repaints
with erase-in-DISPLAY. Measured by replaying this machine's own pane logs into a real xterm
and registering a marker every 20 KB: **Claude Code lost 0 of 278, Codex lost 25%, 33% and
50% across three panes** — which is the "Codex shows no prompt tags so I cannot jump to my
prompts" report, and the prompt had not scrolled anywhere. `shared/markAnchor.ts` reads a
disposal for what it is: the line still being in the buffer means another marker goes on it
(on a deferred callback — the disposal fires from inside xterm's own walk over its marker
list), and only a line the buffer has genuinely forgotten ends the tag. Line 0 is the one
that goes: a trimmed marker was on line 0 an instant earlier, and that is indistinguishable
from a tag still sitting on the oldest line. `npm run test:markanchor`, whose control proves
a bare marker really does die.

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
| `npm run test:laneforeign` | a folder at a lane's path that is a checkout of a DIFFERENT repository: it is named and refused rather than adopted, and its commits are left alone. The load-bearing half is the control that the clone really does pass the old `--is-inside-work-tree` test, without which the case is never reproduced |
| `npm run test:lanepeers` | the arithmetic of a claim on the other desk: what a ref name may carry, and the negatives that decide whether the check is worth having — a desk never blocks itself, a claim nobody refreshed stops counting, and a letter lane is never anybody else's business |
| `npm run test:lanedevice` | the same thing with the plumbing attached: a real bare repo, two real clones, one told it is another machine. The second desk is sent to a letter rather than onto the shared branch, the trunk comes back the instant a chat ends, and the release lock is refused at the SERVER — with the two mechanisms that looked right and were not (the shared branch tip, and `--force-with-lease`) kept as controls |
| `npm run test:notes` | release-note ranges and both template shapes |
| `npm run test:pickrelease` | which release an install may take: the newest one carrying an asset THIS platform can install, so a win-only release is skipped rather than 404'd at for ever |
| `npm run test:remote` | the device link end to end over a real loopback socket |
| `npm run test:pairask` | pairing with no code typed: the six digits agree between the two ends, and — the case the whole design exists for — a real relay in the middle makes them DISAGREE |
| `npm run test:handoff` | a pane handed to the other machine whole, over a real link and real git: WIP pushed as `auto-sync:`, a 5 MB transcript chunked and reassembled byte-for-byte, `--resume` on the far end — and the refusals: a dirty far checkout, unpushed far commits, a folder outside the root |
| `npm run test:theme` | palette derivation + contrast (358 assertions) |
| `npm run test:stashtheme` | that the floating Stash picks no colour of its own, and asks the theme rather than the OS which way round it is |
| `npm run test:sounds` | the alert catalogue: nothing silent, nothing clipping, uploads |
| `npm run test:blurbs` | the "what this is" note on each feature, and that each is rendered |
| `npm run test:place` | the words a pane's strip prints (56 assertions) |
| `npm run test:agentenv` | the environment a pane's agent is started with — a provider is a catalogue entry with two variables set, not a branch in the spawn path, and a key placeholder with no key behind it is DROPPED rather than passed through: a CLI handed the literal `${OPENROUTER_KEY}` fails as a 401 several seconds into a pane that looks perfectly healthy |
| `npm run test:devicewatch` | noticing that a ten-year cookie has been copied — and, the half that decides whether anybody ever reads a mark, that a phone leaving the house, an iOS version bump, a reloaded tab and a row with no stored user-agent all say NOTHING |
| `npm run test:projects` | which folders under the root are projects and which are copies of one: a lane worktree folds under its project (by git's own `gitdir:` pointer, and by a pruned lane's leftovers), while a repository called `service-a` next to a `service` stays a project — hiding somebody's repo is the worse bug |
| `npm run test:cardfit` | that a session card can still be READ once a lane loads it up: the shipped stylesheet in a real headless Chrome at the real 190px sub-line, asserting the agent's name, the clock, the pane's name and the place chip are all whole. Skips out loud with no Chrome |
| `npm run test:diff` | reading a repo's changes: `-z` records, renames, patch numbering |
| `npm run test:railplace` | where a prompt tag is drawn: never off the rail, never far from the thumb it points at (no window) |
| `npm run test:grid` | layout arithmetic, no window needed |
| `npm run test:split` | task splitting; overlapping file claims are REFUSED, never repaired |
| `npm run test:agentic` | the app driving a lane: a hung turn killed by its budget, a run that changed nothing refused, a failed gate retried |
| `npm run test:goals` | the queue that outlives the window: a goal read back after a kill, the next one starting by itself, `outcome` stamped |
| `npm run test:unattended` | that the app says what a driven lane may do: every agent in `HEADLESS` has a nameable permission flag, the words are DERIVED from the arguments the run carries, and a stricter posture silences the claim instead of keeping it |
| `npm run test:dispatch` | the router that picks the agent, the model and the budget for an ask — and the four cases where the CHEAP tier must not be chosen: a repo that cannot check itself, an ask naming no file, repo-wide words, and a retry of something that already failed |
| `npm run test:dispatchpane` | a dispatched run as a real pane, against a fake driver and real git: closes itself on success, STAYS on failure, a person's keystroke drops it ungated, an exited pty is a failure not a wait — and the report that leaves carries the gate's per-step verdicts, skipped included |
| `npm run test:turncopy` | where a turn's two copy icons go: one pair per prompt on screen, the newer one keeping the space when two prompts land within a pair's height, and the reply range that is off by one in the direction that pastes perfectly and is wrong |
| `npm run test:cursorclick` | clicking where the CLI's cursor should go: the keys it sends, the clicks it refuses, and — the load-bearing half — that a BARE click can emit no vertical arrow at any input, plus deleting a highlight by walking to it and backspacing over it |
| `npm run test:stickyselect` | that a highlight stops moving when the mouse is let go — a real xterm in a real Chrome, with the control that the unconditional capture-phase `stopPropagation` this app used to do leaves the selection growing from 18 characters to 58 after the button is up, because xterm's own mouseup (a bubble listener on the document) never runs and its mousemove listener is never taken off |
| `npm run test:anim` | what a looping decoration may cost: an `infinite` keyframe may animate `transform` and `opacity` and nothing else. The idle dot's ring animated a `box-shadow` spread and measured **136% of a GPU core** against the same ring drawn as a scaling layer at **36%** (floor 20%), on IDLE panes — which is most of a working day |
| `npm run test:attach` | putting a picture in front of the agent: the bytes land on the machine that owns the pty, the extension comes off the magic bytes rather than off a name that lied, a batch too big for the device link is refused with a sentence and writes nothing on the way, and a file called `../../.ssh/authorized_keys` cannot leave the folder |
| `npm run test:choices` | reading a live question off a pane's frame and the keys that answer it: two real captured chooser shapes, and the negatives that decide whether it is safe to draw buttons at all - a numbered list in an answer, one somebody quoted back at the agent, a gap in the numbering, and no selection arrow. Plus the byte-level check that the arrows really are escape sequences, because the first version of this file lost its escape in the same edit the source did and passed |
| `npm run test:promptbox` | telling a CLI's drawn input box from everything that only looks like one — a zsh prompt, a diff, a markdown table — because a false positive there lets a bare click recall a command |
| `npm run test:promptsubmit` | that a pane opened WITH a prompt actually sends it: nothing typed while the CLI is still booting, the return sent as its own keystroke rather than the last byte of the paste, sent again while the pane stays idle, and never once it is working |
| `npm run test:onestash` | that there is one Stash: the overlay is a pill while the window is showing the list |
| `npm run test:stashsummon` | that the Stash is not on screen until it is asked for: closing HIDES the window rather than parking a pill, and a summon opens at the pointer, on the pointer's own display, clamped on |
| `npm run test:phone` | the phone client's server: nothing served before the code, calls landing in the app's own handlers, bytes surviving JSON — and PARITY, that one list feeds both transports and every line of it has a handler |
| `npm run test:panesize` | who owns a pane's shape when the desk and a phone are both drawing it: a phone BORROWS the pty's size, gives it back when it looks away, and can never undo a size the desk chose afterwards |
| `npm run test:tunnel` | the way in from anywhere: a URL that never resolves is never called up, a cloudflared that says nothing or hangs settles anyway, and the per-platform asset names a wrong guess would 404 on |
| `npm run test:funnel` | the provider whose address never changes: which machine can be funnelled, which refusals mean "quietly use cloudflared" rather than "tell somebody something broke", that what tailscaled really published beats what was asked for, and that stopping SAYS so — nothing else ever will |
| `npm run test:gist` | the one line History puts under a closed session: a pasted stack trace picks the sentence rather than the first frame, and nothing typed is nothing said rather than a guess |
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
| `npm run test:scrollclear` | that an agent's `/clear` stops destroying the pane's scrollback — all three shapes it has had (`CSI 2 J`, the erase-per-row, and the bare `ESC[6A` overdraw v2.1.233 sends, which erases nothing at all), a sequence torn across two chunks, that an unarmed repaint is left alone, and the result in a real headless xterm with a control per shape proving a plain terminal loses it |
| `npm run test:markanchor` | that a prompt tag survives the CLI erasing the row it sits on — with the control that a bare xterm marker does NOT, which is why Codex panes had no tags to jump to |
| `npm run test:recover` | finishing a turn the transport cut in half: every real error string this desk has logged, and the refusals - a rate limit or an auth failure is never continued, and an error somebody QUOTED at an agent (which the CLI echoes back with no box around it) is a question about the bug, not the bug |
| `npm run test:reclaim` | closing idle panes to give a full machine its memory back: pressure is the trigger and never a clock, a pane WAITING FOR A PERSON is never closed however quiet it looks, and the window is never emptied |
| `npm run test:macsign` | the signing that stops TCC resetting permissions every release |

Needing a real window up (`npm run build && npm run try -- --keep --show
--remote-debugging-port=9333`): `test:view` (grid + find bar), `test:stashdrag`,
`test:activate`, `test:improveview`, `test:turncopyview` (which is happy minimized), and
`test:phoneview` (a real headless Chrome at
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
  above still describes every desk that has not asked otherwise. It exists for the second
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
