/**
 * Is anybody at this machine - the poll, and nothing else. The rule is shared/away.ts.
 *
 * `powerMonitor.getSystemIdleTime()` is the OS's own answer (seconds since any input, on
 * all three platforms) and is the only reading that covers "the mouse has not moved":
 * this window's focus says nothing about a person working in another app, and the
 * renderer only ever sees input aimed at itself.
 */

import { powerMonitor } from 'electron'
import { NOBODY_YET, readAway, type Away } from '../shared/away'

/**
 * 15s. The reading only ever moves a boundary a minute wide (`AWAY_AFTER_MS`), and this
 * runs for the life of the app, so a tighter poll buys nothing a person could notice.
 */
const POLL_MS = 15_000

let state: Away = NOBODY_YET
let timer: NodeJS.Timeout | null = null
let onChange: ((a: Away) => void) | null = null

export function away(): Away {
  return state
}

function read(): void {
  let idleMs: number
  try {
    idleMs = powerMonitor.getSystemIdleTime() * 1000
  } catch {
    // No reading is not "away": a platform that cannot answer must leave the idle clock
    // exactly as it was rather than freezing every pane on the desk for ever.
    return
  }
  const next = readAway(state, idleMs, Date.now())
  const moved = next.awaySince !== state.awaySince || next.sawPerson !== state.sawPerson
  state = next
  if (moved) onChange?.(state)
}

export function startAway(cb: (a: Away) => void): void {
  onChange = cb
  if (timer) return
  read()
  timer = setInterval(read, POLL_MS)
  timer.unref?.()
}

export function stopAway(): void {
  if (timer) clearInterval(timer)
  timer = null
  onChange = null
}
