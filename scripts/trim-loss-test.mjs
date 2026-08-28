// Lowering xterm's `scrollback` option DELETES lines. It is not a cap.
//
// `shared/capacity.ts` gives scrollback back under memory pressure, and the renderer used
// to implement "give it back later" as raising the number again. It does not work, and it
// cost Robert the readable history of a pane he had not looked at for a while (2026-08-27:
// "i cant scroll up and see the history of the chat"). This pins the behaviour so nobody
// re-derives the wrong recovery: the bytes have to be re-rendered from main's own log
// (`paneRedraw` / `redrawHistory`), because xterm cannot give back what it dropped.
//
//   node scripts/trim-loss-test.mjs

import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
let Terminal
try {
  ;({ Terminal } = require_('@xterm/headless'))
} catch {
  console.log('trim loss: SKIPPED - @xterm/headless is not installed')
  process.exit(0)
}

let failed = 0
const ok = (what, cond, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${extra ? ` - ${extra}` : ''}`)
}

const t = new Terminal({ cols: 80, rows: 10, scrollback: 20000, allowProposedApi: true })
const write = (d) => new Promise((res) => t.write(d, res))
for (let i = 0; i < 500; i++) await write(`line ${i}\r\n`)

const before = t.buffer.active.length
ok('the buffer holds every line at full depth', before === 501, `got ${before}`)

t.options.scrollback = 200
await new Promise((r) => setTimeout(r, 20))
const after = t.buffer.active.length
ok('lowering the option DROPS lines, it does not cap them', after < before, `${before} -> ${after}`)
ok(
  '...and the oldest line on screen is no longer line 0',
  t.buffer.active.getLine(0)?.translateToString(true).trim() !== 'line 0',
  JSON.stringify(t.buffer.active.getLine(0)?.translateToString(true).trim())
)

const lostFirst = t.buffer.active.getLine(0)?.translateToString(true)
t.options.scrollback = 20000
await new Promise((r) => setTimeout(r, 20))
ok('raising it back restores NOTHING', t.buffer.active.length === after, `got ${t.buffer.active.length}`)
ok(
  '...which is why the recovery has to re-render from the raw log',
  t.buffer.active.getLine(0)?.translateToString(true) === lostFirst
)

// And the recovery has to reach the pane somebody is LOOKING at.
//
// A focused pane is never trimmed, so `trimPlan` can only hand it back at full depth when
// its lines were deleted while it was in the background - the pane just switched to. The
// renderer used to skip the active pane when re-rendering, which left that one pane with
// its option restored and none of its history. Measured 2026-08-28: load 2.51-3.17 per
// core keeps `assess` at `over` for hours here, so this is the ordinary case, not an edge.
const { readFileSync } = await import('node:fs')
const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
const loop = /for \(const id of regrown\)[\s\S]{0,200}?paneRedraw\.get\(id\)/.exec(app)?.[0] ?? ''
ok('the regrow re-render is not skipped for the focused pane', loop !== '' && !/activeId/.test(loop), JSON.stringify(loop.slice(0, 120)))

const { trimPlan } = await import('../src/shared/capacity.ts').catch(() => ({}))
if (trimPlan) {
  const over = { level: 'over', trim: true }
  const plan = trimPlan([{ id: 'a', focused: true, visible: true, current: 2000 }], over)
  ok('a focused pane that was trimmed in the background is given every line back', plan.length === 1 && plan[0].scrollback === 20000, JSON.stringify(plan))
}

// ...and WHERE those bytes come from, which is the half that was still wrong.
//
// The re-render read `getBuffer` - main's live replay, capped at 400 KB because it is
// held in memory for every pane. An agent CLI's output is almost all repaint frames, so
// 400 KB of it is worth almost no scrollback: measured 2026-08-28 against this desk's own
// s13-mtcp8yry.log (3.67 MB) through a headless xterm at 120 cols, the last 400 KB gave
// 102 rows back and the last 4 MB gave 4,096, for 51 ms more. A pane handed a hundred
// lines of a four-thousand-line conversation is a pane you still cannot scroll up in,
// which is what Robert reported a second time on 2026-08-28.
const pane = readFileSync(new URL('../src/renderer/src/components/TerminalPane.tsx', import.meta.url), 'utf8')
const rd = /const redrawHistory = async[\s\S]{0,600}/.exec(pane)?.[0] ?? ''
ok('the re-render reads the log on disk, not the 400 KB live replay', /api\.paneLog\(sessionId, REDRAW_BYTES\)/.test(rd), JSON.stringify(rd.slice(0, 140)))
ok('...with getBuffer kept only as the fallback', /paneLog\([^)]*\)\)\s*\|\|\s*\(await api\.getBuffer/.test(rd))
ok('the budget is big enough to be worth the round trip', /REDRAW_BYTES = 4_000_000/.test(pane))

// The measurement itself, against the REAL artifact when this machine has one - a
// hand-written fixture cannot show this, because the whole effect is that a CLI's bytes
// are mostly repaints. Skips out loud rather than passing vacuously.
const { homedir } = await import('node:os')
const { join } = await import('node:path')
const { existsSync, readdirSync, statSync } = await import('node:fs')
const hist = join(homedir(), 'Library/Application Support/claude-orchestrator/history')
const big = existsSync(hist)
  ? readdirSync(hist)
      .filter((f) => f.endsWith('.log'))
      .map((f) => ({ f: join(hist, f), size: statSync(join(hist, f)).size }))
      .filter((x) => x.size > 2_000_000)
      .sort((a, b) => b.size - a.size)[0]
  : null
if (!big) {
  console.log('  SKIP no pane log over 2 MB on this machine - the byte budget is unmeasured here')
} else {
  const log = readFileSync(big.f)
  const rows = async (bytes) => {
    const term = new Terminal({ cols: 120, rows: 40, scrollback: 20000, allowProposedApi: true })
    await new Promise((r) => term.write(log.subarray(-bytes), r))
    const n = term.buffer.active.length - 40
    term.dispose()
    return n
  }
  const small = await rows(400_000)
  const full = await rows(4_000_000)
  ok(`4 MB gives materially more history than 400 KB - ${small} rows -> ${full} rows`, full > small * 4)
}

console.log(failed ? `\n${failed} failed` : '\ntrim loss: all good')
process.exit(failed ? 1 : 0)
