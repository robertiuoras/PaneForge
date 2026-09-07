// Keep a small process outside Electron's main thread watching for a disk-stalled main.
// The child is intentionally disposable: it observes, records, kills, and lets a fresh
// app process take over instead of trying to repair a thread that cannot answer a timer.

import { join } from 'node:path'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import { BEAT_MS } from '../shared/mainWatch'
import { logProblem } from './crash'

const REFORK_MS = 10_000
const MAX_REFORKS_PER_HOUR = 5

let child: UtilityProcess | null = null
let beatTimer: NodeJS.Timeout | null = null
let reforks: number[] = []
let stopped = false
let retry: NodeJS.Timeout | null = null
let unavailable = false

function queueRefork(reason: string): void {
  if (stopped || retry) return
  const now = Date.now()
  reforks = reforks.filter((at) => now - at < 60 * 60 * 1000)
  if (reforks.length >= MAX_REFORKS_PER_HOUR) {
    const wait = Math.max(1_000, reforks[0] + 60 * 60 * 1000 - now)
    logProblem('main watchdog', `${reason}; retry limit reached, waiting ${Math.ceil(wait / 60_000)} min`)
    retry = setTimeout(() => { retry = null; fork() }, wait)
    retry.unref()
    return
  }
  reforks.push(now)
  logProblem('main watchdog', `${reason}; retrying in ${REFORK_MS / 1000}s`)
  retry = setTimeout(() => { retry = null; fork() }, REFORK_MS)
  retry.unref()
}

function fork(): void {
  if (stopped || unavailable) return
  if (!utilityProcess || typeof utilityProcess.fork !== 'function') {
    unavailable = true
    logProblem('main watchdog', 'utility process is unavailable; watchdog disabled')
    return
  }
  try {
    child = utilityProcess.fork(join(__dirname, 'watchdog-child.js'), [], {
      serviceName: 'paneforge-watchdog',
      stdio: 'ignore'
    })
  } catch (err) {
    queueRefork(`could not start: ${String(err)}`)
    return
  }
  const watched = child
  watched.on('spawn', () => {
    if (stopped || child !== watched) return
    watched.postMessage({
      t: 'hello',
      pid: process.pid,
      exe: process.execPath,
      appPath: app.getPath('exe'),
      userData: app.getPath('userData'),
      platform: process.platform,
      argv: process.argv.slice(1),
      packaged: app.isPackaged,
      hangMs: !app.isPackaged ? Number(process.env.PF_WATCHDOG_HANG_MS) || 0 : 0
    })
  })
  let failed = false
  const failedChild = (reason: string): void => {
    if (failed) return
    failed = true
    // An `error` can arrive before the utility process exits. Leaving that old child alive
    // without beats lets it kill a healthy replacement main process seventy-five seconds
    // later, so stop it before allowing a refork.
    try { watched.kill() } catch { /* already gone */ }
    if (child === watched) child = null
    queueRefork(reason)
  }
  watched.on('error', (type, location) => failedChild(`${type} at ${location}`))
  watched.on('exit', (code) => {
    failedChild(`stopped (${code})`)
  })
}

export function startMainWatch(): void {
  if (process.env.PF_NO_WATCHDOG === '1' || child || stopped) return
  // A deliberate app quit is not a frozen main process. Stop its child before heartbeat
  // timers end, so a slow normal shutdown never becomes a relaunch.
  app.once('will-quit', stopMainWatch)
  fork()
  beatTimer = setInterval(() => child?.postMessage({ t: 'beat', now: Date.now() }), BEAT_MS)
  beatTimer.unref()
  // An unpackaged-only drill proves the child can recover a main thread that cannot run
  // timers. It is deliberately absent from packaged builds.
  if (!app.isPackaged && process.env.PF_WATCHDOG_TEST_HANG_MS) {
    const ms = Number(process.env.PF_WATCHDOG_TEST_HANG_MS)
    if (Number.isFinite(ms) && ms > 0) setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), 5_000).unref()
  }
}

export function stopMainWatch(): void {
  stopped = true
  if (retry) clearTimeout(retry)
  retry = null
  if (beatTimer) clearInterval(beatTimer)
  beatTimer = null
  child?.kill()
  child = null
}
