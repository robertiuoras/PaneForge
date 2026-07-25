# PaneForge

Desktop app for running Claude Code (and Codex) sessions. Pick the projects you
actually need, each gets a real terminal in one window. Replaces the old
`start-claude-panes.bat` grid, which always opened the same five.

## Install

```
npm run setup
```

Installs dependencies, builds the app, and puts a **PaneForge** shortcut on the
Desktop and in the Start Menu. Re-run after any source change - it closes the running
app, rebuilds in place, and keeps the same shortcut.

Requires Node 20+ and `claude` (and `codex`, if you use it) on `PATH`.

## Using it

- **Ctrl T** - project picker, ranked by when you last worked in each folder. Click a
  project to start it, or tick several (checkbox / Space) and press Enter to start
  them all at once.
- **Workspaces** - a saved set of projects, launched with one click. Tick a few in the
  picker and hit *Save as workspace*, or save whatever is already running from the
  sidebar. This replaces editing the `PROJECTS=` line in the old .bat.
- **Grid view** - every session on screen at once, auto-arranged near-square.
- **Status dots** - yellow starting, green working, blue quiet (probably waiting for
  you), grey exited. A session that goes quiet while the window is in the background
  raises a Windows notification and flashes the taskbar.
- **Broadcast box** - one line sent to every live session, e.g. `/clear`.
- **Restart (⟳)** - respawns the agent in the same pane and folder; also revives an
  exited session.
- Pane buttons open the folder in Explorer or in Cursor / VS Code. Double-click a
  title to rename a session.

Press **F1** in the app for every shortcut.

## Settings

Gear icon, or Ctrl `,`:

- projects folder (any folder of folders, not just `Desktop\Projects`)
- default agent, terminal font size
- notifications, close confirmation, start with Windows
- **Restart as admin** - Electron cannot elevate a single agent, so the whole app
  restarts elevated and every agent it spawns inherits admin. Needed only when an
  agent must stop admin-owned processes (e.g. a service holding port 8000), which is
  the same trade-off the old self-elevating .bat made.

State lives in `%APPDATA%\PaneForge\config.json`: workspaces, settings, window
geometry.

## Dev

```
npm run dev        # electron-vite dev with HMR
npm run typecheck
npm run smoke      # headless proof the pty layer can drive `claude`
npm run package    # unpacked Windows build only, no shortcuts
```

`PaneForge.exe --open <path>` (or `PANEFORGE_OPEN=<path>`) starts a session in that
folder on launch; a second launch focuses the window already open.

Not built yet: git worktree isolation, diff/merge review, task board, reattaching to
sessions after an app restart (see `PLAN.md` M2-M4).

## Windows notes

- ConPTY does not search `PATH`. The agent binary is resolved to an absolute path
  first (`src/main/which.ts`); spawning the bare name fails with `File not found`.
- `@homebridge/node-pty-prebuilt-multiarch` cannot install on Node 20+ on Windows
  (its install script hits `spawn EINVAL`). `@lydell/node-pty` ships per-platform
  prebuilt binaries and no install script.
- Claude Code's own env markers (`CLAUDECODE`, `CLAUDE_CODE_*`) are stripped before
  spawning, otherwise a session launched from inside Claude Code runs as a child
  session with transcript saving disabled.
- `electron-builder` cannot wipe `dist/win-unpacked` while the app is open, so
  `npm run setup` closes PaneForge before building.

## Architecture

PTYs and all OS access live in the Electron main process (`src/main`). The renderer
(`src/renderer`) is pure UI and talks over a narrow typed IPC surface defined in
`src/shared/types.ts` and exposed by `src/preload`.
