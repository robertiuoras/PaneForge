// Where the prompt tags sit on a pane's marker rail.
//
// A tag points at the scrollbar thumb that would bring its prompt into view, so its
// honest position is a plain fraction of the track. Two of them then land on top of
// each other: a conversation is ask, short answer, ask again, so consecutive prompts
// sit a few buffer lines apart and their tags land ~1.7px apart while the hit box a
// tag grows is 18px tall. Separating them is what makes the rail clickable.
//
// The separation used to be a greedy cascade - push each tag at least SEP below the one
// before it, then pull the run back up from the last one - and it was wrong in both
// directions at once. Measured over a 352px rail (a pane in a 2x2 grid):
//
//   100 prompts evenly spread   11 tags drawn PAST the end of the rail, the last 44px
//                               below it - over the terminal, outside the pane
//   40 prompts bunched near the top (the shape a real conversation has)
//                               worst tag displaced 304.8px, mean 147px: the tag for
//                               the first ask drawn near the BOTTOM of the rail
//
// The cascade accumulates - every tag in a cluster pushes the whole tail down - and its
// only clamp is at 0, so nothing bounds the bottom. `SEP` had a 4px floor, so once
// (n-1)*4 exceeded the rail the run simply ran off it.
//
// What we want instead is the placement closest to the truth that still keeps the tags
// apart and on the rail: minimise the total squared displacement subject to
// `x[i+1] >= x[i] + sep` and `0 <= x[i] <= span`. That is isotonic regression, and PAVA
// solves it exactly in one pass - see `dodge`. A cluster now spreads around where it
// actually is instead of dragging everything below it downward.

/** The drawn bar's height, in px (`.mark` in TerminalPane.css). */
export const BAR = 8
/** The most a tag is moved off its true position to clear its neighbour. */
export const MAX_SEP = 12
/** The most hit box a tag grows on each side - what an isolated tag has always had. */
export const MAX_HIT = 6
/**
 * The furthest a tag may end up from the thumb it points at, whatever the crowding.
 *
 * Separation is the thing that gives, not the position. Holding 12px between tags is
 * only ever a convenience for clicking; being drawn beside the wrong part of the buffer
 * is the rail failing at the one thing it is for.
 *
 * The number is a share of the rail with both ends pinned, because both ends matter for
 * different reasons. A handful of consecutive prompts unpicked at the full 12px spreads
 * ~48px - that has to stay allowed, or the fix for the unclickable cluster is undone on
 * the commonest shape there is. And 48px of a short rail is most of the pane, so a small
 * pane gets less. Between them the budget is 15% of the rail: enough that a tag is still
 * visibly beside the thumb it means.
 */
export function driftCap(span: number): number {
  return Math.min(4 * MAX_SEP, Math.max(2 * MAX_SEP, span * 0.15))
}

/**
 * How far apart to hold neighbouring tags on a rail this tall.
 *
 * 12px is comfortable; a crowded rail gets less rather than being allowed to overflow,
 * and there is deliberately no floor. A rail carrying more tags than it has pixels for
 * is a full rail - packing them is honest, drawing the tail somewhere off the pane is
 * not. `hitFor` below then gives those tags the small targets they really have.
 */
export function separation(n: number, span: number): number {
  if (n < 2) return MAX_SEP
  return Math.max(0, Math.min(MAX_SEP, span / (n - 1)))
}

/**
 * The largest separation that still keeps every tag within `MAX_DRIFT` of the truth.
 *
 * A single separation for the whole rail is what made the bunched case hopeless: 42
 * prompts can afford 8.58px each across a 352px rail, but 40 of them sat inside the
 * first 30px of it, and holding those 40 apart at 8.58px needs 334px of rail - so the
 * cluster had to be smeared across the whole pane to obey a number chosen for the rail
 * as a whole. Measured: the tag for the first ask landed 304.8px from it.
 *
 * Displacement only ever grows with separation, so the largest acceptable one is a
 * bisection. 24 rounds over at most a few hundred tags is nothing next to the repaint
 * it feeds, and it runs only when the cheap answer is already good enough to keep.
 */
export function fitSeparation(raw: number[], span: number): number {
  const wide = separation(raw.length, span)
  const cap = driftCap(span)
  if (raw.length < 2 || drift(raw, wide, span) <= cap) return wide
  let lo = 0
  let hi = wide
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (drift(raw, mid, span) <= cap) lo = mid
    else hi = mid
  }
  return lo
}

/** How far the worst-placed tag ends up from where it belongs. */
function drift(raw: number[], sep: number, span: number): number {
  const out = dodge(raw, sep, span)
  let worst = 0
  for (let i = 0; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i] - raw[i]))
  return worst
}

/**
 * The placement nearest `raw` that keeps neighbours `sep` apart and every tag inside
 * `[0, span]` - minimum total squared displacement, so no tag moves further than the
 * crowding actually forces.
 *
 * `y[i] = x[i] - i*sep` turns the separation constraint into "y is non-decreasing", which
 * is isotonic regression on the shifted targets; the pool-adjacent-violators loop below
 * averages each block of violators, which is its exact solution. The box is the same
 * interval for every `y`, so clamping the targets into it first is exact too rather than
 * an approximation: an average of values inside an interval is inside it.
 */
export function dodge(raw: number[], sep: number, span: number): number[] {
  const n = raw.length
  if (!n) return []
  // The highest a shifted target may sit and still leave room for the tags below it.
  // `separation` guarantees (n-1)*sep <= span, so this is never negative.
  const hi = Math.max(0, span - (n - 1) * sep)
  const z = raw.map((v, i) => Math.min(hi, Math.max(0, v - i * sep)))

  const value: number[] = []
  const count: number[] = []
  for (const v of z) {
    value.push(v)
    count.push(1)
    // Any block that now sits above the one after it is not a valid answer for either;
    // their common average is, and merging can expose a violation further back.
    while (value.length > 1 && value[value.length - 2] > value[value.length - 1]) {
      const vb = value.pop() as number
      const cb = count.pop() as number
      const va = value.pop() as number
      const ca = count.pop() as number
      value.push((va * ca + vb * cb) / (ca + cb))
      count.push(ca + cb)
    }
  }

  const out: number[] = []
  for (let b = 0; b < value.length; b++) {
    for (let k = 0; k < count[b]; k++) out.push(value[b])
  }
  return out.map((v, i) => v + i * sep)
}

export interface RailTag {
  /** Where the bar is drawn, in px from the top of the rail. */
  top: number
  /** How far the invisible hit box reaches above and below the bar. */
  hitUp: number
  hitDown: number
}

/**
 * Half the space to each neighbour, so no tag can reach into another's, capped at the
 * 6px that made an isolated tag a comfortable target in the first place.
 */
function hitFor(gap: number): number {
  return Math.max(0, Math.min(MAX_HIT, (gap - BAR) / 2))
}

/**
 * `raw` is each tag's honest position, oldest first and already non-decreasing (the
 * caller's `floor` keeps the rail's one promise: top to bottom is oldest to newest).
 * `span` is the rail less one scrollbar thumb - the range a thumb's top edge covers.
 */
export function placeRail(raw: number[], span: number): RailTag[] {
  const room = Math.max(0, span)
  const want = raw.map((v) => Math.min(room, Math.max(0, v)))
  const tops = dodge(want, fitSeparation(want, room), room)
  return tops.map((top, i) => ({
    top,
    hitUp: i > 0 ? hitFor(top - tops[i - 1]) : MAX_HIT,
    hitDown: i < tops.length - 1 ? hitFor(tops[i + 1] - top) : MAX_HIT
  }))
}
