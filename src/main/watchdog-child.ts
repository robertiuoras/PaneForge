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
import { appendFileSync } from 'node:fs'
import { cpus, freemem, totalmem } from 'node:os'
import { join } from 'node:path'
import {
  BEAT_MS,
  beat,
  decide,
  describeTasklist,
  fresh,
  HANG_MS,
  silenceLine,
  machineBusyPct,
  psCpuPct,
  STARVED_FACTOR,
  starved,
  starvedBackLine,
  starvedWaitLine,
  type CpuTimes,
  type MainWatchState,
  type Starvation,
  type Vitals
} from '../shared/mainWatch'

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
/** The most recent beat's own reported vitals, for the silence line when they stop. */
let last: { at: number; vitals: Vitals | null } | null = null
let beatsReceived = 0
/** os.cpus() times as of the previous tick, so act() can read machine load over one tick. */
let prevCpus: CpuTimes[] = cpus().map((c) => ({ ...c.times }))
let acted = false
const startedAt = Date.now()
/** This silence fell on a machine short of memory, so it gets STARVED_FACTOR times the grace. */
let starvedWait = false
/** The pressure reading is out; ticks hold their place until it answers. */
let reading = false

const port = process.parentPort

port.on('message', (e) => {
  const msg = e.data as { t?: string; now?: number; vitals?: Vitals } | null
  if (!msg || typeof msg.t !== 'string') return
  if (msg.t === 'hello') {
    hello = msg as Hello
    hangMs = (hello.hangMs ?? 0) > 0 ? hello.hangMs ?? 0 : 0
  } else if (msg.t === 'beat') {
    if (starvedWait && hello) void note(hello, starvedBackLine(Math.round((watch.silentTicks * BEAT_MS) / 1000), hello.pid))
    starvedWait = false
    watch = beat(watch)
    beatsReceived++
    // Tolerate a beat with no vitals: an older main, or one that failed to compute them.
    last = { at: Date.now(), vitals: msg.vitals ?? null }
  }
})

const timer = setInterval(() => {
  const now = Date.now()
  // Keep the tick clock moving while the reading is out, so its wait never looks like a sleep.
  if (reading) {
    watch = { ...watch, lastTickAt: now }
    return
  }
  const nowCpus = cpus().map((c) => ({ ...c.times }))
  const limit = hangMs || HANG_MS
  const next = decide(watch, now, starvedWait ? limit * STARVED_FACTOR : limit)
  if (next.action !== 'act') {
    watch = next.state
    prevCpus = nowCpus
    return
  }
  const h = hello
  if (starvedWait || !h) {
    watch = next.state
    clearInterval(timer)
    act(now, prevCpus, nowCpus)
    return
  }
  // First time past the grace: a machine short of memory gets the longer wait, once.
  watch = { ...next.state, acted: false }
  reading = true
  const cpusBefore = prevCpus
  void readStarvation(h).then((s) => {
    reading = false
    // A beat that arrived during the reading already settled this silence.
    if (watch.silentTicks === 0) return
    if (starved(s)) {
      starvedWait = true
      void note(h, starvedWaitLine(Math.round((watch.silentTicks * BEAT_MS) / 1000), Math.round((limit * STARVED_FACTOR) / 1000), s, h.pid))
      return
    }
    watch = { ...watch, acted: true }
    clearInterval(timer)
    act(Date.now(), cpusBefore, cpus().map((c) => ({ ...c.times })))
  })
}, BEAT_MS)

/**
 * Is the machine short of memory, and is main idle rather than spinning? Bounded: any
 * reading that has not answered in three seconds counts as unread.
 */
function readStarvation(h: Hello): Promise<Starvation> {
  const run = (cmd: string, args: string[]): Promise<string | null> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 3_000)
      try {
        execFile(cmd, args, { timeout: 2_500, windowsHide: true }, (err, stdout) => {
          clearTimeout(timer)
          resolve(err || !stdout ? null : String(stdout))
        })
      } catch {
        clearTimeout(timer)
        resolve(null)
      }
    })
  const mac = h.platform === 'darwin'
  return Promise.all([
    mac ? run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']) : Promise.resolve(null),
    h.platform === 'win32' ? Promise.resolve(null) : run('ps', ['-o', 'time=,%cpu=,rss=,state=', '-p', String(h.pid)])
  ]).then(([level, ps]) => {
    const read = level === null ? NaN : Number(level.trim())
    return {
      // A Mac whose level did not answer counts as not short: its free memory says nothing.
      pressure: mac ? (Number.isFinite(read) ? read : 0) : null,
      freeMb: Math.round(freemem() / 1048576),
      totalMb: Math.round(totalmem() / 1048576),
      mainCpuPct: ps === null ? null : psCpuPct(ps)
    }
  })
}

function act(now: number, cpusBefore: CpuTimes[], cpusAfter: CpuTimes[]): void {
  const h = hello
  if (!h) return
  acted = true
  const silent = Math.round((watch.silentTicks * BEAT_MS) / 1000)
  const how = h.packaged ? 'relaunching' : 'stopping it, this is a development copy so it will not be reopened'
  const what = starvedWait ? `${how}, after the longer wait for a machine short of memory` : how
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
  const lastEntry = last && last.vitals ? { agoS: Math.round((now - last.at) / 1000), vitals: last.vitals } : null
  // Only the log line waits on the OS reading; the sample and the desk start at once, so a
  // slow tasklist never pushes them past the budget.
  const noted = readOsProc(h.pid, h.platform).then((proc) =>
    note(
      h,
      silenceLine({
        silentS: silent,
        what,
        pid: h.pid,
        last: lastEntry,
        machine: {
          freeMb: Math.round(freemem() / 1048576),
          totalMb: Math.round(totalmem() / 1048576),
          busyPct: machineBusyPct(cpusBefore, cpusAfter)
        },
        proc
      })
    )
  )
  void Promise.allSettled([noted, sample(h), markDeskForRestart(h)]).then(() => {
    clearTimeout(budget)
    recover()
  })
}

/**
 * Windows' own view of main's pid (`tasklist`), or `ps` elsewhere. Resolves null on error or
 * timeout rather than rejecting, so a hung OS query never delays the six-second recovery
 * budget beyond its own bound.
 */
function readOsProc(pid: number, platform: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (platform === 'win32') {
      execFile(
        'tasklist',
        ['/FI', `PID eq ${pid}`, '/V', '/FO', 'CSV', '/NH'],
        { timeout: 2_500, windowsHide: true },
        (err, stdout) => {
          if (err || !stdout) return resolve(null)
          resolve(describeTasklist(stdout))
        }
      )
    } else {
      execFile('ps', ['-o', 'time=,%cpu=,rss=,state=', '-p', String(pid)], { timeout: 2_500 }, (err, stdout) => {
        if (err || !stdout) return resolve(null)
        const line = stdout.trim().replace(/\s+/g, ' ')
        resolve(line ? `ps says ${line} (TIME %CPU RSS-KB STATE)` : null)
      })
    }
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

/**
 * The helper's own exit, from inside itself. A utilityProcess killed from outside
 * (`TerminateProcess`, an OS OOM kill) runs no exit handler at all - so a `main watchdog:
 * stopped (0)` line in the parent's log with no matching line here, next to it, is how a
 * kill from outside is told apart from the helper quitting on its own. Best effort: a
 * process already exiting is not the place to risk an unhandled throw.
 */
process.on('exit', (code) => {
  try {
    if (!hello) return
    const uptimeS = Math.round((Date.now() - startedAt) / 1000)
    const line = `main watchdog: helper exiting by itself (code ${code}) after ${uptimeS}s, ${beatsReceived} beats received, acted=${acted}`
    appendFileSync(join(hello.userData, 'paneforge-errors.log'), `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* an unwritable profile, or no userData yet: best effort only */
  }
})
