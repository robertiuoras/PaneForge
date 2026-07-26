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
when the release merges your lane back the other way. Claiming a lane also heals it (an
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

## Never take the screen

The app hosts the chat and runs all day beside real work, so nothing it does on its own
may take focus, raise a window, or pop a dialog. Only a click or a hotkey earns the
foreground.

- Show a window the user did not ask for with `showInactive()`, never `show()`.
  `focusWindow()` is for user-initiated paths only.
- A restart the app decided on (update, admin relaunch) calls `markQuietRelaunch()` in
  `src/main/profile.ts` before exiting. The new process consumes that marker, starts
  `inactive` and flashes the taskbar button once instead of stealing the keyboard.
- No `dialog.showMessageBox` for anything the app decided by itself - in-renderer cards
  (`UpdateToast.tsx`) instead. No `setAlwaysOnTop`, no `moveTop`, no `app.focus`.
- Every `spawn`/`Start-Process` keeps `windowsHide: true`; a console flashing is a focus
  steal too.
- `second-instance` must not raise the window while `installStarted` is set: mid-update
  the installer's launch of the new exe arrives on that event.

## Checks

`npm run typecheck` before committing. `npm run smoke` exercises the pty layer.

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
npm run try -- --keep --remote-debugging-port=9333
npm run probe -- --height 560 "(() => { const d=document.querySelector('.dialog'); const r=d.getBoundingClientRect(); return { fits: r.bottom <= innerHeight } })()"
npm run try -- --close
```

`--height`/`--width` drive Chromium's device metrics override, so a short-window check
needs no window manager and puts the size back afterwards. The expression is evaluated
in the renderer with `awaitPromise`, so an async arrow that clicks through a dialog and
then measures works as one argument. `window.__pf[sessionId]` gives a pane's live
`term` and `fit`, which is how pane behaviour is checked without a screenshot.
