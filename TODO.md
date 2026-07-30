# PaneForge — competitive backlog

What T3 Code (`t3.codes`, `pingdotgg/t3code`, 15.8k stars, MIT, TypeScript) and tmux
(`tmux/tmux`) do that PaneForge does not, as things to build. Written 2026-07-31 against
PaneForge v0.3.59.

Each item says what they do, what we have today, what to build, where it lands, and — where
there is one — the version that is better than theirs rather than a copy. Effort is
S (< half a day) / M (a day) / L (multi-day).

**Two things we are deliberately not copying**, so nobody re-opens them:

- **T3 Code renders a structured chat, not a terminal.** It parses each provider's JSON
  stream into message bubbles, so it gets inline approvals, inline diffs and per-message
  search for free — and loses the real TTY: no full-screen CLI, no Ctrl-C semantics, no
  agent PaneForge has never heard of. PaneForge's whole identity is `src/main/sessions.ts`
  spawning a real pty. Everything below is achievable **without** giving that up. Items that
  would need the chat model are marked *(needs stream parsing)* and are opt-in overlays on
  top of the pty, never a replacement for it.
- **tmux's session/window/pane hierarchy.** Our workspaces + grid already cover it. Adopting
  windows-inside-sessions would be a data-model migration that buys a second layer of tabs.

---

## A. Git and review — the largest gap (T3 Code)

We have `src/main/git.ts` → `gitInfo()`, which is branch + dirty count for the pane badge,
and `LaneDialog.tsx`, which merges a worktree lane back. That is the whole of it. T3 Code
ships a full source-control surface: clone, publish, commit, push, PR, review.

- [ ] **A1. Diff review before merge** — L. *(README already lists this as "not built yet")*
  T3 Code shows an inline diff and a one-click PR. We show a file **count** in the lane chip
  and ask you to trust it. Build: a diff view (`git diff --numstat` for the file list,
  `git diff -- <file>` per file, rendered with a JS differ — no new native dep) reachable
  from the lane chip and from a new pane action. **Better than theirs:** open it against the
  *lane* as well as the branch, so the question it answers is "what has this agent done to
  my repo in the last hour", which is the actual question with four agents running.
- [ ] **A2. Commit + push from the pane** — M. Toolbar on the pane: stage all, commit with a
  message, push. Today the agent has to be told to do it, or you leave the app. **Better:**
  offer the commit message from the diff via the pane's own agent (it already has the
  context loaded) instead of a separate API call.
- [ ] **A3. Create a PR** — M. `gh pr create` (already a dependency of Robert's setup, and
  `gh` is what T3 Code shells out to as well), title/body suggested from the commits since
  the base branch. Reuse `scripts/release-notes.mjs`'s Conventional-Commit grouping — we
  already have that parser and they do not.
- [ ] **A4. "This branch has an open PR"** — S. Badge next to the git badge, click to open in
  the browser. `gh pr view --json` cached on the same 30s idle timer as `git.ts`.
- [ ] **A5. Clone a repo into the projects root** — M. T3 Code's palette has *Add Project →
  GitHub repository / Git URL*. Ours only lists folders that already exist. Add to
  `CommandPalette.tsx` + `NewSessionDialog.tsx`: paste `owner/repo` or a URL, pick the
  destination, clone with progress in an `InstallConsole`-style stream, then open a pane in
  it.
- [ ] **A6. Publish a local repo** — S. A folder with no `origin` → create a private GitHub
  repo, add the remote, push. Small and it removes a genuinely annoying manual step.
- [ ] **A7. Source-control status page** — S. Settings → Source Control: is `gh` installed,
  is it authenticated, which account. Same shape as Settings → Agents, which already exists
  and works. GitHub only to start; GitLab/Bitbucket/Azure are T3 Code chasing teams.

## B. Reach — remote, mobile, headless (T3 Code)

`src/main/remote/` is a peer-to-peer link between two *desktop copies* on a LAN: UDP
discovery, pairing code, scrypt + AES-256-GCM. It is good, and it is desktop-to-desktop
only, and both ends must be running the GUI. T3 Code has iOS, Android, a hosted web app, a
headless `t3 serve`, a Linux background service, Tailscale endpoints and SSH-launched
environments.

- [ ] **B1. Headless host mode** — L. `paneforge --serve` starts the pty host with no window.
  This is the keystone: it is what makes B2/B3 and D1 (detach/reattach) possible, and it is
  mostly a re-wiring of `src/main/index.ts` so the remote link and `sessions.ts` can run
  without `BrowserWindow`. Do this before anything else in this section.
- [ ] **B2. Browser client** — L. The renderer is already pure UI over a typed IPC surface
  (`src/shared/types.ts`, 204 channels). Serve it over HTTP from B1's host and back the
  same surface with the existing encrypted socket instead of `ipcRenderer`. That one change
  is a phone client, a tablet client and a second-machine client at once — no App Store, no
  second UI codebase. **Better than theirs:** they maintain native iOS + Android + web +
  Electron; we would maintain one renderer.
- [ ] **B3. QR / link pairing** — S. Today you read a pairing code out loud. Print a QR of
  the pairing URL in `RemoteDialog.tsx` (the pairing code is still the secret; the QR only
  carries the address and a one-shot token).
- [ ] **B4. Reach beyond the LAN** — M. UDP broadcast dies at the subnet. Add a manual
  endpoint field, and detect Tailscale (`tailscale ip -4`, MagicDNS name) the way T3 Code
  does — a tailnet is the honest answer to remote access and costs us no server.
- [ ] **B5. Linux build** — M. T3 Code ships winget, brew cask and AUR. We are Windows +
  Apple Silicon. electron-builder already targets Linux; the work is `node-pty` prebuilds,
  the `.desktop` entry and testing the update path.
- [ ] **B6. Package managers** — M. `winget install` / `brew install --cask`. Likely gated on
  **code signing** (see memory `infra_windows_signing_sac`): winget's manifest validation
  runs the installer and an unsigned one trips the same Smart App Control block users hit
  today, and a brew cask of an unsigned .app still meets Gatekeeper on first launch. Both
  claims are **untested** — before spending effort here, submit one throwaway manifest and
  see what validation actually says, rather than assuming.
- [ ] **B7. SSH-launched environment** — L. T3 Code can start its server on another machine
  over SSH and port-forward it back. Only worth it after B1 exists; then it is "run the host
  over there, point the link at localhost".

## C. Control surface (T3 Code)

- [ ] **C1. Rebindable keys** — M. Our shortcuts are hardcoded in `App.tsx` and listed in
  `ShortcutsDialog.tsx`. T3 Code has command IDs, a JSON rules file and `when` conditions
  (`terminalFocus`, `previewOpen`, …) with last-match-wins precedence. Build: name every
  action with an ID, put the table in `config.json`, add Settings → Keybindings with
  conflict warnings. **Better:** we can seed the defaults from the current
  `ShortcutsDialog` list, so nobody's fingers change.
- [ ] **C2. A prefix key** — M. The real problem C1 only half-solves: every `Ctrl` chord we
  take is one the shell and the agent no longer get (already a live issue on macOS, see
  memory `project_mac_shortcuts_cmd`). tmux solved this in 2007 with a prefix. Add an
  optional leader (`Ctrl Space` by default, off by default) so app commands live in their own
  key table and the terminal keeps the entire keyboard. Neither competitor does this in a
  GUI.
- [ ] **C3. Permission modes per pane** — M. T3 Code has four (Supervised / Auto-accept edits
  / Auto / Full access) mapped onto each provider's own flags. We launch every CLI on its
  defaults. Build: a per-pane mode in `src/shared/agents.ts` alongside the model flag —
  Claude's `--permission-mode`, Codex's approval policy + sandbox level — shown on the pane
  and remembered per project. Low effort for how much it changes unattended runs.
- [ ] **C4. File picker (Ctrl P) and project search (Ctrl Shift F)** — M. Fuzzy-find a file in
  the pane's folder, or grep the project, and **type the path into the pane** rather than
  opening a viewer. That last part is the optimisation: what you want from a file picker
  inside an agent app is to hand the agent a path, and dragging files onto a pane
  (which we already do) proves the interaction.
- [ ] **C5. Project scripts as commands** — S. T3 Code exposes `script.<id>.run`. Read the
  project's `package.json` scripts (and `justfile`, which Robert's repos use) and list them
  in the palette; running one opens a pane on it. Cheap, obvious, immediately useful.
- [ ] **C6. Search transcript *content* from the palette** — M. `Ctrl H` already searches
  history; T3 Code's palette searches thread titles, projects, branches, **user messages and
  final agent responses** in one box. Fold transcript-body search into `CommandPalette.tsx`
  so one keystroke covers "where did I do this".
- [ ] **C7. Preview pane** — L. T3 Code renders the project's dev server next to the agent
  (`preview.refresh`). We already assign each lane its own `PORT` — we know the URL better
  than they do. A `BrowserView` tile in the grid pointed at it, auto-refreshed on save.
- [ ] **C8. Per-pane resource readout** — S. T3 Code has resource telemetry. We have status
  dots. Add CPU / RSS per pty to the pane footer — with four agents running, "which one is
  eating the machine" is a real question, and the pid is already in `sessions.ts`.
- [ ] **C9. Switch model mid-run** — M. `Ctrl Shift A` swaps the *agent* by restarting the
  pane; T3 Code switches model inside a thread. For a CLI the equivalent is sending the
  agent's own in-band command (`/model …` for Claude Code) instead of restarting. Per-agent
  entry in `src/shared/agents.ts`.
- [ ] **C10. Zero-install trial** — S. `npx t3@latest` is how T3 Code gets tried. Once B1/B2
  exist, `npx paneforge` serving the browser client is the same trick with no download and
  no Smart App Control problem.

## D. Terminal craft (tmux)

This is where tmux is thirty years ahead and the items are small.

- [ ] **D1. Detach and reattach** — L. tmux's client/server split means closing the terminal
  does not kill the work. We snapshot the desk (`src/main/restore.ts`) and **re-spawn**,
  asking each agent to resume its conversation — which is a good imitation and still loses
  anything mid-run. With B1 the real thing is available: ptys live in the host, the window
  attaches and detaches, closing the window leaves the agents running. **Better than tmux:**
  we can offer both — attach to a live pty, or the transcript-resume we already have when
  the host was not running.
- [ ] **D2. Search the scrollback** — S. **Highest value per hour on this list.**
  `@xterm/addon-search` is one npm install and two bindings (`Ctrl F`, `n`/`N`) in
  `TerminalPane.tsx`. tmux has had `C-r`/`C-s` in copy mode forever; we have no way to find
  anything in a pane that has scrolled.
- [ ] **D3. Keyboard copy mode** — M. Copy-on-select needs a mouse. tmux: `C-b [`, move,
  select, copy, exit. xterm.js exposes the buffer and selection APIs; a small vi-ish mode
  (`hjkl`, word motions, `v` select, `y` yank into the Stash) covers it. Pairs with D2.
- [ ] **D4. Zoom a pane** — S. `C-b z` toggles one pane to full window and back without
  disturbing the layout. `Ctrl G` toggles the whole grid; there is no "make *this* one big
  for a minute". Trivial in `gridLayout.ts`, used constantly.
- [ ] **D5. Preset layouts** — S. tmux ships even-horizontal, even-vertical, main-horizontal,
  main-vertical, tiled, and one key to cycle them. Our grid is drag-only, so a disturbed
  layout is fixed by hand. Add the five presets plus a cycle key.
- [ ] **D6. Swap / move panes by keyboard** — S. tmux marks a pane (`C-b m`) and swaps
  (`{` / `}`). We can only drag. Add mark + swap and directional move.
- [ ] **D7. Synchronised typing** — S. We have a broadcast box: one line, sent once. tmux's
  `synchronize-panes` mirrors **every keystroke** to every pane in the window, which is what
  you want for "all four of you, Ctrl-C, then re-read the plan". Toggle, with the panes
  visibly outlined while it is on.
- [ ] **D8. Idle and bell alerts** — M. tmux has `monitor-activity`, `monitor-silence`,
  `monitor-bell` with per-window actions. We chime when a turn ends. Add: alert when a pane
  has been **silent** for N minutes (the agent is stuck or waiting, and with eight panes you
  will not notice), and surface the terminal bell.
- [ ] **D9. A scriptable CLI** — M. `tmux send-keys` / `capture-pane` / `new-window` is why
  tmux is automatable. We have `--open <path>`. Build `paneforge <verb>` over a local socket
  to the running app: `open`, `send`, `capture`, `list`, `close`. **The point that neither
  competitor has noticed:** the agents themselves can then drive PaneForge — a Claude pane
  opening a second pane to run its own tests, and reading the output back.
- [ ] **D10. Pipe a pane's output** — S. `pipe-pane` tees a pane live to a file or command.
  We write transcripts at the end. Live tee lets a watcher (or another agent) follow a run.
- [ ] **D11. Named / pinned Stash entries** — S. tmux has 50 auto buffers plus **named**
  buffers that are never evicted, `load-buffer` and `save-buffer`. Our Stash evicts by age
  and size with no way to say "keep this one". Add pin + save-to-file, and a keyboard-only
  picker.
- [ ] **D12. Hooks** — M. `set-hook` runs a command on an event. We have none. Fire on
  pane-opened / turn-finished / pane-exited / lane-merged, running a user command with the
  session as env. This is also the honest way to let Robert wire PaneForge into taskdriver
  without patching the app.
- [ ] **D13. A text config file** — S. All state is `config.json` edited through the GUI.
  tmux's `.tmux.conf` + `source-file` means a setup is diffable, shareable and version
  controlled. Read an optional `~/.paneforge.conf` (or `.paneforge/config.json` per project)
  on top of the GUI settings, and reload it on change.
- [ ] **D14. Floating pane / popup** — M. tmux 3.8 has floating panes and `display-popup`.
  The Stash overlay proves we can float a window; a scratch pane over the grid (quick shell,
  a `git log`, a build) that closes with Escape is the same machinery.
- [ ] **D15. Pane border status** — S. tmux puts a format string in the pane border
  (`pane-border-format`). Ours carries a title. Add the branch, the model and the elapsed
  time to the border/footer — we already compute all three (`GitBadge`, `Elapsed`).

---

## Order to build in

1. **D2, D4, D5, D6, D7, D11, D15** — a day or two, all terminal craft, all visible
   immediately. tmux parity is the cheapest quality in this document.
2. **A1, A2, A3, A4** — diff + commit + PR. The one gap a user switching from T3 Code would
   name first, and the README already admits it.
3. **C3, C5, C8, C1** — permission modes, project scripts, resource readout, rebindable keys.
4. **B1** — headless host. Unblocks B2, B7, D1 and C10, and is the single largest
   architectural step here.
5. **B2, D1** — browser client and true detach. This is the point where PaneForge does the
   thing T3 Code ships four codebases to do, with one renderer.
6. **D9, D12, C7, B4, B5** — CLI, hooks, preview, tailnet, Linux.
7. **B6** — package managers, whenever signing is paid for.
