// Does the prompt rail sit beside the terminal it annotates, whatever shape that
// terminal is drawn in?
//
//   npm run build && npm run try -- --keep --headless --remote-debugging-port=9334
//   PF_PORT=9334 npm run test:railtrack
//
// The rail is `position: absolute` inside `.xterm-wrap`, and its horizontal position was
// the CSS constant `right: 17px` - the width the desktop stylesheet asks the xterm
// viewport's scrollbar to be. Two panes make that a lie, and both draw the tags over the
// output instead of beside it:
//
//  - a MIRRORED pane is drawn under a `scale()` on the host (see `reshape`), and the rail
//    is a sibling of that host rather than a child, so it does not shrink with it.
//    Measured here at `scale(0.6)` before the fix: the terminal's right edge was 363.8px
//    in from the pane's while the rail stayed at 17px, and the track stayed 661.3px tall
//    against a 392.4px screen ("if i resize paneforge on mac then this remote window gets
//    broken", Robert 2026-09-05);
//  - a COARSE-POINTER pane gets an OVERLAY scrollbar, which takes no column out of the
//    viewport at all, so the gutter is 0px wide and every tag hangs 17px inside the pane.
//
// The reading is taken in a REAL WINDOW off real layout, because the whole failure is a
// seam between a stylesheet that looks right and a transform it knows nothing about. The
// two states are driven the way the app itself produces them: a `scale()` on the host, and
// a scrollbar rule that gives the viewport no gutter.
//
// RED PROOF: put `right: 17` back in the rail's inline style in TerminalPane.tsx and every
// `beside the terminal` check below fails in both driven states.

import { connect } from './ui-lab.mjs'

const port = process.env.PF_PORT ?? '9333'
const link = await connect(port)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let checks = 0
let failed = 0
const ok = (cond, what) => {
  checks++
  if (!cond) {
    failed++
    console.log(`  FAIL ${what}`)
  } else {
    console.log(`  ok   ${what}`)
  }
}

/**
 * Where the rail is, against where the terminal actually got drawn.
 *
 * `gap` is the distance from the pane's right edge to the terminal's, `bar` the scrollbar's
 * drawn width, so the rail's own right edge belongs at `gap + bar` and anything less is a
 * tag over the last columns of output.
 */
const MEASURE = `(() => {
  const out = []
  for (const [id, pf] of Object.entries(window.__pf || {})) {
    const t = pf.term
    if (!t || !t.element || !t.element.isConnected) continue
    const host = t.element.parentElement
    const wrap = host.closest('.xterm-wrap')
    const vp = host.querySelector('.xterm-viewport')
    const rail = wrap && wrap.querySelector('.mark-rail')
    if (!wrap || !vp || !rail) continue
    const w = wrap.getBoundingClientRect()
    const v = vp.getBoundingClientRect()
    const r = rail.getBoundingClientRect()
    const scale = vp.offsetWidth > 0 ? v.width / vp.offsetWidth : 1
    out.push({
      id: id.slice(0, 8),
      scale: +scale.toFixed(3),
      gap: +(w.right - v.right).toFixed(1),
      bar: +((vp.offsetWidth - vp.clientWidth) * scale).toFixed(1),
      railRight: +(w.right - r.right).toFixed(1),
      railH: +r.height.toFixed(1),
      vpH: +v.height.toFixed(1)
    })
  }
  return out
})()`

const cwd = process.cwd()
const start = async () => {
  await link.evaluate(
    `window.api.startSession({ cwd: ${JSON.stringify(cwd)}, agent: 'shell' })`
  )
  await sleep(4000)
  // A tag on the rail is built from KEYSTROKES on their way to the pty (see the marker
  // block in TerminalPane.tsx), so the line has to go in through xterm's own input, not
  // through `api.write` - which is the pty end and puts no tag anywhere.
  await link.evaluate(`(() => {
    for (const pf of Object.values(window.__pf || {})) pf.term && pf.term.input('echo rail\\r')
    return true
  })()`)
  await sleep(2000)
}

const closeAll = async () => {
  await link.evaluate(
    `(async () => { for (const s of await window.api.listSessions()) await window.api.killSession(s.id) })()`
  )
  await sleep(1500)
}

/** The rail belongs beside the drawn terminal, at every shape it is drawn in. */
const judge = (rows, where) => {
  ok(rows.length > 0, `${where}: a pane with a tag on its rail was measured`)
  for (const p of rows) {
    console.log(`   ${where} ${JSON.stringify(p)}`)
    ok(
      Math.abs(p.railRight - (p.gap + p.bar)) <= 1.5,
      `${where}: rail's right edge is beside the terminal (${p.railRight} vs ${(p.gap + p.bar).toFixed(1)})`
    )
    ok(Math.abs(p.railH - p.vpH) <= 1.5, `${where}: track is the drawn height (${p.railH} vs ${p.vpH})`)
  }
}

/**
 * Put a rule on the page and make the pane measure itself again.
 *
 * `syncTotal` runs off the pane's resize observer, so a state driven in by hand is not
 * read until something resizes - and the drive has to be a STYLESHEET rule rather than an
 * inline style, because the resize runs `reshape`, which writes `host.style.transform`
 * itself and would wipe an inline one. The nudge is one pixel of the pane's own padding,
 * put straight back.
 */
const drive = async (id, css) => {
  await link.evaluate(`(() => {
    let s = document.getElementById(${JSON.stringify(id)})
    if (!s) { s = document.createElement('style'); s.id = ${JSON.stringify(id)}; document.head.appendChild(s) }
    s.textContent = ${JSON.stringify(css)}
    return true
  })()`)
  for (const px of ['1px', '']) {
    await link.evaluate(
      `(() => { for (const p of document.querySelectorAll('.panes')) p.style.paddingRight = ${JSON.stringify(px)}; return true })()`
    )
    await sleep(700)
  }
}
const undrive = async (id) =>
  link.evaluate(
    `(() => { const s = document.getElementById(${JSON.stringify(id)}); if (s) s.remove(); return true })()`
  )

await closeAll()
await start()

judge(await link.evaluate(MEASURE), 'plain')

// What a mirrored pane wears. `reshape` sets exactly this, from the top-left corner.
await drive(
  'rail-track-scale',
  '.xterm-host { transform: scale(0.6) !important; transform-origin: top left !important }'
)
const scaled = await link.evaluate(MEASURE)
ok(
  scaled.every((p) => p.gap > 100),
  `the driven scale really moved the terminal off the pane's right edge (${scaled.map((p) => p.gap).join(', ')})`
)
judge(scaled, 'mirror scale')

// ...and a touch device's overlay scrollbar, which leaves no gutter at all. Driven with
// the standard property, not `::-webkit-scrollbar`: `.xterm .xterm-viewport` already sets
// `scrollbar-width: auto`, and that wins over the webkit pseudo-element's width.
await undrive('rail-track-scale')
await drive('rail-track-overlay', '.xterm .xterm-viewport { scrollbar-width: none !important }')
const overlay = await link.evaluate(MEASURE)
ok(
  overlay.every((p) => p.bar < 1),
  `the driven overlay scrollbar really left no gutter (${overlay.map((p) => p.bar).join(', ')})`
)
judge(overlay, 'overlay scrollbar')

await undrive('rail-track-overlay')
await closeAll()

console.log(`\n${checks - failed}/${checks} checks passed`)
process.exit(failed ? 1 : 0)
