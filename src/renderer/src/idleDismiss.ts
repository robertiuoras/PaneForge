// The renderer half of `shared/cardIdle.ts`: bind it to a card and the card goes away
// once nobody has touched it for five minutes.
//
// One timeout, not a tick: nothing counts down on screen, so there is no number to keep
// fresh and no interval running behind a card that is only sitting there. The clock is
// rebuilt when a pointer enters or leaves, and when the card is pressed inside.

import { useEffect, useRef, useState } from 'react'
import { CARD_IDLE_MS } from '../../shared/cardIdle'

export interface IdleDismiss {
  /** Spread onto the card's own element. */
  handlers: {
    onPointerEnter: () => void
    onPointerLeave: () => void
    onPointerDown: () => void
    onFocus: () => void
    onBlur: () => void
  }
}

/**
 * @param active whether the card is on screen at all - a card that is not drawn has no clock
 * @param onGone called once, when it has been ignored long enough
 */
export function useIdleDismiss(active: boolean, onGone: () => void, after = CARD_IDLE_MS): IdleDismiss {
  const [held, setHeld] = useState(false)
  const [since, setSince] = useState(() => Date.now())
  // The caller's `onGone` is a fresh closure every render; the timer must not be rebuilt
  // for that, or a card re-rendering once a second would never reach its deadline.
  const go = useRef(onGone)
  go.current = onGone

  useEffect(() => {
    if (!active || held) return
    const t = setTimeout(() => go.current(), Math.max(0, since + after - Date.now()))
    return () => clearTimeout(t)
  }, [active, held, since, after])

  const touch = (): void => setSince(Date.now())
  return {
    handlers: {
      onPointerEnter: () => setHeld(true),
      onPointerLeave: () => {
        setHeld(false)
        touch()
      },
      onPointerDown: touch,
      onFocus: () => setHeld(true),
      onBlur: () => {
        setHeld(false)
        touch()
      }
    }
  }
}
