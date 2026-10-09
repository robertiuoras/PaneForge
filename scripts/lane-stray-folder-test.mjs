// Regression test: a stray folder at a lane's path must not fail every claim.
//
// 2026-10-09, taskdriver.ai on the Windows PC: `taskdriver.ai-h` held only
// `.local-schedule-shots/schedule.png` (written there 6 Oct, not a git worktree). The chooser
// prefers folders that already exist ("reuse a checkout before paying to create one"), so it
// picked lane h over lanes it could have built, `ensureWorktree` refused the folder (rightly:
// it never deletes what it did not make), and the throw failed the WHOLE claim - the chat got
// "could not assign a checkout" while other lanes were free.
//
// The folder is somebody's: it must be left exactly as it is, the claim must go to a lane that
// can be built, and a claim that asks for that lane by name still gets the sentence that says
// what is in the way.
//
//   node scripts/lane-stray-folder-test.mjs

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-lane-stray-folder-test-' + process.pid)
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${detail}`)
  }
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
const repo = join(root, 'demo')
mkdirSync(join(repo, 'scripts'), { recursive: true })
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1' }, null, 2) + '\n')
writeFileSync(join(repo, 'app.js'), 'console.log(1)\n')
writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ pool: ['main', 'a', 'b', 'c'] }, null, 2) + '\n')
installLane(here, repo)
git(repo, 'init', '-q', '-b', 'master')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'first')

const lane = (...args) => {
  try {
    return { ok: true, out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim() }
  } catch (e) {
    return { ok: false, out: (e.stdout ?? '').toString().trim(), err: (e.stderr ?? '').toString().trim() }
  }
}
const laneOf = (r) => {
  try {
    return JSON.parse(r.out).lane
  } catch {
    return null
  }
}

// Two chats hold main and a. Lane b has never been made; lane c's path holds a folder that is
// not a checkout of anything - the shape found on the PC.
ok('first chat takes main', laneOf(lane('claim', '--session', 'one')) === 'main')
ok('second chat takes a', laneOf(lane('claim', '--session', 'two')) === 'a')
const stray = join(root, 'demo-c')
mkdirSync(join(stray, '.local-schedule-shots'), { recursive: true })
writeFileSync(join(stray, '.local-schedule-shots', 'schedule.png'), 'png')

const r = lane('claim', '--session', 'three')
ok('a claim with a stray folder at lane c still succeeds', r.ok, r.err)
ok('it is sent to the lane that can be built', laneOf(r) === 'b', r.out || r.err)
ok('the stray folder is left exactly as it was', existsSync(join(stray, '.local-schedule-shots', 'schedule.png')) && readdirSync(stray).join() === '.local-schedule-shots', readdirSync(stray).join())

// With every buildable lane taken, the refusal names the folder instead of a git error.
const four = lane('claim', '--session', 'four')
ok('with nothing else left the claim is refused', !four.ok, four.out)
ok('...and the refusal names the folder in the way', /demo-c/.test(four.err) && /not a git worktree/.test(four.err), four.err)

// Asked for by name it still says what is in the way.
const named = lane('claim', '--session', 'five', '--prefer', 'c')
ok('asking for lane c by name explains the folder', /not a git worktree/.test(`${named.err}${named.out}`), named.err || named.out)

rmSync(root, { recursive: true, force: true })
console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
