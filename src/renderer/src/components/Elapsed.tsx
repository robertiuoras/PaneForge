// Live "how long has this been running" readout.
//
// One timer for the whole app: a dozen sidebar rows each running their own
// setInterval would be a dozen wakeups a second for the same tick, and every one
// of them would re-render its parent.

import { useEffect, useState } from 'react'

const subs = new Set<(t: number) => void>()
let timer: ReturnType<typeof setInterval> | null = null

function tick(): void {
  const now = Date.now()
  for (const s of subs) s(now)
}

// Chromium throttles timers in an occluded window to about one a minute, so the
// readout can be a minute stale the moment you look at it again. Catching focus
// and visibility changes makes it correct as soon as it is on screen.
function wake(): void {
  if (subs.size) tick()
}

function subscribe(fn: (t: number) => void): () => void {
  subs.add(fn)
  if (!timer) {
    timer = setInterval(tick, 1000)
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', wake)
  }
  return () => {
    subs.delete(fn)
    if (subs.size === 0 && timer) {
      clearInterval(timer)
      timer = null
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }
}

/** Wall clock that updates once a second, shared by every component that asks. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => subscribe(setNow), [])
  return now
}

/** 42s / 5m 23s / 1h 04m - always two units, so the width barely moves. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

interface Props {
  since: number
  /** freeze the clock (an exited session's runtime should stop counting) */
  until?: number
  className?: string
  title?: string
}

export default function Elapsed({ since, until, className = 'elapsed', title }: Props): JSX.Element {
  const now = useNow()
  const text = formatElapsed((until ?? now) - since)
  return (
    // `data-t` is the same digits again, for the shimmer: the highlight that travels
    // through a running clock is a second copy of the text drawn in a moving gradient
    // and clipped to the glyphs (styles.css, `.elapsed::before`). A pseudo-element can
    // only take its content from an attribute, hence the duplicate.
    <span className={className} data-t={text} title={title ?? 'Time since this session started'}>
      {text}
    </span>
  )
}
