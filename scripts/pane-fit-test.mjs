// Does a pane's terminal actually FIT inside the pane, or does its last row hang below
// the edge and get clipped?
//
//   npm run build && npm run try -- --keep --headless --remote-debugging-port=9334
//   PF_PORT=9334 npm run test:panefit
//
// Why this exists. The bottom row of an agent CLI is its status line - the model, the
// folder, the branch, the context reading - and it is the one row that never scrolls, so
// a pane that clips its last row clips the same sentence for ever. On 2026-09-05 every
// pane in a 2x2 desk did: the terminal's screen ended 8.8px below the host's content
// edge, 58% of a 15.19px row.
//
// The cause is a CSS/JS seam that no source test can see. `.xterm-host` carried the pane's
// 5px inset as PADDING, and everything in this app is `box-sizing: border-box`, so
// `getComputedStyle(host).height` answers the border box - inset included. xterm's fit
// addon reads that exact property as the height it has to fill, and subtracts only
// `.xterm`'s own padding, which is zero. So it budgeted 10px that were not there and
// proposed one row too many at every pane size. The fix is a margin, which is outside the
// box the addon measures.
//
// The reading is therefore taken in a REAL WINDOW off real layout, never off the
// stylesheet: the whole failure was that the stylesheet looked correct. The control is the
// second half - a single full-height pane has to fit too, because at some sizes the
// leftover pixels happened to absorb the extra row and the bug looked like it was gone.

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
 * Every pane's overhang, in CSS pixels: how far the terminal's drawn screen reaches past
 * the bottom edge its host leaves for it. Zero or less is a pane that fits.
 */
const MEASURE = `(() => {
  const out = []
  for (const [id, pf] of Object.entries(window.__pf || {})) {
    const t = pf.term, f = pf.fit
    // A closed pane can leave its entry behind for a beat, detached from the document.
    // Measuring one answers zeroes, which would read as "it fits".
    if (!t || !f || !t.element || !t.element.isConnected) continue
    const host = t.element.parentElement
    const screen = host && host.querySelector('.xterm-screen')
    if (!screen) continue
    const cs = getComputedStyle(host)
    const hb = host.getBoundingClientRect()
    const inner = hb.bottom - parseFloat(cs.paddingBottom) - parseFloat(cs.borderBottomWidth || '0')
    const d = f.proposeDimensions()
    out.push({
      id,
      rows: t.rows,
      proposedRows: d && d.rows,
      cellH: +(screen.getBoundingClientRect().height / t.rows).toFixed(3),
      overhang: +(screen.getBoundingClientRect().bottom - inner).toFixed(2)
    })
  }
  return out
})()`

const open = async (n) => {
  const cwd = process.cwd()
  await link.evaluate(
    `(async () => {
      for (let i = 0; i < ${n}; i++) await window.api.startSession({ cwd: ${JSON.stringify(cwd)}, agent: 'shell' })
    })()`
  )
  await sleep(4000)
}

const close = async () => {
  await link.evaluate(
    `(async () => {
      for (const s of await window.api.listSessions()) await window.api.killSession(s.id)
    })()`
  )
  await sleep(1500)
}

async function measure(what) {
  const panes = await link.evaluate(MEASURE)
  ok(panes.length > 0, `${what}: there are panes to measure at all`)
  for (const p of panes) {
    // A row is ~15px, so anything at or under 0 is a pane whose last row is whole. The
    // number is printed either way: a regression here is read as pixels, not a boolean.
    ok(
      p.overhang <= 0,
      `${what}: pane ${p.id} fits - ${p.rows} rows, cell ${p.cellH}px, last row ends ${p.overhang}px past the edge`
    )
    ok(
      p.proposedRows === p.rows,
      `${what}: pane ${p.id} is the size the fit asks for - has ${p.rows}, fit proposes ${p.proposedRows}`
    )
  }
  return panes
}

await close()

// The shape the bug was found in: a grid, where every pane is short.
await open(4)
await measure('four panes')

// The control. A single pane is tall, and at some heights the spare pixels below the last
// row absorbed the extra one - which is how this was called fixed once before.
await close()
await open(1)
await measure('one pane')

await close()

console.log(failed ? `pane fit: ${checks - failed}/${checks} checks passed` : `pane fit: ${checks} checks passed`)
process.exit(failed ? 1 : 0)
