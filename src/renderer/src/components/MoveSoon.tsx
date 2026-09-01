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
//
// ONE CARD PER DECISION, stacked, since 2026-09-01. It used to be one card full stop:
// `armCloseRef` refused outright while another countdown was up (`if
// (closeSoonRef.current) return`), so a second pane that came due during the first
// pane's fifteen seconds was not counted down, not closed, and not mentioned - it was
// simply dropped, and the next sweep armed it from the top. Robert saw the number run
// down, the card vanish and a fresh count appear at ten-and-something for a different
// pane, and read the whole thing as one countdown that had reset: "if theres 2 closing in
// the same 10 secs they both dont close they countdown then go back to 10 seconds which
// is bad, it should just show 2 popups bottom right one above the other with buttons to
// keep it if i want". Each card now owns its own deadline and its own Keep button, so
// two decisions are two sentences and either can be answered without touching the other.
//
// The SOUND stays single (App.tsx): one alert when the first card of a stretch arrives and
// ticks against the soonest deadline only. Robert, same message: "just 1 sound is fine for
// coutndown because when i check i should see both will close and i can choose which to
// keep etc or leave both."

import React, { useEffect, useState } from 'react'
import type { CloseSoon } from './Mascot'
import { nextTickMs } from '../../../shared/elapsed'

export interface MoveSoonProps {
  soons: CloseSoon[]
  /** Leave these panes alone - the same `keepOpen` the card menu and the mascot call. */
  onKeep: (ids: string[]) => void
  /** Stop waiting and do it now. */
  onNow: (ids: string[]) => void
}

/**
 * A countdown's own identity, stable while it counts.
 *
 * The panes it names are what make it that decision rather than another one, so they are
 * the key. `key` is set by whatever armed it; the fallback is here because a probe arms
 * this card by hand (`window.__pfSoon`) and should not have to know that.
 */
export function soonKey(soon: CloseSoon): string {
  return soon.key ?? soon.ids.join('|')
}

/** Whole seconds left, floored at zero - the number the sentence is about. */
export function secondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}

/**
 * How late a wake-up has to be to have crossed the boundary it was aimed at.
 *
 * `nextTickMs` aims the next tick exactly AT the second boundary, and `setTimeout` is
 * allowed to fire a millisecond or two early. Landing early means `secondsLeft` still
 * computes the number that was already on screen, and the tick after that is a whole
 * `step` later - so one number was drawn for two seconds and every number after it was
 * one late. That is the "countdown is a bit weird ... sometime its off by a second".
 * Waking a few milliseconds after the boundary cannot read the wrong side of it.
 */
const TICK_SKEW_MS = 12

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

export default function MoveSoon({ soons, onKeep, onNow }: MoveSoonProps): React.JSX.Element | null {
  // One tick for the whole stack, mounted only while something is counting: this is the
  // shape `AskCountdown` uses, and a subscription that exists when there is nothing
  // counting is a wakeup an hour for a card nobody is looking at.
  //
  // The wake is aimed at the SOONEST boundary across every card rather than at a fixed
  // second, because two cards armed 400ms apart do not change their number at the same
  // moment - a single aligned interval would leave one of them showing a stale second for
  // most of every second.
  const [now, setNow] = useState(() => Date.now())
  const deadlines = soons.map((s) => s.deadline).join(',')
  useEffect(() => {
    if (!soons.length) return
    const at = soons.map((s) => s.deadline)
    let t = 0
    const tick = (): void => {
      const n = Date.now()
      setNow(n)
      const wait = Math.min(...at.map((d) => nextTickMs(d, n))) + TICK_SKEW_MS
      t = window.setTimeout(tick, wait)
    }
    tick()
    return () => window.clearTimeout(t)
  }, [deadlines])
  if (!soons.length) return null
  return (
    <>
      {soons.map((soon) => (
        <div className="move-soon" role="status" data-testid="move-soon" key={soonKey(soon)}>
          <div className="move-soon-say">
            {moveSoonWords(soon)} in{' '}
            <span className="move-soon-count">{secondsLeft(soon.deadline, now)}s</span>
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
      ))}
    </>
  )
}
