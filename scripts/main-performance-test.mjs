// A queued native prompt must not reparse growing output on every idle sweep.
// Also prove the persisted, bounded, prompt-free evidence for slow recurring work.
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const work = join(tmpdir(), 'pf-main-performance-test')
rmSync(work, { recursive: true, force: true })
const home = join(work, 'codex')
const cwd = join(work, 'repo')
const dir = join(home, 'sessions', '2026', '09', '30')
mkdirSync(dir, { recursive: true }); mkdirSync(cwd, { recursive: true })
const bundle = join(work, 'transcripts.cjs')
buildSync({ absWorkingDir: root, stdin: { contents: readFileSync(join(root, 'src/main/transcripts.ts'), 'utf8') + '\nexport { codexSaidByPane };',
  resolveDir: join(root, 'src/main'), loader: 'ts' }, bundle: true,
  platform: 'node', format: 'cjs', outfile: bundle, define: { 'process.env.CODEX_HOME': JSON.stringify(home) } })
const t = createRequire(import.meta.url)(bundle)
const id = '12345678-1234-1234-1234-123456789abc'
const file = join(dir, 'rollout.jsonl')
const row = value => JSON.stringify(value) + '\n'
const user = text => row({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })
const output = row({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(1024 * 1024) }] } })
writeFileSync(file, row({ type: 'session_meta', payload: { id, cwd, timestamp: new Date().toISOString() } }) + user('uniquely identify the original pane') + output.repeat(8))
t.noteSession('p', cwd, 'codex')
t.noteSubmittedPrompt('p', 'uniquely identify the original pane')
assert.equal(t.resumeIdFor('p'), id)
t.noteSubmittedPrompt('p', 'a queued prompt not yet in native history 🦊')
const before = t.reads.codexProofBytes
for (let i = 0; i < 100; i++) assert.equal(t.resumeIdFor('p'), id)
assert.equal(t.reads.codexProofBytes - before, statSync(file).size, '100 misses read the original output once')
const initial = t.reads.codexProofBytes
for (let i = 0; i < 20; i++) {
  appendFileSync(file, output)
  for (let j = 0; j < 5; j++) assert.equal(t.resumeIdFor('p'), id)
}
assert.equal(t.reads.codexProofBytes - initial, Buffer.byteLength(output) * 20, 'growing output reads each appended byte once')
const bytes = Buffer.from(user('a queued prompt not yet in native history 🦊'))
const split = bytes.indexOf(Buffer.from('🦊')) + 2
appendFileSync(file, bytes.subarray(0, split))
assert.equal(t.resumeIdFor('p'), id)
appendFileSync(file, bytes.subarray(split))
assert.equal(t.resumeIdFor('p'), id)
const confirmed = t.reads.codexProofBytes
for (let i = 0; i < 100; i++) assert.equal(t.resumeIdFor('p'), id)
assert.equal(t.reads.codexProofBytes, confirmed, 'a completed delayed UTF-8 user row settles the proof')
t.forgetSession('p')
console.log('ok pending Codex proof reads 28MB growing history once, preserves split UTF-8 and stable ownership')

const proof = join(work, 'proof.jsonl')
writeFileSync(proof, user('first pending proof'))
assert.equal(t.codexSaidByPane(proof, ['first pending proof']), true)
assert.equal(t.codexSaidByPane(proof, ['other pending proof']), false, 'changed queries invalidate positive proof')
writeFileSync(proof, user('other pending proof'))
assert.equal(t.codexSaidByPane(proof, ['other pending proof']), true, 'same-size rewrites invalidate negative proof')
writeFileSync(proof, '')
assert.equal(t.codexSaidByPane(proof, ['other pending proof']), false, 'truncation invalidates positive proof')
writeFileSync(proof, user('other pending proof').trimEnd().replace('"user"', '"\\u0075ser"'))
assert.equal(t.codexSaidByPane(proof, ['other pending proof']), true, 'escaped JSON and a valid final row without LF preserve matching')
rmSync(proof)
writeFileSync(proof, user('fresh replacement!!'))
const stamp = new Date(Date.now() + 1000)
utimesSync(proof, stamp, stamp)
assert.equal(t.codexSaidByPane(proof, ['other pending proof']), false, 'replacement invalidates positive proof')
console.log('ok query changes, rewrite, truncation, replacement, escaped JSON and final rows invalidate or preserve proof correctly')

// Use the real asynchronous rotating writer. Slow-task injection is a local fixture,
// never a production setting, and the saved log is read back rather than just mocked.
const perfBundle = join(work, 'performance.cjs')
buildSync({ absWorkingDir: root, stdin: { contents: "export * from './src/main/mainPerformance'; export * from './src/main/logWrite'", resolveDir: root },
  bundle: true, platform: 'node', format: 'cjs', outfile: perfBundle })
const perf = createRequire(import.meta.url)(perfBundle)
const log = join(work, 'main-performance.log')
perf.startMainPerformance(log, 'test-version')
perf.measureMainTask('idle-sweep', () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 280))
const vitals = { rssMb: 100, heapMb: 30, lagMs: 280, cpuPct: 15, rendererAgoMs: 20 }
let now = Date.now()
perf.mainPerformanceBeat(now, vitals)
await perf.flushLogsOnExit()
const rows = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
assert.equal(rows[0].kind, 'slow-task'); assert.equal(rows[0].task, 'idle-sweep')
assert.ok(rows[0].durationMs >= 250); assert.equal(rows[0].version, 'test-version')
assert.equal(rows[1].lagMs, 280); assert.equal(rows[1].tasks[0].calls, 1)
assert.equal(rows[1].tasks[0].task, 'idle-sweep')
const count = rows.length
for (let i = 0; i < 100; i++) perf.mainPerformanceBeat(now + 1000, vitals)
await perf.flushLogsOnExit()
assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, count, 'trend writes are throttled to 30 seconds')
writeFileSync(log, 'x'.repeat(256 * 1024 + 1))
perf.mainPerformanceBeat(now + 30_000, vitals)
await perf.flushLogsOnExit()
assert.ok(statSync(log + '.1').size <= 256 * 1024 + 1)
assert.ok(statSync(log).size < 2048)
assert.equal(readFileSync(log, 'utf8').includes('queued prompt'), false)
assert.equal(readFileSync(log, 'utf8').includes(cwd), false)
console.log('ok slow task/duration and vital trends persist, throttle, rotate, and contain no prompts or paths')
const iterations = 200_000
const noop = () => 1
let began = performance.now()
for (let i = 0; i < iterations; i++) noop()
const baselineMs = performance.now() - began
began = performance.now()
for (let i = 0; i < iterations; i++) perf.measureMainTask('codex-proof', noop)
console.log(`instrumentation overhead: ${((performance.now() - began - baselineMs) * 1000 / iterations).toFixed(3)} us/call (${iterations} calls)`)
rmSync(work, { recursive: true, force: true })
