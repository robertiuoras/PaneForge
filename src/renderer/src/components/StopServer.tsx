// The countdown in front of closing a dev server that is serving nothing.
//
// Same shape and same corner as `MoveSoon`, for the same reason: nothing the app decides
// by itself may take the screen, so it is never a dialog, never focused, never on top of
// something somebody opened. It lives inside `.corner-stack` with every other card, so it
// can never be drawn underneath one of them.
//
// The sentence names the project and the port, never the pid - "the pid is the one thing
// the person reading this cannot check". The port is the evidence: they can try it in a
// browser while the count runs.

import React, { useEffect, useState } from 'react'
import { stopSoonWhy, stopSoonWords, type StopSoon } from '../../../shared/deadDev'
import { nextTickMs } from '../../../shared/elapsed'

export interface StopServerProps {
  soon?: StopSoon | null
  /** Leave it running - never offered again while the app is up. */
  onKeep: (pid: number) => void
  /** Do it now rather than at the deadline. */
  onNow: (pid: number) => void
}

function secondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}

export default function StopServer({ soon, onKeep, onNow }: StopServerProps): React.JSX.Element | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!soon) return
    const deadline = soon.deadline
    let t = 0
    const tick = (): void => {
      setNow(Date.now())
      t = window.setTimeout(tick, nextTickMs(deadline, Date.now()))
    }
    tick()
    return () => window.clearTimeout(t)
  }, [soon?.deadline])
  if (!soon) return null
  const left = secondsLeft(soon.deadline, now)
  return (
    <div className="move-soon stop-server" role="status" data-testid="stop-server">
      <div className="move-soon-say">
        {stopSoonWords(soon.dev)} in <span className="move-soon-count">{left}s</span>
      </div>
      <div className="move-soon-why">{stopSoonWhy(soon.dev)}</div>
      <div className="move-soon-acts">
        <button type="button" onClick={() => onKeep(soon.dev.pid)}>
          Keep it running
        </button>
        <button type="button" className="ghost" onClick={() => onNow(soon.dev.pid)}>
          Close now
        </button>
      </div>
    </div>
  )
}
