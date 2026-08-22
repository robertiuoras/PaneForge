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
// A focused window DOUBLES the wait; it does not veto for ever. The outright veto is what
// killed this feature on the desk it was built for: nobody is at the PC, so PaneForge is
// simply the last window Windows ever focused and `document.hasFocus()` stays true - the
// app never quit, never installed its staged update, and sat 41 versions behind.
const focusedShort = input({
  focused: true,
  lastAppInput: NOW - 20 * MIN,
  panes: [pane({ lastKeyboard: NOW - 20 * MIN })]
})
assert.equal(idleQuitVerdict(focusedShort).quit, false, 'a focused window past the plain limit still waits')
assert.match(idleQuitVerdict(focusedShort).reason, /focused/, 'and it says focus is why')
assert.equal(
  idleQuitVerdict(input({ focused: true })).quit,
  true,
  'but an hour of nothing at a focused window is nobody there, and it quits'
)
// The control: unfocused, the plain limit still decides. Doubling must not leak into it.
assert.equal(
  idleQuitVerdict(input({ lastAppInput: NOW - 20 * MIN, panes: [pane({ lastKeyboard: NOW - 20 * MIN })] })).quit,
  true,
  'unfocused, the configured limit is the whole of it'
)
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

// ...but a LIVE question is, and the pair above is what makes that check worth having: a
// chooser is drawn on a screen and lives in no transcript, so quitting loses the question
// itself. Both panes read `needsYou`; only the asking one may veto.
const asking = idleQuitVerdict(input({ panes: [pane({ state: 'needsYou', asking: true })] }))
assert.equal(asking.quit, false, 'a pane holding a question must veto the quit')
assert.match(asking.reason, /holding a question/)

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
