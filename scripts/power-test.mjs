#!/usr/bin/env node
/**
 * The power-source parser, against the real thing.
 *
 * The battery sample below is a verbatim capture from this MacBook on 2026-09-01, not a
 * hand-written line that happens to contain the words - a fixture shaped like the code
 * expects proves only that the code agrees with itself. The failure case matters as much
 * as the two good ones: an unreadable answer must THROW, because `false` is the shape of
 * a correct answer and a silently-false power reading would disable the saving forever
 * with nothing to find.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'src/main/power.ts'), 'utf8')
const body = src.match(/export function parsePmsetBatt\(out: string\): boolean \{([\s\S]*?)\n\}/)
if (!body) {
  console.error('power-test: parsePmsetBatt not found in src/main/power.ts')
  process.exit(1)
}
const parse = new Function('out', body[1].replace(/: string/g, ''))

let failed = 0
const check = (name, fn) => {
  try {
    fn()
    console.log('  ok  ' + name)
  } catch (e) {
    failed++
    console.error('  FAIL ' + name + ': ' + e.message)
  }
}
const eq = (a, b, what) => {
  if (a !== b) throw new Error(`${what}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`)
}

// Verbatim `pmset -g batt` on battery, captured 2026-09-01.
const ON_BATTERY = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=35913827)\t60%; discharging; 4:27 remaining present: true
`
const ON_AC = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=35913827)\t60%; charging; 1:12 remaining present: true
`

check('real battery capture reads as on-battery', () => eq(parse(ON_BATTERY), true, 'battery'))
check('AC reads as not-on-battery', () => eq(parse(ON_AC), false, 'ac'))
check('unreadable output throws rather than answering false', () => {
  let threw = false
  try {
    parse('pmset: command not found\n')
  } catch {
    threw = true
  }
  if (!threw) throw new Error('parsed garbage without throwing - a silent false disables the saving forever')
})
check('empty output throws', () => {
  let threw = false
  try {
    parse('')
  } catch {
    threw = true
  }
  if (!threw) throw new Error('parsed empty output without throwing')
})

// And against this machine right now, so the format cannot drift under the fixture.
if (process.platform === 'darwin') {
  check('agrees with live pmset on this machine', () => {
    const live = execFileSync('/usr/bin/pmset', ['-g', 'batt'], { encoding: 'utf8' })
    const answer = parse(live)
    if (typeof answer !== 'boolean') throw new Error('live pmset did not parse to a boolean')
    console.log(`       (live: on battery = ${answer})`)
  })
}

if (failed) {
  console.error(`\npower-test: ${failed} failed`)
  process.exit(1)
}
console.log('power-test: all checks passed')
