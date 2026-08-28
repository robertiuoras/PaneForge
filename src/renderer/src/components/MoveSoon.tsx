// The countdown in front of an automatic move or close, for a desk with no mascot.
//
// `armMoveRef` and `armCloseRef` in App.tsx both used to end with the same sentence:
//
//   if (!mascotOnRef.current) return doMove(fresh, cooldownMinutes)
//
// "With the mascot hidden there is nowhere to draw a count and nothing to press, so the
// only honest behaviour is the old one: do it, and say so in the log." That was true of
// the code and false of the promise, because the mascot **arrives off** - a pet is
// decoration, and only a new install gets the off. So on the desk of anybody who has not
// gone looking for an animal, a pane left this machine with nothing whatever on screen
// saying so, and the only trace was a `console.info` in a DevTools window nobody has open.
// Robert, 2026-08-28: "safeguard for auto handoffs ... it should first have popup saying
// it will hand off in 10 secs".
//
// So the countdown stops being something the mascot owns. This is the same reading, drawn
// as a plain card in the corner when there is no sprite to draw it beside - the shape
// `UpdateToast` already uses, for the same reason: nothing the app decided by itself may
// take the screen, so it is never a `dialog.showMessageBox`, never focused, and never on
// top of a dialog somebody opened.
//
// It draws the SAME `CloseSoon` the mascot draws and calls the SAME two actions, so there
// is one countdown in the app with two faces rather than two countdowns that can disagree.

import React, { useEffect, useState } from 'react'
import type { CloseSoon } from './Mascot'

export interface MoveSoonProps {
  soon?: CloseSoon
  /** Leave these panes alone - the same `keepOpen` the card menu and the mascot call. */
  onKeep: (ids: string[]) => void
  /** Stop waiting and do it now. */
  onNow: (ids: string[]) => void
}

/** Whole seconds left, floored at zero - the number the sentence is about. */
function secondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}

/**
 * What this countdown is about to do, named.
 *
 * The panes are named the way the rest of the app names them (`paneWord`, already done
 * upstream), and the machine is named because "moving a pane" without saying where is a
 * sentence somebody has to go and investigate.
 */
export function moveSoonWords(soon: CloseSoon): string {
  const who = soon.names.length === 1 ? soon.names[0] : `${soon.names.length} panes`
  return soon.move ? `Moving ${who} to ${soon.move.deviceName}` : `Closing ${who}`
}

export default function MoveSoon({ soon, onKeep, onNow }: MoveSoonProps): React.JSX.Element | null {
  // Its own one-second tick, mounted only while a countdown is armed: this is the shape
  // `AskCountdown` uses, and a subscription that exists when there is nothing counting is
  // a wakeup an hour for a card nobody is looking at.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!soon) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [soon?.deadline])
  if (!soon) return null
  const left = secondsLeft(soon.deadline, now)
  return (
    <div className="move-soon" role="status" data-testid="move-soon">
      <div className="move-soon-say">
        {moveSoonWords(soon)} in <span className="move-soon-count">{left}s</span>
      </div>
      <div className="move-soon-why">
        {soon.why === 'idle'
          ? 'It has been quiet a long time.'
          : 'This machine is running out of memory.'}
      </div>
      <div className="move-soon-acts">
        <button type="button" onClick={() => onKeep(soon.ids)}>
          {soon.move ? 'Keep it here' : 'Keep it open'}
        </button>
        <button type="button" className="ghost" onClick={() => onNow(soon.ids)}>
          {soon.move ? 'Move now' : 'Close now'}
        </button>
      </div>
    </div>
  )
}
