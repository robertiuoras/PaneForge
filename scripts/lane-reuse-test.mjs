// Regression test: an abandoned empty copy is reused before a new one is opened, and a
// chat that speaks is awake whatever the app's sleep mark says.
//
// 2026-09-07, toolstash: main/a/b/c/d/e all held, every one at main's commit with nothing
// in it. main "asleep" 55h yet parking every turn (its wake never arrived); b and c held by
// visiting chats last heard from hours ago. The next toolstash chat was handed copy 4,
// then 5, then 6 - the idle sweep only ran when the pool was FULL, and `asleep` was immune
// to every sweep for seven days.
//
//   node scripts/lane-reuse-test.mjs

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-lane-reuse-test')
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
writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ pool: ['main', 'a', 'b', 'c', 'd'] }, null, 2) + '\n')
installLane(here, repo)
git(repo, 'init', '-q', '-b', 'master')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'first')
git(repo, 'tag', 'v0.0.1')
const lane = (...args) => {
  try {
    return { ok: true, out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim() }
  } catch (e) {
    return { ok: false, out: (e.stdout ?? '').toString().trim(), err: (e.stderr ?? '').toString().trim() }
  }
}
const claim = (s) => lane('claim', '--session', s)
const statePath = join(repo, '.git', 'paneforge-lanes.json')
const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
const patch = (fn) => { const s = state(); fn(s); writeFileSync(statePath, JSON.stringify(s, null, 2) + '\n') }
const HOURS_2 = 2 * 60 * 60 * 1000

// Three chats: main, a, b. Then all three go quiet for two hours with nothing in them.
const first = ['one', 'two', 'three'].map((s) => JSON.parse(claim(s).out).lane)
ok('three chats take main, a, b', first.join() === 'main,a,b', first.join())
patch((s) => { for (const c of Object.values(s.lanes)) c.seen = Date.now() - HOURS_2 })

// ---- an abandoned empty copy is reused before a new folder is opened
// (main goes first: a solo chat belongs in the repo itself, and its holder had left.)
const four = JSON.parse(claim('four').out)
ok('the next chat is handed an abandoned copy, not a new one', ['main', 'a', 'b'].includes(four.lane), four.lane)
ok('no copy c folder was made', !existsSync(join(root, 'demo-c')))
const holdOf = (s) => Object.entries(state().lanes).find(([, c]) => c.session === s)
ok('the abandoned hold is gone', Object.values(state().lanes).length === 3)
const five = JSON.parse(claim('five').out)
ok('and the next one too - still no new folder', ['a', 'b'].includes(five.lane) && !existsSync(join(root, 'demo-c')), five.lane)

// ---- an existing unheld copy beats reclaiming somebody's
lane('release', '--session', 'five')
// main's chat stays fresh: an idle main is handed over by its own older rule, which is
// not what this checks.
patch((s) => { for (const [id, c] of Object.entries(s.lanes)) if (id !== 'main') c.seen = Date.now() - HOURS_2 })
const six = JSON.parse(claim('six').out)
ok('a copy nobody holds is taken before one somebody left', six.lane === five.lane, `got ${six.lane}, wanted ${five.lane}`)

// ---- a chat that speaks is awake, whatever the app said
const [mainId] = holdOf('four')
patch((s) => { s.lanes[mainId].asleep = Date.now() - 55 * 60 * 60 * 1000; s.lanes[mainId].seen = Date.now() - 64 * 60 * 60 * 1000 })
lane('park', '--session', 'four')
ok('parking clears the sleep mark', !state().lanes[mainId].asleep)
ok('parking is a heartbeat', Date.now() - state().lanes[mainId].seen < 5000)
patch((s) => { s.lanes[mainId].asleep = Date.now() - 1000 })
claim('four')
ok('a claim clears the sleep mark too', !state().lanes[mainId].asleep)

// ---- a sleeping chat that really is silent keeps its lane
patch((s) => { s.lanes[mainId].asleep = Date.now() - HOURS_2; s.lanes[mainId].seen = Date.now() - HOURS_2 })
const seven = JSON.parse(claim('seven').out)
ok('a genuinely sleeping chat is not robbed', seven.lane !== mainId && state().lanes[mainId].session === 'four', seven.lane)

console.log(failed ? `\n${failed} failed` : '\nall lane-reuse checks passed')
process.exit(failed ? 1 : 0)
