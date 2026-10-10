// Shared by the lane-completion suites: real Git fixtures for verified completion of
// preserved orphan work. Split in three files (lane-completion-test, -owner-test,
// -adopt-test) so the full run is not waiting on one 659s suite (PC, 9 Oct 2026).
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

export const here = dirname(fileURLToPath(import.meta.url))
export const root = mkdtempSync(join(tmpdir(), 'pf-completion-'))
let failures = 0
export const check = (name, pass, detail = '') => { console.log(`${pass ? 'ok' : 'FAIL'} ${name}`); if (!pass) { failures++; console.log(detail) } }
export const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
export function fixture(name) {
  const repo = join(root, name)
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  installLane(here, repo)
  copyFileSync(join(here, 'lane-hook.mjs'), join(repo, 'scripts', 'lane-hook.mjs'))
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, version: '0.0.1' }))
  writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ release: 'merge', pool: ['main', 'a', 'b'] }))
  writeFileSync(join(repo, 'source.txt'), 'base\n')
  git(repo, 'init', '-q', '-b', 'master'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.com')
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base'); git(repo, 'tag', 'v0.0.1')
  const remote = join(root, `${name}-origin.git`)
  git(root, 'init', '--bare', '-q', remote); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-qu', 'origin', 'master', '--tags')
  const statePath = join(repo, '.git', 'paneforge-lanes.json')
  const beatDir = join(repo, '.git', 'paneforge-panes')
  mkdirSync(beatDir)
  const beat = join(beatDir, `pf-${process.pid}.json`)
  writeFileSync(beat, JSON.stringify({ at: Date.now(), chats: [] }))
  const panes = join(repo, '.git', 'panes.txt'); writeFileSync(panes, '')
  const log = join(repo, '.git', 'completion.jsonl')
  const processes = join(repo, '.git', 'processes.json'); writeFileSync(processes, '[]')
  const env = { ...process.env, LANE_PROCESSES_FILE: processes, PF_PANE: '', PF_CTL_NO_APP: '1', LANE_PANES_FILE: panes, LANE_COMPLETION_LOG: log, LANE_REGISTRY: join(repo, '.git', 'registry.json'), CLAUDE_CONFIG_DIR: join(root, 'claude') }
  const cli = join(repo, 'scripts', 'lane.mjs')
  const run = (...args) => {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 90_000 })
    return { code: r.status, out: r.stdout, err: r.stderr }
  }
  const recoveryPath = join(repo, '.git', 'paneforge-recovery.json')
  const state = () => ({ ...JSON.parse(readFileSync(statePath, 'utf8')), recovery: existsSync(recoveryPath) ? JSON.parse(readFileSync(recoveryPath, 'utf8')) : { items: {} } })
  const patch = (fn) => {
    const s = state(); fn(s)
    const { recovery, ...ledger } = s
    writeFileSync(statePath, JSON.stringify(ledger))
    if (existsSync(recoveryPath)) writeFileSync(recoveryPath, JSON.stringify(recovery))
  }
  const claim = JSON.parse(run('claim', '--prefer', 'a', '--session', 'original').out)
  const dir = claim.dir
  const requests = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  return { repo, remote, dir, cli, env, state, patch, run, beat, panes, processes, recoveryPath, requests }
}

// An older blocked item with a dead owner, listed before item `k`.
export const shadow = (s, k) => {
  const items = s.recovery.items
  s.recovery.items = { 'lane:a:old-blocked': { ...items[k], status: 'blocked', owner: 'dead-old', pane: null }, ...items }
}

export function finish() {
  console.log(`${failures ? 'FAIL' : 'ok'} completion fixture: ${failures} failures`)
  if (!failures) rmSync(root, { recursive: true, force: true })
  process.exitCode = failures ? 1 : 0
}
