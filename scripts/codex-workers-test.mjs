import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, utimesSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { EventEmitter, once } from 'node:events'
import childProcess from 'node:child_process'
import { build, buildSync } from 'esbuild'

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
  const { scanWorkerLines, codexWorkersFor, forgetCodexWorkers, describeStep } = createRequire(import.meta.url)(out)
  assert.equal(describeStep('exec_command', JSON.stringify({ cmd: ['bash', '-lc', 'npm   test'] })), 'Running a command: bash -lc npm test')
  // Code mode (real Mac shapes): a custom `exec` input is a script; never show its text.
  assert.equal(describeStep('exec', 'text(await tools.exec_command({cmd:"blender -b scene.blend -a", yield_time_ms: 1000}))'), 'Running a command: blender -b scene.blend -a')
  assert.equal(describeStep('exec', "text(await tools.exec_command({cmd:'sleep 70; ls'}))"), 'Running a command: sleep 70; ls')
  assert.equal(describeStep('exec', 'const r = await tools.view_image({path:"/tmp/a.png"}); image(r.image_url);'), 'Looking at an image')
  assert.equal(describeStep('exec', 'text(await tools.write_stdin({session_id: 3, chars: ""}))'), 'Checking on a running command')
  assert.equal(describeStep('exec', 'await tools.read_file({path: `/work/scene.blend`})'), 'Reading scene.blend')
  assert.equal(describeStep('exec', 'const paths = ["a","b"]'), 'Running a script')
  assert.equal(describeStep('shell', 'echo hi\nmore'), 'Running a command: echo hi', 'other raw input: first non-empty line')
  assert.equal(describeStep('exec_command', '{broken'), 'Running a command', 'bad JSON never throws and is never shown')
  assert.equal(describeStep('shell', JSON.stringify({ command: 'gAAAAABsecret' })), 'Running a command', 'encrypted values are dropped')
  const longStep = describeStep('exec_command', JSON.stringify({ cmd: 'x'.repeat(200) }))
  assert.equal(Array.from(longStep).length, 60)
  assert.ok(longStep.endsWith('\u2026'))
  assert.equal(describeStep('wait', JSON.stringify({ cell_id: '150', yield_time_ms: 60000 })), 'Checking on a running command')
  assert.equal(describeStep('write_stdin', JSON.stringify({ chars: '' })), 'Checking on a running command')
  assert.equal(describeStep('write_stdin', JSON.stringify({ chars: 'y\n' })), 'Typing into a running command')
  assert.equal(describeStep('wait_agent', JSON.stringify({ timeout_ms: 3600000 })), 'Waiting for its helpers')
  assert.equal(describeStep('spawn_agent', JSON.stringify({ task_name: 'alpha', message: 'gAAAAAblob' })), 'Starting a helper: alpha')
  assert.equal(describeStep('spawn_agent', JSON.stringify({ task_name: 'gAAAAAblob' })), 'Starting a helper')
  assert.equal(describeStep('send_input', '{}'), 'Messaging a helper')
  assert.equal(describeStep('close_agent', '{}'), 'Closing a helper')
  assert.equal(describeStep('apply_patch', '*** Begin Patch'), 'Editing files')
  assert.equal(describeStep('read_file', JSON.stringify({ path: 'C:\\work\\scene.blend' })), 'Reading scene.blend')
  assert.equal(describeStep('write_file', JSON.stringify({ path: '/tmp/out.txt', text: 'gAAAAAblob' })), 'Writing out.txt')
  assert.equal(describeStep('read_file', '{}'), 'Reading a file')
  assert.equal(describeStep('view_image', '{}'), 'Looking at an image')
  assert.equal(describeStep('rg', '{}'), 'Searching files')
  assert.equal(describeStep('list_dir', '{}'), 'Listing files')
  assert.equal(describeStep('update_plan', '{}'), 'Updating its plan')
  assert.equal(describeStep('web_search', '{}'), 'Searching the web')
  assert.equal(describeStep('mcp_tool', undefined), 'Using mcp_tool')
  // An add-on tool's name (PC 2026-10-03: `mcp__node_repl__js`) reads as words, not code.
  assert.equal(describeStep('mcp__node_repl__js', '{}'), 'Using node repl: js')
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
  const at = '2026-10-01T03:00:00.000Z'
  const endAt = '2026-10-01T03:01:30.000Z'
  const timed = (type, timestamp) => JSON.stringify({ type: 'event_msg', timestamp, payload: { type, turn_id: 'timed' } }) + '\n'
  scanWorkerLines(scan, timed('task_started', at) + context + timed('task_complete', endAt))
  assert.equal(scan.startedAt, Date.parse(at))
  assert.equal(scan.endedAt - scan.startedAt, 90_000, 'duration is native task time, not lookup time')
  scanWorkerLines(scan, event('task_started', 'without-time'))
  assert.equal(scan.startedAt, undefined, 'missing timestamp does not invent a clock')
  assert.equal(scan.endedAt, undefined, 'a new task clears the preceding finish')
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
  // Real Windows shape (PC "Hume" 2026-10-03): NTFS keeps the modified time of a file Codex
  // holds open, so the file looked 2 h 7 min old while its last event was that minute.
  const hours2 = fixtureNow - 2 * 60 * 60_000
  const stamped = (ms, type, payload) => JSON.stringify({ timestamp: new Date(ms).toISOString(), type, payload }) + '\n'
  const windowsRecords = recentAt => stamped(hours2, 'event_msg', { type: 'task_started', turn_id: 'win' })
    + stamped(hours2, 'turn_context', { model: 'gpt-6.1-sol', effort: 'high' })
    + stamped(hours2, 'event_msg', { type: 'token_count', info: null })
    + stamped(recentAt, 'response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'blender -b scene.blend -a' }) })
    + stamped(recentAt, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 13000000, cached_input_tokens: 0, output_tokens: 188234, total_tokens: 13188234 } } })
  forgetCodexWorkers('pane')
  writeFileSync(file, windowsRecords(fixtureNow - 60_000))
  utimesSync(file, new Date(hours2), new Date(hours2))
  value = await read(now + 41_004)
  assert.equal(value.workers[0].state, 'running', 'a recent native event keeps a worker running when the file modified time lags (Windows)')
  assert.equal(value.workers[0].tokens, 13188234, 'tokens come from the newest native token total')
  assert.equal(value.workers[0].action, 'Running a command: blender -b scene.blend -a')
  assert.equal(value.workers[0].actionAt, fixtureNow - 60_000)
  assert.equal(value.parentTokens, undefined, 'older Codex without a token column still lists workers')
  assert.equal(value.subagentTokens, 13188234, 'subagent share falls back to the listed helpers')
  forgetCodexWorkers('pane')
  writeFileSync(file, windowsRecords(hours2 + 60_000))
  utimesSync(file, new Date(hours2), new Date(hours2))
  value = await read(now + 42_004)
  assert.equal(value.workers[0].state, 'stale', 'old last event and old file time is a dead worker')
  // Real PC "Hume": ~80 MB, its one task started 2 h ago, so the 256 KB tail holds no task event.
  forgetCodexWorkers('pane')
  const filler = stamped(hours2, 'response_item', { type: 'reasoning', encrypted_content: 'gAAAAA' + 'x'.repeat(1000) })
  writeFileSync(file, stamped(hours2, 'event_msg', { type: 'task_started', turn_id: 'long' })
    + stamped(hours2, 'turn_context', { model: 'gpt-6.1-sol', effort: 'high' })
    + filler.repeat(300)
    + stamped(fixtureNow - 60_000, 'response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'blender -b scene.blend -a' }) })
    + stamped(fixtureNow - 60_000, 'event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 13188234 } } }))
  utimesSync(file, new Date(hours2), new Date(hours2))
  value = await read(now + 43_004)
  assert.equal(value.workers[0].state, 'running', 'fresh events with no finish in the tail is a task in progress')
  assert.equal(value.workers[0].tokens, 13188234)
  assert.equal(value.workers[0].action, 'Running a command: blender -b scene.blend -a')
  assert.equal(value.workers[0].startedAt, undefined, 'a start outside the tail is never invented')
  assert.equal(value.workers[0].model, undefined, 'an unproven turn takes no head model')
  appendFileSync(file, stamped(fixtureNow, 'event_msg', { type: 'task_complete', turn_id: 'long' }))
  value = await read(now + 53_005)
  assert.equal(value.workers[0].state, 'completed', 'a later finish still ends the inferred task')
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
  // Real PC chat 01a100d5 numbers: parent 766,573; Hume 13,188,234; Copernicus 960,337.
  const tokenHome = join(dir, 'tokens')
  mkdirSync(tokenHome)
  process.env.CODEX_HOME = tokenHome
  const copernicus = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
  const hume = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
  const grandchild = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
  const copernicusFile = join(tokenHome, 'copernicus.jsonl')
  writeFileSync(copernicusFile, stamped(fixtureNow - 30_000, 'event_msg', { type: 'task_started', turn_id: 't' })
    + stamped(fixtureNow - 20_000, 'event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 960337 } } }))
  const tokenFixture = childProcess.spawnSync(py, [...pyArgs, '-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute('create table threads(id text,rollout_path text,agent_nickname text,agent_path text,created_at integer,tokens_used integer)');c.execute('create table thread_spawn_edges(parent_thread_id text,child_thread_id text,status text)')
for row in [(sys.argv[2],'',None,None,0,766573),(sys.argv[3],sys.argv[6],'Copernicus',None,2,900000),(sys.argv[4],sys.argv[7],'Hume',None,1,13188234),(sys.argv[5],'',None,None,3,500000)]: c.execute('insert into threads values(?,?,?,?,?,?)',row)
for edge in [(sys.argv[2],sys.argv[3]),(sys.argv[2],sys.argv[4]),(sys.argv[4],sys.argv[5])]: c.execute('insert into thread_spawn_edges values(?,?,?)',edge+('open',))
c.commit()`, join(tokenHome, 'state_5.sqlite'), parent, copernicus, hume, grandchild, copernicusFile, join(tokenHome, 'missing.jsonl')], { encoding: 'utf8' })
  assert.equal(tokenFixture.status, 0, tokenFixture.stderr)
  await once(events, 'read') // the changed-parent lookup above is still in flight
  const tokensDone = once(events, 'read')
  codexWorkersFor('tokens', parent, now)
  await tokensDone
  const tokenReading = codexWorkersFor('tokens', parent, now)
  assert.equal(tokenReading.status, 'fresh')
  assert.deepEqual(tokenReading.workers.map(w => [w.name, w.tokens]), [['Copernicus', 960337], ['Hume', 13188234]], 'newer of database and native token totals')
  assert.equal(tokenReading.parentTokens, 766573)
  assert.equal(tokenReading.subagentTokens, 900000 + 13188234 + 500000, 'helpers of helpers count in the subagent share')
  // A tool output bigger than the read tail restarts the read; the last step and tokens stay
  // (PC "Hume" 2026-10-03: 3 records in its last 256 KB, none a tool call).
  appendFileSync(copernicusFile, stamped(fixtureNow - 15_000, 'response_item', { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"blender -b car.blend"}' }))
  const stepDone = once(events, 'read')
  codexWorkersFor('tokens', parent, now + 10_000)
  await stepDone
  assert.equal(codexWorkersFor('tokens', parent, now + 10_000).workers[0].action, 'Running a command: blender -b car.blend')
  appendFileSync(copernicusFile, stamped(fixtureNow - 10_000, 'response_item', { type: 'function_call_output', output: 'x'.repeat(400 * 1024) }))
  const hugeDone = once(events, 'read')
  codexWorkersFor('tokens', parent, now + 20_000)
  await hugeDone
  const afterHuge = codexWorkersFor('tokens', parent, now + 20_000).workers[0]
  assert.deepEqual([afterHuge.action, afterHuge.actionAt, afterHuge.tokens], ['Running a command: blender -b car.blend', fixtureNow - 15_000, 960337], 'last step and tokens survive a record bigger than the tail')
  forgetCodexWorkers('tokens')
  process.env.CODEX_HOME = dir
  const claudeOut = join(dir, 'claude.cjs')
  await build({ entryPoints: ['src/main/runningAgents.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: claudeOut,
    plugins: [{ name: 'quiet-log', setup(b) {
      b.onResolve({ filter: /\/activationLog$/ }, () => ({ path: 'quiet-log', namespace: 'fixture' }))
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export function logHandoff() {}' }))
    } }] })
  const { backgroundAgentsFor, backgroundWorkerReadingFor } = createRequire(import.meta.url)(claudeOut)
  const claudeFile = join(dir, 'claude.jsonl')
  const claudeLines = readFileSync('scripts/fixtures/claude-background-agent.jsonl', 'utf8').trimEnd().split('\n')
  const launchedAt = Date.parse('2026-09-22T18:27:32.073Z')
  writeFileSync(claudeFile, claudeLines.slice(0, 2).join('\n') + '\n')
  backgroundAgentsFor('claude', claudeFile, launchedAt - 1, launchedAt + 1000)
  const claudeReading = backgroundWorkerReadingFor('claude', launchedAt - 1, launchedAt + 1000)
  assert.equal(claudeReading.status, 'fresh')
  assert.deepEqual(claudeReading.workers.map(w => [w.name, w.state, w.startedAt, w.model]), [['Visual review Design 4 pages', 'running', launchedAt, undefined]], 'requested model is not an executed-model claim')
  assert.equal(claudeReading.workers[0].requestedModel, 'sonnet', 'the model the launch asked for is carried, apart from the executed model')
  const opusFile = join(dir, 'opus.jsonl')
  const opusAt = '2026-09-22T19:00:00.000Z'
  writeFileSync(opusFile, [
    { parentUuid: null, isSidechain: false, type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_OPUS', name: 'Agent', input: { subagent_type: 'locator', model: 'opus', description: 'Opus review', prompt: '(redacted)' }, caller: { type: 'direct' } }], stop_reason: 'tool_use' }, timestamp: opusAt },
    { parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_OPUS', type: 'tool_result', content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: a0pus00000000001 (internal ID)\nThe agent is working in the background.' }] }] }, timestamp: opusAt }
  ].map(l => JSON.stringify(l)).join('\n') + '\n')
  const opusAtMs = Date.parse(opusAt)
  backgroundAgentsFor('opus-claude', opusFile, opusAtMs - 1, opusAtMs + 1000)
  const opusWorker = backgroundWorkerReadingFor('opus-claude', opusAtMs - 1, opusAtMs + 1000).workers[0]
  assert.equal(opusWorker?.requestedModel, 'opus', 'an Agent launch with input.model opus yields a worker that reads opus')
  assert.equal(opusWorker.model, undefined, 'asked-for is never an executed-model claim')
  assert.equal(backgroundWorkerReadingFor('claude', launchedAt - 1, launchedAt + 4 * 60 * 60_000).workers[0].state, 'stale', 'aged background launches are not falsely idle')
  appendFileSync(claudeFile, claudeLines.slice(2).join('\n') + '\n')
  backgroundAgentsFor('claude', claudeFile, launchedAt - 1, launchedAt + 5000)
  assert.deepEqual(backgroundWorkerReadingFor('claude', launchedAt - 1, launchedAt + 5000).workers, [], 'Claude task notification ends the observed worker')
  rmSync(claudeFile)
  backgroundAgentsFor('claude', claudeFile, launchedAt - 1, launchedAt + 9000)
  assert.equal(backgroundWorkerReadingFor('claude', launchedAt - 1, launchedAt + 9000).status, 'unknown', 'missing transcript is not an idle count')
  const boundedFile = join(dir, 'bounded-claude.jsonl')
  writeFileSync(boundedFile, JSON.stringify({ type: 'irrelevant', text: 'x'.repeat(9 * 1024 * 1024) }) + '\n' + claudeLines.slice(0, 2).join('\n') + '\n')
  backgroundAgentsFor('bounded-claude', boundedFile, launchedAt - 1, launchedAt + 1000)
  assert.equal(backgroundWorkerReadingFor('bounded-claude', launchedAt - 1, launchedAt + 1000).status, 'limited', 'bounded transcript scans cannot claim complete coverage')
  const uiOut = join(dir, 'worker-ui.cjs')
  buildSync({ stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import Workers from './src/renderer/src/components/Workers'; export const render = session => renderToStaticMarkup(React.createElement(Workers, {session}));`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', tsconfig: 'tsconfig.web.json', outfile: uiOut })
  const { render } = createRequire(import.meta.url)(uiOut)
  globalThis.window = { api: { onLinkState() {} } }
  const session = { id: 'fixture', title: 'Worker proof', agent: 'codex' }
  assert.equal(render(session), '', 'no reading yet draws nothing')
  assert.equal(render({ ...session, codexWorkers: { status: 'fresh', workers: [] } }), '', 'zero running draws nothing')
  const ui = render({ ...session, codexWorkers: { status: 'fresh', workers: [{ id: 'one', name: 'Build & verify', model: 'gpt-6.1-sol', state: 'running', startedAt: fixtureNow - 90_000 }] } })
  assert.match(ui, /1 running/)
  assert.match(ui, /Build &amp; verify/)
  assert.match(ui, /gpt-6.1-sol/)
  assert.match(ui, /1m 30s/)
  assert.doesNotMatch(ui, /tokens|worker-step/, 'no token reading draws no token text')
  const busy = render({ ...session, codexWorkers: { status: 'fresh', parentTokens: 766573, subagentTokens: 14148571, workers: [
    { id: 'hume', name: 'Hume', model: 'gpt-6.1-sol', state: 'running', startedAt: fixtureNow - 7_200_000, tokens: 13188234, action: 'Running a command: blender -b scene.blend -a', actionAt: fixtureNow - 60_000 },
    { id: 'cop', name: 'Copernicus', state: 'running', startedAt: fixtureNow - 1000, tokens: 960337 }] } })
  assert.match(busy, /2 running<span class="workers-tokens"> · 15M tokens \(subagents 14M\)<\/span>/, 'chat total and subagent share in the summary')
  assert.match(busy, /aria-label="[^"]*2 running, 15M tokens \(subagents 14M\)"/)
  assert.match(busy, /Hume: Running a command: blender -b scene.blend -a · Copernicus</, 'collapsed preview names each helper\'s last step')
  assert.match(busy, /13M tokens/)
  assert.match(busy, /960k tokens/)
  assert.match(busy, /class="worker-step"[^>]*>Running a command: blender -b scene.blend -a · <span class="worker-step-ago"[^>]*>1m 00s<\/span> ago<\/div>/)
  assert.equal((busy.match(/worker-step"/g) || []).length, 1, 'no step line without a step')
  assert.doesNotMatch(busy.replace(/<[^>]*>/g, ' '), /\b(thread|rollout|spawn|edge|stdin|cell)\b/i, 'no code words on screen')
  assert.match(render({ ...session, codexWorkers: { status: 'fresh', subagentTokens: 2_500_000, workers: [{ id: 'one', name: 'Build', state: 'running', action: 'Editing files' }] } }), /subagents 2.5M tokens[\s\S]*Editing files<\/div>/, 'only the known part, and no clock without a step time')
  assert.equal(render({ ...session, codexWorkers: { status: 'unknown', workers: [{ id: 'one', name: 'Build', state: 'stale' }] } }), '', 'only stopped/stale workers draws nothing')
  assert.match(render({ ...session, codexWorkers: { status: 'unknown', workers: [{ id: 'one', name: 'Build', state: 'running', startedAt: fixtureNow - 1000 }, { id: 'two', name: 'Old', state: 'stale' }] } }), /1 confirmed running/)
  const asked = render({ id: 'fixture', title: 'Worker proof', agent: 'claude', claudeWorkers: { status: 'fresh', workers: [{ id: 'one', name: 'Opus review', requestedModel: 'opus', state: 'running', startedAt: fixtureNow - 1000 }] } })
  assert.match(asked, /Asked for [^<]*[Oo]pus/, 'requested model is labelled as asked for')
  assert.doesNotMatch(asked, /Model unknown/)
  assert.match(render({ id: 'fixture', title: 'Worker proof', agent: 'claude', claudeWorkers: { status: 'fresh', workers: [{ id: 'one', name: 'No model', state: 'running', startedAt: fixtureNow - 1000 }] } }), /Model unknown/)
  assert.doesNotMatch(asked, /tokens|worker-step/, 'Claude background workers draw exactly as before')
  assert.match(asked, /<span class="workers-preview" title="Opus review">Opus review<\/span>/)
  assert.equal(render({ ...session, agent: 'shell' }), '', 'unsupported provider does not claim zero')
  delete globalThis.window
  console.log('Codex workers: event ordering, incremental reads, partial writes, stale/unknown states (Windows held file time), tokens incl. helpers of helpers, last step words, read-only DB and identity checks passed')
  console.log('Worker display: native timing, Claude background completion/unknown model, hidden when nothing runs, token summary, last step + ago and escaped task labels passed')
} finally {
  Date.now = realNow
  childProcess.execFile = realExec
  if (previousHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = previousHome
  rmSync(dir, { recursive: true, force: true })
}
