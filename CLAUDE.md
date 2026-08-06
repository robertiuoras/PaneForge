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

- An automatic release **reads its own bump off the commit subjects** since the last tag
  (`bumpFor` in `scripts/release-notes.mjs`, the same source the notes come from): a `feat:`
  in the range makes it a minor, anything else a patch. A `!` asks for a major and gets a
  minor while the version starts with 0 — cutting 1.0.0 is a claim about the product, so
  only `node scripts/lane.mjs ship major`, typed on purpose, does it. A bump named on the
  command line is always obeyed as given.
- Releases batch: one per 30 minutes (`COOLDOWN_MS`). Inside that window the work sits on
  master for the next `ready`. Do not "fix" that with `npm run ship`.
- `npm version`, `git tag vX` and pushing a version tag by hand are **blocked**.
  `npm run ship` exists for a build Robert needs in his hands now — say why.
- Two things stop a release, both reported by name: master not typechecking, and a lane
  conflicting with master. A conflicting lane is left out; the rest still goes out.
  `rerere` is on, and the retry timer re-tries recorded conflicts every minute.
- Release notes come from Conventional Commit subjects between version tags
  (`scripts/release-notes.mjs`, template `.github/release-notes.md`). `npm run test:notes`.
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

## Checks

`npm run typecheck` before committing.

| Command | Covers |
|---|---|
| `npm run smoke` | the pty layer |
| `npm run test:restore` | which conversation a reopened pane goes back into |
| `npm run test:consoles` | sweeping console hosts left behind |
| `npm run test:strays` | what a PANE left running (real orphans, ~25s) |
| `npm run test:gitpoll` | the badge's `git status` cache, over a fake clock |
| `npm run test:install` | quitting takes the install pty's whole process tree |
| `npm run test:lanes` | lane engine, worktree sweep, ownership, any-repo release contract |
| `npm run test:laneargs` | what `runSafe` hands a program, through a real cmd.exe |
| `npm run test:notes` | release-note ranges and both template shapes |
| `npm run test:remote` | the device link end to end over a real loopback socket |
| `npm run test:theme` | palette derivation + contrast (358 assertions) |
| `npm run test:sounds` | the alert catalogue: nothing silent, nothing clipping, uploads |
| `npm run test:blurbs` | the "what this is" note on each feature, and that each is rendered |
| `npm run test:place` | the words a pane's strip prints (56 assertions) |
| `npm run test:diff` | reading a repo's changes: `-z` records, renames, patch numbering |
| `npm run test:grid` | layout arithmetic, no window needed |
| `npm run test:split` | task splitting; overlapping file claims are REFUSED, never repaired |
| `npm run test:stash` | what the Stash may cost — no list leaving main carries a body |
| `npm run test:pipe` | the live tee; ANSI stripping across chunk boundaries |
| `npm run test:copymode` | keyboard copy mode arithmetic |
| `npm run test:silence` | the quiet-turn alert; an idle pane is NOT stalled |
| `npm run test:discord` | Rich Presence against a fake Discord over a real named pipe |
| `npm run test:improve` | prompt improvement, model-free (incl. the exact typed byte stream) |
| `npm run test:recall` | "you have asked this before" — and PARITY with the canonical fingerprint |
| `npm run test:rename` | the folder rename, on a throwaway repo |
| `npm run test:dock` | the macOS Dock icon (no `visibleOnFullScreen` without the skip) |
| `npm run test:macupdate` | the app replacing its own bundle |
| `npm run test:macdownload` | every way a mac download can end — none of them a hang |
| `npm run test:history` | what transcripts may cost: the age cutoff and the size cap |
| `npm run test:macsign` | the signing that stops TCC resetting permissions every release |

Needing a real window up (`npm run build && npm run try -- --keep --show
--remote-debugging-port=9333`): `test:view` (grid + find bar), `test:stashdrag`,
`test:activate`, `test:improveview`.

Out of the default suite on purpose because they need the network: `test:discordbrand`,
which asks Discord what the shipped `DISCORD_APP_ID` is called AND whether it still has
the art asset `PRESENCE_IMAGE` names — it passes now, and the two halves fail separately,
because a correct name with no asset is a card with no logo on it; and
`node scripts/mac-update-test.mjs --live <version>` (~120 MB).

The research pipeline's gate is `npm run test:research`, and
`scripts/capability-ingest.mjs` is the ONLY door into the catalogue — see
`RESEARCH-POLICY.md`.

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
