/**
 * The pty and the terminal must open at the SAME width.
 *
 * Everything an agent CLI prints is absolute column moves. A terminal clamps a column it
 * cannot reach, so a byte stream painted at the pty's width and drawn into a narrower
 * grid piles word on word at the right-hand edge - permanently, because xterm can unwrap
 * a row it wrapped itself and can never undo a clamp. Before this the pty spawned at 120
 * and xterm opened at its library default of 80, and a `claude --resume` dumps a whole
 * conversation into that gap.
 *
 * The control is the load-bearing half: writing at 80 and widening MUST still be broken,
 * or this test would pass over a bug it cannot see.
 */
import xtermHeadless from '@xterm/headless'
const { Terminal } = xtermHeadless
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fail = 0
const check = (what, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) fail++
}
const eq = (what, got, want) => check(`${what} (${JSON.stringify(got)})`, got === want)

// One line of the shape every CLI here draws: words placed by absolute column move, out
// to the last column the pty had. Taken from the real log this was measured on.
const WORDS = ['genuinely', 'each', 'depend', 'on', 'the', 'previous', 'output']
const line =
  'Cause:' + WORDS.map((w, i) => `\x1b[${10 + i * 15}G${w}`).join('') + '\r\n'

const render = (paintAt, viewAt) =>
  new Promise((res) => {
    const t = new Terminal({ cols: paintAt, rows: 24, scrollback: 500, allowProposedApi: true })
    t.write(line, () => {
      if (viewAt !== paintAt) t.resize(viewAt, 24)
      const b = t.buffer.active
      const rows = []
      for (let i = 0; i < b.length; i++) rows.push(b.getLine(i)?.translateToString(true) ?? '')
      res(rows)
    })
  })

// The last word sits at column 10 + 6*15 = 100, so 120 is wide enough and 80 is not.
const wide = await render(120, 157)
const narrow = await render(80, 157)
// How many rows the one line ended up spread across. A clamp does not delete a word - the
// terminal wraps it onto the next row instead - so the damage is in the LAYOUT, which is
// what the screen shows: one sentence torn into two ragged columns.
const spread = (rows) => rows.filter((r) => WORDS.some((w) => r.includes(w))).length
const flat = (rows) => rows.join('\n')

check(
  'painted at the pty width, every word survives being widened',
  WORDS.every((w) => flat(wide).includes(w)) && spread(wide) === 1
)
eq(
  '...in the order they were written',
  WORDS.every((w, i) => (i === 0 ? true : flat(wide).indexOf(w) > flat(wide).indexOf(WORDS[i - 1]))),
  true
)
// CONTROL. If this ever passes, the test has stopped being able to see the bug.
eq('CONTROL: painted into a narrower grid, one line tears across several rows', spread(narrow) > 1, true)

// --- the source contract: exactly one number, and both ends read it -----------------
const grid = readFileSync(join(root, 'src/shared/paneGrid.ts'), 'utf8')
const sessions = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
const pane = readFileSync(join(root, 'src/renderer/src/components/TerminalPane.tsx'), 'utf8')
const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')

check('the starting grid is declared once', /export const START_COLS = \d+/.test(grid))
check('main spawns the pty on it', sessions.includes('this.spawn(req, agent, START_COLS, START_ROWS)'))
check('and records the session at it', sessions.includes('cols: START_COLS'))
check('the renderer opens its terminal on the same one', pane.includes('cols: START_COLS'))
check('...rows too', pane.includes('rows: START_ROWS'))
check('no literal 120 left in the pane size the pty is spawned at', !/this\.spawn\(req, agent, 120/.test(sessions))

// --- Fix repairs the scrollback, not only the live frame ----------------------------
check('the pane exposes a full redraw', pane.includes('paneRedraw.set(sessionId, redrawHistory)'))
check('...which is dropped with the pane', pane.includes('paneRedraw.delete(sessionId)'))
check('...and writes at a width no narrower than any it was painted at', pane.includes('Math.max(back, replayColsRef.current ?? 0, START_COLS)'))
check('...and never on a mirror (that pty is another machine\'s)', /redrawHistory = async[\s\S]{0,120}mirrorRef\.current/.test(pane))
check('Fix asks for it', app.includes('paneRedraw.get(target)'))
check('...and says so only when it happened', app.includes("'Display and history repaired.'"))

console.log(fail ? `\n${fail} failed` : '\nall good')
process.exit(fail ? 1 : 0)
