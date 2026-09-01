// A dev server that is running and serving nothing - shared/deadDev.ts.
//
// The load-bearing assertions are the REFUSALS. This is the only thing in the app that
// kills a process nobody named, so every case where it must not act is pinned: a healthy
// server whose socket is held by a child, one a launchd job supervises, one that has only
// just started, one somebody kept, and a failed socket reading (which must never read as
// "nothing is listening", because that would take every dev server on the desk).
//
// Run: npm run test:deaddev

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-deaddev-'))
const outfile = join(work, 'deaddev.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/deadDev.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const {
  DEAD_AFTER_MS,
  DEFAULT_DEAD_DEV,
  deadDevs,
  stopPlan,
  trackDead,
  stopSoonWords,
  stopSoonWhy
} = createRequire(import.meta.url)(outfile)

let pass = 0
const ok = (cond, what) => {
  assert.ok(cond, what)
  pass++
}
const eq = (a, b, what) => {
  assert.deepStrictEqual(a, b, what)
  pass++
}

const dev = (pid, over = {}) => ({
  pid,
  cmd: `next dev -p ${over.port ?? 3000}`,
  label: over.label ?? 'next',
  port: over.port ?? 3000,
  paneId: over.paneId ?? null,
  pane: over.pane ?? null,
  where: over.where ?? 'taskdriver'
})

const NOW = 1_700_000_000_000
const OLD = NOW - DEAD_AFTER_MS - 1000
const none = { now: NOW, kept: new Set(), supervised: new Set() }

// --- what it is for ---------------------------------------------------------

{
  // The measured case, 2026-09-01: two `next dev -p 3006`, one of them holding the port.
  const good = dev(23921, { port: 3006 })
  const dupe = dev(58208, { port: 3006 })
  const serving = new Set([23921])
  const since = new Map([[58208, OLD]])
  const dead = deadDevs([good, dupe], serving, since, none)
  eq(dead.map((d) => d.pid), [58208], 'only the one serving nothing is dead')
  ok(dead[0].deadMin >= 1, 'it says how long it has been dead')
  ok(stopSoonWords(dead[0]).includes('taskdriver'), 'the sentence names the project')
  ok(stopSoonWhy(dead[0]).includes('3006'), 'the reason names the port as the evidence')
  ok(!stopSoonWords(dead[0]).includes('58208'), 'the sentence never carries the pid')
  ok(!/orphan|pid|ppid/i.test(stopSoonWhy(dead[0])), 'no machinery words on screen')
}

// --- refusals ---------------------------------------------------------------

{
  const d = dev(100)
  eq(deadDevs([d], new Set([100]), new Map([[100, OLD]]), none), [], 'a serving one is never dead')
}
{
  const d = dev(100)
  eq(deadDevs([d], new Set(), new Map([[100, NOW - 1000]]), none), [], 'a server still inside its grace is not dead')
  eq(deadDevs([d], new Set(), new Map(), none), [], 'one seen for the first time is not dead')
}
{
  const d = dev(100)
  eq(
    deadDevs([d], new Set(), new Map([[100, OLD]]), { ...none, supervised: new Set([100]) }),
    [],
    'a supervised job is never closed - it comes straight back'
  )
  eq(
    deadDevs([d], new Set(), new Map([[100, OLD]]), { ...none, kept: new Set([100]) }),
    [],
    'one somebody kept is never offered again'
  )
}
{
  eq(deadDevs([dev(1)], new Set(), new Map([[1, OLD]]), none), [], 'pid 1 is refused outright')
}

// --- the clock --------------------------------------------------------------

{
  const d = dev(100)
  const first = trackDead([d], new Set(), new Map(), NOW)
  eq(first.get(100), NOW, 'a newly dead server is stamped now')
  const later = trackDead([d], new Set(), first, NOW + 30_000)
  eq(later.get(100), NOW, 'the moment is NOT reset on the next sweep')
  const alive = trackDead([d], new Set([100]), later, NOW + 60_000)
  eq(alive.has(100), false, 'a server that started serving is forgotten')
  const gone = trackDead([], new Set(), later, NOW + 60_000)
  eq(gone.size, 0, 'a server that exited is forgotten')
}

// --- the countdown ----------------------------------------------------------

{
  const dead = deadDevs([dev(100)], new Set(), new Map([[100, OLD]]), none)
  const plan = stopPlan(dead, null, DEFAULT_DEAD_DEV, NOW)
  ok(plan, 'a dead server arms a countdown')
  eq(plan.deadline - NOW, DEFAULT_DEAD_DEV.countdownSeconds * 1000, 'the deadline is the configured seconds')
  eq(DEFAULT_DEAD_DEV.countdownSeconds, 5, 'five seconds, as asked for')
  eq(DEFAULT_DEAD_DEV.enabled, true, 'it arrives on')

  const again = stopPlan(dead, plan, DEFAULT_DEAD_DEV, NOW + 2000)
  eq(again, plan, 'a countdown already running is never re-armed - the number may only go down')

  eq(stopPlan(dead, null, { ...DEFAULT_DEAD_DEV, enabled: false }, NOW), null, 'off means nothing is offered')
  eq(stopPlan([], null, DEFAULT_DEAD_DEV, NOW), null, 'nothing dead, nothing armed')
}
{
  // Two dead at once is still one card: the corner holds one countdown, and the next
  // sweep offers the next one.
  const dead = deadDevs(
    [dev(100), dev(200, { where: 'secondtonone' })],
    new Set(),
    new Map([
      [100, NOW - 10 * 60_000],
      [200, OLD]
    ]),
    none
  )
  eq(dead.length, 2, 'both are dead')
  eq(dead[0].pid, 100, 'the one dead longest is offered first')
  const plan = stopPlan(dead, null, DEFAULT_DEAD_DEV, NOW)
  eq(plan.dev.pid, 100, 'one card, for that one')
}

// --- the main side, read as source ------------------------------------------

const mainSrc = readFileSync(join(root, 'src/main/deadDev.ts'), 'utf8')
ok(
  /if \(!listening\.size\) return/.test(mainSrc),
  'an empty socket reading is a FAILED reading and stops the sweep - it must never read as "nothing is listening"'
)
ok(/descendants\(procs, d\.pid\)/.test(mainSrc), 'a socket held by a child counts for the parent it was folded into')
ok(/launchctl/.test(mainSrc), 'supervised pids are read, never guessed')
ok(/SWEEP_MS/.test(mainSrc) && !/setInterval\(\s*\(\) => \{\s*void sweepDeadDevs\(\)\s*\}, 1000\)/.test(mainSrc),
  'the expensive sweep runs on SWEEP_MS, not every second')
ok(/stopDevServer/.test(mainSrc), 'the kill goes through the re-validating stopDevServer, never a raw process.kill')

const appSrc = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
ok(/<StopServer/.test(appSrc), 'the card is rendered')
const stack = appSrc.slice(appSrc.indexOf("'corner-stack'"))
ok(stack.indexOf('<StopServer') < stack.indexOf('</div>\n      {activityAt'), 'it lives INSIDE the corner stack, never fixed on its own')

const cardSrc = readFileSync(join(root, 'src/renderer/src/components/StopServer.tsx'), 'utf8')
ok(/Keep it running/.test(cardSrc), 'there is a way to say no')
ok(/Close now/.test(cardSrc), 'there is a way to say yes sooner')
// The word "dialog" appears in this file's own comment saying it is not one, so the
// assertion is about CODE: no message box, no alert, no focus grab.
ok(
  !/showMessageBox|window\.alert\(|\.focus\(\)/.test(cardSrc),
  'never a dialog and never focused - nothing the app decided may take the screen'
)

console.log(`deaddev: ${pass} checks passed`)
