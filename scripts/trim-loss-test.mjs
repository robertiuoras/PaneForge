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

console.log(failed ? `\n${failed} failed` : '\ntrim loss: all good')
process.exit(failed ? 1 : 0)
