/**
 * Whether this screen is still hearing from the desk, for everything that is not the
 * banner.
 *
 * The link reading arrived on `window.api.onLinkState` and only the banner listened, so
 * every OTHER thing drawn off it - the clocks above all - carried on as if the desk were
 * answering. One subscription, held for the life of the page, read by whoever needs it:
 * the alternative is a subscription per pane, which on a phone is a handful of listeners
 * for one boolean.
 *
 * On the desk build this is permanently up: a window looking at its own machine has no
 * link to lose, and nothing ever sends `link:state` over IPC.
 */

import { useEffect, useState } from 'react'
import type { LinkState } from '@shared/linkState'

let state: LinkState = { up: true, lastSeen: Date.now() }
const subs = new Set<(s: LinkState) => void>()
let started = false

function start(): void {
  if (started) return
  started = true
  window.api.onLinkState((s: LinkState) => {
    state = s
    for (const fn of subs) fn(s)
  })
}

/** The reading right now, for code that is not a component. */
export function linkNow(): LinkState {
  return state
}

/** Ask the transport to throw its stream away and open a new one. */
export function reconnectNow(): void {
  const w = window as unknown as { __pfReconnect?: () => void }
  w.__pfReconnect?.()
}

export function useLink(): LinkState {
  start()
  const [s, set] = useState(state)
  useEffect(() => {
    subs.add(set)
    set(state)
    return () => {
      subs.delete(set)
    }
  }, [])
  return s
}
