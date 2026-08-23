// npm run test:autoclear
//
// An automatic /clear ends a session. Every refusal in front of it is therefore worth a
// test, and none of them can be exercised by hand: two of the four need a countdown to be
// running while the desk changes underneath it.

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-autoclear-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const req = createRequire(import.meta.url)
function load(entry, name) {
  const outfile = join(work, `${name}.cjs`)
  buildSync({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile })
  return req(outfile)
}
const shared = load('src/shared/autoclear.ts', 'shared')
const { ClearCountdown } = load('src/main/autoclear.ts', 'main')
const { acceptClear, clearTick, clearChunks, cleanSteps, clampCountdown, MIN_COUNTDOWN_MS, MAX_COUNTDOWN_MS, CLEAR_COUNTDOWN_MS } = shared

const NOW = 1_000_000_000
const pane = (over = {}) => ({ id: 'p1', status: 'idle', lastKeyboard: NOW - 60_000, ...over })
const REQ = { paneId: 'p1', steps: ['fix the thing', 'ship it'], prompt: 'continue the handoff' }

// --- accepting an ask --------------------------------------------------------------------
assert.equal(acceptClear(REQ, undefined, NOW).ok, false)
assert.equal(acceptClear(REQ, undefined, NOW).reason, 'no such pane')
assert.equal(acceptClear(REQ, pane({ status: 'exited' }), NOW).reason, 'the pane has exited')
// The whole point of the feature: a clear that continues nothing just costs a fresh cache.
assert.equal(acceptClear({ ...REQ, steps: [] }, pane(), NOW).reason, 'nothing open to continue')
assert.equal(acceptClear({ ...REQ, steps: ['  ', ''] }, pane(), NOW).reason, 'nothing open to continue')
assert.equal(acceptClear({ ...REQ, prompt: '  ' }, pane(), NOW).reason, 'no resume prompt')
{
  const ok = acceptClear(REQ, pane(), NOW)
  assert.equal(ok.ok, true)
  assert.equal(ok.ask.dueAt, NOW + CLEAR_COUNTDOWN_MS)
  assert.equal(ok.ask.keyboardAt, NOW - 60_000)
  assert.deepEqual(ok.ask.steps, ['fix the thing', 'ship it'])
}
// Bullets and bold survive the handoff's markdown, not the card.
assert.deepEqual(cleanSteps(['- **Correct** the memory', '1. ship', '', null]), ['Correct the memory', 'ship'])
assert.equal(clampCountdown(0), MIN_COUNTDOWN_MS)
assert.equal(clampCountdown(99_999), MAX_COUNTDOWN_MS)
assert.equal(clampCountdown(undefined), CLEAR_COUNTDOWN_MS)
assert.equal(clampCountdown(30), 30_000)

// --- the tick, re-read every time ---------------------------------------------------------
const ask = acceptClear(REQ, pane(), NOW).ask
assert.deepEqual(clearTick(ask, pane(), NOW + 1_000), { act: 'wait', leftMs: CLEAR_COUNTDOWN_MS - 1_000 })
assert.deepEqual(clearTick(ask, pane(), ask.dueAt), { act: 'fire' })
assert.equal(clearTick(ask, undefined, NOW).reason, 'the pane closed')
assert.equal(clearTick(ask, pane({ status: 'exited' }), NOW).reason, 'the pane exited')
// He asked it something during the countdown - a queued /clear would land on that answer.
assert.equal(clearTick(ask, pane({ runSince: NOW + 500 }), NOW + 1_000).reason, 'the pane started another turn')
// Or he typed into it, which is the same fact one step earlier.
assert.equal(clearTick(ask, pane({ lastKeyboard: NOW + 1 }), NOW + 1_000).reason, 'you typed into it')

// --- the countdown in flight ----------------------------------------------------------------
function harness(panes) {
  const writes = []
  const broadcasts = []
  const timers = []
  let now = NOW
  const c = new ClearCountdown({
    panes: () => panes,
    write: (id, data) => writes.push([id, data]),
    changed: (p) => broadcasts.push(p.map((a) => a.paneId)),
    now: () => now,
    after: (fn, ms) => timers.push([ms, fn]),
    log: () => {}
  })
  return {
    c,
    writes,
    broadcasts,
    at: (ms) => (now = NOW + ms),
    drain: () => timers.splice(0).sort((a, b) => a[0] - b[0]).forEach(([, fn]) => fn())
  }
}

// It fires, and it types the three chunks in order - the RETURN on its own, because a long
// single write is read as a paste and the CR becomes a newline instead of a submit.
{
  const panes = [pane()]
  const h = harness(panes)
  assert.equal(h.c.request({ ...REQ, seconds: 30 }).ok, true)
  assert.deepEqual(h.broadcasts.at(-1), ['p1'])
  h.at(29_000)
  h.c.tick()
  assert.equal(h.writes.length, 0, 'not before the countdown runs out')
  h.at(30_000)
  h.c.tick()
  h.drain()
  assert.deepEqual(h.writes.map((w) => w[1]), clearChunks('continue the handoff'))
  assert.deepEqual(h.broadcasts.at(-1), [], 'the card goes when it fires')
  // ...and a tick after that does not type it a second time.
  h.at(31_000)
  h.c.tick()
  assert.equal(h.writes.length, 3)
}

// Cancel means cancel: no keystrokes, ever.
{
  const h = harness([pane()])
  h.c.request({ ...REQ, seconds: 30 })
  assert.equal(h.c.answer('p1', 'cancel'), true)
  assert.deepEqual(h.c.pending(), [])
  h.at(60_000)
  h.c.tick()
  h.drain()
  assert.equal(h.writes.length, 0)
  assert.equal(h.c.answer('p1', 'cancel'), false, 'answering a card that is gone is not an error')
}

// "Clear now" skips the rest of the wait.
{
  const h = harness([pane()])
  h.c.request({ ...REQ, seconds: 300 })
  h.c.answer('p1', 'now')
  h.drain()
  assert.deepEqual(h.writes.map((w) => w[1]), clearChunks('continue the handoff'))
}

// The desk changing underneath it drops the countdown, and says so on the broadcast.
{
  const panes = [pane()]
  const h = harness(panes)
  h.c.request({ ...REQ, seconds: 30 })
  panes[0] = pane({ runSince: NOW + 1_000 })
  h.at(2_000)
  h.c.tick()
  assert.deepEqual(h.c.pending(), [])
  h.at(60_000)
  h.c.tick()
  h.drain()
  assert.equal(h.writes.length, 0)
}

// A second ask for the same pane replaces the first: two cards would type two /clears.
{
  const h = harness([pane()])
  h.c.request({ ...REQ, seconds: 30 })
  h.c.request({ ...REQ, seconds: 60 })
  assert.equal(h.c.pending().length, 1)
  assert.equal(h.c.pending()[0].dueAt, NOW + 60_000)
}

// A refused ask never becomes a countdown.
{
  const h = harness([pane()])
  const out = h.c.request({ ...REQ, steps: [] })
  assert.equal(out.ok, false)
  assert.deepEqual(h.c.pending(), [])
}

console.log('autoclear: ok')
