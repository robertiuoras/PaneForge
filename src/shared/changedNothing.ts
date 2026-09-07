// A turn that finished having changed no file in the project it was working in.
//
// The other end of `shared/cloudWork.ts`. That one answers "the pane looks finished and
// is not"; this one answers "the pane looks finished and nothing came of it". Both are
// the same failure wearing opposite clothes: the card is green, the composer is back, and
// the reading a person takes off the pane is wrong.
//
// The evidence for this one is on disk rather than on screen. An agent that answers
// "done" having written nothing is the one failure an exit code cannot show -
// `dannymac180/fable-advisor`, mined 2026-09-07, names it exactly: "An empty diff with a
// clean exit is a refusal, not a success", observed live when a machine-wide instruction
// file made a delegated run decline politely and return 0. The same ending arrives in a
// pane for a dozen duller reasons: the CLI hit a usage limit and said so, a permission
// was refused, a hook blocked the edit, the model answered the ask as a question instead
// of doing it. Every one of them looks identical from outside - a turn ends, the pane
// goes quiet and green, and the project is byte-for-byte what it was.
//
// So: read the checkout when a turn starts, read it again when the turn ends, and if the
// two readings agree say so in three words on the pane.
//
// It DECORATES and REFUSES. It reaches no busy reading, holds no clock and closes
// nothing - the same contract as `Session.backJob` and `shared/handoffSteps.ts` - because
// "this turn wrote nothing" is information about a turn, never a verdict about whether
// the pane is finished with.
//
// The load-bearing half is the refusals. A reading that could not be taken must come back
// as "say nothing", never as "nothing changed": an unreadable folder, a pane that is not
// in a git checkout, a status that timed out. Each of those is a FAILED reading, and a
// failed reading drawn as a chip is the app calling somebody's work wasted on no
// evidence. Empty must never share a shape with success.
//
// `npm run test:changednothing`.

/**
 * How long a turn has to run before its emptiness is worth saying anything about.
 *
 * A turn of a few seconds is an acknowledgement - "yes", "which file?", "done, see
 * above" - and an acknowledgement changes no files by design. Chipping those would put
 * the words on almost every pane almost all of the time, which is the fastest way to make
 * a reading mean nothing. Half a minute is comfortably longer than any answer that was
 * never going to touch the disk, and comfortably shorter than the smallest real piece of
 * work.
 */
export const MIN_TURN_MS = 30_000

/**
 * What a reading of the checkout is.
 *
 * Deliberately opaque above `main/changedNothing.ts`: it is whatever string that reader
 * builds out of the folder, and the only thing anything else may do with two of them is
 * ask whether they are the same. An empty string is not a reading - it is the reader
 * saying it could not take one - and every refusal below turns on that.
 */
export type Shot = string

export interface TurnEnd {
  /** the checkout as it was when the turn started, or undefined if nobody could read it */
  before?: Shot
  /** the checkout as it is now, or undefined if this reading failed */
  after?: Shot
  /** when the turn started, so a two-second answer is not called a wasted turn */
  startedAt?: number
  /** when it ended */
  endedAt?: number
  /** an agent pane, rather than a plain shell one */
  agent: boolean
  /** a pane belonging to the other machine, drawn here */
  mirror?: boolean
  /** the pane is sitting on a question, so the turn is paused rather than over */
  asking?: boolean
}

/**
 * Did this turn leave the project exactly as it found it?
 *
 * `true` only when two readings were actually taken and they agree. Everything else - a
 * missing reading, a short turn, a shell pane, a mirror, a pane waiting to be answered -
 * is `false`, which is the app declining to say anything rather than saying no.
 */
export function changedNothing(turn: TurnEnd): boolean {
  // A failed reading is not a finding. Both ends must exist, and neither may be the empty
  // string the reader returns when it could not look at the folder.
  if (!turn.before || !turn.after) return false

  // A shell pane that changes no file is the ordinary case: `git log`, `ls`, `npm test`.
  // Only an agent was asked to change something.
  if (!turn.agent) return false

  // A mirror judges nothing, here as everywhere else in this app: the folder it would be
  // reading is on the other machine, and that machine has already read it.
  if (turn.mirror) return false

  // A pane on a question has not finished a turn, it has paused one.
  if (turn.asking) return false

  // An answer is not a wasted turn.
  const { startedAt, endedAt } = turn
  if (!startedAt || !endedAt) return false
  if (endedAt - startedAt < MIN_TURN_MS) return false

  return turn.before === turn.after
}

/**
 * The words on the chip, or null when there is nothing to say.
 *
 * Three words, in the reader's own vocabulary. Not "empty diff", not "no changes staged",
 * not "working tree clean" - the person reading this pane has never used git, and what
 * they want to know is whether the last half hour produced anything.
 */
export function changedNothingWords(turn: TurnEnd): string | null {
  return changedNothing(turn) ? 'changed no files' : null
}

/**
 * ...and the sentence the chip carries on hover.
 *
 * Names the project, because somebody with eight panes open is being told something about
 * one folder and needs to know which. `place` is `shared/place.ts`'s words for the pane -
 * `PaneForge copy 2` - and an absent one leaves the sentence general rather than wrong.
 */
export function changedNothingWhy(place?: string): string {
  const where = place ? ` in ${place}` : ''
  return (
    `This turn finished without changing any file${where}. ` +
    `That is often a refusal reported politely: a usage limit, a permission it was not given, ` +
    `or an ask it answered instead of doing.`
  )
}
