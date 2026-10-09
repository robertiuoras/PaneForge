// A lane whose only commits past trunk are merges that add nothing gets no recovery chat, and a
// `ready` refused by a preserved item says which item and the command that records it.
//
// PaneForge lane c, 2026-10-09: its tip was 29c3264c, a "Merge branch 'master' into lane-c"
// whose tree was trunk's exactly (the lane's own commits were already in trunk). The clock
// pinned it as abandoned work at 7:48pm, the recovery pane never opened, the item went
// `blocked`, and the next chat's `ready` threw "recovered work requires a current
// verification receipt and independent review before ready" without naming the item.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'pf-mergeonly-'))
let failures = 0
const check = (name, pass, detail = '') => { console.log(`${pass ? 'ok' : 'FAIL'} ${name}`); if (!pass) { failures++; console.log(detail) } }
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()

function fixture(name) {
  const repo = join(root, name)
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  installLane(here, repo)
  copyFileSync(join(here, 'lane-hook.mjs'), join(repo, 'scripts', 'lane-hook.mjs'))
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, version: '0.0.1' }))
  writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ release: 'merge', pool: ['main', 'a', 'b'] }))
  writeFileSync(join(repo, 'source.txt'), 'base\n')
  git(repo, 'init', '-q', '-b', 'master'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.com')
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base')
  const remote = join(root, `${name}-origin.git`)
  git(root, 'init', '--bare', '-q', remote); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-qu', 'origin', 'master')
  const beatDir = join(repo, '.git', 'paneforge-panes')
  mkdirSync(beatDir)
  writeFileSync(join(beatDir, `pf-${process.pid}.json`), JSON.stringify({ at: Date.now(), chats: [] }))
  const panes = join(repo, '.git', 'panes.txt'); writeFileSync(panes, '')
  const log = join(repo, '.git', 'completion.jsonl')
  const processes = join(repo, '.git', 'processes.json'); writeFileSync(processes, '[]')
  const env = { ...process.env, LANE_PROCESSES_FILE: processes, PF_PANE: '', PF_CTL_NO_APP: '1', LANE_PANES_FILE: panes, LANE_COMPLETION_LOG: log, LANE_REGISTRY: join(repo, '.git', 'registry.json'), CLAUDE_CONFIG_DIR: join(root, 'claude') }
  const run = (...args) => {
    const r = spawnSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], { cwd: repo, env, encoding: 'utf8', timeout: 90_000 })
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' }
  }
  const statePath = join(repo, '.git', 'paneforge-lanes.json')
  const recoveryPath = join(repo, '.git', 'paneforge-recovery.json')
  const recovery = () => existsSync(recoveryPath) ? JSON.parse(readFileSync(recoveryPath, 'utf8')) : { items: {} }
  const dropHold = () => { const s = JSON.parse(readFileSync(statePath, 'utf8')); delete s.lanes.a; writeFileSync(statePath, JSON.stringify(s)) }
  const requests = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []
  const dir = JSON.parse(run('claim', '--prefer', 'a', '--session', 'original').out).dir
  // The lane's own work reaches trunk, then trunk moves on without it.
  writeFileSync(join(dir, 'work.txt'), 'lane work\n'); git(dir, 'add', 'work.txt'); git(dir, 'commit', '-qm', 'lane work')
  git(repo, 'merge', '-q', '--no-ff', '--no-edit', 'lane-a')
  writeFileSync(join(repo, 'later.txt'), 'later trunk\n'); git(repo, 'add', 'later.txt'); git(repo, 'commit', '-qm', 'trunk advanced')
  git(repo, 'push', '-q', 'origin', 'master')
  return { repo, dir, run, recovery, recoveryPath, dropHold, requests }
}

// 1. A catch-up merge of trunk into the lane is all it has past trunk: nothing to preserve.
{
  const x = fixture('catch-up-merge-only')
  git(x.dir, 'merge', '-q', '--no-ff', '--no-edit', 'master')
  x.dropHold(); x.run('retry')
  check('a lane whose only commit past trunk is a merge adding nothing gets no recovery chat', x.requests().length === 0 && !Object.keys(x.recovery().items).length, JSON.stringify(x.recovery()))
}

// 2. The same merge with content of its own (a file edited while merging) is still preserved.
{
  const x = fixture('merge-with-own-content')
  git(x.dir, 'merge', '-q', '--no-ff', '--no-commit', 'master')
  writeFileSync(join(x.dir, 'later.txt'), 'resolved my way\n'); git(x.dir, 'add', 'later.txt'); git(x.dir, 'commit', '-qm', 'merge master, my way')
  x.dropHold(); x.run('retry')
  check('a merge that changes what trunk holds is still preserved', x.requests().length === 1 && Object.keys(x.recovery().items).length === 1, JSON.stringify(x.recovery()))
}

// 3. A blocked item with no owner: ready names it and the command; that command unblocks ready.
{
  const x = fixture('blocked-names-item')
  writeFileSync(join(x.dir, 'more.txt'), 'unmerged work\n'); git(x.dir, 'add', 'more.txt'); git(x.dir, 'commit', '-qm', 'unmerged work')
  x.dropHold(); x.run('retry')
  const items = x.recovery()
  const key = Object.keys(items.items)[0]
  Object.assign(items.items[key], { status: 'blocked', reason: 'pane open failed or timed out; inspect delivery before explicit retry' })
  delete items.active
  writeFileSync(x.recoveryPath, JSON.stringify(items))
  x.run('claim', '--prefer', 'a', '--cwd', x.dir, '--session', 'next-chat')
  const refused = x.run('ready', '--session', 'next-chat')
  const said = refused.err + refused.out
  check('ready refuses a blocked item it does not own', refused.code !== 0 && /recovered work requires a current verification receipt/.test(said), said)
  check('the refusal names the item and how to record it', said.includes(key) && /--disposition reviewed/.test(said) && /blocked/.test(said), said)
  const receipt = join(x.repo, '.git', 'receipt.json')
  writeFileSync(receipt, JSON.stringify({ reason: 'the lane carries this work; checked by hand' }))
  const recorded = x.run('recover', '--key', key, '--session', 'next-chat', '--disposition', 'reviewed', '--receipt', receipt)
  const again = x.run('ready', '--session', 'next-chat')
  check('the named command clears the refusal', recorded.code === 0 && !/recovered work requires/.test(again.err + again.out), recorded.err + again.err + again.out)
}

console.log(`${failures ? 'FAIL' : 'all passed'}: merge-only lanes and named recovery refusals, ${failures} failures`)
if (!failures) rmSync(root, { recursive: true, force: true })
process.exitCode = failures ? 1 : 0
