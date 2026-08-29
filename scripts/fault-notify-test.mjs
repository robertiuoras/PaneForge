// A fault that reaches a phone, and the six that must not.
//
// The load-bearing half of this file is the negatives. A crash guard exists to keep the
// app up quietly, so the alarm bolted onto it is only worth having while it stays rare:
// a phone that buzzes through a loop throwing every frame is a phone whose owner turns
// the alarm off, and then the next real fault is silent too.
//
//   node scripts/fault-notify-test.mjs

import { buildSync } from 'esbuild'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-faultnotify-'))

buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/faultNotify.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: join(work, 'faultNotify.cjs')
})
const F = createRequire(join(work, 'x.cjs'))('./faultNotify.cjs')

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail !== undefined) console.log(`      ${detail}`)
  }
}

const fresh = () => ({ sent: {}, count: 0 })
const NOW = 1_700_000_000_000
const at = (state, f, o = {}) => F.decide(state, f, { now: NOW, device: 'Roberts-MacBook-Pro', ...o })

// ---- what gets through --------------------------------------------------------------

const crash = at(fresh(), {
  kind: 'uncaughtException',
  detail: 'TypeError: x is not a function\n    at foo (/a/b.js:1:1)'
})
ok('an uncaught exception is sent', !!crash.send)
ok('...naming the machine', /Roberts-MacBook-Pro/.test(crash.send || ''), crash.send)
ok('...and the log, not the stack', /paneforge-errors\.log/.test(crash.send || ''))
ok(
  '...carrying the first line only',
  !/at foo/.test(crash.send || ''),
  'a lock screen gets the headline; the log gets the stack'
)

ok('an unhandled rejection is sent', !!at(fresh(), { kind: 'unhandledRejection', detail: 'nope' }).send)

const wedged = at(fresh(), { kind: 'renderer', detail: 'reload (unresponsive for 20481ms) - 12% 900MB' })
ok('a renderer that was RELOADED is sent', !!wedged.send)
ok(
  '...and says the window stopped answering',
  /stopped answering/.test(wedged.send || ''),
  wedged.send
)
ok(
  'a renderer left alone after three reloads is sent',
  !!at(fresh(), { kind: 'renderer', detail: 'still wedged after 3 reload(s) - leaving it alone' }).send
)
ok(
  'a renderer that had to be recreated is sent',
  !!at(fresh(), { kind: 'renderer', detail: 'recreate (process gone) - ?' }).send
)

// ---- and the refusals, which are the feature ----------------------------------------

ok(
  'a test copy pages NOBODY',
  at(fresh(), { kind: 'uncaughtException', detail: 'boom' }, { profile: 'dev' }).send === null,
  'npm run try must not be able to set off a real alarm'
)
ok(
  'the crash-guard DRILL is not a fault',
  at(fresh(), {
    kind: 'uncaughtException',
    detail: 'Error: SMOKE TEST (not a real fault): crash guard drill, safe to ignore'
  }).send === null
)
for (const detail of [
  'pid 4123 cpu-time 14:03 99.1 812345 (TIME %CPU RSS-KB)',
  'unresponsive - 12% 900MB',
  'answering again after 24310ms',
  'gone: reason=crashed exitCode=133'
]) {
  ok(
    `a renderer READING is not an act: ${detail.slice(0, 28)}...`,
    at(fresh(), { kind: 'renderer', detail }).send === null
  )
}
ok(
  'a kind nobody registered is not sent',
  at(fresh(), { kind: 'windows', detail: 'desktop shortcut put back' }).send === null
)

// ---- the same fault twice, which is what a loop looks like ---------------------------

let s = fresh()
const first = F.decide(s, { kind: 'renderer', detail: 'reload (unresponsive for 20481ms) - 12% 900MB' }, { now: NOW })
s = first.state
ok('the first of a recurring fault is sent', !!first.send)

// Every number differs - pid, ms, memory - which is exactly what defeated a raw-text match.
const again = F.decide(
  s,
  { kind: 'renderer', detail: 'reload (unresponsive for 31904ms) - 44% 1204MB' },
  { now: NOW + 60_000 }
)
ok(
  'the same wedge with different NUMBERS is one message, not two',
  again.send === null,
  'signature() must blank the digits or the quiet window never fires'
)
s = again.state

const later = F.decide(
  s,
  { kind: 'renderer', detail: 'reload (unresponsive for 20000ms) - 12% 900MB' },
  { now: NOW + F.QUIET_MS + 1 }
)
ok('...and is sent again once the quiet window is over', !!later.send)

// ---- the run budget ------------------------------------------------------------------

let b = fresh()
let sent = 0
for (let i = 0; i < 40; i++) {
  // A different fault each time, so only the budget can stop this.
  const r = F.decide(b, { kind: 'uncaughtException', detail: `Error ${'x'.repeat(i)} broke` }, { now: NOW + i })
  b = r.state
  if (r.send) sent++
}
ok(`a throwing loop costs ${F.MAX_PER_RUN} messages, not 40`, sent === F.MAX_PER_RUN, `sent ${sent}`)
ok(
  '...and the last one says it is the last',
  F.faultMessage({ kind: 'uncaughtException', detail: 'x' }, { last: true }).includes('No more of these'),
  'a silence that is not announced reads as "it stopped happening"'
)

// ---- source assertions: the wiring a pure test cannot reach ---------------------------

const crashSrc = readFileSync(join(root, 'src/main/crash.ts'), 'utf8')
ok(
  'crash.ts writes the log BEFORE it tells any listener',
  crashSrc.indexOf('appendFileSync') < crashSrc.indexOf('problem?.('),
  'the record may never depend on the alarm'
)
ok(
  'a listener that throws cannot cost the record',
  /try \{\s*problem\?\.\(kind, detail\)\s*\} catch/.test(crashSrc)
)
const idx = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
ok(
  'startFaultNotify runs AFTER initProfile',
  idx.indexOf('initProfile()') < idx.indexOf('startFaultNotify()'),
  'before it, profileName() is empty and a dev copy pages Robert'
)

console.log(failed ? `\n${failed} failed` : '\nall good')
process.exit(failed ? 1 : 0)
