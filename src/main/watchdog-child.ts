// The one part of PaneForge that is not on the main thread, and the only one that can do
// anything about a main thread that has stopped.
//
// It runs as a utilityProcess: its own OS process, its own event loop, no window and no
// pty. Main sends it a beat every two seconds. When enough ticks pass with nothing, this
// writes down what it saw, takes a sample of the stuck process for whoever reads the log
// afterwards, marks the desk so the panes come back, and then kills and relaunches the app.
//
// 2026-09-07 is why it exists: 50 minutes of a frozen window with nothing in any log, and
// the only way back was `kill -9` and reopening the app by hand. That is exactly the pair
// of commands below.
//
// Deliberately small. It reads no config, has no IPC surface of its own, and every step is
// best effort: a watchdog that throws is a watchdog that is not there.

import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BEAT_MS, beat, decide, fresh, HANG_MS, type MainWatchState } from '../shared/mainWatch'

interface Hello {
  t: 'hello'
  pid: number
  exe: string
  appPath: string
  userData: string
  platform: string
  profile: string
  /** An unpackaged build is a development copy: it is stopped, never relaunched. */
  packaged: boolean
  /** Test override for the hang threshold, in ms. 0 means use the real one. */
  hangMs?: number
}

let hello: Hello | null = null
let watch: MainWatchState = fresh()
let hangMs = 0

const port = process.parentPort

port.on('message', (e) => {
  const msg = e.data as { t?: string } | null
  if (!msg || typeof msg.t !== 'string') return
  if (msg.t === 'hello') {
    hello = msg as Hello
    hangMs = (hello.hangMs ?? 0) > 0 ? hello.hangMs ?? 0 : 0
  } else if (msg.t === 'beat') watch = beat(watch)
})

const timer = setInterval(() => {
  const now = Date.now()
  const next = decide(watch, now, hangMs || HANG_MS)
  watch = next.state
  if (next.action !== 'act') return
  clearInterval(timer)
  act(now)
}, BEAT_MS)

function act(now: number): void {
  const h = hello
  if (!h) return
  const silent = Math.round((watch.silentTicks * BEAT_MS) / 1000)
  const what = h.packaged ? 'relaunching' : 'stopping it, this is a development copy so it will not be reopened'
  const line = `main: no heartbeat for ${silent}s - ${what} (pid ${h.pid})`
  // Disk can be why the main process wedged. The evidence writes are best effort and share
  // one six-second budget, after which recovery proceeds even if their I/O is still stuck.
  let recovered = false
  const recover = (): void => {
    if (recovered) return
    recovered = true
    relaunch(h)
  }
  const budget = setTimeout(recover, 6_000)
  budget.unref?.()
  void Promise.allSettled([note(h, line), sample(h), markDeskForRestart(h)]).then(() => {
    clearTimeout(budget)
    recover()
  })
}

/**
 * One line in paneforge-errors.log, in the same format `crash.ts` writes.
 *
 * It is asynchronous because a system-wide disk stall can affect the child too. The six
 * second recovery budget above means an unavailable disk never postpones the kill.
 */
async function note(h: Hello, line: string): Promise<void> {
  try {
    await mkdir(h.userData, { recursive: true })
    await appendFile(join(h.userData, 'paneforge-errors.log'), `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* an unwritable profile must not stop the recovery */
  }
  console.error(line)
}

/**
 * The post-mortem that was missing on 2026-09-07.
 *
 * `sample` is what finally named the stuck call that day, and it had to be run by hand
 * while the app was still frozen. Three seconds of it, six seconds of patience, and the app
 * goes whether it worked or not.
 */
function sample(h: Hello): Promise<void> {
  if (h.platform !== 'darwin') return Promise.resolve()
  const file = join(h.userData, `main-hang-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`)
  return new Promise((resolve) => {
    execFile('sample', [String(h.pid), '3', '-file', file], { timeout: 6_000 }, () => resolve())
  })
}

/**
 * Say the panes are coming back.
 *
 * `update` uses the existing restore preferences in index.ts. With the default settings,
 * a recovered freeze reopens the panes without asking. A user who disabled or requested
 * confirmation for update restoration keeps that choice. Missing or unreadable desks
 * are skipped.
 */
async function markDeskForRestart(h: Hello): Promise<void> {
  const live = join(h.userData, 'desk.json')
  const exit = join(h.userData, 'desk.exit.json')
  const clear = join(h.userData, 'desk.clear')
  try {
    const [liveRaw, exitRaw, clearRaw] = await Promise.all([
      readFile(live, 'utf8').catch(() => ''),
      readFile(exit, 'utf8').catch(() => ''),
      readFile(clear, 'utf8').catch(() => '')
    ])
    const parse = (raw: string): Record<string, unknown> | null => {
      try {
        const value = JSON.parse(raw) as Record<string, unknown>
        return Array.isArray(value.specs) ? value : null
      } catch { return null }
    }
    const generation = (desk: Record<string, unknown>): number => {
      const value = Number(desk.writtenAt)
      return Number.isFinite(value) ? value : 0
    }
    const liveDesk = parse(liveRaw)
    const exitDesk = parse(exitRaw)
    // Match restore.ts: a terminal snapshot wins ties, while legacy snapshots without a
    // generation are both generation zero.
    const desk = !exitDesk || (liveDesk && generation(liveDesk) > generation(exitDesk)) ? liveDesk : exitDesk
    const clearValue = Number(clearRaw)
    const clearedAt = Number.isFinite(clearValue) && clearValue > 0 ? clearValue : 0
    if (!desk || (clearedAt > 0 && clearedAt >= generation(desk))) return
    desk.reason = 'update'
    desk.clean = true
    desk.at = Date.now()
    desk.writtenAt = Math.max(Date.now(), generation(desk) + 1, clearedAt + 1)
    const tmp = `${exit}.watchdog.tmp`
    await writeFile(tmp, JSON.stringify(desk, null, 2), 'utf8')
    await rename(tmp, exit)
  } catch {
    /* no desk, or a half-written one: the app comes back with nothing to offer */
  }
}

/**
 * Kill the frozen app and open it again, from a process that outlives both of us.
 *
 * This child dies with its parent, so the relaunch cannot be done here: it is handed to a
 * detached shell that waits a second for the pid to go and then opens the app. The
 * singleton lock takes care of itself, because Chromium checks the pid recorded in
 * `SingletonLock` and that pid is the one being killed. This is the same pair of commands
 * that recovered the app by hand on 2026-09-07.
 */
function relaunch(h: Hello): void {
  if (!h.packaged) {
    // A development copy is restarted by whatever is running it. Stopping it is the whole
    // job here, and relaunching a build from `out/` would fight the dev script.
    try { process.kill(h.pid, 'SIGKILL') } catch { /* already gone */ }
    return
  }
  try {
    if (h.platform === 'darwin') {
      // /Applications/PaneForge.app/Contents/MacOS/PaneForge -> /Applications/PaneForge.app
      const bundle = h.appPath.replace(/\/Contents\/MacOS\/[^/]*$/, '')
      const args = h.profile ? ` --args ${quote(`--profile=${h.profile}`)}` : ''
      launchRecovery('sh', ['-c', `kill -9 ${h.pid}; sleep 1; open -n -a ${quote(bundle)}${args}`], h.pid)
    } else if (h.platform === 'win32') {
      const args = h.profile ? ` "--profile=${h.profile}"` : ''
      launchRecovery('cmd', ['/c', `taskkill /F /PID ${h.pid} & timeout /t 2 /nobreak & start "" "${h.exe}"${args}`], h.pid)
    } else {
      const args = h.profile ? ` ${quote(`--profile=${h.profile}`)}` : ''
      launchRecovery('sh', ['-c', `kill -9 ${h.pid}; sleep 1; ${quote(h.exe)}${args} &`], h.pid)
    }
  } catch {
    // No shell, or no process slots. Stopping the app is still better than leaving a window
    // that answers nothing, and the desk above means the panes come back when it is opened.
    try {
      process.kill(h.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

/** Spawn failure can arrive asynchronously; fallback to killing the wedged main process. */
function launchRecovery(command: string, args: string[], pid: number): void {
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', () => {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    })
    child.unref()
  } catch {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
}

/** A path with a space or a quote in it, safe inside `sh -c`. */
function quote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`
}
