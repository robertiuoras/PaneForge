// A dev copy walks you through what it has that the installed app does not - see
// `src/shared/tour.ts` for the arithmetic this only draws. `App.tsx` asks `api.tour()`
// once on mount; the answer is `null` outside a dev copy, so the installed app never sees
// this card at all.
//
// Same shape as every other corner card (`MoveSoon.tsx`, `WhatsNewCard.tsx`): a static
// child of `.corner-stack`, never its own `position: fixed`, no animation, no focus taken.

import { useEffect, useState } from 'react'
import type { TourState, TourSurface } from '../../../shared/tour'
import { currentStep, done, next, previous } from '../../../shared/tour'
import CardX from './CardX'

const api = window.api

export interface TourCardProps {
  /** Set the same state the button for that surface sets - `setPicking(true)` for New
   * session, and so on. Called whenever the step now on screen changes. */
  onOpen: (surface: TourSurface) => void
}

export default function TourCard({ onOpen }: TourCardProps): JSX.Element | null {
  const [state, setState] = useState<TourState | null>(null)
  const [gone, setGone] = useState(false)

  useEffect(() => {
    let live = true
    void api
      .tour()
      .then((t) => live && setState(t))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    if (!state || gone) return
    onOpen(currentStep(state).open)
    // Only the step actually on screen should open anything - not `onOpen` itself, which
    // is a fresh closure every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.index, gone])

  if (!state || gone) return null

  const step = currentStep(state)
  const isLast = done(state)

  return (
    <div className="tour-card" role="status" data-testid="tour-card">
      <CardX onDismiss={() => setGone(true)} />
      <div className="tour-count">
        {state.index + 1} of {state.steps.length}
      </div>
      <div className="tour-text">{step.text}</div>
      <div className="tour-acts">
        <button
          type="button"
          className="ghost small"
          disabled={state.index === 0}
          onClick={() => setState((s) => (s ? previous(s) : s))}
        >
          Previous
        </button>
        <button
          type="button"
          className="primary small"
          onClick={() => (isLast ? setGone(true) : setState((s) => (s ? next(s) : s)))}
        >
          {isLast ? 'Done' : 'Next'}
        </button>
      </div>
    </div>
  )
}
