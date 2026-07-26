// Why did the bell ring?
//
// The chime firing over a session that was still working has now been chased three
// times, each time from memory of what the screen looked like. It is not reproducible
// on demand - it needs a real turn, a real stall, and Robert in another window - so the
// only honest way to fix it is to have the evidence already written down when it happens.
//
// One line per raise, appended to `attention-audit.log` next to the config. It records
// the state the sweep decided on AND the frame the pane was looking at when it said the
// turn was over, so a false alarm can be read back afterwards instead of re-argued.

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/** Two files of this size at most; older lines age out rather than growing forever. */
const MAX_BYTES = 256 * 1024

function logPath(): string {
  let dir: string
  try {
    dir = app.getPath('userData')
  } catch {
    dir = join(process.env.LOCALAPPDATA || tmpdir() || homedir(), 'PaneForge')
  }
  return join(dir, 'attention-audit.log')
}

// Built from char codes rather than written as literals: an escape byte pasted into a
// source file is invisible to every later editor pass, and a regex nobody can see is a
// regex nobody can fix.
const ESC = String.fromCharCode(27)
const OSC = new RegExp(ESC + '\\][^\\u0007]*(?:\\u0007|' + ESC + '\\\\)', 'g')
const CSI = new RegExp(ESC + '[[\\]()#;?]*[0-9;?]*[ -/]*[@-~]', 'g')
const CTRL = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f]', 'g')

/** Strip ANSI so a tail is readable in a text editor, and keep it to a few lines. */
export function plainTail(text: string, lines = 6): string {
  const clean = text.replace(OSC, '').replace(CSI, '').replace(/\r/g, '\n').replace(CTRL, '')
  const rows = clean.split('\n').filter((l) => l.trim())
  return rows.slice(-lines).join(' | ').slice(0, 400)
}

export function audit(kind: string, data: Record<string, unknown>): void {
  try {
    const file = logPath()
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, file + '.1')
    } catch {
      /* first run, or the rotate lost a race - either way keep going */
    }
    appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), kind, ...data }) + '\n')
  } catch {
    // Diagnostics must never be the thing that breaks the app they are diagnosing.
  }
}
