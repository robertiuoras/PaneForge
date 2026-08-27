// Giving a full machine its memory back by closing panes nobody is using.
//
// `capacity.ts` measured where a desk's memory goes and then gave back the only part it
// could give back instantly: scrollback. That is the right first move and it is a small
// one. Measured on this desk 2026-08-14 with twelve panes open:
//
//   9 claude CLIs          1.19 GB   (64-233 MB each)
//   3 codex CLIs             50 MB   (16-17 MB each - an order of magnitude cheaper)
//   PaneForge, 5 processes  270 MB
//   trimming all 12 panes' scrollback   ~74 MB, about 5% of it
//
// So the agent inside the pane is the cost, and the only way to give an agent back is to
// close its pane. Every terminal refuses to do that for a good reason - closing somebody's
// work is not a memory optimisation, it is losing their work.
//
// What makes it defensible HERE, and nowhere else, is that closing a pane in this app is
// nearly free to undo. `kill()` calls `recordEnd`, so the pane keeps its History row; the
// row carries `resumeId` and `scrollbackId`; reopening restores the agent's conversation
// AND what was on the screen. That is `test:restore` and `test:scrollback`, both of which
// existed before this. A closed pane here is a minimised pane everywhere else.
//
// The policy is still deliberately timid, because "nearly free" is not free:
//
//   - It is triggered by PRESSURE, never by a clock. A pane idle for six hours on a
//     machine with room to spare is costing nobody anything, and closing it would be the
//     app tidying up after somebody who did not ask to be tidied up after. Idle time only
//     breaks ties between panes once the machine is already in trouble.
//   - It never touches a pane that is working, starting, stalled, or waiting for a person.
//     `needsYou` is the one that would feel like theft: the agent asked a question, the
//     answer is owed, and the pane looks idle precisely because it is waiting.
//   - It never touches the pane being looked at, or one on screen, or a mirror of another
//     device's pty (which costs this machine a socket and a buffer, not an agent).
//   - It closes at most a couple at a time and re-decides on the next reading, so the
//     machine's own recovery stops it rather than a number guessed here.
//
// Pure: no Electron, no `os`. `npm run test:reclaim`.

import { SESSION_MB, type Verdict } from './capacity'
import type { FleetState } from './fleet'

/**
 * States that may be closed to reclaim memory. Everything else is somebody's business.
 *
 * `needsYou` is in the list and `asking` is what keeps it honest. That state is two facts
 * wearing one name - an agent that ASKED something, and an agent that FINISHED and is
 * sitting at its composer - and refusing the whole state to protect the first refused the
 * second as well. A finished pane is the only pane anybody ever wants closed, so with
 * `ready | exited` this sweep could only ever reach a CLI nobody had typed into at all:
 * measured on this desk 2026-08-20, every pane on it was `needsYou` and the sweep had
 * therefore never closed anything in its life. The refusal that was actually meant is the
 * one below, and it reads the pane's own live question rather than the word for its state.
 */
const CLOSEABLE: ReadonlySet<FleetState> = new Set<FleetState>(['ready', 'exited', 'needsYou'])

export interface ReclaimConfig {
  /** Close idle panes when this machine runs out of memory. */
  enabled: boolean
  /**
   * How long a pane must have been quiet before it may be closed, in minutes.
   *
   * Measured from lastKeyboard (user input), not pty output (which repaints for status updates).
   * 15 minutes is short enough to reclaim under pressure without losing recent work, and long
   * enough to avoid closing a pane somebody is actively thinking about.
   */
  minIdleMinutes: number
  /** How many to close per reading. The next reading decides again. */
  maxPerSweep: number
  /**
   * Close a pane nobody has typed into for this many minutes, whatever the machine's
   * memory says. 0 is off, and off is the default.
   *
   * This is the one thing the paragraph above refuses to do on the desk you are sitting
   * at, and the refusal still stands there: a pane idle six hours on a machine with room
   * is costing nobody anything. What changes it is a machine nobody is sitting at - a
   * second desk driven over the device link, which fills up with panes that were finished
   * hours ago and has no person to close them. So the clock exists, it is off unless
   * somebody sets it, and every refusal that keeps the pressure sweep timid is shared with
   * it verbatim: never a pane that is working, starting, stalled or waiting for a person,
   * never a mirror of some other machine's pty, never the focused pane, never the last one.
   *
   * The cost of closing too early is somebody reopening from History - one click, with the
   * conversation and the screen both intact - and the cost of never closing is a machine
   * that is out of memory in the morning. Those are not the same size, which is why this
   * is half an hour rather than the two hours it started at.
   */
  idleCloseMinutes: number
  /**
   * Marker for the one-time move onto the clock being ON by default.
   *
   * `defaults()` is WRITTEN to config.json at first launch, so every install in existence
   * carries `idleCloseMinutes: 0` explicitly and a flip in `DEFAULT_RECLAIM` alone would be
   * read as somebody's own choice and never applied. Same shape as `autoAnswer.defaultsV2`,
   * and read off the SAVED config for the same reason.
   */
  defaultsV2?: boolean
  /**
   * The same one-shot, for the switch dropping from thirty minutes to ten.
   *
   * A changed default cannot reach an existing desk on its own - `defaults()` is WRITTEN to
   * config.json at first launch, so every machine already carries the old number as if
   * somebody had chosen it. This migration moves ONLY the old switch value (30). A zero is
   * left alone: that is somebody having turned the clock off, and V2's licence to overwrite
   * it was V2's, not this one's.
   */
  defaultsV3?: boolean
}

/**
 * What the Settings switch sets `idleCloseMinutes` to when it is turned on.
 *
 * Ten minutes. It was thirty, and before that two - the two was wrong for the reason below
 * and the thirty was too slow for the desk it runs on: Robert, 2026-08-27, "the idle close
 * is 30 minutes and i want 10". Ten still costs nothing when it is early.
 *
 * The original note stands, and is why being early is cheap: it was two, on the reasoning
 * that being early closes a pane somebody was
 * coming back to - true, and it priced that at far more than it costs. A closed pane here
 * keeps its History row, its `resumeId` and its `scrollbackId`, so coming back to one is
 * a click that restores the conversation AND the screen; a pane held open for two hours
 * on a machine nobody is at is ~190 MB of agent doing nothing. Measured on this desk's PC
 * 2026-08-22: two panes handed off in the morning were still holding their CLIs at
 * teatime, which is the report this number answers.
 */
export const IDLE_CLOSE_MINUTES = 10

export const DEFAULT_RECLAIM: ReclaimConfig = {
  enabled: true,
  minIdleMinutes: 15,
  maxPerSweep: 2,
  idleCloseMinutes: IDLE_CLOSE_MINUTES,
  defaultsV2: true,
  defaultsV3: true
}

export interface ReclaimPane {
  id: string
  state: FleetState
  /** Epoch ms of this pane's most recent user input. */
  lastKeyboard: number
  /**
   * Epoch ms the pty last printed anything, when the caller knows it.
   *
   * Keystrokes alone are not idleness, and reading them as idleness is what closed a pane
   * mid-answer on 2026-08-21: a person types one prompt, the agent works for two hours,
   * and `lastKeyboard` says the pane has been quiet for two hours the entire time. The
   * only thing standing between that and a kill was the pane's STATE, and `status` goes
   * `working` -> `idle` after four seconds of silence with no readable busy footer - so
   * one quiet moment inside a long turn was enough to call the pane finished and start
   * the countdown on it.
   *
   * So quiet means quiet: nobody has typed AND the pane has printed nothing. A pane whose
   * agent is producing output is not idle no matter how long ago somebody last touched
   * the keyboard. Optional because a caller that cannot supply it keeps the old reading.
   */
  lastOutput?: number
  /**
   * Epoch ms this pane last had the keyboard, when the caller knows it.
   *
   * Looking at a pane is using it. Without this the idle clock counted from the last
   * keystroke while the pane sat focused on screen, so a pane read for six minutes and then
   * left was already PAST its deadline the instant focus moved: the card went from no chip
   * at all straight to a red `closes 0:01`, which is a countdown nobody can act on and is
   * exactly how it was reported ("it showed red with 0:01 to close"). Every refusal here
   * already exempts the focused pane, so the only thing that was missing was the moment
   * focus left.
   */
  lastFocus?: number
  /**
   * A turn is in flight (the pane's run clock is going).
   *
   * Belt and braces beside `state`: `endRun` clears the run clock and flips the status in
   * the same pass, so this rarely disagrees - but closing somebody's pane is the one act
   * where a second, independent "is it working" reading is worth its line.
   */
  busy?: boolean
  /** The pane being read. Never closed, at any pressure. */
  focused: boolean
  /** Drawn in the grid right now. Never closed - it is on somebody's screen. */
  visible: boolean
  /** Another device's pty, mirrored here. Closing it frees no agent on this machine. */
  remote: boolean
  /**
   * The agent has a question on screen that nobody has answered.
   *
   * This is the one that would feel like theft, and it is the reason `needsYou` alone is
   * not a refusal: the pane is quiet BECAUSE it is owed an answer, and every idle reading
   * in the app says yes about it. It comes from the pane's own `ask`, never from its state.
   */
  asking?: boolean
  /**
   * The command a SHELL pane is running right now, when there is one.
   *
   * `busy` already carries this through `runSince`, and this is the second, independent
   * reading beside it - the same belt-and-braces `busy` itself is beside `state`. It earns
   * its line because the two are set by different things and one of them was wrong: a
   * background job (`cmd &`) leaves the SHELL in front of the tty, so `paneJob` saw
   * nothing, `runSince` was never set, and a pane with two monitors running in it read as
   * idle and started counting down. Reported 2026-08-24: "1 shell 2 monitors running in
   * session 2, why is it trying to close it".
   */
  job?: string | null
  /**
   * Something the AGENT left running in the background: a `run_in_background` shell, a
   * Monitor loop, a build (`shared/paneBackJobs.ts`).
   *
   * Separate from `job` on purpose. `job` is a SHELL pane's foreground command and also
   * feeds `busyOnScreen`, where a false positive is a pane the sweep never closes and a
   * clock that lies. This one feeds nothing but the refusals below, so being wrong costs a
   * pane that stays open a little longer - and being right is the difference between a
   * twenty-minute build finishing and being killed at minute three, which is what the
   * ladder did before this: the turn ends, the CLI's footer goes quiet, `engaged` drops,
   * the card reads finished, and the work is still going.
   */
  backJob?: string | null
  /**
   * Already on its way to another device - see shared/autoHandoff.ts.
   *
   * Closing it would be the same memory saved and the work lost: the move is mid-flight,
   * so the far end is about to start the pane this one would have been reopened from.
   * Moving beats closing whenever both are available, which is why the ladder puts the
   * handoff sweep above this one.
   */
  handingOff?: boolean
  /**
   * Somebody has said, on this pane, that it is not to be closed for being idle.
   *
   * `keptUntil` is the hour-long hold the countdown chip arms, and it is the right answer
   * for "not now". This is the answer for "not ever": a pane holding a long-running thing
   * the app cannot see - a watcher, a session being read a paragraph at a time, a build
   * somebody wants to come back to - has no reading that says so, and an hour later the
   * clock starts again. Robert, 2026-08-24: "if you right click session you can make it so
   * stops closing in 5min timer always keeps starting".
   *
   * It refuses the pressure sweep as well as the clock. Both close the pane, and a person
   * who said "keep this one" did not mean "unless memory is tight" - the ladder still has
   * three rungs above closing, and the honest thing under real pressure is to move or to
   * say so rather than to overrule them.
   */
  pinned?: boolean
}

/**
 * When this pane last did anything at all - the latest of a keystroke, a printed byte and
 * the moment the keyboard left it.
 *
 * The whole idle reading in both sweeps below. See `ReclaimPane.lastOutput` for why it is
 * not `lastKeyboard` on its own.
 */
export function quietSince(
  p: Pick<ReclaimPane, 'lastKeyboard' | 'lastOutput' | 'lastFocus'>
): number {
  return Math.max(p.lastKeyboard, p.lastOutput ?? 0, p.lastFocus ?? 0)
}

export interface Reclaim {
  id: string
  /** How long it had been quiet, ms. Goes in the log line so the choice is auditable. */
  idleMs: number
  /** Whether closing it frees an agent, or only a buffer. */
  hadAgent: boolean
}

/**
 * Which panes to close, oldest-quiet first, or an empty list.
 *
 * Empty is the answer for everything except a machine that is actually in trouble with
 * panes that are actually finished. `now` is passed rather than read so this is testable.
 */
export function reclaimPlan(
  panes: ReclaimPane[],
  v: Verdict,
  cfg: ReclaimConfig = DEFAULT_RECLAIM,
  now = 0
): Reclaim[] {
  if (!cfg.enabled) return []
  // The trigger. `ok` means the kernel is content and the budget has room; anything the
  // app did there would be tidying, not reclaiming.
  if (v.level === 'ok') return []
  if (!(cfg.maxPerSweep > 0)) return []
  const minIdle = Math.max(0, cfg.minIdleMinutes) * 60_000

  const eligible = panes
    .filter(
      (p) =>
        !p.focused &&
        !p.visible &&
        !p.remote &&
        !p.handingOff &&
        !p.asking &&
        !p.busy &&
        !p.job &&
        !p.backJob &&
        !p.pinned &&
        CLOSEABLE.has(p.state)
    )
    .filter((p) => now - quietSince(p) >= minIdle)
    // Oldest quiet first: of two finished panes, the one nobody has looked at since this
    // morning is the safer one to close than the one that finished a minute ago.
    .sort((a, b) => quietSince(a) - quietSince(b))

  // Never the last pane. An app that empties its own window under memory pressure has
  // not solved the problem, it has removed the reason the window is open.
  const keepAtLeastOne = panes.length - eligible.length < 1 ? 1 : 0
  const room = Math.max(0, eligible.length - keepAtLeastOne)

  return eligible.slice(0, Math.min(cfg.maxPerSweep, room)).map((p) => ({
    id: p.id,
    idleMs: now - quietSince(p),
    // An exited pane's process is already gone: closing it returns a buffer, not an agent.
    // Saying so keeps the log line honest about what was actually bought.
    hadAgent: p.state !== 'exited'
  }))
}

/**
 * Which panes have simply been quiet too long, or an empty list.
 *
 * The clock the sweep above refuses to have, for the machine that has no person: same
 * refusals, one different trigger, and off unless `idleCloseMinutes` says otherwise.
 *
 * `visible` is deliberately NOT a refusal here, and it is the only one dropped. It exists
 * up there because closing something on somebody's screen while their machine is busy is
 * theft; down here the clock has already established that nobody has typed into this pane
 * for hours, and on a desk nobody is sitting at every pane in the grid is "on screen". Keep
 * it and the feature can never fire on the machine it was built for.
 */
export function idleClosePlan(
  panes: ReclaimPane[],
  cfg: ReclaimConfig = DEFAULT_RECLAIM,
  now = 0
): Reclaim[] {
  if (!cfg.enabled) return []
  const minutes = Math.max(0, cfg.idleCloseMinutes ?? 0)
  if (!minutes) return []
  if (!(cfg.maxPerSweep > 0)) return []
  const minIdle = minutes * 60_000

  const eligible = panes
    .filter(onTheClock)
    .filter((p) => now - quietSince(p) >= minIdle)
    .sort((a, b) => quietSince(a) - quietSince(b))

  // Same last-pane rule as the pressure sweep: an app that empties its own window has not
  // saved anything, it has removed the reason the window is open.
  const keepAtLeastOne = panes.length - eligible.length < 1 ? 1 : 0
  const room = Math.max(0, eligible.length - keepAtLeastOne)

  return eligible.slice(0, Math.min(cfg.maxPerSweep, room)).map((p) => ({
    id: p.id,
    idleMs: now - quietSince(p),
    hadAgent: p.state !== 'exited'
  }))
}

/** MB the plan is expected to return, for the line that says whether it was worth doing. */
export function reclaimedMb(plan: Reclaim[]): number {
  return plan.reduce((mb, p) => mb + (p.hadAgent ? SESSION_MB : 0), 0)
}

/**
 * Whether this pane is ON THE CLOCK at all - the whole refusal set, in one place.
 *
 * `idleClosePlan` decides WHO closes and `idleCloseAt` decides WHEN the card says it will,
 * and those two disagreeing is the worst failure this feature has: a card counting down on
 * a pane that will never be closed is a threat the app does not carry out, and a pane
 * closing with no countdown in front of it is the thing the countdown exists to prevent.
 * So there is one predicate and both read it.
 *
 * `busy` is the load-bearing one for a SHELL pane. A pane whose agent has finished and a
 * pane running `npm run build` look identical in the sidebar - both quiet, both green -
 * and `paneJob.ts` is what tells them apart: a live foreground command sets `runSince`,
 * which arrives here as `busy`. Robert, 2026-08-23: "its actually stopped not just stopped
 * but shell or something background still running".
 */
function onTheClock(p: ReclaimPane): boolean {
  return (
    !p.focused &&
    !p.remote &&
    !p.handingOff &&
    !p.asking &&
    !p.busy &&
    !p.job &&
    !p.backJob &&
    !p.pinned &&
    CLOSEABLE.has(p.state)
  )
}

/**
 * When this pane is due to be closed by the idle clock, or null when it is not on it.
 *
 * null is a REFUSAL and never "soon": the caller draws nothing for it. A pane that is
 * working, holding a question, focused, mid-handoff, another device's, or simply not in a
 * closeable state has no deadline at all, and inventing one for it - even a far-off one -
 * would put a countdown on a card nothing is going to close.
 *
 * This is deliberately per-pane and ignores `maxPerSweep` and the last-pane rule, which
 * are about which of several due panes go FIRST. Both can only ever delay a close, and a
 * countdown that says "about now" for a pane that goes one sweep later is honest; one that
 * says nothing because the pane happened to be third in the list is not.
 */
export function idleCloseAt(
  pane: ReclaimPane,
  cfg: ReclaimConfig = DEFAULT_RECLAIM,
  now = 0
): number | null {
  if (!cfg.enabled) return null
  const minutes = Math.max(0, cfg.idleCloseMinutes ?? 0)
  if (!minutes) return null
  if (!onTheClock(pane)) return null
  const at = quietSince(pane) + minutes * 60_000
  // A pane already past its deadline is due NOW, not overdue by four minutes: the sweep
  // runs on a minute timer, so `now` is regularly a little past the moment it was due and
  // a chip counting UP from zero reads as a clock that jammed.
  return Math.max(at, now)
}
