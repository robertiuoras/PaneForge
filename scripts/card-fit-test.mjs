// What a session card can still SAY once it is carrying everything a lane puts on it.
//
// The bug this exists for has now been reported twice: "Claude Code text is hidden when a
// lane is being used". It was fixed once by hand - a floor under `.row-agent` and a big
// shrink factor on the place chip - and came back, because the fix was arithmetic nobody
// re-ran. A comment in styles.css saying "measured at 239px" is not a measurement; it is a
// memory of one.
//
// So this is the measurement, in a real browser, over the SHIPPED stylesheet. It builds the
// sidebar's own markup at the real width, in every combination of chips a card can carry,
// and asserts one thing per case: nothing on the line is cut off. A card is allowed to run
// out of room - it is not allowed to answer "which agent is this" with an ellipsis while
// spending 140px saying the same lane twice.
//
// No window, no server, no app: system Chrome over raw CDP, the same trick
// scripts/phone-view-test.mjs uses. It SKIPS out loud with no Chrome rather than passing.
//
//   node scripts/card-fit-test.mjs

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'src', 'renderer', 'src', 'styles.css'), 'utf8')

let failures = 0
let checks = 0
const ok = (cond, what, detail = '') => {
  checks++
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` - ${detail}` : ''}`)
  if (!cond) failures++
}

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => existsSync(p))

if (!CHROME) {
  console.log('card fit: SKIPPED - no system Chrome found (nothing was downloaded)')
  process.exit(0)
}

/** The sidebar, at the width it really has, holding one card. */
function page(rowSub) {
  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:#111;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px}
  ${css}
  </style>
  <div class="app"><div class="sidebar" style="width:260px"><div class="list">
    <div class="row">
      <div class="row-text">
        <div class="row-title has-key"><span class="num-wrap"><span class="num">1</span></span><span class="row-name">PaneForge</span><span class="elapsed">1m 20s</span></div>
        <div class="row-sub">${rowSub}</div>
      </div>
      <button class="x">x</button>
    </div>
  </div></div></div>`
}

const LOGO = '<span style="flex:none;width:12px;height:12px;display:inline-block"></span>'
const AGENT = '<span class="row-agent">Claude Code</span>'
const MODEL = '<span class="chip">sonnet</span>'
const PLACE = '<button class="chip place">PaneForge · lane a</button>'
// What a lane card really draws now: ONE chip, the project dropped because the title above
// has already said it, wearing the lane's own colour.
const LANE_PLACE = '<button class="chip place lane-chip busy">lane a</button>'
const LANE = '<span class="chip pf-lane">Toolstash · lane c</span>'
const CLOCK = ''

const CASES = [
  { name: 'a plain card', sub: LOGO + AGENT + CLOCK },
  { name: 'with a model', sub: LOGO + AGENT + MODEL + CLOCK },
  { name: 'in a lane', sub: LOGO + AGENT + MODEL + LANE_PLACE + CLOCK },
  { name: 'in a lane, no model', sub: LOGO + AGENT + LANE_PLACE + CLOCK },
  // The one case that legitimately carries two: a chat editing one project while holding
  // some OTHER project's lane. Two different facts, so two chips - and the agent's name
  // still has to survive them.
  { name: "holding another project's lane", sub: LOGO + AGENT + MODEL + PLACE + LANE + CLOCK }
]

const profile = mkdtempSync(join(tmpdir(), 'pf-cardfit-'))
const cdpPort = 9446
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=900,700',
    'about:blank'
  ],
  { stdio: 'ignore' }
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function browserSocket() {
  for (let i = 0; i < 60; i++) {
    try {
      const info = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()
      if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(200)
  }
  throw new Error('Chrome never opened its debugging port')
}

function client(ws) {
  let next = 1
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
  })
  return (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = next++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
      setTimeout(
        () => pending.has(id) && (pending.delete(id), reject(new Error(`${method} timed out`))),
        20_000
      )
    })
}

let ws
try {
  ws = new WebSocket(await browserSocket())
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  const send = client(ws)
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const evaluate = async (expression) => {
    const r = await send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId
    )
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'threw')
    return r.result.value
  }

  for (const c of CASES) {
    await send(
      'Page.navigate',
      { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(page(c.sub)) },
      sessionId
    )
    // A navigate resolves before the document is laid out; the fonts are system ones, so
    // one frame is enough and `document.fonts.ready` is the honest way to wait for it.
    await evaluate('document.fonts.ready.then(() => 1)')
    const m = await evaluate(`(() => {
      const cut = (el) => !el ? null : { w: el.getBoundingClientRect().width, want: el.scrollWidth, text: el.textContent }
      const sub = document.querySelector('.row-sub')
      return {
        sub: sub.getBoundingClientRect().width,
        rowH: document.querySelector('.row').getBoundingClientRect().height,
        lines: Math.round(sub.getBoundingClientRect().height / 15),
        agent: cut(document.querySelector('.row-agent')),
        place: cut(document.querySelector('.chip.place')),
        lane: cut(document.querySelector('.chip.pf-lane')),
        clock: cut(document.querySelector('.elapsed')),
        name: cut(document.querySelector('.row-name')),
        // Everything the line is really trying to draw, so an overflowing line is visible
        // as a number rather than inferred from one clipped child.
        wanted: [...sub.children].reduce((n, el) => n + el.scrollWidth, 0)
      }
    })()`)

    // 1px of slack: a fractional layout rounds `scrollWidth` up to a whole pixel, so an
    // element that fits exactly reports one pixel of overflow and nothing is wrong.
    const fits = (x) => !x || x.want <= x.w + 1
    ok(
      fits(m.agent),
      `${c.name}: the agent's name is readable`,
      `${m.agent.w.toFixed(1)}px of ${m.agent.want}px ("${m.agent.text}")`
    )
    ok(fits(m.clock), `${c.name}: the clock is not cut off`, `${m.clock.w.toFixed(1)}px of ${m.clock.want}px`)
    ok(fits(m.name), `${c.name}: the pane's name is whole`, `${m.name.w.toFixed(1)}px of ${m.name.want}px`)
    ok(fits(m.place), `${c.name}: the place chip is whole`, m.place ? `${m.place.w.toFixed(1)}px of ${m.place.want}px` : '')
    console.log(
      `      card ${m.rowH.toFixed(0)}px, line ${m.sub.toFixed(0)}px in ${m.lines} row(s), wants ${m.wanted}px` +
        (m.place ? `, place ${m.place.w.toFixed(0)}/${m.place.want}` : '') +
        (m.lane ? `, lane ${m.lane.w.toFixed(0)}/${m.lane.want}` : '')
    )
  }
} finally {
  try {
    ws?.close()
  } catch {
    /* already gone */
  }
  chrome.kill()
  await sleep(300)
  rmSync(profile, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} of ${checks} failed` : `\nall ${checks} card-fit checks passed`)
process.exit(failures ? 1 : 0)
