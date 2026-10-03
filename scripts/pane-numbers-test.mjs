// A card's number belongs to the machine the pane runs on and never moves while the pane
// lives (`src/shared/paneLabel.ts`). It used to be the pane's place in the desk list, so
// closing or dragging one renumbered the rest, and a paired desk counted the other
// machine's panes into the same sequence: one chat was "3" on the Mac and "7" on the PC.
//
//   node scripts/pane-numbers-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-pane-numbers-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'pane-numbers.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['scripts/_pane-numbers-entry.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { HOLD_MS, MACHINE_NAME, PaneNumbers, cardLabel, labelFor, machineOf, othersOnDesk, parseLabel, switchKey } =
  createRequire(import.meta.url)(out)

let checks = 0
const is = (actual, expected, what) => {
  assert.deepEqual(actual, expected, what)
  checks++
}

// ---------------------------------------------------------------------------
// The allocator

{
  let now = 0
  const n = new PaneNumbers(() => now)
  is(HOLD_MS, 15 * 60 * 1000, 'a freed number rests fifteen minutes')
  is(['a', 'b', 'c'].map((id) => n.take(id)), [1, 2, 3], 'each new pane takes the lowest free number')
  is(n.take('b'), 2, 'asking again for a pane that holds a number is the same number')
  n.release('b')
  is([n.numberOf('a'), n.numberOf('b'), n.numberOf('c')], [1, undefined, 3], 'closing pane 2 leaves 1 and 3 as they were')
  now += HOLD_MS - 1
  is(n.take('d'), 4, 'a new pane inside fifteen minutes gets 4, not the 2 that just closed')
  now += 1
  is(n.take('e'), 2, 'and after fifteen minutes 2 is free again')
}

{
  let now = 0
  const n = new PaneNumbers(() => now)
  n.take('a')
  n.take('b')
  n.release('b')
  is(n.take('b2', 2), 2, 'the same pane coming back asks for its number and gets it, resting or not')
  is(n.take('x', 1), 3, 'a number a live pane holds is refused, and the lowest free one is given instead')
  is(n.take('y', 0), 4, 'a wish that is not a positive integer is ignored')
  is(n.take('z', 12), 12, 'there is no ceiling - a wish for 12 is honoured')
}

{
  // Desk restore after an app restart: a fresh allocator, each pane asking for the number
  // the snapshot saved.
  const before = new PaneNumbers(() => 0)
  const saved = ['p', 'q', 'r'].map((id) => ({ id, number: before.take(id) }))
  before.release('p')
  const kept = saved.filter((s) => s.id !== 'p')
  const after = new PaneNumbers(() => 0)
  is(kept.map((s) => after.take(`new-${s.id}`, s.number)), [2, 3], 'a restored desk gives each pane its number back')
  is(after.take('fresh'), 1, 'and a new pane fills the gap below them')
}

{
  // The desk file is read before anybody answers the restore offer, and a pane can open in
  // between. Without the hold it takes 1, saved 1 comes back as 2, saved 2 as 3...
  const n = new PaneNumbers(() => 0)
  n.reserve(1)
  n.reserve(2)
  is(n.take('opened-first'), 3, 'a pane opened before the restore skips the saved numbers')
  is([n.take('saved-1', 1), n.take('saved-2', 2)], [1, 2], 'and the restored panes still get theirs')
}

{
  let now = 0
  const n = new PaneNumbers(() => now)
  n.take('a')
  n.take('b')
  n.prune(['a'])
  is(n.numberOf('b'), undefined, 'prune releases a pane nobody closed through the front door')
  is(n.numberOf('a'), 1, 'and keeps the live one')
  is(n.take('c'), 3, 'what prune released rests like any freed number')
}

// ---------------------------------------------------------------------------
// Words

is(MACHINE_NAME, { mac: 'Mac', pc: 'PC' }, 'the short machine names')
is([machineOf('win32'), machineOf('darwin'), machineOf('linux')], ['pc', 'mac', 'mac'], 'which machine a platform is')
is([labelFor('pc', 3), labelFor('mac', 12)], ['PC 3', 'Mac 12'], 'a label is the machine then the number')
is([labelFor(undefined, 3), labelFor('pc', 0), labelFor('pc', 1.5), labelFor('pc', undefined)], [null, null, null, null], 'and nothing without both')

for (const [ref, want] of [
  ['PC 3', { machine: 'pc', number: 3 }],
  ['pc3', { machine: 'pc', number: 3 }],
  ['PC-3', { machine: 'pc', number: 3 }],
  [' mac  12 ', { machine: 'mac', number: 12 }],
  ['3', { machine: null, number: 3 }],
  ['0', null],
  ['PC', null],
  ['Mac', null],
  ['x3', null],
  ['', null],
  [undefined, null]
]) is(parseLabel(ref), want, `parseLabel(${JSON.stringify(ref)})`)

// ---------------------------------------------------------------------------
// What a card shows

{
  const desk = { machine: 'pc', others: true }
  is(cardLabel({ number: 3 }, desk), 'PC 3', "this desk's pane, with another computer's panes here")
  is(cardLabel({ number: 3 }, { machine: 'pc', others: false }), '3', 'and the bare number when there are none')
  is(cardLabel({ number: 3, remote: { machine: 'mac' } }, desk), 'Mac 3', "a mirrored pane wears its owner's label")
  is(cardLabel({ number: 3, remote: { machine: 'mac' } }, { machine: 'pc', others: false }), 'Mac 3', 'always with the machine name')
  is(cardLabel({ remote: { machine: 'mac' } }, desk), 'Mac', 'an older owner that sent no number: the machine name alone')
  is(cardLabel({ number: 3, remote: {} }, desk), null, 'a mirror whose machine is not known yet draws nothing')
  is(cardLabel({}, desk), null, 'a pane with no number draws nothing')
}

{
  const online = (panes) => ({ status: 'online', panes })
  is(othersOnDesk([{}], []), false, 'just this desk: nobody else here')
  is(othersOnDesk([{}, { remote: { device: 'm', name: 'Mac' } }], []), true, 'a mirrored pane is another computer on the desk')
  is(othersOnDesk([{}], [online([{ watched: false }])]), true, 'so is a listed one')
  is(othersOnDesk([{}], [online([{ watched: true }])]), false, 'a watched pane counts only through its mirror')
  is(othersOnDesk([{}], [{ status: 'off', panes: [{ watched: false }] }]), false, 'an offline device lists nothing')
}

is([switchKey({ number: 3 }), switchKey({ number: 10 }), switchKey({ number: 3, remote: { device: 'm', name: 'Mac' } }), switchKey({})], [3, null, null, null], 'Ctrl+N belongs to this desk’s own panes 1-9')

console.log(`\n${checks} checks - all good`)
