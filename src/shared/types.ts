import type { FrameMeta, LoginInput, LoginRequest } from './remoteLogin'

import type { AutoClearAsk } from './autoclear'
import type { SplitAnswer } from './splitPlan'
import type { Away } from './away'
import type { LinkState } from './linkState'
// Types shared by the Electron main process and the React renderer.
// Keep this file dependency-free: it is imported from both sides of the IPC bridge.

import type { ActivityEntry } from './activity'
import type { AttachIn, AttachResult } from './attach'
import type { BackJob } from './backJobs'
import type { Verdict } from './capacity'
import type { AutoAnswerConfig } from './autoAnswer'
import type { MascotConfig } from './mascot'
import type { TipsConfig } from './tips'
import type { DeadDevConfig, StopSoon } from './deadDev'
import type { RecoverConfig } from './recover'
import type { AutoHandoffConfig } from './autoHandoff'
import type { AutoClearConfig } from './autoclear'
import type { PaneTrustConfig } from './paneTrust'
import type { ReclaimConfig } from './reclaim'
import type { UsageReport } from './usage'
import type { RunningDev } from './devList'

import type { AgentInfo, AgentSpec } from './agents'
import type { DiscordStyle, PresenceStatus } from './discordRpc'
// Same type-level-only cycle as goals: handoff.ts imports Session from here.
import type { HandoffItem } from './handoff'
import type { DeviceMark } from './deviceWatch'
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
  /**
   * This row is a CLIENT, not a project: a folder under the projects root's own `clients`
   * roster, whose `name` reads `Alison | clients` so the list says who it is and where it
   * lives in one line. The value is the client's own name.
   *
   * They are rows in the same list on purpose. Everything the launcher already does -
   * type to filter, tick several, Enter, a message that picks the folder - then works on
   * a client with no second list to learn (Robert, 2026-09-04: "i can make a clients
   * session called alison and then when i click new session alison | clients would popup
   * so i know that its part of clients").
   */
  client?: string
}

/**
 * The turn clock read straight off the agent's own footer: how long IT says the turn
 * has been running, and how coarsely it printed that (`24m 3s` is second-accurate,
 * `24m` says nothing about the seconds). Defined next to the reader that produces it.
 */
import type { BusyReason, TurnClock } from './busy'
export type { TurnClock }
import type { PaneAsk } from './choices'
export type { PaneAsk }

/**
 * A pane that has just been renamed for the client it turned out to be working for.
 *
 * The rename happens first and the card reports it, rather than the card asking first: a
 * question in the corner of a window that is often behind something else is a question
 * nobody answers, and the answer this one wants is "yes" every time it is right. So the
 * cheap direction is the automatic one, and `was` is what Cancel puts back.
 */
/** The activity list plus when it was last looked at, so a badge can count what is new. */
export interface ActivityFeed {
  items: ActivityEntry[]
  seenAt: number
}

export interface ClientNamed {
  id: string
  /** the client's folder name, so a caller can tell two renames apart */
  slug: string
  /** what the pane is called now */
  title: string
  /** what it was called a moment ago - `basename(cwd)` */
  was: string
  /**
   * `folder` is evidence, `prompt` is a client read out of what was typed, and `topic` is
   * the subject of the first ask when it named no client at all.
   */
  from: 'folder' | 'prompt' | 'topic' | 'reply'
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
  /**
   * Epoch ms of the FIRST byte this process printed, and undefined until it does.
   *
   * Not `lastOutput`, which is stamped at start so that every idle reading has a clock to
   * count from. This one answers "has the CLI in this pane said anything yet", which is the
   * only honest way to tell a pane that is still booting from one that is sitting there
   * finished - a RESTORED pane already has a full screen of yesterday's output on it, so
   * "the terminal is empty" stopped being that reading the moment scrollback came back.
   * Reset by anything that spawns a new process into the pane (restart, wake).
   */
  printed?: number
  /** epoch ms of the most recent user input (prompt submission, keystrokes); used for idle detection */
  lastKeyboard: number
  /** An unsent prompt exists, or the app cannot prove that the composer is empty. */
  drafting?: boolean
  createdAt: number
  /**
   * When this PANE first appeared on the desk, across every restart since - which is not
   * `createdAt`, the age of this process. Three timers read `createdAt` as process age
   * (the starting->idle flip, the attention rule, the stall rule), so the display clock
   * gets a field of its own rather than back-dating theirs.
   */
  openedAt?: number
  exitCode?: number
  /**
   * The client this pane was recognised as working for, when it was - the folder slug out
   * of `shared/clientName.ts`. Set once and kept: it is what stops the prompt reading
   * asking the same question of every line typed afterwards, and what a second reading
   * compares against when the pane moves to another client's folder.
   */
  clientSlug?: string
  /**
   * This pane asked not to be named for a client. Set by Cancel on the card, and by
   * nothing else - a person undoing the rename is stating that the reading was wrong,
   * which is the one fact here that outranks the folder.
   */
  clientOff?: boolean
  /**
   * Which reading named this pane, when one did. `topic` is a guess off the first prompt
   * and may be replaced by a `client` identified later; `client` is final, and a title a
   * person typed carries neither and is never touched.
   */
  autoTitled?: 'client' | 'topic'
  /**
   * Epoch ms since this pane's `cwd` stopped existing on disk, unset while it is there.
   * A live pane keeps running (its shell falls back to $HOME); an EXITED one whose folder
   * has been gone for a minute is a card about nothing and gets reaped by `sweepIdle`.
   */
  cwdGone?: number
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
  /**
   * True while that press is being HELD because somebody is at this window.
   *
   * Separate from `autoAnswerAt` rather than encoded as a large one: a held question has no
   * deadline at all - it starts a fresh `waitMs` the moment the window is left - so a
   * countdown is the one thing that must not be drawn for it. What the pane draws instead
   * is the option it WOULD press and the reason nothing is happening.
   */
  autoAnswerHeld?: boolean
  /**
   * When the idle clock will CLOSE this pane, epoch ms, or absent when nothing will.
   *
   * Published by the desk that owns the pty (`shared/reclaim.ts`'s `idleCloseAt`), never
   * derived by a viewer: the deadline is a fact about the owner's settings and its own
   * refusals - which pane is focused over there, whether a shell job is still running -
   * and a second machine guessing at it would draw a countdown nobody is going to honour.
   */
  closingAt?: number
  /**
   * The deadline above is a HOLD, not the idle clock.
   *
   * "Keep it open" parks a pane for an hour, and the publish takes the later of the two
   * numbers - so a held pane drew `closes 55m` under a sentence saying it had been quiet
   * and was being closed to give its memory back. Same chip, opposite fact. The card says
   * `kept 55m` for this and explains the hold instead.
   */
  closeKept?: boolean
  autoAnswerN?: number
  /**
   * When this session will /clear ITSELF, epoch ms, and what it will ask the fresh one.
   *
   * Armed by the `autoclear` Stop hook once context is past its line and a handoff on disk
   * lists steps a fresh session could start on. On the session rather than in a map of its
   * own because every refusal that drops it - a keystroke, another turn, a live question -
   * is already a fact about the session, and a countdown nobody can see is the bug this
   * replaced. See `shared/autoclear.ts`.
   */
  autoClearAt?: number
  /**
   * This pane is mid-autoclear handover until this epoch ms, if it is.
   *
   * The window between the app typing `/clear` and the resume prompt landing. It is a
   * DEADLINE rather than a flag so the curtain over the terminal takes itself down when
   * the clock runs out, whatever main did or failed to do.
   */
  handoverUntil?: number
  autoClearPrompt?: string
  autoClearSteps?: string[]
  /**
   * The exact keystrokes the countdown will send, frozen when it was armed.
   *
   * Not recomputed when the timer fires: the command differs per CLI (`/new` in Codex),
   * and re-deriving it at the last moment from a prompt string is how the app and the hook
   * ended up with two copies of one contract. What was decided is what is typed.
   */
  autoClearChunks?: string[]
  /**
   * Nothing is open - this is context being freed, not work being carried on.
   *
   * The card says a different sentence for it, because "clearing and carrying on from its
   * handoff" over an empty prompt is a promise the clear does not keep.
   */
  autoClearNoResume?: boolean
  /** Roughly how much context the clear frees, when a watcher measured it. */
  autoClearTokens?: number
  /**
   * How the last countdown ENDED ("cleared", or "stood down - ..."), shown ~5s.
   *
   * ADDENDUM 2026-08-27: a countdown that stood down used to just vanish - or worse,
   * freeze at 0:00 - and nobody watching could tell which of the two the app decided.
   * The outcome is a fact about the session for the same reason the countdown is.
   */
  autoClearOutcome?: string
  autoClearOutcomeAt?: number
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
  /**
   * What this pane was asked to do, in one line - the same reading History puts under a
   * closed session (`shared/gist.ts`), for the surfaces that talk about a LIVE pane.
   *
   * On the session rather than fetched when wanted because the thing that needs it is a
   * sentence about a pane that is being closed: by the time anything could read it off
   * disk, the pane it is about is gone. Free by construction - it is keystrokes the app
   * already relays on their way to the pty, never a summary anything was paid for - and
   * absent for a pane nobody has typed a real ask into yet, which is said as nothing
   * rather than as a guess.
   */
  gist?: string
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
   * The width the RESTORED part of this pane's buffer was painted at, when it has one.
   *
   * A reopened pane replays the log of the pane it is coming back from, and those bytes
   * are absolute cursor moves made in that pane's width - so the terminal has to be that
   * width while they are written, or the old screen piles up on its right-hand edge and
   * no repaint can ever repair it. Set once at start and never moved: the restore mark in
   * the buffer is where it stops applying. See `shared/replayWidth.ts`.
   */
  replayCols?: number
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
   * When this pane was QUEUED for a move, if it is queued rather than in transit.
   *
   * The two states looked identical on the card - one chip reading `moving` - and they are
   * not the same fact at all. A transfer is measured in seconds (2.3 s between this Mac and
   * the PC, and most of that has since been taken out); a queued pane is waiting for its
   * own turn to end, which is however long the agent takes - a ten-minute build is ten
   * minutes of a chip saying `moving`. Three panes sat like that on 2026-08-23 and read as
   * a broken handoff. Absent while a real transfer is in flight.
   */
  handoffQueuedAt?: number
  /**
   * What the move is doing right now - `pushing the repo`, `sending to Roberts-MacBook-Pro`
   * - while a transfer is in flight. A bare `moving` for a minute reads as a broken move;
   * this is the sentence that says which half is slow. Absent while queued, and gone with
   * `handingOff`.
   */
  handoffStage?: string
  /** When the pane was first painted as on its way - the clock the chip counts from. */
  handoffSince?: number
  /**
   * The device that handed this pane here, when one did - see `StartSessionRequest`.
   * Read by the local-pane budget, which may not send it straight back where it came from.
   */
  arrivedFrom?: string
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
  /**
   * How many times a person has had to step in on this pane - answered a question the app
   * would not answer, typed into a turn that was running, or said what to do next.
   *
   * A7 of the autonomous-task milestone: the target is a NUMBER (0-2 per feature) and
   * nothing measured it. `shared/interventions.ts` decides what counts; an `app` write -
   * a queued prompt, an autoclear, an auto-answered question - never does.
   */
  interventions?: number
  /** This pane's output is being teed to a file as it runs. See `main/pipe.ts`. */
  piping?: PipeInfo
  /**
   * The turn is still running and the pane has printed nothing since this moment -
   * long enough that something is wrong. Undefined the instant it speaks again.
   */
  stalledSince?: number
  /** The terminal rang its bell and nobody has looked at the pane since. */
  bell?: boolean
  /**
   * The command running in this pane's foreground, when it is a SHELL pane running one.
   *
   * A shell pane has neither of the readings an agent pane has - no prompt this app
   * watched being submitted, no CLI footer saying it is busy - so `npm run build` typed
   * into one read as `ready - type to start` for the whole two minutes it took. This is
   * the pty's own foreground process (`shared/paneJob.ts`), which is what puts the pane
   * in Running with a clock counting the command rather than nothing at all.
   */
  job?: string
  /**
   * What this pane is still RUNNING with its turn over, when the app can name one.
   *
   * `shared/paneBackJobs.ts`'s reading, forwarded onto the session so the sessions list
   * can sort by it. An agent that starts work in the background - a `run_in_background`
   * shell, a Monitor loop, a build - goes quiet the moment the turn ends: the CLI's
   * footer stops, `engaged` drops, and the pane sorted into `Your move` while a shell
   * subtree under it was still going. That is a pane nobody has to act on.
   *
   * It reaches `fleetState` and NOTHING else. It is deliberately not `job`, which feeds
   * `busyOnScreen`: a false reading there is a pane the idle sweep never closes, a budget
   * that never moves and a clock that lies, and this one is a heuristic over a process
   * table. Being wrong here costs a heading.
   */
  backJob?: string
  /** Epoch ms that job started, so the row's clock counts the job and not the silence. */
  backJobSince?: number
  /**
   * A phone or the other desk's mirror is drawing this pane right now - a live size borrow
   * (`shared/paneSize.ts`), renewed every 30s and dropped at `BORROW_TTL_MS`. The idle
   * sweeps refuse it (`ReclaimPane.watched`): on a desk nobody sits at it is the only
   * reading of "somebody is looking at this".
   */
  watched?: boolean
  /**
   * How many steps this pane's handoff still lists as open, or undefined when it has no
   * handoff at all.
   *
   * `0` and `undefined` are DIFFERENT answers and the difference is the whole point: `0`
   * is a session that wrote `## Next steps` / `None` and is finished, `undefined` is a
   * pane that has never written one and about which nothing is known. A chip that read
   * them the same would mark every ordinary pane as done.
   *
   * Like `backJob` it ranks and decorates and reaches no BUSY reading - a handoff is a
   * file somebody wrote minutes ago, never evidence about what the pty is doing now.
   */
  handoffOpen?: number
  /**
   * Epoch ms this pane was put to sleep: the pty is gone and the card is not.
   *
   * A sleeping pane carries `status: 'exited'` as well, deliberately - every guard in
   * this app that asks whether a pane has a live process already reads that word, and a
   * fifth `SessionStatus` would have had to be added to each of them one at a time. This
   * field is what separates the two: an exited pane is a run that ENDED, a sleeping one
   * is a pane somebody is keeping. See `shared/sleep.ts`.
   */
  asleep?: number
  /**
   * Why the pane is asleep. `manual` is a press on its own menu; `idle` the idle sleep
   * clock; `pressure` the app giving memory back while the desk was full; `queued` a
   * pane created past capacity that has never run yet (its launch prompt is KEPT). Only
   * `pressure` and `queued` are woken again by the app on its own (`shared/wakePlan.ts`).
   */
  asleepReason?: SleepReason
}

export type SleepReason = 'manual' | 'idle' | 'pressure' | 'queued'

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

/**
 * One row of a batch launch, one per request and in the same order, so a row can always
 * be paired with the folder that was asked for. A batch that simply came back SHORT left
 * the window guessing which folder was missing and why - it said "it may not be on this
 * machine any more" about a folder that was really refused for another reason entirely -
 * and left `pf open-many` printing `refused <cwd>` with no reason at all.
 */
export interface StartedPane {
  /** The folder that was asked for. Not where the pane landed - that is `session.cwd`. */
  cwd: string
  /** The pane, when one opened. */
  session?: Session
  /** Plain words for a person: why this folder got no pane. Only set when none opened. */
  why?: string
}

export interface StartSessionRequest {
  cwd: string
  /**
   * Set by the remote host on a start that arrived over the link: the address the asking
   * desk connected from. The pane is told where that desk's Chrome is (`PF_CHROME_CDP`,
   * `shared/peerChrome.ts`); a local start carries none.
   */
  fromAddress?: string
  title?: string
  agent?: Agent
  model?: string
  /**
   * Which machine the person picked in the New session dialog, when a paired one was
   * online to pick. Absent = let `shared/offloadFirst.ts` decide.
   */
  where?: 'local' | 'remote'
  /**
   * A NAMED paired device to start on (its id or its name as shown in Devices). Beats
   * `where`; a device that is not online refuses the pane by name, never falls back.
   */
  device?: string
  /** resume the most recent session in that directory (`claude --continue`) */
  resume?: boolean
  /**
   * Resume THIS conversation rather than whichever is newest in the folder. Written into
   * the desk when the pane's own transcript could be named, and dropped again if that
   * transcript is gone by the time the panes are offered back.
   */
  resumeId?: string
  /**
   * If a pane is already open in this folder, go to that one instead of opening a second.
   *
   * Off everywhere by default, because opening two panes on one project is an ordinary
   * thing to want. A CLIENT row is the exception: the whole reason it is in the list is to
   * be the one place that client's work happens, and picking Alison twice in a morning
   * should land in the same chat both times - "if theres already existing lane it would
   * just open that again just like with history" (Robert, 2026-09-04).
   */
  reuse?: boolean
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
  /**
   * Open this pane with no process behind it: the card, its place and its screen, and
   * nothing running. A press wakes it in the conversation `resumeId` names - the same
   * path `sleep()`/`wake()` already use, see `shared/sleep.ts`.
   *
   * Set by a restore (`shared/restoreTurn.ts`'s `restoreAsleep`) and by a pane that was
   * asleep when the app went down. Never by a fresh launch: somebody who opened a pane
   * asked for the agent in it.
   */
  asleep?: boolean
  /**
   * Close this pane once the work it was opened for is finished.
   *
   * For a pane opened by AUTOMATION (`pf open --close-when-done`): a brief is typed in, the
   * agent does it, and the card then sits on the desk for ever because nobody was watching
   * to close it. Never set by a person opening a pane - somebody who opens a pane is in it.
   *
   * "Finished" is the sweep's reading and not the turn ending, deliberately: the pane must
   * have printed, be out of its turn, hold no question, and be running nothing - including
   * a background job an agent left behind, which is sampled every four seconds and so is
   * not known at the moment the turn ends. See `CLOSE_DONE_QUIET_MS`.
   */
  closeWhenDone?: boolean
  /**
   * The pane to tell when that happens - an id or a title, resolved when it is needed
   * rather than when the pane opens, because the opener may have gone by then.
   *
   * The message goes through `queuePrompt`, which waits for an idle composer, so it lands
   * between the opener's own turns rather than inside one.
   */
  reportTo?: string
  /**
   * The device this pane was handed over FROM. Set only by `receiveHandoff`.
   *
   * It exists for one refusal: the local-pane budget may not hand a pane straight back to
   * the machine that just handed it here. Two desks that each keep two agents are each
   * right about their own budget, and between them they would pass one pane back and
   * forth for ever - the one failure mode of a policy that fires while nothing is wrong.
   */
  arrivedFrom?: string
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
  /**
   * What the chat holding it is CALLED - the name on its card, after any rename.
   *
   * Every row on the lane strip belongs to a chat that is not a pane in this window, so
   * the one thing no card can say about it is what it was. A folder and a letter answered
   * "which checkout" and never "which job", which is the question actually being asked of
   * a list of seven. Filled in from the history file the chat left behind (main/history.ts
   * `chatNameFor`), matched on the conversation id the lane recorded; absent when that
   * chat left no history, and then nothing is drawn rather than a guess.
   */
  chatTitle?: string
  /** the first thing that chat was asked to do, when its history kept one */
  chatAbout?: string
  /** a live chat holds it right now */
  held: boolean
  /**
   * Held by a chat that no running copy of the app is hosting and that has been silent
   * past the reclaim window - the next sweep gives it back. The strip draws no row for it
   * unless it is also conflicted or ready (main/laneBoard.ts `markGone`).
   */
  gone?: boolean
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
  /**
   * Why the finished work has not gone out yet, as the release gate itself last answered
   * it (`noteHold` in scripts/lane.mjs), and when that answer STARTED being true.
   *
   * The strip used to draw a finished lane as "done - ships with the next update" and
   * leave it at that, which is a promise rather than a state: the same words are on
   * screen whether the release is ten minutes away, waiting on another chat, or refusing
   * because master fails its own tests. Nothing here is computed a second time - the gate
   * is the only thing allowed to decide, and this is its answer repeated.
   */
  hold: { reason: string; at: number } | null
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
  /**
   * This build is ready and two earlier ones were already thrown away unused, so the app
   * has stopped waiting to be asked and will restart itself once no pane is in use.
   * See shared/updateStale.ts.
   */
  ignored?: boolean
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
  /**
   * The ask that opened each chapter of the session, oldest first.
   *
   * `gist` answers "what was this" for a session that asked one thing, and is wrong for
   * every session worth coming back to: a long one is several jobs in a row, and `/clear`
   * is where one ends and the next begins. See `shared/gist.ts` - still keystrokes the app
   * already relays, never a summary anything was paid for.
   */
  chapters?: string[]
  /** chapters past the cap: the count is kept when the text is not */
  dropped?: number
  /**
   * Every ask this session made, oldest first - `chapters` only keeps the first ask of
   * each subject, this is the whole list `Show all asks` reads. Never a bare slash
   * command; see `shared/gist.ts`.
   */
  askLines?: string[]
  /** internal: a clear happened, so the next real ask opens a chapter */
  fresh?: boolean
  /**
   * The pty's width while this session ran.
   *
   * The transcript is raw terminal bytes hard-wrapped by the CLI at that width, so
   * replaying it at any other one re-flows box drawing into soup. Best effort: the last
   * width the pane was resized to.
   */
  cols?: number
  /** asks that were work (never a slash command); 40 and 1 are different sessions */
  asks?: number
  /**
   * The conversation this pane was on when it closed, so "Open again" brings back the
   * CHAT and not just the folder.
   *
   * `reclaim.ts` closes idle panes on the reasoning that a closed pane here is a minimised
   * one - the row keeps the transcript and the screen, so reopening is a click. That was
   * only ever true of a pane RESTORED from a desk spec, which carries its own `resumeId`.
   * A pane started fresh had none anywhere, so its row reopened with `resume: true` and no
   * id, which resumes whatever the newest conversation in that folder happens to be by
   * then - somebody else's. Reported 2026-08-25: a chat closed by the idle sweep, and the
   * only way back to it was the raw transcript file.
   */
  resumeId?: string
  /**
   * The folder this session ran in is not there any more.
   *
   * Computed on every read rather than stored, because it is a fact about the disk and not
   * about the session. It exists because "Open again" on such a row did NOTHING visible:
   * main's start loop catches a missing folder per request so one bad entry cannot abort a
   * whole workspace launch, and the row is then simply not started. On this desk most of
   * History is temp folders from tests and swept lane worktrees, so that is the common
   * case rather than the rare one - and a button that reads as working and is not is worse
   * than a row that says why.
   */
  gone?: boolean
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

/**
 * One pane on a paired device, whether or not this one is mirroring it.
 *
 * This used to carry six fields, because its only reader was the Devices panel's pick
 * list - a name and a folder is enough to decide what to mirror. The sidebar reads it
 * now, and the sidebar is answering a different question: not "what could I watch" but
 * "what is that machine DOING". So it carries everything `shared/fleet.ts` reads, and
 * a PC pane can be sorted into `Your move` beside a local one without a byte of its
 * output crossing the link.
 *
 * That distinction is the whole design. LISTING a remote pane costs one field in a
 * message that is already sent whenever anything over there changes; MIRRORING one
 * costs a live byte stream and an xterm buffer on this machine, per pane. So every
 * pane is listed and none is mirrored until it is opened.
 *
 * The question itself (`Session.ask`) is deliberately NOT here - answering a chooser
 * needs the frame it was read off, which is a mirror's job. `asking` is the fact the
 * sidebar draws, and pressing the row is what gets you the buttons.
 */
export interface RemotePaneInfo {
  /** its id ON that device - what `watch` holds and `remote:watch` is given */
  id: string
  title: string
  cwd: string
  agent: Agent
  status: SessionStatus
  /** this device is mirroring it right now */
  watched: boolean
  /** worktree lane suffix, so `describePlace` says the same thing it says here */
  lane?: string
  // Everything below is what `fleetState`/`fleetRow` read. Same names as `Session`, so
  // one function serves a local pane and a listed one.
  engaged?: boolean
  bell?: boolean
  /** the CLI over there is sitting on a question - it cannot be answered without opening it */
  asking?: boolean
  attention?: boolean
  exitCode?: number
  lastOutput?: number
  runSince?: number
  stalledSince?: number
  createdAt?: number
  /** the command running in that pane's foreground, when it is a shell pane running one */
  job?: string
  /** what that pane is still running with its turn over - see `Session.backJob` */
  backJob?: string
  backJobSince?: number
  /** when THAT desk's idle clock will close it - its decision, forwarded, never ours */
  closingAt?: number
  /** ...and whether that number is a "keep it open" hold rather than the idle clock */
  closeKept?: boolean
}

/** Live state of one paired device. */
export interface RemotePeerState extends RemotePeer {
  status: 'off' | 'connecting' | 'online' | 'error'
  /** why it is not connected, in words meant for the person reading them */
  error?: string
  /** the PaneForge version that device reported at handshake, known only while connected */
  version?: string
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
    /** this app's own version - so the renderer never needs to import Electron to read it */
    version: string
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
  /**
   * The build this machine last showed a "what changed" card for.
   *
   * Absent means a fresh install, which is deliberately NOT a card - see
   * `shared/whatsNew.ts`'s `shouldSpeak`. Written on the first launch either way, so the
   * first card anybody ever sees is a real one.
   */
  seenVersion?: string
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
   * The one-time move onto the idle-offload clock being ON, at `IDLE_OFFLOAD_MINUTES`.
   *
   * `defaults()` is WRITTEN at first launch, so every config in existence carries
   * `offloadIdleMinutes: 0` explicitly and a changed default alone would read as
   * somebody's own choice. It moves ONLY an exact 0 - any other number is a value
   * somebody typed, and this has no licence over it.
   */
  offloadDefaultsV4?: boolean
  /** roles offered in the swarm dialog, editable by the user */
  swarmRoles: SwarmRole[]
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
  /**
   * The occasional "did you know" card - src/shared/tips.ts. Optional so a config written
   * before it existed still loads, and defaulted ON: the features it names are ones
   * nothing else in the window would ever mention.
   */
  tips?: TipsConfig
  /**
   * Closing a dev server that is running and serving nothing - src/shared/deadDev.ts.
   * Optional so a config written before it existed still loads.
   */
  deadDev?: DeadDevConfig
  reclaim?: ReclaimConfig
  /**
   * Panes somebody has said are never to be closed for being idle - "Keep this pane open"
   * on the card's right-click, `ReclaimPane.pinned`.
   *
   * On the CONFIG rather than in the renderer, because it was renderer state and so every
   * restart and every update put every pinned pane back on the idle clock - a promise that
   * lasted until the next automatic restart, which on this app is several times a day.
   *
   * These are session ids, and a restored pane is issued a NEW one, so `restorePanes` in
   * main translates each id through the pane's `scrollbackId` (which IS the old id) as the
   * panes come back, and drops the ids nothing came back for. Without that the list only
   * ever grows and every entry in it is stale after one restart.
   */
  pinnedPanes?: string[]
  /**
   * Move finished panes to a paired device when this machine runs out of memory, rather
   * than closing them - see shared/autoHandoff.ts. Sits above `reclaim` on the same
   * ladder: closing is what happens when there is nowhere to move a pane to.
   */
  autoHandoff?: AutoHandoffConfig
  /**
   * When a pane clears ITSELF for cost, and whether the app watches for it at all.
   *
   * Claude panes are decided by their own Stop hook, which knows the token count exactly.
   * `watchNonClaude` is the codex/antigravity half, where nothing hooks the end of a turn
   * and the size has to be read off the CLI's own files - see `main/autoclearWatch.ts`.
   */
  autoClear?: AutoClearConfig

  /**
   * Where a pane on somebody else's inference provider may be opened, and whether it is
   * confined at all - see `shared/paneTrust.ts`. Absent means unconfined, which is what
   * every desk that has not asked otherwise gets.
   */
  paneTrust?: PaneTrustConfig
  /**
   * Quit the WHOLE app after this many minutes with no input - see shared/idlequit.ts.
   * 0 (the default) is off. Distinct from `reclaim`, which closes single panes: this
   * closes the window and ends the process, so it refuses on a focused window, on any
   * pane that is working/starting/stalled, and on any pane another device is driving.
   */
  idleQuitMinutes?: number
  /**
   * Hold the display (and so the machine) awake while any pane has an agent mid-turn or
   * is sitting on a question - see shared/awake.ts. On by default: this Mac had
   * `displaysleep 1` on battery, so a ten-minute turn ran behind a black screen and the
   * question at the end of it was never seen. Capped at one unbroken busy stretch, so a
   * wedged pane cannot keep a laptop lit all night.
   */
  keepDisplayAwake?: boolean
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
   * Rebound keyboard shortcuts: action id -> chord (`"g"`, `"shift+g"`).
   *
   * Only what has been CHANGED is stored, so a default that moves in a later build moves
   * for everybody who never touched it - which is the whole reason this is not a full map
   * written out at first launch. `shared/keymap.ts` owns the ids and the parsing, and
   * drops anything it cannot read rather than leaving a shortcut with a hole in it.
   */
  keys?: Record<string, string>
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
  /**
   * The pane this row would come back AS - the old session's id, carried straight off the
   * saved desk (`StartSessionRequest.scrollbackId`).
   *
   * It is on the dialog's own row because the answer is rebuilt from these rows, not from
   * the desk: without it the ASKED restore path silently dropped both of the things that
   * id carries - the pane's scrollback (`restoredTail` reads the log under the OLD id) and
   * its "Keep this pane open" (`restorePanes` translates `config.pinnedPanes` through it).
   * The silent update restart passed the desk specs whole and kept both, so the two paths
   * disagreed and only the one Robert's config actually uses (`restoreAfterRestart: 'ask'`)
   * lost them.
   */
  scrollbackId?: string
  /** it was asleep when the app went down, and comes back that way */
  asleep?: boolean
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

/** Shape exposed on window.api by the preload script. */
export interface Api {
  listProjects(): Promise<Project[]>
  /** make a project folder from a typed name; null when the name may not be one */
  createProject(name: string): Promise<Project | null>
  /**
   * Which project a first message is about, ranked. Empty text means no matches, so
   * this is safe to call on every keystroke; it reads no files that are not cached.
   */
  routeProjects(text: string): Promise<RouteResult>
  /** every known agent with whether its binary is actually on this machine */
  listAgents(): Promise<AgentInfo[]>
  listSessions(): Promise<Session[]>
  startSession(req: StartSessionRequest): Promise<Session>
  /**
   * Launch several panes at once. One row back per request, in order: a row carries the
   * pane it opened, or the words saying why that folder got none.
   */
  startSessions(reqs: StartSessionRequest[]): Promise<StartedPane[]>
  /** respawn the agent in place, keeping the pane and its id */
  restartSession(id: string): Promise<Session | null>
  /** swap a running pane to another CLI/model - same folder, same pane, fresh process */
  switchAgent(id: string, agent: Agent, model?: string): Promise<Session | null>
  renameSession(id: string, title: string): Promise<void>
  /**
   * Put a client rename back and stop offering it for this pane. The card's Cancel.
   *
   * A rename that could only be undone by typing the old name again is not a cancel: the
   * old name is `basename(cwd)`, which the person never typed and has no reason to know.
   */
  undoClientName(id: string): Promise<void>
  /** A pane has just been named for a client. Carries what it was called before. */
  onClientNamed(fn: (e: ClientNamed) => void): () => void
  onActivity(fn: (feed: ActivityFeed) => void): () => void
  /**
   * The sidebar's order after a card was dragged, newest-first-to-last as displayed.
   * Mirrored ids are carried along and ignored by the machine that receives them.
   */
  reorderSessions(ids: string[]): void
  /** Record why a pane was closed by a sweep, into `reclaim.log` under userData. */
  logReclaim(entry: Record<string, unknown>): void
  /** One line to `fix.log` per Fix run: the screen's signature before the repair. */
  logFix(entry: Record<string, unknown>): void
  /** What the app has done on its own lately, newest first. See `shared/activity.ts`. */
  listActivity(): Promise<ActivityFeed>
  /**
   * The prompt a pane opened on a backlog task starts with, or why there is none.
   *
   * Reading only - the backlog has one writer (`claude-config/backlog.mjs`). Reached by
   * `pf open --task <id>`, which refuses BEFORE opening a pane when the id names nothing.
   */
  taskBrief(ref: string): Promise<{ prompt: string } | { error: string }>
  /** The list has been opened: everything in it stops counting as new. */
  markActivitySeen(): void
  killSession(id: string): Promise<void>
  /**
   * End this pane's agent and keep its card: the process and its whole tree go, the row
   * stays where it is wearing an `asleep` chip, and what is on screen is untouched.
   * See `shared/sleep.ts`.
   */
  sleepSession(id: string): Promise<Session | null>
  /** Start a sleeping pane's agent again, back in the conversation it was in. */
  wakeSession(id: string): Promise<Session | null>
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
  resize(id: string, cols: number, rows: number, borrowed?: boolean, viewer?: string): void
  /**
   * The phone has stopped looking: every borrowed pty goes back to the desk's shape.
   *
   * `viewer` is WHICH screen stopped looking, and it must be the same name that screen
   * borrowed under - a borrow filed under one name and returned under another is never
   * given back, which is how a mirrored pane stayed at phone width on the machine that
   * owns it long after the phone was put down.
   */
  returnSize(viewer?: string): void
  /**
   * This desk takes ONE pane's size back from every screen borrowing it.
   *
   * `returnSize` is a borrower letting go; this is the owner taking. It exists because a
   * borrow from a paired device holds no lease - a mirror has no tick of ours to renew
   * with, so `at` is 0 and `dropStale` can never expire it (see `Borrow.at` in
   * shared/paneSize.ts). That is right while somebody is drawing the pane and wrong for
   * ever afterwards: an attached-but-idle mirror kept a Mac pane at the PC window's 107
   * columns with `borrowed: true`, and every desk resize - dragging the window, showing
   * the pane, Fix - was swallowed by the "a phone is still drawing this" branch in
   * `resize`. The pane was 107 wide inside a 89-column pane with a black margin down the
   * right, and it took an ssh to the other machine to give it back (measured 2026-09-04,
   * s43-mtmmi8yy).
   *
   * So Fix asks for it. USER-INITIATED ONLY, and never from a mirror: a person at the
   * machine that owns the pty outranks a screen somewhere else that has gone quiet, and
   * a mirror that is really being watched re-borrows on its next repaint.
   */
  takePaneSize(id: string): void
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
  paneVisibility(client: string, ids: string[], viewer?: string): void
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
  setBusy(id: string, busy: boolean, tail?: string, clock?: TurnClock, reason?: BusyReason): void
  /**
   * When the idle clock will close this pane, or null when nothing will. The window
   * decides it (it holds the focus and the config); the session carries it, so this
   * desk's card and every paired device's listing draw the same number.
   */
  setClosing(id: string, at: number | null, kept?: boolean): void
  /**
   * What changed in the build now running, or null for "say nothing".
   *
   * Asked ONCE by the renderer on mount. It answers null on every launch that is not the
   * first one on a newer build, and also on a launch that could not reach GitHub - the
   * card is never an error and never empty. See `shared/whatsNew.ts`.
   */
  whatsNew(): Promise<import('./whatsNew').WhatsNew | null>
  /**
   * The change list for a dev copy, as steps to walk through - `null` when there is
   * nothing to show (the installed app, or a build that is not ahead of it). See
   * `shared/tour.ts`.
   */
  tour(): Promise<import('./tour').TourState | null>
  /**
   * Runs one of the checkout's own `scripts/<name>-test.mjs` for a tour step and reads
   * its answer. Refused outside a dev copy and for any other path. See `shared/tour.ts`.
   */
  tourCheck(script: string): Promise<import('./tour').TourCheck>
  /**
   * Put the tour's example chats in History, or take them away - `on` adds them only when
   * nothing already there would show the step what it is about. Dev copy only; answers
   * how many rows changed. See `shared/tourSample.ts`.
   */
  tourSample(on: boolean): Promise<number>
  /** One counted line out of a check that is still running - see `main/tour.ts`. */
  onTourCheckLine(cb: (p: import('./tour').TourProgress) => void): () => void
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
   * Open the PROJECT a pane's folder belongs to: a lane (a git worktree) resolves to its
   * trunk checkout, because a lane is scratch and a file left in one is swept with it.
   * Anything that is not a worktree opens unchanged. Answers with the folder that was
   * opened, or null when it is not there any more.
   */
  revealProject(cwd: string, title?: string): Promise<string | null>
  revealPane(cwd: string): Promise<string | null>
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
   * The same for paths on the device the window is on, read there - a `file://` drop
   * carries no bytes, and on a mirrored pane the path means nothing to the other desk.
   */
  attachPaths(sessionId: string, paths: string[]): Promise<AttachResult>
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
  /** A new pane the app decided to start on the other machine, before it does. */
  onOffloadSoon(
    cb: (ask: { id: string; project: string; deviceName: string; reason: string; deadline: number }) => void
  ): () => void
  /** Answer that card: `go` false keeps the pane on this machine. */
  answerOffload(id: string, go: boolean): Promise<void>
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
  /** Move an agent CLI to its newest release; reports on the install console. */
  updateAgent(id: string): Promise<void>
  /** file picker that wires an existing binary up as an agent override */
  locateAgent(id: string): Promise<string | null>

  /** named profile this window runs under ('' = the normal installed app) */
  profile(): Promise<string>
  updateState(): Promise<UpdateState>
  /**
   * Ask for a pane to be /clear'd after a countdown the desk can stop. The caller is the
   * `autoclear` Stop hook, never the window - see shared/autoclear.ts.
   */
  /** Every sign-in a script is waiting on, newest first. */
  loginRequests(): Promise<LoginRequest[]>
  /** A script hit a login wall. Puts a card up; opens nothing. */
  needsLogin(req: {
    site: string
    url: string
    host?: string
    port?: number
    machine?: string
    from?: string
  }): Promise<LoginRequest>
  /** Somebody pressed the card: open the tunnel, the browser and the picture. */
  openLogin(id: string): Promise<{ ok: boolean; error?: string }>
  /** Done, or Close. The sign-in stays on the machine it was typed into. */
  closeLogin(id: string): void
  /** Not now. */
  dismissLogin(id: string): void
  /** A pointer or a key, on the remote page. */
  loginInput(id: string, ev: LoginInput): void
  /** This frame is on screen - send the next one. */
  loginPainted(id: string, ack: number): void
  /** The view's size in CSS pixels; the remote page is made this shape. */
  /** The far page's viewport, and the box it is drawn into on this screen. */
  loginSize(id: string, w: number, h: number, boxW?: number, boxH?: number): void
  onLoginFrame(cb: (f: { id: string; data: string; meta: FrameMeta; ack: number }) => void): () => void
  onLogins(cb: (reqs: LoginRequest[]) => void): () => void
  askAutoClear(req: AutoClearAsk): Promise<{ ok: boolean; reason?: string; dueAt?: number }>
  /** The two buttons on that card. */
  /** Countdowns in flight, for a window that has just opened. */
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


  listHistory(): Promise<HistoryEntry[]>
  searchHistory(query: string): Promise<HistoryHit[]>
  readHistory(id: string): Promise<string>
  deleteHistory(id: string): Promise<void>

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
  /**
   * Bring a MIRRORED pane back to this device - the other direction of the same move.
   *
   * The pty never travels, so this cannot pull: the device that owns the pane is asked to
   * run its own handoff at us. Every refusal and the mid-turn queue are therefore the far
   * end's, and the report is the same `HandoffItem[]` a local hand-off gives.
   */
  bringPaneHere(id: string): Promise<HandoffItem[]>
  /** Panes waiting for their turn to end before they move - see shared/autoHandoff.ts. */
  handoffPending(): Promise<{ id: string; device: string; deviceName: string; since: number }[]>
  /** Stop waiting on one. The pane stays here, unmarked. */
  cancelHandoff(id: string): Promise<boolean>
  /**
   * A queued move's own countdown: the turn ended and it will run at `at` unless
   * cancelled - `at: null` clears the card (busy again, cancelled, or the move ran).
   * Fed into the same `MoveSoon.tsx` card the idle/pressure countdowns use.
   */
  onHandoffSoon(cb: (soon: { id: string; device: string; deviceName: string; at: number | null }) => void): () => void
  /**
   * Whether each of these folders' code could reach another machine - a git checkout,
   * under the projects root, with an origin remote. Asked by the automatic sweeps before
   * they pick a pane, so a repo that cannot travel is never counted down at.
   */
  handoffReady(cwds: string[]): Promise<Record<string, boolean>>
  /**
   * Arm a pane's own /clear, from the `autoclear` Stop hook. See `shared/autoclear.ts`.
   *
   * Answers `{ ok: false, reason }` rather than throwing, because the caller is a detached
   * child process whose stderr nobody reads: a refusal has to be something it can log.
   */
  askAutoClear(ask: unknown): Promise<{ ok: boolean; reason?: string }>
  cancelAutoClear(id: string): Promise<boolean>
  /**
   * Hand the pane back to the person at the desk, mid-handover.
   *
   * The clear has already run and the resume prompt is still queued. This drops that
   * prompt - `queuePrompt` reads `lastKeyboard` against the mark it took, and this moves
   * it - and takes the curtain down. The escape hatch is the whole reason the curtain is
   * allowed to swallow keys at all.
   */
  takeOverPane(id: string): Promise<boolean>

  /** The best earlier ask this draft repeats, or null. Cheap: a scored lookup, no search. */
  priorPrompt(draft: string): Promise<PriorPrompt | null>
  /**
   * Break one long ask into the panes that can run at the same time. Expensive - it runs
   * an agent CLI once, headlessly - so it is only ever called from a press.
   */
  splitPrompt(text: string): Promise<SplitAnswer>
  /** Record that a draft was actually sent. Fire-and-forget. */
  promptUsed(draft: string, meta: { cwd?: string; agent?: string; id?: string }): void

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
  /**
   * The machine moved between battery and wall power. Drives the `on-battery` class,
   * which holds the sidebar's looping decorations still - see styles.css.
   */
  onBattery(cb: (onBattery: boolean) => void): () => void
  /** Whether this screen can still hear the desk. Only a phone ever gets one. */
  onLinkState(cb: (state: LinkState) => void): () => void
  /** the window state right now, for the page's first paint (the push can arrive first) */
  appVisibleNow(): Promise<boolean>
  /** on battery right now, for the page's first paint (the push can arrive first) */
  appOnBatteryNow(): Promise<boolean>
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
   * Nobody is at this machine since this moment, epoch ms - or null while somebody is.
   *
   * The idle close reads it and freezes its clock there; see `src/shared/away.ts`. Null is
   * also the answer on a machine no person has ever touched, which is the second desk this
   * whole feature exists for and the one place the pause must never fire.
   */
  onAway(cb: (away: Away) => void): () => void
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
  /** The dev server the app is about to close for serving nothing, or null. */
  onStopSoon(cb: (soon: StopSoon | null) => void): () => void
  /** Leave that one running - never offered again while the app is up. */
  keepDevServer(pid: number): void
  /** Close it now rather than at the deadline. */
  stopDevNow(pid: number): void
  /**
   * What THIS machine is running that no pane owns: scheduled agent turns, cron loops,
   * dev servers. See `shared/backJobs.ts`. Read on demand - it is a whole process table.
   */
  listJobs(): Promise<BackJob[]>
  /**
   * The same question asked of a paired machine, which is the point of it: a PC running
   * unattended work had no surface in this app at all.
   *
   * REJECTS when that device is not connected. An empty array means "it is running
   * nothing", which is the answer somebody opens this to check, so a read that could not
   * happen must never share its shape.
   */
  listRemoteJobs(device: string): Promise<BackJob[]>
  /**
   * A remote pane's scrollback was replaced wholesale - the link came back and the
   * other device re-sent everything. The pane clears and redraws instead of appending
   * a second copy of what it already had.
   */
  onPaneReset(cb: (id: string) => void): () => void
  /**
   * The app is about to type a clear into this pane itself (autoclear). The pane files its
   * screen into the scrollback now, exactly as it does for a clear somebody typed.
   */
  onPaneArmClear(cb: (id: string) => void): () => void
  /** A line submitted into this pane by the app or a phone - not by this window. */
  onPaneTyped(cb: (id: string, line: string, origin: 'person' | 'app') => void): () => void
  /**
   * The pane is mid-autoclear-handover until `until` (epoch ms), or free again at 0.
   *
   * Sent when the app types `/clear` into a pane it is clearing, and again the moment the
   * resume prompt has gone in or been dropped. The renderer draws a curtain over the
   * terminal in between - see `TerminalPane`'s handover overlay.
   */
  onPaneHandover(cb: (id: string, until: number) => void): () => void
  /** global push-to-talk hotkey fired from the main process */
  onVoiceHotkey(cb: () => void): () => void
  /**
   * A main-process error, which used to be a modal message box that stole the keyboard.
   * Shown as a line in the footer instead; the detail is in paneforge-errors.log.
   */
  onAppError(cb: (message: string) => void): () => void
}
