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

/** 0 B / 74 KB / 3.2 MB - short enough to sit inside a chip on a pane header. */
export function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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
    // One copy of the digits, and only one. The clock used to carry `data-t` so a
    // pseudo-element could redraw the same text in a gradient clipped to the glyphs; two
    // copies of a glyph antialiased two different ways is a ghost, not a shimmer
    // (styles.css, `.elapsed`). The pill's sheen is the "live" signal now.
    <span className={className} title={title ?? 'Time since this session started'}>
      {text}
    </span>
  )
}
