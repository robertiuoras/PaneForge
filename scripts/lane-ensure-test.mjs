// ensureLaneFolder(): a lane the sweep reclaimed is rebuilt before a session is spawned
// into it.
//
// The bug this pins down had no error message of its own. sweepLanes() removes a lane that
// is merged, empty and unheld, which is correct. A pane restored after the app was closed
// still remembers that folder as its cwd, and Claude Code spawns every hook with the
// session's cwd - so a cwd that is not there fails all of them at once with
// `posix_spawn '/bin/sh'` ENOENT, the lane hook included, which is the one thing that would
// have put the folder back. Its heal only runs on UserPromptSubmit. 2026-08-07: eight
// SessionStart hooks died that way in taskdriver.ai-a and the folder reappeared 33 seconds
// into the session, once a human had already typed.
//
// Real git in a temp folder, real lanes.ts, no stubs - same shape as lane-work-test.mjs.

import { buildSync } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '..')
// realpath: macOS hands out /var/folders/... for a temp dir git spells /private/var/...
const work = realpathSync(mkdtempSync(join(tmpdir(), 'pf-laneensure-')))
let failures = 0

function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` - ${detail}`}`)
  if (!ok) failures++
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`)
  return (r.stdout ?? '').trim()
}

/**
 * git in a folder that may not exist.
 *
 * Every assertion after the first one is about a rebuilt lane, so when the rebuild is what
 * broke, `git` above throws inside the fixture and the run dies on a stack trace naming a
 * temp directory instead of printing which checks failed. A red test has to stay readable
 * to be worth having: this returns '' and lets the checks report.
 */
function gitSoft(cwd, args) {
  if (!existsSync(cwd)) return ''
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  return r.status === 0 ? (r.stdout ?? '').trim() : ''
}

/** Bundle lanes.ts and import it - see loadLaneWork() in lane-work-test.mjs for why. */
async function loadLanes() {
  const out = join(work, 'lanes.bundle.mjs')
  buildSync({
    absWorkingDir: repoRoot,
    entryPoints: [join('src', 'main', 'lanes.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: out,
    external: ['electron']
  })
  return import(pathToFileURL(out).href)
}

const lanes = await loadLanes()

/** A repo with one commit and a real `<repo>-a` lane on branch `lane-a`. */
function fixture(name) {
  const repo = join(work, name)
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'app.js'), 'const a = 1\n')
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'test'])
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'first'])
  const lane = `${repo}-a`
  git(repo, ['worktree', 'add', '-b', 'lane-a', lane])
  return { repo, lane }
}

// ------------------------------------------------- the swept lane comes back

{
  const { repo, lane } = fixture('swept')
  // Exactly what sweepLanes() does to a lane holding nothing.
  git(repo, ['worktree', 'remove', lane])
  check('precondition: the sweep removed the lane folder', !existsSync(lane))

  lanes.ensureLaneFolder(lane)

  check('the lane folder is back', existsSync(lane))
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: lane,
    encoding: 'utf8'
  })
  check('it is a real worktree, not a bare folder', (inside.stdout ?? '').trim() === 'true')
  const head = gitSoft(lane, ['rev-parse', '--abbrev-ref', 'HEAD'])
  check('it is on the lane branch it was on before', head === 'lane-a', head || '(no checkout)')
  check('the repo checkout still lists it', git(repo, ['worktree', 'list']).includes(lane))
}

// ------------------------------------------------- the branch is gone too

{
  const { repo, lane } = fixture('nobranch')
  git(repo, ['worktree', 'remove', lane])
  git(repo, ['branch', '-D', 'lane-a'])

  lanes.ensureLaneFolder(lane)

  check('a lane whose branch was deleted is recreated', existsSync(lane))
  const head = gitSoft(lane, ['rev-parse', '--abbrev-ref', 'HEAD'])
  check('on a freshly cut lane-a', head === 'lane-a', head || '(no checkout)')
  void repo
}

// ------------------------------------------------- what it must NOT touch

{
  // A folder that is already there is somebody's checkout with work in it. Never rebuilt,
  // never reset - this function only ever fills in a hole.
  const { repo, lane } = fixture('present')
  writeFileSync(join(lane, 'wip.txt'), 'half a feature\n')
  lanes.ensureLaneFolder(lane)
  check('an existing lane is left completely alone', existsSync(join(lane, 'wip.txt')))
  void repo
}

{
  // `<something>-a` that is not a lane of a repo is a project in its own right. Dropping a
  // worktree on top of one would be the worst possible failure mode of this function.
  const stray = join(work, 'not-a-repo-a')
  mkdirSync(stray, { recursive: true })
  writeFileSync(join(stray, 'mine.txt'), 'not a lane\n')
  rmSync(stray, { recursive: true, force: true })
  lanes.ensureLaneFolder(stray)
  check('a missing folder whose parent is not a repo is not created', !existsSync(stray))
}

{
  const plain = join(work, 'plain-folder')
  lanes.ensureLaneFolder(plain)
  check('a path that is not lane-shaped is ignored', !existsSync(plain))
}

rmSync(work, { recursive: true, force: true })
console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
