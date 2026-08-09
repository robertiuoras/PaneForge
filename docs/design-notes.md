# PaneForge — design notes

Why every rule in `CLAUDE.md` exists: the measurements behind each number, the traps that
cost hours, and the decisions not worth re-litigating. Headings match `CLAUDE.md`.

Read the matching section here before CHANGING one of those things. The rule in
`CLAUDE.md` is enough to work beside it.

---

# PaneForge

Electron app that hosts coding agents in panes. It hosts the chat you are reading this
in, which shapes every rule below.

## Never close the app you are running inside

`PaneForge.exe` under `AppData\Local\Programs\claude-orchestrator` is the live app and
killing it ends this session mid-turn. To see a change, open a **second** copy:

```
npm run try                     # builds, opens as its own profile, minimized, no focus
npm run try -- --show           # same, but put the window on screen (still no focus)
```

Profiles (`src/main/profile.ts`) give that copy its own userData, single-instance lock,
config and taskbar button, so the live app is untouched. The profile name comes from the
folder name, so each checkout opens its own window.

## Lanes: more than one chat works on this repo

Chats get started from other projects ("add X to PaneForge" from one, "fix Y" from
another) and would otherwise share this checkout: two builds writing one `out/`, two
version bumps, two releases minutes apart.

A hook assigns each session a lane automatically - `main` (this folder, master) or a
worktree `claude-orchestrator-a` / `-b` on `lane-a` / `lane-b`. Work only in the lane you
were given; writing into another chat's checkout is refused by a PreToolUse hook, not by
convention. `node scripts/lane.mjs status` shows who holds what.

None of that is about PaneForge, and since 2026-07-31 it is not only for PaneForge. Two
chats in one checkout of ANY repository overwrite each other's edits and race the same
index, so `lane.mjs` takes `--repo <dir>` and the hook passes whichever repository the
chat is actually sitting in. There is ONE engine - this file - driving every project on
the machine; a copy per repo would drift, and the only symptom of the drift would be two
chats quietly sharing one checkout, which is the thing lanes exist to prevent.

What a repository gets is decided by `.lanes.json` in its root, every field optional:

```json
{ "lanes": false, "branch": "main", "release": "merge", "pool": ["main", "a"] }
```

`release` is the whole difference between here and everywhere else, and it is a
declaration rather than a guess on purpose. `"version"` bumps package.json, tags, pushes
and publishes - which in a repo that deploys on push IS a production release, and no
project should start doing that because a script recognised an npm script name. So any
repo that is not this one defaults to `"merge"`: finished lanes are merged into its branch
and pushed, batched behind the same lock and the same cooldown, and no version is ever
cut. This repo's own `.lanes.json` says `"version"`, which is what it always did.

The branch is the repo's own - whatever the main checkout has checked out, so a project on
`main` rather than `master` needs no configuration at all. A repo with no remote, and
`claude-memory` (edited from every chat on the machine, by hooks as well as agents), never
get lanes. A chat alone in a repo is told nothing: it gets `main`, which is the folder it
was already in, and silence is the point - a line about lanes on every prompt in every
project is how a useful line stops being read.

**A visitor never squats `main`.** Twice (2026-08-07, 2026-08-09) a chat whose own
project was a different repository - its shell had merely cd'd here - claimed `main`,
finished in minutes, and then held the checkout for as long as its window stayed open;
every real chat in the repo was sent to a letter lane by a chat that had left. The idle
sweep could not help for an hour, because an hour of silence is the least a LIVE holder
deserves. Two rules close it. A claim now says whether its chat is a visitor - the hook
reads the session's home project off its transcript path, because `cwd` follows the
shell and is exactly how the squatter got in - and a visitor is handed a letter lane
while one is free, keeping `main` only when the folder holds uncommitted work to
protect. And a `Stop` hook runs `park` when any chat's turn ends: holds on clean lanes
are marked, the mark clears the moment that chat claims again, and a claim that needs a
parked `main` takes it after ten minutes (`PARK_STEAL_MS`) - at once when the parked
holder is a visitor. Nothing can be lost: one uncommitted character and `park` records
nothing and no steal touches the lane. `visitor-park-test.mjs` is the proof, and 8 of
its 14 checks fail on the engine as it was.

`npm run test:lanes` ends with `lane-anyrepo-test.mjs`, which drives the real script
against real throwaway repos on `main` with real remotes. It pins the two answers that are
easy to get wrong once a second repo exists: a repo that never asked for releases must
NEVER cut a version, and one that asked must cut exactly the version this repo would.
Finding it needed writing: a repository that has just turned releases on has a version in
package.json and no tag matching it, and `v0.1.0..HEAD` is a fatal "ambiguous argument"
that surfaced as `No release yet: Command failed` - a repo that could never cut its first
release and never said why.

## Releasing happens by itself

There is one command, and it is not a release:

```
node scripts/lane.mjs ready --session <id>   # this lane's work is done and verified
```

`ready` marks the lane and then tries the release. It goes out when no chat is mid-work
any more - clean lanes, nothing uncommitted, nothing finished-but-unmarked - so whoever
finishes last releases for everyone, in ONE version bump. While another chat is still
editing it says so and does nothing; that chat's own `ready` (or the end of its session,
which marks committed work done on the way out) cuts the release instead. Wait for it
rather than shipping again.

Two things stop an automatic release, both reported by name: master not typechecking, and
a lane that conflicts with master. A conflicting lane is left out and keeps its mark - the
rest still goes out.

You will normally meet that conflict long before the release does. `ready` merges master
into your lane first and refuses to mark anything shippable until that merge is clean, so
the files are listed to you while you still have the context: resolve them, `git add`,
`git commit`, run `ready` again. `rerere` is on, so the resolution you do once is replayed
when the release merges your lane back the other way. A conflict left recorded is retried
by the running app every minute (`lane.mjs retry`), so the ones that stop being conflicts
clear and ship without anyone acting; the ones that need real editing are typed into a
pane that is not mid-turn. A paragraph about lane X appearing in your pane came from
there - it is yours to do. Once you `resolve` a lane it is yours for 45 minutes and
nothing will touch the merge you have open in it. Claiming a lane also heals it (an
unfinished merge left by a dead chat is aborted, a branch whose work master already has is
reset to master) and every lane merges master again after each release. Never leave a lane
sitting in a conflicted merge: it is the one state no other chat is allowed to touch.

`npm version`, `git tag vX`, and pushing a version tag by hand are blocked. `npm run ship`
still exists for a release you want right now, but nothing should need it.

Every automatic release used to be a **patch** bump, and the reasoning was sound as far as
it went: `ready` cannot express "this one is a minor", and a release batches several chats'
work, so no single chat is entitled to decide for the others. The conclusion drawn from
that - default to patch, ask for anything else by name - was the part that did not hold.
It made the version a build counter. Fifty-nine patches into 0.4 nobody could tell from
`v0.4.60` whether it carried a feature or a typo, and the `ship minor` that would have said
so was never typed, because typing it is a thing a person has to remember and no chat is
in a position to remember it.

The information was already in the repo. The subjects are Conventional Commits - it is what
the release notes above are built from - so the release can read its own bump off the range
it is about to ship (`bumpFor`, in scripts/release-notes.mjs): a `feat:` anywhere in it
makes the release a minor, everything else leaves it a patch. That decides per RELEASE
rather than per chat, which is exactly the objection that forced the patch default, and it
needs nobody to remember anything.

Two limits, both deliberate. A `!` (or a BREAKING CHANGE trailer) asks for a major and gets
a **minor** while the version still starts with 0 - the usual 0.x reading, and 1.0.0 is a
claim about the product that no commit subject is allowed to make on its own. And a bump
named on the command line is obeyed as given: `ship major` still cuts 1.0.0, `ship patch`
still forces a patch over a range full of features. `auto` is what the unattended paths
(`ready`, the session-end mark, the retry timer) pass.

**And then the rule above was too loud, so below 1.0 it now stops at the patch**
(`nextVersion`, same file, 2026-08-07). Read the argument two paragraphs up again with the
0.x part in mind: it is right that `v0.4.60` does not say whether it carried a feature, and
wrong that `feat:` is the thing that would say so, because below 1.0 nearly every commit
adds something. What the fix produced was not a meaningful minor, it was a faster build
counter with a shorter tail. In one day - 2026-08-06 into 08-07 - **v0.4.62 became v0.8.0
over six releases carrying seven commits between them, two of them `feat:`**, and four of
those six carried nothing at all (that half was the tag-drift bug, fixed separately in
v0.8.0). Robert's complaint is the measurement: he could no longer tell a week of work from
a one-line fix by looking at the number, and 0.4.x had been fine.

So below 1.0 the ladder is one rung shorter and every rung above the patch has to be typed:
a plain `feat:` or `fix:` moves the patch, `feat!:` is the only bump a commit may still ask
for and it gets a minor, and `ship minor` / `ship major` do exactly what they say because a
person said so. At 1.0 and above nothing is demoted and ordinary semver resumes - the
demotion asks the current version, not a flag, so there is nothing to switch off later.
`bumpFor` was left alone: it still reads the subjects honestly, and what a release may DO
with that reading is one function with the version in front of it. `npm run test:notes`
pins both halves.

`ship minor` by hand keeps its old caveat: the release page will say only what changed
since the last tag, so a feature list from further back needs putting on by hand
(`gh release edit`), AFTER the workflow's `notes` job has run, since that job rewrites the
body from its own range.

Automatic releases batch: one every thirty minutes at most (`COOLDOWN_MS` in
`scripts/lane.mjs`). Inside that window `ready` says so and leaves the work on master,
where the next `ready` or session end takes it out. Do not "fix" that by running
`npm run ship` - a version per finished chunk is what produced fifteen releases in one
day. It used to cost two hours of batching because each release interrupted with a prompt;
updates now install on exit, so releases are cheap to ignore and the wait is short. Reach
for `ship` only when a specific build has to be in Robert's hands now, and say why.

A lane is only ready while it still looks the way it did when it said so: edit or commit
again and the mark is dropped and the release waits for you, by name. Nothing to do about
it except mark ready again - but it means a release never stalls silently on a chat that
said done and kept typing (`scripts/release-gate-test.mjs` is that failure, pinned).

### Every automatic release is a dev release (2026-08-09)

Robert's ask, verbatim in intent: stop broken builds reaching the app he is sitting in.
Until now every `ready` fed the same feed his live copy polls, so a session's mistake
was on his desk within the half hour and the fix cost more releases - the version
number had become a mistake counter. The missing piece was a channel between "the lane
engine released it" and "everybody runs it".

The mechanism is GitHub's own, which is why it is small. A release cut with the
prerelease flag is invisible to `/releases/latest`, and `/releases/latest` is exactly
what a stable electron-updater resolves (`GitHubProvider.getLatestTagName`; the token
path's `PrivateGitHubProvider` appends `/latest` the same way - both were read, not
assumed, in `node_modules/electron-updater@6.8.9`). Flip `allowPrerelease` and the same
provider reads the newest atom-feed entry instead - every build, the moment it is cut.
So: `releaseType: "prerelease"` in `package.json` and `--prerelease --latest=false` in
the workflow's `gh release create` make every automatic release a dev one, and
`config.devUpdates` → `setDevChannel()` → `allowPrerelease` makes any single install
the copy that takes them. The flag is re-asserted on every check, not trusted from
wiring time, because a setting that changes at runtime must not need a restart to mean
anything. The Mac's fallback path (`macFallback`, which answers from the releases API
when a release carries no mac feed) had `/releases/latest` hardcoded and would have
quietly pinned a dev-channel Mac to stable - it now asks per channel.

Tags stay plain (`v0.8.29`, never `v0.8.29-dev.1`): the GitHub prerelease FLAG is the
channel, so promotion is one metadata edit and stable installs update to exactly the
bytes the dev channel proved. A `-dev` suffix would have meant retagging or rebuilding
on promote - a second artifact that is precisely NOT the one that was tested.

`lane.mjs promote [version]` is the only door to stable, and it re-checks the two
failures this repo has already shipped before flipping the flag: a one-legged release
(v0.7.2 Windows-only, v0.8.0 Mac-only - either platform's feed missing) and a feed
whose declared size disagrees with the asset actually served (v0.4.27, the hash-check
death with no reporter). It then verifies `/releases/latest` really answers the
promoted tag, because the claim is what stable installs will see, not that an edit
exited 0. `doctor` lists what sits unpromoted so a quiet dev channel is visible;
`status` deliberately does not - it must stay offline.

Older installs (≤ v0.8.28, `allowPrerelease` never set) already resolve
`/releases/latest`, so they wait for promotions correctly without knowing the channel
exists. `install.sh` / `install.ps1` and the README's fixed-name links all go through
`releases/latest/download/`, so a first-time install is always the promoted build.

`npm run test:promote` drives the command against a stubbed `gh`; `test:updater` pins
the channel flag's default, its flip, and its re-assertion per check.

The checkouts on disk are `PaneForge`, `-a`, `-b`, `-c`. They used to be
`claude-orchestrator*`, and `scripts/rename-repo.mjs` moved them: `git worktree move` for
each lane, then the main checkout, then `worktree repair`, then the lane state's stored
paths. `scripts/rename-repo-test.mjs` (`npm run test:rename`) still proves it on a
throwaway repo, including that the worktrees answer git from their new paths. Both names
still resolve everywhere - `laneBoard.ts`, the lane hook in claude-memory, `try.mjs`'s
profile naming - so a Mac that has not been renamed keeps working.

What held it up for two days is worth keeping: the script's guard tests "in use" by
renaming the folder and putting it straight back, and that kept failing with EBUSY while
NO process had the folder as its working directory. The holder was an orphan headless
`conhost.exe` from a pane whose chat had died, plus `git rev-parse --git-common-dir`
processes hung there for 23 hours. `handle64 -u <dir>` is what names such a holder;
nothing in Node or PowerShell will. The hung git is fixed at the source - every `git()`
in `scripts/lane.mjs` now has a 20s deadline, so a stuck git can no longer outlive the
chat that spawned it and squat on the checkout.

The scheduled task (`PaneForgeRename`) that was going to do this unattended has been
deleted; `Projects/.autosync/paneforge-rename.mjs` is its harmless leftover copy.

`package.json`'s `name` stays `claude-orchestrator` on purpose - Electron builds
`%APPDATA%\<name>` from it, so changing it moves the installed app's config, workspaces
and single-instance lock. That is a migration, not a rename, and it buys nothing anyone
can see.

## An update may never need a person

The promise is the one every installed app makes: install once, update from the app, for
ever. Measured against it, this app has failed three times, and every failure was the same
shape wearing a different coat.

**2026-08-06.** The Mac sat on 0.4.45 from Aug 3 with the badge frozen at 33%. Cause was
`fetchTo` in `macUpdate.ts` never settling when the v0.4.62 body stopped arriving at exactly
30 MiB of 95.8 MB - no `'error'` handler, no `'aborted'` handler, a truncated body reaching
`'finish'` and resolving. v0.6.0 settled every path in that file, added a watchdog on BYTES
rather than on the socket, and raced staging against a 30-minute deadline.

**2026-08-07, the next morning.** Same Mac, same 33%, still 0.4.45. Nothing had regressed:
**v0.6.0 fixed the updater in the release, and the updater is what delivers releases.** A
machine whose updater is the wedged component never receives its own fix. Quitting installed
nothing either, because the quit swap asked `phase === 'ready'` and the phase said
`downloading`. The only way back was replacing `/Applications/PaneForge.app` by hand.

Three lessons, and only the third is structural.

1. **A fix to the update path needs an out-of-band install for the machines already stuck,
   and that is part of shipping it, not a follow-up.** Here that is a detached watcher
   holding the app's own `swap.sh` open, waiting on the running pid.
2. **A phase is a live flag; a staged bundle is a fact on disk.** When the two disagree the
   fact wins. `stagedInstallable()` reads memory only (set at launch by `adoptStaged()`),
   because it is called on the way out and must not scan or delete anything. Installing a
   build older than the one that failed to download is right: it is still newer than what is
   running, and the next launch looks again.
3. **The recovery may not live inside the thing that can hang.** This is the whole of it.
   Settling our own downloads fixes one promise and leaves the shape intact, and
   `electron-updater`'s check and download are not ours to settle at all. So:
   - `set()` stamps `phaseAt` on a phase CHANGE (a percent tick must not restamp it, or a
     download that stalls at 33% looks fresh for ever). `busy()` drops a transient phase
     past its budget and logs `wedged`. Budgets are generous - hotel wifi must never trip
     one - and every one is env-overridable so the test takes 150ms instead of 45 minutes.
   - `probing` is the same flag one size down: `supersede()` sets it, discards every update
     event while it is set, and unwinds it in a `finally` a hung check never reaches. Same
     treatment, `PROBE_BUDGET_MS`.
   - **The poll is armed before the await as well as after it.** `arm()` lived only in
     `pollOnce`'s `finally`, and `finally` is not reached while an await hangs - so one
     unsettled promise did not merely wedge the phase, it ended the background poll for the
     life of the process, leaving nothing to notice the wedge or undo it. A healthy turn's
     `finally` re-arms at the ordinary cadence and replaces the watchdog, so nothing polls
     faster than before; only a turn that never returns is affected.

`update-health.json` is the fourth piece and the cheapest: `lastGood`, a count of recovered
wedges, and the last one's name. A recovered wedge otherwise leaves no trace once the phase
resets, and the thing worth knowing is never any single one - it is "this machine has not
had a good look at the feed in four days". Silence is what made the last one cost a day: an
empty log reads exactly like nothing to do. Three days logs `health STALE`.

`npm run test:wedge` (also the second half of `npm run test:updater`) hangs the stub on
purpose - a promise with no ending at all, not a slow one - and asserts each of the four
recovers unattended, including the reported symptom itself: `download-progress` at 33%,
which is the exact number this Mac sat on. The staged-bundle half runs for real on macOS and
skips out loud elsewhere. Writing it caught one thing worth keeping: the first attempt never
reached the hang, because the phase was still `checking` from the previous case and `busy()`
correctly refused - a test of a recovery path has to reach the failure first.

## Never take the screen

The app hosts the chat and runs all day beside real work, so nothing it does on its own
may take focus, raise a window, or pop a dialog. Only a click or a hotkey earns the
foreground.

- Show a window the user did not ask for with `showInactive()`, never `show()`.
  `focusWindow()` is for user-initiated paths only.
- A launch nobody asked to see (`npm run try`, i.e. `--minimized`) shows nothing at all on
  macOS. `revealPlan()` in `src/main/profile.ts` decides that per platform: Windows still
  has to `showInactive()` then `minimize()`, because a window that was never shown cannot
  be restored from its taskbar button - but doing the same on a Mac is a window appearing
  over your work and genie-animating into the Dock on every launch, which is what
  developing PaneForge felt like all day. The Dock icon of a running app is the way back
  in: `activate` (and `did-become-active`, for Cmd-Tab) reveals it, ignoring the
  activation macOS emits for the launch itself. `npm run test:quiet` pins both halves.
- A restart the app decided on (update, admin relaunch) calls `markQuietRelaunch()` in
  `src/main/profile.ts` before exiting. The new process consumes that marker, starts
  `inactive` and flashes the taskbar button once instead of stealing the keyboard.
- No `dialog.showMessageBox` for anything the app decided by itself - in-renderer cards
  (`UpdateToast.tsx`) instead. No `setAlwaysOnTop`, no `moveTop`, no `app.focus`.
- Every `spawn`/`Start-Process` keeps `windowsHide: true`; a console flashing is a focus
  steal too.
- `second-instance` must not raise the window while `installStarted` is set: mid-update
  the installer's launch of the new exe arrives on that event.

Holding the screen back is allowed to delay the window. It is not allowed to lose it, and
for a while it did. `gameMode.ts` has an escape hatch for "a game that is RUNNING is not a
game that is ON SCREEN" - `setFocusProbe`, which answers whether our own window is visible
and focused. At the launch reveal that window is the one which has deliberately never been
shown, so the probe is false by construction: a game merely left running held the reveal
back, and the reveal was the only thing that could ever have made the probe true. With
cs2.exe up for hours at a time on this machine, "until the game exits" was not a wait, it
was a stop - a live app with no window and no taskbar button, which looks exactly like an
update that failed to restart, and got reported as one twice.

So the foreground window's process is now asked about directly, in the two places where
the answer decides whether the app gets to exist on screen: the launch reveal, and work
already sitting in the deferred queue. Alt-tabbing out of a game is enough; it no longer
has to close. The query is a P/Invoke through PowerShell and costs ~600ms, which is why
the 15s poller still uses `tasklist` and this is asked ONLY while something is being held.
Every failure mode answers "not a game" on purpose.

Two numbers to keep, both measured rather than assumed: main reaches `whenReady` in ~307ms,
so a launch that appears slow is never boot - every boot line carries `+<ms>` since process
start now, precisely so the next report of "it came back too slow" has a figure instead of
a silence. And that ~600ms is why `test:quiet` waits for the reveal decision to appear in
the log rather than sleeping a fixed 2.5s past it; with a game genuinely on screen it SKIPS
out loud, because a file that cries wolf every time there is a game up is how a real
regression here gets waved through.

## Two machines, one desk

`src/main/remote/` lets a second device drive this one's panes. Both ends are peers -
each can host and each can connect out - so there is no setting deciding which machine
you have to be sitting at.

The pty never moves. A mirrored pane's agent, checkout, transcript and worktree all stay
on the device it was opened on; the other window watches and types. Moving a run would
mean moving the folder it is editing, which is the one thing that cannot be done over a
socket. "Continue where I left off" is therefore *remote control*, not migration.

Session ids are the seam. A mirrored pane is `@<device>/<id>`, and `remote.owns(id)` in
`main/index.ts` routes every pane message to the link instead of the pty manager - so
the sidebar, the palette, the grid and every shortcut treat it as an ordinary pane.

Three decisions worth not re-litigating:

- **The host owns the terminal's size.** A mirror is drawn at the far end's cols/rows
  (carried on `Session.cols/rows`) and shrinks its own font to hold them. Two windows
  both fitting one pty trade SIGWINCHes forever, with a full-screen CLI repainting its
  whole frame every round.
- **A mirror never reports the busy footer.** The device the agent runs on is reading
  the same frame in its own window, a few frames ahead; a second opinion arriving late
  can only contradict it, and a false "finished" is the chime firing mid-turn.
- **Frames are decoded where they are consumed, not where they arrive.** The last
  handshake frame and the first encrypted one routinely land in one TCP segment.
  Decoding eagerly read ciphertext as JSON and killed the link a moment after it came
  up - and whether it happened depended on how the kernel split the packets, so it
  looked like a flaky network. `scripts/remote-test.mjs` pins it.

The pairing code is the whole secret: never sent, only proved, and the traffic keys are
derived from it (scrypt, then AES-256-GCM per direction). That is why rotating it cuts
every paired device off rather than just changing what to type next time. Hosting is off
until switched on, and discovery is a UDP broadcast that carries no secret.

### Pairing two desktops with no code typed, and what actually authorises it

A phone can scan. A desktop cannot, and the invite blob only replaces typing when the two
machines share a clipboard — a Mac and a Windows PC do not. So the seamless path for two
desktops is the other shape: **tap the device you found, it asks, somebody approves over
there.**

The thing to be careful about is what that button proves, which on its own is *nothing*.
The pairing code proved the person had been at the other screen. A card saying "Gamer-PC
wants to pair" proves only that something on the network sent a name it chose. So the
authentication is moved into a number:

- The two ends agree a secret over X25519. That defeats an eavesdropper and does **not**
  defeat a machine in the middle, which simply agrees one secret with each side.
- Six digits are derived from the shared secret **and both public keys**. A relay
  necessarily holds two different secrets, so the number it can show the joiner is not the
  number the host computes. The human comparing two screens is the check; this is Bluetooth
  numeric comparison, and it is why the card leads with the digits rather than the name, and
  why the same block is drawn on the waiting side too.
- Six rather than four: an attacker gets one guess at a mismatch passing unnoticed, and six
  makes that one in a million.

`scripts/pair-ask-test.mjs` stands up a **real relay** — a server that faces the joiner as a
host and asks the real desk at the same time — and asserts the two numbers disagree. That
case is the reason the file exists; everything else in the flow could have been checked by
using it.

Two decisions that keep the blast radius small:

- **Approval hands over the ordinary pairing code**, sealed to the agreed secret
  (AES-256-GCM), and the joiner then reconnects through the existing code path. Stored
  peers, reconnects, and `New code` cutting everyone off all keep working unchanged, and the
  new crypto exists only for the length of one pairing.
- **The ask socket is never armed and never becomes a guest.** It carries no session, which
  is why `host.list()` stays empty across the whole exchange.

`PROTOCOL` stays 1. `askpair` is a third message type in the second slot of the same
handshake, and a build that predates it fails to recognise it and refuses — which is the
right answer, because it has no way to show anybody a card. Bumping would have broken every
already-paired device to announce a path neither end would ever take with the other.

The wait is a person, so it gets its own budget (`APPROVE_MS`, two minutes) rather than the
handshake's ten seconds. That budget exposed a real gap the tests caught: `server.close()`
does not touch a socket that is already open, so switching hosting off left the far end
watching "waiting for approval" until its own timeout, with nothing left here that could
ever answer. `RemoteHost` now tracks sockets that are connected but not yet guests and drops
them in `stop()`.

The Approve card is rendered from `App`, not from the Devices dialog: the request arrives
while somebody is standing at the *other* machine, so a card only that dialog could show is
a request nobody would ever answer. It obeys "never take the screen" — corner, not modal, no
focus stolen, no window raised; the focus it does take is within the window, so Enter is
Deny.

## The phone is this window, served

There is no second app and there will not be one. Every runner in the category shipped a
phone client in the last nine months and they all shipped the same one - the desktop keeps
the agent, the phone watches it and answers it - and T3 Code, Orca and the rest each
maintain iOS + Android + web + Electron to do it. We maintain one renderer, because the
renderer imports nothing from Electron and nothing from Node: it is pure UI over
`window.api`. Supplying that object over HTTP is the whole client (`src/main/phone.ts`,
`src/renderer/src/browserApi.ts`).

What actually stopped it before was not the UI and not the transport. It was that the
mapping from method name to IPC channel existed only as 141 hand-written closures inside
the preload, so a second transport meant re-typing every one and drifting the first time
anybody added a channel - the `promptKey.ts` failure mode, a lookup that quietly stops
finding things. So the mapping is data now, in `src/shared/surface.ts`, typed as
`{ [K in keyof Api]: SurfaceEntry }`: a method added to `Api` without a channel does not
compile, and both transports are built from the one list. The preload is 38 lines.

- **Calls land in the app's own handler, not a copy of one.** Electron has no public way
  to call your own `ipcMain.handle` body (`_invokeHandlers` is private and a rename from
  breaking in silence), so `src/main/ipcTap.ts` records the registrations as they happen -
  which is why `tapIpc()` runs at the top of `index.ts`, above them. 134 of the 135
  handlers ignore the event object; the one that does not is `recents:drag`, handing a file
  to the OS drag layer, and it gets a sender that says it is gone rather than a fake window.
- **Events down one stream, calls up as POSTs.** SSE, not a WebSocket: the repo has three
  runtime dependencies and a socket here would mean a fourth or hand-rolled RFC 6455
  framing. SSE also reconnects by itself, which is what a phone locking its screen needs.
  `send` is fire-and-forget AND ordered - a keystroke then a resize must arrive that way
  round - so the client queues sends, keeps one request in flight, and a burst of typing
  collapses into one POST. `broadcast` sits *ahead* of the window check in `send()`: a
  phone must keep receiving output while the window is minimized or being rebuilt.
- **Off until switched on, and the code is the door.** Anything that can type into a pane
  can run commands on this machine. An unpaired browser gets one 40-byte page and nothing
  else - not the UI, not one asset - and five wrong codes buys that address a minute of
  silence, including for the right code, because guessing is what is being stopped.
- **The cookie is derived, never stored**: `hmac(deviceId, code)`. A restart does not sign
  every phone out and rotating the code signs all of them out at once, with no token file
  to keep in step. The code is six characters from an alphabet with no vowels and no
  lookalikes: it is typed once, on a phone, off the screen in front of you.
- **What stops `/../../secret` is normalizing an absolute path**, which folds away every
  `..` that would leave the root - not the `startsWith('..')` line, which is a backstop for
  the day the input stops being absolute. Proved by mutation: removing that line fails
  nothing, removing the auth check fails eight assertions.
- **Bytes travel as base64** (`shared/wireJson.ts`). Two calls on this surface carry a
  `Uint8Array` and plain JSON turns those into `{"0":12,...}` - four times the size, and on
  the way back an object the caller reads NaN out of.
- **A phone is not a small desktop.** The window is a 282px sidebar beside the panes; at
  414px that leaves a pane 132px wide, which is a 16-column terminal - not a small version
  of this app, a broken one. Under 720px the two take turns (`handheld.ts`, one `@media`
  block in `styles.css`): the list is the home screen - it already says which project,
  which agent and who wants you, and it already holds Fleet, Swarm, search and Settings -
  and a tapped pane gets the whole display with one 34px chip back. The tap has to hand
  over the screen even when that pane was already active, which is the normal case coming
  back from the list, so the row's click says so rather than something watching `activeId`.
  One of the two halves is `display: none` rather than translated away: an xterm laid out
  at 0px reflows its buffer to one column and does not come back.
- **The pty never moves**, exactly as in the section above. A pane's agent, checkout and
  transcript stay on the machine the pane was opened on.

`npm run test:phone` is the server with no browser and no Electron: what it refuses, what
it routes, and the parity - every method on the surface has a handler in `src/main`, the
preload names no channel of its own, and every event `send()` pushes is one the surface can
subscribe to. `npm run test:phoneview` is the half that test cannot reach: system Chrome,
headless, at 414x896, against a running copy. It types the code into the pairing page the
way a person does (the cookie is HttpOnly - there is no shortcut), opens a pane *from the
browser*, types into it and reads the echo out of the terminal's own buffer, then measures
the handheld layout. Reading that echo out of `document.body.innerText` finds nothing, ever:
xterm draws to a canvas, so the text is in `window.__pf[id].term.buffer`, and a test looking
in the DOM fails against a perfectly live pane.

Not built, and the UI does not pretend otherwise: there is no headless host (the app has to
be running - TODO B1) and no phone-first diff view (H2). Reaching it from outside the
network is a tailnet address, which is why `phoneUrls` sorts 100.64/10 first.

### Scanning asks; a press on the desk answers

The QR carried the code for a while, in the fragment, and that solved the typing. It did not
solve the thing underneath it, which only became visible when Robert asked to see "the
connected devices" and there was nothing honest to show: **the cookie was
`hmac(deviceId, code)`, so every browser that ever used the code held the identical one.**
There was no list of who was in, no way to remove one of them, and `New code` - which signs
out all of them at once - was the only revoke that could exist. A per-row `Disconnect`
button would have been a lie: the stream returns immediately, because the cookie is still
good.

So the picture is now the bare address and the secret is minted at the other end. The phone
opens the link, `POST /pf/ask` raises a card on this desk with four digits that are on both
screens, and Approve mints **that browser** a 32-byte token. What follows from that one
change:

- there is no secret on screen at all, so a photograph of the Devices panel is worth
  nothing, and nothing has to be read across a room;
- a device can be signed out **by name**, and it means it - `who()` looks the token up in
  the list on every single request, so the stream ends and the next request gets the pairing
  page (verified against a running copy, not only in tests);
- an approved phone survives restarts and the app's own updates, because the list is in the
  config like everything else that has to outlive the process;
- the four digits are not a password and are never sent by the browser. They are generated
  here and shown in both places, so Approve is a statement that *the phone in your hand is
  the one that asked*.

Nothing is granted by asking - the card is a refusal until it is answered. Anything that can
reach the port can raise one, which is what an open port means, so: one request stands at a
time, five per address per ten minutes, two minutes to answer, and the card says where the
request came from. An `internet` origin (which is what a tunnel makes every phone) is drawn
in the warning colour rather than like the phone in your pocket, because those two are
answered differently. The whole thing is a switch; off, the QR goes back to carrying the code
in the fragment and the old zero-tap path is exactly as it was.

The code is still there, still typed on a phone with no camera, and `New code` still signs
out everything that used one. What it no longer has to be is the only way in.

### The code in a fragment, and why not an account

Six characters is small, and it was still the only typing left in the product, done in the
worst place there is to type: an on-screen keyboard, phone in one hand, copying off a screen
a metre away. So Settings drew the address and the code together as a QR, the camera app
opens it, and pairing is one tap. That is the fallback path now, not the main one.

**OAuth and email were asked for and refused, and the reason is not effort.** Both are
identity services, and identity is not the question this link asks. What is behind the code
is a pane, which is a shell on this machine, on this network - and every part of that
sentence is local. An OAuth flow would need a provider, an internet round trip and a public
HTTPS redirect target, which `http://192.168.1.23:7312` categorically is not (Google, Apple
and GitHub all refuse a private-IP redirect URI); that means a cloud service PaneForge does
not have and should not want, and it means the desk cannot be paired to on a network with no
way out. Email is worse in the way that matters: a magic link is a bearer token for a shell,
sent through a third party, sitting in a mailbox for ever, and it is *slower* than typing six
characters. Both trade a secret that never leaves the room for a secret that leaves it, to
save six keystrokes.

The QR keeps the secret in the room, and the shape of the link is the careful part:

- **The code rides in the fragment**, `<address>/#<code>`, not the path and not a query. A
  browser never sends a fragment to the server, so the code is in no access log, no proxy in
  front of this, and no `Referer` of anything the app loads afterwards. The pairing page
  reads it and POSTs it exactly as a person would - same endpoint, same lockout counting it -
  and then drops it out of the address bar with `location.replace`.
- **A wrong or stale scan falls through to the form.** The page is the same page; scanning
  only fills it in.
- `src/shared/qr.ts` is the encoder, no dependency and nothing downloaded. Byte mode, error
  level M, versions 1 to 6 - the longest address this app can produce is
  `http://255.255.255.255:65535/#ZZZZZZ` at 36 bytes and version 5 holds 84. Stopping below
  version 7 is what keeps it under 300 lines: 7 is where a symbol starts carrying a second
  version block with its own table and BCH code. It **throws rather than truncates**, because
  a QR that encodes half an address still scans, and sends the phone somewhere wrong.

**The test decodes; it does not compare.** The first version of that file built the generator
polynomial in reverse - `next[j] ^= mul(poly[j], EXP[i])` where it needed `next[j] ^= poly[j]`
- so every error-correction codeword was wrong. The symbols had the right version, the right
size, the right finders, timing patterns and alignment patterns, and the right data modules;
they differed from a reference encoder's output no more than a different mask choice would;
and not one of them could be read by any scanner. `npm run test:qr` therefore reads the drawn
symbol back the way a scanner does - format bits for the mask, the zig-zag walk,
de-interleave, every Reed-Solomon syndrome must be zero, then the payload out - for every
version at every mask, plus one fixture of error-correction codewords taken off a symbol an
independent encoder produced. Nothing weaker catches this class of bug. (Encoders differ
harmlessly on how much zero padding follows the terminator, which is why that fixture pins
the arithmetic directly instead of comparing finished symbols.)

`test:phoneview` covers the other half: a real headless Chrome opening the scanned link and
landing in the app with nothing typed. Each case gets its own target, because a URL that
differs only in its fragment is a same-document navigation - assigning `location.href` does
not reload the page, the inline script never re-runs, and the result reads exactly like a
broken feature.

## Every colour is derived, and every pane says which project it is in

Two rules that touch nearly every file in the renderer, both added 2026-08-01.

**There is no palette.** `src/shared/theme.ts` computes one from a single accent, and the
window reads it as CSS variables written onto `:root` by `applyTheme`. The literals still
at the top of `styles.css` are the ~40ms fallback before a config loads, not the source -
change them and you change the flash, nothing else. Adding a colour means adding it to
`paletteFor`, never to a component.

The maths is Oklab, hue and chroma held while lightness sweeps, because per-channel RGB
clamping does not desaturate - it HUE-SHIFTS, so a violet surface quietly becomes a blue
one at the dark end of the ramp and nothing says why. `inGamut` binary-searches the chroma
that fits instead.

Nothing about the ladder was chosen; it was fitted. The palette that shipped measures
L 0.1462 / 0.1749 / 0.2035 / 0.2391, so the steps are 0.0287, 0.0287, 0.0356 - which is
where the `0, 1, 2, 3.24` multipliers come from, and where `depth ^ 1.93` comes from: that
exponent is the one putting the shipped `depth: 0.3` exactly on 0.1462. Linear it landed
at L 0.32, a mid grey, because a slider whose ends are black and white spends most of its
travel in a range no dark UI uses. The consequence to remember is that **light themes live
above ~0.9 on that slider**, which is why Paper is 0.98 - at 0.72 it rendered #6d6b68 and
at 0.95 #d2d0cd, both measured in the real window and both dingy.

`npm run test:theme` is 358 assertions and its load-bearing half is contrast: every preset,
and every hue on the wheel at full tint, must clear 4.5:1 for body text and 3:1 for the
grey second lines. That is the only failure this feature has and it is invisible to whoever
picked the colour - they know what the text says. It also pins that a config nobody has
touched still draws the app that shipped.

The default accent `#f0a868` is the icon's own top ember pulled off full orange. The
sidebar mark is the icon's geometry (`split: 0.415`, gap 0.043, radius 0.032 from
`make-icon.mjs`, inset removed) in `currentColor`, so it follows the accent. Before this
the two marks were drawn independently and had different splits - the sidebar was a
different logo from the taskbar.

**Every pane says which project it is in.** `src/shared/place.ts` is the only thing allowed
to turn a folder, a branch, a worktree suffix and a lane id into words. It exists because
the strip printed `lanes main master`, where `main` is a lane id and `master` is a branch
and neither names anything you could go and look at - and once lanes worked in any repo,
several rows said `master` at once for different repositories.

The rules, and where each came from:

- The project name is never omitted and never abbreviated. Everything else is added only
  when it is not implied, so one pane in one repo on its trunk reads `PaneForge` and
  nothing else - the common case, which is what you read past to reach the unusual one.
- A trunk branch is dropped rather than printed. No editor does better (VS Code prints
  `main` in the status bar like any other branch); the one shipped product that improves on
  it is Vercel, which labels default-branch deploys "Production" - a ROLE where the name
  would be. So `master` is answered ("main checkout"), not hidden.
- A branch some tool generated to hold a copy is dropped too: `pf/w2`, `lane-a` and Claude
  Code's `worktree-<slug>` all repeat the copy's own number.
- There are TWO numbers and they are worded apart on purpose. `copy 2` is the second
  checkout of that project; `pane 3` is the third card in the sidebar and Ctrl+3 reaches
  it. They are independent - the second copy of a repo is very often not the second pane
  on screen - so a bare `#2` beside a `3` key was one number too many with no way to tell
  which was which. Only the pane number is a keystroke, and only chats are named by it
  ("pane 3 has it", against eight characters of a session id only when there is no pane).
  Claude Code names worktrees `bright-running-fox` and Conductor uses city names; neither
  can be typed, which is why numbers are worth keeping despite needing the disambiguation.
- `-a` is stripped only when the caller already knows the folder is that lane, never
  guessed: `service-a` is a real project name. Only `-w<digits>` comes off unasked.

`npm run test:place` is 56 assertions on the strings themselves. One of them is a refusal
that the real window found: the sidebar has no `git status` of its own on purpose (one per
card, to print a word), so its tooltip claimed "not a git checkout" about a checkout with
19 uncommitted files. An absent fact and a known-negative fact are not the same thing and
only one is safe to assert.

`laneWords.ts` is built by esbuild in `lane-holder-test.mjs` now, not `tsc` on the one
file: `tsc --rootDir src` emits `from '../../shared/place'` with no extension, which Node's
ESM loader refuses, so the moment that file gained a runtime import the test died on a
module-not-found naming a temp directory.

## What a pane leaves running

Quitting kills each pty with `taskkill /F /T <pid>`, and that is a tree walk over live
`ParentProcessId` links performed at the moment of the kill. Two ordinary things sit outside
it, and `src/main/strays.ts` is both of them.

The first was measured rather than assumed, and it is not the obvious one. Windows keeps the
parent field after the parent dies - it is a number, not a link - so an orphan is still
listed as its dead parent's child. What breaks is the WALK: with the middle process gone from
the table there is no row joining the pty to the leaf, so `npm run dev` (npm exits, vite keeps
going) leaves a dev server the pane's own kill can never reach. The second is the app dying
without running `shutdown()` at all - a crash, the installer, a power cut. There the tree is
intact but its root is gone, and `taskkill` refuses a pid that no longer exists, so there is
nothing to walk from. Both are pinned as real processes in `npm run test:strays`.

Neither link can be recovered afterwards, so the app writes it down while it is still true: a
sampler walks each live pty's descendants every 30s and merges what it finds into
`strays.json` under userData, keyed by the app run that owns it. Closing a pane, quitting and
the next launch all kill from that ledger rather than from the process table.

Three rules it must keep, all of them load-bearing:

- **A pid is never enough.** Every record carries the process's creation time, and the check
  is re-made by whatever does the killing rather than trusted from the file. A ledger written
  before a reboot names pids that now belong to a browser.
- **A run whose app is still alive is somebody else's.** That is another copy of PaneForge -
  usually the `npm run try` one - and sweeping it would kill panes a person is typing in.
- **Nothing here may block the main process.** Every process-table read is `execFile`, and
  the two paths that cannot wait for a callback (a pane closing, the app exiting) do not read
  the table at all - they hand the pids to a detached script that verifies them once we are
  gone. A `spawnSync` here is the busy cursor the pane badges' `git status` is banned for.

It never asks what the pane is RUNNING, which is the point: claude, codex, gemini, aider or a
bare shell all leave descendants the same way, and a per-CLI hook would be written once per
agent, out of date the day a new one ships, and silent in exactly the crash case above.

POSIX needs almost none of it. node-pty's child is a session leader, so a pane's descendants
share a process GROUP - inherited, not linked, so it survives an intermediate parent dying -
and one `kill(-pid)` reaps the lot. The ledger stays there only for a run that died without
killing anything.

The test's own lesson is worth keeping: it stubbed `spawnDetachedNoWindow` with a plain
`spawn(..., { detached: true })` and every kill silently did nothing, because that is the
exact shape `consoles.ts` exists to avoid on this Windows build. It loads the real module now.
A stub of the one line that is hard on this platform is a test that passes while the app leaks.

## A reopened pane comes back with what was on its screen

Built 2026-08-07, and the reason it is written down is that it looked expensive and was not.

The complaint is ordinary: the app updates itself, every pane reopens, and every one of them
is blank. `scrollback: 20000` in `TerminalPane.tsx` is xterm's own buffer and it lives in the
renderer's memory, so it dies with the window. The pane is not empty in any interesting
sense - the agent is right where it was, mid-conversation, because `resumeId` put it back
there - it just has nothing to show for it, which is worse than empty: the one thing on
screen is a fresh prompt under a title claiming a conversation you cannot read.

`test:restore` is the test that sounds like this one and is not. It pins which conversation
a reopened pane goes back into, which is the agent's memory. Nothing there is about pixels.

The obvious build is a new store: tee each pane to a capped ring under userData, prune it,
cap it, test it. That work is already done and has been for months - `history.ts` appends
every pane's RAW output to `userData/history/<id>.log` for the transcript search, capped at
8 MB per pane and pruned by `test:history`'s age and size rules. So the feature is a read.
`tail(id, bytes)` gives back the end of that file and `start()` writes it into the new
pane's `OutBuffer`, which is the same buffer a re-mounted pane already redraws from - the
renderer needed no change at all.

What was genuinely missing is one field. A restored pane is a NEW session with a new id, so
nothing joins it to the log the old one wrote; `snapshot()` now writes `scrollbackId` (the
LIVE id, the one the log is named after) into the desk, and `start()` reads it. Save the
wrong id there and the feature does nothing, for ever, without an error - which is why the
test asserts the saved id is the live session's, not just that the field is a string.

Three details that are each a visible bug when got wrong:

- **The tail is raw.** `read()` strips ANSI because it answers "what was said" for search;
  this answers "what was on screen", and the colour, the box drawing and the cursor moves
  ARE what was on screen. A stripped replay looks like a log file, not a terminal.
- **The cut is on a line boundary.** Slicing raw terminal bytes at an arbitrary offset lands
  inside an escape sequence often enough to matter, and the terminal then prints the tail of
  that sequence as literal text across the first line - `31mred text...`. Dropping up to the
  first newline costs one partial line and removes the whole class.
- **The mark resets first.** The caption that says where the old output ends is written
  straight after a tail cut mid-run, so whatever attribute was in force at the cut would
  bleed into the caption and then into everything the new process writes.

The cap is the buffer's 400 KB, not the log's 8 MB: what comes back is what a pane already
keeps in memory, not the whole day. That is deliberate - the promise is "the screen you
left", and a pane that replays twenty times its own scrollback on every launch is a
different, slower feature nobody asked for. `npm run test:scrollback` drives the real
`SessionManager` with the pty stubbed, and pins both halves plus the 2 MB case.

## The app remembers what has been asked

The expensive part of a repeated ask is never the typing. It is the agent re-reading the
repo, re-searching GitHub and re-deriving an answer that already exists, at full token price,
because nothing in the loop remembers the question was settled in March. Robert asked for a
safeguard that stops that early, across every CLI he uses.

**Why it is not a CLI hook, which is the obvious build.** Claude Code has
`UserPromptSubmit`, and Robert's `claude-memory/claude-config/prompt-dejavu.mjs` already uses
it — that hook is where this idea comes from and it works well. It also covers exactly one
agent. Codex has no equivalent, and `shared/agents.ts` lists thirteen. A hook-based version
is therefore a feature that silently does nothing for twelve of them and needs rewriting
whenever a fourteenth ships.

PaneForge hosts the pty, and `shared/draft.ts` already reconstructs what is being typed from
the raw bytes — that is how the Improve chip knows there is a draft at all. Reading the
archive from there means the agent's identity stops mattering: it sees what a person typed,
not what any particular CLI does with it. That is the whole argument for building it here.

**What it deliberately does not do.** It never blocks, never types into the pane, never
cancels a run. A repeat is frequently intentional — the same deploy check every morning, a
retry of something that failed — so an interruption that has to be dismissed would be wrong
more often than a chip that can be ignored. Being wrong costs a glance, which is the right
budget for a heuristic running on somebody's half-typed sentence.

**The quiet window is the load-bearing part, not the score.** `QUIET_MS` is six hours, and
without it the feature fires hardest exactly when it is least wanted: a prompt reworded and
re-sent two minutes after the first attempt failed is the same piece of work, and being told
"you have asked this before" at that moment is both true and useless. Every threshold in
`promptKey.ts` could be tuned and the feature would survive; drop the quiet window and it
gets switched off in a day.

**Only submitted lines are recorded**, never drafts. An archive of half-written sentences
would match badly, and it would also be a record of things somebody decided not to say. What
is stored is the token set plus a 300-character preview — enough to match on and to show,
never the full text.

**`src/shared/promptKey.ts` is a fourth copy, on purpose, and that is a real hazard.** The
same algorithm lives in Robert's `claude-memory` hook, the TaskDriver archive server and the
Discord bot, and those three share one archive keyed by a hash of the sorted token set. Any
drift between copies splits that archive into archives that never see each other's entries —
with no error and no symptom, just a lookup that quietly stops finding things. It is a copy
rather than an import because the app ships to people who have none of that and the feature
has to work on its own local history alone. `npm run test:recall` recomputes the canonical
file's answers over a shared corpus and asserts ours agree; when that file is absent it
**skips out loud**, because a silent skip is precisely how the copies would drift unobserved.

**What is honestly missing.** Nothing yet watches a pane's repo for the commit an ask turned
into, so `outcome` is null for every row this app records, and the tooltip says so in those
words rather than implying a lookup happened and found nothing. The outcomes that do appear
come from an external archive that already stamps them — which is how Robert's own history,
including prompts posted in Discord, reaches the chip: `promptRecall.extraArchives` merges
other JSONL files read-only. Writing into a file another tool owns would mean agreeing with
it about a format forever, and the two already disagree.

## Dictation needs nothing installed

The mic on every pane, and Ctrl/Cmd Shift Space into the focused one. It used to
require `pip install whisper-ctranslate2`, which is the version of a feature that
exists in Settings and is never switched on. `src/shared/voicePick.ts` picks between
three transcribers and `useVoice.ts` falls down them when one fails at run time.

- **`system`** - a whisper CLI on PATH, run by the main process. Fastest, fully
  offline, and now *preferred when it happens to be there* rather than demanded.
- **`inapp`** - Whisper in a worker in this window (`voiceWorker.ts`), ONNX Runtime's
  wasm build. Nothing to install. This is the default and the reason the feature works
  on a machine with no Python.
- **`browser`** - the browser's own recogniser. It streams words as you say them and
  costs no download, which is why it wins on a phone, and it is the one that sends
  audio off the device, so it is never chosen while a local engine exists.

Four things here are measurements, not opinions, and each one is a line somebody will
otherwise "simplify":

- **Feature-detecting `webkitSpeechRecognition` is not enough.** Inside Electron the
  constructor is present and every session ends `error: "network"` - Chromium's speech
  endpoint wants a Google key Electron does not ship. So `browser` is gated on *not*
  being Electron, judged by the user agent.
- **Every 8-bit build of these Whisper repos downloads and then refuses to run**:
  `qdq_actions.cc:137 TransposeDQWeightsForMatMulNBits / Missing required scale:
  model.decoder.embed_tokens.weight_merged_0_scale`. `q8`, `int8` and `uint8` all fail;
  `fp32` works at 151 MB for `tiny`; `bnb4` works and is the smallest that does, so it
  ships. The sizes in `shared/voiceModels.ts` move with that choice.
- **The wasm is ours, not a CDN's.** transformers.js defaults `wasmPaths` to jsdelivr;
  an engine that needs the network on every launch is not the offline promise the
  feature is sold on. `electron.vite.config.ts` copies the pair into `out/renderer/ort/`
  - and DELETES the 23.5 MB asyncify binary vite emits from onnxruntime's own
  `new URL(..., import.meta.url)`, which the worker never asks for. Without that the
  build carries 36 MB for a 12.9 MB job.
- **Nothing on the page may import the worker's module.** `MODEL_MB` used to live
  beside it; importing that one constant took the main renderer chunk from 1.01 MB to
  2.23 MB, because it dragged transformers.js and onnxruntime in with it. The constants
  live in `shared/voiceModels.ts`, which imports nothing.

The model is downloaded once from Hugging Face and cached, which is the only network
this feature does and why `index.html`'s CSP names `huggingface.co` (plus
`wasm-unsafe-eval`, without which WebAssembly cannot compile at all).

**A phone is not a small desktop.** On a touch screen or a window under 720px the act
of dictating takes the whole screen (`VoiceOverlay.tsx`) - the one overlay in this app
allowed to, because a finger asked for it. A 32px target beside a terminal is right on
a monitor and unusable at arm's length. The ring around the mic *is* the input level
off the analyser, so a mic that is not being heard shows it by not moving, which is
worth more than a label saying "listening". The overlay also appears on a desktop while
the model downloads: a once-ever wait belongs somewhere it cannot be read as a hang.

`npm run test:voice` is both halves - the ladder as arithmetic, and a sentence spoken
by the OS voice pushed through the shipped worker (2.6s of audio, ~1.8s to transcribe
with `tiny`), plus the overlay measured at 390x844 and asserted absent at 1400x900.
It skips out loud without a window or without macOS `say`.

## The app can run a lane itself, and refuses to call it done unheard

Shipped 2026-08-07 as phases I1, I2 and I3 of `docs/agentic.md`. That file is still the
reasoning and the survey; this section is what landed and what it cost to get right.

**The control channel is headless, not the pty.** `claude -p --output-format stream-json
--verbose` prints one JSON object per line carrying turn boundaries, tool calls, token
counts and an explicit end. `readsBusy()` infers one of those from terminal glyphs and has
to be re-taught every time a CLI redraws its footer. Panes keep the pty - that is the
product - and `shared/agentic.ts` parses the stream for anything the app drives itself.
An agent whose structured flag we do not know still runs, as `plain`: text, no tool count,
no token count. A worse answer, not a missing feature.

**Three things a driven turn must survive, and all three are spawned for real in
`npm run test:agentic`** - 66 assertions, ~4s, six real child processes and seven real git
repositories, no CLI installed and none startable (the `bin`/`argsPrefix` seam runs a stub
under `node`):

- **A turn that never ends.** The budget timer is armed BEFORE the first await, not in a
  `finally`, for the same reason `POLL_WATCHDOG_MS` is: a recovery that lives inside the
  thing that can hang is not a recovery. The stub ignores `SIGTERM`, so only the tree kill
  ends it, and the test asserts it died on time rather than eventually.
- **A turn that ends having done nothing.** The dangerous outcome is not a crash - a crash
  is loud - it is twenty minutes of tokens producing a comment. So the gate's FIRST step is
  the diffstat, and `noOp` calls two lines or fewer nothing. A CLI that exits 0 having
  printed nothing is `silent`, not `done`.
- **A new file that was never `git add`ed.** `git diff` cannot see one, so a lane whose
  whole deliverable is one new file would report itself as having changed nothing - and
  that is the signal everything above trusts. `diffSince` runs `git add -A --intent-to-add`
  first: the paths without their content, into the lane's own index.

**The gate's order is the design.** diffstat → typecheck → the repo's own suite → a
reviewer agent over the patch. Cheapest first, and the reviewer last because a diff that
does not compile has nothing worth an opinion about. Two things it will not do: a missing
step is reported as *skipped*, never as passed ("the suite passed" and "there is no suite"
are different sentences), and `parseVerdict` fails closed - a reviewer that timed out,
crashed or answered prose has NOT passed the lane. Defaulting that the other way is the
one change that would make the whole gate decorative.

**The reviewer runs in an empty directory.** It is started with the same
`bypassPermissions` posture as the lane it is judging, so inside the lane it could edit the
branch to agree with itself. Its whole input is the patch already in its prompt.

**The retry prompt is a local, not the lane's `note`.** `note` is the line the board shows
and every tool call overwrites it; parking the retry brief there means the second attempt
is started with whatever the first one was doing when it stopped - which fails again,
identically, and looks like the agent being stubborn. The test proves the second attempt is
a different attempt: the stub only fixes its file when it can see the failure text.

Two retries then stop (`MAX_ATTEMPTS` 3). An agent that has failed one gate three times is
not one retry away from passing it. Lanes run three at a time - a Max plan has no
concurrency cap, it has a five-hour token window, and 3-5 sustained agents is what that
window carries - staggered 900ms apart because N `git worktree add` on one repository is a
fight over one index lock.

**What a driven lane leaves running is our problem too.** A driven agent is spawned
detached, in its own process group - which is what makes the tree kill work and what makes
it survive us. It is not a pty, so `strays.ts` has never heard of it and the quit-time
`taskkill` walk does not name it. Without `stopAllDrives()` on the way out, quitting the
app leaves an agent editing a worktree with nothing left that can stop it. It is called
from `before-quit` and again from `hardExit`, because the second path does not go through
the first.

**A goal outlives the window (I4).** Everything up to I3 lived in a Map: the ask, the plan,
which lanes passed, which branch was sitting there reviewed and unmerged. That is fine for a
loop somebody is watching and useless for one that is meant to run while nobody is. So Drive
it queues a goal instead of starting a run - `goals.json` under userData, written to a temp
file and renamed, because the read happens once at startup and a half-written file at that
moment is the whole queue gone.

Four things it took to be honest rather than merely persistent:

- **One goal at a time.** Not a token decision - `MAX_PARALLEL` already caps the lanes
  inside a run at three, and a second goal starting beside it quietly makes that six against
  one five-hour window and one worktree pool. I5 is what turns the constant into a reading
  of the real budget.
- **A goal the process died holding is `interrupted`.** A fourth outcome, deliberately: its
  agents are gone, but the branch is not, and it holds whatever had been written when they
  were killed. `done` would put unread work under a heading that says ready to review;
  automatically re-queueing it would start a second agent in a worktree nobody has looked
  at, which is the one thing lanes exist to prevent. Retry is a press.
- **`recordOutcome` stamps, it never creates.** The prompt archive is fed from the bytes on
  their way to a pty; an ask it has never seen is a miss, not a new row. Inventing one would
  mean a mission typed into a dialog quietly became something the recall chip warns about
  later.
- **The debounce may not eat a state change.** Lane notes move on every tool call, so the
  file is written on a 500ms timer - but every transition calls `flushGoals()` first, and
  the recovery pass writes back immediately rather than returning a corrected list nobody
  persisted.

Found by building the test rather than by reading the code: a lane that throws - a malformed
plan was enough - escaped `driveLane` through `Promise.all` into the `void drive(...)` in
`startDrive`, as an unhandled rejection. The whole run died, the other lanes stopped
mid-work, and the board went on showing them as `working` for ever because nothing was left
to move them. `driveLane` is wrapped now and the lane fails alone.

Not built: the budget scheduler, hotspot locks and unattended mode (I5-I7). And by decision,
never: this merges nothing. `lane.mjs ready` stays a person's word.

## Checks

`npm run typecheck` before committing, and `npm test`.

`npm test` is `scripts/test-all.mjs`: the 34 checks that need no window, no network, no
real agent CLI and no minute of wall clock, run cheapest-first, 30.1s for the lot on the
Mac. It is not a new set of tests - every one of them was already in `package.json` under
its own `test:*` name and had been for weeks. What was missing was a script called
exactly `test`, and that name is load-bearing: `gateCommands` in `src/main/agentGate.ts`
resolves its suite step with `pick(cfg.gate?.suite, 'test', 'no test script in this
repo')`, so on the repo with sixty tests on it the gate that judges a lane **the app
drove itself** ran diffstat, typecheck, *skipped*, reviewer. The gate reported that
honestly - `skipped` is printed by name and never reads as a pass - and nobody read it.
That is the part worth remembering: a pipeline can be scrupulous about naming a step it
did not run and still be a pipeline nobody is running that step in. Check what the steps
resolved to against the real repo, not that the reporting is correct.

Which tests belong in it is a cost question, not a taste one. A driven lane waits on this
before a reviewer ever sees the diff, so the entry price is that a test catches its
regression by ARITHMETIC rather than by somebody looking at a pane. The slow ones
(`test:strays` spawns real orphans, `test:lanes`, `test:agentic`, `test:goals`,
`test:remote`), the ones that need a real window (`test:view`, `test:stashdrag`,
`test:activate`, `test:improveview`) and the ones that need the network
(`test:discordbrand`, `mac-update-test --live`) stay out, and the header of
`test-all.mjs` names each with where to run it instead. A failure prints that test's
whole output rather than a summary, because the reader is as often the agent being told
its lane failed as it is a person.

`npm run smoke` exercises the pty layer.
`npm run test:restore` covers what a reopened desk is made of: which conversation each
pane goes back into (never another pane's, never one older than the pane) and what the
dialog says it was doing. `npm run test:consoles` pins the sweep that kills console hosts
left behind - including the guard that stops it touching a console whose parent is alive.
`npm run test:strays` is the same question one level out, for what a PANE left running, and
it is the one test here that spawns real orphans: a child whose parent has exited, killed
from what the sampler wrote down, and a bystander whose pid is in the ledger with the wrong
creation time left untouched beside it. It takes ~25s for that reason.
`npm run test:gitpoll` drives a fake clock over the badge's `git status` cache, so the
thirty-second idle window is checked in milliseconds rather than by waiting.
`npm run test:install` starts a real install pty that sits there and proves quitting
takes its whole process tree - nothing is installed and nothing is written.
`npm run test:dock` keeps the macOS Dock icon: no window may ask to float over
fullscreen apps without `skipTransformProcessType`, because Electron implements that by
turning the whole process into an accessory and never turning it back - which is
`app.dock.hide()` for the app, from a line about one overlay window. On a Mac it also
runs a real Electron to check that Electron itself still behaves that way.
`npm run test:macupdate` is about the one thing that can leave a Mac with no PaneForge at
all: the app replacing its own bundle. It builds a real fake install, a real ditto zip and
runs the real swap script, and checks that the app is NOT moved while its process is alive,
that a failed swap puts the old bundle back, and that the relaunch is `open -g` (never the
foreground) - or absent entirely when the swap happens because the user quit. The download
half is proved against the live release with `node scripts/mac-update-test.mjs --live
<version>`, which is left out of the suite because it pulls ~120 MB.

`npm run test:macsign` is why the Mac stops asking for permission to read your Documents
folder every single release. macOS stores a TCC grant against the app's *designated
requirement*, and an ad-hoc signature has no certificate to name the app by, so that
requirement is the binary's own hash - `cdhash H"ec87a5..."`. This repo cuts a patch
whenever a chat finishes, the app auto-updates, and every one of those releases threw away
Documents, Desktop, Downloads, iCloud Drive, local network and Apple Events and asked for
all of it again. Nothing in the app can fix that: not an entitlement, not the
`NS*UsageDescription` strings, not `xattr -d com.apple.quarantine`, because none of them
is what TCC decided to key the grant on.

Signing with any certificate at all changes the requirement to `identifier
"com.robert.paneforge" and certificate root = H"..."`, which has no cdhash in it and
therefore survives every rebuild. `scripts/mac-cert.mjs create` makes that certificate -
self-signed, twenty years, `codeSigning` EKU - and prints the two repository secrets
(`PF_CERT_P12`, `PF_CERT_PASSWORD`) that let CI sign with the SAME one, since a second
certificate is a second root hash and one more reset. It buys nothing from Gatekeeper: a
self-signed build is still refused on first launch, so `install.sh` and `macUpdate.ts` go
on clearing quarantine exactly as before. The test pins the ad-hoc case as well as the
signed one - without it, it could not tell "the certificate fixed this" from "this was
never broken" - and its last assertion is the only one TCC actually depends on: change the
app, sign again, the requirement is byte-identical.

Four things it cost an hour each to learn, none of them visible from the code:

- `set-keychain-settings -t 0 -u`, which every guide to CI signing includes, asks the
  Security agent for authorisation. With no GUI session there is nobody to answer, so it
  fails as "User canceled the operation" - and it leaves the keychain in a state where the
  next call, the import itself, fails the same way. On a desktop it does worse: it puts a
  password dialog on Robert's screen for a keychain whose password is empty. It is gone;
  `mac-sign.mjs` unlocks the keychain a second before signing instead, which the 300-second
  auto-lock cannot outrun.
- The identity does not need to be TRUSTED. `security find-identity -v` hides it -
  `CSSMERR_TP_NOT_TRUSTED` - while codesign signs with it perfectly happily, and the kernel
  runs the result, quarantined or not. Trusting a root is another dialog nobody can click.
- The key lives in its own keychain, never `login`, because `set-key-partition-list` needs
  that keychain's password and the login one is Robert's. Without that call every signature
  dies as `errSecInternalComponent`, an error that mentions nothing about keychains.
- OpenSSL 3 writes a p12 macOS cannot read. `security import` reports "MAC verification
  failed during PKCS12 import (wrong password?)" about a password that is correct;
  `-certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1` is the fix.

The test's own fixture had never run on a Mac newer than Big Sur: it built its framework
out of `/usr/lib/libSystem.B.dylib`, which has not been a file on disk since the dyld
shared cache swallowed it, and the framework it built had no `Versions/A/Resources/
Info.plist`, which codesign rejects as "bundle format unrecognized, invalid, or unsuitable"
- while signing the MAIN executable, because signing anything inside a bundle walks the
whole bundle. Both are fixed and worth not reintroducing.

`npm run test:stashtheme` is about a different question, and the one a person actually
asked: *why does the Stash look different in the app than it does outside it?* Because
until 2026-08-07 it was two features. The in-window one (`RecentsFlyout.tsx`, rules in
`styles.css`) and the floating one (`shelf.tsx`, `shelf.css`) share not a single selector,
and only one of them was ever wired to the theme. Measured on a default install with a
probe against both live windows:

| | main window | Stash overlay |
|---|---|---|
| `--accent` | `#f0a868` | `128, 192, 255` |
| body text | `#efecea` | `#ecedf2` |
| surface | `#0d0907` (derived) | `rgba(38, 38, 48, .9)` (fixed) |
| inline `:root` variables | 33 | **0** |

Zero is the whole finding: `applyTheme` had never been called in that window, so the
literals in `shelf.css` were not the ~40ms fallback CLAUDE.md describes — they were the
palette. And light-or-dark came from `@media (prefers-color-scheme: light)`, which asks
macOS. macOS does not know which preset is loaded, so PaneForge on Paper with the OS in
dark mode drew a light window with a dark Stash floating over it and nothing in Settings
could reach it.

Three things that only turned up by reading the live window rather than the diff:

- The overlay's accent was called `--accent`, the same name the palette writes as a hex.
  `rgba(var(--accent), 0.2)` of a hex is not an error, it is a dropped declaration — eight
  rules would have gone transparent the moment the fix landed, silently. It is `--acc-rgb`.
- `parseHex` answers in 0..1, because everything downstream of it in `theme.ts` is Oklab
  maths. The first build wrote `--acc-rgb: 0.941, 0.659, 0.408`, which `rgba()` reads as
  ~1/255 and paints black. The probe read it back before anyone saw the window.
- Deriving the third text step as muted mixed 74% toward the background matched the old
  hand-picked `#74748a` on a dark card almost exactly, and measured **3.54:1** on Paper
  where the old hard-coded light value had been 4.81:1 — Paper's muted is already close to
  its paper. The faintest step is now `--muted` itself, which `test:theme` holds at 3:1 for
  every preset and hue. Read back in a real window: 13.08 / 5.77 / 9.22 on Paper and
  15.34 / 6.29 / 10.63 dark, body / secondary / buttons.

The test that came out of it is structural, not a contrast run, and deliberately: the three
text steps are now `--text`, `--muted` and a mix of the two, and a mix of two colours that
each clear a ratio against the same background clears it too. The only way back to a
failure is a colour of its own, so that is what it looks for — no hex and no chromatic
`rgb()` in `shelf.css` outside a `var()` fallback slot, no `prefers-color-scheme`, no
`rgba(var(--accent)`, no unscaled `parseHex`, and `theme` absent from `STASH_CONFIG_KEYS`
(a window floating over every other app may read the theme and must never write it). Each
of those five was re-broken and the test watched to go red before it was believed.

`npm run test:stash` is what the Stash is allowed to cost, and it is model-free and
window-free because the two things it pins are invisible while they are broken - the
feature keeps working perfectly and only gets slow. A full 200-entry history was 414KB, of
which 383KB was `text` that nothing on screen draws (the rows draw `preview`, the first 140
characters) and ~207KB more was the same clip stored a second time inside `key`, and all of
it was stringified, written and structured-cloned to two windows on every copy made
anywhere on the machine. So: no list leaving the main process may carry a body, `recentText`
returns that body byte-exact for the one click that types it into a pane, and a key must not
contain the clip it stands for. It also pins the two ways the history could come back empty
- the save goes through a `.tmp` and a rename, and the sweep that deletes orphaned files has
to name that `.tmp` as a keeper rather than happen to miss it - and that `flushRecents` on
`will-quit` gets a copy made in the app's last second onto disk, which a debounced async
write otherwise loses.

`npm run test:stashdrag` needs a test copy up (`npm run try -- --keep --show
--remote-debugging-port=9333`) and drags the Stash overlay with real CDP input, because
`setPointerCapture` - which the drag is built on - refuses a pointer id no physical
pointer owns. What it measures is the gap between the pointer and the thing it grabbed
MID-gesture, not after: the overlay is moved by hand from screen coordinates, and on macOS
the arithmetic was 105px out horizontally and 100px vertically because AppKit had quietly
clamped the window it was computed from. It also pins the size of the grip's hit box,
since a press that misses the handle opens the list instead of moving the window.

`npm run test:activate` is the other half of that press, and it is about the app the Stash
is NOT. `focusable: false` stops the overlay's window becoming key; on macOS it does not
stop the click activating the APP, and PaneForge answers activation by revealing its main
window - which is the only way back into a copy that launched hidden. So clicking a row to
copy, or grabbing the grip to move the overlay, pulled the whole app over the thing being
pasted into and took the focus the Cmd-V needed. The overlay is an NSPanel on darwin now
(`type: 'panel'`, i.e. `NSWindowStyleMaskNonactivatingPanel`) so the activation never
happens, and `shared/activation.ts` refuses any activation a press on the Stash explains.

Its load-bearing assertion is an ordering one, and it is the one a guard written the way it
reads gets backwards: the press and the activation are ONE gesture arriving by two routes -
AppKit's notification and the browser routing the input - and on a real click the press is
timestamped AFTER the activation. So the handler waits `ACTIVATION_SETTLE_MS` for the other
half rather than answering on arrival, and the window is checked in both directions. The
press itself is recorded from `webContents.on('input-event')` in main, never from an IPC
message the page sends, which is a round trip later than the decision. The Electron half
spawns a real Electron and pins that `input-event` still carries mouse events to a
`focusable: false` transparent window - the one assumption an upgrade could take away
silently, and it would take away silently: every click would simply raise the app again.

`npm run test:view` is the grid and the find bar in a real window, and it needs one up
(`npm run build && npm run try -- --keep --show --remote-debugging-port=9333`). The
arithmetic behind the five layouts is pinned without a window by `npm run test:grid`; what
that cannot answer is whether the panes land where it says, since the cells are CSS grid
lines and the dividers are absolutely positioned over the gaps. Nor can the DOM answer
anything about the find bar: with the WebGL renderer there is no text in it and the
highlights are decorations over a canvas, so the addon's own count - the number the bar
prints - is the only honest source. Two things it pins that cost an hour each to see: a
pane RESIZED after text was written into it loses that text, because the shell repaints
the screen it owns (so a search that "found nothing" was a test writing into a pane it
then zoomed), and a window that is not being drawn can find every match and count none -
which is why the bar says "found" rather than "no matches" when the search landed but
nothing was counted, and why the test wants `--show`.

`npm run test:improve` is the prompt-improvement feature, model-free: the one draft
reconstruction (`shared/draft.ts`, which replaced the three copies that used to disagree),
the envelope that holds secrets and long code back and restores them byte-exact, the
sanitiser, and the whole retrieval and budget pipeline against real fixture vaults on
disk. Its cheap, load-bearing half is `prompt-insert-test.mjs`: the improved text is not
displayed, it is TYPED into an agent with real tools in a real repo, so every assertion
there is about the exact byte stream reaching `write()` - no `\r` ever, no leading `/`
`!` or `#`, no escape that could close the bracketed paste early and hand the rest to the
terminal as keys.

`npm run test:improveview` is the half only a real window can answer, and it needs one up
(`npm run build && npm run try -- --keep --show --remote-debugging-port=9333`). The draft
is reconstructed from keystrokes, so it is driven by real keystrokes through xterm's own
input path and read back out of `window.__pf.draft(id)`. Two things it pinned that cost an
hour each: a pane keeps reading `status: 'working'` for ~3.5 s after the last keystroke,
because the shell echoing its own prompt line is output like any other - so a single idle
timer always fired while the pane was still busy and the chip could never appear at all;
and `Session.engaged` is not "busy" but "something has been asked of this session", which
typing is, and it never goes back down, so guarding on it suppressed the chip forever.
Accept is proved by the terminal, not by a spy on the bridge - `applyImproved` writes from
the main process on purpose, so the byte stream is built in one place - and "did not
submit" is the improved text sitting on the prompt row with the cursor never having moved
down to a fresh one.

Its last assertion is the one every other assertion here assumed and none of them made:
that a suggestion actually comes back. The sheet tests deliberately do not say which phase
they land in, calling that a race, so nothing noticed that `DEADLINE_MS` was 20 s while the
work takes 22.5 s bare and 32.6 s from inside the app - every click was killed by its own
deadline and reported as "produced no answer", which reads as a broken feature rather than
as a wrong number. It prints the milliseconds, so a CLI that gets slower shows up as a
rising figure instead. The companion rule is that only a CHANGED draft cancels a run in
flight: a keystroke used to, and over half a minute a person moves the cursor or clicks
back into the pane, which silently threw the answer away and put the offer chip back.

`npm run test:research` is the Phase 2 gate, model-free and network-free: what a research
run is allowed to believe, and what it must refuse. Three cases are the reason it exists. A
lead is not evidence - a finding cited only to a Reddit thread or a showcase page is
rejected outright rather than stored at low confidence. A source that was never opened is
not a source, because a search snippet reads exactly like a citation once it is in a JSON
field. And hostile text is REJECTED, never sanitised: repairing it would mean deciding
which half of a poisoned note was the honest half. It also pins the derived lifecycle -
`Discovered → Evaluated → Tested → Verified → Recommended` is computed by `stage()` from the
stored vault status plus the evidence on the record, so nothing reaches Tested without a
sandbox run and nothing reaches Recommended without something having shipped. There is no
field anyone can set.

The pipeline that fills the catalogue is documented in `RESEARCH-POLICY.md`, and the one
thing worth knowing before touching it is that `scripts/capability-ingest.mjs` is the ONLY
door in. The scheduled agent lives in taskdriver and is Python; the gate is TypeScript; an
agent that validated its own findings would be a second implementation of the
untrusted-content boundary, and the drift would only ever be visible as something hostile
getting stored. `capability-sandbox.mjs` is the only thing allowed to install, only with an
explicit `--install`, into a throwaway directory with no credentials in its environment and
`--ignore-scripts` - and it never RUNS what it installed, because the build links modules
rather than executing them.

`npm run test:split` is the other way several agents take one job, and the difference
from a swarm is the whole point. A swarm is several roles in ONE checkout, kept apart by
their briefs - right when they interleave, wrong for four independent features, because
"do not edit files another role owns" is a sentence in a prompt and a sentence does not
survive an agent that needs one import from over there. A split cuts the task into
workstreams and sends each through the same `laneFor` the session list uses, so each one
is in its own worktree: they cannot write the same file because they are not looking at
the same file.

The model proposes and `src/main/split.ts` decides. The load-bearing check is that no
two lanes claim the same path - a plan that overlaps is REFUSED, never repaired, because
repairing it means guessing which lane the file belonged to and the cost of guessing is
paid later, in a merge, by someone who was not there. Containment counts (`src/main` and
`src/main/split.ts` are the same claim), case counts (these file systems are
case-insensitive), and `.` is the whole repository rather than a path that collides with
nothing.

Two of its rules were written by running the real CLI rather than by reading the code,
and neither is visible without doing that. Claimed paths keep their capitals: they are
compared lowercased but STORED as given, because the string ends up in the brief the
agent is started with and `src/renderer/src/components/settingsdialog.tsx` is a file
that does not exist on a Mac. And the brief cap is 2400, not 1200, because a real
three-lane plan came back with ~1300-character briefs and the first cap truncated every
one of them mid-sentence.

`SPLIT_DEADLINE_MS` is 240 s and the number was measured, for the same reason the
improver's was: a real plan for this repository takes **61.5 s** from a bare `claude -p`
and 35 s from inside the app, and the first version shipped with improvement's 90 s,
where every click died on its own deadline and reported "produced no answer" - which
reads as a broken feature rather than as a wrong constant. The dialog counts the seconds
out loud so a slow plan looks slow rather than stuck.

`npm run test:pipe` is the live tee of a pane's output, and the half of it worth pinning
is not the file being written - it is the chunk boundary. The pty hands over whatever
pieces it feels like, and an escape sequence does not respect them: `\x1b[3` in one chunk
and `1mb` in the next is one colour change, and stripping the halves separately leaves
`1mb` sitting in the file as text. `AnsiStream` in `shared/ansi.ts` holds an unfinished
sequence - and a trailing `\r`, which is either a line ending or a cursor return
depending on a byte that has not arrived - until the rest of it comes. The test asserts
the streamed result is byte-identical to stripping the whole input at once, that raw
mode changes nothing at all, that stopping flushes what was being held, and that a tee
pointed at a file that cannot be opened costs the pane nothing: the stream's `error` is
handled, or an unhandled one takes the whole main process down with it. That stripper is
the transcript's too - one implementation, since a transcript and its tee disagreeing
about the same run is a bug nobody would ever look for.

`npm run test:copymode` is keyboard copy mode's arithmetic, away from xterm because it
is the half that is wrong in ways a screenshot cannot show. Three of its rules were
written by things that were already broken: `V` had to become a SHAPE rather than a pair
of columns (as columns, `V` then `j` selected one whole line plus a single stray
character of the next, and that is what a yank put on the clipboard); a horizontal key
that moves nothing must not move the wanted column either, or `l` at the end of a short
line silently shifts where the next `j` lands; and `G` means the last line with anything
ON it, not the last line the buffer has - measured in a real window, a pane two lines
into its life reported a buffer 70 rows long, so "the end" was 68 rows below the last
thing printed, where `$` selects nothing and a yank comes back empty. The window half is
in `test:view`, and it exists because of a measurement too: the shortcut acts on the
ACTIVE pane, so a probe that starts a pane without focusing it drives one pane while
measuring another and reports a feature that does nothing.

`npm run test:silence` is the alert that says a running turn has gone quiet, and it
exists because a rule about MINUTES cannot be checked by hand - nobody re-tests a five
minute timer, so every mistake it can make ships, and every mistake it can make is the
app crying wolf. The decision is a pure function in `shared/alerts.ts` for that reason:
the sweep it runs inside owns a pty, and a test that has to spawn `claude` to find out
whether a number is compared correctly is a test nobody runs. Its load-bearing assertion
is a refusal: a pane with no turn running is NOT stalled however long it has been quiet.
That is tmux's `monitor-silence` rule deliberately not copied - an idle pane is silent
all day, and eight of them would raise eight alerts about nothing every N minutes, which
is how an alert gets switched off for good.

`npm run test:discord` is the Discord Rich Presence ("3/6 sessions running" on the
profile), without Discord: the whole client run against a fake Discord served over a
real named pipe. The two things it pins are invisible in a unit test and both have
bitten this repo before: a frame split across data events must not be decoded early
(the device link's launch bug, relearned here), and a socket error nobody handles
takes the main process down (the tee's lesson). It also pins the budget rules - a
burst of session events collapses to one trailing SET_ACTIVITY, an unchanged desk
sends nothing, an empty desk sends a clear rather than "0/0" - and that a Discord
that is not running costs nothing, silently, forever. The header line of the presence is
the Discord APPLICATION's name, and that application is `DISCORD_APP_ID` in
`shared/discordRpc.ts` - **a constant, not a setting**. It was a text field for a few
releases and that was wrong in three directions at once: a user who cleared it or
mistyped a digit got a presence Discord had no application to resolve, with the app
reporting nothing amiss; anyone still on the earlier BORROWED id - "Manic's Auction
House", the author's Discord bot, used because creating an application needs a portal
login and a captcha a script cannot pass - kept a stranger's brand on their profile,
which is invisible from inside the app because 19 digits do not say whose name Discord
is about to print; and a field for it read as "you have to make your own application",
which was never true. So the saved key is not migrated, it is DELETED on load
(`dropSavedDiscordId`) and left out of the next write. What a user may still do is turn
the presence off, or reword it.

Owning the application is not the same as being ON it. An application's icon names the
HEADER and is never the artwork: a presence that sends no `assets` is drawn as text with
no image at all. So the mark stayed missing from every profile long after the name was
right and the icon was uploaded, with nothing anywhere reporting it - the frame is valid,
Discord accepts it, and the only tell is a card that looks a bit empty. `buildActivity`
names the art asset (`PRESENCE_IMAGE`, the name it was uploaded under in the portal, not
a URL and not the icon hash). Discord drops an image key it cannot resolve in silence,
which is why the brand test checks the asset exists rather than trusting the send.

The third thing that can be wrong is the one the app used to be silent about: **whether
Discord accepted any of it**. Discord acknowledges every `SET_ACTIVITY` by echoing back
the activity it STORED - the application name it resolved, the asset id the image name
became, the lines it kept - or by answering `evt: 'ERROR'` with a reason. Every one of
those frames was read only for `READY` and otherwise dropped, so a refused presence and
an accepted one looked identical from inside the app, and the settings tab could only
describe what was INTENDED. It now reports that ack (`PresenceStatus`, pushed on
`discord:status`), which is the only honest answer to "is this actually on my profile":
connected as whom, headed by what, accepted at when, or refused in Discord's own words.

What the ack still cannot say is whether anyone ELSE can see the card, because Discord
does not tell an application that and the switches that hide it are Discord's own:
Activity Privacy ("Display current activity as a status message", "Share your detected
activities with others") and Activity Status per server. A presence can be correct all
the way to the ack and invisible to every friend, which is why the tab says so in
words next to the status rather than leaving the app looking broken. Presence is
desktop-only either way - the phone and browser clients never draw one.

That warning only reaches somebody who opens the tab, so `npm run test:discordbrand`
says it to the repository instead: it reads the `DISCORD_APP_ID` literal out of
`src/shared/discordRpc.ts` - the value that actually ships, never a copy - asks Discord what
that application is called, and FAILS while the answer is not PaneForge. Then it asks the
same id for its art assets and FAILS while none is named `PRESENCE_IMAGE`. Both halves
are checked because they broke in that order and a correct name with no asset is a card
with no logo on it; both are fixed now, so the test passes. Neither could be fixed by a
script - New Application and Add Image are both a portal login and a captcha - but no
bot, no scopes, no OAuth and nothing to "connect": rich presence talks to the local
Discord client over a named pipe and the id is all it needs. Offline it SKIPS and prints
the skip, because a check that quietly passes when it could not run is worse than no
check when the thing it catches is a wrong answer that looks like no answer. Out of the
default suite for needing the network.

Everything BELOW that header is ours, and Settings → Discord owns it: two templates
(`{running}`, `{total}`, `{idle}`, `{sessions}`, `{projects}`, `{project}`) plus
switches for the project line, the elapsed clock, and whether an idle desk says
anything at all. It lives in `discordStyle`, and every template defaults to the EMPTY
STRING rather than to its wording - the built-in text lives in `discordRpc.ts` as
`DEFAULT_DETAILS`/`DEFAULT_STATE`/`DEFAULT_IDLE_DETAILS`, shown as the field's
placeholder. That is what lets a config nobody has touched keep sending the exact
bytes it sent before the tab existed (the test asserts it byte for byte) and lets a
later reword reach people who never opened the tab. `buildActivity` takes the style
as a second argument with a default, so the pure function stays callable from the
preview in Settings - the panel is the real activity, not a mock of one. Two rules
it enforces that a template can otherwise break: a line still gives up trailing
project names for a "+2 more" before Discord's 128-char cut, and templates that
render to nothing send a CLEAR rather than a blank badge on the profile. Restyling
does not drop the pipe (that would be a reconnect per keystroke) but does clear the
last-sent memo, or an edit landing on the same numbers would be read as "no change"
and never leave the machine.

`npm run test:notes` is about the release page saying what changed.
`scripts/release-notes.mjs` reads the Conventional Commit subjects between the previous
version tag and this one and sorts them into New / Fixed / Faster / Other changes.

Three things publish that body and all three call the same function, so they cannot
print different pages: the workflow's `notes` job, `publishFallback` in `lane.mjs` for
the releases Actions never built, and `reconcileNotes` on the retry timer. The template
is `.github/release-notes.md` and the changes go where `{{CHANGES}}` is.

`reconcileNotes` is the backstop, and worth keeping even though CI now writes the
changes itself: on the retry timer that already runs every minute, it looks at the
newest release for an hour after it is cut and fills in any body with no
`## What changed` in it. Check-then-write rather than one-shot, so a body overwritten by
anything - an older checkout cutting a release, a re-run of an older workflow - is
noticed on the next tick and put back. It costs nothing when no release is that new.

The workflow's `notes` job checks out with `fetch-depth: 0`. Without it there are no
tags and no history to diff against, and the job would quietly publish the "nothing to
list" fallback on every release while going green.

That job could not be edited from this machine until 2026-07-31: pushing any commit
touching `.github/workflows/` was rejected because the `gh` token had `repo` but not
`workflow` scope. `gh auth refresh -h github.com -s workflow` is the fix, and the
`-h` is not optional when it is not a person typing it.

The test builds a real repo with real tags and pins the ways the range goes wrong
silently: v0.3.9 must not sort above v0.3.10, a version with no tag yet means "since the
newest tag", the `release:` bump and lane merges are not changes, a subject with no
prefix is still reported, and a release with nothing new keeps the commit link instead
of printing an empty heading. It pins both template shapes - the `{{CHANGES}}` one in
the repo now, and the older "New in this build" line - because a release cut from a
checkout older than the switch-over reads its own template, not this one.

`scripts/lane-fixture.mjs` is why the four lane tests no longer carry a hand-written
`['lane.mjs', 'test-app.mjs']` copy list: giving lane.mjs one more import broke all four
at once, with an ERR_MODULE_NOT_FOUND naming a temp directory rather than the cause. The
list is derived from lane.mjs's own relative imports now.
`npm run test:remote` runs the device link end to end over a real loopback socket -
pairing, refusal, mirroring, keystrokes back, and that nothing on the wire is readable.
`npm run test:lanes` ends with `lane-sweep-test.mjs`, the one test about DELETING
things: it builds real repositories with real worktrees and checks every case the sweep
must refuse (uncommitted, untracked, unmerged, squashed from several commits, a pane
open in it or in a subfolder of it, a branch that is not `pf/wN`). Add a case there
before relaxing a rule - it is how the "somebody else's worktree at `myapp-w2`" hole
was found. `lane-owner-test.mjs` in the same suite is about who HOLDS a lane: a hold
records the chat, not the folder, because every chat records the main checkout it started
in - so matching by folder let one new pane silently "own" two dead chats' lanes and wipe
them off the strip while they were still held. It also pins the reclaim: a hold no
running copy of the app is hosting, quiet for fifteen minutes, is given back by
`lane.mjs release`. Liveness is judged across copies, never per window: every copy
publishes the chats it hosts to `.git/paneforge-panes.json`, and a chat counts as gone
only when it is in nobody's list. Without that, the test copy `npm run try` opens - which
hosts no chats at all - would decide every chat in the real window had died and hand out
checkouts people are typing in.

## Gotchas that look like mistakes

`package.json` `description` is the bare word "PaneForge" on purpose. electron-builder
writes it into the exe's FileDescription, which is the name Windows Task Manager shows,
and a tagline there read as a second app called "run every coding agent you own in one
window". The tagline lives in the README instead.

The icon is generated, not stored. `node scripts/make-icon.mjs` draws it from about a
hundred lines of arithmetic and writes `icon.png` + `icon.svg` at the root and
`build/icon.png`, which is electron-builder's default buildResources directory - so the
Windows `.ico` and the Mac `.icns` come from that one file with no configuration at all.
Do not replace it with a checked-in blob: there is no ImageMagick on this machine (the
`convert` on PATH is Windows' filesystem tool) and no sharp, so a blob is a file nobody
can resize when Discord wants a 512 or a store wants a 1024. `--size N --out path` renders
any single size. The gap between panes is 0.043 of the canvas because that is what still
reads as three panes after a downsample to 24px - 2px of background survives on both
splits, which is the whole reason the mark is legible in a taskbar.

`git status` for the pane badges must stay async (`execFile`, not `spawnSync`). Sync
spawns block the main process, which owns the window message loop, and Windows answers a
stalled message loop by swapping the pointer for the busy cursor.

## Checking a layout change without screenshots

Screenshots cannot answer "is the last row reachable", and a session that takes ten of
them costs more than the fix. Ask the real window instead:

```
npm run build                    # --keep below SKIPS the build; without this you measure the last one
npm run try -- --keep --remote-debugging-port=9333
npm run probe -- --height 560 "(() => { const d=document.querySelector('.dialog'); const r=d.getBoundingClientRect(); return { fits: r.bottom <= innerHeight } })()"
npm run try -- --close
```

A probe answering exactly what it answered before your edit is the tell: nothing was
rebuilt. The port is per checkout - another lane's test copy holds 9333 and says so -
so a second lane probes with `PF_PORT=9334` and launches with the matching flag.

`--height`/`--width` drive Chromium's device metrics override, so a short-window check
needs no window manager and puts the size back afterwards. The expression is evaluated
in the renderer with `awaitPromise`, so an async arrow that clicks through a dialog and
then measures works as one argument. `window.__pf[sessionId]` gives a pane's live
`term` and `fit`, which is how pane behaviour is checked without a screenshot.
