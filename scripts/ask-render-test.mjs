// A pane's question, drawn and paid for.
//
// Two promises this cannot check without a real window, and both were broken before it
// existed:
//
//  1. Arrowing through an agent's answers may not cost the whole desk a render. The
//     sessions list is one array for every pane, rebuilt in main on every frame of a
//     question, so before `memo` in TerminalPane.tsx five arrow moves cost **34 renders
//     of every pane on the desk** - four of which had no question on them at all. A
//     render re-measures the prompt rail against the live xterm
//     buffer, which is why that was felt as lag rather than seen as a number.
//     The load-bearing assertion is the BYSTANDER's count, not the question pane's: a
//     memo that skipped the pane holding the question would pass a "renders went down"
//     check and break the feature outright.
//
//  2. The countdown says what is about to happen, in time to disagree with it. It has to
//     be on screen with a real size, and it has to NAME the option - and that option has
//     to be findable on the row of buttons, which is the `.auto` mark.
//
// Needs a window:
//   npm run build && npm run try -- --keep --remote-debugging-port=9334
//   PF_PORT=9334 node scripts/ask-render-test.mjs
// It skips out loud when there is none, the same as the other window tests.

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const PORT = process.env.PF_PORT || '9333'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let page
for (let i = 0; i < 20; i++) {
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    .then((r) => r.json())
    .catch(() => [])
  page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !(t.url ?? '').includes('shelf'))
  if (page) break
  await new Promise((r) => setTimeout(r, 500))
}
if (!page) {
  console.log(`SKIP: no debuggable window on port ${PORT}.`)
  console.log('  npm run build && npm run try -- --keep --remote-debugging-port=9334')
  console.log('  PF_PORT=9334 node scripts/ask-render-test.mjs')
  process.exit(0)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const pending = new Map()
let seq = 0
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
})
const send = (method, params) =>
  new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, { res, rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
const evalIn = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let bad = 0
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ' - ' + detail : ''}`)
  if (!ok) bad++
}

// A clean desk first: this is the DEV copy's own profile, and a pane left over from an
// earlier run holds a question of its own - whose card is then the first `.pane-ask` in
// the document, in a pane that is not on screen. Measuring that one reported the
// countdown as 0x0 while the real one was drawn perfectly.
// Two shell panes. The second one is the point: it has no question and must not render.
const ids = await evalIn(`(async () => {
  for (const s of await window.api.listSessions()) await window.api.killSession(s.id)
  const out = []
  for (const n of [1, 2]) {
    const s = await window.api.startSession({ cwd: ${JSON.stringify(ROOT)}, agent: 'shell', name: 'askrender-' + n })
    out.push(typeof s === 'string' ? s : s.id)
  }
  return out
})()`)
await wait(2500)

await evalIn(`(async () => {
  const c = await window.api.getConfig()
  await window.api.setConfig({
    ...c,
    // The tick is a sound about a pane, so it is under the same switch as the rest of them
    // and a dev profile with alerts off would report a working countdown as silent.
    soundOnIdle: true,
    sounds: { ...(c.sounds || {}), volume: Math.max(0.2, (c.sounds || {}).volume ?? 1) },
    // \`holdWhileWatching\` off, deliberately: this test is about the countdown being DRAWN,
    // and the hold's whole job is to draw no countdown while this window has the keyboard.
    // Left on, the test would pass or fail on whether the probe's window happened to be
    // focused, which is a coin toss and not the thing under test.
    autoAnswer: {
      ...(c.autoAnswer || {}),
      enabled: true,
      waitMs: 20000,
      holdWhileWatching: false,
      anyQuestion: false,
      maxRun: 5
    }
  })
})()`)

// A chooser the real reader accepts: the CLI's own footer, numbered options, one arrow.
// One option leads with a yes-shaped word, so autoAnswer has something to pick and the
// countdown has something to name.
const frameFor = (sel) =>
  [
    'Do you want to proceed?',
    `${sel === 1 ? '❯' : ' '} 1. Yes, run it`,
    `${sel === 2 ? '❯' : ' '} 2. No, stop and tell me`,
    'Enter to select · ↑/↓ to navigate · Esc to cancel'
  ].join('\n')

const feed = async (sel) => {
  const b64 = Buffer.from(frameFor(sel) + '\n', 'utf8').toString('base64')
  await evalIn(`window.api.write(${JSON.stringify(ids[0])}, ${JSON.stringify(`clear; echo ${b64} | base64 -d\r`)})`)
}

await feed(1)
await wait(3000)

const ask = await evalIn(`(async () => {
  const l = await window.api.listSessions()
  const s = l.find((x) => x.id === ${JSON.stringify(ids[0])})
  return s && s.ask ? { selected: s.ask.selected, n: s.ask.options.length } : null
})()`)
check(Boolean(ask) && ask.n === 2, 'the frame reads as a live question', JSON.stringify(ask))

// Scoped to THIS pane's own subtree: see the note above about a stale pane's card.
const drawn = await evalIn(`(() => {
  const pane = window.__pf[${JSON.stringify(ids[0])}].host.parentElement
  const auto = pane.querySelector('.pane-ask-auto')
  const r = auto && auto.getBoundingClientRect()
  const btns = [...pane.querySelectorAll('.pane-ask-btn')].map((b) => ({
    text: b.textContent,
    auto: b.classList.contains('auto')
  }))
  return { text: auto ? auto.textContent : null, w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0, btns }
})()`)
check(drawn.w > 100 && drawn.h >= 20, 'the countdown is on screen with a real size', `${drawn.w}x${drawn.h}`)
check(/\d+s/.test(drawn.text ?? ''), 'it counts in seconds', drawn.text ?? 'nothing drawn')
check((drawn.text ?? '').includes('Yes, run it'), 'it names the option it will press')
const marked = drawn.btns.filter((b) => b.auto)
check(marked.length === 1 && marked[0].text.includes('Yes, run it'), 'that option is the marked one on the row', JSON.stringify(marked))

// WHERE it is drawn, which is the other half of "I want to see the countdown on the
// terminal". The card used to lie across the bottom of the pane - which is where a CLI
// draws its chooser - so the thing being answered was underneath the thing answering it,
// and the card repeated the question, clamped to two lines, to make up for covering it.
// Docked right: the CLI's own question stays readable beside it, and the copy is gone.
const dock = await evalIn(`(() => {
  const pane = window.__pf[${JSON.stringify(ids[0])}].host.parentElement
  const card = pane.querySelector('.pane-ask')
  if (!card) return null
  const r = card.getBoundingClientRect()
  const h = pane.getBoundingClientRect()
  return {
    rightGap: Math.round(h.right - r.right),
    leftGap: Math.round(r.left - h.left),
    w: Math.round(r.width),
    paneW: Math.round(h.width),
    copy: !!card.querySelector('.pane-ask-q'),
    btnW: [...card.querySelectorAll('.pane-ask-btn')].map((b) => Math.round(b.getBoundingClientRect().width))
  }
})()`)
check(Boolean(dock) && dock.rightGap <= 12, 'the card is docked to the right edge', `${dock && dock.rightGap}px gap`)
check(
  Boolean(dock) && dock.leftGap > dock.rightGap && dock.w < dock.paneW * 0.75,
  'and leaves the CLI its own question to the left of it',
  dock && `${dock.w} of ${dock.paneW}, ${dock.leftGap}px clear`
)
check(Boolean(dock) && !dock.copy, 'the question is not drawn a second time inside it')
check(
  Boolean(dock) && dock.btnW.length > 1 && new Set(dock.btnW).size === 1,
  'the answers are one per line and all the same width, so arrowing moves no button',
  dock && JSON.stringify(dock.btnW)
)

// The sidebar half. The pane's countdown is drawn inside a pane that is very often not
// the one on screen, which is exactly the report this answers ("I cannot even see the
// timer counting down"), so the card carries the seconds too.
const card = await evalIn(`(() => {
  const row = document.querySelector('.row[data-id=' + JSON.stringify(${JSON.stringify(ids[0])}) + ']')
  // The seconds are a span INSIDE the 'asks you' chip (AskClock -> .asks-in), not a chip
  // of their own: '.chip.asks-in' matched nothing and reported the countdown missing.
  const chip = row && row.querySelector('.chip.asks .asks-in')
  const r = chip && chip.getBoundingClientRect()
  return { text: chip ? chip.textContent : null, w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0 }
})()`)
check(card.w > 8 && card.h >= 10, "the card says how long is left", `${card.text} ${card.w}x${card.h}`)
check(/^\d+s$|^now$/.test(card.text ?? ''), 'and says it in seconds', card.text ?? 'nothing drawn')

// ...and it is also audible, which is the half no screen is needed for. `playTick` counts
// itself on the window because a probe cannot hear anything; three seconds of a live
// countdown must produce two or three ticks, never one per frame of the chooser.
const ticks = () => evalIn('window.__pfTicks || 0')
const t0 = await ticks()
await wait(3200)
const t1 = await ticks()
check(t1 - t0 >= 2 && t1 - t0 <= 4, 'it ticks once a second while the countdown runs', `${t1 - t0} ticks in 3.2s`)

// Now the cost. Five arrow moves, counted per pane.
const renders = () => evalIn(`(() => Object.fromEntries([...(window.__pfRenders || new Map())]))()`)
const before = await renders()
for (const sel of [2, 1, 2, 1, 2]) {
  await feed(sel)
  await wait(1500)
}
const after = await renders()
const cost = (id) => (after[id] ?? 0) - (before[id] ?? 0)
check(cost(ids[1]) === 0, 'a pane with no question renders NOT AT ALL while another is arrowed', `${cost(ids[1])} renders`)
check(cost(ids[0]) > 0 && cost(ids[0]) <= 15, 'the pane holding the question still redraws', `${cost(ids[0])} renders`)

await evalIn(`(async () => { for (const id of ${JSON.stringify(ids)}) await window.api.killSession(id) })()`)
ws.close()
console.log(bad ? `\n${bad} failed` : '\nall good')
process.exit(bad ? 1 : 0)
