// What a live tee is allowed to put in the file, and when.
//
// `pipe.ts` is tmux's `pipe-pane`: something ELSE is reading that file while the pane
// is still running, so "the bytes arrive eventually" is not the contract - they have to
// be on disk while the pipe is open, and they have to be the bytes the pane printed.
//
// The failure modes are all at the seams, not in the happy path:
//   - an escape sequence cut in half by a chunk boundary leaves `1mb` in the file as
//     text if each half is stripped on its own,
//   - a trailing `\r` is a line ending or a cursor return depending on a byte that has
//     not arrived,
//   - whatever the stripper was holding when the tee stops is real output and must not
//     be dropped on the floor,
//   - and a tee pointed at a folder that does not exist must cost the pane nothing
//     worse than losing the tee. An unhandled stream 'error' would take the app down
//     from the path every keystroke's echo travels.
//
// Model-free and window-free.
//
//   node scripts/pipe-test.mjs

import { strict as assert } from 'node:assert'
import { buildSync } from 'esbuild'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-pipe-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

for (const rel of ['src/shared/ansi.ts', 'src/main/pipe.ts']) {
  assert.ok(existsSync(join(root, rel)), `${rel} is missing`)
}

// esbuild's own API, not its CLI: `node node_modules/esbuild/bin/esbuild` only works on
// Windows, where that path is a JS shim. On macOS and Linux it is the native binary.
const bundle = (entry, name) => {
  const outfile = join(work, name)
  buildSync({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile
  })
  return createRequire(import.meta.url)(outfile)
}

const { stripAnsi, AnsiStream } = bundle('src/shared/ansi.ts', 'ansi.bundle.cjs')
const { startPipe, stopPipe, stopAllPipes, pipeInfo, feedPipe } = bundle(
  'src/main/pipe.ts',
  'pipe.bundle.cjs'
)

let checks = 0
const eq = (actual, expected, msg) => {
  checks++
  assert.equal(actual, expected, msg)
}
const ok = (value, msg) => {
  checks++
  assert.ok(value, msg)
}

const p = (name) => join(work, name)
const readIf = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll the disk rather than guessing at a flush interval. */
async function until(fn, msg, ms = 2000) {
  const deadline = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > deadline) assert.fail(`${msg} (nothing after ${ms}ms)`)
    await sleep(10)
  }
}
const fileIs = (file, want, msg, ms) => until(() => readIf(file) === want, `${msg}; file held ${JSON.stringify(readIf(file))}, wanted ${JSON.stringify(want)}`, ms)

// ---------------------------------------------------------------------------
// 1. Raw mode is byte-exact. A tee in raw mode is what you replay into a terminal,
//    so a single stripped byte makes the file a different thing.
// ---------------------------------------------------------------------------
const RAW = '\x1b[31mred\x1b[0m and \x1b]0;title\x07 plain\r\n'
const rawFile = p('raw.log')
const rawInfo = startPipe('raw', { path: rawFile })
eq(rawInfo.path, rawFile, 'startPipe must report the path it was given')
eq(rawInfo.text, false, 'raw mode must report text:false')
eq(rawInfo.bytes, 0, 'a fresh tee has written nothing')
eq(rawInfo.dropped, 0, 'a fresh tee has dropped nothing')
ok(rawInfo.startedAt > 0, 'startedAt must be a real timestamp')
feedPipe('raw', RAW)

// ---------------------------------------------------------------------------
// 2. Live, not buffered: the bytes are on disk with the pipe still OPEN. Nothing
//    below may call stopPipe to make this pass - that is the whole feature.
// ---------------------------------------------------------------------------
await fileIs(rawFile, RAW, 'raw bytes must reach disk while the tee is still open')
ok(
  Buffer.compare(readFileSync(rawFile), Buffer.from(RAW, 'utf8')) === 0,
  'raw mode must be byte-identical to what was fed - no strip, no re-encode'
)
ok(pipeInfo('raw') !== undefined, 'the tee is still open after writing')
eq(pipeInfo('raw').bytes, Buffer.byteLength(RAW), 'bytes must count what was written')
stopPipe('raw')

// ---------------------------------------------------------------------------
// 3. Text mode strips the escape sequences.
// ---------------------------------------------------------------------------
const textFile = p('text.log')
const TEXT_IN = '\x1b[32mgreen\x1b[0m \x1b]0;window title\x07plain\n'
const textInfo = startPipe('text', { path: textFile, text: true })
eq(textInfo.text, true, 'text mode must report text:true')
feedPipe('text', TEXT_IN)
await fileIs(textFile, 'green plain\n', 'text mode must strip colour and OSC')
eq(readIf(textFile), stripAnsi(TEXT_IN), 'the streamed strip must equal stripAnsi of the whole input')
stopPipe('text')

// ---------------------------------------------------------------------------
// 4. An escape sequence cut in half by a chunk boundary. `\x1b[3` + `1mb` is ONE
//    colour change; stripping the halves separately leaves `1mb` in the file as text.
//    The first half must also not be written raw while it waits.
// ---------------------------------------------------------------------------
const splitFile = p('split.log')
startPipe('split', { path: splitFile, text: true })
feedPipe('split', 'a\x1b[3')
await fileIs(splitFile, 'a', 'only the decidable prefix may be written')
eq(readIf(splitFile).includes('\x1b'), false, 'a half-written escape must never reach the file')
eq(readIf(splitFile).includes('[3'), false, 'the parameter bytes must not be written as text')
eq(pipeInfo('split').bytes, 1, 'bytes must count only what was actually written')
feedPipe('split', '1mb')
await fileIs(splitFile, 'ab', 'the rejoined sequence must strip whole - never a stray `1mb`')
eq(readIf(splitFile), stripAnsi('a\x1b[31mb'), 'split feed must match the unsplit strip')
stopPipe('split')

// The same seam without the file in the way, and both directions of the AnsiStream
// contract: what it emits now, and what it was holding.
{
  const s = new AnsiStream()
  eq(s.push('a\x1b[3'), 'a', 'AnsiStream must hold an unfinished escape back')
  eq(s.push('1mb'), 'b', 'the held escape must strip once its terminator arrives')
  eq(s.end(), '', 'nothing may be left over once the sequence completed')
}

// ---------------------------------------------------------------------------
// 5. A trailing `\r` is undecidable: `\r\n` is a line ending, a bare `\r` is a cursor
//    return that reads as a newline. Both must survive being split, and neither may
//    turn one line break into two.
// ---------------------------------------------------------------------------
{
  const s = new AnsiStream()
  eq(s.push('x\r'), 'x', 'a trailing lone `\\r` must be held back, not guessed at')
  const rest = s.push('\ny') + s.end()
  const crlf = 'x' + rest
  eq(crlf, stripAnsi('x\r\ny'), 'a split CRLF must equal the unsplit strip')
  eq(crlf.replace(/\r\n/g, '\n'), 'x\ny', 'a split CRLF must stay ONE line break')
  eq(/\n\n/.test(crlf), false, 'a split CRLF must not become two newlines')
}
{
  const s = new AnsiStream()
  eq(s.push('x\r'), 'x', 'a trailing lone `\\r` must be held back before a bare CR too')
  eq(s.push('y') + s.end(), '\ny', 'a bare CR arriving split must become a newline')
  eq('x' + '\ny', stripAnsi('x\ry'), 'a split bare CR must equal the unsplit strip')
}

// ...and through a real file, which is where a doubled newline would actually be seen.
const crlfFile = p('crlf.log')
startPipe('crlf', { path: crlfFile, text: true })
feedPipe('crlf', 'x\r')
await fileIs(crlfFile, 'x', 'the held `\\r` must not be written before its next byte')
feedPipe('crlf', '\ny')
await fileIs(crlfFile, stripAnsi('x\r\ny'), 'a CRLF split across chunks must land as one line break')
eq(readIf(crlfFile).replace(/\r\n/g, '\n'), 'x\ny', 'the CRLF file must read as x, newline, y')
stopPipe('crlf')

const crFile = p('cr.log')
startPipe('cr', { path: crFile, text: true })
feedPipe('cr', 'x\r')
feedPipe('cr', 'y')
await fileIs(crFile, 'x\ny', 'a bare CR split across chunks must become one newline')
stopPipe('cr')

// ---------------------------------------------------------------------------
// 6. stopPipe flushes what the stripper was holding. An escape sequence that never
//    finished is still bytes the pane printed; losing them silently is worse than
//    printing the `[`.
// ---------------------------------------------------------------------------
const heldFile = p('held.log')
startPipe('held', { path: heldFile, text: true })
feedPipe('held', 'a\x1b[')
await fileIs(heldFile, 'a', 'the unfinished escape is held while the tee is open')
stopPipe('held')
await fileIs(heldFile, stripAnsi('a\x1b['), 'stopPipe must flush what the stripper was holding')

// ---------------------------------------------------------------------------
// 7. After stopPipe the tee is gone: no further writes, no info.
// ---------------------------------------------------------------------------
eq(pipeInfo('held'), undefined, 'pipeInfo must be undefined once the tee is stopped')
const afterStop = readIf(heldFile)
feedPipe('held', 'MUST NOT APPEAR')
await sleep(60)
eq(readIf(heldFile), afterStop, 'feedPipe after stopPipe must write nothing')
stopPipe('held') // a second stop is a no-op, not a throw
eq(pipeInfo('held'), undefined, 'a second stopPipe must leave it stopped')

// ---------------------------------------------------------------------------
// 8. append keeps what was there; the default replaces it.
// ---------------------------------------------------------------------------
const appendFile = p('append.log')
writeFileSync(appendFile, 'HEAD\n')
startPipe('append', { path: appendFile, append: true })
feedPipe('append', 'more\n')
await fileIs(appendFile, 'HEAD\nmore\n', 'append:true must keep the existing content')
stopPipe('append')
startPipe('append', { path: appendFile })
feedPipe('append', 'fresh\n')
await fileIs(appendFile, 'fresh\n', 'the default must truncate the file')
stopPipe('append')

// ---------------------------------------------------------------------------
// 9. Starting a second tee on the same pane replaces the first: the old file must
//    stop growing rather than both being written for the rest of the run. Replacing
//    has to CLOSE the old tee, not just forget it - so the first tee is in text mode
//    holding an unfinished escape, and being replaced must flush it exactly as
//    stopPipe does. Overwriting the map entry alone leaves those bytes lost and the
//    old file handle open, and both files would look right without this.
// ---------------------------------------------------------------------------
const firstFile = p('first.log')
const secondFile = p('second.log')
startPipe('swap', { path: firstFile, text: true })
feedPipe('swap', 'one\n\x1b[')
await fileIs(firstFile, 'one\n', 'the first tee writes normally, holding the escape')
const swapped = startPipe('swap', { path: secondFile })
eq(swapped.path, secondFile, 'startPipe must return the NEW tee')
eq(pipeInfo('swap').path, secondFile, 'the pane must report the tee that replaced it')
await fileIs(firstFile, stripAnsi('one\n\x1b['), 'being replaced must flush the old tee, like stopPipe')
feedPipe('swap', 'two\n')
await fileIs(secondFile, 'two\n', 'the replacing tee gets the output')
await sleep(60)
eq(readIf(firstFile), stripAnsi('one\n\x1b['), 'the replaced tee must stop growing')
stopPipe('swap')

// ---------------------------------------------------------------------------
// 10. Backpressure accounting. The drop path is a CAP - it only fires when the stream
//     has more than 2 MB handed to it and not yet written, i.e. a tee pointed at a
//     disk or a network share slower than the pane. Forcing that here would mean
//     racing a real fs, so what is pinned instead is the invariant either side of it:
//     for normal traffic nothing is dropped and `bytes` equals what reached the file.
// ---------------------------------------------------------------------------
const bulkFile = p('bulk.log')
startPipe('bulk', { path: bulkFile })
const CHUNK = 'the agent says something reasonably long here\n'.padEnd(1024, '.')
const ROUNDS = 256
for (let i = 0; i < ROUNDS; i++) feedPipe('bulk', CHUNK)
const expected = Buffer.byteLength(CHUNK) * ROUNDS
eq(pipeInfo('bulk').dropped, 0, 'normal traffic must never drop')
eq(pipeInfo('bulk').bytes, expected, 'bytes must equal every byte handed to the stream')
await until(() => existsSync(bulkFile) && statSync(bulkFile).size === expected, `${expected} bytes must reach the file`)
stopPipe('bulk')

// ---------------------------------------------------------------------------
// 11. stopAllPipes closes every tee at once (it is what quitting calls) and each file
//     is complete, not truncated at whatever the last flush happened to be.
// ---------------------------------------------------------------------------
const many = ['m1', 'm2', 'm3'].map((id) => ({ id, file: p(`${id}.log`), body: `${id} line\n`.repeat(200) }))
for (const m of many) {
  startPipe(m.id, { path: m.file })
  feedPipe(m.id, m.body)
}
eq(many.every((m) => pipeInfo(m.id) !== undefined), true, 'all three tees are open before the sweep')
stopAllPipes()
eq(many.every((m) => pipeInfo(m.id) === undefined), true, 'stopAllPipes must retire every tee')
for (const m of many) await fileIs(m.file, m.body, `${m.id} must be complete after stopAllPipes`)

// ---------------------------------------------------------------------------
// 12. A path that cannot be opened. The failure arrives asynchronously, long after
//     startPipe returned, on a stream nothing else listens to - so the only two
//     acceptable outcomes are "the tee retires itself" and "the pane keeps running".
// ---------------------------------------------------------------------------
const badFile = join(work, 'no-such-dir', 'nope.log')
const bad = startPipe('bad', { path: badFile })
eq(bad.path, badFile, 'startPipe may still return an info object for a doomed path')

// The one window where an escaping error is caught rather than being allowed to end
// the run - kept as narrow as possible and containing NO assertions, because an
// uncaughtException handler swallows a failed assert in a top-level await too, and a
// test that exits 0 while printing nothing is worse than no test at all.
let leaked = null
const onLeak = (e) => {
  leaked = e
}
process.on('uncaughtException', onLeak)
feedPipe('bad', 'this goes nowhere\n') // must not throw
let retired = false
for (const deadline = Date.now() + 2000; Date.now() < deadline; ) {
  if (leaked) break
  if (pipeInfo('bad') === undefined) {
    retired = true
    break
  }
  await sleep(10)
}
process.off('uncaughtException', onLeak)

eq(leaked, null, `a stream error must not escape the module: ${leaked && leaked.message}`)
eq(retired, true, 'a stream error must retire the tee, not leave it looking open')
feedPipe('bad', 'still nowhere\n') // must not throw after the error either
stopPipe('bad') // must not throw
eq(existsSync(badFile), false, 'nothing may be created inside a directory that does not exist')

stopAllPipes()
await sleep(50)
rmSync(work, { recursive: true, force: true })

console.log(`pipe: all ${checks} checks passed`)
