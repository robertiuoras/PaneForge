// Main-process errors must never take the keyboard.
//
// Electron's default handler for an uncaught exception in the main process is a modal
// Windows message box - "A JavaScript error occurred in the main process" - with an OK
// button. It steals focus from whatever app was in front, it appears while a build is
// still running so it lands mid-sentence, and it says nothing the log could not. That is
// the worst possible behaviour for an app developed from a session running inside itself:
// one bad launch of the test copy interrupts the agent doing the work.
//
// So: catch everything, append it to a file, tell the window if there is one, and stay
// up. Nothing is swallowed silently - `paneforge-errors.log` next to the config is the
// record, and the app says so in the pane footer when a window exists to say it in.

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'

const MAX_REPORTS = 50

let reports = 0
let notify: ((message: string) => void) | null = null

/** Where the log goes. Deliberately does not trust getPath: this runs when paths break. */
function logPath(): string {
  let dir = ''
  try {
    dir = app.getPath('userData')
  } catch {
    dir = join(process.env.LOCALAPPDATA || tmpdir() || homedir(), 'PaneForge')
  }
  return join(dir, 'paneforge-errors.log')
}

function write(kind: string, err: unknown): void {
  const at = new Date().toISOString()
  const detail = err instanceof Error ? (err.stack || err.message) : String(err)
  // The console line is what an agent running `npm run try` sees, so it is the same text.
  console.error(`[${at}] ${kind}: ${detail}`)
  try {
    const p = logPath()
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, `[${at}] ${kind}: ${detail}\n`)
  } catch {
    /* the console line above is the fallback */
  }
}

/**
 * Called once, as early in the main process as possible - before profile setup, which is
 * itself a thing that has thrown at module scope.
 */
export function installCrashGuard(): void {
  process.on('uncaughtException', (err) => {
    write('uncaughtException', err)
    report(err)
  })
  process.on('unhandledRejection', (err) => {
    write('unhandledRejection', err)
    report(err)
  })
}

/**
 * Prove the guard still works, from an unpackaged build only:
 *   PANEFORGE_CRASH_TEST=1 npm run try -- --keep
 * The app must stay up, say so in the corner, and add a line to paneforge-errors.log -
 * no message box. Without this the only way to test it is to wait for a real crash.
 */
export function crashTestHook(): void {
  if (app.isPackaged || !process.env.PANEFORGE_CRASH_TEST) return
  setTimeout(() => {
    // Named so nobody who walks past the test window - or reads the log a day later -
    // has to work out whether the app really broke. It says it is a drill.
    throw new Error('SMOKE TEST (not a real fault): crash guard drill, safe to ignore')
  }, 4000)
}

/** Once a window exists it can show these instead of the log being the only trace. */
export function onCrashReport(fn: (message: string) => void): void {
  notify = fn
}

function report(err: unknown): void {
  // A loop that throws every frame would otherwise flood the renderer with toasts.
  if (++reports > MAX_REPORTS) return
  const first = String(err instanceof Error ? err.message : err).split('\n')[0]
  try {
    notify?.(first)
  } catch {
    /* the window went away between the check and the send */
  }
}
