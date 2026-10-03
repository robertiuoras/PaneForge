#!/usr/bin/env node
/**
 * Card labels in the pf CLI: "PC 3" / "Mac 3" name one pane on one computer, a bare number
 * is this computer's own pane. Pure functions from `pf-ctl-lib.mjs`, no PaneForge needed.
 *
 *   node scripts/pf-label-test.mjs
 */
import { strict as assert } from 'node:assert'
import * as lib from './pf-ctl-lib.mjs'

let n = 0
function check(name, fn) {
  fn()
  n++
  console.log(`ok - ${name}`)
}

const { parseLabel, labelFor, rowLabel, paneByRef, MACHINE_NAME } = lib

// own panes 1 and 3 on the PC, a mirrored Mac pane that is also "3", and a Mac pane only listed
const rows = [
  { id: 's1-a', title: 'One', number: 1, machine: 'pc', label: 'PC 1' },
  { id: 's3-c', title: 'Three', number: 3, machine: 'pc', label: 'PC 3' },
  { id: '@mac/s3-m', title: 'Mac three', number: 3, remote: { device: 'mac', name: 'MacBook', machine: 'mac' }, label: 'Mac 3' },
  { id: '@mac/s5-m', title: 'Mac five', number: 5, machine: 'mac', listed: true, label: 'Mac 5' }
]

check('machine names and labelFor', () => {
  assert.deepEqual(MACHINE_NAME, { mac: 'Mac', pc: 'PC' })
  assert.equal(labelFor('pc', 3), 'PC 3')
  assert.equal(labelFor('mac', 12), 'Mac 12')
  assert.equal(labelFor(undefined, 3), null)
  assert.equal(labelFor('pc', 0), null)
  assert.equal(labelFor('pc', 1.5), null)
})

check('parseLabel', () => {
  assert.deepEqual(parseLabel('PC 3'), { machine: 'pc', number: 3 })
  assert.deepEqual(parseLabel('pc3'), { machine: 'pc', number: 3 })
  assert.deepEqual(parseLabel('PC-3'), { machine: 'pc', number: 3 })
  assert.deepEqual(parseLabel(' mac  12 '), { machine: 'mac', number: 12 })
  assert.deepEqual(parseLabel('3'), { machine: null, number: 3 })
  for (const bad of ['0', 'PC 0', 'PC', 'x3', '', 'PC 3 4']) assert.equal(parseLabel(bad), null, bad)
})

check('rowLabel uses the row label, else the card number', () => {
  assert.equal(rowLabel(rows, rows[2]), 'Mac 3')
  const old = [{ id: 'a' }, { id: 'b' }]
  assert.equal(rowLabel(old, old[1]), '2')
})

check('a bare number is this computer\'s own pane, even beside a "Mac 3"', () => {
  assert.equal(paneByRef(rows, '3', 'pc').id, 's3-c')
})

check('a label names the pane on that computer', () => {
  assert.equal(paneByRef(rows, 'Mac 3', 'pc').id, '@mac/s3-m')
  assert.equal(paneByRef(rows, 'pc3', 'pc').id, 's3-c')
  assert.equal(paneByRef(rows, 'PC-1', 'pc').id, 's1-a')
})

check('nothing matching is null; a listed-only pane comes back marked', () => {
  assert.equal(paneByRef(rows, 'PC 9', 'pc'), null)
  assert.equal(paneByRef(rows, '9', 'pc'), null)
  assert.equal(paneByRef(rows, 'Mac 5', 'pc').listed, true)
  assert.equal(paneByRef(rows, 'Mac 5', 'pc').id, '@mac/s5-m')
})

check('an id wins over a label shape', () => {
  assert.equal(paneByRef([{ id: '3', number: 1, machine: 'pc' }, ...rows], '3', 'pc').id, '3')
})

check('every row pf list prints has a column 1 other scripts can parse; numberless rows are left out', () => {
  const noNumber = { id: '@old/s9', title: 'Old', remote: { device: 'old', name: 'Old', machine: 'mac' }, label: 'Mac' }
  const unknown = { id: '@x/s1', title: 'X', listed: true, label: '?' }
  const printed = lib.listRows([...rows.slice(0, 3), noNumber], [rows[3], unknown])
  assert.deepEqual(printed.map(([l]) => l), ['PC 1', 'PC 3', 'Mac 3', 'Mac 5'])
  for (const [l] of printed) assert.match(l, /^(\d+|(PC|Mac) \d+)$/)
  const mirroredNoLabel = { id: '@old/s8', title: 'Old', remote: { device: 'old', name: 'Old', machine: 'mac' } }
  const listedNoNumber = { id: '@old/s7', title: 'Old', listed: true, machine: 'mac', label: null }
  assert.deepEqual(lib.listRows([rows[0], mirroredNoLabel], [listedNoNumber]).map(([l]) => l), ['PC 1'])
  const bareMirrored = { id: '@d/x', remote: { device: 'd', name: 'Mac', machine: 'mac' } }
  const listedNull = { id: '@d/y', listed: true, label: null }
  const zero = { id: 'z', number: 0, label: '0' }
  assert.deepEqual(lib.listRows([rows[0], bareMirrored, { ...bareMirrored, label: '2' }], [listedNull, { ...listedNull, label: 'Mac 0' }]).map(([l]) => l), ['PC 1'])
  assert.deepEqual(lib.listRows([zero]), [])
  const older = [{ id: 'a' }, { id: 'b' }]
  assert.deepEqual(lib.listRows(older).map(([l]) => l), ['1', '2'])
})

check('pf list status word says what a finished chat is still running', () => {
  const w = lib.listStatusWord
  assert.equal(w({ status: 'idle', subagent: 'builder: compile GuardDeck' }), 'idle, still running: builder: compile GuardDeck')
  assert.equal(w({ status: 'idle', backJob: 'npm run build' }), 'idle, still running: npm run build')
  assert.equal(w({ status: 'idle', subagent: 'agent words', backJob: 'job label' }), 'idle, still running: agent words')
  assert.equal(w({ status: 'idle' }), 'idle')
  assert.equal(w({ status: 'working', subagent: 'x' }), 'working')
  assert.equal(w({ status: 'starting', backJob: 'x' }), 'starting')
  assert.equal(w({ status: 'exited', backJob: 'x' }), 'exited')
  assert.equal(w({ status: 'idle', asleep: true, subagent: 'x' }), 'asleep')
  const long = w({ status: 'idle', subagent: 'a\tb\nc ' + 'z'.repeat(100) })
  assert.ok(!/[\t\n]/.test(long))
  assert.ok(long.length <= 'idle, still running: '.length + 60)
  assert.match(long, /^idle, still running: a b c z/)
  assert.ok(long.endsWith('…'))
  const exact = 'y'.repeat(60)
  assert.equal(w({ status: 'idle', backJob: exact }), `idle, still running: ${exact}`)
  assert.equal(w({ status: 'idle', backJob: `${'word '.repeat(12)}tail` }), `idle, still running: ${'word '.repeat(11)}word…`)
})

console.log(`\n${n} checks passed`)
