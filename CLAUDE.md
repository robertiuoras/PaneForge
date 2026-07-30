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
`npm run test:stashdrag` needs a test copy up (`npm run try -- --keep --show
--remote-debugging-port=9333`) and drags the Stash overlay with real CDP input, because
`setPointerCapture` - which the drag is built on - refuses a pointer id no physical
pointer owns. What it measures is the gap between the pointer and the thing it grabbed
MID-gesture, not after: the overlay is moved by hand from screen coordinates, and on macOS
the arithmetic was 105px out horizontally and 100px vertically because AppKit had quietly
clamped the window it was computed from. It also pins the size of the grip's hit box,
since a press that misses the handle opens the list instead of moving the window.
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
