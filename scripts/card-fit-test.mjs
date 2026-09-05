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
import { closeTestChrome } from './close-test-chrome.mjs'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
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
function page(rowSub, remote = false, titleChips = '', name = 'PaneForge') {
  const mark = remote
    ? '<span class="row-remote"><svg viewBox="0 0 16 16" width="13" height="13"></svg></span>'
    : ''
  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:#111;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px}
  ${css}
  /* Every measurement here is a WIDTH, and an animation that moves a box is width noise.
     The clock pill's sheen (.elapsed::after) is absolutely positioned, inset 0, and
     translated to plus/minus 120% of the pill. The pill is overflow:hidden, so it is a
     scroll container and scrollWidth counts that overflowing sheen: the clock reported
     anywhere between 53px and 116px of wanted width for the same fixed text, depending
     on which frame of a 3.6s loop the measurement landed on. Nothing about the card was
     wrong; the ruler was moving. Same trick as npm run test:contrast, which kills
     animation before it samples pixels. */
  *, *::before, *::after { animation: none !important; transition: none !important; }
  </style>
  <div class="app"><div class="sidebar" style="width:260px"><div class="list">
    <div class="row">
      <div class="row-text">
        <div class="row-title has-key"><span class="num-wrap"><span class="num">1</span></span>${mark}<span class="row-name">${name}</span><span class="row-tags">${titleChips}<span class="elapsed">1m 20s</span></span></div>
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
// The title line's own chips. `asks you` and `kept open` are fixed text with `flex: none`,
// so on one line the NAME is the only thing that can give way - which is the bug this pair
// of cases pins. The seconds inside the ask chip are its widest state.
const ASKS = '<span class="chip asks">asks you<span class="asks-in">hold</span></span>'
const KEPT = '<button class="chip kept">kept open</button>'
// A pane whose turn is over with something still running in the background: the finished
// turn's clock, and beside it what is still going. The longest thing this chip draws is
// `running` plus a script name.
const TURN_DONE = '<span class="elapsed done">4m 12s</span>'
const JOB = '<span class="chip jobs">running build</span>'

const CASES = [
  { name: 'a plain card', sub: LOGO + AGENT + CLOCK },
  { name: 'with a model', sub: LOGO + AGENT + MODEL + CLOCK },
  { name: 'in a lane', sub: LOGO + AGENT + MODEL + LANE_PLACE + CLOCK },
  { name: 'in a lane, no model', sub: LOGO + AGENT + LANE_PLACE + CLOCK },
  // The one case that legitimately carries two: a chat editing one project while holding
  // some OTHER project's lane. Two different facts, so two chips - and the agent's name
  // still has to survive them.
  { name: "holding another project's lane", sub: LOGO + AGENT + MODEL + PLACE + LANE + CLOCK },
  // A pane whose agent is on the OTHER machine. The mark went on the title line rather
  // than the sub-line precisely so it costs the sub-line nothing, and "costs nothing" is a
  // claim about pixels - so the worst sub-line is measured again with the mark above it.
  { name: 'mirrored from another device', sub: LOGO + AGENT + MODEL + LANE_PLACE + CLOCK, remote: true },
  {
    name: "mirrored, holding another project's lane",
    sub: LOGO + AGENT + MODEL + PLACE + LANE + CLOCK,
    remote: true
  },
  // Robert's own card, 2026-08-28: pane 3, project `clients`, title `pizzasrus`, with a
  // question standing and the pane pinned. The name was drawn as a single letter `p`.
  { name: 'asking and pinned', sub: LOGO + AGENT + CLOCK, title: ASKS + KEPT, shortName: true },
  { name: 'asking', sub: LOGO + AGENT + CLOCK, title: ASKS },
  // Robert's own card, 2026-08-29: pane 1, project `clients`, title `Sonia`, pinned, in a
  // lane. Nothing is cut off and it still read as broken - three ragged lines with the
  // clock alone on the second, and a hole between a short name and the chip beside it.
  { name: 'pinned, short name, in a lane', sub: LOGO + AGENT + LANE_PLACE, title: KEPT, shortName: true },
  // The background-job chip beside a FINISHED turn's clock - the state that reads as a lie
  // if the words are wrong and as ragged if they do not fit. `running build` is the widest
  // ordinary label, and this is the pair that has to share one 190px title line.
  { name: 'a finished turn with a job still running', sub: LOGO + AGENT + LANE_PLACE, title: TURN_DONE + JOB },
  // Three state chips is 207px of chrome on a 190px line (measured 2026-08-29), so this
  // one CANNOT be one row and is not asked to be: what it must do is wrap as a box.
  { name: 'pinned, with a job still running', sub: LOGO + AGENT + LANE_PLACE, title: KEPT + TURN_DONE + JOB, shortName: true, wraps: true }
]

const profile = mkdtempSync(join(tmpdir(), 'pf-cardfit-'))

/**
 * A port the OS says is free, not a number written into the file.
 *
 * Two lane worktrees running `npm test` at once is the ordinary case here, and a fixed port
 * means the second one gets a Chrome that never binds and then "Chrome never opened its
 * debugging port" - which reads as a broken card, not as a busy port. Same as
 * scripts/confirm-fit-test.mjs; `PF_CARDFIT_PORT` pins it when something outside needs to
 * attach.
 */
async function freePort() {
  const fixed = Number(process.env.PF_CARDFIT_PORT)
  if (Number.isFinite(fixed) && fixed > 0) return fixed
  return await new Promise((resolve, reject) => {
    const s = createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

const cdpPort = await freePort()
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

// `existsSync` above proves the file is there, not that it can be RUN. A binary with no
// execute bit fails asynchronously, and an unhandled 'error' event kills this process with
// no line saying so.
let spawnFailed = null
chrome.on('error', (err) => {
  spawnFailed = err
})
let chromeExit = null
chrome.on('exit', (code, signal) => {
  chromeExit = signal ? `killed by ${signal}` : `exited with code ${code}`
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function browserSocket() {
  for (let i = 0; i < 40; i++) {
    if (spawnFailed) throw new Error(`Chrome could not be started: ${spawnFailed.message}`)
    try {
      const info = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()
      if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(200)
  }
  throw new Error(
    `Chrome never opened its debugging port ${cdpPort}` +
      (chromeExit ? ` - it ${chromeExit}` : ' - it is still running, so the port is likely in use')
  )
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
      {
        url:
          'data:text/html;charset=utf-8,' +
          encodeURIComponent(page(c.sub, c.remote, c.title ?? '', c.shortName ? 'Sonia' : 'PaneForge'))
      },
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
        title: (() => {
          const t = document.querySelector('.row-title')
          return { w: t.getBoundingClientRect().width, h: t.getBoundingClientRect().height }
        })(),
        // The remote mark, if the card carries one. Its width rather than a cut() reading:
        // it has no text, and the only way it can fail is by being squeezed to nothing.
        remote: (() => {
          const el = document.querySelector('.row-remote')
          return el ? el.getBoundingClientRect().width : null
        })(),
        // Where the title line's own children really sit, so a card that fits and still
        // reads as broken is a number too: a hole after a short name, and a wrapped line
        // whose only item is pushed to the far right with nothing to its left.
        // Every state chip is inside the one tag box. This is the fix itself: with the
        // chips as direct children of the title line they each took an auto left margin
        // and a wrap scattered them down the card.
        loose: [...document.querySelectorAll('.row-title > .chip, .row-title > .elapsed')].length,
        gaps: (() => {
          const t = document.querySelector('.row-title')
          const kids = [...t.children].map((el) => {
            const r = el.getBoundingClientRect()
            return { cls: el.className.split(' ')[0], l: r.left, r: r.right, t: r.top, h: r.height, w: r.width }
          })
          const box = t.getBoundingClientRect()
          const rows = new Map()
          for (const k of kids) {
            const key = Math.round((k.t + k.h / 2) / 8)
            if (!rows.has(key)) rows.set(key, [])
            rows.get(key).push(k)
          }
          const holes = []
          // The gap in FRONT of the tag box is the auto margin doing its job - the clock
          // belongs at the far end of the line. Every other gap is a hole.
          for (const [, row] of rows) {
            row.sort((a, b) => a.l - b.l)
            for (let i = 1; i < row.length; i++) {
              if (row[i].cls === 'row-tags') continue
              holes.push(Math.round(row[i].l - row[i - 1].r))
            }
          }
          const over = Math.max(0, ...kids.map((k) => Math.round(k.r - box.right)))
          return { rows: rows.size, holes, over, kids: kids.map((k) => k.cls + ':' + Math.round(k.l - box.left) + '-' + Math.round(k.r - box.left) + '@' + Math.round(k.t)), box: Math.round(box.width) }
        })(),
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
    // A card that fits and still reads as broken. Both of these passed every assertion
    // above on 2026-08-29 while Robert's card drew `Sonia` in a 78px box with 40px of
    // nothing after it and the clock alone on a second row 135px from the left.
    ok(
      Math.max(0, ...m.gaps.holes) <= 8,
      `${c.name}: no hole between the things on the title line`,
      `gaps ${m.gaps.holes.join('/')}px`
    )
    ok(
      m.loose === 0,
      `${c.name}: every state chip is in the one tag box`,
      `${m.loose} loose on the title line`
    )
    ok(
      m.gaps.over <= 1,
      `${c.name}: nothing on the title line runs off the card`,
      `${m.gaps.over}px past the edge`
    )
    // The card Robert reported: a short name, a pin and a clock is 118px of chrome on a
    // 190px line and has no business taking three rows. It measured 40px tall over two
    // rows with the chips as separate items (2026-08-29), and 19px in one row now.
    if (c.shortName && !c.title.includes('asks') && !c.wraps)
      ok(
        m.title.h < 25,
        `${c.name}: the title line is ONE row`,
        `${m.title.h.toFixed(1)}px tall`
      )
    // ...and a card whose chips genuinely do not fit one row wraps to TWO, never three.
    // That is what `.row-tags` wrapping inside itself buys, and the failure it replaces is
    // a chip running off the edge - which the assertion above already refuses. A third row
    // means the box has stopped wrapping as a unit and is stacking one chip per line.
    if (c.wraps)
      ok(
        m.gaps.rows === 2,
        `${c.name}: the chips wrap to two rows, not one per chip`,
        `${m.gaps.rows} rows, ${m.title.h.toFixed(1)}px tall`
      )
    ok(fits(m.place), `${c.name}: the place chip is whole`, m.place ? `${m.place.w.toFixed(1)}px of ${m.place.want}px` : '')
    if (c.remote)
      ok(
        m.remote !== null && m.remote >= 13,
        `${c.name}: the remote mark is drawn at full size`,
        `${m.remote === null ? 'missing' : m.remote.toFixed(1) + 'px'}`
      )
    console.log(
      `      title ${m.title.h.toFixed(0)}px/${m.gaps.box}px in ${m.gaps.rows} row(s), gaps ${m.gaps.holes.join('/')}px, ${m.gaps.kids.join(' ')}`
    )
    console.log(
      `      card ${m.rowH.toFixed(0)}px, line ${m.sub.toFixed(0)}px in ${m.lines} row(s), wants ${m.wanted}px` +
        (m.place ? `, place ${m.place.w.toFixed(0)}/${m.place.want}` : '') +
        (m.lane ? `, lane ${m.lane.w.toFixed(0)}/${m.lane.want}` : '')
    )
  }
} finally {
  await closeTestChrome(chrome, profile, ws)
}

console.log(failures ? `\n${failures} of ${checks} failed` : `\nall ${checks} card-fit checks passed`)
process.exit(failures ? 1 : 0)
