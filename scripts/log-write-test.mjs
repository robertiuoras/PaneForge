// Exercise delayed writes, compaction and failure recovery without a real stalled disk.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transform } from 'esbuild'

const files = new Map()
const events = []
let release
let blockedFile
let failingFile
let reads = 0
const nextTurn = () => new Promise(resolve => setImmediate(resolve))
const mock = {
  mkdir: async () => {},
  stat: async file => ({ size: Buffer.byteLength(files.get(file) ?? '') }),
  readFile: async file => { reads++; return files.get(file) ?? '' },
  rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from) },
  truncate: async file => files.set(file, ''),
  appendFile: async (file, text) => {
    events.push(`append:${text}`)
    if (file === blockedFile) { blockedFile = null; await new Promise(resolve => { release = resolve }) }
    if (file === failingFile) { failingFile = null; throw new Error('test disk error') }
    files.set(file, (files.get(file) ?? '') + text)
  },
  writeFile: async (file, text) => {
    events.push(`replace:${text}`)
    if (file === blockedFile) { blockedFile = null; await new Promise(resolve => { release = resolve }) }
    files.set(file, text)
  }
}
globalThis.__logWriteFs = mock
let source = readFileSync(new URL('../src/main/logWrite.ts', import.meta.url), 'utf8')
source = source.replace(/import \{([^}]+)\} from 'node:fs\/promises'/, 'const {$1} = globalThis.__logWriteFs')
const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' })
const { appendLog, rewriteLog, writeLatest, flushLogsOnExit } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

blockedFile = '/ordered'
appendLog('/ordered', 'A')
appendLog('/ordered', 'B')
rewriteLog('/ordered', 'AB compacted')
appendLog('/ordered', 'C')
await nextTurn()
assert.deepEqual(events, ['append:A'], 'later operations wait behind the outstanding write')
release()
await nextTurn()
assert.equal(files.get('/ordered'), 'AB compactedC', 'compaction and appends keep caller order')
console.log('ok delayed append, compaction and append retain order')

failingFile = '/failure'
appendLog('/failure', 'lost')
appendLog('/failure', 'kept')
await nextTurn()
assert.equal(files.get('/failure'), 'kept')
console.log('ok a failed write does not poison the next write')

blockedFile = '/latest'
writeLatest('/latest', 'one')
await nextTurn()
writeLatest('/latest', 'two')
writeLatest('/latest', 'three')
release()
await nextTurn()
assert.equal(files.get('/latest'), 'three')
assert(!events.includes('replace:two'), 'superseded snapshot is coalesced')
console.log('ok snapshots coalesce while a disk write is outstanding')

appendLog('/small', 'short', { halveAt: 100 })
await nextTurn()
assert.equal(reads, 0, 'below-threshold logs are not read back on every append')
appendLog('/small', '\nnext\nlast\n', { halveAt: 5 })
await nextTurn()
assert.equal(files.get('/small'), 'last\n')
console.log('ok trimming reads only logs above the byte threshold')
blockedFile = '/exit'
appendLog('/exit', 'terminal')
await nextTurn()
let flushed = false
const flush = flushLogsOnExit().then(() => { flushed = true })
await nextTurn()
assert.equal(flushed, false, 'exit waits for pending diagnostics')
release()
await flush
assert.equal(files.get('/exit'), 'terminal')
blockedFile = '/stalled'
appendLog('/stalled', 'late')
await nextTurn()
await flushLogsOnExit()
assert.equal(files.has('/stalled'), false, 'stalled disk cannot hold exit indefinitely')
release()
await nextTurn()
console.log('ok exit flush waits for writes and bounds stalled disk wait')
delete globalThis.__logWriteFs
