// A run that died without a quit line is attributed by the next launch.
//
// 2026-09-30 11:17Z: pid 20879 went silent and the next launch said only "8 pane(s) left by
// a crash or a kill". macOS had three hang reports and a loginwindow force quit. The next
// launch now reads the dead run's heartbeat and those reports and says which.
//
//   node scripts/last-breath-test.mjs

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const { previousEnd, isAppReport, BREATH_EVERY_MS } = await import('../src/shared/lastBreath.ts')

const at = Date.parse('2026-09-30T11:17:03Z')
const now = Date.parse('2026-09-30T11:20:22Z')
const dead = { pid: 20879, version: '0.8.232', at }
const spin = (name, t) => ({ name, at: Date.parse(t), reason: 'Slow response to HID event' })

// The 09-30 evidence, as the files were named on disk.
{
  const line = previousEnd(
    dead,
    [
      spin('PaneForge_2026-09-30-211044_Roberts-MacBook-Pro.spin', '2026-09-30T11:10:44Z'),
      spin('PaneForge_2026-09-30-211527_Roberts-MacBook-Pro.spin', '2026-09-30T11:15:27Z'),
      spin('PaneForge_2026-09-30-211625_Roberts-MacBook-Pro.spin', '2026-09-30T11:16:25Z'),
      spin('PaneForge_2026-09-30-211726_Roberts-MacBook-Pro.spin', '2026-09-30T11:17:26Z'),
      spin('PaneForge_2026-09-30-211901_Roberts-MacBook-Pro.spin', '2026-09-30T11:19:01Z'),
      spin('PaneForge_2026-09-30-211933_Roberts-MacBook-Pro.spin', '2026-09-30T11:19:33Z'),
      spin('PaneForge_2026-09-30-212055_Roberts-MacBook-Pro.spin', '2026-09-30T11:20:55Z')
    ],
    70914,
    now
  )
  assert.ok(line, 'a run with no quit is attributed')
  assert.match(line, /pid 20879, v0\.8\.232\) ended without a quit; last heard from 2026-09-30T11:17:03\.000Z \(3 min before/)
  assert.match(line, /stopped responding and was force-quit or killed while hung - macOS hang report PaneForge_2026-09-30-211726_Roberts-MacBook-Pro\.spin \(Slow response to HID event\), 3 reports; 3 earlier hang report\(s\) in the hour before$/, line)
}

// A crash report outranks a hang report: it is the more specific cause.
assert.match(
  previousEnd(dead, [spin('PaneForge_2026-09-30-211901_x.spin', '2026-09-30T11:19:01Z'), { name: 'PaneForge-2026-09-30-211905.ips', at: Date.parse('2026-09-30T11:19:05Z'), reason: 'EXC_BAD_ACCESS' }], 1, now),
  /it crashed - macOS crash report PaneForge-2026-09-30-211905\.ips \(EXC_BAD_ACCESS\)/
)
// Reports from an earlier death are not this one's.
assert.match(previousEnd(dead, [spin('PaneForge_2026-09-29-090000_x.spin', '2026-09-29T09:00:00Z')], 1, now), /no macOS crash or hang report - killed from outside[^;]*$/)
// A run that quit has already said why; this run is not the previous one; no breath, no line.
assert.equal(previousEnd({ ...dead, quit: 'Cmd-Q' }, [], 1, now), null)
assert.equal(previousEnd(dead, [], 20879, now), null)
assert.equal(previousEnd(null, [], 1, now), null)

assert.ok(isAppReport('PaneForge_2026-09-30-211901_Roberts-MacBook-Pro.spin', 'PaneForge'))
assert.ok(isAppReport('PaneForge-2026-09-30-211905.ips', 'PaneForge'))
assert.ok(!isAppReport('PaneForge Next_2026-09-30-211901_x.spin', 'PaneForge'), 'a sibling app is not this one')
assert.ok(!isAppReport('Safari_2026-09-29-040756_x.spin', 'PaneForge'))
assert.ok(BREATH_EVERY_MS <= 60_000, 'the heartbeat is fresh enough to place a death within a minute')

// Wiring: the breath starts in the lock holder before the desk line, and the quit line marks it.
const index = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const logQuit = index.slice(index.indexOf('function logQuit'), index.indexOf('function quitReason'))
assert.match(logQuit, /lastBreath\(quitReason\(\)\)/, 'every quit path (all go through logQuit) marks the breath')
assert.match(index, /if \(app\.hasSingleInstanceLock\(\)\)\s*startBreathing\([\s\S]{0,120}updateLog\('death'[\s\S]{0,60}logProblem\('death'[\s\S]{0,40}\}\)\s*offerRestore\(\)/)
const main = readFileSync(new URL('../src/main/lastBreath.ts', import.meta.url), 'utf8')
assert.match(main, /if \(breathing\) write\(/, 'a lock loser quitting never overwrites the running copy\'s breath')

console.log('last breath: ok')
