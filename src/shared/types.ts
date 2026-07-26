// Types shared by the Electron main process and the React renderer.
// Keep this file dependency-free: it is imported from both sides of the IPC bridge.

import type { AgentInfo, AgentSpec } from './agents'

export type SessionStatus =
  | 'starting'   // pty spawned, no output yet
  | 'working'    // output arrived in the last few seconds
  | 'idle'       // quiet, assume it is waiting for you
  | 'exited'     // process ended

/**
 * Which CLI a session runs. Free-form on purpose: the catalogue lives in
 * `agents.ts` and the user can add their own, so a union type here would have to
 * be edited for every new agent.
 */
export type Agent = string

export interface Project {
  name: string
  path: string
  /** epoch ms of the newest Claude Code transcript for this path, 0 if never used */
  lastUsed: number
  isGit: boolean
}

export interface Session {
  id: string
  title: string
  cwd: string
  agent: Agent
  /** model passed to the agent, empty/undefined = the CLI's own default */
  model?: string
  status: SessionStatus
  /** epoch ms of the most recent pty output */
  lastOutput: number
  createdAt: number
  exitCode?: number
  /** went quiet while you were looking elsewhere - cleared when you open the pane */
  attention?: boolean
  /**
   * Something has been asked of this session (a queued prompt, or you typed into
   * it). A freshly launched CLI that has only drawn its own banner is quiet but
   * has finished nothing, so it must not raise attention or chime.
   */
  engaged?: boolean
  /** swarm role label ("Planner"), shown on the pane header when set */
  role?: string
  /**
   * Epoch ms the current turn started, undefined whenever the agent is not working.
   * "How long has this run been going" is the number worth watching; time since the
   * pane was opened kept counting through days of idling and told you nothing.
   */
  runSince?: number
  /** How long the last finished turn took (ms), shown frozen once it ends. */
  lastRunMs?: number
  /** worktree lane suffix ("w2") when this session runs in an auto-created lane */
  lane?: string
  /**
   * What was decided about sharing the folder, when it is worth saying out loud -
   * a lane that was created, or a clash that could not be split (not a repo).
   */
  laneNote?: string
}

export interface StartSessionRequest {
  cwd: string
  title?: string
  agent?: Agent
  model?: string
  /** resume the most recent session in that directory (`claude --continue`) */
  resume?: boolean
  /** text typed into the agent once it is ready */
  prompt?: string
  /** extra ms before the prompt is typed, used to stagger a swarm launch */
  promptDelay?: number
  /** swarm role label, carried onto the session for the pane header */
  role?: string
  /** filled in by the main process when the launch was moved into a worktree lane */
  lane?: string
  /** one-line explanation of the lane decision, shown as a toast after launch */
  laneNote?: string
}

/** One saved project inside a workspace. */
export interface PresetItem {
  path: string
  title: string
  agent: Agent
  model?: string
  resume?: boolean
}

/** A named set of projects launched together - the replacement for the old .bat list. */
export interface Preset {
  id: string
  name: string
  items: PresetItem[]
}

/** Repo state of a session's folder, null when the folder is not a git checkout. */
export interface GitInfo {
  branch: string
  ahead: number
  behind: number
  /** changed paths, staged or not, untracked included */
  dirty: number
  staged: number
  detached: boolean
}

/**
 * One PaneForge development lane (scripts/lane.mjs), as shown in the sidebar strip.
 * Only present on a machine that has a PaneForge checkout - see main/laneBoard.ts.
 */
export interface LaneBoardEntry {
  /** "main", "a", "b", ... */
  lane: string
  dir: string
  branch: string
  /** folder the chat holding this lane started in, when it said */
  from: string | null
  /** a live chat holds it right now */
  held: boolean
  /** epoch ms the holding chat was last seen doing something */
  seen: number
  /** marked shippable, waiting for the batched release */
  ready: boolean
  /** finished work that will not merge into master: left out of every release until fixed */
  conflicted: boolean
  conflictSince?: number
  /** the files that disagree, as lane.mjs recorded them */
  conflictDetail?: string
  /** the conflict's own chat has gone quiet, so any chat may take it over */
  adoptable: boolean
  /** chat that took the conflict over, when one has */
  resolver: string | null
}

export interface LaneBoard {
  repo: string
  lanes: LaneBoardEntry[]
  /** epoch ms a release started, when one is running */
  releasing: number | null
  lastShip: { version: string; at: number; lanes: string[] } | null
}

export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

// ---------------------------------------------------------------------------
// Elevation

/** What the app knows about running with admin rights on this machine. */
export interface AdminStatus {
  /** false on macOS/Linux, where the scheduled-task trick does not exist */
  supported: boolean
  /** this process is elevated right now */
  elevated: boolean
  /** the no-prompt launch task is registered for this user */
  taskInstalled: boolean
  /** exe the task points at, used to spot a task left over from an older build */
  taskTarget: string
  /** where the app currently runs from */
  exePath: string
}

// ---------------------------------------------------------------------------
// Agent install

/** Streamed output of a one-click agent install. */
export interface InstallEvent {
  agentId: string
  /** raw terminal output chunk */
  chunk?: string
  /** set on the last event */
  done?: boolean
  /** true when the binary was found on PATH afterwards */
  ok?: boolean
}

// ---------------------------------------------------------------------------
// Updates

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'none'
  | 'error'
  | 'unsupported'

export interface UpdateState {
  phase: UpdatePhase
  /** version running right now */
  current: string
  /** version on the server, when one is newer */
  version?: string
  /** 0-100 while downloading */
  percent?: number
  notes?: string
  error?: string
  /** release page to open by hand, used where in-place update is not possible */
  url?: string
}

// ---------------------------------------------------------------------------
// Task board + shared memory (per project folder, committed or gitignored by you)

export type TaskStatus = 'todo' | 'doing' | 'done'

export interface TaskItem {
  id: string
  title: string
  notes?: string
  status: TaskStatus
  /** agent id this task is meant for, purely a hint */
  agent?: Agent
  createdAt: number
  updatedAt: number
}

/** Everything PaneForge stores inside one project's `.paneforge` folder. */
export interface ProjectBoard {
  path: string
  tasks: TaskItem[]
  /** free-form notes every pane in this project can read (AGENTS-style memory) */
  memory: string
  /** absolute path of the memory file, so a prompt can point an agent at it */
  memoryPath: string
}

// ---------------------------------------------------------------------------
// Swarm

/** One pane in a swarm launch. */
export interface SwarmRole {
  id: string
  name: string
  agent: Agent
  model?: string
  /** appended after the mission text when the pane starts */
  brief: string
  enabled: boolean
}

export interface SwarmRequest {
  cwd: string
  mission: string
  roles: SwarmRole[]
}

// ---------------------------------------------------------------------------
// History

/** A finished or running session's transcript on disk. */
export interface HistoryEntry {
  id: string
  title: string
  cwd: string
  agent: Agent
  model?: string
  startedAt: number
  endedAt?: number
  bytes: number
}

export interface HistoryHit {
  id: string
  title: string
  cwd: string
  agent: Agent
  startedAt: number
  /** matching line, already stripped of terminal escapes */
  line: string
}

// ---------------------------------------------------------------------------

export interface VoiceConfig {
  enabled: boolean
  /** whisper model name passed to the local transcriber */
  model: string
  /** ISO language code, 'auto' to let the model decide */
  language: string
}

export interface VoiceStatus {
  /** a local transcriber was found on PATH */
  available: boolean
  /** which binary is used (whisper-cli, whisper, faster-whisper, ...) */
  engine: string
  path: string
  /** command that installs one, for the one-click button */
  install: string
}

export interface Config {
  /** folder scanned for projects */
  root: string
  presets: Preset[]
  defaultAgent: Agent
  /** model per agent id, remembered from the last launch ('' = the CLI's default) */
  defaultModels: Record<string, string>
  /** extra CLIs the user wired up in Settings, merged over the built-in catalogue */
  customAgents: AgentSpec[]
  /** terminal font size, shared by every pane */
  fontSize: number
  /** a mouse selection in a pane goes straight to the clipboard */
  copyOnSelect: boolean
  /**
   * Drag-select text even while the agent has mouse reporting on. Claude Code and
   * Codex both grab the mouse, which is what makes a plain drag select nothing.
   * Selection only: the wheel scrolls the pane's own scrollback regardless.
   */
  mouseSelect: boolean
  /** repaint a pane by itself when its size settles, so a resize cannot leave it garbled */
  autoFixUi: boolean
  /** OS notification + taskbar flash when a session goes quiet in the background */
  notifyOnIdle: boolean
  /** soft chime when a session finishes its turn or asks you something */
  soundOnIdle: boolean
  /**
   * Keep the last things you copied on a shelf in the corner, so a screenshot or a
   * block of text is one click from the focused pane. Off stops the clipboard being
   * watched at all.
   */
  clipboardShelf: boolean
  /** show every session at once instead of one at a time */
  grid: boolean
  /** ask before closing a session that is still running */
  confirmClose: boolean
  launchAtLogin: boolean
  /** launch elevated with no UAC prompt via the registered scheduled task */
  adminMode: boolean
  /** check GitHub releases in the background and offer the update */
  autoUpdate: boolean
  /**
   * Reopen the panes an update closed. Off means a restart is a clean desk, which
   * is the only way to get rid of a set of panes that otherwise comes back every
   * time the app updates itself.
   */
  restoreAfterUpdate: boolean
  /**
   * What a cold launch does with the panes the last run left behind (a normal quit,
   * a PC restart, a crash). `ask` offers them, `always` reopens them silently,
   * `never` starts clean. An update restart is not this setting - see
   * `restoreAfterUpdate` - because that restart was the app's own idea.
   */
  restoreAfterRestart: RestoreMode
  /** keep a searchable transcript of every pane */
  saveHistory: boolean
  /** delete stored transcripts older than this; 0 keeps everything */
  historyDays: number
  voice: VoiceConfig
  /**
   * Put a second session in the same git repo into its own worktree lane, so two
   * agents can work at once without overwriting each other. Off means both share
   * the folder, which is only safe when one of them is read-only.
   */
  autoLane: boolean
  /** roles offered in the swarm dialog, editable by the user */
  swarmRoles: SwarmRole[]
  /**
   * Panes to reopen on next launch, written just before an update restart.
   *
   * Superseded by userData/desk.json and only still read on the first launch after
   * updating from a version that wrote it here - which is exactly the launch that
   * would otherwise lose the panes the old code had just saved.
   */
  restoreSessions?: StartSessionRequest[]
  window: WindowBounds
}

/** @see Config.restoreAfterRestart */
export type RestoreMode = 'ask' | 'always' | 'never'

/** One pane from the last run, as offered back on the next launch. */
export interface RestorePane {
  /** position in the saved desk; what an answer refers to */
  id: string
  cwd: string
  title: string
  agent: Agent
  model?: string
  /** why this one cannot be reopened: shown greyed and never started */
  gone?: 'folder' | 'agent'
}

/** The "restore your last session?" question, as the renderer receives it. */
export interface RestoreOffer {
  panes: RestorePane[]
  /** panes past the launch cap: listed as not restored rather than silently dropped */
  extra: RestorePane[]
  /** when the desk was written */
  at: number
  /** false means the last run ended in a crash or a power cut */
  clean: boolean
}

export interface RestoreAnswer {
  accept: boolean
  /** ids of the panes to reopen, in offer order */
  ids: string[]
  /** the user ticked "always restore after a restart" */
  always?: boolean
}

/**
 * One thing you copied: text, or an image saved to a PNG we own.
 * `key` is what makes copying the same thing twice one entry instead of two.
 */
export interface RecentItem {
  id: string
  key: string
  kind: 'text' | 'image'
  /** epoch ms it landed on the shelf */
  at: number
  /** full text, text items only */
  text?: string
  /** the saved PNG, image items only - this is what gets typed into a pane */
  path?: string
  /** small data URL for the tile, image items only */
  thumb?: string
  /** one-line label for the row */
  preview: string
  lines?: number
  chars?: number
  width?: number
  height?: number
}

/** Shape exposed on window.api by the preload script. */
export interface Api {
  listProjects(): Promise<Project[]>
  /** every known agent with whether its binary is actually on this machine */
  listAgents(): Promise<AgentInfo[]>
  listSessions(): Promise<Session[]>
  startSession(req: StartSessionRequest): Promise<Session>
  startSessions(reqs: StartSessionRequest[]): Promise<Session[]>
  /** respawn the agent in place, keeping the pane and its id */
  restartSession(id: string): Promise<Session | null>
  /** swap a running pane to another CLI/model - same folder, same pane, fresh process */
  switchAgent(id: string, agent: Agent, model?: string): Promise<Session | null>
  renameSession(id: string, title: string): Promise<void>
  killSession(id: string): Promise<void>
  write(id: string, data: string): void
  /** send the same line to every live session */
  broadcast(text: string): void
  resize(id: string, cols: number, rows: number): void
  /** poke the pty size so a full-screen CLI redraws itself from scratch */
  redraw(id: string): void
  /**
   * The pane telling main whether the agent still looks busy on screen. Only the
   * renderer can see the rendered frame, and "still working" must not chime.
   */
  /** `tail` is the frame that decided a `false`, kept for the attention audit log. */
  setBusy(id: string, busy: boolean, tail?: string): void
  /** replay of everything the pty printed so far, for re-attaching a pane */
  getBuffer(id: string): Promise<string>
  clearAttention(id: string): void

  getConfig(): Promise<Config>
  setConfig(patch: Partial<Config>): Promise<Config>
  pickRoot(): Promise<string | null>

  reveal(path: string): void
  openInEditor(path: string): Promise<string | null>
  openExternal(url: string): void
  /** write to the OS clipboard (renderer has no navigator.clipboard under file://) */
  copyText(text: string): void
  readClipboard(): Promise<string>
  /** branch + dirty count for a folder; null when it is not a repo */
  gitInfo(path: string): Promise<GitInfo | null>
  /** PaneForge's own dev lanes, or null on a machine without a PaneForge checkout */
  laneBoard(): Promise<LaneBoard | null>
  /**
   * Absolute path of a dropped File. Electron removed File.path, so the real path
   * only comes from webUtils in the preload.
   */
  pathForFile(file: File): string

  /** elevation state plus the no-UAC launch task */
  adminStatus(): Promise<AdminStatus>
  /** register (or refresh) the scheduled task that starts PaneForge elevated */
  adminEnable(): Promise<{ ok: boolean; message: string }>
  adminDisable(): Promise<{ ok: boolean; message: string }>
  relaunchAsAdmin(): void

  /** run an agent's install command, streaming output back via onInstall */
  installAgent(id: string): Promise<void>
  /** file picker that wires an existing binary up as an agent override */
  locateAgent(id: string): Promise<string | null>

  /** named profile this window runs under ('' = the normal installed app) */
  profile(): Promise<string>
  updateState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  installUpdate(): void

  /**
   * The panes the last run left behind, when the launch decided to ask about them.
   * Pulled by the renderer on mount rather than pushed on launch: the window is
   * still loading when main makes that decision.
   */
  pendingRestore(): Promise<RestoreOffer | null>
  answerRestore(answer: RestoreAnswer): void

  /** tasks + shared memory for one project folder */
  board(path: string): Promise<ProjectBoard>
  saveTasks(path: string, tasks: TaskItem[]): Promise<ProjectBoard>
  saveMemory(path: string, memory: string): Promise<ProjectBoard>

  startSwarm(req: SwarmRequest): Promise<Session[]>

  listHistory(): Promise<HistoryEntry[]>
  searchHistory(query: string): Promise<HistoryHit[]>
  readHistory(id: string): Promise<string>
  deleteHistory(id: string): Promise<void>

  /** the clipboard shelf, newest first */
  listRecents(): Promise<RecentItem[]>
  /** put a shelf item back on the OS clipboard */
  copyRecent(id: string): void
  /** hand an image item to the OS drag layer, so it can be dropped in any app */
  dragRecent(id: string): void
  clearRecents(): void

  voiceStatus(): Promise<VoiceStatus>
  /** wav bytes in, text out; runs a local whisper, nothing leaves the machine */
  transcribe(wav: ArrayBuffer): Promise<{ text: string; error?: string }>
  installVoice(): Promise<void>

  onData(cb: (id: string, data: string) => void): () => void
  onSessions(cb: (sessions: Session[]) => void): () => void
  onConfig(cb: (config: Config) => void): () => void
  onInstall(cb: (e: InstallEvent) => void): () => void
  onUpdate(cb: (s: UpdateState) => void): () => void
  /** a session just went quiet after doing something - drives the chime */
  onAttention(cb: (s: Session) => void): () => void
  /** global push-to-talk hotkey fired from the main process */
  onVoiceHotkey(cb: () => void): () => void
  /** something new landed on the clipboard shelf */
  onRecents(cb: (items: RecentItem[]) => void): () => void
  /**
   * A main-process error, which used to be a modal message box that stole the keyboard.
   * Shown as a line in the footer instead; the detail is in paneforge-errors.log.
   */
  onAppError(cb: (message: string) => void): () => void
}
