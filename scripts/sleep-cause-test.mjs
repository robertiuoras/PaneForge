// Exercise the actual renderer sweep and IPC handler: an automatic sleep must carry
// its decision all the way to the manager, not become a fictional manual click.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
const app = read('src/renderer/src/App.tsx')
const sweepStart = app.indexOf('    const sweep = (): void => {', app.indexOf('const pressure: SleepPressure'))
const sweepEnd = app.indexOf('    // A verdict turning tight', sweepStart)
assert(sweepStart > 0 && sweepEnd > sweepStart)
const sweepCode = transformSync(app.slice(sweepStart, sweepEnd), { loader: 'ts' }).code
const main = read('src/main/index.ts')
const handlerCode = transformSync(main.slice(main.indexOf("ipcMain.handle('sessions:sleep'"), main.indexOf("ipcMain.handle('sessions:wake'")), { loader: 'ts' }).code
let handler
const calls = []
new Function('ipcMain', 'remote', 'manager', handlerCode)(
  { handle: (_name, fn) => { handler = fn } }, { owns: () => false },
  { sleep: (...args) => { calls.push(args); return { asleep: 1 } } }
)
for (const pressure of ['ok', 'tight', 'over']) {
  const deps = {
    cfg: { idleSleepMinutes: 30 }, pressure,
    sessionsRef: { current: [] }, activeRef: { current: null },
    focusLeftAt: { current: {} }, pinnedRef: { current: {} }, usageRef: {},
    awayRef: {}, personRef: { current: true }, reclaimPaneOf: x => x,
    deskNow: x => x,
    pressureSleepMs: (minutes, p) => (p === 'over' ? .5 : p === 'tight' ? 1 : minutes) * 60_000,
    DEFAULT_RECLAIM: { idleSleepMinutes: 30 },
    idleSleepPlan: () => [{ id: 'pane', idleMs: 1_800_123 }],
    CLOSE_COUNTDOWN_MS: 15_000,
    // From 2026-09-10 the sweep does not sleep anything: it arms a countdown card, and the
    // card is what sleeps when nobody stops it (Robert: "it should have a countdown so i
    // know its sleeping"). The decision the card carries is still the sweep's, so this
    // stands in for the card and then makes the call the card's own branch makes.
    armSleepRef: {
      current: (plan, p) => {
        for (const item of plan)
          void deps.api.sleepSession(item.id, p === 'ok' ? 'idle' : 'pressure', {
            source: 'renderer-idle-sweep',
            pressure: p,
            idleMs: item.idleMs,
            thresholdMs: deps.pressureSleepMs(deps.cfg.idleSleepMinutes, p)
          })
      }
    },
    api: { sleepSession: (...args) => handler({ processId: 123 }, ...args), logReclaim() {} }
  }
  new Function(...Object.keys(deps), `${sweepCode}; sweep()`)(...Object.values(deps))
  const [id, reason, evidence] = calls.at(-1)
  assert.equal(id, 'pane')
  assert.equal(reason, pressure === 'ok' ? 'idle' : 'pressure', 'automatic sleep retains its real reason through IPC')
  assert.equal(evidence.source, 'renderer-idle-sweep')
  assert.equal(evidence.pressure, pressure)
  assert.equal(evidence.idleMs, 1_800_123)
  assert.equal(evidence.thresholdMs, pressure === 'over' ? 30_000 : pressure === 'tight' ? 60_000 : 1_800_000)
}
// ...and the card's own branch really is the one that calls it, with that reason. The stub
// above proves the decision survives the IPC; this proves the app has the caller.
assert.match(
  app,
  /if \(soon\.sleep\) \{[\s\S]{0,600}api\.sleepSession\(id, soon\.why === 'idle' \? 'idle' : 'pressure', \{\s*source: 'renderer-idle-sweep'/,
  'the sleep countdown is what calls sleepSession, with the measured reason'
)
assert.match(app, /armSleepRef\.current\(plan, pressure\)/, 'the sweep arms the countdown')
console.log('sleep-cause: renderer and IPC preserve idle/pressure decisions')

handler({ processId: 0 }, 'api-pane')
assert.equal(calls.at(-1)[1], 'unknown', 'legacy API calls cannot be attributed to a manual click')
assert.equal(calls.at(-1)[2].source, 'api')

// Every structured diagnostic sink identifies its app process/build and participates
// in one ordering, even when several events have the same millisecond timestamp.
const logs = []
const logSource = read('src/main/activationLog.ts').replace(/^import .*$/gm, '')
const logCode = transformSync(logSource, { loader: 'ts', format: 'cjs' }).code
const metaModule = { exports: {} }
new Function('module', 'app', transformSync(read('src/main/diagnosticMeta.ts').replace(/^import .*$/gm, ''), { loader: 'ts', format: 'cjs' }).code)(metaModule, { getVersion: () => 'test-version' })
const module = { exports: {} }
new Function('module', 'join', 'app', 'appendLog', 'diagnosticMeta', logCode)(module,
  (...parts) => parts.join('/'), { getPath: () => '/profile', getVersion: () => 'test-version' },
  (file, line) => logs.push({ file, ...JSON.parse(line) }), metaModule.exports.diagnosticMeta)
for (const name of ['logReclaim', 'logFix', 'logOffload', 'logEffort', 'logActivation'])
  module.exports[name]({ action: 'probe', pid: -1, version: 'untrusted', seq: -1 })
module.exports.logHandoff('probe')
assert.equal(new Set(logs.map(row => row.file)).size, 6)
for (const [i, row] of logs.entries()) {
  assert.equal(row.pid, process.pid)
  assert.equal(row.version, 'test-version')
  assert.equal(row.seq, i + 1)
  assert(Number.isFinite(Date.parse(row.t)))
}
console.log('sleep-cause: six diagnostic logs share verified process/build/order metadata')

const textLogs = []
for (const [file, start, end, args, mocks] of [
  ['src/main/autoclearLog.ts', 'export function acLog(', '\n}', ['probe'], { autoclearLogPath: () => '/autoclear', MAX_BYTES: 100 }],
  ['src/main/updater.ts', 'function log(...parts:', '\n}', ['probe'], { LOG: () => '/updater' }]
]) {
  const source = read(file)
  const a = source.indexOf(start), b = source.indexOf(end, a) + end.length
  assert(a >= 0 && b > a)
  const code = transformSync(source.slice(a, b).replace('export ', ''), { loader: 'ts' }).code
  const name = file.includes('autoclear') ? 'acLog' : 'log'
  const deps = { ...mocks, diagnosticMeta: metaModule.exports.diagnosticMeta,
    appendLog: (_file, line) => textLogs.push(line) }
  new Function(...Object.keys(deps), `${code}; return ${name}`)(...Object.values(deps))(...args)
}
for (const [i, line] of textLogs.entries()) {
  const meta = JSON.parse(line.match(/\[pf (\{.*\})\]/)[1])
  assert.equal(meta.seq, i + 7, 'text logs share the structured logs event ordering')
  assert.equal(meta.pid, process.pid)
  assert.equal(meta.version, 'test-version')
}
const early = { exports: {} }
new Function('module', 'app', transformSync(read('src/main/diagnosticMeta.ts').replace(/^import .*$/gm, ''), { loader: 'ts', format: 'cjs' }).code)(early, { getVersion() { throw Error('not ready') } })
assert.equal(early.exports.diagnosticMeta().version, 'unknown', 'metadata remains safe during startup faults')
console.log('sleep-cause: text logs share event metadata; early startup fallback works')

handler({ processId: 0 }, 'spoof', 'manual', { source: 'continuation' })
assert.deepEqual(calls.at(-1), ['spoof', 'unknown', { source: 'api' }])
handler({ processId: 123 }, 'mismatch', 'manual', { source: 'renderer-idle-sweep', pressure: 'over' })
assert.equal(calls.at(-1)[1], 'pressure')
handler({ processId: 123 }, 'internal', 'continuation', { source: 'continuation' })
assert.deepEqual(calls.at(-1), ['internal', 'unknown', { source: 'renderer' }])

const sessions = read('src/main/sessions.ts')
const identityStart = sessions.indexOf('    const processIdentity =')
const identityEnd = sessions.indexOf('\n\n    proc.onData', identityStart)
const exitStart = sessions.indexOf("      logReclaim({ action: 'process-exit'")
const exitEnd = sessions.indexOf('\n      if (live.proc !== proc)', exitStart)
assert(identityStart > 0 && identityEnd > identityStart && exitEnd > exitStart)
const lifecycle = []
const meta = { agent: 'claude', cwd: '/old', status: 'idle' }
const proc = { pid: 321 }
const live = { req: { resumeId: 'original' }, proc }
const code = transformSync(sessions.slice(identityStart, identityEnd), { loader: 'ts' }).code
const exitCode = transformSync(sessions.slice(exitStart, exitEnd).replace('this.down', 'false'), { loader: 'ts' }).code
new Function('meta', 'live', 'proc', 'id', 'basename', 'logReclaim', `${code}; meta.agent='codex'; meta.cwd='/new'; live.proc={pid:999}; const exitCode=137; ${exitCode}`)(meta, live, proc, 'pane', s => s.split('/').at(-1), row => lifecycle.push(row))
assert.equal(lifecycle[1].agent, 'claude')
assert.equal(lifecycle[1].folder, 'old')
assert.equal(lifecycle[1].processPid, 321)
assert.equal(lifecycle[1].resumeId, 'original')
assert.equal(lifecycle[1].superseded, true)
console.log('sleep-cause: caller attribution and superseded process identity verified')
