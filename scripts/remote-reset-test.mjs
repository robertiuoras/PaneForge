// Exercise the shipped renderer reset callback with a real xterm and a delayed IPC
// buffer read. A streamed delta must appear exactly once after the reset snapshot.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless')
const source = readFileSync(new URL('../src/renderer/src/components/TerminalPane.tsx', import.meta.url), 'utf8')
const start = source.indexOf('const offReset = api.onPaneReset(')
const end = source.indexOf('\n    const off = api.onData', start)
assert.ok(start > 0 && end > start)
const callback = transformSync(source.slice(start, end), { loader: 'ts' }).code
const keeperStart = source.indexOf('let readingSnapshot = false')
const keeperEnd = source.indexOf('const f = new FitAddon()', keeperStart)
assert.ok(keeperStart > 0 && keeperEnd > keeperStart)
const factory = transformSync(source.slice(keeperStart, keeperEnd), {loader:'ts'}).code
const keeperSource = readFileSync(new URL('../src/shared/keepScrollback.ts', import.meta.url), 'utf8')
const { keepScrollback } = await import('data:text/javascript;base64,' + Buffer.from(transformSync(keeperSource, {loader:'ts',format:'esm'}).code).toString('base64'))
const t = new Terminal({ cols: 80, rows: 10, allowProposedApi: true })
let reset, resolveRead, reads = 0
const api = {
  onPaneReset(fn) { reset = fn; return () => {} },
  getBuffer() { reads++; return new Promise(resolve => { resolveRead = resolve }) }
}
const install = new Function('api', 't', 'keepScrollback', `
  const sessionId = 'remote', list = [], dead = false;
  let sawOutput = false;
  let wipeSnap = null, wipeTimer;
  const window = { clearTimeout }, publish = () => {}, setBlank = () => {}, pinned = { current: true }, seedMarks = () => {};
  const keptRows = () => { throw new Error('read stale screen during snapshot'); };
  const screenNow = () => { throw new Error('armed stale wipe during snapshot'); };
  const armWipeCheck = () => {};
  ${factory}
  ${callback}
  return { pinned };
`)
const { pinned } = install(api, t, keepScrollback)
t.write('stale queued output\r\n')
reset('remote', 'before\r\n')
await new Promise(resolve => t.write('after\r\n', resolve))
resolveRead?.('before\r\nafter\r\n')
await new Promise(resolve => setImmediate(resolve))
await new Promise(resolve => t.write('', resolve))
const rows = Array.from({ length: t.buffer.active.length }, (_,r) => t.buffer.active.getLine(r).translateToString(true)).filter(Boolean)
assert.deepEqual(rows, ['before', 'after'], 'a delta arriving after reset is appended exactly once')
assert.equal(reads, 0, 'reset does not race a later read of a mutable buffer')
reset('remote', '')
await new Promise(resolve => t.write('new stream', resolve))
assert.equal(t.buffer.active.getLine(0).translateToString(true), 'new stream')
reset('remote', '\x1b[2J\x1b[Hclean screen')
await new Promise(resolve => t.write('', resolve))
assert.equal(t.buffer.active.getLine(0).translateToString(true), 'clean screen', 'a clear in the snapshot never restores stale screen contents')
// A pane that was following output still follows it after the replacement. This is the
// normal landing for a newly opened mirror as well, because its initial tail gap is zero.
pinned.current = true
reset('remote', Array.from({ length: 45 }, (_, i) => `following ${i}\r\n`).join(''))
await new Promise(resolve => t.write('', resolve))
assert.equal(
  t.buffer.active.baseY - t.buffer.active.viewportY,
  0,
  'a following pane lands on the newest line after a remote reset'
)
// A reconnect replaces the terminal's whole buffer. It must retain a reader's place in
// scrollback, rather than treating that network event as a request to jump to the tail.
await new Promise(resolve => t.write(Array.from({ length: 30 }, (_, i) => `old ${i}\r\n`).join(''), resolve))
t.scrollToTop()
pinned.current = false
const beforeGap = t.buffer.active.baseY - t.buffer.active.viewportY
reset('remote', Array.from({ length: 45 }, (_, i) => `new ${i}\r\n`).join(''))
await new Promise(resolve => t.write('', resolve))
assert.equal(
  t.buffer.active.baseY - t.buffer.active.viewportY,
  Math.min(beforeGap, t.buffer.active.baseY),
  'a remote reset preserves the reader\'s distance from the newest output, capped at its new top'
)
t.dispose()
console.log('remote reset: ordered snapshot, clean reset, and preserved scroll position passed')
