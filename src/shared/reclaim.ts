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
   * Stop the agent in a pane nobody has typed into for this many minutes, and keep the
   * card - see `IDLE_SLEEP_MINUTES` and `shared/sleep.ts`. 0 is off.
   *
   * A NEW key, so an existing config.json simply does not have it and `?? IDLE_SLEEP_MINUTES`
   * gives every desk the default: none of the `defaultsVN` machinery is needed, because
   * that exists for a default that was already WRITTEN as a number somebody could have
   * chosen. Missing is missing.
   */
  idleSleepMinutes?: number
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
  /** The same again, ten minutes becoming five - see `migrateReclaimV4`. */
  defaultsV4?: boolean
}

/**
 * What the Settings switch sets `idleCloseMinutes` to when it is turned on.
 *
 * Five minutes. It was ten earlier the same day, thirty before that, and two before that -
 * the two was wrong for the reason below and the thirty was too slow for the desk it runs
 * on: Robert, 2026-08-27, "the idle close is 30 minutes and i want 10", then "actually
 * sorry its 5 min". Being early costs less here than it did, because the clock no longer
 * starts at all on a pane whose output nobody has read (see `unread`).
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
export const IDLE_CLOSE_MINUTES = 5

/**
 * How long a pane may sit unused before its agent is stopped and the CARD is kept.
 *
 * On by default, unlike the close clock above, because being wrong costs so much less:
 * sleeping keeps the pane, its place, its screen and its conversation, and waking it is
 * one press and the CLI's own 1.4s boot. Closing takes the card off the desk, which is
 * the thing a pane kept for easy access exists to keep - Robert, 2026-08-27: "i keep
 * session 2 and 5 kept open just for easy access... maybe to save resources you can sleep
 * them". Measured on this desk 2026-08-28, eight live `claude` panes: 61, 64, 153, 166,
 * 174, 177, 231 and 247 MB, 1.27 GB in total, none of it doing anything.
 *
 * Five minutes, the same as the close clock, and that is the point: sleeping is what this
 * app does to an idle pane, and closing is what it does when it is also allowed to take
 * the card away. Half an hour was set when sleeping was the new rung and the risk was
 * unknown; measured since, a slept pane costs nothing to wake and loses nothing, so the
 * conservative number was buying a quarter of an hour of a CLI sitting on ~190 MB doing
 * nothing. Robert, 2026-08-31: "we need timer as well 5 mins to sleep otherwise uses lots
 * of resources".
 */
export const IDLE_SLEEP_MINUTES = 5

export const DEFAULT_RECLAIM: ReclaimConfig = {
  enabled: true,
  minIdleMinutes: 15,
  maxPerSweep: 2,
  idleCloseMinutes: IDLE_CLOSE_MINUTES,
  idleSleepMinutes: IDLE_SLEEP_MINUTES,
  defaultsV2: true,
  defaultsV3: true,
  defaultsV4: true
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
  /**
   * The pane is ASLEEP: its agent has already been given back and the card is what
   * somebody is keeping (`shared/sleep.ts`).
   *
   * It arrives here wearing `state: 'exited'`, which is in `CLOSEABLE` - so without this
   * both sweeps would close the very pane sleeping exists to keep, and buy nothing at all
   * for it. There is no memory left in a sleeping pane to reclaim.
   */
  asleep?: number
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

/**
 * Has this pane printed something since the keyboard last left it - a turn nobody has read.
 *
 * The idle clock counts from the last printed byte, so an agent that finishes a turn while
 * somebody is in another pane starts its own countdown: the answer is on screen, nobody has
 * seen it, and ten minutes later the pane is gone with it. Robert, 2026-08-27: "if you havent
 * read the output then the closes in countdown wont start".
 *
 * `lastFocus` is stamped when the keyboard ARRIVES at a pane as well as when it leaves, so
 * "read" here means the pane has had the keyboard at some point after its last output. A
 * pane being read right now is `focused` and already exempt; the moment it is left, the
 * stamp lands after the output and the clock starts from there.
 *
 * It holds the idle CLOCK only. `reclaimPlan` fires on real memory pressure, where holding
 * an unread pane open is the more expensive of the two mistakes.
 */
export function unread(p: Pick<ReclaimPane, 'lastOutput' | 'lastFocus'>): boolean {
  return (p.lastOutput ?? 0) > (p.lastFocus ?? 0)
}

export interface Reclaim {
  id: string
  /** How long it had been quiet, ms. Goes in the log line so the choice is auditable. */
  idleMs: number
  /** Whether closing it frees an agent, or only a buffer. */
  hadAgent: boolean
  /**
   * The moment this pane's own idle clock runs out - the same number `idleCloseAt` puts on
   * the card.
   *
   * It is here because the countdown is armed BEFORE the deadline rather than after it,
   * and the two have to agree. Armed after, the card said `closes now`, nothing happened
   * for up to a whole sweep, and then fifteen seconds appeared from nowhere - reported
   * 2026-08-31 as "it was stuck on closes now then the timer went back to 0:10".
   */
  dueAt?: number
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
        !p.asleep &&
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
 * The panes the idle clock would take, in the order it would take them.
 *
 * One function, because the card and the sweep must not disagree about a single pane:
 * `idleClosePlan` closes these and `idleCloseAt` draws a countdown for exactly these. It
 * used to be two readings, and the pane they disagreed about was the one the last-pane
 * rule holds back - its card said `closes now` and nothing was ever going to close it.
 * Measured 2026-09-01: with no focused pane, one pane on a quiet desk sat at `closes now`
 * for the whole run and never went.
 *
 * The last-pane rule is kept - an app that empties its own window has not saved anything,
 * it has removed the reason the window is open - so the fix is that the held-back pane is
 * not on the clock at all, rather than on a clock that never rings.
 */
export function dueForIdleClose(
  panes: ReclaimPane[],
  cfg: ReclaimConfig = DEFAULT_RECLAIM,
  now = 0,
  personHere = true,
  lead = 0
): ReclaimPane[] {
  if (!cfg.enabled) return []
  const minutes = Math.max(0, cfg.idleCloseMinutes ?? 0)
  if (!minutes) return []
  // `maxPerSweep` is no longer a cap here, but zero still means the sweeps are switched
  // off and this clock is one of them.
  if (!(cfg.maxPerSweep > 0)) return []
  const minIdle = minutes * 60_000

  const eligible = panes
    .filter((p) => onTheClock(p, personHere))
    .filter((p) => now + lead - quietSince(p) >= minIdle)
    // Oldest quiet first, so the one held back is the one that went quiet most recently.
    .sort((a, b) => quietSince(a) - quietSince(b))

  const keepAtLeastOne = panes.length - eligible.length < 1 ? 1 : 0
  return eligible.slice(0, Math.max(0, eligible.length - keepAtLeastOne))
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
  now = 0,
  personHere = true,
  /**
   * How far AHEAD of the deadline a pane may be picked, ms.
   *
   * Zero is "only panes already past their clock", which made the countdown the one thing
   * on screen that runs after the clock it belongs to has already finished. With a lead,
   * the countdown IS the last seconds of the card's own clock and the number only ever
   * goes down.
   */
  lead = 0
): Reclaim[] {
  const eligible = dueForIdleClose(panes, cfg, now, personHere, lead)
  if (!eligible.length) return []
  const minIdle = Math.max(0, cfg.idleCloseMinutes ?? 0) * 60_000

  // NOT capped at `maxPerSweep`. That cap belongs to the pressure sweep, which closes a
  // pane in order to change a reading of the machine and is worth taking that reading again
  // between panes. Nothing here reads the machine - this clock only knows that nobody has
  // touched these panes for minutes - so the cap bought no accuracy and cost the truth of
  // the card: with one countdown on screen at a time, seven due panes closed two at a time
  // and the last one sat wearing `closes now` for 54 seconds (measured 2026-09-01, real
  // `idleClosePlan` stepped at the sweep's own 5s). Robert: "shows closes now tag but it
  // wasnt closing at all or too slow to close".
  return eligible.map((p) => ({
    id: p.id,
    // Never the lead: this is how long the pane has REALLY been quiet, and it is what the
    // log line is read back for.
    idleMs: Math.max(0, now - quietSince(p)),
    hadAgent: p.state !== 'exited',
    dueAt: quietSince(p) + minIdle
  }))
}

/**
 * Which panes have been unused long enough to have their agent stopped and their card kept.
 *
 * The rung BELOW closing, and the reason the close clock can stay off on the desk somebody
 * is sitting at: everything a person would miss survives a sleep, so the refusals can be
 * the same ones without the price of being wrong. `onTheClock` is shared with
 * `idleClosePlan` verbatim - never a pane that is focused, unread, working, running a job,
 * holding a question, mid-handoff, pinned, another machine's, or already asleep.
 *
 * Three things `idleClosePlan` does that this deliberately does not:
 *   - it keeps one pane back, because an app that empties its own window has saved nothing.
 *     Sleeping empties nothing: every card stays where it is, wearing the screen it had.
 *   - it caps the sweep at `maxPerSweep`, because a close is worth re-reading the machine
 *     between. Nothing here depends on a reading of the machine.
 *   - it counts `visible` as no refusal for the second desk's sake. Here it never was one:
 *     a sleeping pane looks the same as it did, so being on screen changes nothing.
 *
 * And it does not refuse an UNREAD pane, which is the one refusal that is about a pane
 * disappearing - see `keepable`. Nothing disappears here, and a pane nobody has focused
 * yet is unread for ever, so keeping it would make this clock inert.
 */
export function idleSleepPlan(
  panes: ReclaimPane[],
  cfg: ReclaimConfig = DEFAULT_RECLAIM,
  now = 0
): Reclaim[] {
  if (!cfg.enabled) return []
  const minutes = Math.max(0, cfg.idleSleepMinutes ?? IDLE_SLEEP_MINUTES)
  if (!minutes) return []
  const minIdle = minutes * 60_000
  return panes
    .filter(sleepable)
    .filter((p) => now - quietSince(p) >= minIdle)
    .sort((a, b) => quietSince(a) - quietSince(b))
    .map((p) => ({ id: p.id, idleMs: now - quietSince(p), hadAgent: p.state !== 'exited' }))
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
function onTheClock(p: ReclaimPane, personHere = true): boolean {
  return (
    // Only while there is somebody here to have read it. A machine no person has touched
    // this run (`Away.sawPerson`) is the second desk this clock exists for: nothing there
    // is ever read, so an unread refusal would switch the feature off on the one machine
    // that needs it.
    !(personHere && unread(p)) && keepable(p)
  )
}

/**
 * The refusals that are about the PANE rather than about having read it.
 *
 * Split out because sleeping and closing disagree on exactly one of them. `unread` is
 * there so a turn nobody has seen is not taken off the desk before they see it - which is
 * a statement about the pane VANISHING. A sleeping pane vanishes nothing: the card, its
 * place and every row on its screen stay exactly where they are, and a pane never focused
 * at all reads as unread for ever (`lastFocus` is undefined), so keeping it here would
 * make the sleep clock inert on the desk it was built for. Measured on this machine: two
 * eligible panes, quiet 126s against a 60s clock, neither slept.
 */
/**
 * The refusals the SLEEP clock keeps, which is `keepable` minus exactly one of them.
 *
 * `pinned` - "keep this one open" - is an instruction about the CARD. Somebody who said it
 * meant that the pane must still be there when they come back, and a slept pane is: its
 * card, its place, its screen and its conversation are all exactly where they were, and a
 * press wakes it in the same chat. What sleeping gives back is the agent, which is the
 * ~190 MB that made the pane worth a rule in the first place.
 *
 * So a kept pane is exempt from closing and NOT from sleeping, which is what makes "keep
 * it open" cost nothing to say. Robert, 2026-08-31: "sessions even if kept open should
 * still sleep ... otherwise uses lots of resources". Every other refusal is shared
 * verbatim, `asleep` included - a sleeping pane is the outcome, not a candidate.
 */
function sleepable(p: ReclaimPane): boolean {
  return keepable({ ...p, pinned: false })
}

function keepable(p: ReclaimPane): boolean {
  return (
    !p.focused &&
    !p.remote &&
    !p.handingOff &&
    !p.asking &&
    !p.busy &&
    !p.job &&
    !p.backJob &&
    !p.pinned &&
    !p.asleep &&
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
  now = 0,
  personHere = true,
  /**
   * Every local pane, so this can refuse the one the last-pane rule holds back.
   *
   * Optional only because the answer without it is the one this function always gave.
   * Pass it: a card is the only place that refusal is visible, and without the list this
   * draws `closes now` on the pane that is never going to be closed.
   */
  all?: ReclaimPane[]
): number | null {
  if (!cfg.enabled) return null
  const minutes = Math.max(0, cfg.idleCloseMinutes ?? 0)
  if (!minutes) return null
  if (!onTheClock(pane, personHere)) return null
  if (all && !dueForIdleClose(all, cfg, now, personHere).some((p) => p.id === pane.id)) {
    // Not "later": the last-pane rule does not lift while the desk stays as it is, and a
    // pane that has not reached its own clock yet is caught by the arithmetic below.
    if (now - quietSince(pane) >= minutes * 60_000) return null
  }
  const at = quietSince(pane) + minutes * 60_000
  // A pane already past its deadline is due NOW, not overdue by four minutes: the sweep
  // runs on a minute timer, so `now` is regularly a little past the moment it was due and
  // a chip counting UP from zero reads as a clock that jammed.
  return Math.max(at, now)
}

/**
 * Whether a freshly computed deadline is the same FACT as the one already published.
 *
 * `idleCloseAt` clamps an overdue pane to `now` so its chip cannot count up from zero, and
 * `now` moves on every single session broadcast - so the publisher in the renderer wrote a
 * new number, `setClosingAt` saw it move and emitted a session list, that list re-ran the
 * publisher, and it wrote a newer number still. A pane past its idle deadline therefore
 * span a full main->renderer->main round trip as fast as the event loop would carry it,
 * broadcasting the whole desk (and every paired phone) each time, until the minute sweep
 * finally closed it. That is also what "the countdown stops at 0:01" was: `at` was dragged
 * forward to `now` faster than the second could tick, so `ceil((at - now) / 1000)` never
 * reached 0 and the chip never said `now`.
 *
 * Due is ONE state, not a number that moves. Two deadlines that are both in the past (or
 * exactly now) are the same fact and must not be republished; everything else is compared
 * exactly, so an ordinary countdown still updates the instant it really changes.
 */
export function sameDeadline(
  prev: number | undefined,
  next: number | undefined,
  now: number
): boolean {
  if (prev === next) return true
  if (prev === undefined || next === undefined) return false
  return prev <= now && next <= now
}
