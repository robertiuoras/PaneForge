// Regression test for the three ways the lane engine used to blame the code for a broken
// machine, and then need a person to type something before any release could happen again.
//
// Every one of these was found on 2026-08-02 in one session, and every one of them is
// invisible to whoever is running the app: a lane folder that is not a checkout, a lock
// file left behind by a git that was killed, and a checkout with no node_modules. None of
// the three is a disagreement about code, and all three were reported as one - "lane a
// conflicts with master", "master does not typecheck" - so the honest answer, deleting a
// file or running an install, was the one thing the message never said. The stall lasted
// seven hours here, and here there is somebody who can read `.git/index.lock` and know it
// is safe to remove. On somebody else's machine it lasts until they give up.
//
// What is asserted, in order:
//
//   1. a lane folder that is no longer a worktree is rebuilt, not handed out broken
//   2. the node_modules junction the engine itself leaves behind does not block that
//   3. a lane that breaks while its own chat holds it is rebuilt on the next claim
//   4. an abandoned index.lock is cleared and the merge goes through
//   5. a FRESH index.lock is left alone, and the lane is not called conflicted for it
//   6. no node_modules is reported as no node_modules, not as code that does not compile
//   7. a typecheck that cannot start is told apart from one that ran and found errors
//
// Real git, real lane.mjs, no network: `npm` is stubbed on PATH for the install case.
//
//   node scripts/lane-heal-test.mjs

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-lane-heal-test')
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
const gitTry = (cwd, ...args) => {
  try {
    return git(cwd, ...args)
  } catch (e) {
    return String(e.stderr ?? e.message).trim()
  }
}

// ---------------------------------------------------------------- a repo with lanes

const repo = join(root, 'demo')
const laneA = join(root, 'demo-a')

/** A fresh repo every block, so one failing assertion cannot cascade into the next. */
function makeRepo({ typecheck = null, deps = null } = {}) {
  rmSync(repo, { recursive: true, force: true })
  rmSync(laneA, { recursive: true, force: true })
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  const pkg = { name: 'demo', version: '0.0.1' }
  if (typecheck) pkg.scripts = { typecheck }
  if (deps) pkg.devDependencies = deps
  writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg, null, 2))
  // "none" keeps the whole release path offline: lanes merge, nothing is pushed or tagged.
  writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ release: 'none', lanes: ['main', 'a', 'b'] }))
  writeFileSync(join(repo, 'app.txt'), 'one\n')
  installLane(here, repo)
  git(repo, 'init', '-q', '-b', 'master')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'first')
  return repo
}

const lane = (...args) =>
  execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args, '--repo', repo], {
    cwd: repo,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, PATH: stubDir + delimiter + process.env.PATH, Path: stubDir + delimiter + (process.env.Path ?? process.env.PATH) }
  }).trim()

const isWorktree = (dir) => gitTry(dir, 'rev-parse', '--is-inside-work-tree') === 'true'

// The FIRST chat in a repo is given `main` - the checkout itself - so solo work needs no
// branch and no merge. Everything below is about the worktree lanes, so park a session on
// main first and let the one under test land in a.
const claimLaneA = (session) => {
  lane('claim', '--session', 'holds-main', '--cwd', repo)
  return JSON.parse(lane('claim', '--session', session, '--cwd', repo))
}

/** A committed change sitting in lane a, ready to be merged. */
const workInLaneA = (text = 'lane work\n') => {
  writeFileSync(join(laneA, 'app.txt'), text)
  git(laneA, 'add', '-A')
  git(laneA, 'commit', '-qm', 'lane a work')
}

// ---------------------------------------------------------------- an npm that never phones home

// `npm ci` / `npm install` must not reach the network in a test. This stub answers both by
// creating the directory the real one would, so the install path is exercised end to end.
const stubDir = join(root, 'stub')
mkdirSync(stubDir, { recursive: true })
writeFileSync(
  join(stubDir, 'npm-stub.mjs'),
  `import { mkdirSync, writeFileSync } from 'node:fs'\n` +
    `import { join } from 'node:path'\n` +
    `const args = process.argv.slice(2)\n` +
    `if (args[0] === 'ci' || args[0] === 'install') {\n` +
    `  mkdirSync(join(process.cwd(), 'node_modules', '.bin'), { recursive: true })\n` +
    `  writeFileSync(join(process.cwd(), 'node_modules', 'installed-by-stub'), '')\n` +
    `  process.exit(0)\n` +
    `}\n` +
    // Everything else is `npm run --silent typecheck`: run the script out of package.json
    // with the shell, which is all the real npm does that matters here.
    `if (args[0] === 'run') {\n` +
    `  const name = args.filter((a) => !a.startsWith('--'))[1]\n` +
    `  const pkg = JSON.parse((await import('node:fs')).readFileSync(join(process.cwd(), 'package.json'), 'utf8'))\n` +
    `  const cmd = pkg.scripts?.[name]\n` +
    `  if (!cmd) { console.error('npm ERR! missing script: ' + name); process.exit(1) }\n` +
    `  const { spawnSync } = await import('node:child_process')\n` +
    `  const r = spawnSync(cmd, { cwd: process.cwd(), stdio: 'inherit', shell: true })\n` +
    `  process.exit(r.status ?? 1)\n` +
    `}\n` +
    `process.exit(0)\n`
)
writeFileSync(join(stubDir, 'npm.cmd'), `@echo off\r\nnode "%~dp0npm-stub.mjs" %*\r\n`)
writeFileSync(join(stubDir, 'npm'), `#!/bin/sh\nexec node "$(dirname "$0")/npm-stub.mjs" "$@"\n`)
try {
  chmodSync(join(stubDir, 'npm'), 0o755)
} catch {
  /* Windows */
}

// ---------------------------------------------------------------- 1-2: a folder that is not a checkout

makeRepo()
const claimed = claimLaneA('s1')
ok('a fresh claim builds a real worktree', claimed.dir === laneA && isWorktree(laneA), claimed.dir)

// Break it exactly the way it breaks in the wild: the folder survives, the checkout does
// not, and git is told to forget it. Then put back the node_modules junction the engine
// leaves in every lane, because that junction is what stopped `git worktree add` from
// repairing the folder by hand and made the state permanent.
rmSync(laneA, { recursive: true, force: true })
mkdirSync(laneA, { recursive: true })
git(repo, 'worktree', 'prune')
mkdirSync(join(repo, 'node_modules'), { recursive: true })
try {
  symlinkSync(join(repo, 'node_modules'), join(laneA, 'node_modules'), 'junction')
} catch {
  /* unprivileged POSIX without symlink rights - the rest of the assertion still holds */
}
ok('the broken folder really is not a checkout', !isWorktree(laneA))

// s1 still holds lane a, so this is the case where a lane breaks UNDER the chat sitting in
// it: the one path that returns early and used to hand the broken folder straight back.
const again = JSON.parse(lane('claim', '--session', 's1', '--cwd', repo))
ok('the chat already holding the lane gets it rebuilt', isWorktree(laneA), again.dir)
ok('the junction did not take the real node_modules with it', existsSync(join(repo, 'node_modules')))

// ---------------------------------------------------------------- 3: broken, then a new chat

rmSync(laneA, { recursive: true, force: true })
mkdirSync(laneA, { recursive: true })
git(repo, 'worktree', 'prune')
lane('release', '--session', 's1')
const rebuilt = JSON.parse(lane('claim', '--session', 's2', '--cwd', repo))
ok('a new chat is given a rebuilt worktree, not the broken folder', rebuilt.dir === laneA && isWorktree(laneA), rebuilt.dir)

// ---------------------------------------------------------------- 4: an abandoned lock

makeRepo()
claimLaneA('s1')
workInLaneA()

const lock = join(repo, '.git', 'index.lock')
writeFileSync(lock, '')
// Older than STALE_LOCK_MS (5 minutes): nothing legitimate holds an index that long.
const old = Date.now() / 1000 - 60 * 60
utimesSync(lock, old, old)

const shipped = lane('ready', '--session', 's1')
ok('an abandoned lock does not stop the merge', /merged into master/i.test(shipped), shipped)
ok('the abandoned lock was cleared', !existsSync(lock))
ok('the lane really landed on master', git(repo, 'show', '-s', '--format=%s', 'master').includes('merge lane a'), git(repo, 'log', '--oneline', '-3', 'master'))

let state = JSON.parse(readFileSync(join(repo, '.git', 'paneforge-lanes.json'), 'utf8'))
ok('nothing was recorded as a conflict', Object.keys(state.conflicts ?? {}).length === 0, JSON.stringify(state.conflicts))

// ---------------------------------------------------------------- 5: a lock somebody is holding

makeRepo()
claimLaneA('s1')
workInLaneA()

const live = join(repo, '.git', 'index.lock')
writeFileSync(live, '')
const out = lane('ready', '--session', 's1')
ok('a live lock is not deleted', existsSync(live), out)

state = JSON.parse(readFileSync(join(repo, '.git', 'paneforge-lanes.json'), 'utf8'))
ok('a live lock is not recorded as a conflict', Object.keys(state.conflicts ?? {}).length === 0, JSON.stringify(state.conflicts))
ok('the blocked lane stays ready, so the next release takes it', Boolean(state.ready?.a), JSON.stringify(state.ready))

// The whole point of keeping the mark: once the lock is gone the work goes out with no
// one being asked anything.
rmSync(live, { force: true })
const later = lane('ship')
ok('it merges by itself once the lock is gone', /merged into master/i.test(later), later)

// ---------------------------------------------------------------- 6: no dependencies

// The typecheck needs the dependencies to pass, which is what makes this the real case:
// without the install it fails, and what it fails with looks exactly like broken code.
makeRepo({
  typecheck: 'node -e "process.exit(require(\'node:fs\').existsSync(\'node_modules\') ? 0 : 1)"',
  deps: { typescript: '^5.5.0' }
})
claimLaneA('s1')
workInLaneA()
ok('the checkout starts with no node_modules', !existsSync(join(repo, 'node_modules')))

const installed = lane('ready', '--session', 's1')
ok('missing dependencies are installed instead of reported', existsSync(join(repo, 'node_modules', 'installed-by-stub')), installed)
ok('and the release then happens', /merged into master/i.test(installed), installed)
ok('nothing claimed the code does not typecheck', !/does not typecheck/i.test(installed), installed)

// ---------------------------------------------------------------- 7: cannot run vs found errors

makeRepo({ typecheck: 'definitely-not-a-real-binary --noEmit' })
claimLaneA('s1')
workInLaneA()
const cannot = lane('ready', '--session', 's1')
ok('a typecheck that cannot start says so', /could not run/i.test(cannot), cannot)
ok('and does not blame the code', !/does not typecheck/i.test(cannot), cannot)

makeRepo({ typecheck: 'node -e "console.log(\'app.ts(1,1): error TS1005: oops\'); process.exit(1)"' })
claimLaneA('s1')
workInLaneA()
const broken = lane('ready', '--session', 's1')
ok('a real type error is still called a type error', /does not typecheck/i.test(broken), broken)
ok('and it quotes the error', /TS1005/.test(broken), broken)

// ----------------------------------------------------------------

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
