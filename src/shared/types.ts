// Types shared by the Electron main process and the React renderer.
// Keep this file dependency-free: it is imported from both sides of the IPC bridge.

import type { AgentInfo, AgentSpec } from './agents'
import type { DiscordStyle, PresenceStatus } from './discordRpc'
import type { Improvement } from './promptSchema'
import type { ImproveMetrics } from './promptBudget'
import type { RevealTarget } from './pathToken'
import type { RouteMatch, RouteResult } from './projectRoute'
import type { CustomSound, SoundConfig } from './sounds'
import type { ThemeConfig } from './theme'

export type { CustomSound, DiscordStyle, RevealTarget, RouteMatch, RouteResult, SoundConfig, ThemeConfig }

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

/**
 * The turn clock read straight off the agent's own footer: how long IT says the turn
 * has been running, and how coarsely it printed that (`24m 3s` is second-accurate,
 * `24m` says nothing about the seconds). Defined next to the reader that produces it.
 */
import type { TurnClock } from './busy'
export type { TurnClock }

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
  /**
   * The pty's size on the machine that owns it. Only used by a mirror, which draws
   * itself at exactly these dimensions instead of fitting its own window - two
   * devices cannot both decide how wide one terminal is.
   */
  cols?: number
  rows?: number
  /**
   * This pane's agent runs on another machine and is mirrored here. The id is
   * namespaced with the device, so nothing else in the app has to care: keystrokes,
   * resizes and closes are routed back over the link by the main process.
   */
  remote?: {
    /** device id, matching a RemotePeer */
    device: string
    /** what that device calls itself, for the pane badge */
    name: string
  }
  /** This pane's output is being teed to a file as it runs. See `main/pipe.ts`. */
  piping?: PipeInfo
  /**
   * The turn is still running and the pane has printed nothing since this moment -
   * long enough that something is wrong. Undefined the instant it speaks again.
   */
  stalledSince?: number
  /** The terminal rang its bell and nobody has looked at the pane since. */
  bell?: boolean
}

/**
 * A live tee of one pane's output. Rides on the session list rather than an event of
 * its own: the byte counter has to move on screen, and the sessions broadcast is
 * already the thing that redraws a pane header.
 */
export interface PipeInfo {
  path: string
  /** escape sequences stripped on the way out, for a file something will READ */
  text: boolean
  startedAt: number
  bytes: number
  /** bytes thrown away because the consumer could not keep up - normally 0 */
  dropped: number
}

export interface StartSessionRequest {
  cwd: string
  title?: string
  agent?: Agent
  model?: string
  /** resume the most recent session in that directory (`claude --continue`) */
  resume?: boolean
  /**
   * Resume THIS conversation rather than whichever is newest in the folder. Written into
   * the desk when the pane's own transcript could be named, and dropped again if that
   * transcript is gone by the time the panes are offered back.
   */
  resumeId?: string
  /** text typed into the agent once it is ready */
  prompt?: string
  /** extra ms before the prompt is typed, used to stagger a swarm launch */
  promptDelay?: number
  /** swarm role label, carried onto the session for the pane header */
  role?: string
  /**
   * The pane this one is coming back as. Written into the desk so a restart can replay
   * what was on screen: the transcript is stored under the OLD session's id, and a
   * restored pane is issued a new one. Only the desk sets it.
   */
  scrollbackId?: string
  /** filled in by the main process when the launch was moved into a worktree lane */
  lane?: string
  /** one-line explanation of the lane decision, shown as a toast after launch */
  laneNote?: string
  /**
   * Environment added on top of the inherited one, so a lane's dev server does not
   * fight the original folder's for a port. Set by the main process only.
   */
  laneEnv?: Record<string, string>
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
 * Which changes to show.
 *
 * `working` is what is not committed yet - the answer to "what has this agent done since
 * the last commit". `branch` is every commit this branch has that its base does not - the
 * answer to "what is this whole piece of work". `all` is both at once, which is the one a
 * lane wants: with four agents running, the question is "what has this one done to my
 * repo", and whether it happened to commit halfway through is not part of it.
 */
export type DiffScope = 'working' | 'branch' | 'all'

/** One changed path in a DiffSet. */
export interface DiffFile {
  path: string
  /** where it came from, when git called it a rename */
  oldPath: string | null
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  added: number
  removed: number
  /** git would not diff it as text, so there are no counts and no patch */
  binary: boolean
  /** not in the index at all - the counts are the whole file */
  untracked: boolean
}

export interface DiffSet {
  scope: DiffScope
  /** the branch this was compared against, null when the scope does not need one */
  base: string | null
  /** the branch the folder is on */
  branch: string
  files: DiffFile[]
  /** more files changed than the list was allowed to carry */
  truncated: boolean
  /**
   * Why there is nothing to show, when there is nothing to show. Null means the answer is
   * simply "no changes" - a real, useful answer, and a different one from "this scope
   * could not be worked out".
   */
  problem: string | null
}

/** One file's patch, read on demand: a diff set of 300 files is 300 of these unasked. */
export interface DiffPatch {
  path: string
  text: string
  /** git's output was longer than the cap and was cut */
  truncated: boolean
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
  /**
   * The chat holding it, as lane.mjs recorded it (a Claude session id). Several lanes are
   * routinely held from the SAME folder by different chats, so the folder cannot say who
   * has one - this can.
   */
  session: string | null
  /**
   * The pane that chat is running in, when one of this window's panes is it. Null means
   * nothing on this screen is that chat: it ended without saying so, or it runs elsewhere.
   */
  ownerPane: string | null
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

/**
 * What is inside one worktree lane (`<repo>-w2`), read without touching either working
 * tree - see main/laneWork.ts. This is a lane of the user's own project, not one of
 * PaneForge's development lanes above.
 */
export interface LaneWork {
  /** lane label, "w2" */
  lane: string
  dir: string
  /** the main checkout it branched from */
  repo: string
  branch: string
  /** branch the main checkout is on - what "merge back" means */
  base: string
  /** commits in the lane the base branch does not have */
  ahead: number
  /** uncommitted files in the lane */
  dirty: number
  /** files that would conflict if it were merged right now */
  conflicts: string[]
  /** the main checkout has uncommitted work, so a merge cannot run into it yet */
  baseDirty: boolean
  /** nothing worth keeping: no commits of its own, nothing uncommitted */
  empty: boolean
}

export type LaneMergeResult =
  | { ok: true; commits: number; base: string; branch: string; removed: boolean }
  | {
      ok: false
      reason: 'not-a-lane' | 'nothing' | 'lane-dirty' | 'base-dirty' | 'conflict' | 'failed'
      conflicts?: string[]
      detail?: string
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
  error?: string
  /** release page to open by hand, used where in-place update is not possible */
  url?: string
}

/**
 * What a click on "Restart now" actually did.
 *
 * `held` is the one that mattered: do-not-disturb queues the restart instead of running
 * it, and until this existed the renderer could not tell that apart from a restart that
 * was about to happen, so the button said "Restarting..." and nothing ever came of it.
 * `game` names what is holding it, so the card can say so and offer the way past.
 */
export interface InstallOutcome {
  status: 'installing' | 'held' | 'nothing-to-install'
  /** the process that is holding it back, when `status` is 'held' */
  game?: string | null
  /** true when the hold is the manual do-not-disturb switch rather than a game */
  manual?: boolean
  /**
   * How many panes have an agent mid-turn, when that is what is holding it back.
   * Outranks the other two in the card's wording: a game costs you a dropped round,
   * this costs you the answer a pane was writing.
   */
  busy?: number
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
// Split
//
// The other shape: not several roles sharing one checkout, but one task cut into
// workstreams that each get their OWN worktree lane. See main/split.ts for why the
// file ownership below is the load-bearing part rather than a hint.

/** One workstream of a split: what to build, and the files it alone may write. */
export interface SplitLane {
  name: string
  brief: string
  /** repo-relative paths or directories. Never overlapping another lane's. */
  owns: string[]
  /** unticked lanes are left out of the launch and their files stay unclaimed */
  enabled?: boolean
}

export interface SplitPlan {
  lanes: SplitLane[]
  /** what every lane must implement identically - written into all of their briefs */
  contracts: string
  /** set when there is no usable split; `lanes` is empty and this says why */
  refused?: string
}

export interface SplitRequest {
  cwd: string
  mission: string
  plan: SplitPlan
  agent?: Agent
  model?: string
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
  /**
   * Which transcriber to use. 'auto' runs the ladder in shared/voicePick.ts, which
   * prefers a whisper CLI when one happens to be on PATH and otherwise runs Whisper
   * in the window - so the feature needs no install. Naming one pins it.
   */
  engine: 'auto' | 'system' | 'inapp' | 'browser'
}

/**
 * Hold every interruption back while a game is on screen. Windows takes an
 * exclusive-fullscreen game off the display when any window appears above it, so
 * "quiet" here means the app opens nothing, floats nothing and flashes nothing until
 * the game exits - not merely that it declines the keyboard. See main/gameMode.ts.
 */
export interface GameModeConfig {
  /** watch for the processes below and go quiet by itself while one is running */
  enabled: boolean
  /**
   * Process names (with .exe) that count as "playing". Empty falls back to the
   * built-in list of games that default to exclusive fullscreen.
   */
  processes: string[]
  /** force do-not-disturb on regardless of what is running */
  manual: boolean
}

/** What the UI shows about game mode: the live reading, not the settings. */
export interface GameModeStatus {
  active: boolean
  /** the process that matched, null when only the manual switch is on */
  game: string | null
  manual: boolean
  /** interruptions waiting for the screen (an update restart, a window) */
  waiting: number
}

/**
 * Prompt and capability intelligence - improving a draft before it is sent.
 *
 * Off by default, and that is not caution for its own sake: this is the first feature in
 * the app that spends the user's model budget on something they did not ask a turn for.
 *
 * `auto` is present in the union and unreachable from Settings in this version. Automatic
 * generation should follow evidence about latency, acceptance and downstream quality
 * rather than precede it, and the union being ready is what keeps that a one-line change
 * rather than a refactor.
 */
/**
 * "You have asked this before" — see main/promptArchive.ts.
 *
 * On by default, which the improve feature deliberately is not: this one spends no tokens,
 * starts no process and touches no network, so the case for making people find it first is
 * weak and the thing it saves is exactly the thing nobody notices they are paying for.
 */
export interface PromptRecallConfig {
  /** Match a draft against earlier asks and offer the chip. Off also stops recording. */
  enabled: boolean
  /**
   * Archives written by something else, merged in read-only — a prompt typed into a bare
   * terminal, or into a CLI before this app was installed. Absent files are ignored, so a
   * path that only exists on one machine is safe to keep in a synced config.
   */
  extraArchives: string[]
}

/** An earlier ask this draft repeats. Everything the chip shows and nothing else. */
export interface PriorPrompt {
  /** 0..1, how much of the shorter ask the other one covers */
  score: number
  /** the earlier prompt, already collapsed to one line and capped */
  text: string
  /** the project folder it was typed in, if known */
  project: string | null
  /** which agent it was typed at, if known */
  agent: string | null
  /** ISO of the most recent time it was asked */
  at: string | null
  /** how many times it has been asked */
  uses: number
  /**
   * What it produced — `<repo> <sha> <subject>`. Null for every entry this app records
   * today: nothing yet watches a pane's repo for the commit an ask turned into, so the only
   * outcomes that appear come from an external archive that already stamps them. The field
   * is here rather than added later so those rows survive a merge unchanged.
   */
  outcome: string | null
}

export interface PromptImproveConfig {
  mode: 'off' | 'suggest' | 'auto'
  /** Which CLI runs the improver. '' = the same agent as the pane. */
  engine: string
  /** Model for the improver; '' = that CLI's default. A cheap tier is the right choice. */
  model: string
  /** How readily it may ask. `minimal` allows one question, `balanced` allows three. */
  clarify: 'minimal' | 'balanced'
  /** What the budget is spent on. `tokens` drops retrieved knowledge first. */
  optimise: 'quality' | 'balanced' | 'tokens'
  /** Consult the capability catalogue at all. */
  capabilities: boolean
  /** ms of quiet before the pane's footer offers the chip. Generation never starts here. */
  idleMs: number
  /** Obsidian vault root. '' disables the Markdown knowledge provider. */
  vaultPath: string
  /** Absolute path to `vaultindex.py`. '' disables the indexed knowledge provider. */
  indexScript: string
  /** Write improvement events to prompt-audit.log. Hashes and counts only. */
  telemetry: boolean
  /** Also keep the text of improved prompts, so a golden case can be contributed. */
  telemetryText: boolean
}

export type ImproveOutcomeKind = 'accepted' | 'rejected' | 'cancelled' | 'failed'

/** What Settings and the sheet need to know without running anything. */
export interface ImproveStatus {
  /** A CLI that can run the improver was found on PATH. */
  available: boolean
  /** Which one would be used for a pane with no agent of its own. */
  engine: string
  /** Command that installs one, for the one-click button - the Voice tab's shape. */
  install: string
  /** Knowledge sources that answered when asked. Empty is a normal state. */
  providers: string[]
  /** A vault path that exists on this machine, offered as a starting point. */
  vaultCandidate: string
}

export interface ImproveOptions {
  /**
   * Include `draft`/`inbox` knowledge, labelled unverified everywhere it appears.
   *
   * The same escape hatch `vaultindex.py --include-untrusted` has. Not reachable from the
   * UI: it exists for the tests and the demonstration, where the bundled fixture
   * catalogue is the only knowledge there is and all of it is honestly `draft`.
   */
  includeUntrusted?: boolean
  /**
   * Capability ids the user removed from a previous answer.
   *
   * Removal is a re-run rather than a redraw: the improved prompt was written with that
   * capability in it, so hiding the chip would leave the text still recommending it.
   */
  exclude?: string[]
  /**
   * A note on the rewrite, typed after reading one: "shorter", "keep the file names",
   * "ask me about the auth part".
   *
   * A re-run rather than an edit of the text in the box, so what comes back is a whole
   * suggestion written to that instruction - and the word diff against the original still
   * means what it says.
   */
  tweak?: string
}

/** One retrieved reference as the sheet shows it. */
export interface ImproveSource {
  id: string
  title: string
  provider: string
  source: string
  trusted: boolean
  /** The derived lifecycle word: discovered, evaluated, tested, verified, recommended... */
  stage: string
  /** Past its review window. Usable, but it has to say so. */
  stale: boolean
  /** Can the user remove this one and re-run? Only catalogue entries. */
  removable: boolean
}

/** One improvement, as it crosses the bridge. The original is always carried back. */
export interface ImproveResult {
  ok: boolean
  error?: string
  original: string
  improvement?: Improvement
  /** Where the brief's references came from, shown separately from the prompt. */
  sources: ImproveSource[]
  /** "held back: 1 secret, 2 code blocks", or empty. */
  held: string
  metrics: ImproveMetrics
}

/** What one on-demand research pass returns to the sheet. */
export interface ResearchReport {
  ok: boolean
  /** completed | no-finding | skipped | deferred | failed | needs-human */
  outcome: string
  /** One line, safe to show. */
  detail: string
  /** New, and untested. Never presented as a recommendation. */
  kept: Array<{ id: string; name: string; category: string; description: string; stage: string; source: string }>
  /** Dropped, with the reason - so a run that kept nothing is not a run that found nothing. */
  rejected: Array<{ id: string; why: string }>
  /** What it says it opened, shown so the user can judge the sources themselves. */
  sources: Array<{ url: string; sourceClass: string; opened: boolean; checkedAt: string }>
  /** Already known. The number that proves research was avoided. */
  duplicates: number
  ms: number
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

// ---------------------------------------------------------------------------
// Remote devices
//
// Two machines, one desk. A device can host (answer for its own panes) and connect
// out (mirror another device's panes into this window) at the same time, which is
// what makes "leave the desktop, keep going on the laptop, come back" work without
// either side being the server.

/** Another device this one has been paired with, remembered across restarts. */
export interface RemotePeer {
  /** the other device's own id - what its session ids are namespaced with */
  id: string
  name: string
  /** hostname or IP on the local network */
  address: string
  port: number
  /** its pairing code; the secret that authenticates and encrypts the link */
  code: string
  /** reconnect to it automatically, on launch and after it goes away */
  auto: boolean
}

/** Live state of one paired device. */
export interface RemotePeerState extends RemotePeer {
  status: 'off' | 'connecting' | 'online' | 'error'
  /** why it is not connected, in words meant for the person reading them */
  error?: string
  /** panes mirrored from it right now */
  sessions: number
  /** epoch ms the current connection came up */
  since?: number
  /** it is announcing itself on this network right now */
  seen?: boolean
}

/** A PaneForge seen broadcasting on the LAN that this device has not paired with. */
export interface RemoteFound {
  id: string
  name: string
  address: string
  port: number
  platform: string
  version: string
  seen: number
}

/** A device currently connected *to* this one. */
export interface RemoteGuest {
  id: string
  name: string
  address: string
  since: number
  watching: number
}

/** Everything the Remote dialog draws, pushed whenever any of it changes. */
export interface RemoteState {
  self: {
    id: string
    name: string
    code: string
    port: number
    /** the listener is actually up */
    hosting: boolean
    /** why it is not, when it should be (a taken port) */
    error?: string
    /** this machine's LAN addresses, for typing into the other device */
    addresses: string[]
  }
  peers: RemotePeerState[]
  found: RemoteFound[]
  guests: RemoteGuest[]
}

export interface RemoteConfig {
  /** answer connections from your other devices */
  host: boolean
  port: number
  /** the code another device has to type once; regenerating it revokes every pairing */
  code: string
  /** how this device introduces itself */
  name: string
  /** stable identity, generated on first run */
  id: string
  /** announce on the LAN so the other device finds this one without an IP */
  discoverable: boolean
  peers: RemotePeer[]
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
   * Minutes a RUNNING turn may print nothing before the pane says it is stuck. Silence
   * at an idle prompt never counts - that is just a pane you are not using. 0 is off.
   */
  silenceAlertMin: number
  /**
   * Surface the terminal bell. A CLI that rings it is asking for a person directly,
   * and until now the app swallowed it: xterm's own audible bell is off and nothing
   * was drawn in its place.
   */
  bellAlert: boolean
  /**
   * Which sound each of the three alerts makes, how loud, and any files the user has
   * added. The switches above decide WHETHER an alert happens; this decides what it
   * sounds like, and they are separate because muting a chatty CLI and disliking the
   * bell are different complaints.
   */
  sounds: SoundConfig
  /**
   * Feature notes the user has dismissed, by blurb id (`shared/blurbs.ts`). A one-line
   * "what this is" at the top of Devices is worth reading once and noise by the fortieth
   * time, so each one can be closed on its own and Settings brings them all back.
   */
  hiddenBlurbs: string[]
  /**
   * Show the desk's headline numbers as Discord activity - "3/6 sessions running"
   * plus which projects - refreshed as turns start and finish. Counts and folder
   * names only, never a byte of pane content. Off tells Discord nothing at all.
   */
  discordPresence: boolean
  /**
   * What the presence actually says: the two lines as templates, and switches for the
   * parts that are not text. Empty templates mean the built-in wording, so this is
   * safe to leave alone forever and an upgrade changes nothing on anyone's profile.
   */
  discordStyle: DiscordStyle
  /**
   * Keep the last things you copied on a shelf in the corner, so a screenshot or a
   * block of text is one click from the focused pane. Off stops the clipboard being
   * watched at all.
   */
  clipboardShelf: boolean
  /**
   * Also float that history in a small always-on-top window, bottom-left of whichever
   * display the app is on, so it is reachable while you are in a browser or an editor
   * rather than only while PaneForge has the screen. Needs `clipboardShelf` on - it is
   * the same history, in a window that outlives the app being minimised.
   */
  clipboardOverlay: boolean
  /**
   * How long the Stash shows itself for when something new lands on it, in ms. 0 means it
   * never opens by itself and only the key (Ctrl+Shift+V) or the pill opens it - which is
   * what you want once you copy all day and stopped needing to be told.
   */
  stashPeekMs: number
  /**
   * How long the opened Stash list stays up once the pointer has left it (or never
   * arrived), in ms. 0 leaves it open until it is closed by hand. Opening it is one
   * hover; leaving it open forever means it is sitting over someone's window an hour
   * after the paste it was opened for.
   */
  stashAutoCloseMs: number
  /** entries the Stash keeps, across restarts. Text is cheap; this is mostly text. */
  stashMaxItems: number
  /** images are a PNG each on disk, so they fall off a shorter list of their own */
  stashMaxImages: number
  /**
   * Hours a file you dropped on the Stash is kept before it is swept, with its copy on
   * disk. 0 keeps them until you clear the Stash by hand. Files are the only thing here
   * that can be gigabytes, so they are the only thing with a clock on them.
   */
  stashFileHours: number
  /** biggest single file the Stash accepts, MB. Bigger ones are refused, not truncated. */
  stashMaxFileMb: number
  /**
   * Where the floating Stash was last dragged to, as its bottom-left corner in screen
   * coordinates. Null means the default corner, and it goes back to null if that point is
   * no longer on any display (a monitor unplugged, a resolution changed).
   */
  stashPos: { x: number; y: number } | null
  /** show every session at once instead of one at a time */
  grid: boolean
  /**
   * Column and row sizes for the grid, as fractions, keyed by the shape they were set for
   * ("3x2"). Per shape rather than per pane on purpose: what somebody means by dragging a
   * divider is "in a three-across grid the left column should be wide", which should
   * survive closing one pane and opening another. A shape that has never been dragged is
   * absent and gets equal shares.
   */
  gridSizes: Record<string, { cols: number[]; rows: number[] }>
  /**
   * How the grid arranges panes: everything the same size, one row of columns, one column
   * of rows, or one big pane on the left or on top. Ctrl Shift G cycles it.
   *
   * The union is written out here rather than imported from `renderer/gridLayout`, which
   * is where `LayoutKind` lives and which the main process must not import. The two are
   * the same five strings and `isLayout()` is what checks a value read off disk.
   */
  gridLayout: 'tiled' | 'columns' | 'rows' | 'main-left' | 'main-top'
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
  /** improve a draft prompt before it is sent - see PromptImproveConfig. Off by default. */
  promptImprove: PromptImproveConfig
  /** say so when a draft repeats an ask already made - see PromptRecallConfig. On. */
  promptRecall: PromptRecallConfig
  /** stay out of the way while a game is running - see GameModeConfig */
  gameMode: GameModeConfig
  /**
   * Put a second session in the same git repo into its own worktree lane, so two
   * agents can work at once without overwriting each other. Off means both share
   * the folder, which is only safe when one of them is read-only.
   */
  autoLane: boolean
  /** roles offered in the swarm dialog, editable by the user */
  swarmRoles: SwarmRole[]
  /** pairing, hosting and the devices whose panes show up in this window */
  remote: RemoteConfig
  /**
   * Colours, corners and row height. One accent plus four numbers; every other colour
   * in the window is derived from them - see shared/theme.ts.
   *
   * Optional so a config written by an older build still loads: `getConfig` fills it
   * with DEFAULT_THEME, which reproduces the palette that used to be hard-coded in
   * styles.css. Nobody's window changes shape because they updated.
   */
  theme?: ThemeConfig
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
  /** the conversation this pane will be put back into, when it could be named */
  resumeId?: string
  /**
   * The last thing typed into that conversation. A folder name says where a pane was;
   * this is the only thing on the dialog that says what it was for.
   */
  lastPrompt?: string
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
 * One thing on the Stash: text you copied, an image saved to a PNG we own, or a file you
 * dropped on it (a video, a zip, anything) copied into the Stash folder so the original
 * can move or be deleted without the row going dead.
 * `key` is what makes copying the same thing twice one entry instead of two.
 */
export interface RecentItem {
  id: string
  key: string
  kind: 'text' | 'image' | 'file'
  /** epoch ms it landed on the shelf */
  at: number
  /**
   * Full text, text items only - and only in the main process. Every copy of this list
   * that reaches a window has it stripped (`lean()` in recents.ts); ask for it by id with
   * `recentText`.
   */
  text?: string
  /** our copy on disk - the path typed into a pane, and the file an OS drag carries */
  path?: string
  /** small data URL for the tile, image items only */
  thumb?: string
  /** one-line label for the row */
  preview: string
  lines?: number
  chars?: number
  width?: number
  height?: number
  /** file items: the name it arrived with, which is what the row shows */
  name?: string
  /** file items: size of our copy, bytes */
  bytes?: number
  /** file items: guessed from the extension ('video/mp4'), decides the preview tile */
  mime?: string
  /** file items: epoch ms it gets swept at. Absent = kept until the Stash is cleared. */
  expires?: number
  /**
   * Kept no matter what: a pinned entry is skipped by every cap and by the file clock, and
   * sits above the rest of the list. The Stash forgets things on purpose, so the one thing
   * you are pasting all afternoon needs a way to opt out of that.
   */
  pinned?: boolean
}

/**
 * The slice of Config the floating overlay is allowed to read and write from its own
 * settings panel. It is a window that sits over every other app, so it gets the Stash's
 * own knobs and nothing else - no roots, no agents, no shell.
 */
export type StashConfig = Pick<
  Config,
  | 'stashPeekMs'
  | 'stashAutoCloseMs'
  | 'stashMaxItems'
  | 'stashMaxImages'
  | 'stashFileHours'
  | 'stashMaxFileMb'
  | 'clipboardOverlay'
>

/** Exactly the keys the overlay may patch. Anything else on the wire is dropped. */
export const STASH_CONFIG_KEYS = [
  'stashPeekMs',
  'stashAutoCloseMs',
  'stashMaxItems',
  'stashMaxImages',
  'stashFileHours',
  'stashMaxFileMb',
  'clipboardOverlay'
] as const

/** Shape exposed on window.api by the preload script. */
export interface Api {
  listProjects(): Promise<Project[]>
  /**
   * Which project a first message is about, ranked. Empty text means no matches, so
   * this is safe to call on every keystroke; it reads no files that are not cached.
   */
  routeProjects(text: string): Promise<RouteResult>
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
  /**
   * The sidebar's order after a card was dragged, newest-first-to-last as displayed.
   * Mirrored ids are carried along and ignored by the machine that receives them.
   */
  reorderSessions(ids: string[]): void
  killSession(id: string): Promise<void>
  write(id: string, data: string): void
  /** send the same line to every live session */
  resize(id: string, cols: number, rows: number): void
  /** poke the pty size so a full-screen CLI redraws itself from scratch */
  redraw(id: string): void
  /**
   * The pane telling main whether the agent still looks busy on screen. Only the
   * renderer can see the rendered frame, and "still working" must not chime.
   */
  /**
   * `tail` is the frame that decided a `false`, kept for the attention audit log.
   * `clock` is how long the agent's own footer says the turn has been running, with
   * the precision it printed - the run clock is anchored to it rather than to when
   * this app happened to notice the turn.
   */
  setBusy(id: string, busy: boolean, tail?: string, clock?: TurnClock): void
  /** replay of everything the pty printed so far, for re-attaching a pane */
  getBuffer(id: string): Promise<string>
  /**
   * Start teeing this pane's output to a file, or stop the one that is running.
   *
   * Starting with no path asks for one (a save dialog the user opened, which is the
   * only kind this app is allowed to show). The answer is the pane's new state, so a
   * cancelled dialog and a stopped tee are the same `null` and the caller needs no
   * second round trip.
   */
  pipePane(id: string, opts: { path?: string; text?: boolean; append?: boolean } | null): Promise<PipeInfo | null>
  clearAttention(id: string): void

  getConfig(): Promise<Config>
  setConfig(patch: Partial<Config>): Promise<Config>
  pickRoot(): Promise<string | null>
  /** file dialog, then a copy into userData. `error` is a sentence to put on screen. */
  addSound(): Promise<{ ok: boolean; sound?: CustomSound; error?: string }>
  /** the bytes of an uploaded sound, for decodeAudioData. Null = gone or unreadable. */
  soundData(id: string): Promise<Uint8Array | null>
  removeSound(id: string): Promise<SoundConfig>
  renameSound(id: string, name: string): Promise<SoundConfig>
  /** what Discord itself last said about the presence - accepted, refused, or not running */
  discordStatus(): Promise<PresenceStatus>
  onDiscordStatus(cb: (status: PresenceStatus) => void): () => void

  /** open a folder, or open a file's folder with the file selected */
  reveal(path: string): void
  /**
   * Resolve a path an agent printed, relative to the pane it was printed in.
   *
   * Null means "not a path on this machine", which is how the terminal decides whether a
   * token is worth underlining at all.
   */
  pathKind(cwd: string, token: string): Promise<RevealTarget | null>
  openInEditor(path: string): Promise<string | null>
  openExternal(url: string): void
  /** write to the OS clipboard (renderer has no navigator.clipboard under file://) */
  copyText(text: string): void
  readClipboard(): Promise<string>
  /** branch + dirty count for a folder; null when it is not a repo */
  gitInfo(path: string): Promise<GitInfo | null>
  /** the changed files in a folder, for one scope. Cheap; no patches are read. */
  diffFiles(cwd: string, scope: DiffScope): Promise<DiffSet>
  /** one file's patch, read when that file is selected */
  diffPatch(cwd: string, scope: DiffScope, path: string, untracked: boolean): Promise<DiffPatch>
  /** PaneForge's own dev lanes, or null on a machine without a PaneForge checkout */
  laneBoard(): Promise<LaneBoard | null>
  /** what is in a pane's worktree lane; null when the folder is not a lane */
  laneWork(cwd: string): Promise<LaneWork | null>
  /** merge a worktree lane back into the branch it came from */
  mergeLane(cwd: string): Promise<LaneMergeResult>
  /** a pane was sent back to its project folder because its lane held nothing */
  onLaneMoved(cb: (id: string, message: string) => void): () => void
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
  /** run an agent's uninstall command, streaming to the same console */
  uninstallAgent(id: string): Promise<void>
  /** file picker that wires an existing binary up as an agent override */
  locateAgent(id: string): Promise<string | null>

  /** named profile this window runs under ('' = the normal installed app) */
  profile(): Promise<string>
  updateState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  /**
   * Start the restart-into-the-new-version. Resolves to what actually happened, because
   * it does not always happen: with do-not-disturb up the restart is queued instead, and
   * a button that had no way to learn that just sat on "Restarting..." forever, which is
   * exactly what "installing from the update popup does not work" was.
   */
  installUpdate(): Promise<InstallOutcome>
  /** restart for the update even though a game is on screen - the way past the hold */
  installUpdateAnyway(): void

  /** is the app holding interruptions back right now, and how many are waiting */
  gameStatus(): Promise<GameModeStatus>
  /** force do-not-disturb on or off by hand, applied without waiting for a poll */
  setGameManual(on: boolean): Promise<GameModeStatus>

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

  /** Ask the local coding CLI how this task divides. Never throws - see `refused`. */
  planSplit(req: { cwd: string; mission: string; agent?: string }): Promise<SplitPlan>
  /** One pane per lane, each moved into its own git worktree before it starts. */
  startSplit(req: SplitRequest): Promise<Session[]>

  listHistory(): Promise<HistoryEntry[]>
  searchHistory(query: string): Promise<HistoryHit[]>
  readHistory(id: string): Promise<string>
  deleteHistory(id: string): Promise<void>

  /**
   * Copy files into the Stash - a drag-drop onto the shelf, or the picker below. Returns
   * how many were taken; the rest were over the size cap or unreadable.
   */
  addStashFiles(paths: string[]): Promise<number>
  /** OS file picker, then the same. Only ever from a click - it is a foreground dialog. */
  pickStashFiles(): Promise<number>
  /** open the Stash folder in the file manager, for the times a drag is not enough */
  revealStash(): void
  /** open or shut the floating Stash - what Ctrl+Shift+V does while the app has focus */
  toggleStash(): void
  /** the clipboard shelf, newest first */
  listRecents(): Promise<RecentItem[]>
  /**
   * The body of one stash entry. The list arrives without them - a full history is 383KB
   * of text nothing on screen shows - so the one click that types a clip into a pane
   * fetches that clip.
   */
  recentText(id: string): Promise<string>
  /** put a shelf item back on the OS clipboard */
  copyRecent(id: string): void
  /** hand an image item to the OS drag layer, so it can be dropped in any app */
  dragRecent(id: string): void
  /** forget one item - the clipboard is where a password lands by accident */
  removeRecent(id: string): void
  clearRecents(): void

  /** hosting, pairings, discovered devices and who is connected right now */
  remoteState(): Promise<RemoteState>
  /** start or stop answering other devices */
  setRemoteHost(on: boolean): Promise<RemoteState>
  /** move the listener; returns the state with the error if the port is taken */
  setRemotePort(port: number): Promise<RemoteState>
  /** new pairing code: every device paired with the old one is cut off */
  rotateRemoteCode(): Promise<RemoteState>
  /** how this device introduces itself to the others */
  renameDevice(name: string): Promise<RemoteState>
  /**
   * Pair with a device: connect once to prove the code, then remember it. Resolves
   * with the failure in words rather than throwing, because a mistyped code is the
   * normal case and the dialog shows it inline.
   */
  pairRemote(peer: { address: string; port: number; code: string; name?: string }): Promise<{
    ok: boolean
    error?: string
    state: RemoteState
  }>
  /**
   * The single line to copy on this device so the other one can pair by pasting it.
   * Carries every address, the port and the code, and stops being accepted after
   * fifteen minutes - see `main/remote/invite.ts`.
   */
  remoteInvite(): Promise<string>
  /**
   * Pair from a pasted invite, trying each address it carries. `code` comes back set
   * when the paste turned out to be a bare pairing code, which still needs an address.
   */
  pairRemoteText(text: string): Promise<{
    ok: boolean
    error?: string
    code?: string
    name?: string
    state: RemoteState
  }>
  /** Pair from that clipboard invite, without its text passing through the window. */
  pairFromClipboard(): Promise<{
    ok: boolean
    error?: string
    code?: string
    name?: string
    state: RemoteState
  }>
  /** An invite already sitting on this machine's clipboard, so pairing is one click. */
  clipboardInvite(): Promise<{ name: string; expires: number } | null>
  forgetRemote(id: string): Promise<RemoteState>
  /** connect to or disconnect from a device already paired */
  connectRemote(id: string, on: boolean): Promise<RemoteState>
  /** ask the LAN who is there, now, rather than waiting for the next announcement */
  scanRemote(): Promise<RemoteState>
  /** that device's own project folders, so a pane can be opened over there */
  remoteProjects(device: string): Promise<Project[]>
  /** the CLIs installed on that device - its list, not this one's */
  remoteAgents(device: string): Promise<AgentInfo[]>
  /** open a pane on that device; it appears here mirrored, like the rest of its panes */
  startRemote(device: string, req: StartSessionRequest): Promise<Session>

  /** is there a CLI on PATH that can run the improver, and where would knowledge come from */
  /** The best earlier ask this draft repeats, or null. Cheap: a scored lookup, no search. */
  priorPrompt(draft: string): Promise<PriorPrompt | null>
  /** Record that a draft was actually sent. Fire-and-forget. */
  promptUsed(draft: string, meta: { cwd?: string; agent?: string }): void
  improveStatus(): Promise<ImproveStatus>
  /**
   * Improve a draft. Never submits anything and never writes to the pane: the result is
   * shown first and only `applyImproved` touches the terminal.
   */
  improvePrompt(id: string, draft: string, options?: ImproveOptions): Promise<ImproveResult>
  /** One second pass, with the answers to the questions the first pass asked. Never a third. */
  answerImprove(
    id: string,
    draft: string,
    answers: Array<{ question: string; answer: string }>,
    options?: ImproveOptions
  ): Promise<ImproveResult>
  /** Abort whatever is in flight for this pane. Silent, and safe to call when nothing is. */
  cancelImprove(id: string): void
  /**
   * Research this request: one bounded pass over public sources, on demand.
   *
   * Never automatic. It installs nothing, it does not rewrite the draft, and what it finds
   * comes back labelled Discovered - the prompt is only rebuilt afterwards, by asking for
   * an improvement again.
   */
  researchRequest(id: string, draft: string): Promise<ResearchReport>
  /** Stop a research pass. Does not touch an improvement running for the same pane. */
  cancelResearch(id: string): void
  /**
   * Accept: empty the prompt box and paste the improved text into it. There is no `\r` in
   * what this writes and no option that adds one - the user presses Enter.
   */
  applyImproved(id: string, text: string): Promise<{ ok: boolean; error?: string }>
  /** What happened to a suggestion, for the development metrics. Off unless telemetry is on. */
  recordImprove(outcome: ImproveOutcomeKind, metrics: ImproveMetrics, editedChars?: number): void

  voiceStatus(): Promise<VoiceStatus>
  /** wav bytes in, text out; runs a local whisper, nothing leaves the machine */
  transcribe(wav: ArrayBuffer): Promise<{ text: string; error?: string }>
  installVoice(): Promise<void>

  onData(cb: (id: string, data: string) => void): () => void
  onSessions(cb: (sessions: Session[]) => void): () => void
  onConfig(cb: (config: Config) => void): () => void
  onInstall(cb: (e: InstallEvent) => void): () => void
  onUpdate(cb: (s: UpdateState) => void): () => void
  /**
   * The window was minimised or restored. The only reliable source for it: this window
   * runs with backgroundThrottling off, which also pins document.visibilityState to
   * 'visible' forever, so nothing in the page can tell.
   */
  onAppVisible(cb: (visible: boolean) => void): () => void
  /** the window state right now, for the page's first paint (the push can arrive first) */
  appVisibleNow(): Promise<boolean>
  /** game started or ended, or something joined/left the queue waiting on it */
  onGameMode(cb: (s: GameModeStatus) => void): () => void
  /** a session just went quiet after doing something - drives the chime */
  onAttention(cb: (s: Session) => void): () => void
  /**
   * The opposite: a turn that is still running has printed nothing for minutes. Kept
   * apart from `onAttention` all the way down because the two mean opposite things -
   * one is "it finished", this one is "it should have said something by now".
   */
  onStalled(cb: (s: Session) => void): () => void
  /** a pane's terminal rang its bell - a CLI asking for a human directly */
  onBell(cb: (s: Session) => void): () => void
  /** the pane's terminal rang its bell; reported from the renderer, which parses it */
  paneBell(id: string): void
  /** hosting, pairing or discovery changed */
  onRemote(cb: (s: RemoteState) => void): () => void
  /**
   * A remote pane's scrollback was replaced wholesale - the link came back and the
   * other device re-sent everything. The pane clears and redraws instead of appending
   * a second copy of what it already had.
   */
  onPaneReset(cb: (id: string) => void): () => void
  /** global push-to-talk hotkey fired from the main process */
  onVoiceHotkey(cb: () => void): () => void
  /** something new landed on the clipboard shelf */
  onRecents(cb: (items: RecentItem[]) => void): () => void
  /** the floating overlay asked for one of its items to go into the focused pane */
  onRecentToPane(cb: (id: string) => void): () => void
  /**
   * A main-process error, which used to be a modal message box that stole the keyboard.
   * Shown as a line in the footer instead; the detail is in paneforge-errors.log.
   */
  onAppError(cb: (message: string) => void): () => void
}

/**
 * What the floating clipboard overlay gets on `window.shelf`. Much smaller than `Api`
 * on purpose: that window sits over every other application, so it can read the
 * clipboard history and change nothing else about the app.
 */
/**
 * What `dragWindow.lift()` answers. The sliding form carries the content's offset inside
 * the expanded window and the content's size; `{ live: true }` means main is moving the
 * window itself and the renderer should only keep reporting the pointer.
 */
export type ShelfLift = { dx: number; dy: number; w: number; h: number } | { live: true } | null

export interface ShelfApi {
  list(): Promise<RecentItem[]>
  /** put it back on the OS clipboard, ready for Ctrl+V wherever you already were */
  copy(id: string): void
  remove(id: string): void
  clear(): void
  /** keep this one through every cap and clock, or stop keeping it */
  pin(id: string, on: boolean): void
  /** start an OS drag carrying our copy on disk - an image's PNG, or a dropped file */
  drag(id: string): void
  /** files dropped onto the overlay itself, by absolute path */
  add(paths: string[]): Promise<number>
  /** the overlay's + button: an OS file picker, then the same */
  pick(): Promise<number>
  /** absolute path of a dropped File, which Electron only exposes in a preload */
  pathForFile(file: File): string
  /** type it into PaneForge's focused pane instead of the clipboard */
  /** `focus` raises the main window too. Off by default: the overlay exists to leave
   *  the keyboard where it was. */
  toPane(id: string, focus?: boolean): void
  focusApp(): void
  /** record a physical Stash press without bringing the main window forward */
  touch(): void
  /** open the folder the Stash's copies live in */
  reveal(): void
  /** the overlay grew or shrank: the main process resizes the window to match */
  setExpanded(open: boolean): void
  /** the overlay's own settings panel needs room the list does not */
  setTall(tall: boolean): void
  /**
   * Move the window itself by dragging its header. `focusable: false` rules out the usual
   * draggable-region, so the page reports the pointer in screen coordinates instead.
   *
   * The move itself is a lift/slide/drop: the OS window is expanded once over the whole
   * desktop and the content slides inside it with a CSS transform, because moving a
   * transparent always-on-top window with setPosition costs a DWM recomposite per call
   * (~27ms measured) and no pacing makes 37Hz feel like a drag. See shelfWindow.ts.
   */
  dragWindow: {
    start(): void
    /** Begin actually moving. Either the window is expanded over the desktop and the
     * content slides inside it (Windows - answers with where the content sits inside it
     * and its size), or main moves the window per pointer report (`{ live: true }`,
     * macOS). Null when no drag is active any more. */
    lift(): Promise<ShelfLift>
    /** A pointer move during a live drag: put the window there. Ignored otherwise. */
    move(dx: number, dy: number): void
    /** The renderer has painted the lifted (or dropped) content; safe to show again. */
    shown(): void
    /** Settle at the dragged-to position and remember it. */
    drop(dx: number, dy: number): Promise<void>
    end(): void
  }
  onItems(cb: (items: RecentItem[]) => void): () => void
  onExpanded(cb: (open: boolean) => void): () => void
  /** the Stash's own settings, for the panel behind the gear */
  getConfig(): Promise<StashConfig>
  setConfig(patch: Partial<StashConfig>): Promise<StashConfig>
  /** the same settings changed somewhere else - the main window's Settings dialog */
  onConfig(cb: (config: StashConfig) => void): () => void
}
