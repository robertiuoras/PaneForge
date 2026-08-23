// Replay Robert's REAL pane log through the shipped keeper into a real headless xterm,
// and see what the scrollback holds either side of his last /clear.
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

const root = '/Users/robertiuoras/Projects/PaneForge'
const out = join(tmpdir(), 'pf-repro-keep.cjs')
buildSync({ absWorkingDir: root, entryPoints: ['src/shared/keepScrollback.ts'], bundle: true, format: 'cjs', platform: 'node', outfile: out })
const req = createRequire(import.meta.url)
const { keepScrollback, keptRows, mayClearScreen } = req(out)
const lossOut = join(tmpdir(), 'pf-repro-loss.cjs')
buildSync({ absWorkingDir: root, entryPoints: ['src/shared/screenLoss.ts'], bundle: true, format: 'cjs', platform: 'node', outfile: lossOut })
const { screenLost, lostRows, fileRows } = req(lossOut)
const { Terminal } = req('@xterm/headless')

const log = readFileSync(join(homedir(), 'Library/Application Support/claude-orchestrator/history/s1-mt5w0f6v.log'))
const bannerAt = log.lastIndexOf(Buffer.from('~/Projects/PaneForge\x1b[39m'))
// The clear starts at the ESC[H that begins the erase-per-row walk.
const clearAt = Number(process.argv[2])
const before = log.subarray(Math.max(0, clearAt - 400000), clearAt).toString('utf8')
const during = log.subarray(clearAt, bannerAt + 3000).toString('utf8')
console.log('clearAt', clearAt, 'bannerAt', bannerAt, 'before bytes', before.length)

const ROWS = 40, COLS = 159
function run (armed) {
  const t = new Terminal({ rows: ROWS, cols: COLS, scrollback: 100000, allowProposedApi: true })
  let wipes = 0
  const keep = keepScrollback(() => ROWS, () => false, Date.now, () => keptRows(t), () => { wipes++ })
  const write = (s) => new Promise((r) => t.write(keep(s), r))
  return (async () => {
    await write(before)
    const baseBefore = t.buffer.active.baseY
    const screen = []
    for (let y = 0; y < ROWS; y++) screen.push(t.buffer.active.getLine(t.buffer.active.baseY + y)?.translateToString(true) ?? '')
    if (armed) await new Promise((r) => t.write(keep.arm(), r))
    await write(during)
    const baseAfter = t.buffer.active.baseY
    const after = []
    for (let y = 0; y < ROWS; y++) after.push(t.buffer.active.getLine(t.buffer.active.baseY + y)?.translateToString(true) ?? '')
    let filed = 0
    if (!armed && wipes) {
      const lost = lostRows(screen, after)
      if (screenLost(screen, after)) { await new Promise((r) => t.write(fileRows(lost, ROWS), r)); filed = lost.length }
    }
    // How much of the pre-clear screen can still be found anywhere in the buffer?
    const all = []
    for (let y = 0; y < t.buffer.active.baseY + ROWS; y++) all.push(t.buffer.active.getLine(y)?.translateToString(true).trim() ?? '')
    const hay = all.join('\n')
    const want = screen.map((r) => r.trim()).filter((r) => r.length >= 6)
    const kept = want.filter((r) => hay.includes(r)).length
    return { armed, wipes, filed, baseBefore, baseAfter, grew: baseAfter - baseBefore, want: want.length, kept, keptRowsAtClear: keptRows(t) }
  })()
}
console.log('ARMED   ', await run(true))
console.log('UNARMED ', await run(false))
