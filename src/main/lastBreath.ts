// The heartbeat that lets the next launch say how this one ended. Why: shared/lastBreath.ts.
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { app } from 'electron'
import { BREATH_EVERY_MS, isAppReport, previousEnd, type Breath, type HostReport } from '../shared/lastBreath'

/** Only the copy that started breathing writes: a lock loser quitting must not overwrite it. */
let breathing = false

function file(): string {
  return join(app.getPath('userData'), 'last-breath.json')
}

function write(b: Breath): void {
  try {
    writeFileSync(file(), JSON.stringify(b))
  } catch {
    /* the next breath tries again */
  }
}

/** The first line of a report that says why it was written. */
function reasonOf(path: string): string {
  let fd = -1
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(8192)
    const head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8')
    return (/^(?:Reason|Exception Type):\s*(.+)$/m.exec(head)?.[1] ?? /"type"\s*:\s*"([A-Z_]+)"/.exec(head)?.[1] ?? '').trim()
  } catch {
    return ''
  } finally {
    if (fd >= 0) closeSync(fd)
  }
}

/** macOS hang and crash reports about this app. Read once, at a launch that follows a death. */
function hostReports(): HostReport[] {
  if (process.platform !== 'darwin') return []
  const appName = basename(process.execPath)
  const out: HostReport[] = []
  for (const dir of ['/Library/Logs/DiagnosticReports', join(homedir(), 'Library/Logs/DiagnosticReports')]) {
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!isAppReport(name, appName)) continue
      try {
        const path = join(dir, name)
        out.push({ name, at: statSync(path).mtimeMs, reason: reasonOf(path) })
      } catch {
        /* unreadable: root-only on some machines */
      }
    }
  }
  return out
}

/**
 * Says how the previous run ended when it did not, then keeps this run's heartbeat.
 * Call once, from the copy that holds the single-instance lock.
 */
export function startBreathing(log: (line: string) => void): void {
  let prev: Breath | null = null
  try {
    prev = JSON.parse(readFileSync(file(), 'utf8')) as Breath
  } catch {
    /* first run, or a breath cut off mid-write */
  }
  const died = !!prev && !prev.quit && prev.pid !== process.pid
  const line = previousEnd(prev, died ? hostReports() : [], process.pid, Date.now())
  if (line) log(line)
  breathing = true
  const breathe = (): void => write({ pid: process.pid, version: app.getVersion(), at: Date.now() })
  breathe()
  setInterval(breathe, BREATH_EVERY_MS).unref()
}

/** The quit line's half: a run that says why it left is not attributed at the next launch. */
export function lastBreath(quit: string): void {
  if (breathing) write({ pid: process.pid, version: app.getVersion(), at: Date.now(), quit })
}
