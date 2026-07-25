# PaneForge

Desktop app for running Claude Code (and Codex) sessions - start only the ones you
need, one window, real terminals. Self-hosted alternative to BridgeMind, scoped to a
solo workflow. See `PLAN.md` for the full roadmap.

## Status

M0 + M1 core done:

- Real pty per session (`@lydell/node-pty`), so the agent TUI behaves exactly as it
  does in Windows Terminal: colours, input box, Ctrl-C, resize.
- Project picker ranked by when you last worked in each folder (read from
  `~/.claude/projects` transcripts), filter-as-you-type, optional first message.
- Sidebar with live status dots: starting / working / waiting for you / exited.
- Tab view or 2x2 grid; panes stay mounted so scrollback survives switching.
- `--continue` (resume last session) and `codex` as an alternative agent.

Not built yet: git worktree isolation, diff/merge review, task board, session
persistence across app restarts (see PLAN.md M2-M4).

## Run

```
npm install
npm run dev        # electron-vite dev with HMR
npm run build      # production bundle into out/
npm run smoke      # headless proof the pty layer can drive `claude`
npm run typecheck
npm run package    # unpacked Windows build via electron-builder
```

`--open <path>` (or `PANEFORGE_OPEN=<path>`) starts a session in that folder on launch.

## Keys

| Key | Action |
|---|---|
| Ctrl T | new session picker |
| Ctrl W | close the focused session |
| Esc | dismiss the picker |

## Windows notes

- ConPTY does not search `PATH`. The agent binary is resolved to an absolute path
  first (`src/main/which.ts`); spawning the bare name fails with `File not found`.
- `@homebridge/node-pty-prebuilt-multiarch` cannot install on Node 20+ on Windows
  (its install script hits `spawn EINVAL`). `@lydell/node-pty` ships per-platform
  prebuilt binaries and no install script.
- Claude Code's own env markers (`CLAUDECODE`, `CLAUDE_CODE_*`) are stripped before
  spawning, otherwise a session launched from inside Claude Code runs as a child
  session with transcript saving disabled.

## Architecture

PTYs and all OS access live in the Electron main process (`src/main`). The renderer
(`src/renderer`) is pure UI and talks over a narrow typed IPC surface defined in
`src/shared/types.ts` and exposed by `src/preload`.
