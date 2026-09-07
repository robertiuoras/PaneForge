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
