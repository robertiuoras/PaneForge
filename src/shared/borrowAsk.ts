// When a mirror may ask the host for a different grid, and when it must stop asking.
//
// A mirrored pane asks the machine that owns the pty to draw it at the grid this window
// has room for (`borrowGrid` in mirrorFit.ts), and the host lends every borrower the
// SMALLEST grid asked for (`shared/paneSize.ts`). Those two rules are each right and
// together they can storm:
//
//   1. The ask target is computed from `proposeDimensions()`, which is a floor of a
//      pixel ratio. A scrollbar appearing, a font step, a scale transform settling - any
//      of them moves the answer by ONE cell, so the target alternates 153x51, 152x51,
//      153x51...
//   2. The old guard keyed a try counter on the exact target: the same numbers were
//      asked at most `TRIES` times, and a DIFFERENT target started the count again.
//      Alternating by one cell therefore reset the counter on every pass, so the cap
//      never applied: the mirror asked on every repaint, the host resized the pty
//      between two grids, and a full-screen CLI redrew its whole frame each time. That
//      is "it resizes many times to fill the space, then loops and breaks".
//   3. And a grid the host can never grant - a second viewer (a phone, another mirror)
//      is smaller, so `smallestBorrow` wins - is a target that is never reached, so
//      "ask until it is applied" is an ask for ever.
//
// So the deadband is the fix, not a bigger counter: two targets within a cell of each
// other are the SAME target, and a burst of genuinely different targets is capped by a
// budget over a window that no amount of alternation can reset.

/** No faster than this for the same target. */
export const BORROW_EVERY_MS = 1200
/** How many times one target may be re-stated before giving up on it. */
export const BORROW_TRIES = 6
/**
 * Cells of slack that count as "the same grid".
 *
 * One cell, because that is the size of every rounding artefact in the measurement, and
 * because a mirror drawing one column of slack is invisible while a mirror re-wrapping
 * the far end's screen twice a second is not.
 */
export const BORROW_DEADBAND = 1
/** The storm brake: at most this many asks... */
export const BORROW_WINDOW_MAX = 8
/** ...in this long, however many different targets they name. */
export const BORROW_WINDOW_MS = 10_000

export interface BorrowAsk {
  cols: number
  rows: number
  /** when this target was last asked for */
  at: number
  /** how many times it has been asked */
  tries: number
  /** every ask in the recent past, oldest first - the window brake reads this */
  recent: number[]
}

export interface AskIn {
  /** what the mirror wants now */
  cols: number
  rows: number
  /** the grid the host is actually drawing - no ask is needed when they already agree */
  hostCols: number
  hostRows: number
  now: number
  state: BorrowAsk | null
}

export interface AskOut {
  ask: boolean
  state: BorrowAsk | null
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= BORROW_DEADBAND

/**
 * One decision, and the state to carry to the next one.
 *
 * `state` is returned rather than mutated so the caller can hold it in a ref and a test
 * can hold it in a variable.
 */
export function shouldAsk(i: AskIn): AskOut {
  // Already drawn at the grid we want, to within the same slack the deadband allows.
  // Asking for a cell the host is only rounding away is the storm's first step.
  if (near(i.cols, i.hostCols) && near(i.rows, i.hostRows)) return { ask: false, state: i.state }

  const prev = i.state
  const recent = (prev?.recent ?? []).filter((t) => i.now - t < BORROW_WINDOW_MS)

  if (prev && near(prev.cols, i.cols) && near(prev.rows, i.rows)) {
    // The SAME target, whether or not the numbers are identical. This is the branch the
    // old code missed: it compared for equality, so a one-cell wobble looked new.
    if (prev.tries >= BORROW_TRIES || i.now - prev.at < BORROW_EVERY_MS)
      return { ask: false, state: { ...prev, recent } }
    return {
      ask: true,
      state: { cols: i.cols, rows: i.rows, at: i.now, tries: prev.tries + 1, recent: [...recent, i.now] }
    }
  }

  // A genuinely different target - this window was resized, or the pane was moved. It is
  // allowed, but it spends from the window budget, so alternating targets cannot buy an
  // unlimited number of asks by looking new each time.
  if (recent.length >= BORROW_WINDOW_MAX)
    return { ask: false, state: prev ? { ...prev, recent } : null }

  return {
    ask: true,
    state: { cols: i.cols, rows: i.rows, at: i.now, tries: 1, recent: [...recent, i.now] }
  }
}
