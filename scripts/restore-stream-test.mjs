// Regression: an animated raw tail is not a screen, and live deltas must follow
// the snapshot boundary, including while xterm parses a staged-width restore.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'
import { runInNewContext } from 'node:vm'
import xterm from '@xterm/headless'
const src = readFileSync(new URL('../src/renderer/src/components/TerminalPane.tsx', import.meta.url), 'utf8')
const js = code => transformSync(code, { loader: 'ts', target: 'node20' }).code
const between = (a, b) => src.slice(src.indexOf(a), src.indexOf(b, src.indexOf(a)))

// Execute the actual debounce with a deterministic clock, no wall-clock sleeps.
let now = 100, serial = 0, repairs = 0
const timers = new Map()
const needRestoreFix = { current: true }, host = { current: { offsetParent: {} } }, asleepRef = { current: false }
const arm = runInNewContext(js(between('    let fixTimer:', '    armFix.current =')) + '\narmRestoreFix', {
  needRestoreFix, host, asleepRef, Date: { now: () => now }, RESTORE_FIX_MS: 1200,
  runRestoreFix: () => { repairs++; needRestoreFix.current = false },
  window: { clearTimeout: id => timers.delete(id), setTimeout: (fn, delay) => { timers.set(++serial, { fn, at: now + delay }); return serial } }
})
for (; now <= 5100; now += 100) {
  arm()
  for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn() }
}
assert.equal(repairs, 1, 'continuous animation cannot starve the restore repair')
needRestoreFix.current = true
host.current.offsetParent = null
arm()
assert.equal(timers.size, 0, 'hidden pane keeps recovery pending without a timer')
host.current.offsetParent = {}
asleepRef.current = true
arm()
assert.equal(timers.size, 0, 'asleep pane is never poked')
asleepRef.current = false
arm()
assert.equal([...timers.values()][0].at, now + 1200, 'visibility/wake gets a fresh quiet window')

// A synthetic version of the observed Codex stream: a base screen followed by
// enough cursor-addressed animation to evict it from the 400 kB raw tail.
const base = '\x1b[HBASE SCREEN\r\nPROMPT\r\n'
const animation = '\x1b[5;1H.' .repeat(60000)
const snapshot = base + animation
const tail = new xterm.Terminal({ cols: 91, rows: 59, allowProposedApi: true })
await new Promise(resolve => tail.write(snapshot.slice(-400000), resolve))
assert.equal(tail.buffer.active.getLine(0).translateToString(true).includes('BASE SCREEN'), false)
tail.dispose()

for (const mode of ['plain', 'staged', 'cancel']) {
  const staged = mode !== 'plain'
  const term = new xterm.Terminal({ cols: 91, rows: 59, allowProposedApi: true })
  let job, reset, delta, marks = 0, disposed = 0, typed = 0
  const list = [{ marker: { dispose: () => disposed++ } }]
  const noop = () => {}
  const api = {
    onPaneReset: fn => { reset = fn; return noop }, onData: fn => { delta = fn; return noop },
    replayHistory: async () => {
      // This delta is already in the snapshot. It must not be appended twice.
      delta('pane', '\x1b[HOLD FRAME')
      reset('pane', snapshot + '\x1b[7;1HBOUNDARY')
      // Arrives before xterm's snapshot write callback, after main's boundary.
      delta('pane', '\x1b[8;1HAFTER SNAPSHOT')
      return true
    }
  }
  if (mode === 'cancel') {
    // Disposal can prevent any pending parse callback from running.
    term.write = () => {}
  }
  const context = {
    api, sessionId: 'pane', queueReplay: j => { job = j }, activeRef: { current: true }, visibleRef: { current: false },
    mirrorRef: { current: true },
    t: term, f: {}, keep: x => x, withoutReplayQueries: x => x,
    needRestoreFix: { current: false }, armRestoreFix: noop, pinned: { current: true }, setBlank: noop,
    seedMarks: () => marks++, reshape: noop, replayColsRef: { current: 120 }, replaying: { current: false },
    restorePromptMarks: async () => {},
    // The old pane's SHAPE, not just its width: antigravity's frame is drawn against the
    // terminal height, so the staged replay is written at both and handed back at both.
    replayRowsRef: { current: 24 },
    splitReplay: (bytes, _cols, _now, rows) =>
      staged ? { before: bytes, after: '\x1b[9;1HSTAGED END', cols: 120, rows } : null,
    list, publish: noop, pendingDataWrites: 0, drainTyped: () => typed++, sawOutput: false,
    lastByteAt: { current: 0 }, lastBusyCheck: Date.now(), checkBusy: noop, settle2: undefined,
    window: { clearTimeout: noop, setTimeout: noop }, armWipeCheck: noop, bumpTotal: noop,
    dead: false, scrollIntent: { current: 0 }, setScrolledUp: noop,
    wipeTimer: undefined, wipeSnap: null, makeKeeper: () => x => x, readingSnapshot: false
  }
  const cancel = runInNewContext(js(between('    let gone = false', '    /**\n     * Whether the agent')) + js(between('    const offReset =', '    /**\n     * Full repair')) + '\n(() => { gone = true; finishInitialReplay?.(); initialReplay = undefined })', context)
  const completed = job.run()
  if (mode === 'cancel') {
    cancel()
    let timer
    try { await Promise.race([completed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('disposed pane held the replay queue')), 1000) })]) }
    finally { clearTimeout(timer); term.dispose() }
    continue
  }
  await completed
  const row = n => term.buffer.active.getLine(n).translateToString(true)
  assert.equal(row(0), 'BASE SCREEN', 'base screen survives animation-heavy restore')
  assert.equal(row(6), 'BOUNDARY', 'snapshot replaces pre-boundary live data')
  assert.equal(row(7), 'AFTER SNAPSHOT', 'new deltas follow the entire snapshot')
  if (staged) assert.equal(row(8), 'STAGED END', 'staged tail was parsed before later deltas')
  assert.equal(term.cols, 91, 'live deltas use the current width')
  assert.equal(term.rows, 59, 'and the pane is handed back its own height after a staged replay')
  assert.equal(disposed, 1, 'obsolete pre-snapshot markers are disposed')
  assert.equal(marks > 0 && typed > 0, true)
  term.dispose()
}
console.log('restore-stream: animated tail, bounded repair, hidden/asleep guards and ordered staged replay passed')
