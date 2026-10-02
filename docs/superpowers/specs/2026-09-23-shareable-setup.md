# PaneForge for other people: zero-effort setup (2026-09-23)

Robert: "i need paneforge able to share with other users to use so make sure super simple
setup and automatically does everything it needs ... so it can run like it is here ...
autoclear flow ... make sure they can connect remote devices easy too."

A new user downloads the installer from GitHub Releases (repo is public), opens the app,
and ends up where Robert is: Claude Code installed and signed in, lanes on, auto-clear on,
and a second machine pairable from any network. No terminal.

## What is missing today (measured 2026-09-23)

1. Auto-clear only works on Robert's machine: the Stop hook (`autoclear.mjs`), the
   request script (`pane-clear.mjs`) and the SessionStart handoff injector live in his
   private `claude-memory/claude-config` repo. A new user gets nothing.
2. Installed hooks run `node ...`. Claude Code's native installer does not put Node on
   PATH, so on a machine without Node every hook fails.
3. No first-run check. Claude Code's install line is `npm i -g @anthropic-ai/claude-code`
   (`src/shared/agents.ts`), which needs Node. Sign-in is never mentioned.
4. Pairing (`src/main/remote/invite.ts`) carries every local address, so two machines on
   different networks pair only if both already run Tailscale. Nothing says so.
5. The Mac build is not Apple-notarized (`mac.identity: null`), so a downloaded copy is
   blocked on first open. Fix needs a paid Apple Developer account: Robert's call.

## Workstreams (separate files, run in parallel)

### A. Auto-clear ships in the app (main chat)
- `scripts/autoclear-hook.mjs` (packaged via `extraResources`): Stop + SessionStart hook,
  self-contained (node builtins only). Stop: context >= threshold (default 180,000 tokens,
  read from the transcript's last assistant `usage`) and no fresh handoff -> exit 2 telling
  Claude to write `~/.claude/projects/<slug>/memory/session-handoff.md` with a
  `## Next steps` list. Next Stop with a fresh handoff that has open steps -> writes a
  request file for the app (`<userData>/autoclear-requests/<PF_PANE>.json`). SessionStart
  `source=clear` -> prints the handoff as context.
- App watches that folder and feeds each request to the same code as `autoclear:ask`
  (countdown card, `/clear`, resume prompt). No network, no pairing code.
- Installer beside `laneHooks.ts`: tagged `--installed-by=paneforge`, installed app only,
  and LEFT ALONE when any existing hook already runs an autoclear (Robert's machine).
- Hook runner: `node` when on PATH, else the app binary with `ELECTRON_RUN_AS_NODE=1`.
  Lane hooks use the same runner.

### B. First-run setup card (helper 1)
Welcome screen shows a short checklist only while something is missing: Claude Code
installed (native installer, no Node needed), Windows Git (Claude Code on Windows needs
Git Bash), signed in. Each row has one button. Reuses `src/main/install.ts` +
`InstallConsole.tsx`.

### C. Devices from any network + download page (helper 2)
Devices dialog: when this machine has no Tailscale address, one plain line + button to
install Tailscale, saying both machines need it signed into the same account. README
"Install" section for other people: download link, Mac first-open steps, Windows
SmartScreen steps.

## Done means
- Fresh machine story holds end to end in a test copy: setup card lists what is missing,
  auto-clear hook installs in a sandboxed HOME, a request file arms the countdown.
- `npm run typecheck`, `npm test` pass; each workstream adds a `scripts/<x>-test.mjs`.
- Nothing released without Robert's word.
