// The Fix-press reading: counts off real rows, never a guess. See src/shared/fixSign.ts.
import { strict as assert } from 'node:assert'
import { fixSignature } from '../src/shared/fixSign.ts'

// A clean Claude Code frame: one footer, two rules round the composer.
const clean = [
  '           Claude Code v2.1.259',
  '',
  '────────────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ''
]
assert.deepEqual(fixSignature(clean, 80), { footers: 1, rules: 2, edge: 0, rows: 7 })

// The same frame painted twice with the old one left behind - what a torn pane holds.
const torn = [...clean, ...clean]
const t = fixSignature(torn, 80)
assert.equal(t.footers, 2)
assert.equal(t.rules, 4)

// Bytes clamped into a narrower grid run to the last column.
const clamped = ['x'.repeat(51), 'y'.repeat(20), 'z'.repeat(51) + '   ']
assert.equal(fixSignature(clamped, 51).edge, 2)
assert.equal(fixSignature(clamped, 0).edge, 0)

// Blank rows are not rows that say anything.
assert.deepEqual(fixSignature(['', '   ', ''], 80), { footers: 0, rules: 0, edge: 0, rows: 3 })
console.log('fix-sign: 7 assertions ok')
