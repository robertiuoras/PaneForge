// The per-pane counter and the clock behind `shared/hookDeny.ts`.
//
// Main owns it because the pty's bytes are main's: the renderer sees a repaint, and a
// pane that is closed, reloaded or wedged loses renderer memory - which is exactly when
// "why did nothing run in that pane for two minutes" gets asked.
//
// Nothing here is persisted. A stretch of refusals is a within-session reading; the row
// it produces goes to `activity.json`, which already survives a restart.

import { entry } from '../shared/activity'
import { denyWords, readDenies, stretchDue, type DenyGate, type Stretch } from '../shared/hookDeny'
import { noteActivity } from './activity'

/** Per pane, per gate: nobody cares that "some gate" refused six times. */
const seen = new Map<string, Map<DenyGate, Stretch>>()

/** How a pane is named on the row, supplied by the caller that holds the session. */
type NameFor = (id: string) => string

let nameFor: NameFor = (id) => id
let timer: NodeJS.Timeout | null = null

/** Set once, from `index.ts`, so this file needs to know nothing about sessions. */
export function hookDenyNames(fn: NameFor): void {
  nameFor = fn
}

/**
 * Feed a chunk of what a pane printed. Returns how many refusals were in it, so a test
 * can assert on the reading without waiting for the stretch to end.
 */
export function feedHookDeny(id: string, text: string, now = Date.now()): number {
  const found = readDenies(text)
  if (!found.length) return 0
  let byGate = seen.get(id)
  if (!byGate) {
    byGate = new Map()
    seen.set(id, byGate)
  }
  for (const d of found) {
    const s = byGate.get(d.gate)
    if (s) {
      s.count += 1
      s.at = now
    } else {
      byGate.set(d.gate, { gate: d.gate, count: 1, at: now })
    }
  }
  arm()
  return found.length
}

/** A pane that has gone: its unfinished stretch is written out, then forgotten. */
export function endHookDeny(id: string, now = Date.now()): void {
  flush(id, now, true)
  seen.delete(id)
}

/**
 * Write out every stretch that is over. Exported so the test drives the clock instead of
 * waiting on it.
 */
export function sweepHookDeny(now = Date.now()): void {
  for (const id of [...seen.keys()]) flush(id, now, false)
  if (!seen.size && timer) {
    clearInterval(timer)
    timer = null
  }
}

function flush(id: string, now: number, force: boolean): void {
  const byGate = seen.get(id)
  if (!byGate) return
  for (const [gate, s] of [...byGate]) {
    if (!force && !stretchDue(s, now)) continue
    byGate.delete(gate)
    // A forced flush still respects `MIN_FOR_ROW`: a pane closing on one refusal has
    // nothing to say about the gate, and a row saying so would be noise on the list.
    if (!stretchDue({ ...s, at: 0 }, now)) continue
    noteActivity(entry('refused', nameFor(id), denyWords(gate, s.count), now))
  }
  if (!byGate.size) seen.delete(id)
}

/**
 * The sweep only runs while something is being refused. A desk where no gate ever fires
 * - the normal one - pays nothing for this file at all.
 */
function arm(): void {
  if (timer) return
  timer = setInterval(() => sweepHookDeny(), 15_000)
  timer.unref?.()
}

/** Only for the test: drop every reading between cases. */
export function resetHookDeny(): void {
  seen.clear()
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
