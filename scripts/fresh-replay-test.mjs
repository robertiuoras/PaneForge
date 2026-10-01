import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { transformSync } from 'esbuild'
const source = readFileSync(new URL('../src/shared/freshReplay.ts', import.meta.url), 'utf8')
const { freshReplay } = await import('data:text/javascript;base64,' + Buffer.from(transformSync(source, { loader: 'ts', format: 'esm' }).code).toString('base64'))
assert.equal(freshReplay('', 'current'), 'current')
assert.equal(freshReplay('saved', ''), 'saved')
assert.equal(freshReplay('old\r\ncurrent', 'current'), 'old\r\ncurrent', 'already current snapshot is unchanged')
assert.equal(freshReplay('old\r\nshared', 'shared\r\nnew'), 'old\r\nshared\r\nnew', 'partial overlap is appended once')
assert.equal(freshReplay('old😀雪', '😀雪new'), 'old😀雪new', 'Unicode overlap is exact')
assert.equal(freshReplay('old\x1b[38;2;12', '\x1b[38;2;12;34;56mnew'), 'old\x1b[38;2;12;34;56mnew', 'overlap completes a split control sequence')
const clipped = 'shared' + 'x'.repeat(400_000 - 6)
assert.equal(freshReplay('old\r\n' + clipped, '\x1b[?1049;1003;1006;2004h' + clipped), 'old\r\n' + clipped, 'synthetic retained modes do not conceal overlap')
assert.equal(freshReplay('oldshared', '\x1b[?1049hshared'), 'oldshared\x18\x1b[?1049hshared', 'an actual leading alternate-screen setter is never mistaken for a synthetic prefix')
assert.equal(freshReplay('old', '\x1b[?25hnew'), 'old\x18\x1b[?25hnew', 'actual cursor mode is retained')
assert.equal(freshReplay('old\x1b[', '\x1b[?1049hnew'), 'old\x1b[?1049hnew', 'exact overlap completes an unfinished mode setter once')
assert.equal(freshReplay('old\x1b]', '\x1b[?1049hnew'), 'old\x1b]\x18\x1b[?1049hnew', 'disjoint streams cancel an unfinished escape without discarding either stream')
const repetitive = 'ab'.repeat(200_000)
assert.equal(freshReplay('old' + repetitive, repetitive + 'new'), 'old' + repetitive + 'new', 'repetitive TUI output retains longest overlap')
const index = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
assert.equal((index.match(/freshReplay\(history\.tail/g) ?? []).length, 3, 'local and remote log/replay use current bytes')
const pane = readFileSync(new URL('../src/renderer/src/components/TerminalPane.tsx', import.meta.url), 'utf8')
const reset = pane.slice(pane.indexOf('    const receiveReset = ('), pane.indexOf('    const writeData ='))
assert.match(reset, /writeStaged\('[\s\S]*?pendingDataWrites--[\s\S]*?needRestoreFix\.current = true\s+armRestoreFix\(\)/, 'reset requests a settled native frame after parse')
const { Terminal } = createRequire(import.meta.url)('@xterm/headless')
const t = new Terminal({ cols: 134, rows: 53, allowProposedApi: true })
try {
  const stale = '\x1b[?1049h\x1b[53;1HOLD STATUS'
  const live = '\x1b[?1049h\x1b[53;20HNEW TOKENS'
  await new Promise(r => t.write(freshReplay(stale, live), r))
  // A disjoint incremental tail is explicitly not a complete frame. The native
  // redraw supplied after settled replay is what resolves missing cursor state.
  assert.match(t.buffer.active.getLine(52).translateToString(true), /OLD STATUS/)
  await new Promise(r => t.write('\x1b[H\x1b[2J\x1b[53;1HCURRENT STATUS', r))
  assert.equal(t.buffer.active.getLine(52).translateToString(true), 'CURRENT STATUS')
} finally { t.dispose() }
console.log('fresh replay: current, overlap, Unicode, modes, disjoint redraw, and source routing passed')
