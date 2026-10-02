// Does a pane mirrored from the other machine FILL its card, at the far end's grid, with
// nothing cut off on the right and no empty band on the left - on a PC-like screen
// (devicePixelRatio 1.25) and a Mac-like one (2)?
//
//   npm run build && npm run try -- --keep --headless --remote-debugging-port=9446
//   PF_PORT=9446 npm run test:mirrorview
//
// Why this exists. Robert, 2026-10-02, with a screenshot of a Mac pane mirrored on the PC:
// the conversation pushed right behind a wide empty band and its lines cut off at the right
// edge - "display broken on both mac and pc and need this full fixed 100% so it fits same
// size and works properly without breaking". Measured in a dev copy (dpr 1.25, card 909px):
// the owner holding 121x37, the mirror settled at font 12 with WebGL cells of 6.4px and a
// centring `translate(68px, ...)`; the renderer then swapped to the DOM one (a pane hidden
// and shown, or a lost GPU context) and the SAME font drew 7.03px cells - nothing re-ran the
// fit, so 75px stayed empty on the left and two columns hung off the right. Nothing about
// that is visible in the arithmetic suites: the cell size is a fact of the renderer and the
// screen it is on, so it is read here, in a real window, off real layout.
//
// The owner desk is a fake: `src/main/remote/host.ts` itself, built here, over a backend
// whose pty is a painter writing `S<row>---E` lines exactly as wide as its grid. It lends
// its grid to the mirror's ask (a desk nobody is at) or holds its own (somebody is at it,
// so the mirror must shrink its font instead), and it can change its own size.
//
// Readings, CSS px, per step: the owner's grid, the mirror's grid, its font, its cell,
// `gapLeft` (card edge to the first column), `clippedRight` (screen past the card's right
// edge, scrollbar excluded) and `clippedCols`, plus `gapRight`/`gapBottom`.

import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { connect, root } from './ui-lab.mjs'

const port = process.env.PF_PORT ?? '9334'
const c = await connect(port)
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

let checks = 0
let failed = 0
const ok = (cond, what, detail) => {
  checks++
  if (!cond) failed++
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}${!cond && detail !== undefined ? `  -- ${detail}` : ''}`)
}

const work = mkdtempSync(join(tmpdir(), 'pf-mirror-view-'))
buildSync({
  entryPoints: [join(root, 'src/main/remote/host.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: join(work, 'host.mjs'),
  logLevel: 'error'
})
const { RemoteHost } = await import('file:///' + join(work, 'host.mjs').replace(/\\/g, '/'))

/** One fake owner desk with one pane. */
async function ownerDesk(tag) {
  const id = 'mirror-view'
  const device = `mirror-view-${tag}-${Date.now()}`
  const code = crypto.randomUUID()
  const owner = { deskCols: 160, deskRows: 45, lend: true, borrows: new Map(), asks: [], grids: [] }
  const session = { id, title: `Mirror view ${tag}`, cwd: root, agent: 'claude', status: 'idle', createdAt: Date.now(), cols: 160, rows: 45 }
  let buffer = ''
  const dataL = []
  const sessL = []
  const paint = () => {
    let out = '\x1b[2J\x1b[H'
    for (let r = 0; r < session.rows; r++) {
      const head = `S${r}`
      out += `\x1b[${r + 1};1H` + (head + '-'.repeat(Math.max(0, session.cols - head.length - 1)) + 'E').slice(0, session.cols)
    }
    buffer = out
    for (const cb of dataL) cb(id, out)
  }
  const settle = () => {
    let cols = owner.deskCols
    let rows = owner.deskRows
    let borrowed = false
    if (owner.lend && owner.borrows.size) {
      cols = Math.min(...[...owner.borrows.values()].map((b) => b.cols))
      rows = Math.min(...[...owner.borrows.values()].map((b) => b.rows))
      borrowed = true
    }
    if (cols === session.cols && rows === session.rows && session.borrowed === borrowed) return
    Object.assign(session, { cols, rows, borrowed })
    owner.grids.push(`${cols}x${rows}`)
    for (const cb of sessL) cb([session])
    paint()
  }
  const backend = {
    list: () => [session],
    buffer: () => buffer,
    log: () => buffer,
    write: () => {},
    sendPrompt: () => {},
    resize: (_id, cols, rows, borrowed, viewer) => {
      owner.asks.push({ cols, rows, borrowed: borrowed === true, viewer: String(viewer) })
      if (borrowed) owner.borrows.set(String(viewer), { cols: Math.max(20, cols), rows: Math.max(5, rows) })
      settle()
    },
    returnSize: (_id, viewer) => {
      owner.borrows.delete(String(viewer))
      settle()
    },
    redraw: () => paint(),
    setBusy: () => {},
    clearAttention: () => {},
    kill: () => {},
    restart: () => null,
    rename: () => {},
    switchAgent: () => null,
    projects: async () => [],
    agents: async () => [],
    jobs: async () => [],
    onData: (cb) => (dataL.push(cb), () => {}),
    onTyped: () => () => {},
    onSessions: (cb) => (sessL.push(cb), () => {}),
    onAttention: () => () => {}
  }
  paint()
  const host = new RemoteHost(backend, () => ({ id: device, name: `Mirror view ${tag}`, platform: 'darwin', version: '0.0.0-test' }), () => code)
  host.start(0)
  await once(host.server, 'listening')
  const paired = await c.evaluate(
    `window.api.pairRemote(${JSON.stringify({ address: '127.0.0.1', port: host.server.address().port, code, name: `Mirror view ${tag}` })})`
  )
  if (!paired?.ok) throw new Error(`pairing the fake owner failed: ${paired?.error}`)
  await c.evaluate(`window.api.watchRemote(${JSON.stringify(device)}, ['${id}'])`)
  let mirrorId
  for (const end = Date.now() + 10_000; Date.now() < end && !mirrorId; ) {
    mirrorId = await c.evaluate(`window.api.listSessions().then((a) => a.find((s) => s.title === ${JSON.stringify(session.title)})?.id)`)
    if (!mirrorId) await pause(100)
  }
  if (!mirrorId) throw new Error('the mirror never arrived')
  const q = JSON.stringify(mirrorId)
  await c.evaluate(`document.querySelector('.row[data-id="' + ${q} + '"]')?.click()`)
  const done = async () => {
    await c.evaluate(`window.api.forgetRemote(${JSON.stringify(device)})`).catch(() => {})
    host.stop?.()
    host.server?.close?.()
  }
  return { owner, session, settle, mirrorId, q, done }
}

const MEASURE = (q) => `(() => {
  const p = window.__pf[${q}]
  if (!p || !p.term || !p.host) return null
  const t = p.term, h = p.host, x = t.element
  const scr = h.querySelector('.xterm-screen'), vp = h.querySelector('.xterm-viewport')
  if (!scr || !x || !h.offsetParent) return null
  // The card: the nearest box that clips. What is past its edge is not on screen.
  let clip = h.parentElement
  while (clip && getComputedStyle(clip).overflow === 'visible') clip = clip.parentElement
  const sr = scr.getBoundingClientRect(), cr = clip.getBoundingClientRect(), hb = h.getBoundingClientRect()
  const xr = x.getBoundingClientRect()
  // The box the grid should fill, as the fit addon reads it (host less the terminal's
  // padding and the scrollbar), at the host's UNTRANSFORMED place: the mirror's centring
  // is a translate on the host, and that is part of what is being measured.
  const mx = new DOMMatrix(getComputedStyle(h).transform === 'none' ? '' : getComputedStyle(h).transform)
  const tx = mx.m41, ty = mx.m42
  const hs = getComputedStyle(h), xs = getComputedStyle(x)
  const sb = vp ? vp.offsetWidth - vp.clientWidth : 0
  const left = hb.left - tx + (parseInt(xs.paddingLeft) || 0)
  const top = hb.top - ty + (parseInt(xs.paddingTop) || 0)
  const w = parseInt(hs.width) - (parseInt(xs.paddingLeft) || 0) - (parseInt(xs.paddingRight) || 0) - sb
  const hh = parseInt(hs.height) - (parseInt(xs.paddingTop) || 0) - (parseInt(xs.paddingBottom) || 0)
  // Visible: inside the card and not under the scrollbar, which rides the terminal's right edge.
  const visibleRight = Math.min(cr.right, xr.right - sb)
  const cellW = sr.width / t.cols, cellH = sr.height / t.rows
  const r1 = (n) => Math.round(n * 10) / 10
  return {
    grid: t.cols + 'x' + t.rows, cols: t.cols, rows: t.rows, font: t.options.fontSize,
    gl: p.hasWebgl(), dpr: devicePixelRatio, cellW: r1(cellW), cellH: r1(cellH),
    card: Math.round(cr.width) + 'x' + Math.round(cr.height), box: w + 'x' + hh, sb,
    gapLeft: r1(sr.left - left), gapRight: r1(left + w - sr.right),
    gapTop: r1(sr.top - top), gapBottom: r1(top + hh - sr.bottom),
    clippedRight: r1(Math.max(0, sr.right - visibleRight)), clippedBottom: r1(Math.max(0, sr.bottom - cr.bottom)),
    clippedCols: Math.max(0, Math.ceil((sr.right - visibleRight) / cellW - 0.01)),
    transform: h.style.transform || '-'
  }
})()`

/** Read until two readings 600ms apart agree, or give up after `ms`. */
async function settled(d, ms = 8000) {
  let last = null
  let same = 0
  const end = Date.now() + ms
  while (Date.now() < end) {
    await pause(600)
    const now = await c.evaluate(MEASURE(d.q))
    if (!now) continue
    const key = JSON.stringify({ ...now, owner: `${d.session.cols}x${d.session.rows}` })
    if (key === last) {
      if (++same >= 1) return now
    } else same = 0
    last = key
  }
  return await c.evaluate(MEASURE(d.q))
}

const rows = []
function record(dpr, step, m, d, extra = {}) {
  rows.push({ dpr, step, owner: `${d.session.cols}x${d.session.rows}${d.session.borrowed ? ' lent' : ''}`, ...m, ...extra })
  console.log(
    `  [dpr ${dpr}] ${step.padEnd(22)} owner ${d.session.cols}x${d.session.rows}${d.session.borrowed ? ' lent' : '     '}` +
      `  mirror ${m.grid} font ${m.font} cell ${m.cellW}x${m.cellH} ${m.gl ? 'webgl' : 'dom  '}` +
      `  box ${m.box} gapLeft ${m.gapLeft} gapRight ${m.gapRight} gapTop ${m.gapTop} gapBottom ${m.gapBottom} clipped ${m.clippedRight}px/${m.clippedCols}col` +
      (extra.asks !== undefined ? `  asks ${extra.asks} owner-resizes ${extra.resizes} (${d.owner.grids.join(' ')})` : '')
  )
}

/** The checks every step shares: the far end's whole grid, on screen, not pushed aside. */
function fits(dpr, step, m, d) {
  const tag = `[dpr ${dpr}] ${step}:`
  ok(m.cols === d.session.cols && m.rows === d.session.rows, `${tag} the mirror draws the owner's grid`, `${m.grid} vs ${d.session.cols}x${d.session.rows}`)
  ok(m.clippedCols === 0 && m.clippedRight === 0, `${tag} no column is cut off on the right`, `${m.clippedRight}px, ${m.clippedCols} cols`)
  ok(m.clippedBottom === 0, `${tag} no row is cut off at the bottom`, `${m.clippedBottom}px`)
  // Centred or flush, never shoved: the band on the left may not be wider than the one on
  // the right by more than a cell (the grid is whole cells, so the two can differ by one).
  ok(m.gapLeft <= Math.max(0, m.gapRight) + m.cellW, `${tag} no empty band on the left`, `left ${m.gapLeft} right ${m.gapRight} cell ${m.cellW}`)
}

async function run(dpr) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: dpr, mobile: false })
  const d = await ownerDesk(String(dpr).replace('.', '_'))
  try {
    const maxFont = await c.evaluate(`window.api.getConfig().then((c) => c.fontSize)`)

    // 1. The owner desk is empty, so it lends: the mirror's ask IS the grid. One ask per
    //    box size - a wobble is the owner's pty resized and repainted for nothing.
    // Counted from the pairing: the first asks go out while the pane is still opening.
    let m = await settled(d)
    const asks = d.owner.asks.length
    const resizes = d.owner.grids.length
    record(dpr, 'owner lends', m, d, { asks, resizes })
    fits(dpr, 'owner lends', m, d)
    ok(m.font === maxFont, `[dpr ${dpr}] owner lends: drawn at the user's own font`, `${m.font} vs ${maxFont}`)
    ok(m.gapRight < m.cellW + 1 && m.gapBottom < m.cellH + 1, `[dpr ${dpr}] owner lends: the lent grid fills the card to within a cell`, `right ${m.gapRight} bottom ${m.gapBottom}`)
    ok(resizes <= 2, `[dpr ${dpr}] owner lends: the owner's pty is resized at most twice to get there`, `${resizes}: ${d.owner.grids.join(' ')}`)
    ok(
      d.owner.grids.every((g, i) => d.owner.grids.indexOf(g) === i),
      `[dpr ${dpr}] owner lends: the ask never wobbles back to a grid it left`,
      d.owner.grids.join(' ')
    )
    ok(d.owner.asks.every((a) => a.viewer.endsWith('window')), `[dpr ${dpr}] owner lends: the ask is filed under the window, not as a phone`, JSON.stringify(d.owner.asks.slice(-2)))

    // 2. Somebody is at the owner desk: it keeps its own 160x45 and the mirror shrinks.
    d.owner.lend = false
    d.settle()
    m = await settled(d)
    record(dpr, 'owner holds bigger', m, d)
    fits(dpr, 'owner holds bigger', m, d)

    // 3. ...a grid that fits at the user's font, reached from a SHRUNKEN one - the font
    //    walk used to stop a pixel short.
    d.owner.deskCols = 121
    d.owner.deskRows = 37
    d.settle()
    m = await settled(d)
    record(dpr, 'owner resizes 121x37', m, d)
    fits(dpr, 'owner resizes 121x37', m, d)
    const best = await c.evaluate(`(() => {
      const p = window.__pf[${d.q}], t = p.term, f = p.fit, was = t.options.fontSize
      let best = 0
      for (let font = ${maxFont}; font >= 6 && !best; font--) {
        t.options.fontSize = font
        const r = f.proposeDimensions()
        if (r && r.cols >= t.cols && r.rows >= t.rows) best = font
      }
      t.options.fontSize = was
      return best
    })()`)
    await settled(d)
    ok(m.font === best, `[dpr ${dpr}] owner resizes 121x37: the largest font that fits, not one below it`, `${m.font} vs ${best}`)

    // 4. The renderer swaps under the same font (a pane hidden and shown, a lost GPU
    //    context): the cell changes size and the fit must follow it.
    await c.evaluate(`window.__pf[${d.q}].dropWebgl()`)
    m = await settled(d)
    record(dpr, 'after renderer swap', m, d)
    fits(dpr, 'after renderer swap', m, d)

    // 5. The owner's window gets smaller than the card: held at the user's font, centred.
    d.owner.deskCols = 100
    d.owner.deskRows = 30
    d.settle()
    m = await settled(d)
    record(dpr, 'owner holds smaller', m, d)
    fits(dpr, 'owner holds smaller', m, d)
    ok(m.font === maxFont, `[dpr ${dpr}] owner holds smaller: drawn at the user's own font`, `${m.font} vs ${maxFont}`)
    ok(Math.abs(m.gapLeft - m.gapRight) <= 1.5, `[dpr ${dpr}] owner holds smaller: centred, not pushed to one side`, `left ${m.gapLeft} right ${m.gapRight}`)

    // 6. ...and grows again.
    d.owner.deskCols = 140
    d.owner.deskRows = 40
    d.settle()
    m = await settled(d)
    record(dpr, 'owner resizes 140x40', m, d)
    fits(dpr, 'owner resizes 140x40', m, d)

    // 7. Nobody at the owner desk again: it lends, on the DOM renderer this time.
    d.owner.lend = true
    d.settle()
    m = await settled(d)
    record(dpr, 'owner lends again', m, d)
    fits(dpr, 'owner lends again', m, d)
    ok(m.font === maxFont, `[dpr ${dpr}] owner lends again: drawn at the user's own font`, `${m.font} vs ${maxFont}`)
    ok(m.gapRight < m.cellW + 1 && m.gapBottom < m.cellH + 1, `[dpr ${dpr}] owner lends again: fills the card to within a cell`, `right ${m.gapRight} bottom ${m.gapBottom}`)
  } finally {
    await d.done()
  }
}

try {
  for (const dpr of [1.25, 2]) await run(dpr)
} finally {
  await c.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${checks - failed}/${checks} checks passed`)
if (process.env.MIRROR_VIEW_JSON) console.log(JSON.stringify(rows))
c.close?.()
setTimeout(() => process.exit(failed ? 1 : 0), 200)
