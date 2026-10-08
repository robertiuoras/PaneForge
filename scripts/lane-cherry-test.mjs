// Regression test: a claim must not run `git cherry` on a lane that has no commits of its own.
//
// 2026-10-09, taskdriver.ai on the Windows PC: lanes a and b sat on a trunk commit hundreds of
// commits behind main with nothing of their own. `git cherry main lane-b` builds a patch-id for
// every commit on the MAIN side too, took 20s+ per call (one call alone ran over a minute), and
// a claim made several of them: 63.8s wall clock, past the hook's 25s limit, so every prompt
// printed "could not assign a checkout" while nothing was actually wrong.
//
// A fixture repo is too small to be slow, so this asserts the cause instead of a stopwatch: a
// preload logs every child process the engine starts, and no `cherry` may be among them while
// every lane is level with or behind master.
//
//   node scripts/lane-cherry-test.mjs

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-lane-cherry-test-' + process.pid)
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

const log = join(root, 'children.log')
const preload = join(root, 'trace.cjs')
writeFileSync(
  preload,
  `const cp = require('child_process'), fs = require('fs'), m = require('module')
for (const k of ['execFileSync', 'spawnSync']) {
  const o = cp[k]
  cp[k] = function (...a) {
    if (process.env.CHERRY_LOG) fs.appendFileSync(process.env.CHERRY_LOG, a[0] + ' ' + (Array.isArray(a[1]) ? a[1].join(' ') : '') + String.fromCharCode(10))
    return o.apply(this, a)
  }
}
m.syncBuiltinESMExports()
`
)
const lane = (...args) => {
  try {
    return {
      ok: true,
      out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], {
        cwd: repo,
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, CHERRY_LOG: log, NODE_OPTIONS: `--require ${preload}` }
      }).trim()
    }
  } catch (e) {
    return { ok: false, out: (e.stdout ?? '').toString().trim(), err: (e.stderr ?? '').toString().trim() }
  }
}

// Three chats take main, a, b; then master moves on, so a and b are behind with nothing of their own.

const first = ['one', 'two', 'three'].map((s) => JSON.parse(lane('claim', '--session', s).out).lane)
ok('three chats take main, a, b', first.join() === 'main,a,b', first.join())
for (const s of ['one', 'two', 'three']) lane('park', '--session', s)
for (let i = 0; i < 5; i++) {
  writeFileSync(join(repo, 'app.js'), `console.log(${i + 2})\n`)
  git(repo, 'commit', '-qam', `trunk ${i}`)
}

rmSync(log, { force: true })
const r = lane('claim', '--session', 'four', '--status')
ok('the claim succeeds', r.ok, r.err)
const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n') : []
const cherries = calls.filter((l) => l.startsWith('git cherry '))
ok('calls were traced', calls.some((l) => l.startsWith('git ')), 'trace log empty - preload not applied')
ok('no git cherry for lanes with nothing of their own', cherries.length === 0, cherries.join(' | '))

rmSync(root, { recursive: true, force: true })
console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
