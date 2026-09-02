// What the pet is FEELING, which is only ever a reading of the desk.
//
// The sprite already had exactly two faces: standing there, and the hard blink it puts on
// while something is counting down. Everything else the desk was doing - a question nobody
// has answered, four panes printing at once, the moment a long turn finishes, an afternoon
// where nothing has happened for two hours - looked identical. So the one thing in the
// window whose whole job is to be glanced at said nothing at a glance.
//
// This is that glance. It is arithmetic over the pane list the mascot already holds
// (`MascotPane` - state, `asking`, `idleMs`), it reaches no timer of its own, and it says
// nothing out loud: the moods are CSS classes on the sprite and nothing else. Nothing here
// may make a sound, raise a window, or open anything.
//
// The one rule that is not obvious is the hysteresis. A pane list is rebuilt whenever any
// pane changes anything, which on a busy desk is several times a second, and a mood that
// followed it exactly would strobe between `work` and `idle` while one agent breathed. So
// a mood has to hold for `MIN_HOLD_MS` before another one may replace it - with a single
// exception, because a question is the one reading that is worth more the sooner it shows.
//
// Pure: no DOM, no Electron, no clock of its own - `now` is passed in. `npm run test:petmood`.

import type { MascotPane } from './mascot'

export type Mood =
  /** A pane has a live question on screen. Beacon hard, eyes ahead, no blink. */
  | 'alert'
  /** Something is printing. The arms and treads run at about half their period. */
  | 'work'
  /** A turn just finished. One hop, held for `CHEER_MS`, then it falls through. */
  | 'cheer'
  /** Nothing is happening and nothing has for a while. Lid down, beacon off. */
  | 'nap'
  /** Anything else - the drawing exactly as it has always been. */
  | 'idle'

/**
 * How long a finish is celebrated.
 *
 * Long enough to be seen by somebody looking back at the window, short enough that it is
 * over before it is scenery. It is deliberately longer than `MIN_HOLD_MS`, so a cheer
 * always survives its own hold and can never be cut short by the thing that stops flicker.
 */
export const CHEER_MS = 3000

/**
 * How quiet the desk has to be before the pet sleeps.
 *
 * Measured from the NEWEST idle reading on the desk - the most recently touched pane -
 * because one pane somebody is typing into means the desk is not quiet, however long the
 * other nine have been sitting there. Two minutes is past "reading the answer" and short
 * of "went to lunch", and being wrong about it costs a lid.
 */
export const NAP_AFTER_MS = 2 * 60 * 1000

/**
 * How long a mood has to hold before another may replace it.
 *
 * Not a taste decision: the pane list is rebuilt on every reading of every pane, so a
 * `working` pane that pauses for one sample flips the whole sprite and flips it back. A
 * mood that changes faster than somebody can look at it is noise wearing a signal's
 * clothes. `alert` is exempt - see `petMood`.
 */
export const MIN_HOLD_MS = 1500

/** What the last reading decided, and the two things it has to remember to decide again. */
export interface MoodState {
  mood: Mood
  /** Epoch ms this mood was entered - the hold and the cheer are both measured from it. */
  since: number
  /**
   * Which panes were printing at the previous reading.
   *
   * The whole of the cheer: "a turn finished" is not a state any pane carries, it is the
   * difference between two readings. Held as a set of ids rather than a count, because
   * one pane finishing while another starts leaves the count where it was.
   */
  wasWorking: Set<string>
  /**
   * Epoch ms the current cheer runs out, when one is running.
   *
   * Kept rather than derived from `since`, because a finish that arrives while the hold
   * is still holding must not be thrown away - the hop is owed, and it plays as soon as
   * the mood is allowed to change.
   */
  cheerUntil?: number
  /**
   * The pane a press on the sprite should go to while `alert`.
   *
   * Only ever a pane that is asking, and with several of them the one that has been
   * waiting longest (`idleMs` on an asking pane is time since it last printed, which is
   * time since it put the question up). Absent in every other mood - a press on a pet
   * that is not alert opens the bubble, as it always has.
   */
  goto?: string
}

/** The state a window starts in: nothing seen yet, so nothing to say. */
export function firstMood(now: number): MoodState {
  return { mood: 'idle', since: now, wasWorking: new Set() }
}

/** Which panes have a question up, longest-waiting first. */
function asking(panes: MascotPane[]): MascotPane[] {
  return panes.filter((p) => p.asking).sort((a, b) => b.idleMs - a.idleMs)
}

/** A pane that was printing last time and has stopped with something to read. */
function justFinished(panes: MascotPane[], was: Set<string>): boolean {
  return panes.some((p) => was.has(p.id) && (p.state === 'needsYou' || p.state === 'ready'))
}

/** How long the desk has been left alone: the most recently touched pane's own clock. */
function quietFor(panes: MascotPane[]): number {
  if (!panes.length) return 0
  return Math.min(...panes.map((p) => p.idleMs))
}

/**
 * The mood this reading WANTS, before the hold gets a say.
 *
 * The order is the order somebody would read the desk in: a question outranks work,
 * work outranks the moment something finished, and sleep is the absence of all three.
 */
function wanted(panes: MascotPane[], now: number, cheerUntil: number): Mood {
  if (panes.some((p) => p.asking)) return 'alert'
  if (panes.some((p) => p.state === 'working')) return 'work'
  if (now < cheerUntil) return 'cheer'
  // An empty desk is not asleep, it is a window nobody has opened a pane in yet, and a
  // pet with its eyes shut over no panes reads as broken rather than restful.
  if (panes.length && quietFor(panes) >= NAP_AFTER_MS) return 'nap'
  return 'idle'
}

/**
 * The mood, from this reading of the desk and the last one.
 *
 * Called when the pane list changes and at nothing but the next expiry (`nextMoodAt`) -
 * never on a tick. `prev` is the previous answer; the first call takes `firstMood`.
 */
export function petMood(panes: MascotPane[], now: number, prev: MoodState): MoodState {
  const working = new Set(panes.filter((p) => p.state === 'working').map((p) => p.id))

  // A finish is owed a hop even if the hold refuses it this instant - the deadline is
  // stamped here, off the reading that saw it, and the mood catches up when it may.
  let cheerUntil = prev.cheerUntil ?? 0
  if (justFinished(panes, prev.wasWorking)) cheerUntil = now + CHEER_MS

  const want = wanted(panes, now, cheerUntil)
  const heldFor = now - prev.since

  // A question wins instantly. Everything else on this sprite is decoration and can wait
  // a second and a half; the one reading that means somebody is BLOCKED cannot, and it is
  // also the one that never flickers - a question is up until it is answered.
  const may = want === 'alert' || heldFor >= MIN_HOLD_MS
  const mood = want === prev.mood || !may ? prev.mood : want

  const first = mood === 'alert' ? asking(panes)[0] : undefined

  return {
    mood,
    since: mood === prev.mood ? prev.since : now,
    wasWorking: working,
    // The debt is cleared once it has been paid, so a second finish an hour later is a
    // second hop rather than a mood that never leaves `cheer`.
    cheerUntil: now < cheerUntil ? cheerUntil : undefined,
    goto: first?.id
  }
}

/**
 * When this mood could change on its own, with nothing on the desk moving. `null` when it
 * cannot, which is most of the time - that is what stops the caller arming a timer at all.
 *
 * Three things expire without a new reading: a cheer running out, a quiet desk crossing
 * into `nap`, and a change the hold is currently refusing.
 */
export function nextMoodAt(panes: MascotPane[], now: number, state: MoodState): number | null {
  const at: number[] = []
  if (state.cheerUntil && state.cheerUntil > now) at.push(state.cheerUntil)

  const quiet = quietFor(panes)
  if (
    panes.length &&
    !panes.some((p) => p.asking) &&
    !panes.some((p) => p.state === 'working') &&
    quiet < NAP_AFTER_MS
  ) {
    at.push(now + (NAP_AFTER_MS - quiet))
  }

  const want = wanted(panes, now, state.cheerUntil ?? 0)
  if (want !== state.mood && now - state.since < MIN_HOLD_MS) at.push(state.since + MIN_HOLD_MS)

  if (!at.length) return null
  return Math.min(...at)
}
