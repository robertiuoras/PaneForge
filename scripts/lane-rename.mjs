// Write-then-rename that survives Windows. A rename over a file another process has open
// (a reader, antivirus, the indexer) fails for a few ms with EPERM/EACCES/EBUSY; the engine
// used to throw and leave its `.tmp` behind. Retry briefly, and never leave the tmp behind.
import { readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])
const DELAYS = [10, 20, 40, 80, 120] // ms, 270 in all

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function renameSafe(tmp, target, { rename = renameSync, pause = sleep } = {}) {
  for (let i = 0; ; i++) {
    try {
      rename(tmp, target)
      return
    } catch (e) {
      if (!BUSY.has(e && e.code) || i >= DELAYS.length) {
        try { unlinkSync(tmp) } catch { /* already gone */ }
        throw e
      }
      pause(DELAYS[i])
    }
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

// Remove `<base>.<pid>.tmp` litter left by a process that died, or older than ten minutes.
export function sweepStaleTmp(target, { isAlive = alive, nowMs = Date.now() } = {}) {
  const dir = dirname(target)
  const escaped = basename(target).replace(/[.*+?^$|(){}[\]\\]/g, '\\$&')
  const re = new RegExp('^' + escaped + '\\.(\\d+)\\.tmp$')
  let names = []
  try { names = readdirSync(dir) } catch { return 0 }
  let n = 0
  for (const name of names) {
    const m = re.exec(name)
    if (!m || Number(m[1]) === process.pid) continue
    try {
      const p = join(dir, name)
      if (!isAlive(Number(m[1])) || nowMs - statSync(p).mtimeMs > 600_000) { unlinkSync(p); n++ }
    } catch { /* raced with its owner */ }
  }
  return n
}
