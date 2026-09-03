// One keystroke, one destination.
//
//   node scripts/login-keys-test.mjs
//
// Robert's report, 2026-09-03: with the remote login picture open, what he typed "went
// both in that remote screen and on local mac prompt". The view called `preventDefault`
// and nothing else, and `preventDefault` does not stop another LISTENER hearing the key -
// it only stops the browser's own default action. The pane's terminal is such a listener:
// xterm reads the key off its own hidden textarea and writes it to the pty itself
// (`TerminalPane.tsx`, `t.onData` -> `api.write`), so the password went to the login page
// AND to the agent.
//
// There is no browser here. The little DOM below is the whole point: it walks a real
// capture -> target -> bubble path and honours stopPropagation, so "did anything else
// hear it" is a countable number and not an opinion. The last block re-introduces the
// original bug in a second bundle and asserts the leak comes back, which is what makes a
// green run above mean something.

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-login-keys-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const bundle = (entry, outName) => {
  const outfile = join(work, outName)
  buildSync({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile })
  return createRequire(import.meta.url)(outfile)
}
const M = bundle('src/shared/remoteLogin.ts', 'remoteLogin.bundle.cjs')

let n = 0
const eq = (got, want, why) => {
  n++
  assert.deepEqual(got, want, why)
}
const ok = (cond, why) => {
  n++
  assert.ok(cond, why)
}

// ------------------------------------------------------------------ a very small DOM
/** A node in the path an event travels. `window` is the outermost. */
class El {
  constructor(name, parent) {
    this.name = name
    this.parent = parent ?? null
    this.on = []
  }
  addEventListener(type, fn, capture = false) {
    this.on.push({ type, fn, capture: Boolean(capture) })
  }
  removeEventListener(type, fn, capture = false) {
    this.on = this.on.filter((l) => !(l.type === type && l.fn === fn && l.capture === Boolean(capture)))
  }
}

const makeEvent = (type, key, mods = {}) => {
  const e = {
    type,
    key,
    code: key.length === 1 ? 'Key' + key.toUpperCase() : key,
    ctrlKey: Boolean(mods.ctrl),
    metaKey: Boolean(mods.meta),
    shiftKey: Boolean(mods.shift),
    altKey: Boolean(mods.alt),
    defaultPrevented: false,
    _stop: false,
    _stopNow: false,
    preventDefault() {
      this.defaultPrevented = true
    },
    stopPropagation() {
      this._stop = true
    },
    stopImmediatePropagation() {
      this._stop = true
      this._stopNow = true
    }
  }
  return e
}

/** capture from the outside in, then the target, then bubble back out. */
const dispatch = (target, e) => {
  const path = []
  for (let el = target; el; el = el.parent) path.unshift(el)
  const run = (el, capture) => {
    for (const l of [...el.on]) {
      if (l.type !== e.type || l.capture !== capture) continue
      l.fn(e)
      if (e._stopNow) return
    }
  }
  for (let i = 0; i < path.length - 1; i++) {
    run(path[i], true)
    if (e._stop) return e
  }
  run(target, true)
  if (!e._stop) run(target, false)
  if (e._stop) return e
  for (let i = path.length - 2; i >= 0; i--) {
    run(path[i], false)
    if (e._stop) return e
  }
  return e
}

/**
 * The desk as it really is while the picture is open: the login view listens on the
 * window in the capture phase, and the pane's terminal is still mounted underneath with
 * xterm's hidden textarea holding the caret.
 */
const desk = (keys) => {
  const win = new El('window')
  const doc = new El('document', win)
  const pane = new El('pane', doc)
  const helper = new El('xterm-helper-textarea', pane)
  const pty = []
  const composer = []
  // xterm does NOT consult defaultPrevented - it turns the key into bytes itself. That is
  // exactly why preventDefault alone never fixed this.
  helper.addEventListener('keydown', (e) => pty.push(e.key), false)
  // A plain text field, which preventDefault alone WOULD have been enough for.
  helper.addEventListener('keydown', (e) => {
    if (!e.defaultPrevented) composer.push(e.key)
  }, false)
  win.addEventListener('keydown', keys.down, true)
  win.addEventListener('keyup', keys.up, true)
  return { win, helper, pty, composer }
}

const rig = (make, clock = { t: 0 }) => {
  const sent = []
  const acts = []
  const keys = make(
    {
      send: (input) => sent.push(input),
      paste: () => acts.push('paste'),
      release: () => acts.push('release')
    },
    () => clock.t
  )
  return { ...desk(keys), sent, acts, clock }
}

// ------------------------------------------------- typing goes to ONE place, not two
{
  const r = rig(M.loginKeys)
  for (const ch of 'hunter2') dispatch(r.helper, makeEvent('keydown', ch))
  eq(r.sent.length, 7, 'every letter of the password reached the other computer')
  eq(r.pty, [], 'and NOT ONE of them reached the local pane - this is the whole bug')
  eq(r.composer, [], 'nor any other text field on this desk')
  eq(
    r.sent.map((s) => s.k.key).join(''),
    'hunter2',
    'in order, as keyDowns'
  )
}

// Enter is the one that submits the login form; it must not also be sent to the agent.
{
  const r = rig(M.loginKeys)
  dispatch(r.helper, makeEvent('keydown', 'Enter'))
  dispatch(r.helper, makeEvent('keyup', 'Enter'))
  eq(r.sent.map((s) => s.type), ['keyDown', 'keyUp'], 'both halves of the press travel')
  eq(r.pty, [], 'and the pane never sees Enter, which would have run whatever was typed there')
}

// ---------------------------------------------------- keys that stay on this machine
{
  const r = rig(M.loginKeys)
  dispatch(r.helper, makeEvent('keydown', 'w', { meta: true }))
  eq(r.sent, [], 'Cmd+W would close the remote tab, so it is never forwarded')
  eq(r.pty, ['w'], 'and it is deliberately left alone here, so this window still handles it')
}

// ------------------------------------------------------------- Escape twice gets out
{
  const clock = { t: 1000 }
  const r = rig(M.loginKeys, clock)
  dispatch(r.helper, makeEvent('keydown', 'Escape'))
  eq(r.acts, [], 'one Escape is a key the login page itself may want')
  eq(r.sent.length, 1, 'so it is forwarded')
  eq(r.pty, [], 'and it still does not reach the pane')
  clock.t = 1400
  dispatch(r.helper, makeEvent('keydown', 'Escape'))
  eq(r.acts, ['release'], 'the second one inside 700ms hands the keyboard back')
  eq(r.sent.length, 1, 'and is not also typed on the other computer')
  eq(r.pty, [], 'nor here')
}
{
  const clock = { t: 1000 }
  const r = rig(M.loginKeys, clock)
  dispatch(r.helper, makeEvent('keydown', 'Escape'))
  clock.t = 1000 + M.ESC_RELEASE_MS + 1
  dispatch(r.helper, makeEvent('keydown', 'Escape'))
  eq(r.acts, [], 'two Escapes a second apart are two Escapes, not a way out')
}

// ------------------------------------------------------------------ paste is one act
{
  const r = rig(M.loginKeys)
  dispatch(r.helper, makeEvent('keydown', 'v', { meta: true }))
  eq(r.acts, ['paste'], 'a password manager fill is one insert')
  eq(r.sent, [], 'not a keystroke per character')
  eq(r.pty, [], 'and Cmd+V does not paste into the pane at the same time')
}

// --------------------------------------------------------------------- the red proof
// The original code, rebuilt: preventDefault and no stopPropagation. If this still shows
// nothing in the pty, the harness above is not testing anything.
{
  const src = readFileSync(join(root, 'src/shared/remoteLogin.ts'), 'utf8')
  const before = `  const claim = (e: KeyEventLike): void => {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation?.()
  }`
  assert.ok(src.includes(before), 'the fix is spelled the way the red proof expects')
  const buggy = join(work, 'remoteLogin.buggy.ts')
  writeFileSync(
    buggy,
    src.replace(before, `  const claim = (e: KeyEventLike): void => {\n    e.preventDefault()\n  }`)
  )
  const B = bundle(buggy, 'remoteLogin.buggy.cjs')
  const r = rig(B.loginKeys)
  for (const ch of 'hunter2') dispatch(r.helper, makeEvent('keydown', ch))
  eq(r.sent.length, 7, 'the old code did reach the other computer')
  eq(r.pty, [...'hunter2'], 'AND typed the whole password into the local pane - the reported bug, reproduced')
  eq(r.composer, [], 'a plain text field was the half preventDefault did cover, which is why it looked fine in review')
}

// ------------------------------------------------------- the app's own shortcut list
// The half `stopImmediatePropagation` cannot reach. The app's shortcut list is on the
// WINDOW in the capture phase and is registered when the window opens, so it runs before
// the picture's listener and cannot be stopped by it.
//
// Proved in a real window on 2026-09-03 (a dev copy, driven over CDP, the picture holding
// the keyboard): the exact sequence below sent `hello` to the far machine and nothing at
// all to the pane, and then Cmd+F opened THIS app's Find box while the F went over there
// too. After the fix the same sequence leaves Find closed - `.find-input` absent - and
// still types `hello` on the other computer.
{
  const seq = [
    { key: 'h', code: 'KeyH' },
    { key: 'e', code: 'KeyE' },
    { key: 'l', code: 'KeyL' },
    { key: 'l', code: 'KeyL' },
    { key: 'o', code: 'KeyO' },
    { key: 'f', code: 'KeyF', meta: true }
  ]
  for (const k of seq) eq(M.chordAllowed(true, k), false, `${k.meta ? 'Cmd+' : ''}${k.key} belongs to the picture while it has the keyboard`)
  for (const k of seq) eq(M.chordAllowed(false, k), true, `${k.meta ? 'Cmd+' : ''}${k.key} is this desk's own again once the picture does not have it`)
  // The keys the far machine is never sent are the ones this desk still owns - the same
  // line `forwarded` draws, so a shortcut cannot go missing on both computers at once.
  eq(M.chordAllowed(true, { key: 'w', code: 'KeyW', meta: true }), true, 'Cmd+W stays this window\'s, because it is never sent over')
  eq(M.chordAllowed(true, { key: 'q', code: 'KeyQ', meta: true }), true, 'so does Cmd+Q')

  const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
  ok(/chordAllowed\(/.test(app), "the app's shortcut list asks before it acts")
  ok(/login-screen\.typing/.test(app), 'and asks about the picture that has the keyboard')
}

console.log(`login keys: ${n} checks pass - one keystroke, one destination`)
