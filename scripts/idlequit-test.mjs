// npm run test:idlequit
//
// The app quitting itself is the most destructive thing it does on a timer, so every
// refusal gets a test that fails if the refusal is dropped.

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-idlequit-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const outfile = join(work, 'idlequit.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/idlequit.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { idleQuitVerdict } = createRequire(import.meta.url)(outfile)

const NOW = 1_000_000_000
const MIN = 60_000
const pane = (over = {}) => ({ state: 'ready', lastKeyboard: NOW - 60 * MIN, remote: false, ...over })
const input = (over = {}) => ({
  panes: [pane()],
  minutes: 15,
  focused: false,
  lastAppInput: NOW - 60 * MIN,
  now: NOW,
  ...over
})

// Off by default: a build that starts quitting on people who never asked for it is worse
// than one that never quits at all.
assert.equal(idleQuitVerdict(input({ minutes: 0 })).quit, false, 'minutes 0 must be off')
assert.equal(idleQuitVerdict(input({ minutes: 0 })).reason, 'off')

// The happy path.
const yes = idleQuitVerdict(input())
assert.equal(yes.quit, true, 'an hour quiet at a 15 min setting must quit')
assert.match(yes.reason, /no input for 60 min/)

// Every refusal.
assert.equal(idleQuitVerdict(input({ focused: true })).quit, false, 'focused window must never quit')
assert.equal(idleQuitVerdict(input({ panes: [] })).quit, false, 'no panes must never quit')
for (const state of ['working', 'starting', 'stalled']) {
  const v = idleQuitVerdict(input({ panes: [pane({ state })] }))
  assert.equal(v.quit, false, `${state} pane must veto the quit`)
  assert.match(v.reason, new RegExp(state))
}
assert.equal(
  idleQuitVerdict(input({ panes: [pane({ remote: true })] })).quit,
  false,
  'a pane driven from another device must veto the quit'
)

// A finished pane waiting on Robert is NOT a refusal: that is exactly the desk he walks
// away from, and the session resumes from History when he comes back.
assert.equal(idleQuitVerdict(input({ panes: [pane({ state: 'needsYou' })] })).quit, true, 'needsYou must not veto')
assert.equal(idleQuitVerdict(input({ panes: [pane({ state: 'exited' })] })).quit, true, 'exited must not veto')

// The clock: one busy-with-input pane holds the whole app open.
assert.equal(
  idleQuitVerdict(input({ panes: [pane(), pane({ lastKeyboard: NOW - 2 * MIN })] })).quit,
  false,
  'recent typing in any pane holds the app open'
)
// ...and so does input that was not typed into a pane at all.
assert.equal(
  idleQuitVerdict(input({ lastAppInput: NOW - 2 * MIN })).quit,
  false,
  'recent app input (clicks, shelf, settings) holds the app open'
)

// Boundary: exactly at the limit quits, one millisecond under does not.
assert.equal(idleQuitVerdict(input({ lastAppInput: NOW - 15 * MIN, panes: [pane({ lastKeyboard: NOW - 15 * MIN })] })).quit, true)
assert.equal(
  idleQuitVerdict(input({ lastAppInput: NOW - 15 * MIN + 1, panes: [pane({ lastKeyboard: NOW - 15 * MIN + 1 })] })).quit,
  false
)

console.log('idlequit: ok')
