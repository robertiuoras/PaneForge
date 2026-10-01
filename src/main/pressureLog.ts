// Runs the once-a-minute sample for `shared/pressureLog.ts` and appends it to `pressure.log`.
//
// ONE async `ps` per sample (`execFileSync` froze the main process 2-4 s at load 400, see
// memory.ts). A sample that finds the previous one still running is skipped, not queued.
import { execFile } from 'node:child_process'
import { cpus, loadavg, platform } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { appendLog } from './logWrite'
import { memoryReading } from './memory'
import { buildPressureLine, parsePsTable, parseSwapUsedMb, PS_ARGS, type PressurePane } from '../shared/pressureLog'

export const PRESSURE_LOG_MS = 60_000
const MAX_BYTES = 2 * 1024 * 1024

export function startPressureLog(panes: () => PressurePane[]): () => void {
  let running = false
  const file = (): string => join(app.getPath('userData'), 'pressure.log')
  const swap = (cb: (mb: number | null) => void): void => {
    if (platform() !== 'darwin') return cb(null)
    execFile('/usr/sbin/sysctl', ['vm.swapusage'], { encoding: 'utf8', timeout: 5000 }, (err, out) =>
      cb(err ? null : parseSwapUsedMb(out))
    )
  }
  const sample = (): void => {
    if (running) return
    running = true
    execFile('ps', PS_ARGS, { encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (err || !out) {
        running = false
        return
      }
      swap((swapUsedMb) => {
        running = false
        try {
          const m = memoryReading()
          const line = buildPressureLine({
            at: Date.now(),
            kernel: m.kernel,
            compressor: m.compressor,
            loadavg1: loadavg()[0],
            cores: cpus().length || 1,
            compressorMb: m.compressorMb,
            swapUsedMb,
            ownPid: process.pid,
            panes: panes(),
            rows: parsePsTable(out)
          })
          appendLog(file(), JSON.stringify(line) + '\n', { rotateAt: MAX_BYTES })
        } catch {
          /* a log line is never worth a crash */
        }
      })
    })
  }
  const t = setInterval(sample, PRESSURE_LOG_MS)
  t.unref?.()
  return () => clearInterval(t)
}
