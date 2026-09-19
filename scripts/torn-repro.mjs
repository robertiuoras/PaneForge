// A red-capable repro of torn pane screens, judged by ARITHMETIC on a terminal buffer -
// never by a screenshot.
//
// A pane is torn when its rows do not read the way the same bytes read in a terminal wide
// enough to hold them. Two independent readings, because they fail for different reasons:
//
//   clamp   - a row whose trimmed text reaches the last column while the bytes that drew
//             it asked for a column further out. A terminal CLAMPS a column move it
//             cannot reach and piles word on word at the right-hand edge; nothing can
//             undo it afterwards, which is why Fix has to re-render from the raw log.
//   differs - a row that is not the row the reference render has at that index, with the
//             reference written at a width past every absolute column move in the bytes
//             and then resized DOWN to the pane's width. That is what the screen would
//             look like if the two ends had agreed.
//
//   node scripts/torn-repro.mjs logs   # over real CLI logs, no app, no window
//   node scripts/torn-repro.mjs app    # in a headless dev copy, over real panes
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, openSync, readSync, closeSync, statSync } from 'node:fs'
const require_ = createRequire(import.meta.url)
const { Terminal } = require_('@xterm/headless')

export const START_COLS = 120

/** Every column these bytes try to reach: CSI n G, CSI r;c H, CSI n C from column 0. */
export function paintWidth(bytes) {
  let max = 0
  for (const m of bytes.matchAll(/\x1b\[(\d+)G/g)) max = Math.max(max, +m[1])
  for (const m of bytes.matchAll(/\x1b\[\d+;(\d+)H/g)) max = Math.max(max, +m[1])
  return max
}

export function readTail(file, bytes) {
  const size = statSync(file).size
  const n = Math.min(size, bytes)
  const fd = openSync(file, 'r')
  const b = Buffer.alloc(n)
  readSync(fd, b, 0, n, size - n)
  closeSync(fd)
  return b.toString('utf8')
}

/** Write `bytes` into a terminal `writeCols` wide, then put it at `finalCols`. */
export function render(bytes, writeCols, finalCols, rows = 40) {
  const t = new Terminal({ cols: writeCols, rows, allowProposedApi: true, scrollback: 20000 })
  return new Promise((res) => {
    t.write(bytes, () => {
      if (finalCols !== writeCols) t.resize(finalCols, rows)
      const b = t.buffer.active
      const out = []
      const wrapped = []
      for (let y = 0; y < b.length; y++) {
        out.push(b.getLine(y)?.translateToString(true) ?? '')
        wrapped.push(Boolean(b.getLine(y)?.isWrapped))
      }
      res({ rows: out, wrapped, cols: t.cols, lines: lines(out, wrapped) })
    })
  })
}

/**
 * The LOGICAL lines of a render: a row xterm wrapped is the same line, so it is taken at
 * full width and joined with no separator. Row-by-row diffing cannot be the reading -
 * re-wrapping moves every row without losing a character, and that is not a tear.
 */
export function lines(rowsArr, wrapped) {
  const out = []
  let cur = ''
  for (let y = 0; y < rowsArr.length; y++) {
    cur += wrapped[y + 1] ? rowsArr[y] : rowsArr[y].trimEnd()
    if (!wrapped[y + 1]) {
      const t = cur.replace(/\s+/g, ' ').trim()
      if (t) out.push(t)
      cur = ''
    }
  }
  return out
}

/**
 * A tear is TEXT THAT IS GONE, not text that moved. A clamp piles word on word at the
 * right-hand edge, so the sentence that was there is no longer anywhere in the buffer;
 * a re-wrap keeps every character. So the reading is: logical lines the reference holds
 * that the candidate does not, plus the rows sitting hard against the last column.
 */
export function tornRows(got, want, cols) {
  const have = new Set(want.lines)
  const mine = new Set(got.lines)
  const lost = want.lines.filter((l) => l.length > 8 && !mine.has(l))
  const clamped = got.rows.filter((r) => r.trimEnd().length >= cols).length
  return {
    refLines: want.lines.length,
    gotLines: got.lines.length,
    lost: lost.length,
    clamped,
    examples: lost.slice(-3).map((l) => l.slice(0, 120)),
    _have: have
  }
}

export async function judge(bytes, writeCols, finalCols) {
  const paint = paintWidth(bytes)
  const ref = await render(bytes, Math.max(paint + 1, finalCols, writeCols), finalCols)
  const got = await render(bytes, writeCols, finalCols)
  const r = tornRows(got, ref, finalCols)
  delete r._have
  return { paint, writeCols, finalCols, ...r }
}

/* --------------------------------------------------------------- reading a real pane */

/**
 * One pane's buffer, out of the live window. Rows and their wrap flags, because a tear is
 * measured on LOGICAL lines - see `lines`.
 */
export const PANE_READ = (id, take) => `(() => {
  const h = window.__pf[${JSON.stringify(id)}]
  if (!h) return null
  const b = h.term.buffer.active
  const rows = [], wrapped = []
  const from = Math.max(0, b.length - ${take})
  for (let y = from; y < b.length; y++) {
    const l = b.getLine(y)
    rows.push(l ? l.translateToString(true) : '')
    wrapped.push(Boolean(l && l.isWrapped))
  }
  const p = h.pty()
  return { cols: h.term.cols, rows: h.term.rows, len: b.length, ptyCols: p && p.cols, ptyRows: p && p.rows, buf: rows, wrap: wrapped }
})()`

/** What that pane SHOULD read, from the bytes it was fed, at the width it ended up. */
export async function referenceFor(bytes, cols, paintedAt = 0) {
  // The width the bytes were PAINTED at, not a guess. A CLI that draws in absolute column
  // moves says so in the bytes (`paintWidth`); one that only wraps - antigravity prints no
  // column move at all - says nothing, and its width is the pty it ran at, off the
  // recorded `cols`. Getting this wrong invents a tear: a full-screen frame written 37
  // columns wider than it was drawn reads as 59 lost lines with nothing wrong anywhere.
  const wide = Math.max(paintWidth(bytes) + 1, paintedAt, 20)
  const r = await render(bytes, wide, cols)
  return r.lines
}

/** Lines the reference holds that this pane does not. The tear, in one number. */
export function lostAgainst(pane, ref) {
  const mine = new Set(lines(pane.buf, pane.wrap))
  const want = ref.filter((l) => l.length > 8)
  const lost = want.filter((l) => !mine.has(l))
  return { lost: lost.length, of: want.length, examples: lost.slice(-3) }
}

/* ------------------------------------------------------------------------ the runs */

const LIVE = process.env.HOME + '/Library/Application Support/claude-orchestrator/history'
const DEV = process.env.HOME + '/Library/Application Support/claude-orchestrator-dev-d'

/** One real conversation per CLI, off this machine's own history. */
export const REAL = [
  { cli: 'claude', id: 's38-mu7v2peb' },
  { cli: 'codex', id: 's16-mu2dhned' },
  { cli: 'antigravity', id: 's12-mu3uon6z' }
]

async function modeLogs() {
  for (const { cli, id } of REAL) {
    const bytes = readTail(`${LIVE}/${id}.log`, 400_000)
    const meta = JSON.parse(readFileSync(`${LIVE}/${id}.json`, 'utf8'))
    console.log(`\n### ${cli} ${id}  recorded cols=${meta.cols}  paints to ${paintWidth(bytes)}`)
    for (const [what, w, f] of [
      ['a launch, xterm still 80 under a 120 pty', 80, 157],
      ['a launch, both ends at 120', 120, 157],
      ['b restore, replay staged at recorded cols', meta.cols, 83],
      ['b mount of a LIVE pane, no recorded width', 83, 83],
      ['c shrink 157->83 while printing', 83, 83],
      ['control: written at least as wide as it paints', 157, 157]
    ]) {
      const r = await judge(bytes, w, f)
      console.log(
        `  ${what.padEnd(44)} write=${String(w).padStart(3)} final=${String(f).padStart(3)} ` +
          `lines=${r.refLines} LOST=${r.lost} clampedRows=${r.clamped}`
      )
      if (r.lost) console.log(`     gone: ${JSON.stringify(r.examples[r.examples.length - 1] ?? '')}`)
    }
  }
}



/**
 * A dev profile whose desk is three saved panes, one per CLI, each pointing at a REAL
 * conversation off this machine's history - a `.json` recording 120 columns over a `.log`
 * that paints to 156, which is the state 9 of 9 live panes are in on disk right now.
 *
 * The panes are shells. The tear being measured is the REPLAY, which happens in `start()`
 * before the process says anything, so the agent behind it changes nothing and a real CLI
 * here would only cost tokens and make the run non-deterministic.
 */
export function seedDev({ asleep = true } = {}) {
  mkdirSync(DEV + '/history', { recursive: true })
  // The marker a consumed desk leaves, and the copy it is filed under: both would stop
  // the next launch reading the desk written below.
  rmSync(DEV + '/desk.clear', { force: true })
  rmSync(DEV + '/desk.prev.json', { force: true })
  const specs = []
  for (const { cli, id } of REAL) {
    const bytes = readTail(`${LIVE}/${id}.log`, 400_000)
    writeFileSync(`${DEV}/history/${id}.log`, bytes)
    const meta = JSON.parse(readFileSync(`${LIVE}/${id}.json`, 'utf8'))
    writeFileSync(`${DEV}/history/${id}.json`, JSON.stringify({ ...meta, id, endedAt: undefined }))
    specs.push({
      cwd: process.cwd(),
      title: `${cli} restored`,
      agent: 'shell',
      scrollbackId: id,
      asleep,
      openedAt: Date.now()
    })
  }
  writeFileSync(DEV + '/desk.json', JSON.stringify({ specs, at: Date.now(), clean: true, reason: 'torn-repro', writtenAt: Date.now() }))
  return specs
}

async function modeApp() {
  const { connect } = await import('./ui-lab.mjs')
  const link = await connect(process.env.PF_PORT ?? '9444')
  if (process.env.PF_WIDTH) await link.resize(Number(process.env.PF_WIDTH), Number(process.env.PF_HEIGHT ?? 760))
  await new Promise((r) => setTimeout(r, 3000))
  const panes = await link.evaluate('(async () => (await window.api.listSessions()).map(s => ({ id: s.id, title: s.title, cols: s.cols, rows: s.rows, asleep: s.asleep })))()')
  console.log(JSON.stringify(panes))
  for (const p of panes) {
    const src = REAL.find((r) => p.title.startsWith(r.cli))
    await link.evaluate(`(async () => window.api.focusSession && window.api.focusSession(${JSON.stringify(p.id)}))()`).catch(() => {})
    await new Promise((r) => setTimeout(r, 1200))
    const before = await link.evaluate(PANE_READ(p.id, 2000))
    if (!before) { console.log(`${p.title}: no pane handle`); continue }
    // The pane's OWN log, not the one it was seeded from: `restoredTail` caps what it
    // replays, so measuring against the source file counts the lines the cap dropped as a
    // tear. This file is exactly the bytes this pane was handed.
    const own = `${DEV}/history/${p.id}.log`
    const bytes = existsSync(own) ? readTail(own, 4_000_000) : ''
    const painted = src ? JSON.parse(readFileSync(`${LIVE}/${src.id}.json`, 'utf8')).cols ?? 0 : 0
    const ref = bytes ? await referenceFor(bytes, before.cols, painted) : []
    const b = bytes ? lostAgainst(before, ref) : { lost: 0, of: 0 }
    await link.evaluate(`(async () => window.__pf[${JSON.stringify(p.id)}].redraw())()`)
    await new Promise((r) => setTimeout(r, 2500))
    const after = await link.evaluate(PANE_READ(p.id, 2000))
    const ref2 = bytes ? await referenceFor(bytes, after.cols, painted) : []
    const a = bytes ? lostAgainst(after, ref2) : { lost: 0, of: 0 }
    console.log(
      `${p.title.padEnd(22)} xterm ${before.cols}x${before.rows} pty ${before.ptyCols}x${before.ptyRows} ` +
        `bufRows=${before.len} LOST ${b.lost}/${b.of} -> after Fix (xterm ${after.cols}) ${a.lost}/${a.of}`
    )
    if (b.examples && b.examples.length) console.log(`   gone: ${JSON.stringify(b.examples[b.examples.length - 1])}`)
  }
  link.close()
}

/**
 * Moment (c): a pane RESIZED while the bytes are arriving.
 *
 * The window is opened wide enough that the pane is at least as wide as the bytes paint,
 * a real pty is fed a real CLI's recorded output, and the window is narrowed halfway
 * through. Nothing is simulated: the pty, the IPC hop, the fit and the terminal are the
 * app's own. The control is the same feed with no resize, which must come back clean or
 * the measurement is about the feed rather than about the resize.
 */
async function modeLive() {
  const { connect } = await import('./ui-lab.mjs')
  const link = await connect(process.env.PF_PORT ?? '9444')
  const src = REAL.find((r) => r.cli === (process.env.CLI ?? 'claude'))
  const log = `${DEV}/history/${src.id}.log`
  const bytes = readTail(log, 400_000)
  const paint = paintWidth(bytes)
  for (const shrink of [false, true]) {
    await link.resize(1800, 900)
    await new Promise((r) => setTimeout(r, 1500))
    const id = await link.evaluate(
      `(async () => (await window.api.startSession({ cwd: ${JSON.stringify(process.cwd())}, agent: 'shell', title: 'feed ${shrink ? 'shrunk' : 'steady'}' })).id ?? null)()`
    )
    await new Promise((r) => setTimeout(r, 2500))
    const wide = await link.evaluate(PANE_READ(id, 5))
    await link.evaluate(`(async () => window.api.write(${JSON.stringify(id)}, ${JSON.stringify('cat ' + log + '\n')}))()`)
    if (shrink) {
      await new Promise((r) => setTimeout(r, 250))
      await link.resize(1000, 900)
    }
    await new Promise((r) => setTimeout(r, 6000))
    const after = await link.evaluate(PANE_READ(id, 3000))
    const ref = await referenceFor(bytes, after.cols, paint)
    const lost = lostAgainst(after, ref)
    await link.evaluate(`(async () => window.__pf[${JSON.stringify(id)}].redraw())()`)
    await new Promise((r) => setTimeout(r, 3000))
    const fixed = await link.evaluate(PANE_READ(id, 3000))
    const lost2 = lostAgainst(fixed, await referenceFor(bytes, fixed.cols, paint))
    console.log(
      `${shrink ? 'SHRUNK mid-print' : 'control, steady '} start ${wide.cols}x${wide.rows} (pty ${wide.ptyCols}) ` +
        `-> end xterm ${after.cols} pty ${after.ptyCols} paint ${paint}: LOST ${lost.lost}/${lost.of}` +
        ` -> after Fix (xterm ${fixed.cols}) ${lost2.lost}/${lost2.of}`
    )
    if (lost.examples.length) console.log(`   gone: ${JSON.stringify(lost.examples[lost.examples.length - 1])}`)
    await link.evaluate(`(async () => window.api.closeSession && window.api.closeSession(${JSON.stringify(id)}))()`).catch(() => {})
  }
  await link.clearResize()
  link.close()
}

const mode = process.argv[2]
if (mode === 'logs') await modeLogs()
else if (mode === 'seed') console.log(JSON.stringify(seedDev({ asleep: process.argv[3] !== 'awake' }), null, 1))
else if (mode === 'app') await modeApp()
else if (mode === 'live') await modeLive()
