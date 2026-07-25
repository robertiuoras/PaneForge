// Live "how long has this been running" readout.
//
// One timer for the whole app: a dozen sidebar rows each running their own
// setInterval would be a dozen wakeups a second for the same tick, and every one
// of them would re-render its parent.

import { useEffect, useState } from 'react'

const subs = new Set<(t: number) => void>()
let timer: ReturnType<typeof setInterval> | null = null

function subscribe(fn: (t: number) => void): () => void {
  subs.add(fn)
  if (!timer) {
    timer = setInterval(() => {
      const now = Date.now()
      for (const s of subs) s(now)
    }, 1000)
  }
  return () => {
    subs.delete(fn)
    if (subs.size === 0 && timer) {
      clearInterval(timer)
      timer = null
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
  return (
    <span className={className} title={title ?? 'Time since this session started'}>
      {formatElapsed((until ?? now) - since)}
    </span>
  )
}
