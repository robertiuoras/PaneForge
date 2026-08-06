// A second machine must not re-release work the first one already shipped.
//
// Every release decision in `lane.mjs` is made from LOCAL tags. `bumpFor` reads the newest
// one to find the commits about to ship; `commitsSinceVersion` asks whether the current
// version's tag exists at all, and when it does not it falls back to counting the WHOLE
// history - which is never zero, so the guard that exists to say "nothing new since vX"
// silently waves through a release with nothing in it.
//
// Two machines share this repo, and a checkout routinely holds a release COMMIT without
// holding its TAG. On 2026-08-07 that shipped four empty releases in ninety minutes, two of
// them minor bumps: v0.5.0 re-read `feat(release): read the version bump off the commits`
// (shipped in v0.4.62 an hour earlier) and v0.7.0 re-read `feat: cap what transcripts cost`
// (shipped in v0.6.0). Both releases contained no commits at all.
//
// So this drives the real CLI against two clones of one origin and pins the two answers
// that were wrong:
//
//   the lagging machine cuts NOTHING, rather than a phantom minor
//   and it knows the tag exists, because it fetched before deciding
//
// The lag is reproduced exactly the way it happens: `fetch --no-tags` + merge, which is a
// checkout that has the commits and not the tag. Without syncTags() the second machine
// cuts v0.3.0 here.
//
//   node scripts/lane-tagsync-test.mjs

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const ENGINE = join(repoRoot, 'scripts', 'lane.mjs')
const work = mkdtempSync(join(tmpdir(), 'pf-tagsync-'))
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

function identify(repo) {
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
}

// ---------------------------------------------------------------- one origin, two machines

const origin = join(work, 'shared.git')
execFileSync('git', ['init', '--bare', '-q', origin], { windowsHide: true })

// Machine A: the one that releases first.
const alpha = join(work, 'alpha')
mkdirSync(alpha, { recursive: true })
git(alpha, 'init', '-q', '-b', 'main')
identify(alpha)
writeFileSync(join(alpha, 'package.json'), JSON.stringify({ name: 'shared', version: '0.1.0' }, null, 2) + '\n')
writeFileSync(join(alpha, '.lanes.json'), JSON.stringify({ release: 'version' }, null, 2) + '\n')
writeFileSync(join(alpha, 'app.js'), 'console.log(1)\n')
git(alpha, 'add', '-A')
git(alpha, 'commit', '-qm', 'init')
git(alpha, 'remote', 'add', 'origin', origin)
git(alpha, 'push', '-q', '-u', 'origin', 'main')

// Machine B: cloned BEFORE the release, which is what makes its tags lag.
const beta = join(work, 'beta')
execFileSync('git', ['clone', '-q', origin, beta], { windowsHide: true })
identify(beta)

// A ships a feature. This is the release that really happened, and the only one that should.
{
  lane(alpha, 'claim', '--session', 'a-1', '--cwd', alpha)
  const second = JSON.parse(lane(alpha, 'claim', '--session', 'a-2', '--cwd', alpha).out)
  writeFileSync(join(second.dir, 'feature.js'), 'export const x = 1\n')
  git(second.dir, 'add', '-A')
  git(second.dir, 'commit', '-qm', 'feat: a thing worth a minor')
  const done = lane(alpha, 'ready', '--session', 'a-2')
  ok('machine A cuts the release its commits asked for', git(alpha, 'tag') === 'v0.2.0', `${git(alpha, 'tag')} / ${done.out}`)
}

// B catches up the way a lagging checkout really does: the commits, not the tag.
git(beta, 'fetch', '-q', '--no-tags', 'origin', 'main')
git(beta, 'merge', '-q', '--ff-only', 'FETCH_HEAD')
ok(
  'machine B now has the release commit',
  JSON.parse(readFileSync(join(beta, 'package.json'), 'utf8')).version === '0.2.0'
)
ok('and does NOT have its tag - this is the whole setup', git(beta, 'tag') === '', git(beta, 'tag'))

// ---------------------------------------------------------------- what B must do about it

{
  lane(beta, 'claim', '--session', 'b-1', '--cwd', beta)
  const done = lane(beta, 'ready', '--session', 'b-1')

  const tags = git(beta, 'tag').split('\n').filter(Boolean).sort()
  ok(
    'the lagging machine releases NOTHING - no phantom minor',
    !tags.includes('v0.3.0'),
    `${tags.join(',') || 'none'} / ${done.out}`
  )
  ok(
    'and package.json is untouched',
    JSON.parse(readFileSync(join(beta, 'package.json'), 'utf8')).version === '0.2.0',
    JSON.parse(readFileSync(join(beta, 'package.json'), 'utf8')).version
  )
  ok(
    'because it fetched the tag before deciding',
    tags.includes('v0.2.0'),
    tags.join(',') || 'no tags at all'
  )
  ok(
    'and the release commit A made is still the newest thing on the branch',
    git(beta, 'log', '-1', '--pretty=%s') === 'release: v0.2.0',
    git(beta, 'log', '-1', '--pretty=%s')
  )
}

// ------------------------------------------- and a machine with REAL work still releases

{
  const second = JSON.parse(lane(beta, 'claim', '--session', 'b-2', '--cwd', beta).out)
  writeFileSync(join(second.dir, 'bug.js'), 'export const x = 2\n')
  git(second.dir, 'add', '-A')
  git(second.dir, 'commit', '-qm', 'fix: a real change')
  const done = lane(beta, 'ready', '--session', 'b-2')
  const tags = git(beta, 'tag').split('\n').filter(Boolean)
  ok(
    'a fetch that finds nothing new does not stop a release that has something',
    tags.includes('v0.2.1'),
    `${tags.join(',')} / ${done.out}`
  )
  ok(
    'and it is a patch, read off the fix - not a minor re-read from the last release',
    !tags.includes('v0.3.0'),
    tags.join(',')
  )
}

rmSync(work, { recursive: true, force: true })
console.log(failures ? `\n${failures} failed` : '\nall good')
process.exit(failures ? 1 : 0)
