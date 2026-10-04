// Regression test: a push of master needs a passing test suite on the exact tree it pushes.
//
// 2026-10-04: master 106963ac passed its suite, the cron ship merged lane b (c2a39f8b) and
// pushed the result. Only the typecheck ran on the merged tree, so two suites (paneanswer,
// closedone) were red on origin/master with no test run on the tree that was pushed. Two
// more red commits (21baf0ff, e2c68e0a) were plain `git push` from the main checkout: no
// pre-push hook existed at all.
//
// Asserted, each in its own throwaway repo with a bare origin and the REAL lane.mjs:
//   1. any lane command installs `.git/hooks/pre-push`; a hand push of an untested master
//      commit is refused and origin/master does not move, also with no `node` on PATH (how
//      the app's own pushes run), and a hook written before that fallback gets rewritten
//   2. a lane that is green alone but red once merged (the c2a39f8b shape): `ready` pushes
//      nothing, local master goes back, the lane keeps its ready mark, the reason names it,
//      and an unsaved edit in the main folder is kept (`reset --hard` there wiped it)
//   3. a green lane ships: origin/master gets the lane's change (the engine's own push passes
//      the hook because the merged tree was tested)
//   4. pushing a lane-* branch is never gated
//   5. a hook that is not PaneForge's is never overwritten
//
//   node scripts/lane-push-gate-test.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = realpathSync(mkdtempSync(join(tmpdir(), 'pf-push-gate-')))
process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    /* a leftover temp folder is the smaller lie */
  }
})

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${String(detail).split('\n').join('\n      ')}`)
  }
}

const run = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

let blocks = 0
/**
 * A PaneForge-shaped repo (it carries its own lane.mjs, so it is OWN) with a bare origin and a
 * suite that fails exactly when a file named BROKEN exists in the checkout it runs in.
 */
function makeRepo() {
  blocks++
  const repo = join(root, `demo${blocks}`)
  const origin = join(root, `origin${blocks}.git`)
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1', scripts: { test: 'node suite.cjs' } }, null, 2))
  writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ release: 'merge', pool: ['main', 'a', 'b'] }))
  writeFileSync(join(repo, 'app.txt'), 'one\n')
  writeFileSync(
    join(repo, 'suite.cjs'),
    `const fs = require('node:fs')\n` +
      `if (fs.existsSync('BROKEN')) { console.log('FAIL  broken  0.1s'); process.exit(1) }\n` +
      `console.log('ok  fine  0.1s')\n`
  )
  installLane(here, repo)
  git(repo, 'init', '-q', '-b', 'master')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'first')
  git(root, 'init', '-q', '--bare', '-b', 'master', origin)
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', '-u', 'origin', 'master')
  return { repo, origin }
}

const lane = (repo, ...args) => {
  const r = spawnSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args, '--repo', repo], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 300_000
  })
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}
const ledger = (repo) => JSON.parse(readFileSync(join(repo, '.git', 'paneforge-lanes.json'), 'utf8'))
const originTip = (origin) => git(origin, 'rev-parse', 'master')

/** Main held by one chat, lane a by another: the shape every real release has. */
const claimA = (repo) => {
  lane(repo, 'claim', '--session', 'holds-main', '--cwd', repo)
  return JSON.parse(lane(repo, 'claim', '--session', 'sess-a', '--cwd', repo).out)
}
const commitIn = (dir, file, text, msg) => {
  writeFileSync(join(dir, file), text)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', msg)
}

// ---------------------------------------------------------------- 1. the hook and a hand push
{
  const { repo, origin } = makeRepo()
  lane(repo, 'status')
  const hook = join(repo, '.git', 'hooks', 'pre-push')
  ok('a lane command installs the pre-push hook', existsSync(hook) && readFileSync(hook, 'utf8').includes('paneforge-push-gate'))
  const before = originTip(origin)
  commitIn(repo, 'app.txt', 'untested\n', 'untested change')
  const push = run(repo, 'push')
  ok('a hand push of an untested master is refused', push.code !== 0 && /refused/.test(push.err), `${push.code} ${push.err}`)
  ok('...and origin/master did not move', originTip(origin) === before)

  // The app runs lane.mjs as `ELECTRON_RUN_AS_NODE=1 <PaneForge>`, so the `git push` its ship
  // spawns can have no `node` on PATH. The hook must still run the check, not die with 127.
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (/^path$/i.test(k)) delete env[k]
  const sep = process.platform === 'win32' ? ';' : ':'
  const nodeNames = process.platform === 'win32' ? ['node.exe', 'node.cmd', 'node'] : ['node']
  env.PATH = (process.env.PATH ?? process.env.Path ?? '')
    .split(sep)
    .filter((d) => d && !nodeNames.some((n) => existsSync(join(d, n))))
    .join(sep)
  const gitBin = join(git(repo, '--exec-path'), process.platform === 'win32' ? 'git.exe' : 'git')
  const bare = spawnSync(gitBin, ['push'], { cwd: repo, env, encoding: 'utf8' })
  ok(
    'with no node on PATH the hook still runs the check and refuses for the real reason',
    bare.status !== 0 && /nothing has run the test suite/.test(bare.stderr ?? ''),
    `${bare.status} ${bare.stderr}`
  )
  ok('...and origin/master did not move', originTip(origin) === before)

  // A hook written before that fallback existed is brought up to date by the next lane command.
  const old = (existsSync(hook) ? readFileSync(hook, 'utf8') : '').replace(/^\s*if command -v node[^\n]*\n/m, '').replace(/^\s*if \[ -x [^\n]*\n/m, '')
  writeFileSync(hook, old, { mode: 0o755 })
  lane(repo, 'status')
  ok('a hook from before the no-node fallback is rewritten', existsSync(hook) && readFileSync(hook, 'utf8').includes('ELECTRON_RUN_AS_NODE'))
}

// ---------------------------------------------------------------- 2. green alone, red merged
{
  const { repo, origin } = makeRepo()
  const a = claimA(repo)
  const before = originTip(origin)
  const mainBefore = git(repo, 'rev-parse', 'master')
  commitIn(a.dir, 'BROKEN', 'x\n', 'a lane commit that breaks the suite')
  // Somebody's unsaved edit in the main folder, in a file the lane does not bring.
  const draft = 'one\nsomebody is still writing this\n'
  writeFileSync(join(repo, 'app.txt'), draft)
  const r = lane(repo, 'ready', '--session', 'sess-a')
  ok('a red merged tree is not pushed: origin/master did not move', originTip(origin) === before, r.out)
  ok('local master is back where it was, without the broken file', git(repo, 'rev-parse', 'master') === mainBefore && !existsSync(join(repo, 'BROKEN')), r.out)
  ok('the lane keeps its ready mark', Boolean(ledger(repo).ready?.[a.lane]), JSON.stringify(ledger(repo).ready))
  ok('the reason names the failing suite', /broken/.test(r.out), r.out)
  ok('and the unsaved edit in the main folder is still there', readFileSync(join(repo, 'app.txt'), 'utf8') === draft, r.out)
}

// ---------------------------------------------------------------- 3 and 4. green ships
{
  const { repo, origin } = makeRepo()
  const a = claimA(repo)
  const before = originTip(origin)
  commitIn(a.dir, 'feature.txt', 'harmless\n', 'a harmless lane commit')
  const r = lane(repo, 'ready', '--session', 'sess-a')
  const tip = originTip(origin)
  ok('a green lane ships: origin/master moved', tip !== before, r.out)
  ok('...and carries the lane change', git(origin, 'show', `${tip}:feature.txt`) === 'harmless', r.out)
  const laneBranch = `lane-${a.lane}`
  const p = run(repo, 'push', 'origin', laneBranch)
  ok('a lane branch push is never gated', p.code === 0, p.err)
}

// ---------------------------------------------------------------- 5. a foreign hook
{
  const { repo } = makeRepo()
  const hook = join(repo, '.git', 'hooks', 'pre-push')
  mkdirSync(dirname(hook), { recursive: true })
  const mine = '#!/bin/sh\n# somebody else\nexit 0\n'
  writeFileSync(hook, mine, { mode: 0o755 })
  lane(repo, 'status')
  ok('a hook that is not PaneForge\'s is left alone', readFileSync(hook, 'utf8') === mine)
}

process.exit(failed ? 1 : 0)
