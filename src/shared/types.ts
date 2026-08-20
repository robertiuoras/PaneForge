// Types shared by the Electron main process and the React renderer.
// Keep this file dependency-free: it is imported from both sides of the IPC bridge.

import type { AttachIn, AttachResult } from './attach'
import type { Verdict } from './capacity'
import type { AutoAnswerConfig } from './autoAnswer'
import type { MascotConfig } from './mascot'
import type { RecoverConfig } from './recover'
import type { AutoHandoffConfig } from './autoHandoff'
import type { ReclaimConfig } from './reclaim'
import type { UsageReport } from './usage'
import type { RunningDev } from './devList'

import type { DriveRun } from './agentic'
// Type-only, and therefore erased: `goals.ts` reads `SplitPlan` from here and this reads
// `Goal` from there, which is a cycle at the type level only and no import at runtime.
import type { Goal } from './goals'
import type { AgentInfo, AgentSpec } from './agents'
import type { DiscordStyle, PresenceStatus } from './discordRpc'
// Same type-level-only cycle as goals: handoff.ts imports Session from here.
import type { HandoffItem } from './handoff'
import type { DeviceMark } from './deviceWatch'
import type { Improvement } from './promptSchema'
import type { ImproveMetrics } from './promptBudget'
import type { RevealTarget } from './pathToken'
import type { RouteMatch, RouteResult } from './projectRoute'
import type { CustomSound, SoundConfig } from './sounds'
import type { ThemeConfig } from './theme'

export type { CustomSound, DiscordStyle, DriveRun, RevealTarget, RouteMatch, RouteResult, SoundConfig, ThemeConfig }

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
  /**
   * This folder is a second checkout of another project in the same root - a git
   * worktree (`<repo>-a` on `lane-a`, Claude Code's `worktree-<slug>`) or what one
   * left behind. The value is that project's NAME, so the launcher can fold them
   * under it instead of listing eight copies of one repository.
   *
   * Proved, never guessed: `.git` is a file pointing into the parent's
   * `.git/worktrees`, or the folder is a `<project>-<letter>` sibling of a real
   * repository while being no repository itself. `service-a` next to no `service`
   * is a project, and stays one.
   */
  checkoutOf?: string
}

/**
 * The turn clock read straight off the agent's own footer: how long IT says the turn
 * has been running, and how coarsely it printed that (`24m 3s` is second-accurate,
 * `24m` says nothing about the seconds). Defined next to the reader that produces it.
 */
import type { TurnClock } from './busy'
export type { TurnClock }
import type { PaneAsk } from './choices'
export type { PaneAsk }

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
  /** epoch ms of the most recent user input (prompt submission, keystrokes); used for idle detection */
  lastKeyboard: number
  createdAt: number
  /**
   * When this PANE first appeared on the desk, across every restart since - which is not
   * `createdAt`, the age of this process. Three timers read `createdAt` as process age
   * (the starting->idle flip, the attention rule, the stall rule), so the display clock
   * gets a field of its own rather than back-dating theirs.
   */
  openedAt?: number
  exitCode?: number
  /** went quiet while you were looking elsewhere - cleared when you open the pane */
  attention?: boolean
  /**
   * Something has been asked of this session (a queued prompt, or you typed into
   * it). A freshly launched CLI that has only drawn its own banner is quiet but
   * has finished nothing, so it must not raise attention or chime.
   */
  engaged?: boolean
  /**
   * The question this pane is sitting on, when it is sitting on one.
   *
   * Read off the pane's own frame by `shared/choices.ts`, so it works for every CLI
   * here rather than for whichever one has a hook. It is on the session rather than in
   * the pane's own state because the whole point is the surfaces that are not the desk:
   * a phone draws the same buttons, and a bot over the phone server can answer one.
   */
  ask?: PaneAsk
  /**
   * When `autoAnswer` will press that question, epoch ms, and which option it will press.
   *
   * Absent whenever nothing is going to happen - the setting is off, the question has no
   * obviously-good answer, or the pane has used up its run of automatic presses. The pane
   * counts down against it (`shared/autoAnswer.ts`, `autoAnswerAt`), so a press is never
   * the first anybody hears of it.
   */
  autoAnswerAt?: number
  autoAnswerN?: number
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
   * A phone is holding this pane's size, so `cols`/`rows` above are ITS shape and not
   * this window's. The desk draws a borrowed pane at that grid rather than at its own
   * width - two windows cannot both decide, and the one being looked at wins.
   */
  borrowed?: boolean
  /**
   * This pane is on its way to another device, or waiting for its turn to end so it can be.
   *
   * On the session rather than in the sender, because two other things have to see it: the
   * pane draws it (a pane about to disappear should say so before it does), and
   * `reclaim.ts` refuses to close it - a pane closed out from under a move in flight is a
   * handoff that reports success about a pane that is no longer there.
   */
  handingOff?: boolean
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
  /**
   * What the pane the desk is replacing knew about itself: when it first opened, how long
   * its last turn took, whether it had been asked anything, and whether it was mid-turn.
   * A restored pane is a NEW session, so without these it comes back with no clock and a
   * grey "ready - type to start" dot on a live conversation. See `shared/restoreTurn.ts`.
   * Only the desk sets them.
   */
  openedAt?: number
  lastRunMs?: number
  engaged?: boolean
  wasWorking?: boolean
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
  /**
   * The desk the holding chat is sitting at, spelled the way lane.mjs publishes claims
   * (the sanitised hostname, or `PF_DEVICE`). A lane read out of THIS machine's ledger is
   * this machine's by construction - that file lives in a local `.git` and no other device
   * writes it - so it is filled in from `LaneBoard.device` when the record predates the
   * field. Null only where the hostname sanitises away to nothing, which is the same case
   * that turns cross-device claims off entirely.
   */
  device: string | null
  /**
   * This row is a claim ANOTHER device published on the shared remote, not a lane in this
   * machine's ledger. Nothing local may act on it: there is no worktree here to hand out,
   * its chat is not a chat on this machine, and giving it back (`goneLanes`) would free a
   * checkout somebody is typing in at the other desk.
   */
  peer: boolean
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
  /**
   * The newest commit on this lane's branch, as its subject line - and the files it has
   * uncommitted right now.
   *
   * "3 commits not in main · 2 uncommitted files" answers how MUCH is in a lane and says
   * nothing at all about WHAT, which is the question actually being asked when somebody
   * opens a lane they did not open themselves ("see other lanes and what they are working
   * on"). A commit subject and a couple of filenames are the only answer available for
   * free: both are already in the repository, neither needs a model, and a lane whose chat
   * is not a pane in this window has nothing else to say for itself.
   */
  subject: string | null
  /** epoch ms of that commit */
  at: number | null
  /** up to four uncommitted paths, lane-relative, as `git status` spells them */
  touching: string[]
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
  /** This desk, in the same spelling lane.mjs publishes claims under. */
  device: string | null
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

/** The same plan, driven by the app. See `docs/agentic.md` and `main/supervisor.ts`. */
export interface DriveRequest extends SplitRequest {
  /** Skip the reviewer agent. The diff and command steps of the gate still run. */
  skipReview?: boolean
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
  /**
   * What this session was asked to do, in one line - the first thing typed at the agent.
   *
   * The reason History is worth opening: a folder and a clock do not say which of eleven
   * closed sessions is the one to bring back. Free by construction (see `shared/gist.ts`):
   * it is keystrokes the app already relays, never a summary anything had to be paid for.
   */
  gist?: string
  /** how many asks were submitted in it; 40 and 1 are different sessions to return to */
  asks?: number
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
  /**
   * The panes on THAT device this one mirrors, by their id over there. Empty means the
   * link is up and this window is drawing none of its panes, which is the default: a
   * connection is permission to watch, not a decision to watch everything.
   */
  watch?: string[]
  /** mirror every pane it has, including ones opened later. Off unless asked for. */
  mirrorAll?: boolean
}

/** One pane on a paired device, as the Devices panel offers it. */
export interface RemotePaneInfo {
  /** its id ON that device - what `watch` holds and `remote:watch` is given */
  id: string
  title: string
  cwd: string
  agent: Agent
  status: SessionStatus
  /** this device is mirroring it right now */
  watched: boolean
}

/** Live state of one paired device. */
export interface RemotePeerState extends RemotePeer {
  status: 'off' | 'connecting' | 'online' | 'error'
  /** why it is not connected, in words meant for the person reading them */
  error?: string
  /** panes mirrored from it right now */
  sessions: number
  /** every pane it has, mirrored or not, so the panel can offer the pick */
  panes: RemotePaneInfo[]
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
    /** a device on this network may raise an Approve card here instead of typing the code */
    pairByAsking: boolean
  }
  peers: RemotePeerState[]
  found: RemoteFound[]
  guests: RemoteGuest[]
  /** a device asking THIS one to let it in, waiting on Approve or Deny here */
  asking?: RemoteAsk
  /** a request THIS device sent, waiting to be approved over there */
  waiting?: RemoteWaiting
}

/**
 * A device asking to pair without a code, and the six digits that stand in for having
 * typed one.
 *
 * The digits are the authentication, not the button: they are derived from a key exchange
 * that binds both ends, so a machine sitting in the middle cannot make them agree. See
 * `main/remote/wire.ts`. Which is why the UI shows them on both screens and says to
 * compare them - a card that only said "Gamer-PC wants to pair" would be trusting a name
 * anybody on the network can choose.
 */
export interface RemoteAsk {
  id: string
  name: string
  platform: string
  address: string
  /** six digits, shown on both screens; they must match */
  sas: string
  at: number
}

/** The same request, seen from the device that sent it. */
export interface RemoteWaiting {
  name: string
  address: string
  platform: string
  sas: string
  at: number
}

/**
 * Serving this desk's own UI to a browser on this network - the phone client.
 *
 * Separate from `remote` on purpose: that one is two desktop copies proving a code to
 * each other over an encrypted socket, and both ends run the app. This one has a browser
 * at the far end, so the transport is HTTP and the secret is a cookie. See `main/phone.ts`.
 */
export interface PhoneConfig {
  /** answer browsers. Off until switched on: anything that can type into a pane can run
   * commands on this machine. */
  on: boolean
  port: number
  /** the characters a browser types once; rotating it signs every phone out */
  code: string
  /**
   * Reachable from outside this network, through a Cloudflare quick tunnel.
   *
   * Its own switch and not implied by `on`, because the two are different promises: `on`
   * puts this desk on the LAN, where the front door is already a private address. This
   * one puts a public https address in front of it, and the code stops being the second
   * lock behind a network nobody else is on - which is why turning it on lengthens the
   * code (see `LONG_CODE_LEN` in main/index.ts).
   */
  tunnel?: boolean
  /**
   * Browsers that were let in by somebody pressing Approve on this desk, each with its
   * own secret. This is what makes "scan, approve, and it stays signed in" possible: the
   * derived cookie above is the same on every phone that ever typed the code, so it can
   * only ever be revoked for all of them at once, and there is no such thing as a list of
   * WHICH devices are allowed. A per-device token is that list.
   */
  devices?: PhoneDevice[]
  /**
   * Let a browser ask to be let in instead of typing the code.
   *
   * On by default, because it is the whole point of the QR: the phone opens the address,
   * this desk raises a card with four digits and the same four are on the phone, and one
   * press signs it in for good. Nothing is granted by the asking - the card is a refusal
   * until somebody here presses Approve.
   */
  ask?: boolean
  /**
   * Require a passkey touch before a browser may type into a pane.
   *
   * Watching and typing are not the same risk and used to be the same permission: a signed-in
   * phone could run commands on this machine for the life of its cookie. With this on, panes
   * are still free to watch, and the first keystroke of an unlock window costs one Face ID
   * touch - so a stolen cookie is a viewer, not a shell.
   *
   * Only ever armed over TLS: WebAuthn does not exist outside a secure context, so arming it
   * on the plain-http LAN path would lock out the phones that cannot satisfy it. In practice
   * that means it guards exactly the public path - see `armed()` in main/phone.ts.
   */
  typeGate?: boolean
  /** passkeys enrolled here, one per authenticator. Forgetting one revokes it immediately. */
  keys?: PhoneKey[]
}

/**
 * One enrolled passkey. The public half only - there is nothing here worth stealing, which
 * is the whole appeal of the primitive.
 */
export interface PhoneKey {
  /** credential id, base64url - the string the browser sends back to identify itself */
  id: string
  /** the public key as a stringified JWK; `createPublicKey` takes this shape directly */
  jwk: string
  /** COSE algorithm: -7 ES256 (Apple platforms), -257 RS256 (Windows Hello) */
  alg: number
  /** ms epoch it was enrolled */
  at: number
  /** what the panel shows; a label this desk chose, never one the browser asserted */
  label: string
  /** last signature counter seen; 0 from an authenticator that does not keep one */
  count: number
}

/**
 * A passkey as the panel shows it. The public key is left behind deliberately - the window
 * has no use for it, and a surface carries the smallest thing that answers the question.
 */
export interface PhoneKeyView {
  id: string
  label: string
  at: number
}

/** One browser that was approved on this desk, and may come back without asking again. */
export interface PhoneDevice {
  id: string
  /** 'iPhone' / 'Android phone' / 'Mac' - what its user-agent claimed when it asked */
  kind: string
  /** the address it asked from, kept so the list reads as a place and not an id */
  address: string
  /** which side of the front door it asked from */
  origin: PhonePeer['origin']
  /** ms epoch it was approved */
  at: number
  /** ms epoch it last held a live stream */
  seen: number
  /**
   * What its browser calls itself, kept for ONE reason: so approving the same phone a
   * second time replaces its row instead of adding another. Eight rows for three devices
   * is what the list looked like before this, and a list nobody can read is a list where
   * "sign this one out" stops being a thing anybody does.
   */
  ua?: string
  /**
   * What was noticed the last time this token arrived looking like somebody else, and null
   * once it has been read and dismissed on the desk. Advisory only - nothing in the server
   * refuses a request because of it, because a watcher that revokes on suspicion locks the
   * owner out from a train. See `shared/deviceWatch.ts`.
   */
  mark?: DeviceMark | null
  /**
   * Its secret, 32 random bytes as hex. NEVER leaves the main process: `PhoneState`
   * carries `PhoneDeviceView`, which is this without the token.
   */
  token: string
}

/** A signed-in device as the panel is allowed to see it: everything except the secret. */
export type PhoneDeviceView = Omit<PhoneDevice, 'token'> & { live: boolean }

/**
 * A browser waiting on this desk's Approve, and the four digits that decide it.
 *
 * The digits are not a password and are not sent by the browser: they are generated here
 * and shown in both places, so pressing Approve is a statement that the phone in your hand
 * is the one that just asked. Anything on the network can raise this card - that is what
 * an open port means - which is why it says WHERE the request came from and why it grants
 * nothing at all until a person answers it.
 */
export interface PhoneAsk {
  id: string
  /** four digits, shown here and on the phone */
  sas: string
  address: string
  kind: string
  origin: PhonePeer['origin']
  /** ms epoch it arrived; it expires by itself */
  at: number
}

/**
 * One browser holding a live event stream.
 *
 * Deliberately NOT "a paired device". The cookie is `hmac(deviceId, code)` and therefore
 * identical on every phone that ever typed the code, so there is no per-device identity to
 * remember and nothing to sign out one at a time - see `main/phone.ts`. What can honestly
 * be shown is who is watching RIGHT NOW, which is what this is, and the panel says so.
 */
export interface PhonePeer {
  /** stable while this stream is open; a reconnect is a new one */
  id: string
  /** the address it reached us on, normalised out of IPv4-mapped IPv6 */
  address: string
  /** 'iPhone' / 'iPad' / 'Android' / 'Mac' / 'Windows' / 'Browser' - coarse on purpose */
  kind: string
  /** which side of the front door it came from - see `originOf` in main/phone.ts */
  origin: 'this machine' | 'this network' | 'tailnet' | 'internet'
  /** ms epoch the stream opened, so the panel can say how long it has been up */
  since: number
}

/**
 * A way in from a network that is not this one, without a VPN at either end.
 *
 * `off` and `up` are the settled pair; `fetching` (downloading cloudflared once) and
 * `starting` are transient and carry a budget in `main/tunnel.ts`, because a phase that
 * can be held for ever by a hung child is the one shape that makes somebody reinstall.
 */
export interface TunnelState {
  phase: 'off' | 'fetching' | 'starting' | 'up'
  /** the https address, and only once it has really answered - never on the phase alone */
  url: string
  /** which provider is carrying it; '' when nothing is up */
  via?: 'tailscale' | 'cloudflare' | ''
  /**
   * Whether that address is the same one tomorrow.
   *
   * The whole difference between the two providers, and the only part of it a person
   * needs told: a stable address can be added to a phone's home screen and signed into
   * once, while a cloudflared quick tunnel mints a new hostname per run - a new origin,
   * so a new cookie, so the approval card again on every launch.
   */
  stable?: boolean
  error?: string
}

export interface PhoneState {
  /** the listener is actually up */
  on: boolean
  port: number
  code: string
  /** addresses to type into a phone, tailnet first */
  urls: string[]
  /** browsers holding a live event stream right now */
  clients: number
  /** one per live stream, newest last */
  peers: PhonePeer[]
  /** approved once, allowed back without asking - the list `New code` used to have to be */
  devices: PhoneDeviceView[]
  /** a browser waiting on Approve right now, at most one */
  ask: PhoneAsk | null
  /** whether a browser may ask at all, rather than typing the code */
  asking: boolean
  /** the way in from outside this network, off unless asked for */
  tunnel: TunnelState
  /** is a passkey touch required before a browser may type into a pane */
  typeGate: boolean
  /** the passkeys enrolled, so the panel can show them and take one away */
  keys: PhoneKeyView[]
  /** why it is not up when it should be (a taken port) */
  error?: string
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
  /**
   * Let a device on this network ask to pair, and approve it here by comparing six digits
   * instead of typing the code over there.
   *
   * Optional so a config written by an older build still loads, and defaulted ON: what it
   * grants is the right to put a card on this screen, and the card is refused by default.
   * Switch it off and the listener answers such a request by name rather than silently.
   */
  pairByAsking?: boolean
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
  /**
   * @deprecated The OpenRouter slot of `providerKeys`, mirrored here by `setConfig` so
   * a build rolled back to before that record existed still finds the key. Read
   * `providerKeys.openrouter`; never write this.
   */
  openrouterKey: string
  /**
   * One key per provider, by the id in `KEY_PROVIDERS`, handed to every agent whose
   * `env` asks for it. A missing or blank one means the agent is started with the
   * variable ABSENT rather than empty - see `resolveEnv`, and the 401-inside-a-healthy
   * -pane failure that shape exists to stop.
   */
  providerKeys: Record<string, string>
  /** terminal font size, shared by every pane */
  fontSize: number
  /** a mouse selection in a pane goes straight to the clipboard */
  copyOnSelect: boolean
  /**
   * Alt/Option-click in a pane moves the CLI's cursor to where you clicked, by sending
   * the arrow keys that would have got there. Behind a modifier on purpose: in a plain
   * shell an up-arrow is the previous command rather than a movement.
   */
  clickMovesCursor: boolean
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
   * Send a pane's question to Telegram, so an answer is not waiting on somebody being at
   * this desk. Off by construction on a machine with no bot credentials (`main/askNotify.ts`
   * reads `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` from the environment or from
   * `~/.claude/usage-notify.env`); this switch is for turning it off on a machine that has
   * them. Message only - answering is still a press, here or on the phone client.
   */
  telegramAsk: boolean
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
   * Nothing on screen until it is asked for: no pill in the corner, and the list opens at
   * the POINTER when the key is pressed. On by default. The pill was a window over
   * somebody's work by definition, and it opened on hover - the thing you did not ask for
   * happening while you reach for something else. Off puts the corner pill back.
   */
  stashSummon: boolean
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
   * Clips the Stash must never remember, one rule per line: a case-insensitive substring,
   * or `/regex/` for the real thing. Empty by default and deliberately so - the built-in
   * protection is the copying app's own concealed marker (`shared/conceal.ts`), which is
   * always honoured and is not a guess about the content. Guessing is what this field is
   * for, and it is the user's guess: copying an API key to paste it AT an agent is an
   * everyday move here, so an app that swallowed one by itself would read as broken.
   * A matching clip is never written to disk at all, not written and hidden.
   */
  stashDeny: string
  /**
   * Where the floating Stash was last dragged to, as its bottom-left corner in screen
   * coordinates. Null means the default corner, and it goes back to null if that point is
   * no longer on any display (a monitor unplugged, a resolution changed).
   */
  stashPos: { x: number; y: number } | null
  /**
   * The size the expanded Stash was last resized to by dragging its edges. Null means the
   * built-in size. Clamped to sane bounds on the way in (`shelfWindow.ts`), so a corrupt
   * config cannot draw an unusable window.
   */
  stashSize: { width: number; height: number } | null
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
  /** Windows: put the Desktop shortcut back when a launch finds it missing. */
  desktopShortcut?: boolean
  /** launch elevated with no UAC prompt via the registered scheduled task */
  adminMode: boolean
  /** check GitHub releases in the background and offer the update */
  autoUpdate: boolean
  /**
   * Take every build as soon as it is cut. Automatic releases are GitHub prereleases
   * (the dev channel); a stable install only moves when one is promoted
   * (`lane.mjs promote`). On, this install updates on every build - sooner, less proven.
   */
  devUpdates: boolean
  /**
   * Reopen the panes an update closed. Off means a restart is a clean desk, which
   * is the only way to get rid of a set of panes that otherwise comes back every
   * time the app updates itself.
   */
  restoreAfterUpdate: boolean
  /**
   * Ask before reopening them, so an update restart obeys the same rule as every other
   * restart. Off by default and deliberately so: the app updates itself several times a
   * day, and a dialog that often is worse than the inconsistency it removes. On, the
   * update restart stops being the one restart that never asks.
   */
  askAfterUpdate: boolean
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
  /**
   * When this machine is out of memory, start the next pane on a paired device instead.
   * Only fires when the capacity policy already says so AND that device has the same
   * project - never silently, and never onto a machine that cannot open the folder.
   */
  offloadWhenFull: boolean
  /**
   * Ask before it does, rather than moving the pane and saying so afterwards.
   *
   * On, because where a pane runs is a decision with a reason this machine cannot see:
   * the checkout being edited, the browser pointed at its dev server, the person sitting
   * in front of it. The dialog recommends the paired device (it is the one that fixes the
   * memory), and an answer holds for ten minutes so a burst of launches asks once. Off
   * restores the silent move.
   */
  offloadAsk: boolean
  /** roles offered in the swarm dialog, editable by the user */
  swarmRoles: SwarmRole[]
  /**
   * May the app drive a lane with an agent whose only headless posture is "no prompts"?
   *
   * On, because that is every agent the app can drive (see `HEADLESS` in shared/agentic.ts)
   * and the blast radius is one unmerged branch in a worktree the app made. Off refuses to
   * start a drive or queue a goal at all, and says which flag it refused - K4.
   */
  driveUnattended: boolean
  /**
   * D3 of `docs/agentic-dispatch.md`: where a finished dispatched goal reports to.
   * Empty `reportUrl` turns the POST off entirely; `reportKey` rides as `x-dispatch-key`
   * when the endpoint demands one. The desk never holds the Discord token - the endpoint
   * does the posting and the 24h delete.
   */
  dispatch: { reportUrl: string; reportKey: string }
  /** pairing, hosting and the devices whose panes show up in this window */
  remote: RemoteConfig
  /**
   * Finish a turn the transport cut in half, without being asked - see shared/recover.ts.
   * Optional so a config written by an older build still loads; `getConfig` fills it in.
   */
  recover?: RecoverConfig
  /**
   * Press the obvious answer to an agent's question without being asked - see
   * shared/autoAnswer.ts. Optional so a config written by an older build still loads.
   */
  autoAnswer?: AutoAnswerConfig
  /**
   * Close idle panes when this machine runs out of memory - see shared/reclaim.ts.
   * Optional so a config written by an older build still loads.
   */
  /**
   * The face on the resource ladder - src/shared/mascot.ts. Optional so a config written
   * by an older build still loads.
   */
  mascot?: MascotConfig
  reclaim?: ReclaimConfig
  /**
   * Move finished panes to a paired device when this machine runs out of memory, rather
   * than closing them - see shared/autoHandoff.ts. Sits above `reclaim` on the same
   * ladder: closing is what happens when there is nowhere to move a pane to.
   */
  autoHandoff?: AutoHandoffConfig
  /**
   * Quit the WHOLE app after this many minutes with no input - see shared/idlequit.ts.
   * 0 (the default) is off. Distinct from `reclaim`, which closes single panes: this
   * closes the window and ends the process, so it refuses on a focused window, on any
   * pane that is working/starting/stalled, and on any pane another device is driving.
   */
  idleQuitMinutes?: number
  /**
   * The phone client. Optional so a config written by an older build still loads -
   * `getConfig` fills it in, off, with a fresh code.
   */
  phone?: PhoneConfig
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
  /**
   * How many of `panes` start ticked. Fewer than all of them when the machine is already
   * short of memory: restoring is the one moment N agent CLIs start in one tick, and that
   * is what "six panes came back and I cannot type" was. A preselect, never a cap.
   */
  fits: number
  /** Why fewer than all are ticked. Empty when everything fits. */
  memoryNote: string
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
  /**
   * This app put it on the clipboard: a pane copying on select, Ctrl+C over a highlight,
   * or the Stash's own Copy button. It is still stashed - it is a thing you copied - but
   * it never makes the Stash open by itself, because you were reading a pane, not asking
   * for a list. See `noteOwnCopy` in main/recents.ts.
   */
  own?: boolean
}

/**
 * The slice of Config the floating overlay is allowed to read and write from its own
 * settings panel. It is a window that sits over every other app, so it gets the Stash's
 * own knobs and nothing else - no roots, no agents, no shell.
 */
export type StashConfig = Pick<
  Config,
  | 'stashSummon'
  | 'stashPeekMs'
  | 'stashAutoCloseMs'
  | 'stashMaxItems'
  | 'stashMaxImages'
  | 'stashFileHours'
  | 'stashMaxFileMb'
  | 'stashDeny'
  | 'clipboardOverlay'
  // Read-only here, and deliberately absent from STASH_CONFIG_KEYS below: the overlay
  // draws the app's colours and may not change them. Without this the floating Stash was
  // the one surface in the app with a palette of its own - a cold blue on a warm orange
  // theme, and dark while the app was on Paper - because it followed the OS's dark mode
  // instead of the accent everything else is derived from.
  | 'theme'
>

/** Exactly the keys the overlay may patch. Anything else on the wire is dropped. */
export const STASH_CONFIG_KEYS = [
  'stashSummon',
  'stashPeekMs',
  'stashAutoCloseMs',
  'stashMaxItems',
  'stashMaxImages',
  'stashFileHours',
  'stashMaxFileMb',
  // `stashDeny` is deliberately NOT here even though the overlay is sent it: the overlay
  // is `focusable: false`, so there is no way to TYPE a rule into it. It is read-only
  // there for the same reason `theme` is - the panel can say what the rules are, and
  // Settings in the main window is where they are changed.
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
  /**
   * Quit the app because nobody has used it for a while. The renderer owns the clock
   * (it is the side that knows about keyboard input and focus); main only obeys, and
   * leaves the marker that stops the keep-alive task reopening what was closed on purpose.
   */
  quitIdle(reason: string): Promise<void>
  write(id: string, data: string): void
  /**
   * Put a job in a pane's prompt box and press Enter, properly.
   *
   * `write(id, text + '\r')` does NOT submit: the CLIs here run with bracketed paste on,
   * so a burst that size arrives as pasted text and the trailing return is one more
   * character of it. The text then sits in the composer waiting for a person. This goes
   * through the main process, which waits for an idle composer, sends the return as its
   * own keystroke, and re-sends it if the pane is still idle after (sessions.ts
   * `queuePrompt`). Use it for anything the app hands a chat unattended.
   */
  sendPrompt(id: string, text: string): void
  /** send the same line to every live session */
  /**
   * `borrowed` is a phone saying "this is my screen's size, not the desk's". One pty
   * cannot be two shapes, so a phone that opens a pane bends it to a phone and the desk
   * gets the size back the moment the phone looks away - see `returnSizes` in sessions.ts.
   */
  resize(id: string, cols: number, rows: number, borrowed?: boolean): void
  /** the phone has stopped looking: every borrowed pty goes back to the desk's shape */
  returnSize(): void
  /**
   * Which panes this client currently has on screen, and who this client is.
   *
   * A hint, and only ever a performance one: output for a pane nobody is looking
   * at is gathered for longer before it is sent (see `dataPump.ts`), which is most
   * of the IPC traffic on a desk with several panes open. Every byte still arrives,
   * in order, and a pane named here is flushed at once - so being wrong about this
   * costs a tenth of a second of staleness on a pane that is off screen anyway.
   *
   * `client` is this window's or browser's own id, and it is what keeps two phones
   * from erasing each other. Re-state the claim on a timer: it expires, which is the
   * only thing that copes with a screen that goes away without saying so.
   */
  paneVisibility(client: string, ids: string[]): void
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
   * Further back than `getBuffer` can reach: the last `bytes` of this pane's transcript,
   * ANSI and all, straight off the log on disk.
   *
   * The live replay is capped at 400 KB because it is held in memory for every pane, and
   * on a phone that cap is most of the problem: an agent's "thinking" animation is
   * thousands of repaint frames, so 400 KB of a working Claude pane is a couple of
   * minutes and everything said before it is unreachable there - the desk still has it
   * only because its terminal accumulated the lines live. The log on disk holds up to
   * 8 MB per pane, so this is where "I can't see the output before a certain point" is
   * answered. Raw, not stripped: it is rendered through a terminal at the other end.
   */
  paneLog(id: string, bytes?: number): Promise<string>
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
  /**
   * Save files where the agent in `sessionId` can open them, and answer with the paths.
   *
   * The paths are on the machine that owns the pty, which is the whole point: a mirrored
   * pane's agent runs on the other device, so the bytes go over the link and are written
   * there. See `src/shared/attach.ts`.
   */
  /**
   * Answer the question on a pane by number, as if somebody had arrowed to it.
   *
   * The number is the one the CLI printed. It resolves false when the pane is not on
   * that question any more - a chooser that has been answered from the desk in the
   * meantime must not have a stale button press land on whatever replaced it.
   */
  chooseOption(sessionId: string, n: number): Promise<boolean>
  attachFiles(sessionId: string, files: AttachIn[]): Promise<AttachResult>
  /**
   * The same, for whatever image is on the clipboard of the device the window is on.
   *
   * `readClipboard` answers '' for an image, and forwarding a raw ^V only works for an
   * agent that reads the clipboard itself AND runs on this machine. This works for every
   * agent and for a mirrored pane.
   */
  attachClipboardImage(sessionId: string): Promise<AttachResult>
  /**
   * Put image bytes on the clipboard of the device this window is on, so a raw ^V can
   * hand them to an agent that reads images off the clipboard itself.
   *
   * The one thing that turns a dropped screenshot into an attached IMAGE rather than a
   * path typed at the prompt. Answers false when the bytes are not an image any decoder
   * here can read, which is the caller's cue to fall back to the path.
   */
  putImageOnClipboard(src: {
    data?: string
    path?: string
    /** decode only - answer whether this IS an image, and leave the clipboard alone */
    probe?: boolean
  }): Promise<boolean>
  /** True only for the private clipboard fixture used by the disposable Electron probe. */
  clipboardFixtureActive(): Promise<boolean>
  /** branch + dirty count for a folder; null when it is not a repo */
  gitInfo(path: string): Promise<GitInfo | null>
  /** the changed files in a folder, for one scope. Cheap; no patches are read. */
  diffFiles(cwd: string, scope: DiffScope): Promise<DiffSet>
  /** one file's patch, read when that file is selected */
  diffPatch(cwd: string, scope: DiffScope, path: string, untracked: boolean): Promise<DiffPatch>
  /** one board per lane-using repo the open panes are in; empty on a machine without one */
  laneBoard(): Promise<LaneBoard[]>
  /** what is in a pane's worktree lane; null when the folder is not a lane */
  laneWork(cwd: string): Promise<LaneWork | null>
  /** merge a worktree lane back into the branch it came from */
  mergeLane(cwd: string): Promise<LaneMergeResult>
  /** a pane was sent back to its project folder because its lane held nothing */
  onLaneMoved(cb: (id: string, message: string) => void): () => void
  /** A queued handoff finished, failed, or gave up waiting - said on screen, not only logged. */
  onHandoffMoved(cb: (message: string) => void): () => void
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

  /**
   * The same plan, driven by the app instead of by a person: no panes, one headless
   * agent per lane, each verified before it is called finished. Never merges - see
   * `docs/agentic.md`. Returns as soon as the run exists, not when it finishes.
   */
  startDrive(req: DriveRequest): Promise<DriveRun>
  /** Stop one run now, mid-command if need be. */
  stopDrive(id: string): Promise<boolean>
  /** Stop every live run. The one switch. */
  stopAllDrives(): Promise<number>
  listDrives(): Promise<DriveRun[]>
  /** Forget the finished ones. Memory only. */
  clearDrives(): Promise<number>

  /**
   * The queue a driven plan goes into rather than starting on the spot (I4).
   *
   * The difference from `startDrive` is everything that happens when nobody is watching:
   * a goal is on disk, so it survives a restart; a second one waits rather than fighting
   * the first for worktrees; and when it ends it says what it turned into. Prefer this to
   * `startDrive` for anything a person is not about to sit and watch.
   */
  addGoal(req: DriveRequest): Promise<Goal>
  listGoals(): Promise<Goal[]>
  /** Stop it, whether it is running or still in the line. */
  cancelGoal(id: string): Promise<boolean>
  /** Put a finished, cancelled or interrupted goal back in the line, keeping its attempts. */
  retryGoal(id: string): Promise<boolean>
  /** Drop one finished goal from the file. */
  removeGoal(id: string): Promise<boolean>
  clearGoals(): Promise<number>

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
   * Everything on the Stash matching every word of `q`, newest first; the newest 60 for
   * an empty query. It is a main-process search on purpose: the lists a window is handed
   * have had the bodies stripped out of them, so a filter here would only ever match a
   * clip's first 140 characters - and the clip nobody can find by its opening line is the
   * four-thousand-line log.
   */
  searchRecents(q: string): Promise<RecentItem[]>
  /**
   * The body of one stash entry. The list arrives without them - a full history is 383KB
   * of text nothing on screen shows - so the one click that types a clip into a pane
   * fetches that clip.
   */
  recentText(id: string): Promise<string>
  /**
   * Correct a text entry in place, keeping its position and its pin. For the moment a
   * copied path names the wrong branch: the thing you copied, fixed, not a new thing.
   * The OS clipboard is deliberately left alone - editing a stash entry is not a copy.
   */
  editRecent(id: string, text: string): void
  /** put a shelf item back on the OS clipboard */
  copyRecent(id: string): void
  /** hand an image item to the OS drag layer, so it can be dropped in any app */
  dragRecent(id: string): void
  /** forget one item - the clipboard is where a password lands by accident */
  removeRecent(id: string): void
  clearRecents(): void
  /**
   * The main window's Stash just opened, or closed. There is one Stash, so while this is
   * true the floating overlay stays a pill: it draws above every window, including the
   * one holding the list that can actually be typed into.
   */
  stashInWindow(open: boolean): void

  /**
   * The phone client: whether this desk is serving its UI over HTTP, on what addresses,
   * and how many browsers are watching right now. See `main/phone.ts`.
   */
  phoneState(): Promise<PhoneState>
  /** start or stop serving. Never on by itself - it grants a browser a pane. */
  setPhoneServing(on: boolean): Promise<PhoneState>
  /** move the listener; returns the state with the error if the port is taken */
  setPhonePort(port: number): Promise<PhoneState>
  /** new pairing code: every phone holding the old cookie is signed out */
  rotatePhoneCode(): Promise<PhoneState>
  /**
   * Reachable from outside this network, through a Cloudflare quick tunnel. The first
   * `true` downloads cloudflared once and can take a minute, so the answer comes back as
   * soon as the phase is known and the rest arrives on `onPhone`.
   */
  setPhoneTunnel(on: boolean): Promise<PhoneState>
  /**
   * Answer the browser waiting on this desk. `true` mints it a secret of its own, so it
   * comes back signed in without asking again; `false` refuses and says so over there.
   */
  answerPhoneAsk(ok: boolean): Promise<PhoneState>
  /** sign one approved device out. Its cookie stops working at once. */
  forgetPhoneDevice(id: string): Promise<PhoneState>
  /**
   * Dismiss what was noticed about one device - "that was me". Desk-only: refused over
   * HTTP, because a warning a stolen cookie can clear about ITSELF is not a warning.
   */
  clearPhoneMark(id: string): Promise<PhoneState>
  /** whether a browser may ask to be let in at all, instead of typing the code */
  setPhoneAsking(on: boolean): Promise<PhoneState>
  /** Require a passkey touch before a browser may type. Desk-only: refused over HTTP. */
  setPhoneTypeGate(on: boolean): Promise<PhoneState>
  /** Remove one enrolled passkey, or every one with '*'. Desk-only: refused over HTTP. */
  forgetPhoneKey(id: string): Promise<PhoneState>
  /** the count and the addresses change without anybody asking */
  onPhone(cb: (state: PhoneState) => void): () => void

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
  /**
   * Ask a device on this network to let this one in, with no code typed anywhere.
   *
   * Resolves only once somebody has answered over there, which can be a minute or two -
   * the six digits to compare arrive long before that, on `RemoteState.waiting`, because
   * comparing them is what the person does while this is still pending.
   */
  askToPair(peer: { address: string; port: number; name?: string }): Promise<{
    ok: boolean
    error?: string
    state: RemoteState
  }>
  /** Answer the request on THIS device's screen. Anything but true is a refusal. */
  answerPair(ok: boolean): Promise<RemoteState>
  /** Stop waiting on a request this device sent. */
  cancelAsk(): Promise<RemoteState>
  /** whether this device will put a pairing request on screen at all */
  setPairByAsking(on: boolean): Promise<RemoteState>
  forgetRemote(id: string): Promise<RemoteState>
  /** connect to or disconnect from a device already paired */
  connectRemote(id: string, on: boolean): Promise<RemoteState>
  /** ask the LAN who is there, now, rather than waiting for the next announcement */
  scanRemote(): Promise<RemoteState>
  /**
   * Choose which of a device's panes this window mirrors - `ids` are ITS ids, and the
   * list replaces the previous pick. `all` mirrors everything it has, now and later.
   * Connecting mirrors nothing until this is called.
   */
  watchRemote(device: string, ids: string[], all?: boolean): Promise<RemoteState>
  /** that device's own project folders, so a pane can be opened over there */
  remoteProjects(device: string): Promise<Project[]>
  /** the CLIs installed on that device - its list, not this one's */
  remoteAgents(device: string): Promise<AgentInfo[]>
  /** open a pane on that device; it appears here mirrored, like the rest of its panes */
  startRemote(device: string, req: StartSessionRequest): Promise<Session>
  /**
   * Move live panes TO that device: code via the git remote, conversation and
   * screen over the link. Each pane closes here only once its replacement is
   * running there; the report says per pane what carried and what refused.
   */
  handoffToDevice(
    device: string,
    ids?: string[],
    closeReceiverWhenDone?: boolean,
    /** false moves a pane mid-turn and loses the answer being written. Default true. */
    waitForTurn?: boolean
  ): Promise<HandoffItem[]>
  /** Panes waiting for their turn to end before they move - see shared/autoHandoff.ts. */
  handoffPending(): Promise<{ id: string; device: string; deviceName: string; since: number }[]>
  /** Stop waiting on one. The pane stays here, unmarked. */
  cancelHandoff(id: string): Promise<boolean>

  /** is there a CLI on PATH that can run the improver, and where would knowledge come from */
  /** The best earlier ask this draft repeats, or null. Cheap: a scored lookup, no search. */
  priorPrompt(draft: string): Promise<PriorPrompt | null>
  /** Record that a draft was actually sent. Fire-and-forget. */
  promptUsed(draft: string, meta: { cwd?: string; agent?: string; id?: string }): void
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
  /** A driven run moved: a lane changed state, or its progress line changed. */
  onDrive(cb: (run: DriveRun) => void): () => void
  onGoals(cb: (goals: Goal[]) => void): () => void
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
  /** A pane has just put a NEW question on screen (the arrow moving is not one). */
  onAsk(cb: (s: Session) => void): () => void
  /** the pane's terminal rang its bell; reported from the renderer, which parses it */
  paneBell(id: string): void
  /** hosting, pairing or discovery changed */
  onRemote(cb: (s: RemoteState) => void): () => void
  /** What this machine can still hold - see src/shared/capacity.ts. */
  onCapacity(cb: (v: Verdict) => void): () => void
  /**
   * What the panes are costing right now, measured rather than modelled - see
   * src/shared/usage.ts. Pushed every few seconds while a window is on screen.
   */
  onUsage(cb: (r: UsageReport) => void): () => void
  /** The last reading, for a window that opened between samples. Null before the first. */
  usage(): Promise<UsageReport | null>
  /**
   * The dev servers running on this machine right now, attributed to panes.
   *
   * The caller passes the sidebar's own ordering and words - which pane is number 3 and
   * what that project is called - and nothing else: the folder and the pty pid are read
   * in main off the pane's own record, so this cannot be pointed at a folder the caller
   * does not own. One process-table read per call, on demand.
   */
  listDevServers(panes: Array<{ id: string; pane: number; name: string }>): Promise<RunningDev[]>
  /** Stop one of them, and the tree under it. Re-validated in main - a pid is reused. */
  stopDevServer(pid: number): Promise<{ ok: boolean; why?: string }>
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
   * The floating overlay's magnifier was pressed. It cannot be typed into itself - it is
   * `focusable: false`, which is the reason clicking a row leaves your keyboard where it
   * was - so searching happens in this window, which the press has already raised.
   */
  onStashSearch(cb: () => void): () => void
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

/** Which edge (or corner) of the Stash a resize grabbed. */
export type ShelfEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

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
  /**
   * A drop that carries bytes and no path - an image dragged out of a browser, a file
   * from an app that hands over data rather than a file. Main parks the bytes as a file
   * and stashes that, so the same drop works wherever it came from.
   */
  addData(name: string, data: ArrayBuffer): Promise<number>
  /** the full body of a text clip, on demand - the list never carries it */
  text(id: string): Promise<string>
  /** the overlay's + button: an OS file picker, then the same */
  pick(): Promise<number>
  /** absolute path of a dropped File, which Electron only exposes in a preload */
  pathForFile(file: File): string
  /** type it into PaneForge's focused pane instead of the clipboard */
  /** `focus` raises the main window too. Off by default: the overlay exists to leave
   *  the keyboard where it was. */
  toPane(id: string, focus?: boolean): void
  focusApp(): void
  /**
   * Hand searching to the main window and raise it. A press on this button is a person
   * asking for the app, which is the one thing allowed to take the screen - and it is
   * the only way there is: an unfocusable window cannot be typed into.
   */
  openSearch(): void
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
  /**
   * Resize the window by dragging any edge or corner. Same shape as the drag: the page
   * reports pointer travel in screen pixels, main does the bounds arithmetic and
   * remembers the size (`stashSize`) so the Stash reopens at the size it was left.
   */
  resizeWindow: {
    start(edge: ShelfEdge): void
    move(dx: number, dy: number): void
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
