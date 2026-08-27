// The plumbing behind `shared/renderWatch.ts`: watch one window's renderer, and get it back.
//
// Nothing here may take the screen. A reload is `webContents.reload()`, which repaints the
// window that is already there and never orders it front; a rebuild goes through the same
// `createWindow` a quiet relaunch uses. See "Never take the screen" in CLAUDE.md.

import { execFile } from 'node:child_process'
import { app, type BrowserWindow } from 'electron'
import { logProblem } from './crash'
import { PROBE_EVERY_MS, afterAct, decide, fresh, type Watch } from '../shared/renderWatch'

let timer: NodeJS.Timeout | null = null
let state: Watch = fresh()
/** A `render-process-gone` this watch asked for, so it is answered with a reload. */
let killing = false

/** What the renderer's own OS process is costing, for the log line that names the spin. */
function metricsFor(pid: number): string {
  try {
    const m = app.getAppMetrics().find((e) => e.pid === pid)
    if (!m) return `pid ${pid} (no metrics)`
    const cpu = m.cpu?.percentCPUUsage
    const mem = m.memory?.workingSetSize
    return (
      `pid ${pid} type=${m.type}` +
      (typeof cpu === 'number' ? ` cpu=${cpu.toFixed(1)}%` : '') +
      (typeof mem === 'number' ? ` ws=${Math.round(mem / 1024)}MB` : '')
    )
  } catch {
    return `pid ${pid} (metrics unavailable)`
  }
}

/**
 * The number the 2026-08-28 incident was identified by, and the one `getAppMetrics` does
 * not give: CUMULATIVE cpu time. `percentCPUUsage` is a delta since the last call and read
 * 0.0% for a renderer that had burned ~14 minutes of CPU, which says nothing at all about a
 * loop that has been spinning for a quarter of an hour. Asked out of band, after the line
 * above is already written, so nothing in the recovery path waits on a process spawn.
 */
function logCpuTime(pid: number): void {
  if (pid < 0 || process.platform === 'win32') return
  execFile('/bin/ps', ['-o', 'time=,%cpu=,rss=', '-p', String(pid)], { timeout: 3000 }, (err, out) => {
    if (err) return
    const line = out.trim().replace(/\s+/g, ' ')
    if (line) logProblem('renderer', `pid ${pid} cpu-time ${line} (TIME %CPU RSS-KB)`)
  })
}

function pidOf(win: BrowserWindow): number {
  try {
    return win.webContents.getOSProcessId()
  } catch {
    return -1
  }
}

/**
 * Start watching a window. `recreate` is called when there is no renderer left to reload.
 *
 * Safe to call again for a new window: the previous watch is dropped, and the counters go
 * with it, because a window that was rebuilt is not the window that kept wedging.
 */
export function watchRenderer(win: BrowserWindow, recreate: () => void): void {
  stopRenderWatch()
  state = fresh()
  killing = false
  const wc = win.webContents

  wc.on('unresponsive', () => {
    if (state.unresponsiveSince) return
    state.unresponsiveSince = Date.now()
    const pid = pidOf(win)
    logProblem('renderer', `unresponsive - ${metricsFor(pid)}`)
    logCpuTime(pid)
  })
  wc.on('responsive', () => {
    if (!state.unresponsiveSince) return
    logProblem('renderer', `answering again after ${Date.now() - state.unresponsiveSince}ms`)
    state.unresponsiveSince = 0
  })
  wc.on('render-process-gone', (_e, details) => {
    logProblem('renderer', `gone: reason=${details.reason} exitCode=${details.exitCode}`)
    // Our own kill, from the branch below. The page is what has to come back, so this is a
    // reload and not a rebuild - and `gone` is deliberately NOT set, or the next tick would
    // throw away a perfectly good window.
    if (killing) {
      killing = false
      try {
        win.webContents.reload()
      } catch (err) {
        logProblem('renderer', `reload after kill threw: ${String(err)}`)
      }
      return
    }
    state.gone = true
  })

  timer = setInterval(() => {
    if (win.isDestroyed()) return stopRenderWatch()
    const now = Date.now()
    const act = decide(state, now)
    if (act === 'wait') {
      // Only ever one probe outstanding: the point of the reading is how long the OLDEST
      // unanswered ask has been waiting, and a fresh probe every tick would reset it.
      if (!state.probeSentAt && !state.gone && !win.webContents.isDestroyed()) {
        const sent = now
        state.probeSentAt = sent
        win.webContents
          // `true` marks it user-gesture-ish, which is irrelevant here; the value is that
          // this round-trips through the renderer's task queue, which is the thread that
          // was spinning.
          .executeJavaScript('1', true)
          .then(() => {
            if (state.probeSentAt === sent) state.probeSentAt = 0
          })
          .catch(() => {
            // A rejected probe means the page went away under us, which the events above
            // report properly. Clearing it keeps a torn-down page from reading as a spin.
            if (state.probeSentAt === sent) state.probeSentAt = 0
          })
      }
      return
    }
    if (act === 'give-up') {
      logProblem('renderer', `still wedged after ${state.reloads} reload(s) - leaving it alone`)
      return stopRenderWatch()
    }
    const why = state.gone
      ? 'process gone'
      : state.unresponsiveSince
        ? `unresponsive for ${now - state.unresponsiveSince}ms`
        : `no answer to the liveness probe for ${now - state.probeSentAt}ms`
    const pid = pidOf(win)
    logProblem('renderer', `${act} (${why}) - ${metricsFor(pid)}`)
    logCpuTime(pid)
    state = afterAct(state, now)
    if (act === 'recreate') {
      stopRenderWatch()
      return recreate()
    }
    // The renderer process is KILLED first, and that is the load-bearing half.
    //
    // Measured 2026-08-28 against a real `while (true)` in this app's own window:
    // `reload()` on a spinning renderer does nothing until the loop ends. It is a message
    // to the renderer's main thread, and that thread is the one that is busy - the window
    // came back at 45.1s of a bounded 45s spin, which is the spin ending, not a recovery.
    // `forcefullyCrashRenderer()` takes the process out from under it, and the reload runs
    // from `render-process-gone` above, on a fresh one.
    //
    // Silent by construction either way: the window is already on screen and reload()
    // repaints it. Panes come back from desk.json and `--resume`, the same path a restart
    // uses, which is what makes killing the renderer an acceptable price at all.
    try {
      killing = true
      win.webContents.forcefullyCrashRenderer()
    } catch (err) {
      killing = false
      logProblem('renderer', `kill threw: ${String(err)}`)
      try {
        win.webContents.reload()
      } catch (e2) {
        logProblem('renderer', `reload threw: ${String(e2)}`)
      }
    }
  }, PROBE_EVERY_MS)
  timer.unref?.()
}

export function stopRenderWatch(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** For the live test: what the watch believes right now. */
export function renderWatchState(): Watch {
  return { ...state }
}
