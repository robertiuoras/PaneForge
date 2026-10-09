// Regression test: a lane folder gets the repository's generated git-hooks folder, so a commit
// made in a lane runs the same pre-commit checks a commit in the main checkout does.
//
// The bug this exists for (Toolstash, 2026-10-09): the shared .git/config says
// `core.hooksPath = .husky/_`, a path relative to each checkout's root. `.husky/_` is husky's
// generated, gitignored stub folder, so it exists only in the main checkout. Git does not warn
// about a hooks folder that is not there - it just skips every hook - so every commit in
// Toolstash lanes a to h skipped eslint, tsc and check:arch. Lane a shipped two TypeScript
// errors that way and the release job then refused main ("main does not typecheck").
//
// The rule: when the shared hooksPath is relative, exists in the main checkout, holds nothing
// git tracks, and is missing in the lane folder, the engine COPIES it in (never a link, never
// over one that is already there). A folder git tracks arrives with the checkout and is left to it.
// Real repositories and real worktrees in the temp folder, the real lane.mjs, real `git commit`.
//
//   node scripts/lane-hookspath-test.mjs
//   LANE_ENGINE=/path/to/other/lane.mjs node scripts/lane-hookspath-test.mjs
//     runs the same checks against another copy of the engine - how "the new checks fail on the
//     old source" is shown: `git show <old>:scripts/lane.mjs > /tmp/old-lane.mjs`.

import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(realpathSync(tmpdir()), 'paneforge-lane-hookspath-test')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

let failed = 0
let passed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (cond) passed++
  else {
    failed++
    if (detail) console.log(`      ${String(detail).split('\n').join('\n      ')}`)
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

const HOOK = '#!/bin/sh\necho ran > "$(git rev-parse --show-toplevel)/hook-marker.txt"\n'

/**
 * A repository whose shared config names `hooksPath`. `tracked` = the hooks folder is committed
 * (a team's own `.githooks`); otherwise it is generated and ignored, the way husky writes `_`.
 */
function fixture(name, hooksPath, { tracked }) {
  const repo = join(root, name)
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, version: '0.0.1' }, null, 2) + '\n')
  writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ pool: ['main', 'a'] }, null, 2) + '\n')
  writeFileSync(join(repo, 'source.txt'), 'base\n')
  writeFileSync(join(repo, '.gitignore'), tracked ? 'hook-marker.txt\n' : `${hooksPath}/\nhook-marker.txt\n`)
  mkdirSync(join(repo, hooksPath), { recursive: true })
  writeFileSync(join(repo, hooksPath, 'pre-commit'), HOOK)
  chmodSync(join(repo, hooksPath, 'pre-commit'), 0o755)
  installLane(here, repo)
  if (process.env.LANE_ENGINE) copyFileSync(process.env.LANE_ENGINE, join(repo, 'scripts', 'lane.mjs'))
  git(repo, 'init', '-q', '-b', 'master')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'config', 'core.hooksPath', hooksPath)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'first')
  git(repo, 'tag', 'v0.0.1')
  rmSync(join(repo, 'hook-marker.txt'), { force: true })

  const claim = (session) => {
    const r = execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), 'claim', '--prefer', 'a', '--session', session], {
      cwd: repo,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, PF_PANE: '' }
    })
    return JSON.parse(r.trim())
  }
  return { repo, claim }
}

/** Commit one change in `dir` and say whether the pre-commit hook ran for it. */
function commitIn(dir, text) {
  rmSync(join(dir, 'hook-marker.txt'), { force: true })
  writeFileSync(join(dir, 'source.txt'), text)
  git(dir, 'add', 'source.txt')
  git(dir, 'commit', '-qm', `change ${text.trim()}`)
  return existsSync(join(dir, 'hook-marker.txt'))
}

// ---- generated hooks folder (husky's `_`): the case that shipped broken code
{
  const f = fixture('generated', '.husky/_', { tracked: false })
  ok('the hooks folder is only in the main checkout to begin with', existsSync(join(f.repo, '.husky', '_', 'pre-commit')) && git(f.repo, 'ls-files', '--', '.husky/_') === '')
  const lane = f.claim('s1')
  ok('claim gave a lane folder', lane.lane === 'a' && existsSync(lane.dir), JSON.stringify(lane))
  ok('the new lane folder has the hooks folder', existsSync(join(lane.dir, '.husky', '_', 'pre-commit')), lane.dir)
  ok('it is a copy, not a link to the main checkout', existsSync(join(lane.dir, '.husky', '_')) && !lstatSync(join(lane.dir, '.husky', '_')).isSymbolicLink() && !lstatSync(join(lane.dir, '.husky', '_', 'pre-commit')).isSymbolicLink())
  ok('a commit in the lane runs the pre-commit hook', commitIn(lane.dir, 'one\n'))

  // A lane made before the fix has no such folder: its next claim brings it in.
  rmSync(join(lane.dir, '.husky'), { recursive: true, force: true })
  ok('an older lane really is missing the folder', !existsSync(join(lane.dir, '.husky', '_')))
  f.claim('s1')
  ok('the next claim of an existing lane puts the hooks folder back', existsSync(join(lane.dir, '.husky', '_', 'pre-commit')))
  ok('and a commit there runs the hook again', commitIn(lane.dir, 'two\n'))

  // A hooks folder already in the lane is somebody's; it is never overwritten.
  mkdirSync(join(lane.dir, '.husky', '_'), { recursive: true })
  writeFileSync(join(lane.dir, '.husky', '_', 'pre-commit'), '#!/bin/sh\n# lane-local\n')
  f.claim('s1')
  ok('an existing hooks folder in the lane is left exactly as it is', readFileSync(join(lane.dir, '.husky', '_', 'pre-commit'), 'utf8') === '#!/bin/sh\n# lane-local\n')
}

// ---- tracked hooks folder: it arrives with the checkout, so it is not copied around it
{
  const f = fixture('tracked', '.githooks', { tracked: true })
  const lane = f.claim('s2')
  ok('a tracked hooks folder comes with the lane checkout', existsSync(join(lane.dir, '.githooks', 'pre-commit')), lane.dir)
  rmSync(join(lane.dir, '.githooks'), { recursive: true, force: true })
  f.claim('s2')
  ok('a folder git tracks is not copied in over the lane\'s own deletion', !existsSync(join(lane.dir, '.githooks')))
}

// ---- no hooksPath at all: nothing is created
{
  const f = fixture('plain', '.husky/_', { tracked: false })
  git(f.repo, 'config', '--unset', 'core.hooksPath')
  const lane = f.claim('s3')
  ok('a repository with no hooksPath gets no hooks folder in its lanes', !existsSync(join(lane.dir, '.husky', '_')))
}

rmSync(root, { recursive: true, force: true })
console.log(failed ? `\n${failed} FAILED, ${passed} passed` : `\nall passed (${passed})`)
process.exit(failed ? 1 : 0)
