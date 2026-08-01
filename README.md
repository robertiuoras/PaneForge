# PaneForge

One window for every coding agent you own. Claude Code, Codex, Gemini CLI, Qwen,
Ollama, Copilot, Cursor Agent, opencode, Crush, Goose, Amp, Aider, a plain shell,
or any other CLI you point it at. Each project gets a real terminal pane, and you
choose which AI and which model runs in it.

Windows and Apple Silicon macOS. Free, no accounts, no server.

## Download

No clone, no build, no account. Every build lives on the
**[Releases page](https://github.com/robertiuoras/PaneForge/releases/latest)** - that
page always shows the newest one.

### Windows 10/11 - `PaneForge-Setup.exe`

Take it from the Releases page and run it. Installs for the current user in a few
seconds, no admin prompt, and puts PaneForge on the Desktop and in the Start Menu.

### macOS (Apple Silicon) - `PaneForge-arm64.dmg`

Same page. Drag the app to Applications, then **right-click it > Open > Open** the
first time.

Prefer one command? These do the same thing, plus the Gatekeeper/Smart App Control
handling below, and can be re-run to update:

```bash
# macOS
curl -fsSL https://raw.githubusercontent.com/robertiuoras/PaneForge/master/scripts/install.sh | bash
```
```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/robertiuoras/PaneForge/master/scripts/install.ps1 | iex
```

The portable no-installer builds are on that same Releases page.

<details>
<summary><b>Windows or macOS says the app is untrusted - what to click</b></summary>

The build is **not code signed**: a Windows certificate costs a few hundred dollars a
year and notarising on macOS needs a paid Apple developer account. That warning is
about the missing signature, not about the app, and it happens once.

**Windows**

- *"Windows protected your PC"* (SmartScreen) - click **More info**, then **Run anyway**.
- *"Smart App Control blocked an app that may be unsafe"*, *"Your administrator has
  blocked this app"*, or the installer closes with no message - that is **Smart App
  Control**, and it cannot be talked round per-app: it blocks the unsigned `PaneForge.exe`
  itself, so the zip build does not dodge it either. The only way to run is to turn it
  off: Windows Security > App & browser control > **Smart App Control settings** > Off.
  Since the Windows 11 April 2026 update it can be switched back on later; on older
  builds turning it off is one-way (it stays off until Windows is reinstalled), so
  decide once. If you would rather not, wait for a signed build.
- Edge or Chrome may also call the download *"not commonly downloaded"* - keep it from
  the download list.

**macOS**

- First launch must be **right-click the app > Open > Open**. Once only.
- If macOS still refuses: `xattr -dr com.apple.quarantine /Applications/PaneForge.app`
  (the `install.sh` one-liner already does this).
- Intel Macs have no published build - use *Build it yourself* below.

</details>

None of this recurs: updates after the first install are silent (see below).

### First run, in order

1. **Nothing is installed? That is fine.** Open **Settings > Agents** (or press
   **Ctrl ,**). Every CLI PaneForge knows is listed with whether it is on your machine,
   and the missing ones have an **Install** button that runs the real installer and
   streams its output into the app. Claude Code and Codex need their own subscriptions;
   Gemini CLI, Qwen, opencode, Crush, Goose, Aider and Ollama are grouped as **Free** and
   need no account. If you already have a CLI somewhere unusual, **Locate** points the app
   at the binary instead.
2. **Point it at your code.** Press **Ctrl T**. First time, it asks for the folder your
   projects live in (`~/Projects`, `D:\work`, whatever) and lists what is in it, most
   recently worked in first.
3. **Start a pane.** Tick a project, pick the agent and model, press Enter. That is a
   real terminal running that CLI in that folder - same colours, same keys, same Ctrl-C.
4. **Press F1** for every shortcut.

The app checks for new versions in the background and offers the update itself, so this
is the only time you download anything by hand.

## Build it yourself

Only needed if you want to change the code, or you are on an Intel Mac (no published
build). Otherwise use the downloads above.

```
npm install
npm run setup
```

Builds the app and puts a **PaneForge** shortcut on the Desktop, in the Start Menu
and on the taskbar (macOS: builds the .app for you to drag into Applications).
Re-run after any source change. Needs Node 20+.

## What it does

- **Ctrl T** - project picker, ranked by when you last worked in each folder. Tick
  several and press Enter to start them all at once.
- **Workspaces** - a saved set of projects launched with one click.
- **Agent + model per pane** - pick the CLI and pin the exact model (Opus 5, Opus
  4.8, Sonnet 5, Gemini 2.5 Pro, a local Ollama model...). **Ctrl Shift A** flips
  the focused pane to the next installed agent, same folder, same pane, for "Claude
  is stuck, let Codex look at it".
- **Free agents** - Gemini CLI, Qwen Code, opencode, Crush, Goose, Aider and Ollama
  are grouped as *Free* in the picker: usable with no subscription, and Ollama runs
  entirely offline.
- **One-click install** - Settings > Agents shows what is missing and installs it
  for you, streaming the installer's output. Nothing needs a terminal. *Locate*
  points PaneForge at a binary you already have somewhere odd.
- **Swarm (Ctrl Shift S)** - one mission, one pane per role (Planner, Builder,
  Reviewer, Tester), each told what it owns so they stop editing the same file.
  Roles are editable and remembered.
- **Worktree lanes** - open a second session in a project you already have open and
  it lands in its own git worktree (`<project>-w2`, branch `pf/w2`), carrying the
  things a fresh checkout cannot have: your `.env` files, your local editor and
  agent settings, the submodules a bare `worktree add` leaves empty, and whatever
  the project installed - `node_modules`, a `.venv`, a composer or bundler
  `vendor`, at the root and one level down for monorepos. Dependencies arrive as
  hardlinks a few seconds after the pane opens, so they cost no disk and deleting a
  lane never touches the original folder's copy. A cloned virtualenv is repointed
  at the lane (`pyvenv.cfg`, activate scripts, console shebangs), so it runs the
  lane's packages and not the folder it came from. Two agents can build different
  features in one
  repo at the same time without overwriting each other or racing the git index. The
  pane says which lane it is in. Off by one switch in Settings, and a folder that is
  not a repo is left shared with a warning. A lane also gets the two things a bare
  worktree does not:
  - **its own dev server port** - `PORT` (and `PF_LANE_PORT`) is set past whatever
    the project itself asks for, and then checked to be free before the pane opens,
    so `npm run dev` in two lanes - or in two different projects - does not collide.
    The port is read from wherever the project already states it: a dev script, a
    Vite/Next/Nuxt/Tauri config, a compose file's host mapping, `launchSettings.json`,
    a `PORT=` in `.env`, or the convention of the stack it is (Django and FastAPI
    8000, Flask 5000, Rails 3000, Expo 8081, Storybook 6006, Go and Rust 8080).
    Servers that read `PORT` need nothing; one that pins its port in config wants
    `--port $PORT`, and the launch toast states the number.
  - **the original folder's agent memory** - Claude Code and Codex both key a
    project by its folder path, so a lane would otherwise start with no transcripts,
    no `/resume`, no memory and no granted permissions for a repo you are already
    deep in, and open on a "do you trust this folder?" prompt. The lane's Claude
    project folder is linked to the original's, the original's trust, allowed tools
    and recent prompts are copied onto the lane path, and the folder's Codex trust
    level is carried across too. Nothing is granted that the original folder was not
    already granted: a repo you never trusted stays untrusted in its lane.
  - **an end** - click the lane chip on the pane to see what is in the lane (commits
    it has that the branch it came from does not, uncommitted files, and the files it
    would conflict on) and to merge it back in one click. The merge refuses rather
    than improvising: uncommitted work in either checkout, or a real conflict, is
    reported with the files named and nothing is touched. A lane holding nothing is
    deleted on its own - branch and folder - so merged and never-used lanes do not
    pile up, and a pane whose conversation is cleared in an empty lane goes back to
    the project folder it came from. Nothing with work in it is ever removed.
- **Board (Ctrl Shift K)** - tasks and shared memory for a project, stored in that
  project's `.paneforge/` folder so the agents running there can read it. Every
  agent started in a folder with memory is told to read it first.
- **History (Ctrl H)** - every pane's transcript, saved and searchable, long after
  the pane is closed. Reopen any past session in its old folder.
- **Stash (Ctrl Shift V, or Ctrl Alt V from any app)** - anything you copy, anywhere on
  the machine, appears bottom-left and stays. Click text to paste it into the focused
  pane. Click a screenshot and PaneForge saves it as a PNG and types *its path* at the
  prompt, which is the only form of an image a CLI agent can read - no more "save it,
  find the folder, type the path".
  Drop a file on it - a clip, a recording, an export - and it keeps a copy you can drag
  straight back out into a chat, a browser upload box, an editor, for as long as you say
  (a day by default, then it deletes itself). Videos show their own first frame.
  Settings > Stash has all of it: how long it shows itself for, how much it keeps, how
  long dropped files live, and the biggest file it will take.
- **Voice (Ctrl Shift Space)** - hold to talk, and the text lands in the focused
  pane. Transcribed by a Whisper model on your own machine: free, offline, nothing
  uploaded. Settings > Voice installs the engine in one click.
- **Find in a pane (Ctrl F)** - search that pane's scrollback, 20,000 lines of it, with
  every match highlighted and Enter / Shift Enter to step. It searches the pane you are
  in, so with four agents running the answer is never somebody else's output. Escape
  closes it and gives the keyboard straight back to the agent.
- **Arrange the grid (Ctrl Shift G)** - tiled, columns, rows, one big pane on the left,
  one big pane on top. Each layout remembers the sizes you dragged for it, and any pane
  can be zoomed to the whole window and back (**Ctrl Shift Z**) without disturbing the
  arrangement underneath.
- **Grid view**, **status dots**, **broadcast box** (one line to every session),
  **restart in place**, rename, open in editor/Explorer.

Press **F1** for every shortcut.

## Run as administrator with no UAC prompt (Windows)

Settings > System > *Always start as administrator*. It registers a Windows
scheduled task once - that is the single UAC approval, ever - and repoints your
shortcuts at it. Every launch after that is elevated and silent, so agents can stop
admin-owned processes (a service holding port 8000, for example).

Worth knowing before you turn it on:

- everything PaneForge launches is elevated too, including every agent pane
- Windows blocks drag and drop from Explorer into an elevated window
- the task is pinned to the app's exact exe path, and `npm run setup` re-points it
  after a rebuild

## Shipping updates (for whoever owns the repo)

```
npm run ship          # 0.2.0 -> 0.2.1, commit, tag, push
npm run ship minor    # 0.2.0 -> 0.3.0
```

GitHub Actions then builds Windows and macOS and publishes both to a Release, which
is the same feed running copies poll. Everyone is offered the update within half an
hour. Sharing with someone else is just sending them the Releases link.

The same workflow uploads a second copy of each installer under a version-less name
(`PaneForge-Setup.exe`, `PaneForge-arm64.dmg`, `PaneForge-win.zip`,
`PaneForge-arm64.zip`) and rewrites the release body from
`.github/release-notes.md`. That fixed name is what `scripts/install.sh` and
`install.ps1` fetch, so they never need touching after a release. The versioned files
and `latest*.yml` are untouched, because the auto-updater reads those.

Binary links do not go anywhere in this repo - not the README, and not the release
notes either: GitHub Support flagged the account for exactly that on 2026-07-28
(executables belong in a Release's own Assets list, not linked from a page). The
release body names the files and lets GitHub's own Assets list do the linking, and
the 50 bodies published before that ruling were rewritten to match. The only address
handed out anywhere is the Releases page.

On Windows the download is quiet and so is the install: accepting the update runs the
installer silently, with no setup window, and PaneForge comes back on its own with
the panes it had open, each one resuming its agent's last conversation. macOS does the
same thing without an installer: the release zip is expanded next to the app's data and a
small script moves the new bundle into `/Applications` the moment the old process exits,
then reopens it in the background. Squirrel.Mac is what refuses an unsigned update, and a
folder move needs no Squirrel. A Mac only gets handed the download page when it cannot do
that at all - an Intel Mac, or a copy still running from inside the mounted .dmg.

## Dev

```
npm run dev        # electron-vite dev with HMR
npm run try        # build, then open a SECOND PaneForge beside the live one
npm run try -- --keep   # skip the build, just open it again
npm run typecheck
npm run smoke      # headless proof the pty layer can drive `claude`
npm run smoke -- --cmd codex --args "resume --last"
npm run package    # unpacked Windows build, no shortcuts
```

### Two copies at once

PaneForge is developed from an agent running inside PaneForge, so closing the app to
test a change would kill the session doing the work. Named profiles make that
unnecessary:

```
PANEFORGE_PROFILE=dev   # or --profile=dev
```

A profile moves `userData` aside (`PaneForge-dev`), which gives that copy its own
single-instance lock, its own config, workspaces and history, and its own taskbar
button. Its config is seeded once from the live app so it does not open blank, and
the two drift apart after that - an experiment in the test copy can never corrupt the
real one. The window is titled `PaneForge - dev` and the version badge carries a
`DEV` tag, because the two windows are otherwise identical.

`npm run dev` and `npm run try` set the profile themselves; an unpackaged run is a
build under test by definition and can never collide with the installed app.

A profile window opens **minimized and without focus** - it is usually launched by an
agent running in the live app, and a test window that steals the keyboard mid-sentence, or
paints itself over what you are reading, is worse than no test window. It waits on the
taskbar until you click it; `npm run try -- --show` puts it on screen instead, still
without taking focus.

`npm run try` deliberately launches `node_modules/electron`, not a packaged exe:
Windows Smart App Control blocks freshly built unsigned binaries, that Electron is
already trusted, and skipping electron-builder makes it start in seconds.

Agents live in one place: `src/shared/agents.ts`. A new CLI is one entry - binary,
launch args, resume args, model flag, install command, colour - and it appears in
every picker. The same shape is what *Add agent* in Settings writes, so nothing
needs a rebuild.

`PaneForge.exe --open <path>` (or `PANEFORGE_OPEN=<path>`) starts a session in that
folder on launch; a second launch focuses the window already open.

State lives in `%APPDATA%\claude-orchestrator\config.json` (macOS: `~/Library/
Application Support/claude-orchestrator`): workspaces, settings, window geometry.
Transcripts sit next to it in `history/`. The folder is named after the npm package,
which is still `claude-orchestrator` on purpose: it is what Electron derives both the
settings folder and the install directory from, so renaming it would strand every
existing install's saved workspaces and quietly install the next update beside the old
app instead of over it. The product, the repo and everything a user ever sees are
PaneForge. A named profile appends its name: `claude-orchestrator-dev`.

The first launch on a machine picks a projects root by looking for the usual homes in
turn (`~/Desktop/Projects`, `~/Projects`, `~/source/repos`, `~/Developer`, `~/code`,
and so on) and taking the first that exists and has folders in it. If none do, the
picker says which folder it looked in and offers to change it, rather than showing an
empty list.

Not built yet: diff/merge review, reattaching to sessions after an app restart
(see `PLAN.md`).

## Platform notes

- ConPTY does not search `PATH`. The agent binary is resolved to an absolute path
  first (`src/main/which.ts`); spawning the bare name fails with `File not found`.
- That lookup tries `PATHEXT` extensions *before* the bare filename: npm installs
  both `codex` (a bash script ConPTY cannot execute) and `codex.cmd` in the same
  folder, and picking the extensionless one kills the session on launch.
- `@homebridge/node-pty-prebuilt-multiarch` cannot install on Node 20+ on Windows
  (its install script hits `spawn EINVAL`). `@lydell/node-pty` ships per-platform
  prebuilt binaries and no install script.
- Claude Code's own env markers (`CLAUDECODE`, `CLAUDE_CODE_*`) and Codex's
  `CODEX_SANDBOX*` are stripped before spawning, or a nested agent runs crippled.
- macOS updates itself without a signing certificate by treating the .app as what it
  is - a folder. `src/main/macUpdate.ts` downloads the release zip, expands it with
  `ditto` (never `unzip`: it flattens the framework symlinks and the bundle will not
  launch), checks the version inside, and leaves a detached shell script to move it in
  after this process exits. Squirrel.Mac, which electron-updater would use, validates
  code signatures and refuses an ad-hoc signed build - so it is not used on darwin at
  all. `npm run test:macupdate` covers the swap.
- Ignoring the update prompt on Windows is not the same as refusing it: the
  downloaded update installs when you close the app, so the fix is there next time
  you start it. Nothing is swapped under a live pane - the panes are gone by then.

## License

MIT. Do what you like with it.

## Architecture

PTYs and all OS access live in the Electron main process (`src/main`). The renderer
(`src/renderer`) is pure UI and talks over a narrow typed IPC surface defined in
`src/shared/types.ts` and exposed by `src/preload`.
