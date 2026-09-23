// `lane.mjs sweep` removes checkout folders nobody uses, and never the work in them.
//
// Measured 2026-09-23: taskdriver.ai had 18 checkout folders, ~36 GB, on a disk 94% full,
// and nothing ever deleted one. The sweep deletes folders, so every reason it KEEPS one is
// pinned here, and so is where the work of a removed one went: commits and unsaved edits on
// origin, untracked and ignored files in an archive, dependencies and build output nowhere.
//
// Real git, a real bare origin, real lane.mjs, a real process sitting in a folder. The one
// stand-in is `LANE_PANES_FILE`, which answers for PaneForge's `pf list`.
//
// (lane-sweep-test.mjs is the APP's sweep of empty lane branches, src/main/laneWork.ts.)
//
//   node scripts/lane-sweep-folders-test.mjs

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// realpath: macOS says /var/folders where git and lsof say /private/var/folders.
const root = join(realpathSync(tmpdir()), 'paneforge-lane-sweep-folders-test')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
const home = join(root, 'home')
mkdirSync(home)
const panesFile = join(root, 'panes.tsv')

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${String(detail).split('\n').join('\n      ')}`)
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
const commit = (cwd, file, subject) => {
  writeFileSync(join(cwd, file), `${subject}\n`)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-qm', subject)
}

const origin = join(root, 'demo.git')
const repo = join(root, 'demo')
git(root, 'init', '-q', '--bare', '-b', 'master', origin)
mkdirSync(join(repo, 'scripts'), { recursive: true })
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1' }, null, 2) + '\n')
writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules\n.next\n')
writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ pool: ['main', 'c', 'd', 'e', 'f', 'g', 'h', 'm', 'u', 'w'], release: 'merge' }, null, 2) + '\n')
installLane(here, repo)
git(repo, 'init', '-q', '-b', 'master')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'first')
git(repo, 'remote', 'add', 'origin', origin)
git(repo, 'push', '-q', '-u', 'origin', 'master')

const folder = (name) => join(root, name)
function addTree(name, branch, base = 'master') {
  git(repo, 'worktree', 'add', '-q', '-b', branch, folder(name), base)
  git(folder(name), 'config', 'user.email', 'test@example.com')
  git(folder(name), 'config', 'user.name', 'test')
  return folder(name)
}

/** Make a whole checkout look untouched for `ms` - its files, its folders and its git state. */
function age(dir, ms) {
  const t = new Date(Date.now() - ms)
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      utimesSync(p, t, t)
    }
    utimesSync(d, t, t)
  }
  walk(dir)
  const gitDir = git(dir, 'rev-parse', '--absolute-git-dir')
  for (const f of ['HEAD', 'index', join('logs', 'HEAD')]) if (existsSync(join(gitDir, f))) utimesSync(join(gitDir, f), t, t)
}
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

// c: an empty lane nobody uses - the ordinary case, removed. It carries a copied .env
// (ignored, archived) and dependencies (ignored, rebuilt, never archived).
const laneC = addTree('demo-c', 'lane-c')
writeFileSync(join(laneC, '.env'), 'SECRET=copied\n')
mkdirSync(join(laneC, 'node_modules', 'dep'), { recursive: true })
writeFileSync(join(laneC, 'node_modules', 'dep', 'index.js'), 'dependency\n')
// d: an empty lane touched a minute ago - removed too: no idle clock for a finished lane.
const laneD = addTree('demo-d', 'lane-d')
// m: a lane whose commit was merged into the project and pushed - finished, removed.
const laneM = addTree('demo-m', 'lane-m')
commit(laneM, 'merged.js', 'feat: merged back')
git(repo, 'merge', '-q', '--ff-only', 'lane-m')
git(repo, 'push', '-q', 'origin', 'master')
// w: a lane with a commit the project does not have - NEVER removed, however old.
const laneW = addTree('demo-w', 'lane-w')
commit(laneW, 'work.js', 'feat: not merged')
// u: a lane with only an unsaved new file - NEVER removed, however old.
const laneU = addTree('demo-u', 'lane-u')
writeFileSync(join(laneU, 'draft.md'), 'half-written\n')
// e: old, but a PaneForge pane (an asleep one) is open in it - kept.
const laneE = addTree('demo-e', 'lane-e')
// f: old, but the ledger says a chat holds it - kept.
const laneF = addTree('demo-f', 'lane-f')
// g: old, but a program is running in it - kept. POSIX only: Windows has no `lsof`, and
// there the pane check and the idle clock decide alone.
const posix = process.platform !== 'win32'
const laneG = posix ? addTree('demo-g', 'lane-g') : null
// A hand-made checkout of a feature branch, four days idle, carrying everything that can be
// lost: a commit origin lacks, an unsaved edit, an untracked file, an ignored .env - kept.
const feature = addTree('demo-feature', 'feat/x')
commit(feature, 'feature.js', 'feat: only in this folder')
writeFileSync(join(feature, 'feature.js'), 'edited but never committed\n')
writeFileSync(join(feature, 'notes.md'), 'untracked notes\n')
writeFileSync(join(feature, '.env'), 'SECRET=kept\n')
mkdirSync(join(feature, 'node_modules', 'dep'), { recursive: true })
writeFileSync(join(feature, 'node_modules', 'dep', 'index.js'), 'dependency\n')
mkdirSync(join(feature, '.next'), { recursive: true })
writeFileSync(join(feature, '.next', 'build.js'), 'build output\n')
// A hand-made checkout one day idle - under the three-day rule for non-lane folders.
const young = addTree('demo-young', 'feat/young')
// Four days idle but locked - somebody asked git to keep it.
const locked = addTree('demo-locked', 'feat/locked')
git(repo, 'worktree', 'lock', locked)

for (const d of [laneC, laneE, laneF, laneG, laneM].filter(Boolean)) age(d, 7 * HOUR)
for (const d of [laneW, laneU]) age(d, 30 * DAY)
age(laneD, 60 * 1000)
age(feature, 4 * DAY)
age(young, 1 * DAY)
age(locked, 4 * DAY)

writeFileSync(
  panesFile,
  [
    // `exited` is how an ASLEEP pane lists, and it wakes back into its folder.
    ['1', 's1-x', 'exited', 'demo', laneE],
    ['3', 's3-x', 'idle', 'demo', repo]
  ]
    .map((c) => c.join('\t'))
    .join('\n') + '\n'
)
const state = join(repo, '.git', 'paneforge-lanes.json')
writeFileSync(
  state,
  JSON.stringify({ lanes: { f: { session: 'someone', cwd: laneF, claimed: Date.now() - 7 * HOUR, seen: Date.now() - 7 * HOUR } }, ready: {}, conflicts: {} }, null, 2)
)
const sleeper = posix ? spawn('sleep', ['3600'], { cwd: laneG, stdio: 'ignore' }) : null

const lane = (env, ...args) => {
  try {
    return execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, HOME: home, USERPROFILE: home, LANE_PANES_FILE: panesFile, ...env }
    }).trim()
  } catch (e) {
    return String(e.stdout ?? '') + String(e.stderr ?? '')
  }
}

try {
  // ------------------------------------------------------------ no answer, no sweep
  const blind = lane({ LANE_PANES_FILE: join(root, 'missing.tsv') }, 'sweep')
  ok('no answer from PaneForge removes nothing', /Nothing removed/.test(blind) && existsSync(laneC), blind)

  // ------------------------------------------------------------ dry run
  const dry = lane({}, 'sweep', '--dry-run')
  ok('dry run names the finished lane', /Would remove demo-c\b/.test(dry), dry)
  ok('dry run keeps the feature folder with work in it', /Keeping demo-feature: it has 1 saved change not in the main copy/.test(dry), dry)
  ok('dry run removes nothing', existsSync(laneC) && existsSync(laneD))

  // ------------------------------------------------------------ one sweep at a time
  const lockFile = join(repo, '.git', 'paneforge-sweep.lock')
  writeFileSync(lockFile, `${process.pid} ${Date.now()}\n`)
  const locked2 = lane({}, 'sweep')
  ok('a live sweep holding the lock stops a second one', /another sweep/.test(locked2) && existsSync(laneC), locked2)
  writeFileSync(lockFile, `999999 ${Date.now()}\n`)
  const stale = lane({}, 'sweep', '--dry-run')
  ok('a dry run ignores the lock', /Would remove demo-c\b/.test(stale), stale)
  rmSync(lockFile, { force: true })

  // ------------------------------------------------------------ the real sweep
  const said = lane({}, 'sweep')
  ok('the finished lane folder is gone', !existsSync(laneC), said)
  ok('its branch is kept', Boolean(git(repo, 'branch', '--list', 'lane-c')))
  ok('a finished lane used a minute ago is gone too', !existsSync(laneD), said)
  ok('a lane whose work was merged is gone', !existsSync(laneM), said)
  ok('a lane with an unmerged commit stays, a month idle', existsSync(laneW) && /Keeping demo-w: it has 1 saved change not in the main copy yet/.test(said), said)
  ok('its commit is still there', git(laneW, 'log', '-1', '--format=%s') === 'feat: not merged')
  ok('a lane with an unsaved file stays, a month idle', existsSync(laneU) && existsSync(join(laneU, 'draft.md')) && /Keeping demo-u: it has 1 unsaved file/.test(said), said)
  ok('the feature folder with work stays', existsSync(feature) && /Keeping demo-feature: it has 1 saved change/.test(said), said)
  ok('...with its unsaved edit untouched', readFileSync(join(feature, 'feature.js'), 'utf8') === 'edited but never committed\n')
  ok('nothing of it was pushed', !git(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').some((h) => h === 'feat/x' || h.startsWith('wip/')))
  ok('a lane with a pane open stays', existsSync(laneE) && /Keeping demo-e: a PaneForge pane is open/.test(said), said)
  ok('a lane a chat holds stays', existsSync(laneF) && /Keeping demo-f: a chat/.test(said), said)
  if (posix) ok('a lane a program runs in stays', existsSync(laneG) && /Keeping demo-g: a program is running/.test(said), said)
  ok('a hand-made folder idle for one day stays', existsSync(young) && /Keeping demo-young: it was used/.test(said), said)
  ok('a locked folder stays', existsSync(locked) && /Keeping demo-locked: somebody locked it/.test(said), said)
  ok('the main folder is never on the list', !/demo:|\bdemo \(/.test(said), said)

  const archives = join(home, '.local', 'share', 'worktree-archive')
  const day = existsSync(archives) ? readdirSync(archives)[0] : null
  const tgz = day ? join(archives, day, 'demo-c.tgz') : ''
  ok('the finished lane\'s ignored files were archived', Boolean(tgz) && existsSync(tgz) && statSync(tgz).size > 0, day)
  if (tgz && existsSync(tgz)) {
    const inside = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' })
    ok('the archive holds the copied .env', /(^|\r?\n)(\.\/)?\.env\r?\n/.test(inside), inside)
    ok('...and no dependencies', !/node_modules/.test(inside), inside)
  }
  ok('the finished lane is reported as already saved', /Removed the demo-c folder \(everything in it was already on the server; files git does not keep are in /.test(said), said)

  const doc = lane({}, 'doctor')
  ok('doctor lists what was cleaned up', /CLEANED UP[\s\S]*Removed the demo-c folder/.test(doc), doc)

  // ------------------------------------------------------------ once is enough
  const again = lane({}, 'sweep')
  ok('a second sweep removes nothing new', !/Removed/.test(again), again)

  // ------------------------------------------------------------ a removed lane comes back
  const claimed = lane({}, 'claim', '--session', 'newcomer', '--cwd', repo, '--prefer', 'c')
  ok('a chat can take the removed lane again', existsSync(laneC), claimed)

  // ------------------------------------------------------------ a chat letting go
  // SessionEnd runs `release`; the folder it held is finished, so it goes right after.
  lane({}, 'release', '--session', 'someone')
  const letGo = Date.now() + 60_000
  while (existsSync(laneF) && Date.now() < letGo) execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 500)'])
  ok('a finished lane goes once its chat lets go', !existsSync(laneF), lane({}, 'doctor'))

  // ------------------------------------------------------------ the clock
  // `retry` (the app's timer, lane-cron on the PC) starts the sweep every six hours.
  const laneH = addTree('demo-h', 'lane-h')
  age(laneH, 7 * HOUR)
  const stampFile = join(repo, '.git', 'paneforge-sweep-at')
  lane({}, 'sweep', '--if-due')
  ok('a repo never swept only starts the clock', existsSync(laneH) && existsSync(stampFile))
  lane({}, 'sweep', '--if-due')
  ok('inside six hours nothing is swept', existsSync(laneH))
  writeFileSync(stampFile, `${Date.now() - 7 * HOUR}\n`)
  lane({}, 'retry')
  const until = Date.now() + 60_000
  while (existsSync(laneH) && Date.now() < until) execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 500)'])
  ok('a due retry sweeps by itself', !existsSync(laneH), lane({}, 'doctor'))
  ok('...and takes the next six hours', Date.now() - Number(readFileSync(stampFile, 'utf8')) < HOUR)
} finally {
  sleeper?.kill()
}

console.log(failed ? `\n${failed} failed` : '\nall sweep-folder checks passed')
process.exit(failed ? 1 : 0)
