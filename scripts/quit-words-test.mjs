// "Why did the app quit" when nothing in the app asked.
//
// The sentence this replaces named three possibilities and separated none of them, which
// is what made 2026-08-21's nine-pane close unanswerable from the machine. The load-bearing
// half is the FALSE POSITIVE: calling a real Cmd-Q an outside kill sends the next person
// hunting a script that does not exist, so a blur a beat before the quit still reads as
// the keyboard.
//
//   node scripts/quit-words-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-quit-words-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const outfile = join(work, 'quitWords.bundle.cjs')
buildSync({ absWorkingDir: root, entryPoints: ['src/shared/quitWords.ts'], bundle: true, format: 'cjs', platform: 'node', outfile })
const { quitWhere, FROM_KEYBOARD_MS } = createRequire(import.meta.url)(outfile)

let n = 0
const ok = (what, cond) => {
  assert.ok(cond, what)
  n++
}
const NOW = 1_760_000_000_000
const KEYS = /Cmd-Q or the app menu/
const OUTSIDE = /did NOT come from this keyboard/

ok('focused right now reads as the keyboard', KEYS.test(quitWhere(true, NOW - 60_000, NOW)))
ok(
  'blurred a beat ago still reads as the keyboard - Cmd-Q blurs before before-quit runs',
  KEYS.test(quitWhere(false, NOW - (FROM_KEYBOARD_MS - 500), NOW))
)
ok(
  'blurred for a while is named as coming from outside',
  OUTSIDE.test(quitWhere(false, NOW - 12_000, NOW))
)
ok('...and says how long, because the number is the evidence', /12s/.test(quitWhere(false, NOW - 12_000, NOW)))
ok(
  'the incident shape: frontmost taken by something else 12s before the quit',
  OUTSIDE.test(quitWhere(false, NOW - 12_400, NOW))
)
ok(
  'never focused this run is its own answer, not an outside kill',
  !OUTSIDE.test(quitWhere(false, 0, NOW)) && !KEYS.test(quitWhere(false, 0, NOW))
)
ok('it never names a culprit as fact', !/pkill killed/.test(quitWhere(false, NOW - 99_000, NOW)))

// The wiring: a pure function nothing calls is the false confidence this repo keeps hitting.
const idx = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
ok('index.ts asks quitWhere for the words', /quitWhere\(focused, lastFocusAt, Date\.now\(\)\)/.test(idx))
ok('focus is recorded on focus', /app\.on\('browser-window-focus'/.test(idx))
ok('...and on blur, which is the reading that matters', /app\.on\('browser-window-blur'/.test(idx))

rmSync(work, { recursive: true, force: true })
console.log(`quit-words: ${n} checks passed`)
