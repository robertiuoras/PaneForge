// Exercise real reclaim sweeps and child exits without touching the user's ledgers.
import assert from 'node:assert/strict'
import os from 'node:os'
import { syncBuiltinESMExports, createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildSync } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const work = mkdtempSync(join(os.tmpdir(), 'pf-reclaim-'))
const originalHome = os.homedir
const originalEngine = process.env.PANEFORGE_ENGINE
const originalRepo = process.env.PANEFORGE_REPO
os.homedir = () => work
syncBuiltinESMExports()
delete process.env.PANEFORGE_REPO
const require = createRequire(import.meta.url)
const first = join(work, 'Projects', 'first')
const second = join(work, 'Projects', 'second')
const calls = join(work, 'calls.jsonl')
const old = Date.now() - 3 * 3600_000
function ledger(repo, lanes) {
  mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(join(repo, '.git', 'paneforge-lanes.json'), JSON.stringify({ lanes, ready: {}, conflicts: {} }))
}
const hold = (session, extra = {}) => ({ session, seen: old, claimed: old, ...extra })

try {
  ledger(first, { main: hold('sleeping', { asleep: old }), a: hold('first-dead'), b: hold('second-dead') })
  ledger(second, { main: hold('other-dead'), a: hold('live-chat') })
  const compiled = join(work, 'board.cjs')
  buildSync({ entryPoints: [join(root, 'src/main/laneBoard.ts')], outfile: compiled, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  const { laneReclaim, laneBoards, goneLanes } = require(compiled)
  const panes = [{ id: 'live-pane', cwd: second, resumeId: 'live-chat' }]
  const firstBoard = laneBoards([{ id: 'visitor', cwd: first }])[0]
  assert(!goneLanes(firstBoard, new Set()).includes('sleeping'), 'sleeping holds must not enter a release loop that preserves them')
  const engine = join(work, 'engine.mjs')
  // No ledger changes: both a no-op and a failure must let later candidates have a turn.
  writeFileSync(engine, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n'); process.exit(process.argv.includes('first-dead') ? 1 : 0)`)
  process.env.PANEFORGE_ENGINE = engine
  await laneReclaim(panes) // first inventory establishment deliberately fails closed
  for (let tick = 0; tick < 4; tick++) await laneReclaim(panes)
  const tried = readFileSync(calls, 'utf8').trim().split('\n').map((line) => {
    const args = JSON.parse(line)
    return args[args.indexOf('--session') + 1]
  })
  assert.equal(tried.length, 4, 'each completed sweep waits for exactly one child')
  assert.deepEqual(new Set(tried), new Set(['first-dead', 'second-dead', 'other-dead']), 'failures and no-ops cannot starve another lane or repository')
  assert.equal(new Set(tried.slice(0, 3)).size, 3, 'every candidate gets a turn before a repeated attempt')
  assert(JSON.parse(readFileSync(join(first, '.git', 'paneforge-lanes.json'))).lanes.main.asleep, 'sleeping ownership stays intact')
  console.log('lane reclaim: sleeping protection, live ownership, failed/no-op fairness and child completion passed')
} finally {
  os.homedir = originalHome
  syncBuiltinESMExports()
  if (originalEngine === undefined) delete process.env.PANEFORGE_ENGINE
  else process.env.PANEFORGE_ENGINE = originalEngine
  if (originalRepo === undefined) delete process.env.PANEFORGE_REPO
  else process.env.PANEFORGE_REPO = originalRepo
  rmSync(work, { recursive: true, force: true })
}
