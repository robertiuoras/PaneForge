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

Every automatic release is a **patch** bump - `ready`, the session-end mark and the retry
timer all call `autoship('patch')`. A minor or major has to be asked for by name
(`node scripts/lane.mjs ship minor`), and it is the one thing `ready` cannot express: work
finished while a chat was still testing has gone out as a patch minutes before the chat
got round to asking for the minor. That is not a problem - `ship minor` from there cuts
the version you wanted - but the release page will say only what changed since the patch,
so the feature list needs putting back on it by hand (`gh release edit`), AFTER the
workflow's `notes` job has run, since that job rewrites the body from its own range.

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

## The folder rename to PaneForge (done 2026-07-27, PC)

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
- Copies are numbered `#2` because Ctrl+2 switches to them - the label IS the keystroke.
  Claude Code names worktrees `bright-running-fox` and Conductor uses city names; neither
  can be typed. Same reason a lane holder is "pane 3" wherever that pane is in this window,
  and eight characters of a session id only when it is not.
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

## Checks

`npm run typecheck` before committing. `npm run smoke` exercises the pty layer.
`npm run test:restore` covers what a reopened desk is made of: which conversation each
pane goes back into (never another pane's, never one older than the pane) and what the
dialog says it was doing. `npm run test:consoles` pins the sweep that kills console hosts
left behind - including the guard that stops it touching a console whose parent is alive.
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
that is not running costs nothing, silently, forever. The header line of the
presence is the Discord APPLICATION's name, which lives in `discordClientId` in the
config: creating an application from a script is impossible (captcha), so the
default id is a BORROWED application - "Manic's Auction House", the author's Discord
bot - and pointing the setting at a new one renames the header with no other change.
That borrowed name is invisible from inside the app, which is how it survived: 19
digits do not say whose brand Discord is about to print. Settings now reads the name
back from `/applications/<id>/rpc` (public, no token, `discord:appName` in main
because the packaged renderer is a `file://` origin and Discord answers CORS for a
real one only) and warns whenever the header is not PaneForge.

That warning only reaches somebody who opens the tab, so `npm run test:discordbrand`
says it to the repository instead: it reads the `discordClientId` literal out of
`src/main/config.ts` - the value that actually ships, never a copy - asks Discord what
that application is called, and FAILS while the answer is not PaneForge. It is failing
right now, on purpose, and the only thing that will fix it is a person: New Application
in the portal is a login and a captcha. No bot, no scopes, no OAuth and nothing to
"connect" - rich presence talks to the local Discord client over a named pipe and the id
is all it needs. Offline it SKIPS and prints the skip, because a check that quietly
passes when it could not run is worse than no check when the thing it catches is a wrong
answer that looks like no answer. Out of the default suite for needing the network.

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
