// Force the delayed disk completions that used to overwrite shutdown snapshots.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as realFs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-main-async-io-'))
const require = createRequire(join(work, 'test.cjs'))
const turn = () => new Promise(resolve => setImmediate(resolve))
const pane = title => [{ cwd: work, title, agent: 'codex' }]
let number = 0
function load(kind, profile, gated = false) {
  const id = ++number
  mkdirSync(profile, { recursive: true })
  const electron = join(work, `electron-${id}.cjs`)
  writeFileSync(electron, `module.exports={app:{getPath:()=>${JSON.stringify(profile)}}}`)
  const pending = []
  const consumers = []
  const queue = task => new Promise((resolve, reject) => {
    const release = async () => { try { await task(); resolve(); await turn() } catch (e) { reject(e); throw e } }
    if (consumers.length) consumers.shift()(release)
    else pending.push(release)
  })
  const mock = { ...realFs }
  if (gated) mock.rename = (...args) => queue(() => realFs.rename(...args))
  const key = `__pfIo${id}`
  globalThis[key] = mock
  const fsStub = join(work, `fs-${id}.cjs`)
  writeFileSync(fsStub, `module.exports=globalThis[${JSON.stringify(key)}]`)
  let source = readFileSync(join(root, `src/main/${kind}.ts`), 'utf8')
  source = source.replace("from 'node:fs/promises'", `from ${JSON.stringify(fsStub)}`)
  if (kind === 'strays') source += '\nexport { writeLedger, writeLedgerSync }\n'
  const output = join(work, `${kind}-${id}.cjs`)
  buildSync({ absWorkingDir: root, stdin: { contents: source, loader: 'ts', resolveDir: join(root, 'src/main') },
    bundle: true, format: 'cjs', platform: 'node', outfile: output, alias: { electron } })
  return { api: require(output), async take() {
    if (pending.length) return pending.shift()
    let timer
    try {
      return await Promise.race([new Promise(resolve => consumers.push(resolve)), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`expected delayed ${kind} I/O`)), 5000)
      })])
    } finally { clearTimeout(timer) }
  } }
}
try {
  const historyProfile = join(work, 'history')
  const { api: history } = load('history', historyProfile)
  history.recordStart({ id: 'ordered', title: 'test', cwd: work, agent: 'codex', createdAt: Date.now(), cols: 80 })
  history.recordData('ordered', 'red')
  const oldWrite = history.flush()
  history.recordData('ordered', 'blue')
  history.flushSync()
  await oldWrite
  assert.equal(readFileSync(join(historyProfile, 'history', 'ordered.log'), 'utf8'), 'redblue')
  console.log('ok transcript shutdown preserves byte order after delayed async completion')

  const shutdown = load('restore', join(work, 'shutdown'), true)
  shutdown.api.saveDesk(pane('old'), 'live')
  const finishOld = await shutdown.take()
  shutdown.api.saveDeskOnExit(pane('exit'))
  await finishOld()
  assert.equal(shutdown.api.readDesk().specs[0].title, 'exit')
  console.log('ok shutdown desk wins over an already-issued live rename')

  const liveProfile = join(work, 'live')
  const live = load('restore', liveProfile, true)
  writeFileSync(join(liveProfile, 'desk.json'), JSON.stringify({ specs: pane('legacy'), at: 123, reason: 'quit', clean: true }))
  assert.equal(live.api.readDesk().specs[0].title, 'legacy', 'old installed desks have no writtenAt')
  live.api.saveDesk(pane('A'), 'live')
  await (await live.take())()
  live.api.saveDesk(pane('B'), 'live')
  const finishB = await live.take()
  live.api.saveDesk(pane('A'), 'live')
  await finishB()
  await (await live.take())()
  assert.equal(live.api.readDesk().specs[0].title, 'A')
  console.log('ok A/B/A keeps latest desired desk while B is in flight')

  live.api.saveDesk(pane('stale'), 'live')
  const finishStale = await live.take()
  live.api.clearDesk()
  await finishStale()
  assert.equal(live.api.readDesk(), null)
  assert.equal(JSON.parse(readFileSync(join(liveProfile, 'desk.prev.json'), 'utf8')).specs[0].title, 'A')
  live.api.saveDesk(pane('stale'), 'live')
  await (await live.take())()
  assert.equal(live.api.readDesk().specs[0].title, 'stale')
  console.log('ok clear survives stale rename, preserves backup and permits a fresh save')

  const recoveryProfile = join(work, 'recovery')
  const recovery = load('restore', recoveryProfile, true)
  recovery.api.saveDesk([ ...pane('started'), ...pane('failed') ], 'update')
  await (await recovery.take())()
  recovery.api.clearDesk({ specs: [ ...pane('started'), ...pane('failed') ], at: Date.now(), clean: false, reason: 'live' })
  recovery.api.saveDeskOnExit([], 'update')
  assert.deepEqual(recovery.api.readDesk().specs.map(s => s.title), ['started', 'failed'], 'an interrupted handoff automatically offers its prior desk after an empty terminal write')
  assert.deepEqual(recovery.api.readPreviousDesk().specs.map(s => s.title), ['started', 'failed'], 'interrupted restore keeps every prior row for explicit recovery')
  recovery.api.clearDesk()
  assert.equal(recovery.api.readDesk(), null, 'Start fresh leaves no automatic restore offer')
  assert.deepEqual(recovery.api.readPreviousDesk().specs.map(s => s.title), ['started', 'failed'], 'Start fresh keeps the prior desk available only through explicit recovery')
  console.log('ok interrupted restore retains its prior desk only for explicit recovery')

  const completedProfile = join(work, 'completed-recovery')
  const completed = load('restore', completedProfile, true)
  completed.api.saveDesk(pane('before'), 'update')
  await (await completed.take())()
  completed.api.clearDesk({ specs: pane('before'), at: Date.now(), clean: false, reason: 'live' })
  completed.api.saveDesk(pane('incomplete'), 'live')
  const finishIncomplete = await completed.take()
  completed.api.completeDeskRecovery()
  await finishIncomplete()
  assert.ok(completed.api.readPreviousDesk(), 'a write issued before recovery completed cannot consume the backup')
  completed.api.saveDeskOnExit(pane('restored'), 'live')
  assert.equal(completed.api.readPreviousDesk(), null, 'the recovery copy is consumed only after a nonempty restored desk is durable')
  console.log('ok completed restore consumes recovery only after persistence')

  const manualProfile = join(work, 'manual-previous')
  const manual = load('restore', manualProfile, true)
  manual.api.saveDesk(pane('current'), 'live')
  await (await manual.take())()
  writeFileSync(join(manualProfile, 'desk.prev.json'), JSON.stringify({ specs: pane('previous'), at: 1, clean: false, reason: 'update' }))
  manual.api.clearDesk({ specs: pane('previous'), at: 1, clean: false, reason: 'update' })
  assert.deepEqual(manual.api.readPreviousDesk().specs.map(s => s.title), ['previous'],
    'manual previous recovery keeps its source desk while current panes remain open')
  console.log('ok manual previous recovery does not overwrite its source desk')

  const partialProfile = join(work, 'partial')
  const partial = load('restore', partialProfile, true)
  partial.api.setDeskHold({ specs: pane('failed'), at: Date.now(), clean: false, reason: 'live' })
  partial.api.saveDesk(pane('started'), 'live')
  await (await partial.take())()
  assert.deepEqual(partial.api.readDesk().specs.map(s => s.title), ['failed', 'started'], 'failed rows are retained beside the panes that started')
  partial.api.saveDeskOnExit(pane('started'), 'update')
  assert.deepEqual(partial.api.readDesk().specs.map(s => s.title), ['failed', 'started'], 'an immediate update keeps failed rows too')
  console.log('ok partial restore keeps failed rows across an immediate update')

  const ledgerProfile = join(work, 'ledger')
  const ledger = load('strays', ledgerProfile, true)
  ledger.api.writeLedger({ runs: { old: [] } })
  const finishLedger = await ledger.take()
  assert.deepEqual(Object.keys(ledger.api.readLedger().runs), [], 'unpublished temp leaves the prior complete ledger intact')
  ledger.api.writeLedgerSync({ runs: { final: [] } })
  await finishLedger()
  ledger.api.writeLedger({ runs: { late: [] } })
  assert.deepEqual(Object.keys(ledger.api.readLedger().runs), ['final'])
  const nextRun = load('strays', ledgerProfile, true)
  nextRun.api.readLedger()
  nextRun.api.writeLedger({ runs: { next: [] } })
  await (await nextRun.take())()
  assert.deepEqual(Object.keys(nextRun.api.readLedger().runs), ['next'])
  console.log('ok terminal ledger wins old completion and yields to the next run')
} finally {
  for (let i = 1; i <= number; i++) delete globalThis[`__pfIo${i}`]
  rmSync(work, { recursive: true, force: true })
}
