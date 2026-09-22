import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const temp = mkdtempSync(join(tmpdir(), 'pf-compute-review-'))
let watcher
try {
  const out = join(temp, 'compute.cjs')
  await build({ entryPoints: [fileURLToPath(new URL('../src/main/computeReviews.ts', import.meta.url))], outfile: out, bundle: true, platform: 'node', format: 'cjs' })
  const { ComputeReviews, computeResult } = createRequire(import.meta.url)(out)
  const binding = { pane: 'shell_1', job: 'job-test-123', owner: 'native-owner', title: 'Test', cwd: temp, capturedAt: new Date().toISOString(), attempt: { hash: 'a'.repeat(64), submittedAt: '2026-01-01T00:00:00.000Z' } }
  const dir = join(temp, binding.job), file = join(temp, 'bindings.json')
  mkdirSync(dir)
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ id: binding.job, session: binding.owner, ...binding.attempt }))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ status: 'queued' }))
  let closes = 0
  watcher = new ComputeReviews(temp, file, () => { closes++; return true })
  watcher.bind(binding)
  watcher.bind({ ...binding, capturedAt: '2000-01-01T00:00:00Z' })
  assert.equal(JSON.parse(readFileSync(file))[0].capturedAt, binding.capturedAt, 'reattachment cannot erase newer-input protection')
  assert.equal(closes, 0, 'idle shell without receipt stays open')
  assert.throws(() => watcher.bind({ ...binding, owner: 'wrong-owner' }))
  assert.throws(() => watcher.bind({ ...binding, job: '../../etc' }))
  const result = { status: 'succeeded', exitCode: 0, finishedAt: new Date().toISOString(), containment: 'windows-job-object' }
  for (const invalid of ['{', '{}', JSON.stringify({ ...result, containment: 'none' }), JSON.stringify({ ...result, exitCode: 1 }), JSON.stringify({ ...result, finishedAt: '2999-01-01' })]) {
    writeFileSync(join(dir, 'result.json'), invalid)
    watcher.check()
    assert.equal(closes, 0)
  }
  watcher.dispose()
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result))
  writeFileSync(join(dir, 'state.json'), JSON.stringify(result))
  let busy = true
  let retained
  watcher = new ComputeReviews(temp, file, (b, r, receipt) => { retained = receipt; closes++; return !busy })
  watcher.check()
  assert.equal(closes, 1, 'restart recovers retained binding and existing receipt')
  assert.equal(JSON.parse(readFileSync(file)).length, 1, 'busy shell keeps completion association')
  busy = false
  watcher.check()
  assert.equal(JSON.parse(readFileSync(file)).length, 0)
  watcher.check()
  assert.equal(closes, 2, 'completed association removed once')
  for (const status of ['failed', 'timed_out', 'cancelled']) {
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ ...result, status, exitCode: null }))
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...result, status }))
    assert.equal(computeResult(temp, binding).status, status, 'failure is a retained terminal result, not success')
  }
  assert.equal(JSON.parse(readFileSync(retained)).result.status, 'succeeded', 'review keeps the actual receipt after current result changes')
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ status: 'queued' }))
  assert.equal(computeResult(temp, binding), undefined, 'old receipt cannot complete queued retry')
  writeFileSync(join(dir, 'state.json'), JSON.stringify(result))
  const nextAttempt = { ...binding.attempt, submittedAt: '2026-01-02T00:00:00.000Z' }
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ id: binding.job, session: binding.owner, ...nextAttempt }))
  assert.equal(computeResult(temp, binding), undefined, 'identical request hash with new timestamp is a different attempt')
  mkdirSync(join(dir, '.retry-lock'))
  assert.throws(() => watcher.bind(binding), 'cannot bind during retry amendment')
  rmSync(join(dir, '.retry-lock'), { recursive: true })
  writeFileSync(join(dir, 'request.json'), JSON.stringify({ id: binding.job, session: binding.owner, ...binding.attempt }))
  // Real filesystem notification, not a timer or manually invoked completion sweep.
  writeFileSync(join(dir, 'result.json'), '{}')
  watcher.dispose()
  let resolve
  const observed = new Promise(r => { resolve = r })
  watcher = new ComputeReviews(temp, file, () => { resolve(); return true })
  watcher.bind(binding)
  await new Promise(r => setImmediate(r))
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result))
  let deadline
  try { await Promise.race([observed, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Filesystem completion event was not delivered')), 5000) })]) }
  finally { clearTimeout(deadline) }
  assert.equal(JSON.parse(readFileSync(file)).length, 0)
  console.log('compute review: receipt validation, ownership, restart, busy retention, failure and filesystem completion passed')
} finally {
  watcher?.dispose()
  rmSync(temp, { recursive: true, force: true })
}
