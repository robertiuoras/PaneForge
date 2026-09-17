/**
 * The app profiles its own window, and can hand it back.
 *
 * Electron gives every `webContents` a `debugger` that speaks the same CDP a
 * `--remote-debugging-port` would have exposed - so the INSTALLED app can be profiled
 * without being relaunched with a flag and without losing the very state that is being
 * investigated. Everything about the profile that is arithmetic lives in
 * `shared/renderCost.ts`; this file only attaches, waits and detaches.
 */

import { BrowserWindow, type WebContents } from 'electron'
import { readProfile, type Cost, type Profile } from '../shared/renderCost'

/** Sample gap. Fine enough to separate two functions, coarse enough to be free. */
const INTERVAL_US = 200
/** A profile nobody stops is a leak of the debugger attachment, so there is a ceiling. */
const MAX_SECONDS = 60

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Attach only for the profile and always let go.
 *
 * A debugger left attached makes Chromium keep instrumentation on for the life of the
 * window, which would turn a measurement into the thing being measured.
 */
async function withDebugger<T>(wc: WebContents, run: () => Promise<T>): Promise<T> {
  const already = wc.debugger.isAttached()
  if (!already) wc.debugger.attach('1.3')
  try {
    return await run()
  } finally {
    if (!already && wc.debugger.isAttached()) {
      try {
        wc.debugger.detach()
      } catch {
        /* the window went away underneath us */
      }
    }
  }
}

/** The window this app draws its desk in, or nothing if there is not one. */
function desk(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
}

export type RenderCost = Cost & {
  /** JS heap in megabytes, so a leak shows up next to the CPU it is costing. */
  heapMb: number
  /** How long this window has been up, in minutes - accumulation is the usual suspect. */
  upMinutes: number
}

/** Run a CPU profile against the live desk window and return the table. */
export async function profileRenderer(seconds = 10): Promise<RenderCost | null> {
  const win = desk()
  if (!win) return null
  const secs = Math.max(1, Math.min(MAX_SECONDS, Math.round(seconds)))
  const wc = win.webContents

  return withDebugger(wc, async () => {
    await wc.debugger.sendCommand('Profiler.enable')
    await wc.debugger.sendCommand('Profiler.setSamplingInterval', { interval: INTERVAL_US })
    await wc.debugger.sendCommand('Profiler.start')
    await wait(secs * 1000)
    const stopped = (await wc.debugger.sendCommand('Profiler.stop')) as { profile?: Profile }

    let heapMb = 0
    try {
      const m = (await wc.debugger.sendCommand('Runtime.evaluate', {
        expression: '(performance?.memory?.usedJSHeapSize ?? 0)',
        returnByValue: true,
      })) as { result?: { value?: number } }
      heapMb = Math.round((m.result?.value ?? 0) / 1048576)
    } catch {
      /* a build without performance.memory still gets its CPU table */
    }

    return {
      ...readProfile(stopped.profile),
      heapMb,
      upMinutes: Math.round(process.uptime() / 60),
    }
  })
}

/**
 * Hand the window back: throw away the renderer's accumulated state and draw the desk
 * again from the record main holds. The ptys, the conversations and the desk file are all
 * in main, so this costs the scrollback that is already re-rendered from main's raw log
 * and nothing else - the same recovery `renderWatch.ts` performs on a wedged window.
 */
export function reloadRenderer(): boolean {
  const win = desk()
  if (!win) return false
  win.webContents.reloadIgnoringCache()
  return true
}
