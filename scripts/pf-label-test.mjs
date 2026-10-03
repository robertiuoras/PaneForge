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

// ------------------------------------------------- a command that changes a chat refuses a number
// 2026-10-03: `pf close 9` closed a chat that had become card 9 13 s earlier, and `pf type 13` typed
// into the wrong chat - a card number is a place on the desk, and places shift when a chat above
// closes. tell/type/close/close-when-done/move and --report-to now take only an id or a name.

check('a bare number is refused with what it names right now and the id form to run', () => {
  const pane = { id: 's12-abc123', title: 'Blender film', status: 'idle', createdAt: 0 }
  const why = lib.cardRefRefusal('3', pane, { redo: (id) => `pf tell ${id} "..."`, now: 10 * 60_000 })
  assert.equal(
    why,
    'refused: "3" is a card number, and card numbers shift when a chat above closes. Card 3 is s12-abc123 (Blender film) right now; run: pf tell s12-abc123 "..."'
  )
})

check('a machine label is refused the same way', () => {
  const pane = { id: '@pc/s7-x', title: 'Site', status: 'idle', createdAt: 0, remote: { machine: 'pc' } }
  const why = lib.cardRefRefusal('pc3', pane, { redo: (id) => `pf close ${id}`, now: 10 * 60_000 })
  assert.equal(
    why,
    'refused: "pc3" is a card label, and card numbers shift when a chat above closes. PC 3 is @pc/s7-x (Site) right now; run: pf close @pc/s7-x'
  )
})

check('a working or just-arrived pane says so; a number naming nothing lists the cards', () => {
  const now = 1_000_000
  const busy = { id: 's35-m', title: 'New', status: 'working', createdAt: now - 13_000 }
  assert.match(lib.cardRefRefusal('9', busy, { redo: (id) => `pf close ${id}`, now }), /right now - it is working and came onto the desk 13 s ago; run: pf close s35-m$/)
  const none = lib.cardRefRefusal('42', null, { cards: ['1', '2', '4'], redo: () => 'x', now })
  assert.equal(none, 'refused: "42" is a card number, and card numbers shift when a chat above closes. There is no card 42 right now (the cards are 1, 2, 4); run pf list and use the id in column 2.')
})

check('a pane only listed from another computer names the command to run THERE', () => {
  const listed = { id: '@mac/s5-m', title: 'Listed chat', status: 'idle', listed: true, machine: 'mac' }
  const why = lib.cardRefRefusal('Mac 5', listed, { redo: (id) => `pf tell ${id} "x"`, now: 0 })
  assert.match(why, /Mac 5 is @mac\/s5-m \(Listed chat\) right now - it runs on the Mac and is not open on this desk; open it here first, or on the Mac run: pf tell s5-m "x"$/)
})

check('an id, a name or a word that is not a number is never refused', () => {
  const pane = { id: 's3-x', title: 'Three', status: 'working', createdAt: 0 }
  for (const ref of ['s3-x', 'Three', '@pc/s3-x', 'PC', 'x3']) assert.equal(lib.cardRefRefusal(ref, pane, { redo: () => '', now: 0 }), null, ref)
})

check('redoLine puts the id where the number was, positional or --report-to, and shortens long words', () => {
  assert.equal(lib.redoLine(['tell', '3', 'commit', 'and', 'stop'], '3', 's12-a'), 'pf tell s12-a commit and stop')
  assert.equal(lib.redoLine(['tell', '3', 'When done, commit'], '3', 's12-a'), "pf tell s12-a 'When done, commit'")
  assert.equal(lib.redoLine(['tell', 'PC 3', 'x'.repeat(200)], 'PC 3', '@pc/s1'), 'pf tell @pc/s1 "..."')
  assert.equal(lib.redoLine(['open', '/x', '--report-to', '3', '--here'], '3', 's9-b'), 'pf open /x --report-to s9-b --here')
  assert.equal(lib.redoLine(['open', '/x', '--report-to=3'], '3', 's9-b'), 'pf open /x --report-to=s9-b')
  // the ref is replaced where it IS the pane, not where it happens to be a word of the text
  assert.equal(lib.redoLine(['close-when-done', 's1', '--report-to', '3'], '3', 's9-b', '--report-to'), 'pf close-when-done s1 --report-to s9-b')
  assert.equal(lib.redoLine(['tell', '3', '3'], '3', 's2-c'), 'pf tell s2-c 3')
})

check('clockDay is a 12-hour local clock with the day', () => {
  assert.equal(lib.clockDay(new Date(2026, 9, 2, 4, 10).getTime()), '4:10am Fri')
  assert.equal(lib.clockDay(new Date(2026, 9, 2, 16, 5).getTime()), '4:05pm Fri')
  assert.equal(lib.clockDay(new Date(2026, 9, 4, 0, 0).getTime()), '12:00am Sun')
  assert.equal(lib.clockDay(new Date(2026, 9, 4, 12, 30).getTime()), '12:30pm Sun')
})

check('owedSince keeps the oldest queued prompt per pane; junk is skipped', () => {
  const store = {
    a: { id: 's1-a', key: 'a', text: 'x', at: 300 },
    b: { id: 's1-a', key: 'b', text: 'y', at: 100 },
    c: { id: 's2-b', key: 'c', text: 'z', at: 50 },
    d: { id: 's3-c', key: 'd', text: 'w' },
    e: null
  }
  const since = lib.owedSince(store)
  assert.equal(since.get('s1-a'), 100)
  assert.equal(since.get('s2-b'), 50)
  assert.equal(since.has('s3-c'), false)
  assert.equal(lib.owedSince(null).size, 0)
})

check('the pf list note says a prompt is waiting, since when, or that it never went in', () => {
  const at = new Date(2026, 9, 2, 4, 10).getTime()
  assert.equal(lib.listNote({ id: 's1', owedPrompt: true }, new Map([['s1', at]])), 'prompt waiting since 4:10am Fri')
  assert.equal(lib.listNote({ id: 's1', owedPrompt: true }, new Map()), 'prompt waiting')
  assert.equal(lib.listNote({ id: 's1', promptUnsent: at }, new Map()), 'prompt not sent - still in its input box')
  assert.equal(
    lib.listNote({ id: 's1', promptUnsent: at, owedPrompt: true }, new Map([['s1', at]])),
    'prompt not sent - still in its input box; prompt waiting since 4:10am Fri'
  )
  assert.equal(lib.listNote({ id: 's1' }, new Map([['s1', at]])), '')
})

console.log(`\n${n} checks passed`)
