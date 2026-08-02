// The processes a pane starts that outlive the pane.
//
// `shutdown()` kills every pty with `taskkill /F /T <pid>`, and `/T` is a tree walk over
// LIVE ParentProcessId links, performed at the moment of the kill. Two ordinary things put
// a dev server outside that walk:
//
//   - the app never got to run shutdown() - a crash, the installer, a power cut, Task
//     Manager. The tree is still intact but its ROOT is gone, and every survivor's ppid
//     names a pid that no longer exists, so there is nothing left to walk from.
//   - the server was detached on purpose (`start /b`, `spawn({ detached: true })`, a
//     `&` through a shell), which cuts the link while everything is still alive.
//
// Neither link can be recovered afterwards. Windows does not reparent an orphan onto a
// living process the way init does; it leaves the dead number in place. So the app writes
// the tree down while it is still true: a sampler walks each live pty's descendants every
// SAMPLE_MS and merges what it finds into a ledger under userData, keyed by the app run
// that owns it. Closing a pane, quitting, and the next launch all kill from that ledger
// rather than from the process table.
//
// Nothing here asks what the pane is RUNNING. It is the pty's descendants, whatever the
// agent is - claude, codex, gemini, aider, a bare shell - and whatever that agent decided
// to start. The alternative is a per-CLI hook: written once per agent, out of date the day
// a new one ships, and still silent in the case this exists for, which is the app dying
// without getting to tell anybody.
//
// What makes killing a remembered pid safe is that a pid is never enough on its own. Every
// record carries the process's creation time, and a pid whose creation time has moved is a
// DIFFERENT process that happens to have been handed the same number. That check is
// re-made at kill time by whatever does the killing, never trusted from the ledger, and it
// is the whole reason this is allowed to run unattended at startup.
//
// Nothing here may block the main process. Every process-table read is async (`execFile`),
// and the two paths that cannot wait for a callback - a pane closing, and the app exiting -
// do not read the table at all: they hand the recorded pids to a detached script that does
// its own verification after we are gone. A `spawnSync` here would be the busy cursor the
// pane badges' `git status` is already forbidden for.
//
// POSIX needs almost none of it. node-pty's child is a session leader, so its descendants
// share a process GROUP, and group membership is inherited rather than linked - it does not
// break when an intermediate parent dies. One `kill(-pid)` reaps a pane's whole tree,
// detached servers included. The ledger stays for the one case a group cannot cover there
// either: an app run that died without killing anything.

import { execFile, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { spawnDetachedNoWindow } from './consoles'

/** How often the live tree is written down. */
export const SAMPLE_MS = 30_000

/**
 * Per run. A desk of eight panes running builds is a few dozen; anything past this is a
 * fork bomb or a sampler that has been running for a week, and neither is worth carrying
 * in a file we read at startup. Oldest records go first, and the drop is logged - a cap
 * that silently truncates reads afterwards as "everything was swept".
 */
export const MAX_TRACKED = 256

export interface ProcRecord {
  pid: number
  ppid: number
  /** Opaque, comparable, and stable for the life of the process. Never a duration. */
  started: string
  name: string
}

export interface StrayRecord {
  pid: number
  started: string
  name: string
}

/** What `strays.json` holds: the runs that have not been swept yet. */
export interface Ledger {
  runs: Record<string, StrayRecord[]>
}

// ---------------------------------------------------------------------------
// The decisions, as pure functions. Everything below the divider is IO.
// ---------------------------------------------------------------------------

/** ppid -> children, built once per sample rather than once per root. */
export function childIndex(snapshot: ProcRecord[]): Map<number, ProcRecord[]> {
  const byParent = new Map<number, ProcRecord[]>()
  for (const p of snapshot) {
    const kids = byParent.get(p.ppid)
    if (kids) kids.push(p)
    else byParent.set(p.ppid, [p])
  }
  return byParent
}

/**
 * Every live descendant of `roots`, roots excluded.
 *
 * Breadth-first over the index, with a seen-set: a pid whose parent field points back up
 * its own tree (Windows reuses pids, and a reused number can close a loop) would otherwise
 * walk forever inside a sampler that runs unattended.
 */
export function descendantsOf(snapshot: ProcRecord[], roots: number[]): ProcRecord[] {
  const byParent = childIndex(snapshot)
  const seen = new Set<number>(roots)
  const out: ProcRecord[] = []
  const queue = [...roots]
  while (queue.length) {
    const pid = queue.shift() as number
    for (const kid of byParent.get(pid) ?? []) {
      if (seen.has(kid.pid)) continue
      seen.add(kid.pid)
      out.push(kid)
      queue.push(kid.pid)
    }
  }
  return out
}

/**
 * Add this sample's findings to what earlier samples saw.
 *
 * The union is the point of the whole file. A process seen once is remembered after its
 * parent has gone and it has stopped being reachable from any root - which is exactly the
 * moment it stops being killable by any other means.
 *
 * Identity is pid AND creation time, so a reused pid appends rather than overwrites, and
 * the stale twin is dropped harmlessly by the same check at kill time.
 */
export function mergeStrays(previous: StrayRecord[], seen: StrayRecord[]): StrayRecord[] {
  const out = [...previous]
  const known = new Set(previous.map((r) => `${r.pid}:${r.started}`))
  for (const r of seen) {
    const key = `${r.pid}:${r.started}`
    if (known.has(key)) continue
    known.add(key)
    out.push(r)
  }
  return out.slice(-MAX_TRACKED)
}

/**
 * Which recorded processes are still alive AND still the same process.
 *
 * `exempt` is how the app keeps its hands off itself and off the copies still running: a
 * test copy's panes are never swept by the copy that happens to start next.
 */
export function victims(recorded: StrayRecord[], live: ProcRecord[], exempt: number[] = []): StrayRecord[] {
  const skip = new Set(exempt)
  const now = new Map(live.map((p) => [p.pid, p.started]))
  const out: StrayRecord[] = []
  const done = new Set<number>()
  for (const r of recorded) {
    if (skip.has(r.pid) || done.has(r.pid)) continue
    if (now.get(r.pid) !== r.started) continue
    done.add(r.pid)
    out.push(r)
  }
  return out
}

/** The runs in a ledger whose app process is gone, so their records are ours to act on. */
export function deadRuns(ledger: Ledger, livePids: number[]): string[] {
  const live = new Set(livePids.map((p) => String(p)))
  return Object.keys(ledger.runs).filter((run) => !live.has(run))
}

/**
 * The detached sweep, as PowerShell, kept a function of its input so a test can read what
 * would run without anything being killed.
 *
 * The creation time is checked again HERE rather than trusted from the ledger. Between the
 * last sample and this script there is a whole app lifetime - and across a reboot, a fresh
 * pid space - for the number to have been handed to something else.
 */
export function reapStraysScript(records: StrayRecord[], delayMs: number): string {
  const pairs = records.map((r) => `'${r.pid}'='${r.started}'`).join(';')
  return [
    `Start-Sleep -Milliseconds ${Math.max(0, Math.round(delayMs))}`,
    `$want = @{${pairs}}`,
    'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |',
    '  Where-Object { $_.CreationDate -and $want.ContainsKey([string]$_.ProcessId) -and',
    '                 $want[[string]$_.ProcessId] -eq [string]$_.CreationDate.ToFileTimeUtc() } |',
    '  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
  ].join('\n')
}

/** The same sweep for POSIX. `ps -o lstart=` is the only portable stable start time. */
export function reapStraysSh(records: StrayRecord[], delayMs: number): string {
  const lines = records.map(
    (r) =>
      `s=$(ps -o lstart= -p ${r.pid} 2>/dev/null | tr -s ' ' '_' | sed 's/^_//;s/_$//'); ` +
      `[ "$s" = "${r.started}" ] && kill -9 ${r.pid} 2>/dev/null`
  )
  return [`sleep ${Math.max(0, delayMs) / 1000}`, ...lines, 'exit 0'].join('\n')
}

/** `pid ppid started name` per line, which is what the Windows command is asked for. */
export function parseSnapshot(text: string): ProcRecord[] {
  const out: ProcRecord[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    if (!pid || pid === ppid) continue
    out.push({ pid, ppid, started: m[3], name: m[4].trim() })
  }
  return out
}

/**
 * `ps` prints lstart as five space-separated fields, so it cannot use parseSnapshot. The
 * underscore join is what `reapStraysSh` reproduces with `tr`, and the two have to agree
 * exactly or every POSIX kill is skipped as a pid-reuse.
 */
export function parsePosixSnapshot(text: string): ProcRecord[] {
  const out: ProcRecord[] = []
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 8) continue
    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    if (!pid || pid === ppid) continue
    out.push({ pid, ppid, started: parts.slice(2, 7).join('_'), name: parts.slice(7).join(' ') })
  }
  return out
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

const WIN = process.platform === 'win32'

const SNAPSHOT_PS = [
  '$ErrorActionPreference="SilentlyContinue"',
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate |',
  '  ForEach-Object { if ($_.CreationDate) {',
  '    "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToFileTimeUtc()) $($_.Name)" } }'
].join('\n')

/**
 * One process table, asynchronously. Windows dates come out as FILETIME ticks and POSIX
 * ones as an underscored `lstart`; both are opaque above this line, which only ever
 * compares them for equality.
 */
export function snapshot(done: (procs: ProcRecord[]) => void): void {
  const finish = (err: unknown, stdout: string): void => {
    if (err || !stdout) return done([])
    done(WIN ? parseSnapshot(stdout) : parsePosixSnapshot(stdout))
  }
  try {
    if (WIN) {
      const encoded = Buffer.from(SNAPSHOT_PS, 'utf16le').toString('base64')
      execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => finish(err, stdout)
      )
    } else {
      execFile('ps', ['-Ao', 'pid=,ppid=,lstart=,comm='], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
        finish(err, stdout)
      )
    }
  } catch {
    /* no powershell, no ps, a locked-down box: the sweep is a tidy-up, never a requirement */
    done([])
  }
}

function file(): string {
  return join(app.getPath('userData'), 'strays.json')
}

export function readLedger(): Ledger {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Ledger>
    const runs = raw.runs && typeof raw.runs === 'object' ? raw.runs : {}
    const clean: Record<string, StrayRecord[]> = {}
    for (const [run, list] of Object.entries(runs)) {
      if (!Array.isArray(list)) continue
      clean[run] = list.filter(
        (r): r is StrayRecord => !!r && typeof r.pid === 'number' && typeof r.started === 'string'
      )
    }
    return { runs: clean }
  } catch {
    return { runs: {} }
  }
}

function writeLedger(ledger: Ledger): void {
  try {
    mkdirSync(dirname(file()), { recursive: true })
    writeFileSync(file(), JSON.stringify(ledger), 'utf8')
  } catch {
    /* read-only profile: see consoles.ts - a tidy-up may never be a requirement */
  }
}

/**
 * This run's records, per pane, in memory. The file is written from it on each sample, so
 * the ledger a later launch reads is never more than SAMPLE_MS out of date.
 */
const tracked = new Map<string, StrayRecord[]>()
let timer: NodeJS.Timeout | undefined
let panes: () => Array<{ id: string; pid: number }> = () => []

function persist(): void {
  const ledger = readLedger()
  ledger.runs[String(process.pid)] = [...tracked.values()].flat().slice(-MAX_TRACKED)
  writeLedger(ledger)
}

/**
 * Take one sample and fold it into the ledger. Exported because the test drives it against
 * real processes rather than waiting out the timer.
 */
export function sampleOnce(done?: () => void): void {
  const live = panes().filter((p) => Number.isInteger(p.pid) && p.pid > 0)
  if (!live.length) return done?.()
  snapshot((procs) => {
    for (const pane of live) {
      const seen = descendantsOf(procs, [pane.pid]).map(({ pid, started, name }) => ({ pid, started, name }))
      const before = tracked.get(pane.id) ?? []
      const merged = mergeStrays(before, seen)
      if (merged.length === MAX_TRACKED && before.length + seen.length > MAX_TRACKED) {
        console.warn(`[strays] pane ${pane.id} is at the ${MAX_TRACKED} cap; its oldest records were dropped`)
      }
      tracked.set(pane.id, merged)
    }
    persist()
    done?.()
  })
}

/**
 * Start writing the tree down. `livePanes` is asked for the pty pids each time rather than
 * handed them once - panes open and close, and a sampler holding a stale list is a sampler
 * recording somebody else's children.
 */
export function trackStrays(livePanes: () => Array<{ id: string; pid: number }>): void {
  panes = livePanes
  if (timer) return
  timer = setInterval(() => sampleOnce(), SAMPLE_MS)
  timer.unref?.()
}

/**
 * Hand `records` to something that will outlive this process and kill them there, after it
 * has re-checked that each pid is still the process we wrote down.
 *
 * Detached for both the reasons in consoles.ts: nothing may block the main process, and on
 * the exit path there is no later turn to be called back on.
 */
export function reapDetached(records: StrayRecord[], delayMs: number): void {
  if (!records.length) return
  try {
    if (WIN) {
      const encoded = Buffer.from(reapStraysScript(records, delayMs), 'utf16le').toString('base64')
      spawnDetachedNoWindow('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded])
    } else {
      spawn('sh', ['-c', reapStraysSh(records, delayMs)], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch {
    /* no shell to run it in - the leak is a tidy-up, not a correctness problem */
  }
}

/**
 * A pane's own tree, killed as the pane closes.
 *
 * On POSIX the first line is the whole feature: the pty child is a session leader, so one
 * signal to the negated pid reaches every descendant including the detached ones, with no
 * ledger and no process table. The recorded sweep still runs after it, for anything that
 * had already left the group.
 */
export function killPaneStrays(id: string, ptyPid?: number): void {
  if (!WIN && ptyPid && ptyPid > 0) {
    try {
      process.kill(-ptyPid, 'SIGKILL')
    } catch {
      /* no such group: the pty is already gone */
    }
  }
  const records = tracked.get(id) ?? []
  tracked.delete(id)
  persist()
  // A short delay: the pty's own kill is in flight, and a process that dies on its own is
  // one we never had to name.
  reapDetached(records, 1500)
}

/**
 * Everything this run recorded, killed in a process that outlives us.
 *
 * Same shape as sweepOwnConsolesOnExit and for the same reason: while we are alive the
 * kill we would fire has to outrace process.exit().
 */
export function sweepOwnStraysOnExit(): void {
  const records = [...tracked.values()].flat()
  tracked.clear()
  const ledger = readLedger()
  delete ledger.runs[String(process.pid)]
  writeLedger(ledger)
  reapDetached(records, 900)
}

/**
 * What the runs before this one left running.
 *
 * Delayed, and a no-op on a machine that has never leaked one - a launch has better things
 * to do with its first seconds than enumerate every process on the box. Runs whose app pid
 * is still alive are left entirely alone: that is another copy of PaneForge, and its panes
 * are its business.
 */
export function sweepOldStrays(done?: (killed: number) => void, delayMs = 6000): void {
  const t = setTimeout(() => {
    const ledger = readLedger()
    snapshot((live) => {
      const dead = deadRuns(ledger, live.map((p) => p.pid)).filter((run) => run !== String(process.pid))
      const records = dead.flatMap((run) => ledger.runs[run] ?? [])
      for (const run of dead) delete ledger.runs[run]
      writeLedger(ledger)
      const doomed = victims(records, live, [process.pid])
      if (doomed.length) {
        console.warn(
          `[strays] ${doomed.length} process(es) left behind by ${dead.length} earlier run(s): ` +
            doomed.map((d) => `${d.name}(${d.pid})`).join(', ')
        )
        reapDetached(doomed, 0)
      }
      done?.(doomed.length)
    })
  }, delayMs)
  // Never a reason for the app to stay alive: if the window has gone in the six seconds
  // before this fires, the sweep the NEXT launch runs covers the same ground.
  t.unref?.()
}

/** Only for the test, which needs a known ledger and a known pane list. */
export function setTrackedForTest(id: string, records: StrayRecord[]): void {
  tracked.set(id, records)
}
