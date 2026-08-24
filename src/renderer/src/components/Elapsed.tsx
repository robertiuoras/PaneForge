// Live "how long has this been running" readout.
//
// One timer for the whole app: a dozen sidebar rows each running their own
// setInterval would be a dozen wakeups a second for the same tick, and every one
// of them would re-render its parent.

import { useEffect, useState } from 'react'
import { bucketOf, formatElapsed, kb, stepFor } from '@shared/elapsed'

// Re-exported so the dozen files that already import these from here keep working: the
// rules moved to `shared/elapsed.ts` to be testable, not to be relocated for callers.
export { formatElapsed, kb, stepFor }

/**
 * A subscriber, and the size of the step it actually cares about.
 *
 * Every clock used to be woken once a second, whatever it drew. That is right for `42s`
 * and pure waste for `12h 04m`, which changes 60 times less often - and the pane header's
 * "open for" clock is one per pane, so on a desk of eight panes it was 8 React renders a
 * second, for ever, to redraw a string that was already correct 59 times out of 60.
 *
 * The timer stays ONE interval for the whole app (a dozen setIntervals for the same tick
 * is the thing this file was written to avoid). What changed is that a tick is delivered
 * to a subscriber only when the bucket it named has actually turned over.
 */
interface Sub {
  fn: (t: number) => void
  step: number
  /**
   * What the buckets are measured FROM, which has to be the clock's own start.
   *
   * Bucketing on the wall minute instead looks identical in a unit test and is wrong on
   * screen: a pane opened at 09:00:30 turns over its displayed minute at :30 past, so a
   * bucket aligned to :00 leaves the header reading `1h 04m` for up to 59 seconds after it
   * became `1h 05m`. A slow clock that is never WRONG is the whole point of the step.
   */
  offset: number
  bucket: number
}

const subs = new Set<Sub>()
let timer: ReturnType<typeof setInterval> | null = null

/** `force` ignores the buckets: a window coming back on screen must be right at once. */
function tick(force = false): void {
  const now = Date.now()
  for (const s of subs) {
    const bucket = bucketOf(now, s.step, s.offset)
    if (!force && bucket === s.bucket) continue
    s.bucket = bucket
    s.fn(now)
  }
}

// Chromium throttles timers in an occluded window to about one a minute, so the
// readout can be a minute stale the moment you look at it again. Catching focus
// and visibility changes makes it correct as soon as it is on screen.
function wake(): void {
  if (subs.size) tick(true)
}

function subscribe(sub: Sub): () => void {
  subs.add(sub)
  if (!timer) {
    timer = setInterval(() => tick(), 1000)
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', wake)
  }
  return () => {
    subs.delete(sub)
    if (subs.size === 0 && timer) {
      clearInterval(timer)
      timer = null
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }
}

/**
 * Wall clock shared by every component that asks, updated no faster than it is read.
 *
 * `step` is the smallest unit the CALLER draws: 1000 for a seconds readout, 60000 for one
 * that shows minutes, `Infinity` for a clock that has stopped. Asking for a bigger step
 * costs nothing and saves a render.
 */
export function useNow(step = 1000, offset = 0): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!Number.isFinite(step)) return
    return subscribe({ fn: setNow, step, offset, bucket: bucketOf(Date.now(), step, offset) })
  }, [step, offset])
  return now
}

interface Props {
  since: number
  /** freeze the clock (an exited session's runtime should stop counting) */
  until?: number
  className?: string
  title?: string
}

export default function Elapsed({ since, until, className = 'elapsed', title }: Props): JSX.Element {
  // A frozen clock subscribes to nothing at all - it was still being woken every second to
  // recompute a number that cannot change. The step is derived from the reading itself, so
  // a pane crossing its first hour drops to minute ticks on the next render.
  const step = until !== undefined ? Infinity : stepFor(Date.now() - since)
  const now = useNow(step, since)
  const text = formatElapsed((until ?? now) - since)
  return (
    // One copy of the digits, and only one. The clock used to carry `data-t` so a
    // pseudo-element could redraw the same text in a gradient clipped to the glyphs; two
    // copies of a glyph antialiased two different ways is a ghost, not a shimmer
    // (styles.css, `.elapsed`). The pill's sheen is the "live" signal now.
    <span className={className} title={title ?? 'Time since this session started'}>
      {text}
    </span>
  )
}
