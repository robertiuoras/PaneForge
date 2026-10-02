// The card before an app-decided move: "Starting taskdriver on Gamer-PC in 8s".
//
// `shared/offloadFirst.ts` decides where a NEW pane starts before it has a pty, and for a
// while it did so in silence - the pane appeared as a mirror and a toast said afterwards
// where it had gone. That is the app taking the desk away from the person at it, so now
// the decision is announced first, with the one button that matters: keep it here. Doing
// nothing lets the decision stand at the deadline, so a launch from the phone or a script
// with nobody watching is never held up by a card nobody presses. Main holds the clock
// (`OFFLOAD_ASK_MS`); this only draws it and answers `offload:answer`.
//
// Same class as `MoveSoon` and drawn beside it in `.corner-stack`: it is the same kind of
// thing, about to put work on another machine, stoppable while it is drawn.

import React, { useEffect, useState } from 'react'
import { MoveSoonSay, secondsLeft } from './MoveSoon'
import CardX from './CardX'

const api = window.api

export interface OffloadAsk {
  id: string
  project: string
  deviceName: string
  reason: string
  deadline: number
}

export default function OffloadSoon(): React.JSX.Element | null {
  const [asks, setAsks] = useState<OffloadAsk[]>([])
  const [now, setNow] = useState(() => Date.now())
  useEffect(
    () =>
      api.onOffloadSoon((ask: OffloadAsk) => {
        setAsks((prev) => [...prev.filter((a) => a.id !== ask.id), ask])
      }),
    []
  )
  useEffect(() => {
    if (!asks.length) return
    const t = window.setInterval(() => {
      const n = Date.now()
      setNow(n)
      // Main acts at the deadline on its own; the card only has to stop being drawn.
      setAsks((prev) => prev.filter((a) => a.deadline > n))
    }, 250)
    return () => window.clearInterval(t)
  }, [asks.length])
  if (!asks.length) return null
  const keepHere = (id: string): void => {
    void api.answerOffload(id, false)
    setAsks((prev) => prev.filter((a) => a.id !== id))
  }
  return (
    <>
      {asks.map((ask) => (
        // Same one line as `MoveSoon`: the reason is the tooltip, and "Start it there now"
        // went - the countdown already starts it there.
        <div
          className="move-soon line"
          role="status"
          data-testid="offload-soon"
          key={ask.id}
          title={`${ask.reason.charAt(0).toUpperCase() + ask.reason.slice(1)}. You would watch it and type into it from here.`}
        >
          <CardX onDismiss={() => keepHere(ask.id)} />
          <MoveSoonSay words={['Starting', ask.project, `on ${ask.deviceName}`]} />
          <span className="move-soon-count">{secondsLeft(ask.deadline, now)}s</span>
          <button type="button" className="primary move-soon-keep" onClick={() => keepHere(ask.id)}>
            Keep here
          </button>
        </div>
      ))}
    </>
  )
}
