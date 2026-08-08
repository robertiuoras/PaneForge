// Regression test for handing `main` back when the chat holding it is not using it.
//
// The bug this exists for: on 2026-08-07 taskdriver.ai's `main` lane was held by a chat in
// a DIFFERENT project that had run one command inside the folder six hours earlier and
// never said another word. Nothing was wrong with that claim - it just never ended, because
// the chat's window stayed open and the 12h stale sweep is for chats that died. So every
// taskdriver chat after it was sent to `lane-a`: a second checkout, a branch and a merge,
// none of which a chat alone in a repository needs. The idle sweep that already existed
// could not help - it only runs when the whole pool is full, and two chats never fill it.
//
// So: a `main` whose chat has been quiet for an hour and has left nothing behind goes to
// the chat that would otherwise open a worktree. Everything that makes the idle sweep safe
// applies here too - one uncommitted character, a ready mark or a conflict and it is left
// alone - plus two of its own: a chat that ASKED for a letter lane still gets it, and
// master's own commits are not a reason to wait, being everyone's already.
//
//   node scripts/idle-main-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-idle-main-test')
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
writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ pool: ['main', 'a', 'b'] }, null, 2) + '\n')
installLane(here, repo)
git(repo, 'init', '-q', '-b', 'master')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'first')
git(repo, 'tag', 'v0.0.1')

const lane = (...args) => {
  try {
    return {
      ok: true,
      out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], {
        cwd: repo,
        encoding: 'utf8',
        stdio: 'pipe'
      }).trim()
    }
  } catch (e) {
    return { ok: false, out: (e.stdout ?? '').toString().trim(), err: (e.stderr ?? '').toString().trim() }
  }
}
const claim = (session, ...rest) => lane('claim', '--session', session, ...rest)
const statePath = join(repo, '.git', 'paneforge-lanes.json')
const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
const patchState = (fn) => {
  const s = state()
  fn(s)
  writeFileSync(statePath, JSON.stringify(s, null, 2) + '\n', 'utf8')
}
/** Past the idle window, nowhere near the 12h stale sweep that would prove nothing here. */
const HOURS_2 = 2 * 60 * 60 * 1000
const quiet = (session, ago = HOURS_2) =>
  patchState((s) => {
    for (const c of Object.values(s.lanes)) if (c.session === session) c.seen = Date.now() - ago
  })
/** Put the ledger back to one quiet chat holding an empty `main`. */
const reset = () => {
  patchState((s) => {
    s.lanes = { main: { session: 'squatter', cwd: '/elsewhere', claimed: Date.now(), seen: Date.now() } }
    s.ready = {}
    s.conflicts = {}
  })
  quiet('squatter')
}

// ------------------------------------------------------------------ the squat itself

const first = JSON.parse(claim('squatter').out)
ok('the first chat gets main', first.lane === 'main', first.lane)

const busy = JSON.parse(claim('worker').out)
ok('a second chat while the first is live opens a worktree', busy.lane === 'a', busy.lane)

reset()
const taken = claim('worker')
ok('a chat arriving after an hour of silence gets main instead', taken.ok && JSON.parse(taken.out).lane === 'main', taken.err)
ok('and main now belongs to it', state().lanes.main?.session === 'worker')
ok('the quiet chat holds nothing', !Object.values(state().lanes).some((c) => c.session === 'squatter'))

// ------------------------------------------------------------------ never at a cost

reset()
writeFileSync(join(repo, 'half-typed.js'), 'export const y =\n')
const dirty = claim('worker')
ok('one uncommitted character keeps main where it is', dirty.ok && JSON.parse(dirty.out).lane === 'a', dirty.err)
ok('and the quiet chat still holds it', state().lanes.main?.session === 'squatter')
unlinkSync(join(repo, 'half-typed.js'))

reset()
patchState((s) => {
  // The mark names the commit it was made at, and a mark whose lane has moved since is
  // dropped as a lie (`reap`) - so a made-up hash proves nothing about this rule at all.
  s.ready.main = { at: Date.now(), commit: git(repo, 'rev-parse', 'HEAD'), commits: 1, session: 'squatter' }
})
const ready = claim('worker')
ok('a main waiting for its release is left alone', ready.ok && JSON.parse(ready.out).lane === 'a', ready.err)

reset()
patchState((s) => {
  for (const c of Object.values(s.lanes)) if (c.session === 'squatter') c.seen = Date.now() - 30 * 60 * 1000
})
const fresh = claim('worker')
ok('half an hour of quiet is not enough', fresh.ok && JSON.parse(fresh.out).lane === 'a', fresh.err)

// A chat sitting IN a lane checkout asked for that lane by name, and is not looking for
// main: taking it would move the folder out from under a chat mid-edit in it.
reset()
const preferred = claim('worker', '--prefer', 'b')
ok('a chat that asked for its own lane still gets it', preferred.ok && JSON.parse(preferred.out).lane === 'b', preferred.err)
ok('and main is untouched by that claim', state().lanes.main?.session === 'squatter')

// ...but a preference that was REFUSED protects nothing. The chat asked for a checkout
// somebody else is in, so it is being moved either way - and moving it to a third folder
// while an untouched `main` sits idle is the exact shape this whole sweep exists to stop.
reset()
patchState((s) => {
  s.lanes.b = { session: 'other', cwd: '/elsewhere', claimed: Date.now(), seen: Date.now() }
})
const refused = claim('worker', '--prefer', 'b')
ok(
  'a chat refused the lane it asked for still takes the idle main',
  refused.ok && JSON.parse(refused.out).lane === 'main',
  refused.err || refused.out
)
ok('and the quiet chat has been moved off it', state().lanes.main?.session === 'worker')

// Commits on master are the repository's, not the holding chat's - `busyLanes` reads them
// the same way, and a release waiting on them would wait for ever.
reset()
writeFileSync(join(repo, 'shipped.js'), 'export const z = 1\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'feat: something already on master')
const withCommits = claim('worker')
ok(
  'unreleased commits on master are not the holder’s work',
  withCommits.ok && JSON.parse(withCommits.out).lane === 'main',
  withCommits.err
)

// The chat that lost main is not broken by it: its next prompt claims a lane of its own.
const back = claim('squatter')
ok('the chat that went quiet gets a lane back when it returns', back.ok && JSON.parse(back.out).lane === 'a', back.err)

console.log(failed ? `\n${failed} failed` : '\nall idle-main checks passed')
process.exit(failed ? 1 : 0)
