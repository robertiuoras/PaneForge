// Lanes for somebody who is not the person who built them.
//
// The lane ENGINE has been repo-agnostic for a long time: `--repo <anywhere>`, per-repo
// `.lanes.json`, hooks that ship in the installer and wire themselves up. The two halves
// around it were not, and both failed in the same silent direction - a confident answer
// about the wrong repository, or no answer at all, with nothing on screen saying so:
//
//   1. `lane.mjs <cmd>` with no --repo used the checkout this FILE ships in. So `status`
//      run from any other project reported PaneForge's lanes, in PaneForge's words. Every
//      note that said "run it from the repo" was describing behaviour that did not exist.
//   2. the strip's findRepo() looked in four hardcoded folders for a checkout literally
//      named PaneForge or claude-orchestrator under ~/Desktop/Projects or ~/Projects, and
//      then ran `<that repo>/scripts/lane.mjs`. For every other user, and for every other
//      project here, the strip drew nothing and the automatic retry/hand-back never ran.
//   3. and the branch on the strip was the string "master", which is wrong for every repo
//      that uses `main` - which is most of them.
//
// So this is the "not PaneForge, not this machine" test: a repo with another name, in
// another folder, on another branch, driven with no flags.
//
//   node scripts/lane-anyuser-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'pf-anyuser-'))
let failures = 0
let loads = 0

function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` - ${detail}`}`)
  if (!ok) failures++
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

/** A real git repo, named nothing like PaneForge, on `main`, nowhere near ~/Projects. */
function makeRepo(name, branch = 'main') {
  const dir = join(work, name)
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '--initial-branch', branch)
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'first')
  return dir
}

// ------------------------------------------------------------------ 1. the engine, no flags

{
  const mine = makeRepo('acme-web')
  const out = execFileSync(process.execPath, [join(repoRoot, 'scripts', 'lane.mjs'), 'status'], {
    cwd: mine,
    encoding: 'utf8',
    stdio: 'pipe'
  })
  const status = JSON.parse(out)
  check('status with no --repo answers about the repo you are standing in', status.repo === 'acme-web',
    `said ${status.repo}`)
  check('and not about the checkout lane.mjs ships in', !String(status.main).includes('PaneForge'),
    String(status.main))
  check('and reads that repo’s own branch', status.branch === 'main', String(status.branch))

  // The flag still wins - the hooks pass it on every prompt and must keep steering.
  const other = makeRepo('acme-docs')
  const flagged = JSON.parse(
    execFileSync(process.execPath, [join(repoRoot, 'scripts', 'lane.mjs'), 'status', '--repo', other], {
      cwd: mine,
      encoding: 'utf8',
      stdio: 'pipe'
    })
  )
  check('--repo still beats the folder you are standing in', flagged.main === other, String(flagged.main))
}

{
  // A worktree of that repo answers with the MAIN checkout, because that is where the
  // shared .git - and so the one lane state file - lives.
  const mine = makeRepo('acme-api')
  const lane = join(work, 'acme-api-a')
  git(mine, 'worktree', 'add', '-b', 'lane-a', lane)
  const status = JSON.parse(
    execFileSync(process.execPath, [join(repoRoot, 'scripts', 'lane.mjs'), 'status'], {
      cwd: lane,
      encoding: 'utf8',
      stdio: 'pipe'
    })
  )
  check('a lane worktree answers with its main checkout', status.main === mine, String(status.main))
}

// ------------------------------------------------------------------ 2. the strip

const out = join(work, 'build')
execFileSync(
  process.execPath,
  [
    join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    join('src', 'main', 'laneBoard.ts'),
    '--outDir', out,
    '--rootDir', 'src',
    '--module', 'es2022',
    '--target', 'es2022',
    '--moduleResolution', 'bundler',
    '--skipLibCheck',
    '--strict'
  ],
  { cwd: repoRoot, stdio: 'pipe' }
)
writeFileSync(join(out, 'package.json'), '{"type":"module"}')

const load = () => import(`${pathToFileURL(join(out, 'main', 'laneBoard.js')).href}?n=${++loads}`)

/** The lane state file, where lane.mjs puts it: the repo's shared .git. */
function state(repo, lanes) {
  writeFileSync(
    join(repo, '.git', 'paneforge-lanes.json'),
    JSON.stringify({ lanes, ready: {}, conflicts: {}, release: null, lastShip: null })
  )
}

const CHAT = '9f0a1c22-1b3e-4f77-9a41-2b6d5c8e0a13'

{
  // Nothing is called PaneForge and PANEFORGE_REPO is not set. The only thing that knows
  // where the work is, is the pane sitting in it.
  delete process.env.PANEFORGE_REPO
  const mine = makeRepo('shopfront')
  state(mine, { main: { session: CHAT, cwd: mine, claimed: Date.now(), seen: Date.now() } })
  const { laneBoard } = await load()
  const board = laneBoard([{ id: 'pane1', cwd: mine, resumeId: CHAT }])
  check('the strip finds the repo a pane is open on', board?.repo === mine, String(board?.repo))
  check('and shows the lane held in it', board?.lanes.some((l) => l.lane === 'main' && l.held) === true)
  check('on that repo’s branch, not the string "master"',
    board?.lanes.find((l) => l.lane === 'main')?.branch === 'main',
    String(board?.lanes.find((l) => l.lane === 'main')?.branch))
}

{
  // A pane in a lane worktree still points at the main checkout's state file. This is the
  // normal case, not the exotic one: a chat given a lane is moved into `<repo>-a`.
  delete process.env.PANEFORGE_REPO
  const mine = makeRepo('bakery')
  const lane = join(work, 'bakery-a')
  git(mine, 'worktree', 'add', '-b', 'lane-a', lane)
  state(mine, { a: { session: CHAT, cwd: lane, claimed: Date.now(), seen: Date.now() } })
  const { laneBoard } = await load()
  const board = laneBoard([{ id: 'pane1', cwd: lane, resumeId: CHAT }])
  check('a pane inside a lane worktree resolves to the main checkout', board?.repo === mine, String(board?.repo))
}

{
  // `.lanes.json` overrides HEAD, the same order lane.mjs reads them in.
  delete process.env.PANEFORGE_REPO
  const mine = makeRepo('deli')
  writeFileSync(join(mine, '.lanes.json'), JSON.stringify({ branch: 'trunk' }))
  state(mine, { main: { session: CHAT, cwd: mine, claimed: Date.now(), seen: Date.now() } })
  const { laneBoard } = await load()
  const board = laneBoard([{ id: 'pane1', cwd: mine, resumeId: CHAT }])
  check('.lanes.json names the branch when it says so',
    board?.lanes.find((l) => l.lane === 'main')?.branch === 'trunk',
    String(board?.lanes.find((l) => l.lane === 'main')?.branch))
}

{
  // A pane on a repo that does not use lanes gets an empty strip - NOT the lanes of some
  // other checkout that happens to exist on this machine. This is the half that made the
  // feature confusing rather than merely absent: on the machine PaneForge is built on the
  // old guesses always hit, so a window doing something else showed PaneForge's lanes.
  delete process.env.PANEFORGE_REPO
  const bare = makeRepo('empty-shop')
  const { laneBoard } = await load()
  check('a pane on a repo with no lanes draws nothing', laneBoard([{ id: 'pane1', cwd: bare }]) === null)
}

{
  // The engine to run is the one on this machine, not one imagined inside the user's repo.
  const mine = makeRepo('florist')
  const { laneEngine } = await load()
  check('a project with no scripts/ of its own still finds no engine rather than a fake path',
    laneEngine(mine) === null, String(laneEngine(mine)))

  process.env.PANEFORGE_ENGINE = join(repoRoot, 'scripts', 'lane.mjs')
  const { laneEngine: withEnv } = await load()
  check('PANEFORGE_ENGINE points it at the shipped engine',
    withEnv(mine) === join(repoRoot, 'scripts', 'lane.mjs'), String(withEnv(mine)))
  delete process.env.PANEFORGE_ENGINE

  const { laneEngine: own } = await load()
  check('and PaneForge’s own checkout still uses the copy beside it',
    own(repoRoot) === join(repoRoot, 'scripts', 'lane.mjs'), String(own(repoRoot)))
}

console.log(failures ? `\n${failures} failed` : '\nall lanes work for any repo, any user')
process.exit(failures ? 1 : 0)
