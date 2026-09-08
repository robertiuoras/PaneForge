#!/usr/bin/env node
// What a woken pane writes before the CLI paints: shared/wakeScreen.ts.
//
// The load-bearing assertion is the NEGATIVE one - these bytes may never erase - plus a
// control that proves the check would notice if they did.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '..', 'src', 'shared', 'wakeScreen.ts')

// The module is TypeScript with no runtime types in it, so it is evaluated directly
// rather than built - same trick the other shared-module suites use.
const code = readFileSync(src, 'utf8')
  .replace(/export function/g, 'function')
  .replace(/export \{[^}]*\}/g, '')
  .replace(/: number \| undefined/g, '')
  .replace(/: string/g, '')
  .replace(/ as number/g, '')
const { wakeBytes, MIN_ROWS, MAX_ROWS } = new Function(`${code}; return { wakeBytes, MIN_ROWS, MAX_ROWS }`)()

let checks = 0
let failed = 0
function ok(what, cond) {
  checks++
  if (!cond) {
    failed++
    console.log(`  FAIL ${what}`)
  }
}

const out = wakeBytes(30)

// 1. It scrolls exactly the pane's own height.
ok('one newline per row', (out.match(/\n/g) || []).length === 30)
ok('no stray carriage rows', (out.match(/\r/g) || []).length === 1)

// 2. It NEVER erases. This is the whole point: the screen the pane fell asleep with has to
//    survive in scrollback, and every one of these sequences would take it away.
for (const bad of ['\x1b[2J', '\x1b[3J', '\x1b[J', '\x1b[0J', '\x1b[1J', '\x1bc', '\x1b[2K']) {
  ok(`no erase ${JSON.stringify(bad)}`, !out.includes(bad))
}
// Control: the check above can actually see an erase when one is there.
ok('control - an erasing string fails the same test', '\x1b[0m\r\n\x1b[2J'.includes('\x1b[2J'))

// 3. The cursor lands at the top of the blank viewport, so the CLI paints downward into
//    rows nobody has written on rather than into the old frame's gaps.
ok('ends at home', out.endsWith('\x1b[H'))
ok('attributes reset first', out.startsWith('\x1b[0m'))
ok('column zero before the scroll', out.slice(0, 6) === '\x1b[0m\r\n'.slice(0, 6))

// 4. A grid nobody measured under-scrolls rather than over-scrolls.
ok('undefined rows', (wakeBytes(undefined).match(/\n/g) || []).length === MIN_ROWS)
ok('zero rows', (wakeBytes(0).match(/\n/g) || []).length === MIN_ROWS)
ok('NaN rows', (wakeBytes(NaN).match(/\n/g) || []).length === MIN_ROWS)
ok('negative rows', (wakeBytes(-5).match(/\n/g) || []).length === MIN_ROWS)
ok('fractional rows floor', (wakeBytes(24.9).match(/\n/g) || []).length === 24)
ok('a grid taller than any screen is capped', (wakeBytes(100000).match(/\n/g) || []).length === MAX_ROWS)
ok('a tall but real grid is not capped', (wakeBytes(80).match(/\n/g) || []).length === 80)

// 5. Two wakes in a row are two clean screens, never a compounding one.
ok('idempotent shape', wakeBytes(30) === out)

// 6. And what it replaced: the caption a sleeping pane leaves in the terminal is now one
//    short dim line, because the sentence moved onto the pane itself (`PaneAsleep`).
const sessions = readFileSync(join(here, '..', 'src', 'main', 'sessions.ts'), 'utf8')
ok('no WAKE_MARK caption left', !sessions.includes('--- awake ---'))
ok('the old sleep banner is gone', !sessions.includes('asleep: the agent has been stopped'))
ok('wake writes the scroll', sessions.includes('wakeBytes(live.rows)'))
const pane = readFileSync(join(here, '..', 'src', 'renderer', 'src', 'components', 'TerminalPane.tsx'), 'utf8')
ok('the pane draws the asleep line', pane.includes('function PaneAsleep'))
ok('a mirror is told nothing', pane.includes('{asleep && !mirror && <PaneAsleep />}'))
ok('booting and asleep are never both drawn', pane.includes('!mirror && !asleep && <PaneBooting'))

console.log(failed ? `wakescreen: ${failed} of ${checks} checks FAILED` : `wakescreen: ${checks} checks passed`)
process.exit(failed ? 1 : 0)
