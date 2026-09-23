// A pane's terminal must never get narrower than the pty it is drawing.
//
// The renderer used to fit the terminal and THEN tell main (`refit` then `api.resize` in
// TerminalPane), so for one IPC hop the grid was already narrow while the CLI was still
// painting at the old width. At rest that gap is invisible; during a streaming turn there
// is always output in it, and a column move past the last column CLAMPS - every line lands
// on the right-hand edge, one word over the last, and the rows scroll into the scrollback
// where no repaint can reach them. Reported 2026-08-25 as "what's wrong with this chat",
// on a pane whose log shows the CLI painting to column 155-157 all session.
//
// Two halves here:
//   1. the ordering itself, held still by `shared/shrinkFirst.ts`
//   2. the CONTROL, which is the reason the ordering matters: paint wider than the grid
//      and the text tears; paint at or under it and the same bytes are clean. Without
//      this half the first half is just an opinion about function returns.
//
//   node scripts/shrink-first-test.mjs

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-shrink-first-'))
const out = join(work, 'shrinkFirst.mjs')
buildSync({
  entryPoints: [join(root, 'src/shared/shrinkFirst.ts')],
  outfile: out,
  format: 'esm',
  bundle: true,
  platform: 'node'
})
// Same trap as link-state and whatsnew: a bare `C:\...` is protocol `c:` to the loader.
const { nextResize, ptyOwed, GRANT_GRACE_MS } = await import(pathToFileURL(out).href)

let failed = 0
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failed++
    console.error(`  FAIL ${name}${detail ? ' - ' + detail : ''}`)
  }
}

console.log('ordering')

// Growing is safe in either order: a terminal wider than the paint just leaves short
// lines, and the next repaint covers them. It must not wait for anything.
ok(
  'a grow fits immediately',
  nextResize({
    have: { cols: 100, rows: 30 },
    want: { cols: 157, rows: 40 },
    pty: { cols: 100, rows: 30 },
    asked: null,
    waitedMs: 0
  }).do === 'fit'
)

// The one that matters.
const shrink = nextResize({
  have: { cols: 157, rows: 40 },
  want: { cols: 120, rows: 40 },
  pty: { cols: 157, rows: 40 },
  asked: null,
  waitedMs: 0
})
ok('a shrink asks the pty first', shrink.do === 'ask', JSON.stringify(shrink))
ok('and asks for the grid the window has room for', shrink.cols === 120 && shrink.rows === 40)

ok(
  'the terminal does NOT follow while the pty is still wide',
  nextResize({
    have: { cols: 157, rows: 40 },
    want: { cols: 120, rows: 40 },
    pty: { cols: 157, rows: 40 },
    asked: { cols: 120, rows: 40 },
    waitedMs: 40
  }).do === 'wait'
)

ok(
  'it follows once the pty is confirmed at the asked grid',
  nextResize({
    have: { cols: 157, rows: 40 },
    want: { cols: 120, rows: 40 },
    pty: { cols: 120, rows: 40 },
    asked: { cols: 120, rows: 40 },
    waitedMs: 40
  }).do === 'fit'
)

// main REFUSES a desk resize while a phone is borrowing the pane (see resize() in
// main/sessions.ts), so an ask that is never granted is a real state and must not leave
// the terminal stuck wider than its own box for ever.
ok(
  'a refused ask gives up after the grace and fits anyway',
  nextResize({
    have: { cols: 157, rows: 40 },
    want: { cols: 120, rows: 40 },
    pty: { cols: 157, rows: 40 },
    asked: { cols: 120, rows: 40 },
    waitedMs: GRANT_GRACE_MS + 1
  }).do === 'fit'
)

// A grant SMALLER than the ask is still a grant: main mins each axis across every
// borrower, so the number that comes back is regularly one nobody asked for.
ok(
  'a grid smaller than the ask counts as granted',
  nextResize({
    have: { cols: 157, rows: 40 },
    want: { cols: 120, rows: 40 },
    pty: { cols: 50, rows: 20 },
    asked: { cols: 120, rows: 40 },
    waitedMs: 10
  }).do === 'fit'
)

// A phone keyboard opening takes ROWS away many times a session. Making that wait would
// move the screen under somebody who is typing, and rows cannot clamp a column move.
ok(
  'losing rows alone does not wait',
  nextResize({
    have: { cols: 120, rows: 40 },
    want: { cols: 120, rows: 18 },
    pty: { cols: 120, rows: 40 },
    asked: null,
    waitedMs: 0
  }).do === 'fit'
)

ok(
  'no measurement is not a resize',
  nextResize({ have: { cols: 120, rows: 40 }, want: null, pty: null, asked: null, waitedMs: 0 }).do ===
    'none'
)

// A pty left at a grid the terminal is not at, with no borrow on record. Live on the desk
// 2026-09-23: s15-mudr1l7h's pty 29x16, `borrowed: false`, under a 130x55 terminal - every
// Claude Code frame wrapped at 29 columns and Fix said "repaired" over it.
console.log('a pty left behind is told again')
ok('ptyOwed exists', typeof ptyOwed === 'function')
const owed = (have, pty) => (typeof ptyOwed === 'function' ? ptyOwed(have, pty) : false)
ok('a 29x16 pty under a 130x55 terminal is owed the grid', owed({ cols: 130, rows: 55 }, { cols: 29, rows: 16 }))
ok('a pty at the terminal grid owes nothing', !owed({ cols: 130, rows: 55 }, { cols: 130, rows: 55 }))
ok('no pty reading owes nothing (a mirror)', !owed({ cols: 130, rows: 55 }, null))
ok(
  "main's 20x5 floor is not a mismatch (no resize per observer tick)",
  !owed({ cols: 15, rows: 3 }, { cols: 20, rows: 5 })
)
ok(
  'a terminal already fitted over a pty at another grid is fitted and re-told, not left',
  nextResize({
    have: { cols: 130, rows: 55 },
    want: { cols: 130, rows: 55 },
    pty: { cols: 29, rows: 16 },
    asked: null,
    waitedMs: 0
  }).do === 'fit'
)
ok(
  'and a pane at rest stays at rest',
  nextResize({
    have: { cols: 130, rows: 55 },
    want: { cols: 130, rows: 55 },
    pty: { cols: 130, rows: 55 },
    asked: null,
    waitedMs: 0
  }).do === 'none'
)

// The whole sequence, the way reshape() in TerminalPane runs it: a box flashes small for a
// frame, grows back before the shrink is granted, and the grant then fits a terminal that
// never moved. The old report rule (`changed` only) left the pty at the flash.
{
  let term = { cols: 130, rows: 55 }
  let pty = { cols: 130, rows: 55 }
  let asked = null
  const told = []
  const step = (box) => {
    const s = nextResize({ have: term, want: box, pty, asked, waitedMs: 10 })
    if (s.do === 'ask') {
      asked = { cols: s.cols, rows: s.rows }
      told.push(asked)
      pty = { ...asked } // main grants it
      return
    }
    if (s.do !== 'fit') return
    asked = null
    const changed = term.cols !== box.cols || term.rows !== box.rows
    term = { ...box }
    if (changed || owed(term, pty)) {
      told.push({ ...term })
      pty = { ...term }
    }
  }
  step({ cols: 29, rows: 16 }) // the flash: a shrink, asked first
  step({ cols: 130, rows: 55 }) // back to full before the grant is read: the grant, then a no-op fit
  step({ cols: 130, rows: 55 })
  ok(
    'a shrink flash that grows back leaves the pty at the terminal grid',
    pty.cols === 130 && pty.rows === 55 && term.cols === 130,
    `pty ${pty.cols}x${pty.rows}, terminal ${term.cols}x${term.rows}, told ${JSON.stringify(told)}`
  )
}

// The shipped renderer uses it: reshape reports on it, the pty effect re-decides on it, and
// Fix re-asserts the terminal's grid before replaying.
const pane = readFileSync(join(root, 'src/renderer/src/components/TerminalPane.tsx'), 'utf8')
ok(
  'reshape tells the pty when it is owed, not only when the terminal moved',
  /if \(changed \|\| ptyOwed\(\{ cols: t\.cols, rows: t\.rows \}, ptyRef\.current\)\)\s*\n\s*api\.resize\(/.test(pane)
)
ok(
  'a pty landing at another grid re-runs reshape',
  /if \(!asked\.current && !ptyOwed\(\{ cols: t\.cols, rows: t\.rows \}, pty \?\? null\)\) return\s*\n\s*reshape\(t, f\)\s*\n\s*\}, \[pty\?\.cols, pty\?\.rows\]\)/.test(pane)
)
{
  const i = pane.indexOf('const redrawHistory = async')
  const body = i < 0 ? '' : pane.slice(i, pane.indexOf('api.replayHistory(sessionId)', i))
  ok(
    'Fix re-asserts the terminal grid on the pty before it replays',
    /api\.takePaneSize\(sessionId\)[\s\S]*api\.resize\(sessionId, back, t\.rows/.test(body)
  )
}

// The control: why any of the above is worth doing.
console.log('control - a clamp really does tear')
const require = createRequire(join(root, 'package.json'))
const { Terminal } = require('@xterm/headless')

// One frame of the shape an agent CLI actually prints: park the cursor at an absolute
// column and write there. At 120 columns every one of these lands; at 80 they all clamp
// onto the last column and pile up.
const frame =
  '\x1b[H' +
  ['alpha', 'bravo', 'charlie', 'delta']
    .map((w, i) => `\x1b[${i + 1};1H${w}\x1b[${i + 1};100H${w.toUpperCase()}`)
    .join('') +
  '\r\n'

const render = (cols) =>
  new Promise((res) => {
    const t = new Terminal({ cols, rows: 12, allowProposedApi: true })
    t.write(frame, () => {
      const b = t.buffer.active
      const lines = []
      for (let i = 0; i < b.length; i++) lines.push(b.getLine(i).translateToString(true))
      res(lines.filter((l) => l.trim()))
    })
  })

const wide = await render(120)
const narrow = await render(80)
const separated = (ls) => ls.every((l) => !/[a-z][A-Z]/.test(l))
ok('at or above the paint width the frame is clean', separated(wide), JSON.stringify(wide.slice(0, 4)))
ok(
  'below it the words are clamped onto each other',
  !separated(narrow),
  JSON.stringify(narrow.slice(0, 4))
)

rmSync(work, { recursive: true, force: true })
if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nshrink-first: all passed')
