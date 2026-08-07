# PaneForge — competitive backlog

What the other agent-runners do that PaneForge does not, as things to build. Sections A–D
were written 2026-07-31 against v0.3.59 from T3 Code (`t3.codes`, `pingdotgg/t3code`,
15.8k stars, MIT, TypeScript) and tmux (`tmux/tmux`). Section E was added 2026-08-06
against v0.4.54 from four more: opcode (`winfunc/opcode`, 22k, Tauri GUI for Claude Code),
Vibe Kanban (`BloopAI/vibe-kanban`, 27k, **sunsetting**), Claude Squad
(`smtg-ai/claude-squad`, 8k, tmux-based TUI) and Container Use (`dagger/container-use`,
3.9k, MCP + containers). Section G was added 2026-08-07 against v0.7.1 from Orca
(`stablyai/orca`, 38.7k, MIT, TypeScript + Electron), which is the closest thing to
PaneForge that exists and the largest of the lot by a factor of two.

Each item says what they do, what we have today, what to build, where it lands, and — where
there is one — the version that is better than theirs rather than a copy. Effort is
S (< half a day) / M (a day) / L (multi-day).

**This page is refreshed by `npm run competitors`, not by remembering.** Three dates in the
paragraph above is three occasions of somebody reading seven READMEs by hand, which is why
Orca reached 38.7k stars before it appeared here at all. `scripts/competitors.mjs` reads the
watchlist in `competitors.json`, asks GitHub for each repo's stars, latest release, README
hash and archived flag, and prints only what moved — star drift under 5% is deliberately
silent, because a report that is mostly noise stops being read. The snapshot in
`docs/competitors.state.json` is checked in, so `git diff` after a run *is* the report and it
survives both machines. **A "README changed" line is the trigger to re-read that project's
feature list into a section here.** `npm run test:competitors` covers the quiet half.

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
- **A container per agent** (Container Use). It buys isolation we already get from worktrees
  plus a hard Docker dependency, a cold-start per pane, and an agent that can no longer see
  the machine's real toolchain — which for Robert's repos (node-pty prebuilds, gh auth,
  local Supabase, an Electron app that must render) is the whole job. The honest version of
  what containers are for here is **C3 permission modes**, which is already on the list.
- **A kanban board as the primary surface** (Vibe Kanban). It is sunsetting, and the reason
  is instructive: planning UI is not where the value is once the agent is good. Our
  `.paneforge/tasks.json` board is the right size. E7 is the one piece worth taking.

---

## A. Git and review — the largest gap (T3 Code)

We have `src/main/git.ts` → `gitInfo()`, which is branch + dirty count for the pane badge,
and `LaneDialog.tsx`, which merges a worktree lane back. That is the whole of it. T3 Code
ships a full source-control surface: clone, publish, commit, push, PR, review.

- [x] **A1. Diff review before merge** — DONE. `src/main/diff.ts` + `src/shared/patch.ts`
  + `DiffDialog.tsx`. The pane's git badge is now a button and the lane dialog has "See the
  changes" beside its merge button. Three scopes — uncommitted, this branch, both — because
  with four agents running the useful question depends on whether the pane is in a lane;
  `all` is the lane's answer and the one the merge button is really asking. No JS differ:
  git writes the patch and `shared/patch.ts` only numbers its lines, which is the part the
  patch text does not state. Read-only by design (an untracked file's patch is synthesised
  from its bytes rather than staged with `git add -N`, which would write an index an agent
  is using). `npm run test:diff`, 64 assertions. **Still open:** committing and staging from
  the dialog is A2, deliberately not built here.
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
- [ ] **A8. Ship a stack, not one 2000-line PR** — L. **A1 is now done**, so the one thing
  left in front of this is **A3** (create a PR).
  GitHub put stacked pull requests into public preview on 2026-07-30: a chain of PRs where
  each one's base is the branch below it, a stack map in the PR UI, server-side base
  retargeting when a middle PR merges, `gh stack` as a CLI extension, and a REST API plus a
  `stack` field on the GraphQL PR type — so it is drivable by us, not just clickable. Their
  own launch material (2026-08-04, "turn one giant AI-generated pull request into a
  reviewable stack") says out loud what the feature is for, and it is the exact thing this
  app produces: one agent runs for an hour and hands back a diff nobody can review.
  Build: in the diff view (A1), let the change be cut into ordered layers — by commit, or by
  a selection of files — and push each layer as a PR based on the one below via `gh stack`.
  **Better than theirs:** GitHub can only split what is already committed, so a human has to
  work out the seams afterwards. We watched the work happen — `split.ts` already reasons
  about file ownership, and the pane's own agent has the reasoning loaded — so we can propose
  the layer boundaries at the moment the work finishes, which is the only moment anyone knows
  what they were.
  **Caveats before starting:** public preview, so the API surface can still move — pin
  behaviour behind one adapter module and do not sprinkle `gh stack` calls through the UI.
  And keep the fallback honest: on a repo without the preview, a stack has to degrade to
  plain chained branches with base pointers set by hand (`gh pr create --base`), which is
  what git-spice (free, GPL-3.0, `--json` output) does entirely client-side and is the better
  thing to shell out to if we ever want this off GitHub.

**Stacking is not lanes, and neither replaces the other.** Lanes are for work that is
*independent and parallel* — several agents, several features, partitioned by file ownership
so they never touch the same lines, each merged back to master whenever it happens to finish.
There is no chain, so there is nothing to cascade. Stacking is for work that is *sequential
and dependent* — one feature whose changes build on each other, which you nonetheless want
reviewed as separate readable layers, merged in order. The two compose: a single lane's
output is exactly the thing worth stacking, and lanes remain how several stacks get built at
once. So A8 is a lane's exit path, not a competitor to `lane.mjs`, and nothing in the lane
engine changes for it.

## B. Reach — remote, mobile, headless (T3 Code)

`src/main/remote/` is a peer-to-peer link between two *desktop copies* on a LAN: UDP
discovery, pairing code, scrypt + AES-256-GCM. It is good, and it is desktop-to-desktop
only, and both ends must be running the GUI. T3 Code has iOS, Android, a hosted web app, a
headless `t3 serve`, a Linux background service, Tailscale endpoints and SSH-launched
environments.

- [ ] **B1. Headless host mode** — L. `paneforge --serve` starts the pty host with no window.
  Still open, and B2 shipped without it: the window is what answers the browser today, so a
  phone reaches this desk only while the app is up. That is the honest limit and it is stated
  in Devices. What B1 adds is a desk with no window at all (and D1's detach/reattach), and it
  is mostly a re-wiring of `src/main/index.ts` so the remote link and `sessions.ts` can run
  without `BrowserWindow`. It no longer blocks anything below it.
- [x] **B2. Browser client** — shipped 2026-08-08. The renderer was already pure UI over
  `window.api`, so the whole client was supplying that object over HTTP. What was in the way
  was that the name→channel mapping existed only as 141 closures in the preload; it is data
  now (`src/shared/surface.ts`, typed by `keyof Api`) and both transports are built from it,
  which is why the preload came out at 38 lines. `src/main/phone.ts` serves the built
  renderer, SSE down and POSTs up, and every call lands in the app's own `ipcMain` body
  through `src/main/ipcTap.ts` — no second surface, no copy of a handler. Off by default
  behind a six-character code, cookie derived rather than stored. `npm run test:phone` +
  `npm run test:phoneview` (real Chrome at 414x896: pane opened from the browser, typed
  into, echo read back). Three decisions worth not re-litigating are in `docs/design-notes.md`
  under "The phone is this window, served". **Better than theirs, as predicted:** they
  maintain iOS + Android + web + Electron, we gained a phone, a tablet and a second-machine
  client from one renderer.
- [x] **B3. QR / link pairing** — SHIPPED. The Devices phone panel draws `<address>/#<code>`
  as a QR and the pairing page posts a code it finds in the fragment, so pairing is a camera
  and one tap with nothing typed. Encoder is `src/shared/qr.ts`, no dependency: byte mode,
  error level M, versions 1-6, which is all a `http://255.255.255.255:65535/#ZZZZZZ` can
  ever need. The plan above said "the QR only carries the URL" and that turned out to be the
  wrong shape — a QR that lands on a form to type into is not pairing, it is a shortcut to
  typing. The **fragment** is what makes carrying the code safe: a browser never sends one
  to the server, so it is in no access log and no `Referer`. `npm run test:qr` decodes what
  the encoder draws (syndromes, payload, every version at every mask) and `test:phoneview`
  proves a scanned link pairs a real browser with nothing typed. OAuth and email were asked
  for and refused — see `docs/design-notes.md`.
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

## E. What the newer runners have (opcode, Vibe Kanban, Claude Squad)

Read 2026-08-06 off the 114 GitHub links Robert has saved in Toolstash. Everything here is
either absent from A–D or a sharper version of an item already in it. Where an item extends
an existing one it says so rather than duplicating it.

- [ ] **E1. What this is costing** — M. opcode's headline feature is a usage dashboard: tokens
  and dollars broken down by model, project and time, read from `~/.claude/projects/*.jsonl`.
  We have **nothing** — `src/main/transcripts.ts` and `history.ts` already read those files
  for other reasons and throw the usage fields away. Build: a live token counter in the pane
  footer beside the turn clock, and a Usage tab totalling by project, model and day.
  **Better than theirs:** opcode reads Claude Code's logs and can only attribute cost to a
  folder. We *host* the agent, so we know which pane, which lane, which task and which agent
  every turn belongs to — we can answer "that refactor cost £6 and Codex would have been
  £0.40", which is the question, and none of the four can. This is also the single item on
  this page with the clearest payback for how Robert actually works.
- [ ] **E2. Is the MCP wiring alive** — S. opcode ships an MCP management panel.
  `claudeTrust.ts` already reads `mcpServers` out of `.claude.json` — to carry a pane's trust
  into a lane checkout — and then shows the user none of it. The failure mode is real and
  silent: a `gh` token rotates, the GitHub MCP starts 401-ing, and the only symptom is an
  agent that has quietly stopped being able to read PRs. Build: Settings → MCP, one row per
  server per agent (the keys `claudeTrust.ts` already parses, plus Codex's config),
  connected / failed / last error, and a re-add button. Same shape as Settings → Agents,
  which already exists and works.
- [ ] **E3. Saved launch recipes** — M. opcode has "CC Agents" (a saved system prompt +
  behaviour), Claude Squad has `-p "<program>"`. We pick an agent and a model at open time
  and that is it. Build: a named recipe = agent + model + permission mode (C3) + cwd +
  opening prompt, launchable from the palette or a hotkey, stored per project. This is what
  turns "open four panes and paste the same brief" into one keystroke, and it is the piece
  `SwarmDialog`/`split.ts` is missing to be usable outside a split.
- [ ] **E4. Comment on a diff line, and the agent gets it** — M, extends **A1**. Vibe Kanban's
  best idea: review the diff, leave an inline comment, it goes straight to the agent without
  leaving the UI. For us the comment is typed into that pane's pty as `path:line — <comment>`.
  **Better:** their comment goes to a scheduler that starts a new run; ours goes to the pane
  that already has the file, the branch and the reasoning loaded. Build A1 with this in mind
  rather than bolting it on after.
- [ ] **E5. Preview with an inspector** — M, extends **C7**. Vibe Kanban's preview has
  devtools, an inspect mode and device emulation. We already drive CDP against our own
  renderer for tests (`npm run probe`, `--remote-debugging-port`), so the machinery exists.
  The one interaction worth having beyond a plain preview: click an element in inspect mode
  and the pane receives the component's file path — the same trick as C4's file picker, from
  the direction people actually notice a bug.
- [ ] **E6. Turn-level checkpoints** — L. opcode snapshots session state so a run can be
  rewound or forked. `src/main/restore.ts` restores the *desk* (which panes, where, in which
  conversation); it does not let you undo one agent turn. Build: at each turn boundary record
  the transcript position plus a `git stash create` object id, and offer "back to before this
  turn" and "fork a new pane from here". **Caveat before starting:** the git half is only
  honest for tracked files, and an agent that ran a migration or wrote outside the repo
  cannot be rewound — say that in the UI or the feature lies.
- [ ] **E7. A task and a pane are the same thing** — S. `board.ts` gives each project a
  `.paneforge/tasks.json` with an `agent` hint per task, but `TaskItem` has no session id, so
  a task and the pane doing it are unrelated objects. Add the link both ways: open a pane
  from a task (recipe from E3, task title as the opening prompt, status → `doing`), and show
  the task on the pane. That is 90% of what Vibe Kanban was for, at 1% of its surface.
- [ ] **E8. The agent list is a competitive number** — S. Vibe Kanban advertised "10+ coding
  agents"; `src/shared/agents.ts` already has 13. Missing from ours and present on their
  lists: Droid, CCR (claude-code-router), Grok CLI, Cline/Continue. Each is a table entry plus
  a launch test. Cheap, and it is the number a comparison page gets judged on.

**Not a build item, but the reason to hurry:** Vibe Kanban (27k stars) announced it is
shutting down. Its users are people who already accepted "several agents, isolated branches,
review the diff, ship" — which is exactly PaneForge minus a hosted backend. A/E4/E7 is the
migration path.

---

## F. Agents that know about each other (Buzz)

Read 2026-08-06 against v0.4.60. Buzz (Block, Jack Dorsey, launched 2026-07-21, open
source) is a Slack-shaped workspace where AI agents are channel members: they are
@-mentioned, hand work to each other, open patches, and — the part that matters here —
**work in parallel git worktrees rather than the local checkout**, with one frontier agent
driving a swarm of cheaper ones that research, build, test and review at the same time.
Block reports the agents inventing coordination nobody scripted: recruiting each other,
splitting work into side channels, handing tasks across contexts.

**The verdict: the coordination is worth building, the chatroom is not.** PaneForge already
has the expensive half — it hosts the ptys, it owns the lane ledger, and `split` already
refuses overlapping file claims. What it does not have is any channel between panes, so
three lanes editing one repo each believe they are alone. That is the actual gap, and it is
ours to close more cheaply than Buzz can: Buzz has to run a relay and re-host git to get
agents in one room; we have them in one process already.

**Not copying** (belongs with the four at the top of this file):

- **Chat as the primary surface, on a relay.** Buzz stores chat and code as one kind of
  signed event so everything is searchable and auditable. That is a good design for a team
  product and the wrong one here: it costs the real TTY (the same objection as T3 Code),
  and a Slack-shaped window is a second inbox for one person at one desk. Our surface is
  the grid; the bus below is plumbing, not a room.
- **Agents as accounts.** Named identities, avatars and permissions are how a team of people
  keeps track. A pane already has a name, a project, a lane and a number.

Everything under F must work **across models** — Claude Code, Codex, and the eleven others
on the list. That rules out any per-CLI hook, for the same reason `promptArchive.ts` reads
the bytes on the way to the pty instead: an agent that ships next month is covered by
construction, and one that has no hook API at all is covered too.

- [ ] **F1. The shared board — who is holding what** — M. Extends `test:split`'s file claims
  from a one-shot check into standing state: each pane declares the files and the intent it
  is working on, written where every pane can read it (`.paneforge/`, beside `tasks.json`,
  since a lane worktree already shares the repo). Every other item under F needs this and
  nothing else does anything useful without it. **Better than theirs:** Buzz infers overlap
  from patches after the fact; we know the claim before the edit, because `split` already
  refuses to hand out overlapping ones.
- [ ] **F2. Cross-pane messages, over the pty** — M. One pane addresses another; the message
  arrives as typed text in the target's prompt, exactly the way `shared/draft.ts` already
  feeds one. Model-agnostic by construction. Three hard rules, all of which are the feature
  rather than caveats on it: it is delivered only when the target is **idle** (the silence
  detector in `test:silence` already knows), it is **rate-limited per pane per turn**, and it
  is **never delivered mid-turn** — an interruption that lands in the middle of a tool call
  is worse than no message. A bus that can type into a terminal can loop; the budget is the
  first thing built, not the last.
- [ ] **F3. Told when somebody moves your ground** — S, needs F1+F2. A lane that touches a
  file another lane claimed produces a message to that lane, not a conflict discovered at
  merge. This is the single failure this section exists to prevent, and it is the cheapest
  item once F1 and F2 are in.
- [ ] **F4. An orchestrator pane** — L, needs F1–F3. One pane that can open and close others,
  hand each a lane and a brief, read their summaries, and answer for the set. This is the
  "full workforce from my laptop" ask, and it is deliberately last: an orchestrator on top of
  panes that cannot see each other just fans out the same blindness faster. **Better than
  theirs:** Buzz's frontier agent coordinates by writing messages and hoping. Ours can read
  the lane ledger, the file claims and each pane's real git state, so "is lane b done" is a
  fact rather than a question it has to ask.
- [ ] **F5. Prompts that know what worked** — M. The pieces exist and do not meet: `Improve`
  rewrites a prompt, `promptArchive.ts` records that an ask was made, and `prompt-eval.mjs`
  scores a golden set (classification 62 → 77%). What is missing is the join — `outcome` is
  null for everything this app records, because nothing watches the pane's repo for the
  commit an ask turned into. Close that and the archive stops being a duplicate-detector and
  becomes the evidence for which phrasings actually land, per agent and per model. That is
  the honest version of "prompt engineering at the top level": measured, not asserted.
- [ ] **F6. Research that reaches the prompts** — M, needs F5. `scripts/capability-ingest.mjs`
  and the research pipeline already bring in new techniques and drop them in a catalogue
  nothing reads back. Wire the catalogue into F5's library so a technique that measurably
  improves the golden set is promoted, and one that does not is dropped. Until F5 exists this
  is a suggestion engine with no scoreboard, which is the state it is in now.
  **`RESEARCH-POLICY.md` still governs: `capability-ingest.mjs` is the only door in.**

---

## G. Orca — the same app, further along (`stablyai/orca`)

Orca is not an adjacent tool the way T3 Code or opcode are. It is an Electron desktop app
that runs any CLI agent in a real terminal across git worktrees, on Windows, macOS and
Linux, MIT-licensed, at 38.7k stars. That is PaneForge's sentence. So this section is
mostly a **confirmation**: the items already on this page are the right ones, and the
biggest app in the category shipped them. Only G1–G3 are new.

**Already listed, and Orca shipping it is the argument for moving it up:** AI diff
annotation is **E4**; the scriptable CLI is **D9** (Orca's also has browser verbs — `click`,
`fill` — which is D9 crossed with G3); usage tracking and the account switcher are **E1**;
remote execution is **B7**; a mobile client is **B2 + B3**; Linux and Homebrew are
**B5 + B6**; opening a worktree straight from an issue is **E7** with a tracker behind it.
None of those need re-arguing. E4, E1 and D9 are the three the comparison makes look
underpriced.

- [ ] **G1. Fan one prompt across N agents and pick the winner** — L. Orca's headline, and
  the one idea on this page we do not have a version of: send the same ask to five agents,
  each in its own worktree, then compare the five diffs and merge one. We have the two ends
  and not the middle — `SwarmDialog.tsx` splits work *apart* by file ownership (`test:split`
  refuses overlapping claims, which is the exact opposite of what this needs: here every
  agent claims every file, in isolation), synchronised typing already types one thing into
  many panes, `lane.mjs` already gives each pane an isolated worktree, and `DiffDialog.tsx`
  already reads a repo's changes. What is missing is the comparison surface and the
  discard: N worktrees created from one commit, one prompt, then a side-by-side of the
  diffs with "merge this one, delete the rest". Robert's personal `race` skill is this
  workflow done by hand through `claude-memory/claude-config/race.mjs`, which is where the
  ranking rules already live (bench number → lines changed → files touched). The version
  better than Orca's is that one: Orca compares by eye, and a repo with a test command can
  rank the candidates before a human looks at any of them.
- [x] **G2. Scrollback that survives a restart** — shipped 2026-08-07, and it was an S in the
  end rather than the M below: `history.ts` already held every pane's raw output on disk, so
  the build was `tail()` plus one field (`scrollbackId`) carried through the desk, and the
  renderer needed no change at all. `npm run test:scrollback`. Original note kept:
  Orca advertises it by name. Ours is
  `scrollback: 20000` in `TerminalPane.tsx` and lives only in the renderer's memory: quit,
  update, or crash, and the pane comes back blank. `test:restore` covers a different thing
  and is easy to mistake for this one — it puts a reopened pane back into the same
  *conversation* by handing the agent its `--resume`, which restores the agent's memory and
  not one line of what was on screen. This is the cheap half of
  `project_pty_survives_restart_decision`: keeping the **pty** alive across a restart was
  measured and rejected (a pty cannot be handed to another process after it exists), but
  keeping the **bytes** is a file. The tee in `src/main/pipe.ts` already writes a pane's
  output to disk with the ANSI handling done and `test:pipe` around it, so this is: always
  tee to a capped ring under userData, replay the tail into xterm on restore, and put it
  under the same age/size cutoff `test:history` pins for transcripts. It lands the day
  after an update, which is exactly when a restart is not the user's idea.
- [ ] **G3. Design Mode — click the UI, and the agent gets the element** — L. Orca embeds
  Chromium and lets you click a rendered element to send its HTML, its computed CSS and a
  screenshot into the prompt. This is **C7 (preview pane)** and **E5 (inspector)** finished
  rather than a fourth item, and it is worth naming separately because it changes what they
  are for: C7 as written is a viewport, and the value is not looking at the page, it is
  turning a click into prompt text. We have the harder half already — `npm run probe`
  drives a real renderer over CDP and evaluates an expression against it, which is the same
  mechanism pointed at our own window instead of the project's dev server. The screenshot
  discipline in `CLAUDE.md` applies to what gets sent: an element's outerHTML plus its
  computed style is a few hundred tokens, a full-page PNG is ten thousand.

**Not copying from Orca:** the 30+ agent list as a headline number is **E8** and stays a
number, not a promise — we already spawn whatever binary the user names, and a curated list
that works beats a long list that mostly does not. Computer Use as a first-class pane is
the same trade as containers: it buys a demo and a permission surface, and every agent that
matters ships its own.

---

## H. The phone — scanned 2026-08-07

Every runner in the category shipped a phone client in the last nine months, and they all
shipped the **same** one: the desktop keeps the agent, the phone watches it and answers it.
Orca's mobile app pairs with the desktop and explicitly "monitors and steers"; Cursor's iOS
app (2026-06-29) is a control panel and says so; Codex on ChatGPT mobile (2026-05-14) is
approvals and diff review with the terminal collapsed; Claude Code's own mobile reaches your
machine by Remote Control. Nobody moved the pty. That is `remote/`'s first decision, arrived
at independently by everyone who tried, and it is the reason the work below is a **view**,
not a second product.

**So B1 + B2 is the whole mobile app, and it stays that way.** T3 Code maintains iOS +
Android + web + Electron; Orca maintains iOS + Android + Electron; we serve the one renderer
we already have. **B2 shipped 2026-08-08 and it took B1 with it in one direction only:** a
phone gets the desk while the app is running, which is every case except a closed laptop.
The items here are what that renderer had to grow to be worth opening on a phone — because
the finding that actually costs something is that **a phone is not a small desktop**, and a
200-column xterm on a 5-inch screen is the version of this that gets installed once. That
part is done: under 720px the list and the panes take turns (`handheld.ts`), measured at
414x896 rather than looked at.

**Transport: B4, and nothing more clever.** Orca has two open issues adding Tailscale and
Tailscale SSH (#6754, #6184) — the biggest app in the category is, right now, arriving at
the answer B4 already names. Omnara and Happy Coder relay through infrastructure they run;
that is the thing we are not doing, and every one of them has a self-host page apologising
for it. A tailnet costs us no server and no account.

- [ ] **H1. Two notifications, not one bell** — M, and **half of it shipped 2026-08-07**.
  Cursor's iOS app pushes *"agent needs input"* and *"agent finished"* as separate classes,
  and that separation is the whole value: one is an interrupt, the other is an FYI, and a
  single ping trains you to ignore both. The **in-app** half is done with H3 below — the
  distinction now exists on screen as motion (`shared/fleet.ts`: a breath is the app
  working, a spreading ring is the app waiting on you, a terminal state is perfectly still)
  and as a count on the Fleet button, which is the first thing in this app to say how many
  panes want a PERSON rather than how many are busy. What is left is the transport: routing
  the same distinction to a phone, plus the deep link that opens *that pane*. Web Push is
  the mechanism; on iOS it needs the page added to the home screen, which is a limit to
  state in the UI rather than let somebody discover.
- [ ] **H2. The phone opens on the diff, not the terminal** — M. Codex mobile makes the diff
  the primary surface and collapses the terminal under it; that is the correct default for a
  screen you look at for eleven seconds. `DiffDialog.tsx` already reads a repo's changes and
  `test:diff` pins the `-z` records and renames, so the mobile route is a narrow layout over
  the same data, with the pty output one tap down.
- [x] **H3. Fleet view: who is working, who is stuck, what changed** — shipped 2026-08-07,
  Ctrl/Cmd Shift F. Conductor's single screen answers those three without opening a pane,
  and it turned out not to be phone-only work at all: the sidebar answered them only by
  reading eight cards, in the order the panes were opened, which is the one order that is
  never the order you care about. Three things it settled that the note below did not
  anticipate:
  - **The sort IS the feature.** `shared/fleet.ts` ranks needs-you above a stall above
    working, and inside one state puts the oldest first, because a pane that has been
    waiting eleven minutes is more interesting than one that finished four seconds ago.
    A pane's `SessionStatus` could not do this: two panes both reading `idle` are a
    finished turn and a CLI nobody has typed into, and those are not the same row.
  - **Motion is the status**, which is H1's in-app half and the one design idea worth
    taking from the whole category. Everyone else draws a spinner per row; here there are
    two motions meaning different things and terminal states are still, so the movement
    *stopping* is the event. `prefers-reduced-motion` turns both off and the words carry it.
  - **The diff bar** — log-scaled, so 40 lines beside a 3,000-line refactor is still
    visible rather than 1.3% of the bar — is the one thing on the page research found
    nowhere else shipped. One `git status` + one `git diff` per distinct FOLDER per tick,
    so four panes in one repo cost what one does.

  `npm run test:fleet` (42 assertions, no window). Verified in a real window against three
  live panes: the typed-into pane sorted to the top as `needsYou` with `callRing 2.4s`, the
  two untouched ones static, a non-repo folder drawing no bar, the changes opening *over*
  the list and Escape returning to it.
- [ ] **H4. What happened while you were away** — S. Jules ships an *audio* changelog of
  recent commits; the listenable part is a gimmick, the digest is not. One card per pane:
  turns taken, files touched, last question asked, since you last looked. Reads the same
  transcripts F5 and E1 read.
- [x] **H5. Voice in** - shipped 2026-08-07, and it was the opposite of "smaller than it
  looks". The note below was right that the desktop already dictated and wrong about why
  that did not count: dictation needed `pip install whisper-ctranslate2` first, which is
  the version of a feature that exists in Settings and never gets switched on. So the work
  was removing the install, not porting the hook.
  - **Three transcribers, one ladder** (`shared/voicePick.ts`): a whisper CLI on PATH when
    there is one, otherwise Whisper in a worker in this window, and on a phone the
    browser's own recogniser - which streams words as you say them, costs no download and
    is the one that sends audio off the device, so it is never picked while a local engine
    exists.
  - **The Web Speech API does NOT carry over, and the check the note asked for is the
    reason.** In Electron the constructor exists and every session ends `error: "network"`:
    Chromium's speech endpoint wants a Google key Electron does not ship. It is real only
    in a served browser, which is exactly the **B2** client - so H5 now gives B2 a feature
    rather than waiting on it.
  - **A phone is not a small desktop**, again. Touch or under 720px and dictating takes the
    whole screen (`VoiceOverlay.tsx`), with the input level drawn as the ring around the mic
    so a mic nobody is hearing shows it by not moving. Verified at 390x844.
  - Everything else in the note stayed true: it goes through `shared/draft.ts`, so the
    prompt archive and Improve still see it, and it stops short of pressing Enter.

  `npm run test:voice` (22 assertions incl. a sentence spoken by the OS voice through the
  shipped worker). What is NOT done: the browser engine has no surface to run in until B2
  exists, so on the desktop today the ladder is CLI-then-in-window.
- [ ] **H6. Per-session cost, not per-month cost** — S. Devin shows compute consumed *per
  child session*. That is **E1** with the aggregation undone, and it is the more useful
  reading: the number you want is "this pane has spent X on this ask", not "you spent Y in
  July". Build E1 this way and H6 costs nothing.

**Confirmations, not new items.** GitHub Agent HQ (GA 2026-02-04) fans one issue across
Claude, Codex and Copilot and then shows the PRs **side by side** — that comparison surface
is exactly what **G1** says is missing, shipped by GitHub, which settles the question of
whether it is the valuable half. Happy Coder's headline is instant switching between several
live agents from one mobile screen, which is **B2** and the sidebar. Orca's mobile pairing
validates the pty-never-moves seam in `remote/`.

**BridgeMind is not in this category.** BridgeSpace is a desktop ADE with multi-pane
terminals, a Kanban and up to 16 panes — so the surface rhymes — but it is credit-metered
(≈$16–100/mo in tiers, you pay them rather than bringing your own subscription), and it is
desktop-only by their own admission, with no mobile client. It competes with Cursor and
Replit, not with a local pty runner. The one thing worth a look is **BridgeSwarm**'s
per-agent file-ownership gating, which is the same problem `test:split` refuses to fudge.

**And the cautionary one:** Vibe Kanban's parent Bloop shut down in early 2026 — hosted
services wound down and refunded, the Apache-2.0 repo left to the community. It is in
`competitors.json` to confirm it stays dead. A runner whose value lives on someone's server
dies with the server; ours is a file on a disk.

## I. The app drives the work — scanned 2026-08-07

The reasoning, the survey it came from and the seven decisions are in
**`docs/agentic.md`**; these are the checkable items. The short version: this repo already
owns the isolation (lanes), the planner (`split.ts`), the launcher (Swarm) and the release,
and is missing the four things that turn those into a loop — an awaited headless turn, a
supervisor, a verification gate, and a budget. Every product in the category stops at a
pull request and so does this; the win is that nothing needs typing in the middle.

- [x] **I1. One headless turn, awaited.** Shipped 2026-08-07. `shared/agentic.ts` reads
      the stream, `main/agentRun.ts` spawns it and resolves
      `{ text, toolCalls, tokens, exit, diffstat }` however the turn ended - including
      `budget` (we killed it) and `silent` (exited 0 having said nothing). The first thing
      in this app that can run an agent with no pane.
- [x] **I2. The supervisor.** Shipped 2026-08-07. `main/supervisor.ts` drives the plan
      `split.ts` already produces: a worktree per brief, three lanes at a time, progress on
      the Fleet board, one stop switch. Started by **Drive it**, beside Launch in Swarm's
      Split tab.
- [x] **I3. The gate.** Shipped 2026-08-07. `main/agentGate.ts`: diffstat → typecheck →
      the repo's own suite → a reviewer agent over the patch, two retries with the failure
      handed back, then stop and say so. It fails CLOSED - a reviewer that timed out or
      answered prose has not passed the lane - and a missing check reads as *skipped*,
      never as a pass.

      All three are covered by `npm run test:agentic`: 66 assertions, ~4s, real child
      processes into real git repositories, no coding CLI needed or startable.

- [x] **I4. The goal queue.** SHIPPED 2026-08-07. `shared/goals.ts` (the arithmetic:
      one-at-a-time, the restart recovery, the outcome string, pruning) and `main/goals.ts`
      (`goals.json` written through a temp file and a rename, the pump, the stamp). Drive it
      queues rather than starts; a goal caught running by a restart is `interrupted` and
      waits for a press; `promptArchive.outcome` is no longer null. `npm run test:goals` —
      48 assertions including two real stub agents driven into real git repositories, where
      the second goal is started by the first one ending. Also fixed while proving it: one
      lane throwing reached `void drive(...)` as an unhandled rejection and killed the whole
      run.
- [ ] **I5. Budget-aware scheduling.** Lanes start on worktree AND token headroom against
      the 5-hour window; cheap phases on cheap models; refuse rather than degrade. **S**
- [ ] **I6. Hotspot ownership.** Worktrees stop two agents editing one file; they do not
      stop two agents both deciding to edit the router. Extend the split plan's file claims
      to a lock across live lanes, and merge those in a deliberate order. **S**
- [ ] **I7. Unattended mode.** Total token budget, max retries, max wall clock, one stop
      switch. Overnight: a goal off the queue, branches with diffs and gate results in the
      morning. **S** once I1–I6 are in, and dangerous before them.

Order: I1 → I2 → I3, then I5 beside I4, then I6, then I7. I3 before I4 deliberately — a
queue of goals that lands unverified work is worse than no queue.

---

## J. The Stash against the tools people already pay for — scanned 2026-08-07

Surveyed: **Maccy** (MIT, Swift, 21.0k), **CopyQ** (GPL-3.0, C++/Qt, 12.1k), **Ditto**
(GPL-3.0, 6.9k, on Windows since 2003), **Paste** ($2.49/mo, $29.99/yr, iCloud sync),
**Raycast** (free tier; retention behind Pro at $8/mo), **PowerToys Advanced Paste** (MIT,
Win+Shift+V), and the paid macOS shelf apps **Dropover / Yoink / Dropzone** — whose one
open-source clone, DropPoint, is discontinued.

**The licence is the first thing, because the ask was to reuse code.** This repo is MIT.
CopyQ and Ditto are GPL-3.0: read them, never paste from them. Maccy is MIT but Swift and
AppKit, so it is a source of *technique*, not of lines. The single drop-in is
`sudhakar3697/node-clipboard-event` (MIT) under J2.

**What none of the six do, and we already do:** click a screenshot and the PNG is written
to disk and its *path* typed at the agent's prompt. Every product above stops at "the image
is now on your clipboard", which is worth nothing to a CLI agent. That stays the headline;
J1–J9 are the ordinary parts we are missing beneath it.

- [x] **J1. Search, and a keyboard-only picker** — S. **Done.** The decision the item asked
      for: the search is in the **main window's** Stash, and the overlay stays mouse-only
      for ever. `focusable: false` is not a setting to work around — on macOS the overlay
      is also an `NSWindowStyleMaskNonactivatingPanel`, so a click on it never activates
      the app at all, and that is the whole feature. Its header gets a magnifier that hands
      the job over (`recents:openSearch` → `focusWindow(true)`, legal because a press is a
      person asking for the app) and the main window opens its Stash with the caret already
      in the box.
      The search itself runs in **main**, not in the renderer, and that is load-bearing:
      `lean()` strips every clip's body out of any list a window is handed, so a filter in
      the window could only ever match a preview's first 140 characters — and the clip
      nobody can find by its opening line is the four-thousand-line log. Measured against a
      real window: a word 200 characters into a 1,430-character clip, absent from the
      preview, is found. Words rather than a phrase; arrows walk the results and wrap;
      Enter sends the highlighted row to the pane.
      **Escape needed a fix a screenshot could not have found.** App.tsx's Escape handler
      is a CAPTURE listener on the window, so it runs before the field ever sees the key: a
      `stopPropagation` in the input was far too late and the probe showed the shelf
      closing with the query still in it. The two-stage Escape (clear, then close) lives in
      App.tsx for that reason.
- [ ] **J2. Stop polling the clipboard** — S. `TICK_MS = 1200` in `recents.ts`, plus a 10s
      image re-read, runs all day whether or not anything was copied, and two copies inside
      one tick collapse into one. Maccy polls at 500ms only because AppKit offers it nothing
      better; Windows has had `AddClipboardFormatListener` since Vista and macOS has
      `NSPasteboard.changeCount`. `node-clipboard-event` (MIT) wraps both and Linux. Keep
      the poll as the fallback for a listener that dies, at a much longer interval.
- [x] **J3. Nothing is excluded, and that is a defect** — S. **Done**, `src/shared/conceal.ts`
      + `npm run test:conceal` (26 assertions, proved red by making `concealedBy` return
      null). A password copied out of 1Password was landing in `history.json` as plaintext
      and sitting there for 200 items. `tick()` now reads the formats *first* — they carry
      the marker, and the answer is needed before a concealed screenshot is decoded, let
      alone written out as a PNG — and honours `org.nspasteboard.Concealed/Transient/AutoGenerated`
      plus the three Windows opt-out formats. A registered `CanIncludeInClipboardHistory`
      is read as a **no** even though Electron cannot show us its DWORD: allowing is the
      default and needs no format at all, so the only reason to register one is to refuse.
      Beside it, `stashDeny` in Settings > Stash: the user's own rules, one per line
      (a line, never a comma — `{2,3}` is a quantifier), blank by default. Deliberately no
      built-in list of secret *shapes*: copying an API key to paste it at an agent is an
      everyday move here and swallowing it would read as broken.
      **Not done, and not the same thing: the per-app deny-list.** Naming the app a clip
      came from means asking the OS for the foreground process on every clipboard change,
      which is the ~600ms call `gameMode.ts` already avoids doing more than once every 15s.
      The marker covers the app that asked to be excluded; a deny-list by bundle id only
      adds the app that did not ask, and it costs a per-tick syscall to get it.
- [ ] **J4. Paste transforms** — M. PowerToys' entire surface: plain text, JSON, Markdown,
      image→text by local OCR, paste as .txt/.png/.html. Three of those earn their place in
      an agent host: paste as plain text; paste a long clip as a **file path** (a 4,000-line
      log belongs in a file the agent reads, not typed into a pty); and OCR on a screenshot
      for the agents that cannot read images at all. The AI half, which PowerToys makes you
      bring an API key for, is Improve and is already built.
- [ ] **J5. Named shelves** — M. CopyQ has tabs, Paste has pinboards; we have one list with
      pins. The version worth having here is per-project: the prompts, ids and paths for
      THIS repo, following the pane's folder. It wants `promptArchive` beside it rather than
      a second store of its own.
- [x] **J6. Edit an item before it is pasted** — S. **Done.** `edit` beside `copy` on any
      text row of the in-window Stash; the body is fetched by id when the button is pressed
      (it is not in the list — same `lean()` rule as above), Ctrl/Cmd+Enter saves, Escape
      throws it away. `editRecent` keeps the row's **position and its pin**, because a path
      that named the wrong branch is the thing you copied corrected, not a new thing you
      copied — and it recomputes the key, so an edit that lands on text already on the
      Stash collapses into one row rather than leaving two that read the same. The OS
      clipboard is deliberately left alone: editing a stash entry is not a copy, and
      quietly replacing what the clipboard holds loses somebody else's work.
      Only in the main window, for the same reason as J1: there is no keyboard in the
      overlay.
- [ ] **J7. The Stash across the device link** — M. Paste charges $2.49/mo for this and
      routes it through iCloud; `src/main/remote/` is already an authenticated, encrypted
      peer link between two machines on the desk. Copy on the laptop, paste on the desktop.
      Text and small files only, capped, off until switched on.
- [ ] **J8. Pick the shelf up where the cursor is** — M. Dropover's shake-to-spawn is the
      one interaction the paid shelf apps are actually sold on; ours is nailed to the
      bottom-left of whichever display the main window is on.
- [ ] **J9. A command on clipboard change** — S. CopyQ's automation, and the same machinery
      as D12; only the trigger is new.

Order: **J3 first** — it is a privacy defect, not a feature — then J2, J1, J6, then J4, J5,
J7, J9, and J8 last.

---

## K. Warp — the terminal that became an agent runner, scanned 2026-08-07

Read off warp.dev and docs.warp.dev. Warp in 2026 is not the "modern terminal" it was
sold as: the front page is an **orchestration-native coding agent**, and the terminal is
the surface it ships on. That is the same bet PaneForge makes, so most of what is over
there is already somewhere on this page and the useful output of the scan is the short
list of things that are **not**.

**What Warp has that this app has no answer to at all: nothing.** That is the honest
finding, and it is worth writing down rather than padding the list. What it has instead is
one idea worth taking whole (K3), one worth taking a cheap tenth of (K1), and a long tail
that is either already here, already on this page under another heading, or a team product
we are not building.

**Where we are ahead, and should stay:** a screenshot clicked here becomes a *path* at an
agent's prompt (nothing in Warp does that); every colour is derived from one accent rather
than a theme file; a pane says which project, checkout and lane it is in (`place.ts`);
panes are real ptys running whichever of thirteen CLIs you like, where Warp's agent is
Warp's agent. Warp is ahead on the editor surface — a real file tree, LSP and a review
panel beside the terminal — which is this page's section A and is already the largest gap.

- [ ] **K1. Walk the scrollback by turn, not by line** — S. Warp's headline terminal idea
      is the **block**: a command and its output as one addressable thing, tinted red on a
      non-zero exit, findable and filterable on its own. It costs Warp a shell integration
      to know where a block starts, and that is exactly what we cannot have — a pane here
      runs an agent's full-screen TUI, which repaints rather than emits, so there are no
      blocks in it to find. But the cheap tenth of it is already sitting here unused: the
      busy detector (`readsBusy`) knows when a turn started and ended, and the prompt rail
      already draws a tag per ask. Bind those boundaries to a key in copy mode, so
      Ctrl+Shift+U then `[`/`]` jumps to the previous or next turn instead of scrolling for
      it. No shell integration, no new state, and it is the thing a block is actually used
      for. Shell panes could have the real version later; agent panes never will.
      **How Warp really does it, read 2026-08-07** (`warp.dev/blog/how-warp-works`,
      `/blog/block-model-behind-warps-agentic-development-environment`): not OSC 133 as
      its own channel. Warp's bootstrap scripts register `preexec`/`precmd` hooks (zsh
      `add-zsh-hook _warp_preexec`/`_warp_precmd`, fish's natives, bash needing a
      bash-preexec shim) and those hooks emit a **DCS carrying encoded JSON** —
      `{"hook":"Preexec","value":{"command":…}}` plus cwd, git state and exit code — which
      its ANSI parser turns into typed hook events. It also reads plain `OSC 133;A` for
      compatibility (issue #6718), but the rich channel is its own. Two findings that
      settle the argument above rather than merely supporting it: **Warp's own block model
      excludes the alternate screen** — `\e[?1049h` switches it to a separate `AltScreen`
      grid with no scrollback, replaced wholesale on exit, and Warp says outright that it
      "doesn't map onto a command and its output". Every agent CLI we host lives there, so
      Warp running our workload has no blocks either. And where the hooks do not fire — a
      complex prompt, anything inside tmux — Warp degrades to **prompt-regex heuristics**,
      which is the thing this app should never ship. Our marks are not a heuristic: they
      are the bytes we relayed, already carrying an xterm `registerMarker` line
      (`Mark` in `TerminalPane.tsx`, `jumpTo` already scrolls to one). So K1 is
      `applyKey` in `shared/copyMode.ts` gaining two keys that move the cursor to the
      nearest mark line either side of it, and nothing else.
- [ ] **K2. Whether the pane's branch has a pull request** — S, and it belongs to **A**,
      not here. Warp's vertical tabs carry the git branch, the worktree and the PR. We
      already say project, checkout and lane (`place.ts`) and the badge already polls
      `git status`; the PR is the one fact missing, and it should arrive with A's git work
      rather than as a second poller. Recorded here only so the scan is complete.
- [ ] **K3. A prompt library — the one Warp idea worth taking whole** — M. Warp Drive holds
      six object types as of 2026-08: workflows (YAML command sequences), notebooks
      (markdown runbooks), environment variables, **prompts**, plans and rules. Four of
      those are wrong for this app —
      a shell-command library is not what an agent host is for, and a shared drive of
      environment variables is the secret-management footgun J3 was just spent avoiding —
      but *prompts* is a real hole. We have two halves of it and neither is the thing: the
      Stash can **pin** a clip, and `promptArchive` knows what has been **asked before**.
      Neither gives you a *named, reusable prompt with a blank in it* — "review the diff on
      `{branch}` for `{concern}`" — that any pane can be handed.
      Build it on what is already there rather than beside it: a pinned Stash entry with a
      name and `{placeholders}`, inserted through `shared/draft.ts` (which is the door
      every ask already goes through, and the reason `promptArchive` sees every agent
      rather than only the two with hooks). Filling the blanks is the same dialog shape as
      Improve. Per-project scoping is J5 and wants the same store, so build the two
      together or the app ends up with two lists of saved text.
      **The shape to copy, read 2026-08-07.** The half of Warp Drive that is open source is
      the workflow YAML (`github.com/warpdotdev/workflows`, `FORMAT.md`), and it is a
      four-field object worth taking as-is: `name`, `command` with `{{arg}}` tokens,
      optional `description`/`tags`, and `arguments[]` of `{ name, description,
      default_value }`. Their **prompts** are a different, newer object and the docs do
      **not** say it takes arguments at all — so the thing we would build is the workflow's
      substitution over the prompt's payload, which is a merge Warp itself has not made.
      Three mechanics to take with it: a filled workflow is **inserted into the input for
      review, never executed** (Ctrl-Shift-R searches, Enter drops it in the block), which
      is exactly `draft.ts`' door and the Improve contract; **Shift-Tab cycles the blanks**,
      and an argument with a preset list opens a suggestion menu rather than a text field;
      and storage is split — Drive proper is cloud/DB-backed (issue #7212 is a standing
      request to make it files), while file-based workflows are read from
      `~/.warp/workflows/*.yaml` **and from `.warp/workflows/` in the repo you are
      standing in**. That last one is J5's per-project scoping for free, and it is the
      right default here: a prompt library that needs an account is not one we would ship.
- [x] **K4. Say what a driven lane is allowed to do** — SHIPPED 2026-08-07. `unattended()`
      in `shared/agentic.ts` reads the posture back out of the arguments `HEADLESS` really
      passes, so nothing on screen can drift from the process: the Fleet board's run head
      carries an `unattended` chip whose tooltip names the flag, the Swarm dialog says it
      in one line above **Drive it** (and never above Launch — a pane is a person
      watching), and `driveUnattended` in Settings refuses the whole thing at both doors,
      `drive:start` and `goal:add`, with a sentence that names the flag it refused. Made
      stricter later, every one of those falls silent rather than keeping the claim.
      `npm run test:unattended` — 35 assertions, and the load-bearing one is that EVERY
      agent in `HEADLESS` has a nameable flag, proved red against an undisclosed new CLI.
      Original note, kept: S, and it is closer to a defect
      than a feature. Warp sells granular agent permissions; ours are a constant. Every
      lane the app drives is started with the permission prompt turned OFF —
      `--permission-mode bypassPermissions` for Claude, `--full-auto` for Codex, `--yolo`
      for Gemini and Qwen (`HEADLESS` in `shared/agentic.ts`) — which is the only way an
      unattended run can work, and nothing on screen says it. The board should say it on
      the card, Settings should be able to refuse to drive an agent whose only unattended
      mode is that, and the goal dialog should say it once before the first run. This is
      not asking for Warp's permission engine: the CLIs own that. It is refusing to keep
      the fact quiet.
      **What Warp's engine actually is, read 2026-08-07** (`docs.warp.dev/agents/autonomy`,
      `/agents/using-agents/agent-profiles-permissions`): a matrix, not a switch — seven
      action categories (apply code diffs, read files, create plans, execute commands,
      interact with a running command, ask clarifying questions, call an MCP server) each
      set to one of *Agent Decides* / *Always Ask* / *Always Allow* / *Never*, plus
      **regex allow and deny lists** for command execution where a deny beats even Always
      Allow. Saved as **Agent Profiles** (the shipped examples are named "Safe & cautious",
      "Prod mode" and "YOLO mode"), switched from an icon in the input area. The part worth
      knowing is what the docs do **not** describe: any indicator of the active mode while
      a run is in flight, or what a fresh install defaults to. So K4 is not catching up
      with Warp — the card that says what this run may do is a thing Warp does not
      document having, and it is one line of text over a fact we already hold in
      `HEADLESS`.

Deliberately **not** taken, with the reason, so the next scan does not re-litigate them:
Warp's cloud agents and the Oz platform (section I is the local version of this, and a
hosted fleet is a business rather than a feature); centralized governance, credit caps and
seat-level usage visibility (a team product — E1 is the one-person version and is the part
that pays); model routing across providers (the CLIs already route, and a second router
would only disagree with them); command corrections, autosuggestions and tab completions
(a pty host does not own the input line); codebase indexing (the agents do their own);
session sharing by link (section B); and Warp's theme system, which is a file of colours
where ours derives every one of them from a single accent.

---

## Order to build in

1. ~~**D2, D4, D5**~~ — shipped in v0.4.0: find in a pane, zoom one pane, five layouts.
   ~~**D6, D7, D15**~~ — shipped in v0.4.11: keyboard pane swap, synchronised typing, and
   the turn clock on the pane border. D11 turned out to be built already.
   ~~**D10, D8, D3**~~ — shipped in v0.4.13: tee a pane's output to a file, the silence
   and bell alerts, and keyboard copy mode. That is the whole of the cheap half; what is
   left under D is the architectural end of it (D1 detach, D9 CLI, D12 hooks).
2. **E1, E2, E7** — the usage/cost readout, the MCP health panel and task↔pane. All three
   are small-to-medium, none needs an architectural change, and E1 is the item on this page
   that pays Robert back fastest: token spend is the thing he measures and the one number
   the app cannot currently show him.
3. **A1 (built with E4), A2, A3, A4** — diff + inline comment + commit + PR. The one gap a
   user switching from T3 Code or Vibe Kanban would name first, and the README already
   admits it.
4. **C3, E3, C5, C8, C1** — permission modes then saved launch recipes (E3 needs C3's mode
   to be worth saving), project scripts, resource readout, rebindable keys.
5. **B1** — headless host. Unblocks B2, B7, D1 and C10, and is the single largest
   architectural step here.
6. **B2, D1, then H1–H3** — browser client and true detach. This is the point where
   PaneForge does the thing T3 Code ships four codebases to do, with one renderer. B2 is
   only half the phone: H1 (two notification classes), H2 (diff first) and H3 (fleet view)
   are what make the served renderer worth opening on one. B3 and B4 belong here too — a QR
   and a tailnet are how it is reached at all.
7. **D9, D12, C7 (with E5), B4, B5** — CLI, hooks, preview + inspector, tailnet, Linux.
8. **E6** — turn-level checkpoints. Last because it is the one item whose honesty depends on
   what the agent touched, and B1 changes where a pty's state lives.
9. **B6** — package managers, whenever signing is paid for.

~~**G2 belongs at step 2, ahead of everything else in G.**~~ Shipped 2026-08-07 (`npm run
test:scrollback`), and it turned out an S rather than an M. G1 belongs with step 6 — it
needs nothing new, but its value is the comparison surface, and that is a real UI. G3 is
step 7, where C7 and E5 already are; it is the reason to build them rather than a separate
job.

**J and K are both mostly closed, and what is left of them slots in rather than queueing.**
J3, J1 and J6 shipped 2026-08-07 (the concealed clipboard, search, editing an entry), and
so did ~~**K4**~~ later the same day — the app no longer keeps quiet about what it lets an
unattended agent do, which is why it went first: it was nearer a defect than a feature. **K3
with J5** is the next real feature under either heading and belongs at step 4, beside the
saved launch recipes it is the prompt-shaped half of. J2, J4, J7–J9 and K1 are step 7
material: none of them is wrong, none of them is what somebody notices missing. **K2 is
not a separate job at all** — it arrives with A's git work or not at all.

**F sits across this order rather than at the end of it.** F1 and F3 are small and pay for
themselves the first time two lanes touch one file, so they belong beside step 2. F5 belongs
wherever E1 lands — both are "the app finally shows you what its agents actually did", and
they read the same transcripts. F2 waits for a reason: it is the item that can type into a
terminal, so it goes in after the budget and the idle check exist, never beside them. F4 is
genuinely last under F and is the only L on the page whose value is zero until the three
before it are in.
