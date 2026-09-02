// The tally, and the file it survives in.
//
// `shared/interventions.ts` decides; this counts and writes. The count lives on the
// session so the card can draw it, and every counted one is also a line in
// `interventions.log`, because the number on a card dies with the pane and the question
// A7 asks - how many interventions did that FEATURE cost - is answered afterwards, from
// the log, with `awk`. No dashboard: that is the harness rabbit hole, named in
// `docs/agentic-backlog-2026-09-02.md`.

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { judge, noteLine, type Moment } from '../shared/interventions'

/** Two files of this size at most, the same rotation as `autoclearLog.ts`. */
const MAX_BYTES = 256 * 1024

export function interventionsLogPath(): string {
  let dir: string
  try {
    dir = app.getPath('userData')
  } catch {
    dir = join(process.env.LOCALAPPDATA || tmpdir() || homedir(), 'PaneForge')
  }
  return join(dir, 'interventions.log')
}

/**
 * Count this moment if it cost a person, and answer the new total.
 *
 * `was` is what the pane had already cost, so the caller keeps the number and this stays
 * a function of its arguments. A moment that costs nothing returns `was` unchanged and
 * writes nothing - a log of everything that happened would be the pane's output again.
 */
export function countIntervention(
  m: Moment,
  was: number,
  who: { id: string; project: string }
): number {
  const v = judge(m)
  if (!v.counts) return was
  const count = was + 1
  try {
    const file = interventionsLogPath()
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, file + '.1')
    } catch {
      /* first run, or the rotate lost a race - either way keep going */
    }
    appendFileSync(file, noteLine({ at: Date.now(), session: who.id, project: who.project, why: v.why, count }))
  } catch {
    // The log must never be the thing that breaks the keystroke it is recording.
  }
  return count
}
