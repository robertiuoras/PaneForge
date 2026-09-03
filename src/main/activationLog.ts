// Why the main window did or did not come forward.
//
// This is the one piece of instrumentation that stayed in after the measurement, and it
// stayed for a reason: "the Stash pulls PaneForge over what I am typing in" has now been
// reported three times and fixed twice, because both earlier fixes were reasoned about
// rather than measured. The thing that finally settled it was a timestamp — the activation
// notification lands 107ms after a click and 2882ms after a drag — and nothing in the app
// recorded that, so it had to be built from scratch each time.
//
// One line per activation decision, which on a normal day is a handful. Bounded, so it can
// never become a file anyone has to think about. If it is ever reported again, the evidence
// is already on disk: read `activation.log` under userData and compare `delta` against the
// windows in `shared/activation.ts`.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/** Big enough to hold days of ordinary use, small enough to never matter. */
const MAX_BYTES = 64 * 1024

const paths = new Map<string, string>()

function file(name: string): string {
  let path = paths.get(name)
  if (!path) {
    const dir = app.getPath('userData')
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* it is the app's own data dir */
    }
    path = join(dir, name)
    paths.set(name, path)
  }
  return path
}

/**
 * Why a pane closed, on disk rather than in a console nobody has open.
 *
 * The idle sweep has always written its reasoning to `console.info` in the renderer, which
 * is a DevTools window that is shut on a normal day - so when a pane went on 2026-08-25
 * ("i renamed it to pizzasrus and kept open but its gone now") there was nothing anywhere
 * to say what took it, and the answer had to be reconstructed from the History row's
 * `endedAt` and the config. One line per close, same bounded file as above.
 */
export function logReclaim(entry: Record<string, unknown>): void {
  write('reclaim.log', entry)
}

/**
 * What a pane looked like when Fix ran on it, one line per run. The reading itself is
 * `shared/fixSign.ts`; this is the file it goes to, so that the next "panes break more
 * often than they should" can be answered off the screens people were looking at.
 */
export function logFix(entry: Record<string, unknown>): void {
  write('fix.log', entry)
}

/**
 * Where a new pane's agent was sent, and why - one line per launch.
 *
 * Same shape and same reason as `logReclaim` above: the decision is taken silently, at
 * the one moment there is nothing on screen to explain it, and "why did this open on the
 * PC" has to be answerable afterwards without a DevTools window that was never open. It
 * carries the answer, the reason sentence and the folder's basename - never the path,
 * which is the one field that would make this file worth reading to somebody else.
 */
export function logOffload(entry: Record<string, unknown>): void {
  write('offload.log', entry)
}

export function logActivation(entry: Record<string, unknown>): void {
  write('activation.log', entry)
}

function write(name: string, entry: Record<string, unknown>): void {
  try {
    const f = file(name)
    appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n')
    // Trimmed on the way past rather than on a timer: this is called a few times a day, so
    // the read only happens when the file has genuinely grown.
    const raw = readFileSync(f, 'utf8')
    if (raw.length > MAX_BYTES) {
      const lines = raw.split('\n').filter(Boolean)
      writeFileSync(f, lines.slice(-Math.floor(lines.length / 2)).join('\n') + '\n')
    }
  } catch {
    // A log that cannot be written must never be the reason a window does not appear.
  }
}
