// The durable record of every autoclear decision.
//
// ADDENDUM 2026-08-27: pane s2's countdown hit zero and typed nothing, and the branch
// taken could not be proven afterwards - every exit in `armAutoClear` was silent, and
// console.info goes to a stdout nobody keeps when the app is launched from the dock. One
// line per decision, appended here, so the next incident is read back instead of re-argued.

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/** Two files of this size at most; older lines age out rather than growing forever. */
const MAX_BYTES = 256 * 1024

export function autoclearLogPath(): string {
  let dir: string
  try {
    dir = app.getPath('userData')
  } catch {
    dir = join(process.env.LOCALAPPDATA || tmpdir() || homedir(), 'PaneForge')
  }
  return join(dir, 'autoclear-app.log')
}

export function acLog(line: string): void {
  try {
    const file = autoclearLogPath()
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, file + '.1')
    } catch {
      /* first run, or the rotate lost a race - either way keep going */
    }
    appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    // The log must never be the thing that breaks the clear it is recording.
  }
}
