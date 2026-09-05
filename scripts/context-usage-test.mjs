import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'pf-context-'))
const oldHome = process.env.CODEX_HOME
process.env.CODEX_HOME = work
const cwd = join(work, 'project'), dir = join(work, 'sessions', '2026', '09', '05')
mkdirSync(cwd); mkdirSync(dir, { recursive: true })
const id = '12345678-1234-4234-8234-123456789abc', other = '12345678-1234-4234-8234-123456789abd'
const now = Date.now(), stamp = (at = now) => new Date(at).toISOString()
const meta = (session = id) => ({ type: 'session_meta', payload: { id: session, cwd, timestamp: stamp() } })
const model = (name = 'model-a') => ({ type: 'turn_context', payload: { model: name } })
const usage = (used = 600, window = 1000, at = now) => ({ type: 'event_msg', timestamp: stamp(at), payload: { type: 'token_count', info: { last_token_usage: { total_tokens: used }, total_token_usage: { total_tokens: 90000000 }, model_context_window: window } } })
const file = join(dir, 'rollout-fixture.jsonl')
const write = (...rows) => writeFileSync(file, rows.map(x => JSON.stringify(x)).join('\n') + '\n')
const out = join(work, 'reader.cjs')
buildSync({ absWorkingDir: root, entryPoints: ['src/main/contextUsage.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' })
const { codexContextUsage: read, receivedContinuation } = createRequire(import.meta.url)(out)
let cases = 0
const equal = (a, b, why) => { assert.deepEqual(a, b, why); cases++ }
try {
  write(meta(), model(), usage())
  equal(read(cwd, id, now)?.percent, 60, 'last usage, not cumulative spend')
  equal(read(cwd, id, now)?.advisory, 'prepare', 'advisory prepare threshold')
  equal(read(cwd, other, now), null, 'another pane in same cwd cannot borrow usage')
  equal(read(cwd + '-other', id, now), null, 'wrong cwd refused')
  writeFileSync(join(dir, 'other.jsonl'), [meta(other), model(), usage(100)].map(JSON.stringify).join('\n') + '\n')
  equal(read(cwd, other, now)?.percent, 10, 'two exact conversations keep distinct context')
  for (const bad of [usage(-1), usage(1001), usage(4, 0), usage(1, null), usage(4, 1000, now + 1), usage(4, 1000, now - 300001)]) {
    if (bad.payload.info.model_context_window === undefined) delete bad.payload.info.model_context_window
    write(meta(), model(), bad)
    equal(read(cwd, id, now), null, 'invalid/missing/stale/future usage unavailable')
  }
  write(meta(), model(), usage(), model('model-b'))
  equal(read(cwd, id, now), null, 'model change invalidates prior reading')
  write(meta(), model(), usage(), model('model-b'), usage(900, 2000))
  equal(read(cwd, id, now)?.percent, 45, 'new model/window accepts its next reading')
  for (const compact of [{ type: 'compacted', payload: {} }, { type: 'event_msg', payload: { type: 'context_compacted' } }]) {
    write(meta(), model(), usage(), compact)
    equal(read(cwd, id, now), null, 'compaction invalidates old usage')
    write(meta(), model(), usage(), compact, usage(200))
    equal(read(cwd, id, now)?.percent, 20, 'fresh post-compaction measurement replaces it')
  }
  write(meta(), { type: 'response_item', payload: { text: 'x'.repeat(2 * 1024 * 1024) } }, model(), usage(800))
  equal(read(cwd, id, now)?.advisory, 'boundary', 'large rollout reads bounded tail')
  write(meta(), usage())
  equal(read(cwd, id, now), null, 'missing model evidence unavailable')
  write(meta(), model(), usage(), { type: 'event_msg', payload: { type: 'token_count', info: null } })
  equal(read(cwd, id, now)?.percent, 60, 'limits-only event does not erase usage')
  write(meta(), model(), usage())
  writeFileSync(file, [meta(), model(), usage()].map(JSON.stringify).join('\n') + '\n{"type":')
  equal(read(cwd, id, now)?.percent, 60, 'partial concurrent append is ignored')
  writeFileSync(file, [meta(), model()].map(JSON.stringify).join('\n') + '\n' + JSON.stringify(usage()).replace('600', '1e999') + '\n')
  equal(read(cwd, id, now), null, 'non-finite JSON number unavailable')
  const handoff = '# Handoff\nVerified task, constraints and work.\n'
  const digest = createHash('sha256').update(handoff.trim()).digest('hex')
  const message = role => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text: handoff }] } })
  write(meta(), model(), message('assistant'))
  equal(receivedContinuation(cwd, id, 'codex', digest), false, 'assistant echo is not receipt')
  write(meta(), model(), message('user'))
  equal(receivedContinuation(cwd, id, 'codex', digest), true, 'new conversation user record proves receipt')
  equal(receivedContinuation(cwd, other, 'codex', digest), false, 'different conversation cannot supply receipt')
  equal(receivedContinuation(cwd, id, 'codex', 'wrong'), false, 'different handoff cannot supply receipt')
  equal(receivedContinuation(cwd, id, 'unknown', digest), false, 'unsupported provider has no claimed receipt')
  console.log(`context usage: ${cases} checks passed`)
} finally {
  if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome
  rmSync(work, { recursive: true, force: true })
}
