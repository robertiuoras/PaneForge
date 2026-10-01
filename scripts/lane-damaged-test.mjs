// Regression test: a copy whose folder is a real worktree but is missing most of its files is
// reported as damaged and is never handed to a new chat.
//
// The bug this exists for (taskdriver.ai-a, 2026-09-30 8:45pm): the folder was a worktree
// whose index held 4,461 staged deletions with only `.claude/` and `..app/` left on disk.
// `laneWorkNow` only knew "is it a worktree" (`broken`), so this read `dirty: true,
// broken: false` - a chat mid-edit - and the copy was handed to a new chat, whose
// SessionStart hook crashed with MODULE_NOT_FOUND because the scripts it runs were among the
// files that were gone.
//
// The rule: a worktree AND more than half of the files tracked at HEAD are missing (deleted
// in the index or on disk). Real git repositories and real worktrees in the temp folder, the
// real lane.mjs, no stubs.
//
//   node scripts/lane-damaged-test.mjs
//   LANE_ENGINE=/path/to/other/lane.mjs node scripts/lane-damaged-test.mjs
//     runs the same checks against another copy of the engine - how "the new checks fail on the
//     old source" is shown: `git show <old>:scripts/lane.mjs > /tmp/old-lane.mjs`.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// realpath: on macOS the temp root is `/var/...`, a link to `/private/var/...`, and the engine
// names its lanes by the real path - a write to `/var/...` would match no lane at all.
const root = join(realpathSync(tmpdir()), 'paneforge-lane-damaged-test')
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

const FILLERS = 200

/** A repository with `FILLERS` ordinary files beside the engine, pool main + the given letters. */
function fixture(name, letters) {
  const repo = join(root, name)
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, version: '0.0.1' }, null, 2) + '\n')
  writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ pool: ['main', ...letters] }, null, 2) + '\n')
  for (let i = 0; i < FILLERS; i++) writeFileSync(join(repo, 'src', `f${String(i).padStart(2, '0')}.js`), `export const n = ${i}\n`)
  installLane(here, repo)
  if (process.env.LANE_ENGINE) copyFileSync(process.env.LANE_ENGINE, join(repo, 'scripts', 'lane.mjs'))
  git(repo, 'init', '-q', '-b', 'master')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'first')
  git(repo, 'tag', 'v0.0.1')

  /** `pane` is the PF_PANE the app gives every chat it starts; '' is a chat outside it. */
  const lane = (pane, ...args) => {
    try {
      return {
        ok: true,
        out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], {
          cwd: repo,
          encoding: 'utf8',
          stdio: 'pipe',
          env: { ...process.env, PF_PANE: pane }
        }).trim()
      }
    } catch (e) {
      return { ok: false, out: String(e.stdout ?? '').trim(), err: String(e.stderr ?? '').trim() }
    }
  }
  const claim = (pane, session, ...more) => {
    const r = lane(pane, 'claim', '--session', session, ...more)
    return r.ok ? JSON.parse(r.out) : { error: r.err || r.out }
  }
  const status = () => JSON.parse(lane('', 'status').out).lanes
  const laneOf = (id) => status().find((l) => l.lane === id)
  const state = () => JSON.parse(readFileSync(join(repo, '.git', 'paneforge-lanes.json'), 'utf8'))
  const tracked = Number(git(repo, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').length)
  return { repo, lane, claim, status, laneOf, state, tracked }
}

/** Remove `n` tracked files from a lane's folder; staged = the way the incident looked. */
function lose(dir, n, { stage }) {
  for (let i = 0; i < n; i++) rmSync(join(dir, 'src', `f${String(i).padStart(2, '0')}.js`))
  if (stage) git(dir, 'add', '-A')
}

/** A real worktree of `repo` for lane `slot`, the way the engine cuts one. */
function worktree(repo, slot) {
  const dir = `${repo}-${slot}`
  git(repo, 'worktree', 'add', '-q', '-b', `lane-${slot}`, dir, 'master')
  return dir
}

// ------------------------------------------------------------------ status: what is damaged

// g stays spare until a chat that asks for nothing takes it, so that chat shows the chooser
// passing over a and e rather than every lane being taken.
const f = fixture('demo', ['a', 'b', 'c', 'd', 'e', 'f', 'g'])
const T = f.tracked
const half = Math.floor(T / 2)
ok(`the fixture tracks enough files to cut at the half and at 75% (${T} files)`, T > 40 && Math.round(T * 0.75) <= FILLERS, String(T))

// a: the incident - three quarters of the files gone, staged, and an untracked `.claude/` left
const a = worktree(f.repo, 'a')
lose(a, Math.round(T * 0.75), { stage: true })
mkdirSync(join(a, '.claude'), { recursive: true })
writeFileSync(join(a, '.claude', 'settings.local.json'), '{}\n')
// b: a few files removed, the commonest "chat mid-edit" there is
const b = worktree(f.repo, 'b')
lose(b, 3, { stage: false })
// c: well past the point where the engine looks further (a refactor), still under half
const c = worktree(f.repo, 'c')
lose(c, 25, { stage: false })
// d, e: exactly half, and one more than half
const d = worktree(f.repo, 'd')
lose(d, half, { stage: true })
const e = worktree(f.repo, 'e')
lose(e, half + 1, { stage: false })
// f: untouched
worktree(f.repo, 'f')

// THE CONTROL. The incident folder really is a worktree git answers about, and really does
// look like a pile of staged deletions - the old engine's own predicate says "healthy".
ok(
  'the incident folder is a worktree whose index holds the deletions',
  git(a, 'rev-parse', '--is-inside-work-tree') === 'true' && git(a, 'status', '--porcelain').split('\n').filter((l) => l.startsWith('D ')).length === Math.round(T * 0.75),
  git(a, 'status', '--porcelain').slice(0, 200)
)

const A = f.laneOf('a')
ok('a: three quarters of the files gone is reported damaged', A.damaged === true, JSON.stringify(A))
ok('a: with how many are missing and how many the copy should have', A.missingFiles === Math.round(T * 0.75) && A.trackedFiles === T, `${A.missingFiles} of ${A.trackedFiles}, expected ${Math.round(T * 0.75)} of ${T}`)
ok('a: it is still a worktree, so `broken` keeps its meaning (not a worktree)', A.broken === false, JSON.stringify(A))
ok('a: nobody holds it', A.heldBy === null, JSON.stringify(A))

const B = f.laneOf('b')
ok('b: a few removed files are just uncommitted edits, not damage', B.dirty === true && B.damaged === false && B.broken === false, JSON.stringify(B))
const C = f.laneOf('c')
ok('c: 25 removed files (under half, past the look-further floor) are not damage', C.dirty === true && C.damaged === false, JSON.stringify(C))
const D = f.laneOf('d')
ok(`d: exactly half gone (${half} of ${T}) is not "more than half"`, D.dirty === true && D.damaged === false, JSON.stringify(D))
const E = f.laneOf('e')
ok(`e: one file past half (${half + 1} of ${T}) is damaged`, E.damaged === true && E.missingFiles === half + 1, JSON.stringify(E))
const F = f.laneOf('f')
ok('f: a normal clean copy is unchanged - not dirty, not damaged, not broken', F.dirty === false && F.damaged === false && F.broken === false && F.missingFiles === 0, JSON.stringify(F))

// ------------------------------------------------------------------ the words

const doctor = f.lane('', 'doctor').out
const row = (id) => new RegExp(`^\\s+${id}\\s+lane-${id}\\s+(.*)$`, 'm').exec(doctor)?.[1] ?? ''
ok(
  'doctor says what is wrong with the damaged copy, in plain words, with the numbers',
  row('a').includes(`missing most of its files (${Math.round(T * 0.75)} of ${T})`) && /never finished being made/.test(row('a')),
  doctor
)
ok('doctor tells whoever reads it what to do, and that no chat gets it', /not handed to a new chat; check it and move it out of the way/.test(row('a')), row('a'))
ok('doctor does not call the deletions "uncommitted edits"', !/uncommitted edits/.test(row('a')), row('a'))
ok('and the ordinary dirty copy is still described as uncommitted edits', /uncommitted edits/.test(row('b')) && !/missing most/.test(row('b')), row('b'))
ok('and the clean copy says nothing is wrong with it', !/missing most|uncommitted|NOT a worktree/.test(row('f')), row('f'))

// ------------------------------------------------------------------ never handed to a chat

const before = git(a, 'status', '--porcelain')
const askA = f.claim('', 'sess-asks-a', '--prefer', 'a', '--cwd', a)
ok('a chat standing in the damaged copy and asking for it is sent to another lane', askA.lane && askA.lane !== 'a' && askA.lane !== 'e', JSON.stringify(askA))
const askE = f.claim('', 'sess-asks-e', '--prefer', 'e', '--cwd', e)
ok('same for the copy that is one file past half', askE.lane && askE.lane !== 'a' && askE.lane !== 'e', JSON.stringify(askE))
const plain = f.claim('', 'sess-plain')
ok('a chat that asks for nothing is not given one either', plain.lane && plain.lane !== 'a' && plain.lane !== 'e', JSON.stringify(plain))
const held = f.state().lanes
ok('no hold was ever recorded on a damaged copy', !held.a && !held.e, JSON.stringify(Object.keys(held)))

const write = f.lane('', 'guard', '--session', 'sess-writes', '--path', join(a, 'src', 'f70.js'))
ok('a chat that writes into the damaged folder is refused and pointed at its own lane', !write.ok && /Make the change there|could not be given/.test(`${write.out}\n${write.err}`), `${write.out}\n${write.err}`)
ok('and nothing was written into the folder by the engine on the way', !existsSync(join(a, 'src', 'f70.js')) || before === git(a, 'status', '--porcelain'), git(a, 'status', '--porcelain').slice(0, 200))

// Control: an ordinary dirty copy that a chat stands in is still handed to it on request.
const askB = f.claim('', 'sess-asks-b', '--prefer', 'b', '--cwd', b)
ok('control: a chat standing in an ordinary dirty copy is still given it', askB.lane === 'b', JSON.stringify(askB))

// ------------------------------------------------------------------ nothing was repaired

ok('the damaged folder is exactly as it was: same deletions, nothing restored, nothing staged', git(a, 'status', '--porcelain') === before, git(a, 'status', '--porcelain').slice(0, 200))
ok('and what was left on disk is still there', existsSync(join(a, '.claude', 'settings.local.json')))

// ------------------------------------------------------------------ the pane that was cleared

{
  const g = fixture('cleared', ['a', 'b'])
  const first = g.claim('pane-1', 'before-clear', '--prefer', 'a')
  ok('a pane starts on lane a', first.lane === 'a', JSON.stringify(first))
  lose(first.dir, Math.round(g.tracked * 0.75), { stage: true })
  // /clear: the SessionEnd hook marks the old chat ended, its hold is still in the ledger.
  g.lane('pane-1', 'park', '--session', 'before-clear', '--ended')
  const after = g.claim('pane-1', 'after-clear', '--cwd', first.dir, '--prefer', 'a')
  ok('its next chat is not carried onto the copy that lost its files', after.lane && after.lane !== 'a', JSON.stringify(after))
  ok('the earlier hold stays where it was, for a person to look at', g.state().lanes.a?.session === 'before-clear', JSON.stringify(g.state().lanes))
}

// ------------------------------------------------------------------ nowhere to put a chat

{
  const g = fixture('lastone', ['a'])
  g.claim('', 'sess-main', '--prefer', 'main')
  const dir = worktree(g.repo, 'a')
  lose(dir, Math.round(g.tracked * 0.75), { stage: true })
  const r = g.claim('', 'sess-next')
  const said = r.error ?? JSON.stringify(r)
  ok('when the damaged copy is the only one left the chat is refused, not given it', Boolean(r.error), said)
  ok('and the refusal names it in words', /missing most of its files: a/.test(said) && /move it out of the way/.test(said), said)
}

console.log(failed ? `\n${failed} failed (${passed} ok)` : `\nall damaged-copy checks passed (${passed} ok)`)
process.exit(failed ? 1 : 0)
