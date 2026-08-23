// Lanes in a repository that is not this one.
//
// `scripts/lane.mjs` was written for PaneForge and had PaneForge baked into it: the repo
// was wherever the script happened to sit, the branch was the literal word `master`, and
// finishing a lane always meant bumping package.json and cutting a GitHub release. None of
// that is what makes lanes worth having. Two chats in one checkout of ANY repository
// overwrite each other's edits and race the same index, and that is the whole problem.
//
// So the engine takes `--repo <dir>` and reads the rest from the repository itself. This
// test drives the real script against real throwaway repos and pins the three answers that
// are easy to get wrong once a second repo exists:
//
//   the branch is the repo's own (`main` here, not the word master)
//   a repo that has not asked for releases NEVER cuts a version - it merges and pushes
//   a repo that has asked for them cuts exactly the version PaneForge would have
//
// The last one matters most in the other direction: the engine's own repo must behave
// today exactly as it did before any of this, which the eight other lane tests cover by
// still passing.
//
//   node scripts/lane-anyrepo-test.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const ENGINE = join(repoRoot, 'scripts', 'lane.mjs')
const work = mkdtempSync(join(tmpdir(), 'pf-anyrepo-'))
let failures = 0

function ok(name, pass, detail = '') {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${pass || !detail ? '' : ` - ${detail}`}`)
  if (!pass) failures++
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`)
  return (r.stdout ?? '').trim()
}

/** The real CLI, exactly as the hook calls it. */
function lane(repo, ...args) {
  const r = spawnSync(process.execPath, [ENGINE, ...args, '--repo', repo], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000
  })
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}

/**
 * A project with an origin it can really push to, on `main` rather than `master` - the
 * branch name is half of what is being tested, so it must not be the one baked in before.
 */
function project(name, { lanes, version } = {}) {
  const origin = join(work, `${name}.git`)
  const repo = join(work, name)
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '--bare', '-q', origin], { windowsHide: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  writeFileSync(join(repo, 'app.js'), 'console.log(1)\n')
  if (version) writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, version }, null, 2) + '\n')
  if (lanes) writeFileSync(join(repo, '.lanes.json'), JSON.stringify(lanes, null, 2) + '\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', '-u', 'origin', 'main')
  return { repo, origin }
}

// ---------------------------------------------------------------- a plain project

{
  const { repo, origin } = project('plain')

  const first = JSON.parse(lane(repo, 'claim', '--session', 'chat-1', '--cwd', repo).out)
  ok('the first chat gets the project folder itself', first.lane === 'main' && first.dir === repo)
  ok("the branch is the repo's own, not the word master", first.branch === 'main', first.branch)
  ok('a repo that never asked for releases only merges', first.release === 'merge', first.release)
  ok('and it knows it is not the engine\'s own checkout', first.own === false)

  const second = JSON.parse(lane(repo, 'claim', '--session', 'chat-2', '--cwd', repo).out)
  const laneA = join(work, 'plain-a')
  ok('a second chat is moved into its own worktree', second.lane === 'a' && second.dir === laneA)
  ok('the worktree exists and is a checkout of the repo', existsSync(join(laneA, 'app.js')))
  ok('it is on its own branch off main', second.branch === 'lane-a')

  const refused = lane(repo, 'guard', '--session', 'chat-2', '--path', join(repo, 'app.js'))
  ok('chat 2 may not write in chat 1\'s checkout', refused.code === 2, refused.out)
  ok('and is told where its own is', refused.out.includes(laneA), refused.out)
  const allowed = lane(repo, 'guard', '--session', 'chat-2', '--path', join(laneA, 'app.js'))
  ok('but may write in its own', allowed.code === 0)

  writeFileSync(join(laneA, 'feature.js'), 'export const x = 1\n')
  git(laneA, 'add', '-A')
  git(laneA, 'commit', '-qm', 'feat: a thing')

  const done = lane(repo, 'ready', '--session', 'chat-2')
  ok('ready succeeds', done.code === 0, done.err)
  ok('the lane merged into main', existsSync(join(repo, 'feature.js')), done.out)
  ok('and was pushed', git(repo, 'rev-parse', 'HEAD') === git(origin, 'rev-parse', 'main'))
  ok('NO version was cut', git(repo, 'tag') === '', git(repo, 'tag'))
  ok('and the output says merged, not released', /merged into main/i.test(done.out), done.out)
}

// ---------------------------------------------------------------- one that does release

{
  const { repo } = project('shipper', { lanes: { release: 'version' }, version: '0.1.0' })

  JSON.parse(lane(repo, 'claim', '--session', 'ship-1', '--cwd', repo).out)
  const second = JSON.parse(lane(repo, 'claim', '--session', 'ship-2', '--cwd', repo).out)
  writeFileSync(join(second.dir, 'feature.js'), 'export const x = 1\n')
  git(second.dir, 'add', '-A')
  git(second.dir, 'commit', '-qm', 'feat: a thing')

  // `feat:`, and below 1.0 that is a PATCH: the release still reads its bump off its own
  // range, and `nextVersion` refuses to spend a minor on it while the major is 0.
  const done = lane(repo, 'ready', '--session', 'ship-2')
  ok('a repo that asked for versions cuts one', git(repo, 'tag') === 'v0.1.1', `${git(repo, 'tag')} / ${done.out}`)
  ok(
    'and the bump is in package.json',
    JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version === '0.1.1'
  )
  ok('the release commit is on main', git(repo, 'log', '-1', '--pretty=%s') === 'release: v0.1.1')
}

// ------------------------------------------- the one bump a commit may still ask for below 1.0

{
  const { repo } = project('breaker', { lanes: { release: 'version' }, version: '0.1.0' })

  JSON.parse(lane(repo, 'claim', '--session', 'brk-1', '--cwd', repo).out)
  const second = JSON.parse(lane(repo, 'claim', '--session', 'brk-2', '--cwd', repo).out)
  writeFileSync(join(second.dir, 'feature.js'), 'export const x = 1\n')
  git(second.dir, 'add', '-A')
  git(second.dir, 'commit', '-qm', 'feat!: a thing that breaks the old one')

  const done = lane(repo, 'ready', '--session', 'brk-2')
  ok('a breaking change still moves the minor', git(repo, 'tag') === 'v0.2.0', `${git(repo, 'tag')} / ${done.out}`)
  ok(
    'and it stops there - no 1.0.0 off a commit subject',
    !git(repo, 'tag').includes('v1.0.0'),
    git(repo, 'tag')
  )
}

// ------------------------------------------------- and the same repo, carrying only fixes

{
  const { repo } = project('patcher', { lanes: { release: 'version' }, version: '0.1.0' })

  JSON.parse(lane(repo, 'claim', '--session', 'pat-1', '--cwd', repo).out)
  const second = JSON.parse(lane(repo, 'claim', '--session', 'pat-2', '--cwd', repo).out)
  writeFileSync(join(second.dir, 'bug.js'), 'export const x = 1\n')
  git(second.dir, 'add', '-A')
  git(second.dir, 'commit', '-qm', 'fix: a thing')

  const done = lane(repo, 'ready', '--session', 'pat-2')
  ok('a release carrying only fixes stays a patch', git(repo, 'tag') === 'v0.1.1', `${git(repo, 'tag')} / ${done.out}`)
}

// ---------------------------------------------------------------- one that opted out

{
  const { repo } = project('optout', { lanes: { lanes: false } })
  const r = lane(repo, 'claim', '--session', 'no-1', '--cwd', repo)
  ok('a repo with lanes turned off is left alone', r.code === 0 && /turned off/.test(r.out), r.out)
  ok('and no worktree is made for it', !existsSync(join(work, 'optout-a')))
}

// ---------------------------------------------------------------- the engine's own repo

{
  // The one that must not have changed: driving THIS repo by --repo has to look exactly
  // like driving it by living in it, or every PaneForge release story is now wrong.
  const s = JSON.parse(lane(repoRoot, 'status').out)
  // It USED to be `version`, and this asserted that. Robert turned it off on 2026-08-23
  // ("wasting time with releases"): finishing work merges and pushes, and a version is cut
  // only when he asks, with `npm run ship`. The assertion is kept rather than deleted
  // because the flip is one line in `.lanes.json` and a silent flip back - by an editor, a
  // merge, or a script that thinks it knows better - would start publishing builds to his
  // machines again with nothing on screen saying so.
  ok('the engine repo does not cut a version by itself', s.mode === 'merge', s.mode)
  ok('...on its own branch', s.branch === 'master', s.branch)
  ok('...and is recognised as its own checkout', s.own === true)
}

try {
  rmSync(work, { recursive: true, force: true })
} catch {
  /* worktrees on Windows sometimes hold a handle for a moment - the temp dir is disposable */
}

console.log(failures ? `\n${failures} failed` : '\nall good')
process.exit(failures ? 1 : 0)
