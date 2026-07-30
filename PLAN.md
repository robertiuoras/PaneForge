# Claude Orchestrator — Build Plan

A desktop app that launches and manages multiple Claude Code agents in one
window, each isolated in its own git worktree, with a task board and live
status. A self-hosted, free alternative to BridgeMind / BridgeSpace, scoped to
one solo founder's workflow (not an enterprise swarm product).

Working name: **PaneForge** (rename freely).
Target user: you. Windows 11 first, Mac/Linux "should work" but not a priority.

---

## 1. Goal & non-goals

**Goals**
- Replace `start-claude-panes.bat` with a real app.
- Run N Claude Code agents at once, each on its own branch/worktree of a repo, so they don't stomp each other's files.
- See every agent's live terminal, status (running / waiting / idle / done), and diff in one window.
- Spawn an agent from a task card; review and merge its branch when done.

**Non-goals (deliberately skipped to stay shippable)**
- Enterprise multi-tenant / team features.
- Cloud hosting — this is a local desktop app.
- Matching BridgeSwarm's full file-ownership lock system on day one (revisit in M4 if ever needed).
- Supporting every agent CLI. Claude Code first; design the spawn layer so Codex/Cursor/etc. can slot in later, but don't build for them now.

---

## 2. The core insight

Claude Code is **a terminal program**. The whole app is a GUI that:

1. **Spawns** `claude` inside a pseudo-terminal (PTY) — one process per agent.
2. **Renders** that PTY's output in a terminal widget, and forwards keystrokes back.
3. **Isolates** each agent in its own `git worktree` (separate branch + working copy).
4. **Orchestrates** on top: task board, status detection, diff/merge.

Steps 1–3 are solved by off-the-shelf libraries. Step 4 is the only real product work. Everything BridgeMind sells is step 4 sitting on top of steps 1–3.

---

## 3. Stack decision

| Layer | Choice | Why |
|---|---|---|
| Shell | **Electron** | Mature, best `node-pty` + `xterm.js` support, every reference app (Crystal) uses it. Tauri is lighter but PTY story on Windows is rougher — not worth the risk for v1. |
| UI | **React + TypeScript + Vite** | Familiar, fast iteration. |
| Terminal render | **xterm.js** (+ `@xterm/addon-fit`, `@xterm/addon-serialize`) | The standard. Serialize addon lets you persist/restore scrollback. |
| PTY | **node-pty** | Spawns `claude` with a real PTY so colors, prompts, resize, and interactive input all work. The single most important dependency. |
| Git | **simple-git** + raw `git worktree` CLI | Worktree add/remove/list, branch, diff, merge. |
| State / store | **zustand** (in renderer) + a small JSON/SQLite file on disk | App is local; no server. SQLite (`better-sqlite3`) if you want history/durability, JSON if you want dead-simple. |
| IPC | Electron `ipcMain`/`ipcRenderer` | Main process owns PTYs + git; renderer is pure UI. |

**Process model (important):** PTYs and git operations live in the **main process** (Node, full OS access). The renderer (UI) talks to them over IPC. Never spawn PTYs in the renderer — it can't be sandboxed and will leak.

---

## 4. Architecture

```
┌──────────────────────── Electron main process (Node) ─────────────────────┐
│                                                                            │
│  AgentManager        WorktreeManager        TaskStore (SQLite/JSON)        │
│   - spawn(claude)     - add/remove wt         - tasks, agents, status      │
│   - write(input)      - list/diff/merge                                    │
│   - onData(output) ──┐                                                     │
│   - kill()           │                                                     │
│        │             │                                                     │
│        │   node-pty  │  simple-git / git CLI                               │
│        ▼             ▼                                                      │
│   [claude PTY #1] [claude PTY #2] ... [claude PTY #N]                       │
└───────────────▲────────────────────────────────────────────────▲──────────┘
                │ IPC: pty-data / pty-input / status / git ops     │
┌───────────────┴──────────────── Renderer (React) ───────────────┴──────────┐
│                                                                            │
│  Sidebar: task board (kanban)     Main: grid of <Terminal/> panes          │
│  - card → "Start agent"           - xterm.js per agent                      │
│  - agent status dots              - tab/focus, diff view, merge button      │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Data model (minimal)

```ts
type Repo = { id: string; path: string; name: string; defaultBranch: string };

type Agent = {
  id: string;
  repoId: string;
  branch: string;            // e.g. agent/fix-login-modal
  worktreePath: string;      // <repo>/.worktrees/<branch> or sibling dir
  pid?: number;
  status: "starting" | "running" | "waiting_input" | "idle" | "done" | "error" | "exited";
  taskId?: string;
  createdAt: number;
};

type Task = {
  id: string;
  repoId: string;
  title: string;
  prompt: string;            // initial instruction piped to claude
  column: "todo" | "in_progress" | "review" | "done";
  agentId?: string;
};
```

State persists to disk so a crash/restart can offer to reattach (you can't truly reattach a dead PTY, but you can reopen the worktree + show the branch + restart the agent).

---

## 6. Repo structure

```
claude-orchestrator/
  package.json
  electron/
    main.ts              # app bootstrap, window, IPC registration
    agentManager.ts      # node-pty spawn/write/kill, status detection
    worktreeManager.ts   # git worktree add/remove/list/diff/merge
    taskStore.ts         # SQLite/JSON persistence
    ipc.ts               # channel definitions (typed)
  src/                   # renderer (React)
    App.tsx
    components/
      TerminalPane.tsx   # xterm.js bound to one agent
      AgentGrid.tsx      # layout of panes
      TaskBoard.tsx      # kanban sidebar
      DiffView.tsx       # per-agent git diff
      StatusDot.tsx
    store.ts             # zustand
  shared/
    types.ts             # Agent/Task/Repo, IPC payloads (shared main+renderer)
  PLAN.md
```

---

## 7. The four hard problems & chosen approach

### 7.1 Worktree lifecycle
Each agent gets `git worktree add <path> -b agent/<slug>` off the repo's default branch. On finish/merge: `git worktree remove` + delete branch (after merge). Keep all worktrees under a single `.worktrees/` dir (gitignored) so cleanup is easy and the repo root stays clean.
- Gotcha: a worktree with uncommitted changes blocks removal — force only after the user confirms (don't silently discard an agent's work).

### 7.2 Agent status detection
You can't ask Claude Code "are you idle?" directly. Heuristics, in order of reliability:
1. **Process alive?** PTY exit → `exited`/`done`.
2. **Output quiet for N seconds** after activity → likely `idle`/`waiting`.
3. **Prompt-pattern match** on the terminal tail (the input box / "esc to interrupt" line) → `running` vs `waiting_input`.
This is exactly where Crystal/Conductor are imperfect — accept "good enough" and let the user glance at the pane. Don't over-engineer.

### 7.3 Merge / conflict handling
Worktrees stop two agents editing the *same file in the same working copy*, but you still merge N branches into main at the end. Approach for v1:
- Per-agent **"Review" step**: show the branch diff, let you merge or discard.
- Merge sequentially into main; on conflict, surface it and either open that worktree for a Claude to resolve, or punt to you.
- **Skip** BridgeSwarm-style file-ownership locks for now — they only pay off when many agents hammer one repo simultaneously, which a solo founder rarely does. Revisit in M4.

### 7.4 Windows PTY reliability
node-pty on Windows uses ConPTY — mostly fine on Win 11, but:
- Test resize, Ctrl-C, and ANSI colors **early** (M0), not after building UI.
- `claude` must be on PATH for the spawned shell; spawn via `cmd /k` or directly resolve the `claude` binary.
- If you elevated the launcher (your admin .bat), spawned agents inherit admin — same blast-radius tradeoff applies here.

---

## 8. Milestones

| Milestone | Deliverable | Rough effort |
|---|---|---|
| **M0 — Spike** | Electron window, one xterm.js pane, one `claude` spawned via node-pty, input+output working on Windows. Prove the stack. | 1–2 days |
| **M1 — Grid MVP** | N panes in a grid, each a separate `claude`, each in its own git worktree of one repo. Add/close agent. Replaces the .bat. | 3–5 days |
| **M2 — Status + diff** | Status dots (running/idle/done via §7.2), per-agent diff view, focus/tab management, scrollback persistence. | 1 wk |
| **M3 — Task board** | Kanban sidebar; card → spawns agent on a branch with the card's prompt piped in; drag card across columns; merge button (sequential merge + conflict surfacing). | 1–2 wk |
| **M4 — Polish / optional** | Session persistence & reattach-on-restart, multi-repo, MCP awareness, scheduling, file-ownership locks if actually needed. | ongoing |

M0+M1 = you've already beaten the .bat (worktrees within one project). M3 = you've matched the useful 80% of BridgeSpace. M4 is the long tail you mostly won't need.

---

## 9. Build-vs-fork decision gate (do this before M0)

Spend 30–60 min with **Crystal** (free, OSS, Electron — this exact architecture):
- If it does ~80% of what you want → **fork/extend it**, skip M0–M2 entirely, jump to customizing the task board. Massive head start.
- If it's close-but-wrong in a structural way → build fresh from this plan, stealing their dependency choices.
- Also glance at **Conductor** (free, Mac — worktree UX reference) and **Claude Code Agent Teams** (native, already in your CLI — may cover the multi-agent-in-one-repo case with zero app).

Decision rule: don't write a line of M0 until you've confirmed Crystal can't be bent to fit. Forking a working Electron+xterm+pty app saves you the riskiest week.

---

## 10. Concrete first session (when you greenlight code)

1. `npm create vite@latest` (react-ts) + add Electron (electron-vite template is cleanest).
2. Add `node-pty`, `@xterm/xterm`, `@xterm/addon-fit`.
3. Main process: `spawnAgent(repoPath)` → `pty.spawn("claude", [], {cwd, cols, rows})`, forward `onData` over IPC.
4. Renderer: one `<TerminalPane>` wiring xterm ↔ IPC.
5. Type "hello" into Claude, see it respond. **That's M0** — the whole rest is iteration on a proven core.

---

## 11. Reality check

- **Foundation (M0–M1): genuinely a few days.** Low risk, proven libraries.
- **The product (M3 task board + merge UX): the real work**, and it's mostly judgment/UX, not hard tech.
- You do **not** need to match BridgeMind feature-for-feature. Build the slice you'll use daily; their swarm/enterprise layer is the part you can skip.
- Biggest risk: scope creep into M4 before M1 is solid. Ship the grid-MVP, use it for a week, let real annoyance drive what M2+ becomes.
