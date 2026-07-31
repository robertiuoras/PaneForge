// The composer interaction, in a real window.
//
// The headless tests prove the pipeline. They cannot prove the part the brief is most
// specific about: that the chip appears only when a draft has gone quiet, that typing
// cancels an improvement in flight, that Escape hands the keyboard back, that Accept
// pastes into the pty without submitting, and that Reject writes nothing at all.
//
// None of that is answerable from the DOM alone either. The draft is reconstructed from
// keystrokes, so the only honest way to drive it is to write real keystrokes through the
// same path a person's typing takes - `window.api.write` - and then read the pane's own
// draft back out of `paneDraft`.
//
// Needs a test copy up, which is never the app hosting this session:
//   npm run build && npm run try -- --keep --show --remote-debugging-port=9333
//   node scripts/prompt-view-test.mjs
//   npm run try -- --close
//
// The port is per checkout; a second lane uses PF_PORT=9334 and the matching flag.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = process.env.PF_PORT ?? '9333'

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && !(t.url ?? '').includes('shelf')
      )
      if (page) return page
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`no debuggable window on port ${port}. Start one with:
  npm run build && npm run try -- --keep --show --remote-debugging-port=${port}`)
}

const page = await findPage()
const ws = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
let seq = 0
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
})
const send = (method, params) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((res, rej) => pending.set(id, { res, rej }))
}
await new Promise((res) => ws.addEventListener('open', res, { once: true }))

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails))
  return r.result.value
}

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail !== undefined) console.log(`      ${detail}`)
  }
}

// --------------------------------------------------------------- a desk to measure

const dir = mkdtempSync(join(tmpdir(), 'pf-improve-view-')).replace(/\\/g, '/')

const id = await evaluate(`(async () => {
  for (const s of [...document.querySelectorAll('.pane[data-id]')].map((p) => p.dataset.id))
    await window.api.killSession(s)
  await new Promise((r) => setTimeout(r, 400))
  await window.api.setConfig({ grid: false })
  const s = await window.api.startSession({ cwd: ${JSON.stringify(dir)}, agent: 'shell' })
  await new Promise((r) => setTimeout(r, 2000))
  return s.id
})()`)
ok('a pane opened to type into', Boolean(id), id)

/**
 * Type into the pane the way a person does.
 *
 * Through `api.write`, which is what xterm's onData calls - so the draft is rebuilt by
 * exactly the code path a real keystroke takes. Writing to the pty directly would prove
 * nothing about the reconstruction.
 *
 * The renderer's own `onData` is what feeds `paneDraft`, and it only fires for input the
 * terminal itself received, so this drives xterm's input handler rather than `api.write`.
 */
const type = (text) => `(async () => {
  const t = window.__pf[${JSON.stringify(id)}].term
  for (const ch of ${JSON.stringify(text)}) {
    t._core.coreService.triggerDataEvent(ch, true)
    await new Promise((r) => setTimeout(r, 2))
  }
})()`

const draftOf = `(() => {
  const d = window.__pf && window.__pf.draft ? window.__pf.draft(${JSON.stringify(id)}) : null
  return d ? { text: d.text, certain: d.certain } : null
})()`

// --------------------------------------------------------------- the setting gate

await evaluate(`(async () => {
  const c = await window.api.getConfig()
  await window.api.setConfig({ promptImprove: { ...c.promptImprove, mode: 'off' } })
})()`)
await new Promise((r) => setTimeout(r, 300))

await evaluate(type('the signup form rejects a valid password on mobile, please look at it?'))
await new Promise((r) => setTimeout(r, 2200))

ok(
  'with the setting OFF no chip ever appears',
  (await evaluate(`document.querySelectorAll('.improve-chip-offer').length`)) === 0
)
ok(
  'and the shortcut says so rather than spending anything',
  await evaluate(`(async () => {
    const r = await window.api.improvePrompt(${JSON.stringify(id)}, 'a real looking draft prompt about the signup page')
    return r.ok === false && /off/i.test(r.error ?? '')
  })()`)
)

// --------------------------------------------------------------- the draft itself

const d1 = await evaluate(draftOf)
ok('the pane reconstructed what was typed', d1 && d1.text.includes('signup form rejects'), JSON.stringify(d1))
ok('and is sure of it', d1 && d1.certain === true)

await evaluate(`(() => { const t = window.__pf[${JSON.stringify(id)}].term; t._core.coreService.triggerDataEvent('\\x1b[A', true) })()`)
await new Promise((r) => setTimeout(r, 150))
ok(
  'an arrow key makes the draft uncertain, so Accept will not wipe over it',
  (await evaluate(draftOf))?.certain === false
)

// Ctrl-U clears the line, in the pane and in the shadow.
await evaluate(`(() => { const t = window.__pf[${JSON.stringify(id)}].term; t._core.coreService.triggerDataEvent('\\x15', true) })()`)
await new Promise((r) => setTimeout(r, 150))
ok('Ctrl-U clears the shadow too', (await evaluate(draftOf))?.text === '')

// --------------------------------------------------------------- suggest mode

await evaluate(`(async () => {
  const c = await window.api.getConfig()
  await window.api.setConfig({ promptImprove: { ...c.promptImprove, mode: 'suggest', idleMs: 600 } })
})()`)
await new Promise((r) => setTimeout(r, 400))

ok(
  'a half-typed draft is NOT offered',
  await evaluate(`(async () => {
    const t = window.__pf[${JSON.stringify(id)}].term
    for (const ch of 'the signup page needs a hero and') t._core.coreService.triggerDataEvent(ch, true)
    await new Promise((r) => setTimeout(r, 1400))
    return document.querySelectorAll('.improve-chip-offer').length === 0
  })()`),
  'it ends on "and" - the sentence is going somewhere'
)

// Polled, not slept, and the wait is generous on purpose. Measured on this machine: a
// pane keeps reading `status: 'working'` for about 3.5 seconds after the last keystroke,
// because the shell echoing and redrawing its own prompt line is output like any other.
// The chip cannot appear before that settles, and waiting a fixed 1.4s asserted only that
// the pane was still echoing.
const chipMs = await evaluate(`(async () => {
  const t = window.__pf[${JSON.stringify(id)}].term
  for (const ch of ' a signup form for accountants?') t._core.coreService.triggerDataEvent(ch, true)
  const t0 = Date.now()
  for (let i = 0; i < 40; i++) {
    if (document.querySelectorAll('.improve-chip-offer').length === 1) return Date.now() - t0
    await new Promise((r) => setTimeout(r, 250))
  }
  return -1
})()`)
ok('a finished draft IS offered, once it has gone quiet', chipMs >= 0, `waited ${chipMs}ms`)
console.log(`      chip appeared ${chipMs}ms after the last keystroke`)

ok(
  'and the offer is withdrawn the moment a key lands',
  await evaluate(`(async () => {
    const t = window.__pf[${JSON.stringify(id)}].term
    t._core.coreService.triggerDataEvent('x', true)
    await new Promise((r) => setTimeout(r, 120))
    return document.querySelectorAll('.improve-chip-offer').length === 0
  })()`)
)

// --------------------------------------------------------------- the sheet

ok(
  'the shortcut opens the sheet',
  await evaluate(`(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'I', ctrlKey: true, metaKey: ${process.platform === 'darwin'}, shiftKey: true, bubbles: true }))
    await new Promise((r) => setTimeout(r, 250))
    return document.querySelectorAll('.improve-sheet').length === 1
  })()`)
)

ok(
  'it shows the captured draft before anything is replaced',
  await evaluate(`(() => {
    const el = document.querySelector('.improve-original')
    return Boolean(el && el.textContent.includes('signup form for accountants'))
  })()`),
  'a wrong shadow has to be visible before it is destructive'
)

ok(
  'TYPING WHILE IT WORKS CANCELS IT, silently',
  await evaluate(`(async () => {
    const t = window.__pf[${JSON.stringify(id)}].term
    t._core.coreService.triggerDataEvent('z', true)
    await new Promise((r) => setTimeout(r, 300))
    return document.querySelectorAll('.improve-sheet').length === 0
  })()`)
)

// --------------------------------------------------------------- accept and reject

/**
 * Watch every byte the RENDERER sends to the pty.
 *
 * Accept is deliberately not one of them: `applyImproved` runs in the main process and
 * writes through the session manager, so the wipe key and the bracketed paste are built
 * and sent where they can be enforced in one place rather than by whoever calls the
 * bridge. `prompt-insert-test.mjs` asserts on that byte stream directly; what this spy is
 * for is the opposite claim - that **Reject** sends nothing at all.
 */
const spyOn = `(() => {
  window.__pfWrites = []
  if (!window.__pfRealWrite) window.__pfRealWrite = window.api.write
  window.api.write = (id, data) => { window.__pfWrites.push([id, data]); return window.__pfRealWrite(id, data) }
  return true
})()`

// Whichever phase the sheet is in - still working, waiting for an answer, or showing a
// suggestion - dismissing it must write nothing and must close it. The improver spawns a
// real CLI, so which phase this lands in depends on how fast that machine is; asserting
// on one of them would make this test a race.
ok(
  'DISMISSING WRITES NOTHING AT ALL, and closes the sheet',
  await evaluate(`(async () => {
    ${spyOn}
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'I', ctrlKey: true, metaKey: ${process.platform === 'darwin'}, shiftKey: true, bubbles: true }))
    await new Promise((r) => setTimeout(r, 600))
    const opened = document.querySelectorAll('.improve-sheet').length
    const before = window.__pfWrites.length
    const dismiss = [...document.querySelectorAll('.improve-btn')].find((b) => /Reject|Close|Cancel/.test(b.textContent))
    dismiss?.click()
    await new Promise((r) => setTimeout(r, 400))
    return opened === 1 && window.__pfWrites.length === before &&
      document.querySelectorAll('.improve-sheet').length === 0
  })()`)
)

ok(
  'Escape closes the sheet and hands the keyboard back',
  await evaluate(`(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'I', ctrlKey: true, metaKey: ${process.platform === 'darwin'}, shiftKey: true, bubbles: true }))
    await new Promise((r) => setTimeout(r, 400))
    const had = document.querySelectorAll('.improve-sheet').length
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise((r) => setTimeout(r, 250))
    return had >= 1 && document.querySelectorAll('.improve-sheet').length === 0
  })()`)
)

// Accept, end to end, read where the bytes actually land.
//
// The wipe key and the bracketed paste are written by the MAIN process, so a spy on the
// renderer's bridge sees nothing - which is how it should be: the byte stream is built in
// one place and `prompt-insert-test.mjs` asserts on it there. What only a real window can
// answer is whether it arrived, and whether it SUBMITTED. A shell pane echoes its line, so
// the prompt row is the evidence, and the cursor not having moved to a new row is the
// proof that no Enter was sent.
const inserted = await evaluate(`(async () => {
  const t = window.__pf[${JSON.stringify(id)}].term
  const b0 = t.buffer.active
  const rowBefore = b0.baseY + b0.cursorY
  const r = await window.api.applyImproved(${JSON.stringify(id)}, 'Fix the signup form: it rejects a valid password below 640px.')
  await new Promise((x) => setTimeout(x, 900))
  const b = t.buffer.active
  return {
    ok: r.ok,
    error: r.error,
    rowsMoved: (b.baseY + b.cursorY) - rowBefore,
    line: b.getLine(b.baseY + b.cursorY)?.translateToString(true).trimEnd() ?? ''
  }
})()`)

ok('Accept puts the improved text in the prompt box', inserted.ok === true && inserted.line.includes('rejects a valid password below 640px'), JSON.stringify(inserted))
ok(
  'AND DOES NOT SUBMIT IT - the text is sitting ON the prompt row, unsent',
  // Measured: the wipe key moves the cursor UP by a row on a PowerShell pane, because
  // Escape clears the line the shell had drawn and it redraws shorter. A submit is the
  // opposite - it would move DOWN to a fresh prompt and leave the typed line behind as
  // history. So "not submitted" is rowsMoved <= 0 AND the text still on the prompt line,
  // which the check above already established.
  inserted.rowsMoved <= 0 && /PS .*>.*rejects a valid password/.test(inserted.line),
  JSON.stringify(inserted)
)
// A refused suggestion writes nothing, through the real IPC path.
const refused = await evaluate(`(async () => {
  ${spyOn}
  const r = await window.api.applyImproved(${JSON.stringify(id)}, '/clear everything and start again')
  await new Promise((r2) => setTimeout(r2, 300))
  return { ok: r.ok, writes: window.__pfWrites.length }
})()`)
ok(
  'a suggestion starting with a slash is refused and writes NOTHING',
  refused.ok === false && refused.writes === 0,
  JSON.stringify(refused)
)

// ------------------------------------------------- a suggestion actually arrives
//
// The one claim every other assertion here assumed and none of them made: that a click on
// the offer ends in a suggestion on this machine, inside the deadline.
//
// It shipped for a week unable to do that. `DEADLINE_MS` was 20 s and one real run of the
// improver measured 22,540 ms, so every attempt was killed and reported as "produced no
// answer (cancelled, or timed out)" - which reads as the feature being broken. Nothing
// caught it because the sheet tests deliberately do not assert which phase they land in,
// calling that a race, and the model-free suite never spawns anything.
//
// So this one waits for the phase rather than sampling it, and prints the number. A
// machine or a CLI that gets slower shows up here as a rising figure long before it shows
// up as a deadline that is too short again.
const arrived = await evaluate(`(async () => {
  const t0 = Date.now()
  const r = await window.api.improvePrompt(
    ${JSON.stringify(id)},
    'the signup form rejects a valid password on mobile, please look at it'
  )
  return {
    ms: Date.now() - t0,
    ok: r.ok,
    error: r.error,
    improved: (r.improvement && r.improvement.improved) || '',
    engine: r.metrics && r.metrics.engine
  }
})()`)
ok(
  'AN IMPROVEMENT ACTUALLY COMES BACK, inside the deadline',
  arrived.ok === true && arrived.improved.length > 20,
  JSON.stringify({ ...arrived, improved: arrived.improved.slice(0, 80) })
)
console.log(`      ${arrived.engine} answered in ${arrived.ms}ms (deadline 90000ms)`)

// --------------------------------------------------------------- put it back

await evaluate(`(async () => {
  if (window.__pfRealWrite) window.api.write = window.__pfRealWrite
  const c = await window.api.getConfig()
  await window.api.setConfig({ promptImprove: { ...c.promptImprove, mode: 'off', idleMs: 1200 } })
  await window.api.killSession(${JSON.stringify(id)})
})()`)

ws.close()
console.log(failed ? `\n${failed} failing` : '\nall good')
process.exit(failed ? 1 : 0)
