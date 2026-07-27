// The retained pty tail must survive being kept as chunks: what a pane redraws itself
// from is this string, so "the last N characters, exactly" is the whole contract.
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
const js = tsc.transpileModule(readFileSync(src, 'utf8').replace(/^export /gm, ''), {
  compilerOptions: { target: tsc.ScriptTarget.ES2022, module: tsc.ModuleKind.None }
}).outputText
const OutBuffer = new Function(`${js}; return OutBuffer`)()

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
