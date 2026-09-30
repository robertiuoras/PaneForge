import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { EventEmitter, once } from 'node:events'
import childProcess from 'node:child_process'
import { buildSync } from 'esbuild'

const dir = mkdtempSync(join(tmpdir(), 'pf-codex-workers-'))
const parent = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const child = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const events = new EventEmitter()
const realExec = childProcess.execFile
let queries = 0
childProcess.execFile = (bin, args, opts, callback) => {
  queries++
  return realExec(bin, args, opts, (error, stdout, stderr) => {
    callback(error, stdout, stderr)
    events.emit('read')
  })
}
const previousHome = process.env.CODEX_HOME
const realNow = Date.now
const fixtureNow = realNow()
try {
  // Activity age is independent of subprocess scheduling and host clock adjustments.
  Date.now = () => fixtureNow
  process.env.CODEX_HOME = dir
  const out = join(dir, 'reader.cjs')
  buildSync({ entryPoints: ['src/main/codexWorkers.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: out })
  const { scanWorkerLines, codexWorkersFor, forgetCodexWorkers } = createRequire(import.meta.url)(out)
  const event = (type, turn_id = 'one') => JSON.stringify({ type: 'event_msg', payload: { type, turn_id } }) + '\n'
  const context = JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'high' } }) + '\n'
  const scan = { file: '', offset: 0, state: 'unknown' }
  scanWorkerLines(scan, context)
  assert.equal(scan.state, 'unknown', 'a context/open edge is not running')
  scanWorkerLines(scan, event('task_started'))
  assert.equal(scan.state, 'running')
  assert.equal(scan.model, undefined, 'a new task does not inherit an old executed model')
  scanWorkerLines(scan, context)
  scanWorkerLines(scan, event('task_complete', 'old'))
  assert.equal(scan.state, 'running', 'a different turn cannot finish the active turn')
  scanWorkerLines(scan, event('turn_aborted'))
  assert.equal(scan.state, 'interrupted')
  scanWorkerLines(scan, event('task_started', 'two') + context + event('task_complete', 'two'))
  assert.equal(scan.state, 'completed')
  assert.equal(scan.model, 'gpt-6.1-sol')
  assert.equal(scan.effort, 'high')
  const file = join(dir, 'child.jsonl')
  writeFileSync(file, event('task_started') + context)
  utimesSync(file, new Date(fixtureNow), new Date(fixtureNow))
  const py = process.platform === 'win32' ? 'py' : 'python3'
  const pyArgs = process.platform === 'win32' ? ['-3'] : []
  const fixture = childProcess.spawnSync(py, [...pyArgs, '-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute('create table threads(id text,rollout_path text,agent_nickname text,agent_path text,created_at integer)');c.execute('create table thread_spawn_edges(parent_thread_id text,child_thread_id text,status text)');c.execute('insert into threads values(?,?,?,?,?)',(sys.argv[2],sys.argv[3],'Planck','/root/build',1));c.execute('insert into thread_spawn_edges values(?,?,?)',(sys.argv[4],sys.argv[2],'open'));c.commit()`, join(dir, 'state_5.sqlite'), child, file, parent], { encoding: 'utf8' })
  assert.equal(fixture.status, 0, fixture.stderr)
  const read = async now => {
    const done = once(events, 'read')
    codexWorkersFor('pane', parent, now)
    await done
    return codexWorkersFor('pane', parent, now)
  }
  const now = Date.now()
  let value = await read(now)
  assert.equal(value.status, 'fresh')
  assert.deepEqual(value.workers.map(w => [w.name, w.model, w.effort, w.state]), [['build', 'gpt-6.1-sol', 'high', 'running']])
  assert.equal(queries, 1, 'unchanged reads do not start another subprocess')
  appendFileSync(file, event('task_complete').trimEnd())
  utimesSync(file, new Date(fixtureNow), new Date(fixtureNow))
  value = await read(now + 10_001)
  assert.equal(value.workers[0].state, 'running', 'partial lines wait for newline')
  appendFileSync(file, '\n')
  utimesSync(file, new Date(fixtureNow), new Date(fixtureNow))
  value = await read(now + 20_002)
  assert.equal(value.workers[0].state, 'completed', 'open native edge remains after completion')
  appendFileSync(file, event('task_started', 'new'))
  utimesSync(file, new Date(fixtureNow), new Date(fixtureNow))
  value = await read(now + 30_003)
  assert.equal(value.workers[0].state, 'running', 'incremental restart after completion')
  utimesSync(file, new Date(0), new Date(0))
  value = await read(now + 40_004)
  assert.equal(value.workers[0].state, 'stale')
  forgetCodexWorkers('pane')
  writeFileSync(file, event('task_started') + context + JSON.stringify({type:'response_item',payload:'x'.repeat(300_000)}) + '\n' + event('task_complete'))
  value = await read(now + 45_004)
  assert.equal(value.workers[0].model, 'gpt-6.1-sol', 'bounded head context matches the proven tail turn')
  assert.equal(value.workers[0].state, 'completed')
  forgetCodexWorkers('pane')
  writeFileSync(file, event('task_started') + context + JSON.stringify({type:'response_item',payload:'x'.repeat(300_000)}) + '\n' + event('task_complete', 'different'))
  value = await read(now + 46_004)
  assert.equal(value.workers[0].model, undefined, 'head model never leaks to another tail turn')
  writeFileSync(file, context)
  value = await read(now + 56_005)
  assert.equal(value.workers[0].state, 'unknown', 'truncation resets activity')
  rmSync(file)
  value = await read(now + 66_006)
  assert.equal(value.workers[0].state, 'unknown', 'missing child does not claim running')
  rmSync(join(dir, 'state_5.sqlite'))
  value = await read(now + 76_007)
  assert.equal(value.status, 'unknown', 'database failure is visible')
  const changed = codexWorkersFor('pane', 'cccccccc-cccc-cccc-cccc-cccccccccccc', now)
  assert.deepEqual(changed.workers, [], 'changing parent never leaks previous children')
  forgetCodexWorkers('pane')
  assert.equal(codexWorkersFor('pane', undefined), undefined)
  console.log('Codex workers: event ordering, incremental reads, partial writes, stale/unknown states, read-only DB and identity checks passed')
} finally {
  Date.now = realNow
  childProcess.execFile = realExec
  if (previousHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = previousHome
  rmSync(dir, { recursive: true, force: true })
}
