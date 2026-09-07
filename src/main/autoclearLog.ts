// The durable record of every autoclear decision.
//
// ADDENDUM 2026-08-27: pane s2's countdown hit zero and typed nothing, and the branch
// taken could not be proven afterwards - every exit in `armAutoClear` was silent, and
// console.info goes to a stdout nobody keeps when the app is launched from the dock. One
// line per decision, appended here, so the next incident is read back instead of re-argued.

import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { appendLog } from './logWrite'

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

// Written from the autoclear sweep's own timer, so it goes to the disk without the window
// waiting on it. The log must never be the thing that breaks the clear it is recording.
export function acLog(line: string): void {
  appendLog(autoclearLogPath(), `[${new Date().toISOString()}] ${line}\n`, { rotateAt: MAX_BYTES })
}
