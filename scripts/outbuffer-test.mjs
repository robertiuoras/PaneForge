// Text remains an exact tail; clipped terminal output also carries its DEC modes.
//
//   node scripts/outbuffer-test.mjs
//
// Run against the built main bundle so the test covers what actually ships.
import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src/main/outBuffer.ts')
assert.ok(existsSync(src), 'src/main/outBuffer.ts is missing')

// The class is dependency-free, so it is compiled straight out of the source file with
// the compiler the repo already has - no build step, and no second copy of the logic in
// the test to drift from the one that ships.
const { readFileSync } = await import('node:fs')
const tsc = (await import('typescript')).default
const modesSource = readFileSync(join(root, 'src/shared/terminalModes.ts'), 'utf8')
const js = tsc.transpileModule((modesSource + '\n' + readFileSync(src, 'utf8').replace(/^import .*$/gm, '')).replace(/^export /gm, ''), {
  compilerOptions: { target: tsc.ScriptTarget.ES2022, module: tsc.ModuleKind.None }
}).outputText
const { OutBuffer, TerminalModes } = new Function(`${js}; return { OutBuffer, TerminalModes }`)()

const LIMIT = 100

// 1. Under the cap, it is exactly what went in.
let b = new OutBuffer(LIMIT)
b.push('hello ')
b.push('world')
assert.equal(b.read(), 'hello world')
assert.equal(b.length, 11)

// 2. Over the cap, it is the LAST `limit` characters and nothing older.
b = new OutBuffer(LIMIT)
let all = ''
for (let i = 0; i < 500; i++) {
  const chunk = `line ${i}\n`
  all += chunk
  b.push(chunk)
}
assert.equal(b.read(), all.slice(-LIMIT), 'tail must equal the last limit chars')
assert.equal(b.read().length, LIMIT)

// 3. A single chunk larger than the cap is still trimmed to the cap on read.
b = new OutBuffer(LIMIT)
b.push('x'.repeat(500))
assert.equal(b.read(), 'x'.repeat(LIMIT))

// 4. read() is stable and repeatable (it compacts in place - it must not consume).
b = new OutBuffer(LIMIT)
for (let i = 0; i < 50; i++) b.push(`${i},`)
const first = b.read()
assert.equal(b.read(), first, 'read twice must give the same tail')
b.push('tail')
assert.equal(b.read(), (first + 'tail').slice(-LIMIT))

// 5. set() replaces everything (a restart writes the reset sequence and starts over).
b.set('\x1bc')
assert.equal(b.read(), '\x1bc')
assert.equal(b.length, 2)

// 6. Empty pushes and an empty buffer are not special cases anywhere else.
b = new OutBuffer(LIMIT)
assert.equal(b.read(), '')
b.push('')
assert.equal(b.read(), '')

// Replay through the real headless terminal, not a second copy of the mode parser.
const { Terminal } = (await import('@xterm/headless')).default
async function state(text) {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  await new Promise((resolve) => term.write(text, resolve))
  const result = { buffer: term.buffer.active.type, mouse: term.modes.mouseTrackingMode,
    paste: term.modes.bracketedPasteMode, encoding: term._core.coreMouseService.activeEncoding,
    wrap: term.modes.wraparoundMode }
  term.dispose()
  return result
}
const startup = '\x1bc\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003;1006;2004h'
const stream = startup + 'rendered frame\r\n'.repeat(100)
b = new OutBuffer(200)
for (let i = 0; i < stream.length; i += 7) b.push(stream.slice(i, i + 7))
assert.deepEqual(await state(b.read()), await state(stream), 'clipped replay retains alternate, mouse, SGR and paste modes')
assert.equal(b.read(), b.read(), 'restoration must not become retained buffer content')
b.push('\x1b[?1049;1003;1006;2004l' + 'normal\r\n'.repeat(100))
assert.deepEqual(await state(b.read()), await state(stream + '\x1b[?1049;1003;1006;2004l'), 'discarded exits return to normal')
b.push('\x1bc' + 'reset\r\n'.repeat(100))
assert.deepEqual(await state(b.read()), await state('\x1bc'), 'RIS clears all remembered modes')
b.set('new session')
assert.equal(b.read(), 'new session', 'set resets discarded-prefix modes')
b.clear()
assert.equal(b.read(), '')

for (const command of ['\x1b[?1049h', '\x1b[?1003;1006;2004h', '\x1b[?1049;1003;1006;2004l', '\x1bc']) {
  for (let cut = 1; cut < command.length; cut++) {
    const tracker = new TerminalModes()
    tracker.consume(startup + command.slice(0, cut))
    const tail = command.slice(cut) + 'tail'
    assert.deepEqual(await state(tracker.restorePrefix(tail) + tail), await state(startup + command + 'tail'), `split setter at ${cut}: ${JSON.stringify(command)}`)
  }
}
const tracker = new TerminalModes()
for (const ch of '\x1b[?47h\x1b[?1047h\x1b[?1049l') tracker.consume(ch)
assert.equal(tracker.alternate, false, 'any alternate exit selects normal buffer')
tracker.consume('\x1b]0;title \x1b[?1049h\x07')
assert.equal(tracker.alternate, false, 'mode-like title text is not a setter')
tracker.consume('\x1bPpayload \x1b[?1049h\x1b\\')
assert.equal(tracker.alternate, false, 'mode-like DCS payload is not a setter')
tracker.consume('\x1b[?' + '1'.repeat(10_000) + 'h')
assert.equal(tracker.alternate, false, 'overlong CSI is bounded and ignored')
tracker.consume('\x1b[?6')
assert.equal(tracker.restorePrefix('n'), '', 'a split device query must never be replayed')
for (const [start, end] of [['\x1b]0;title ', '\x07'], ['\x1bP$q', '\x1b\\']]) {
  const partial = new TerminalModes()
  partial.consume(start)
  const tail = '\x1b[?1049h' + end + 'after'
  assert.deepEqual(await state(partial.restorePrefix(tail) + tail), await state(start + tail), 'clipped string payload cannot become an alternate-screen setter')
}

// Native text-run skipping must still notice every introducer, including a setter
// split at the disk reader's 64 KiB boundary, C1 controls and a cancelled CSI.
const boundary = 'text '.repeat(13_107) + '\x1b[?1049hplain\x9b?1003;1006;2004h\x1b[?1049\x18ordinary'
const whole = new TerminalModes()
whole.consume(boundary)
for (const size of [1, 7, 65_536]) {
  const split = new TerminalModes()
  for (let i = 0; i < boundary.length; i += size) split.consume(boundary.slice(i, i + size))
  assert.equal(split.restorePrefix(), whole.restorePrefix(), `text-run skipping retains incremental semantics at chunk size ${size}`)
}
assert.deepEqual(await state(whole.restorePrefix()), await state(startup), 'C1 setters survive ordinary runs and cancellation')

// Exercise six maximum-sized logs in reader-sized chunks. Report measured scan time
// without a machine-dependent deadline; mode equality is the correctness gate.
const LOG_CAP = 8 * 1024 * 1024
const paintLine = '\x1b[2K\x1b[38;5;244m' + 'agent is showing current implementation progress '.repeat(5) + '\x1b[0m\r\n'
const scanLog = startup + paintLine.repeat(Math.ceil(LOG_CAP / paintLine.length)).slice(0, LOG_CAP - startup.length)
const scanStart = performance.now()
for (let pane = 0; pane < 6; pane++) {
  const modes = new TerminalModes()
  for (let i = 0; i < scanLog.length; i += 65_536) modes.consume(scanLog.slice(i, i + 65_536))
  assert.equal(modes.restorePrefix(), whole.restorePrefix(), 'maximum log scans preserve startup modes')
}
console.log(`six 8 MiB paint logs in 64 KiB chunks: ${(performance.now() - scanStart).toFixed(1)}ms`)

// 7. The point of the whole class: appending stays cheap once the tail is at its cap.
//    A concat+slice per chunk is O(limit); this must not be. Compared against a real
//    400 KB cap, which is what ships.
const REAL = 400_000
const CHUNK = 'the agent says something reasonably long here\r\n'
b = new OutBuffer(REAL)
while (b.length < REAL) b.push(CHUNK)
const t0 = process.hrtime.bigint()
for (let i = 0; i < 20_000; i++) b.push(CHUNK)
const chunked = Number(process.hrtime.bigint() - t0) / 1e6

let s = b.read()
const t1 = process.hrtime.bigint()
for (let i = 0; i < 20_000; i++) s = (s + CHUNK).slice(-REAL)
const naive = Number(process.hrtime.bigint() - t1) / 1e6

console.log(`20k appends at a full 400 KB cap: chunked ${chunked.toFixed(1)}ms, concat+slice ${naive.toFixed(1)}ms`)
assert.ok(chunked * 4 < naive, `chunked append must be far cheaper (${chunked.toFixed(1)}ms vs ${naive.toFixed(1)}ms)`)

console.log('outbuffer: all checks passed')
