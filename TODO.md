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
- [x] **D2. Search the scrollback** — S. **Done in v0.4.0.** `Ctrl F` opens a find bar in
  the focused pane; every match is highlighted, Enter and Shift Enter step, Escape closes
  and hands the keyboard back. It searches THAT pane’s buffer, so with four open the answer
  is never another agent’s scrollback. `npm run test:view` pins it.
- [x] **D3. Keyboard copy mode** — M. **Done in v0.4.13.** `Ctrl Shift U`: `hjkl` or the
  arrows, `w b e` by word, `0 ^ $ g G`, Ctrl-D/U by half a screen, `v` to select, `V` for
  whole lines, `y` to copy into the clipboard and the Stash, `/` hands over to the find
  bar, Escape leaves. A strip along the bottom of the pane lists all of it, because a
  modal mode with nothing on screen saying so is the worst kind. The word motions are
  vi's WORD ones, not its small `w`: in a terminal the thing being reached for is a path
  or a flag, and `src/main/pipe.ts` is one thing to a person and eight stops to vi.
  `npm run test:copymode` pins the arithmetic; `npm run test:view` pins the two things
  only a window can answer - that the mode opens in the pane you are typing into, and
  that no motion key ever reaches the pty.
- [x] **D4. Zoom a pane** — S. **Done in v0.4.0.** `Ctrl Shift Z`, or the zoom button on the
  pane title, makes the focused pane the whole window and back. The grid, its sizes and the
  order underneath are untouched, and the zoom is dropped by itself if that pane closes.
- [x] **D5. Preset layouts** — S. **Done in v0.4.0.** Tiled, columns, rows, big left and
  big top, cycled with `Ctrl Shift G` or picked by name from the palette. Named after what
  you get rather than after the split tmux would have made, and each keeps its own dragged
  sizes: a `2x3` reached by stacking three panes beside a big one is not a tiled `2x3`.
- [x] **D6. Swap / move panes by keyboard** — S. **Done in v0.4.11.** `Ctrl Shift ←` / `→`
  moves the focused pane one slot along the grid. No mark step: tmux needs one because
  `{`/`}` swap with a pane you cannot see from the one you are in, and here you can. It
  **swaps** rather than re-inserting, which is what the drag already did - inserting
  shuffles every pane after the drop into a different cell. `moveInOrder` in
  `gridLayout.ts`, pinned by `npm run test:grid` and, in a real window, `test:view`.
- [x] **D7. Synchronised typing** — S. **Done in v0.4.11.** `Ctrl Shift Y` sends every
  keystroke - control codes and arrows included, not a line at a time like the broadcast
  box - to every open pane, and rings them all in amber while it is on. Only the pane
  being typed IN fans out, so two panes cannot echo each other round in a loop, and a
  mirrored keystroke feeds the receiving pane's draft as well as its pty, so the improve
  chip does not drift out of step with what is on its screen.
- [x] **D8. Idle and bell alerts** — M. **Done in v0.4.13.** Two alerts that are not "your
  turn finished": a running turn that has printed nothing for N minutes (5 by default,
  `silenceAlertMin`, `never` available), and the terminal bell, which the app had been
  swallowing. Both mark the pane, both clear when you look at it, and both have their own
  sound - falling for a stall, one bright note for a bell - so which one it was is
  answerable without looking. The rule tmux's `monitor-silence` uses was deliberately NOT
  copied: silence at an idle prompt is the normal state of a pane you are not using, and
  alerting on it means eight alerts about nothing every N minutes. Only a pane whose turn
  clock is still running counts. `npm run test:silence` pins the truth table.
- [ ] **D9. A scriptable CLI** — M. `tmux send-keys` / `capture-pane` / `new-window` is why
  tmux is automatable. We have `--open <path>`. Build `paneforge <verb>` over a local socket
  to the running app: `open`, `send`, `capture`, `list`, `close`. **The point that neither
  competitor has noticed:** the agents themselves can then drive PaneForge — a Claude pane
  opening a second pane to run its own tests, and reading the output back.
- [x] **D10. Pipe a pane's output** — S. **Done in v0.4.13.** "Write this pane to a file as
  it runs" in the palette (plain-text variant beside it), a chip on the pane header
  counting the bytes, and clicking the chip stops it. Straight through - one stream write
  per chunk, no debounce - because the point is something ELSE following the run: a
  `tail -f`, a log viewer, another agent. The transcript in `history.ts` already kept
  every byte, but in the app's own profile folder, under a session id nobody typed, on a
  1.5s timer. Text mode shares the transcript's stripper (`shared/ansi.ts`), which had to
  learn to work a chunk at a time: an escape sequence split across two chunks used to
  leave `1mb` in the file. A tee pointed at something slow drops output rather than
  buffering it without limit, and says so on the chip. `npm run test:pipe`.
- [x] **D11. Pinned Stash entries** — S. **Already done when this list was written**, which
  is worth more than the tick: the item was researched from tmux's side and never checked
  against ours. `pinRecent` in `src/main/recents.ts` holds an entry out of every cap, the
  file clock and the sweep, and sorts it above the rest; the 📌 is on every row in
  `shelf.tsx`. What is still missing is the *keyboard-only picker* and `save-buffer` -
  a smaller item than this one, and it belongs under D3 (copy mode) when that lands.
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
- [x] **D15. Pane border status** — S. **Done in v0.4.11.** The branch (`GitBadge`) and the
  model (the picker) were already on the pane title; the turn clock was only in the
  sidebar, which is the thing you are not looking at in a grid of four. It is on the pane
  now - counting while the agent works, then the last turn's length, then `exited N`.

---

## Order to build in

1. ~~**D2, D4, D5**~~ — shipped in v0.4.0: find in a pane, zoom one pane, five layouts.
   ~~**D6, D7, D15**~~ — shipped in v0.4.11: keyboard pane swap, synchronised typing, and
   the turn clock on the pane border. D11 turned out to be built already.
   ~~**D10, D8, D3**~~ — shipped in v0.4.13: tee a pane's output to a file, the silence
   and bell alerts, and keyboard copy mode. That is the whole of the cheap half; what is
   left under D is the architectural end of it (D1 detach, D9 CLI, D12 hooks).
2. **A1, A2, A3, A4** — diff + commit + PR. The one gap a user switching from T3 Code would
   name first, and the README already admits it.
3. **C3, C5, C8, C1** — permission modes, project scripts, resource readout, rebindable keys.
4. **B1** — headless host. Unblocks B2, B7, D1 and C10, and is the single largest
   architectural step here.
5. **B2, D1** — browser client and true detach. This is the point where PaneForge does the
   thing T3 Code ships four codebases to do, with one renderer.
6. **D9, D12, C7, B4, B5** — CLI, hooks, preview, tailnet, Linux.
7. **B6** — package managers, whenever signing is paid for.
