// A pane kept for easy access, without the agent it was keeping.
//
// Robert, 2026-08-27: "i keep session 2 and 5 kept open just for easy access... maybe to
// save resources you can sleep them or keep them under super low resource usage? but if i
// open them then it should show layout and everything perfectly".
//
// The card is free and the CLI is the bill. Measured on this desk 2026-08-28, eight live
// `claude` panes: 61, 64, 153, 166, 174, 177, 231 and 247 MB, 1.27 GB in total. Nothing
// this app can do to a pane gives any of that back except ending the process, which is
// what `reclaim.ts` does by CLOSING the pane - and closing takes the card off the desk,
// which is the one thing a pane kept for easy access exists to keep.
//
// So sleeping is the same saving with the card left where it is: the pty dies, the row
// stays in its place in the sidebar wearing an `asleep` chip, and a press wakes it. What
// makes that safe is that everything needed to come back already exists and is already
// tested. `kill()`/`onExit` call `recordEnd`, so the History row, `resumeId` and the
// pane's own scrollback log survive an ended process (`test:restore`, `test:scrollback`),
// and a woken pane keeps its ID - so the terminal in front of it is never unmounted and
// its xterm buffer is untouched. Waking writes no RESET for that exact reason: what is on
// screen IS what was on screen, rather than a replay of it, so there is no width to get
// wrong (`shared/replayWidth.ts` is the harder problem this one does not have).
//
// Pure: no Electron, no `os`. `npm run test:sleep`.

/** What sleeping needs to know about a pane. A subset of `Session`, so both ends fit. */
export interface SleepPane {
  /** A pane whose process has already ended has nothing to give back. */
  status: string
  /** Already asleep - waking is the only thing left to do to it. */
  asleep?: number
  /** Somebody else's pty over the device link: sleeping it would end THEIR pane. */
  mirror?: boolean
  /** A turn is running. */
  busy?: boolean
  /** The pane is sitting on a question - see `shared/choices.ts`. */
  asking?: boolean
  /**
   * Something the pane is running that is not a turn: a shell command (`paneJob.ts`) or
   * a background job an agent left behind (`paneBackJobs.ts`).
   *
   * These are two readings taken different ways and one of them has been wrong before -
   * `reclaim.ts` refuses on both for that reason, and so does this. A pane running
   * `npm run dev` looks idle from every angle except this one.
   */
  job?: string
  backJob?: string
}

/**
 * May this pane be put to sleep?
 *
 * Every refusal is something that would be LOST rather than paused. A conversation is
 * not in that set - it is on disk and `--resume` brings it back - which is the whole
 * reason this is cheaper than it sounds.
 *
 * The focused pane and one that is on screen are deliberately NOT refused. Both are
 * `reclaim.ts` refusals and they are refusals of an AUTOMATIC action: nobody asked for
 * that one, so it may not reach a pane somebody is looking at. Sleeping is a press on
 * that pane's own menu, and refusing to act on the pane whose menu is open would leave
 * the feature unreachable on a desk showing every pane at once.
 */
export function canSleep(p: SleepPane): boolean {
  if (p.status === 'exited' || p.asleep) return false
  if (p.mirror) return false
  if (p.busy || p.asking) return false
  if (p.job || p.backJob) return false
  return true
}

/** Why a pane may not be slept, for the menu row's tooltip. Empty when it may. */
export function sleepRefusal(p: SleepPane): string {
  if (p.asleep) return 'This pane is already asleep.'
  if (p.status === 'exited') return 'This pane has already ended.'
  if (p.mirror) return 'This pane belongs to another machine - sleep it over there.'
  if (p.asking) return 'This pane is waiting for an answer.'
  if (p.busy) return 'This pane is mid-turn.'
  if (p.job) return `This pane is running ${p.job}.`
  if (p.backJob) return `This pane left ${p.backJob} running.`
  return ''
}

/**
 * What the PIN says, given what else the card is already saying.
 *
 * `kept open` is the reading for a pane that is running: it is the only thing left on the
 * card about the idle clock, and it means "this one is never closed for being idle". On a
 * SLEEPING pane it reads as a flat contradiction - the card said `kept open` on one line
 * and `asleep 2h 36m` on the next (reported 2026-08-30), and the word people take out of
 * `open` is "still running", which is the one thing a slept pane is not.
 *
 * The pin still does something there - the pressure sweep and the idle clock both refuse a
 * pinned pane, so the CARD is never taken away - so the chip stays and only the word
 * narrows. `kept` beside `asleep 2h 36m` is two facts; `kept open` beside it was two
 * readings that disagree.
 */
export function keptWords(asleep: boolean): string {
  return asleep ? 'kept' : 'kept open'
}

/** What the card says where its clock would be. */
export function sleepWords(asleep: number, now: number): string {
  const mins = Math.max(0, Math.floor((now - asleep) / 60_000))
  if (mins < 1) return 'asleep'
  if (mins < 60) return `asleep ${mins}m`
  const h = Math.floor(mins / 60)
  return `asleep ${h}h ${String(mins % 60).padStart(2, '0')}m`
}
