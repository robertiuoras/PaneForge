// What the sessions list is made of, without a window.
//
// The list draws two different things through one loop: panes on this desk, and panes on
// a paired machine that this one is NOT mirroring. The second half is the whole reason
// this file exists - it is the only place in the app where a row is drawn for something
// that has no session, no pty and no scrollback here, and every rule about which of those
// rows appears is a judgement that fails silently when it is wrong. A pane drawn twice
// looks like a duplicate; a pane not drawn at all looks like a machine doing nothing.
//
// The load-bearing half is the NEGATIVES: a device that is offline contributes nothing, a
// pane already being mirrored is not offered a second time, and a listed pane never
// carries a Ctrl+N number, because there is nothing here for that key to switch to.
//
// There is also a source assertion at the end, because the quiet way this breaks is a
// field being added to `FleetPane` and not forwarded through `RemotePaneInfo`: the types
// still agree (every added field is optional), the list still renders, and remote panes
// simply sort into the wrong section for ever.
//
//   node scripts/desk-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-desk-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'desk.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['scripts/_desk-entry.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { deskGroups, deskRows, fleetRow, fleetState } = createRequire(import.meta.url)(out)

let checks = 0
const is = (actual, expected, what) => {
  assert.deepEqual(actual, expected, what)
  checks++
}
const ok = (cond, what) => {
  assert.ok(cond, what)
  checks++
}

let n = 0
const sess = (over = {}) => ({
  id: `s${++n}`,
  title: 'pane',
  cwd: '/repo',
  agent: 'claude',
  status: 'idle',
  lastOutput: 1000,
  createdAt: 0,
  ...over
})
const pane = (over = {}) => ({
  id: `r${++n}`,
  title: 'remote pane',
  cwd: '/repo',
  agent: 'claude',
  status: 'idle',
  watched: false,
  ...over
})
const peer = (over = {}) => ({
  id: 'pc',
  name: 'Gamer-PC',
  address: '100.0.0.1',
  port: 7312,
  code: '',
  status: 'online',
  sessions: 0,
  panes: [],
  ...over
})

// ---------------------------------------------------------------------------
// This machine's panes

{
  const a = sess()
  const b = sess()
  const rows = deskRows([a, b], [a, b], [], 'all')
  is(rows.length, 2, 'both local panes are rows')
  is(
    rows.map((r) => r.number),
    [1, 2],
    'and each keeps the number Ctrl+N addresses'
  )
  ok(rows.every((r) => r.session && !r.listed), 'a local row carries its session')
}

{
  // The device filter is visual only, so the NUMBER still comes off the full list - a row
  // numbered by its position on screen would move the Ctrl key under somebody's finger.
  const a = sess()
  const b = sess()
  const c = sess()
  const rows = deskRows([a, b, c], [c], [], 'local')
  is(rows.map((r) => r.number), [3], 'a filtered list still numbers by the full one')
}

// ---------------------------------------------------------------------------
// The other machine's panes, listed rather than mirrored

{
  const local = sess()
  const p = peer({ panes: [pane(), pane()] })
  const rows = deskRows([local], [local], [p], 'all')
  is(rows.length, 3, "a connected device's panes are listed beside this desk's")
  const listed = rows.filter((r) => r.listed)
  is(listed.length, 2, 'both of them')
  is(
    listed.map((r) => r.number),
    [0, 0],
    'and neither has a pane number - there is nothing here for Ctrl+N to reach'
  )
  is(listed[0].listed.device.name, 'Gamer-PC', 'the row knows which machine it is on')
  ok(
    listed[0].key !== listed[1].key && listed[0].key.startsWith('pc:'),
    'the keys are namespaced by device, so two machines cannot collide'
  )
}

{
  // The one that would look like a duplicate rather than like a bug.
  const p = peer({ panes: [pane({ id: 'r-watched', watched: true }), pane()] })
  const rows = deskRows([], [], [p], 'all')
  is(rows.length, 1, 'a pane already being mirrored is not offered a second time')
  ok(!rows.some((r) => r.listed?.pane.id === 'r-watched'), 'and it is the mirrored one that is left out')
}

{
  // A device that is off is reporting a pane list from before it went. Drawing that as
  // live work is worse than drawing nothing.
  for (const status of ['off', 'connecting', 'error']) {
    const p = peer({ status, panes: [pane(), pane()] })
    is(deskRows([], [], [p], 'all').length, 0, `a device that is ${status} lists nothing`)
  }
  is(deskRows([], [], [peer({ panes: [pane()] })], 'all').length, 1, 'an online one does')
}

{
  const p = peer({ panes: [pane()] })
  const local = sess()
  is(deskRows([local], [local], [p], 'local').length, 1, "'This device' hides the other machine's panes")
  // `shown` arrives already filtered - the caller does that, because the pane NUMBER has
  // to come off the unfiltered list. So picking the device leaves only its own panes.
  is(deskRows([local], [], [p], 'pc').length, 1, 'and picking that device leaves only its panes')
  is(deskRows([local], [], [p], 'other').length, 0, 'a filter naming some third device lists nothing')
}

// ---------------------------------------------------------------------------
// A listed pane is ranked by the same rules as a local one

{
  const busy = sess({ status: 'working', runSince: 500 })
  const p = peer({ panes: [pane({ status: 'idle', engaged: true, lastOutput: 10 })] })
  const groups = deskGroups(deskRows([busy], [busy], [p], 'all'), true)
  is(groups[0].key, 'yourMove', 'a finished turn on the OTHER machine still sorts to the top')
  ok(groups[0].rows[0].listed, 'and it is the remote one')
  is(groups[1].key, 'running', 'this desk’s working pane is under it')
}

{
  // A question over there cannot be answered from the row, but it is the loudest reason
  // to open one, so it must rank exactly as a local question does.
  const p = peer({ panes: [pane({ status: 'working', runSince: 5, asking: true })] })
  const groups = deskGroups(deskRows([], [], [p], 'all'), true)
  is(groups[0].key, 'yourMove', 'a pane holding a question outranks the turn it is inside')
}

{
  const a = sess({ status: 'working', runSince: 1 })
  const b = sess({ status: 'idle', engaged: true, lastOutput: 2 })
  const rows = deskRows([a, b], [a, b], [], 'all')
  const arranged = deskGroups(rows, false)
  is(arranged.length, 1, 'the arranged view is one group')
  is(arranged[0].title, '', 'and draws no heading')
  is(
    arranged[0].rows.map((r) => r.key),
    [a.id, b.id],
    'in exactly the order it was given, whatever the panes are doing'
  )
  is(deskGroups(rows, true)[0].key, 'yourMove', 'the grouped view re-sorts the same rows')
}

{
  // The reported bug: `taskdriver.ai 2 - done 6:29 PM - 1 shell still running` sat under
  // `Your move`. Every reading the list had was about the agent's TURN, and the turn was
  // over; the background shell was drawn in a chip and ranked nothing.
  const s = sess({ status: 'idle', engaged: true, lastOutput: 10, backJob: 'npm', backJobSince: 5 })
  const groups = deskGroups(deskRows([s], [s], [], 'all'), true)
  is(groups[0].key, 'running', 'a finished turn with a background job is Running, not Your move')
  const row = fleetRow({ status: 'idle', engaged: true, lastOutput: 10, backJob: 'npm', backJobSince: 5 })
  is(row.label, 'running npm', 'and the row names it, exactly as a shell pane\u2019s job does')
  is(row.since, 5, 'the clock counts the JOB, never the silence since the last byte')
}

{
  // The refusal that keeps it honest: a live question is still the loudest thing on the
  // desk, whatever is running underneath it.
  const s = sess({ status: 'idle', ask: { question: 'q', options: [] }, backJob: 'npm' })
  is(fleetState({ status: 'idle', asking: true, backJob: 'npm' }), 'needsYou', 'a question outranks a background job')
  const groups = deskGroups(deskRows([s], [s], [], 'all'), true)
  is(groups[0].key, 'yourMove', 'and the row stays under Your move')
}

{
  // The control: the same pane with nothing running is exactly where it was.
  const s = sess({ status: 'idle', engaged: true, lastOutput: 10 })
  is(deskGroups(deskRows([s], [s], [], 'all'), true)[0].key, 'yourMove', 'a finished turn with no job is still Your move')
}

{
  // ...and a pane on the OTHER machine is ranked by it too, or the field would sort every
  // remote pane wrong in silence.
  const p = peer({ panes: [pane({ status: 'idle', engaged: true, lastOutput: 10, backJob: 'tail' })] })
  const groups = deskGroups(deskRows([], [], [p], 'all'), true)
  is(groups[0].key, 'running', 'a listed pane with a background job is Running as well')
}

// ---------------------------------------------------------------------------
// The silent one: a field that stops travelling

{
  const fleet = readFileSync(join(root, 'src/shared/fleet.ts'), 'utf8')
  const body = fleet.slice(fleet.indexOf('export interface FleetPane'))
  const fields = [...body.slice(0, body.indexOf('}')).matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1])
  ok(fields.length >= 6, 'FleetPane declares the fields a row is ranked by')

  const types = readFileSync(join(root, 'src/shared/types.ts'), 'utf8')
  const info = types.slice(types.indexOf('export interface RemotePaneInfo'))
  const infoBody = info.slice(0, info.indexOf('\n}'))
  const remote = readFileSync(join(root, 'src/main/remote/index.ts'), 'utf8')
  const map = remote.slice(remote.indexOf('panes: (client?.panes() ?? []).map'))
  const mapBody = map.slice(0, map.indexOf('})),'))

  for (const f of fields) {
    // `status` is already there for the pick list; the rest were added for this screen.
    ok(
      new RegExp(`\\b${f}\\??:`).test(infoBody),
      `RemotePaneInfo carries ${f}, or a remote pane cannot be ranked by it`
    )
    ok(
      new RegExp(`\\b${f}:`).test(mapBody),
      `the peer map forwards ${f} - dropping it sorts every remote pane wrong, silently`
    )
  }
}

console.log(`\n${checks} checks - all good`)
