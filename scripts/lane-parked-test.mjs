// Explicit parked snapshots stay visible outside the lane pool and only enter it through
// an empty slot. Run: node scripts/lane-parked-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-lane-parked-test')
let failed = 0
const ok = (name, condition, detail = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!condition && detail) console.log(`      ${detail}`)
  if (!condition) failed++
}
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()

rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
const repo = join(root, 'repo')
mkdirSync(join(repo, 'scripts'), { recursive: true })
writeFileSync(join(repo, 'package.json'), '{"name":"fixture","version":"0.0.1"}\n')
writeFileSync(join(repo, 'app.js'), 'export const base = true\n')
installLane(here, repo)
git(repo, 'init', '-q', '-b', 'master')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'base')
git(repo, 'tag', 'v0.0.1')

const lane = (...args) => {
  try {
    return { ok: true, out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim() }
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? '').trim(), err: String(e.stderr ?? '').trim() }
  }
}

git(repo, 'checkout', '-qb', 'saved-invest')
writeFileSync(join(repo, 'invest.js'), 'export const invest = true\n')
git(repo, 'add', 'invest.js')
git(repo, 'commit', '-qm', 'feat: saved invest work')
const saved = git(repo, 'rev-parse', 'HEAD')
git(repo, 'checkout', '-q', 'master')
git(repo, 'update-ref', 'refs/remotes/origin/lane-a-invest', saved)
git(repo, 'update-ref', 'refs/remotes/origin/wip/lane-b-extension-session', saved)
git(repo, 'update-ref', 'refs/remotes/origin/park/lane-c-x-wip-2026-09-29', saved)
git(repo, 'branch', 'saved-wip', saved)

let status = JSON.parse(lane('status').out)
ok('status automatically registers the known parked remote convention', status.parkedWork?.[0]?.commit === saved, JSON.stringify(status.parkedWork))
ok('status inventories known wip and park remote conventions', status.parkedWork?.some((p) => p.ref === 'refs/remotes/origin/wip/lane-b-extension-session' && p.reviewRequired) && status.parkedWork?.some((p) => p.ref === 'refs/remotes/origin/park/lane-c-x-wip-2026-09-29' && p.reviewRequired), JSON.stringify(status.parkedWork))
ok('local wip is listed for explicit inspection without an invented lane', status.unregisteredParked?.some((p) => p.ref === 'refs/heads/saved-wip'), JSON.stringify(status.unregisteredParked))
ok('discovered work has not become ready', !status.lanes.find((x) => x.lane === 'a').ready)
ok('discovery never claims or creates a lane checkout', !status.lanes.find((x) => x.lane === 'a').heldBy)
ok('discovery gives an actionable review path instead of recovery', /inspect then park/.test(status.parkedWork?.find((p) => p.ref === 'refs/remotes/origin/lane-a-invest')?.action ?? ''))
ok('doctor makes parked work visible outside JSON status', /PARKED WORK[\s\S]*origin\/lane-a-invest/.test(lane('doctor').out))

const active = JSON.parse(lane('claim', '--session', 'active').out)
const registered = lane('park', '--session', 'active', '--ref', 'origin/lane-a-invest', '--lane', 'a')
ok('explicit park registers the reviewed snapshot', registered.ok, registered.err)
status = JSON.parse(lane('status').out)
const activeLane = status.lanes.find((x) => x.lane === active.lane)
ok('registration never parks the caller active lane', activeLane?.heldBy === 'active' && !activeLane?.parked, JSON.stringify(activeLane))

git(repo, 'update-ref', 'refs/remotes/origin/lane-a-invest', 'master')
status = JSON.parse(lane('status').out)
ok('a moved ref stays visible as an actionable parked record', status.parkedWork?.[0]?.moved === true, JSON.stringify(status.parkedWork))
git(repo, 'update-ref', 'refs/remotes/origin/lane-a-invest', saved)
git(repo, 'merge', '--ff-only', '-q', saved)
status = JSON.parse(lane('status').out)
ok('ancestry-confirmed work says recovery is unnecessary', /already on trunk by ancestry/.test(status.parkedWork?.find((p) => p.ref === 'refs/remotes/origin/lane-a-invest')?.action ?? ''))

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
