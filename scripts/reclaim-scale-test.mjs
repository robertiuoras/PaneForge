// A bounded 50-pane lifecycle check against the actual reclaim decisions.
// It opens no terminals and closes no live pane.

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-reclaim-scale-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const outfile = join(work, 'reclaim.bundle.cjs')
buildSync({ absWorkingDir: root, entryPoints: ['src/shared/reclaim.ts'], bundle: true, format: 'cjs', platform: 'node', outfile })
const { idleClosePlan, idleSleepPlan, DEFAULT_RECLAIM } = createRequire(import.meta.url)(outfile)

const now = 1_700_000_000_000
const cfg = { ...DEFAULT_RECLAIM, idleCloseMinutes: 5, idleSleepMinutes: 5, maxPerSweep: 2 }
const pane = (id, extra = {}) => ({
  id,
  state: 'ready',
  lastKeyboard: now - 10 * 60_000,
  lastOutput: now - 10 * 60_000,
  focused: false,
  visible: false,
  remote: false,
  ...extra
})
const measure = (panes) => {
  const started = performance.now()
  const close = idleClosePlan(panes, cfg, now, false)
  const sleep = idleSleepPlan(panes, cfg, now, false)
  return { close: close.length, sleep: sleep.length, ms: performance.now() - started }
}

const mostlyRemote = Array.from({ length: 50 }, (_, i) => pane(`remote-${i}`, { remote: true }))
const active = Array.from({ length: 50 }, (_, i) => pane(`active-${i}`, { busy: true, state: 'working' }))
const idle = Array.from({ length: 50 }, (_, i) => pane(`idle-${i}`))
const remoteResult = measure(mostlyRemote)
const activeResult = measure(active)
const idleResult = measure(idle)

assert.deepEqual([remoteResult.close, remoteResult.sleep], [0, 0], 'remote panes stay with their owner')
assert.deepEqual([activeResult.close, activeResult.sleep], [0, 0], 'active agents stay running')
assert.deepEqual([idleResult.close, idleResult.sleep], [50, 50], 'idle local panes are the only candidates')
console.log(`reclaim scale: remote ${remoteResult.ms.toFixed(3)}ms, active ${activeResult.ms.toFixed(3)}ms, idle ${idleResult.ms.toFixed(3)}ms (50 each)`)
