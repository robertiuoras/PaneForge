// Regression test: a lane copy whose `git worktree add` was killed half way through its
// checkout is finished (only after proof that nothing in it is anybody's work) or left
// alone - never handed to a chat half made, never left out of the pool forever, never sent
// a recovery pane.
//
// The bug (taskdriver.ai, 7 Oct 2026): ensureWorktree ran `git worktree add` under the 20s
// git deadline. A kill mid-checkout left the copy with its gitdir `locked` reading
// "initializing", NO index file, and only the head of HEAD's files on disk (lane d: 1,401 of
// 4,832 missing; lane f: 531 of 4,831). isWorktree() called that whole, so ensureWorktree
// never rebuilt it; damageOf() called it damaged, so it left the pool for good; and the
// completion clock sent a "Finish preserved work" pane at it.
//
// Real git repositories and worktrees in the temp folder, the real lane.mjs, no stubs. The
// half-made copies are built by hand (cross-platform) AND, on POSIX, by really killing git
// mid-checkout - the control that the hand-built shape is the real one.
//
//   node scripts/lane-halfmade-test.mjs
//   LANE_ENGINE=/path/to/other/lane.mjs node scripts/lane-halfmade-test.mjs
//     runs the same checks against another copy of the engine (`git show <old>:scripts/lane.mjs`).

import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// realpath: on macOS the temp root is `/var/...`, a link to `/private/var/...`, and the engine
// names its lanes by the real path.
const root = join(realpathSync(tmpdir()), 'paneforge-lane-halfmade-test')
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
const FILES = 200
// The file the checkout dies on. Index order: .gitattributes, .lanes.json, package.json,
// scripts/*, src/f000.js ... - so everything before src/f100.js is written, the rest is not.
const TRIP = 'src/f100.js'

function fixture(name, letters, { remote = false } = {}) {
  const repo = join(root, name)
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, version: '0.0.1' }, null, 2) + '\n')
  writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ release: 'merge', pool: ['main', ...letters] }, null, 2) + '\n')
  // Only does anything while a test configures `filter.trip.*`; otherwise git passes it through.
  writeFileSync(join(repo, '.gitattributes'), `${TRIP} filter=trip\n`)
  for (let i = 0; i < FILES; i++) writeFileSync(join(repo, 'src', `f${String(i).padStart(3, '0')}.js`), `export const n = ${i}\n`)
  installLane(here, repo)
  if (process.env.LANE_ENGINE) copyFileSync(process.env.LANE_ENGINE, join(repo, 'scripts', 'lane.mjs'))
  git(repo, 'init', '-q', '-b', 'master')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'first')
  const first = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'src', 'later.js'), 'export const later = 1\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'second')
  git(repo, 'tag', 'v0.0.1')
  const extra = {}
  if (remote) {
    const origin = join(root, `${name}-origin.git`)
    git(root, 'init', '--bare', '-q', origin)
    git(repo, 'remote', 'add', 'origin', origin)
    git(repo, 'push', '-qu', 'origin', 'master', '--tags')
    // What the completion clock needs to believe it may look at all (lane-completion-test).
    const beats = join(repo, '.git', 'paneforge-panes')
    mkdirSync(beats)
    writeFileSync(join(beats, `pf-${process.pid}.json`), JSON.stringify({ at: Date.now(), chats: [] }))
    writeFileSync(join(repo, '.git', 'panes.txt'), '')
    writeFileSync(join(repo, '.git', 'processes.json'), '[]')
    extra.log = join(repo, '.git', 'completion.jsonl')
    extra.env = {
      LANE_PROCESSES_FILE: join(repo, '.git', 'processes.json'),
      PF_CTL_NO_APP: '1',
      LANE_PANES_FILE: join(repo, '.git', 'panes.txt'),
      LANE_COMPLETION_LOG: extra.log,
      LANE_REGISTRY: join(repo, '.git', 'registry.json'),
      CLAUDE_CONFIG_DIR: join(root, 'claude')
    }
  }
  const lane = (...args) => {
    const r = spawnSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PF_PANE: '', ...(extra.env ?? {}) },
      timeout: 120_000
    })
    return { ok: r.status === 0, code: r.status, signal: r.signal, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
  }
  const claim = (session, ...more) => {
    const r = lane('claim', '--session', session, ...more)
    try {
      return r.ok ? JSON.parse(r.out) : { error: r.err || r.out, signal: r.signal }
    } catch {
      return { error: r.out }
    }
  }
  const laneOf = (id) => JSON.parse(lane('status').out).lanes.find((l) => l.lane === id)
  const head = git(repo, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')
  return { repo, lane, claim, laneOf, head, first, ...extra }
}

const adminOf = (dir) => git(dir, 'rev-parse', '--absolute-git-dir')
const lockOf = (dir) => {
  try {
    return readFileSync(join(adminOf(dir), 'locked'), 'utf8').trim()
  } catch {
    return null
  }
}
const hasIndex = (dir) => existsSync(join(adminOf(dir), 'index'))
/** Every file on disk under `dir`, relative, `/`-separated, the root `.git` file left out. */
function onDisk(dir, rel = '') {
  const out = []
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name
    if (p === '.git') continue
    if (e.isDirectory()) out.push(...onDisk(dir, p))
    else out.push(p)
  }
  return out.sort()
}
const mtimes = (dir, files) => Object.fromEntries(files.map((p) => [p, statSync(join(dir, p)).mtimeMs]))

/**
 * A lane copy the way a killed `git worktree add` leaves it: registered, HEAD on the lane
 * branch, `locked` = `lock`, no index, and the first `keep` files of HEAD (index order) on disk,
 * byte for byte.
 */
function halfMake(f, slot, { lock = 'initializing', keep = 120 } = {}) {
  const dir = `${f.repo}-${slot}`
  git(f.repo, 'worktree', 'add', '-q', '--no-checkout', '-b', `lane-${slot}`, dir, 'master')
  const admin = adminOf(dir)
  writeFileSync(join(admin, 'locked'), `${lock}\n`)
  for (const p of f.head.slice(0, keep)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), execFileSync('git', ['cat-file', 'blob', `HEAD:${p}`], { cwd: f.repo }))
  }
  return dir
}

/** The copy is whole: index, every HEAD file, no lock, nothing for git to report. */
function whole(f, dir) {
  // The engine's own node_modules link (excluded through info/exclude) is the one thing allowed.
  const status = git(dir, 'status', '--porcelain', '--untracked-files=all', '--ignored').split('\n').filter((l) => l && l !== '!! node_modules').join('\n')
  const files = onDisk(dir).filter((p) => p !== 'node_modules')
  const missing = f.head.filter((p) => !files.includes(p))
  return {
    ok: hasIndex(dir) && lockOf(dir) === null && missing.length === 0 && status === '' && git(dir, 'ls-files').split('\n').length === f.head.length,
    detail: `index ${hasIndex(dir)}, lock ${JSON.stringify(lockOf(dir))}, missing ${missing.length}, status ${JSON.stringify(status.slice(0, 300))}`
  }
}

// ------------------------------------------------------------------ the incident shape

const f = fixture('demo', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
ok(`the fixture has enough files to cut part way (${f.head.length} at HEAD)`, f.head.length > 150 && f.head.indexOf(TRIP) > 100, f.head.indexOf(TRIP))

const a = halfMake(f, 'a')
const keptA = onDisk(a)
ok(
  'control: the half-made copy looks like the incident - lock "initializing", no index, only the head of HEAD on disk',
  lockOf(a) === 'initializing' && !hasIndex(a) && keptA.length === 120 && keptA.every((p, i) => p === [...f.head.slice(0, 120)].sort()[i]),
  `${lockOf(a)} ${hasIndex(a)} ${keptA.length}`
)
ok(
  'control: git reports every file as a staged deletion, and git calls it a worktree',
  git(a, 'status', '--porcelain').split('\n').filter((l) => l.startsWith('D ')).length === f.head.length && git(a, 'rev-parse', '--is-inside-work-tree') === 'true'
)
const A0 = f.laneOf('a')
ok('status before anything: the half-made copy is reported damaged, not handed out on sight', A0.damaged === true, JSON.stringify(A0))
const beforeA = mtimes(a, keptA)

const gotA = f.claim('sess-in-a', '--prefer', 'a', '--cwd', a)
ok('a chat asking for the half-made copy is given it - finished first', gotA.lane === 'a', JSON.stringify(gotA))
const wA = whole(f, a)
ok('and it is whole: index written, every HEAD file there, lock dropped, git reports nothing', wA.ok, wA.detail)
ok(
  'only the missing files were written: every file that was already there is untouched',
  keptA.every((p) => statSync(join(a, p)).mtimeMs === beforeA[p]),
  keptA.filter((p) => statSync(join(a, p)).mtimeMs !== beforeA[p]).slice(0, 5).join(', ')
)
const A1 = f.laneOf('a')
ok('status after: not damaged, nothing missing', A1.damaged === false && A1.missingFiles === 0, JSON.stringify(A1))

// ------------------------------------------------------------------ anything doubtful is left alone

// b: something that is not HEAD's is in it - a chat's private file
const b = halfMake(f, 'b')
mkdirSync(join(b, '.claude'), { recursive: true })
writeFileSync(join(b, '.claude', 'settings.local.json'), '{}\n')
// c: a file that is there differs from HEAD
const c = halfMake(f, 'c')
writeFileSync(join(c, 'src', 'f010.js'), 'export const n = "edited"\n')
// d: a recovery item is still open on it
const d = halfMake(f, 'd')
writeFileSync(
  join(f.repo, '.git', 'paneforge-recovery.json'),
  JSON.stringify({ items: { [`lane:d:${git(f.repo, 'rev-parse', 'lane-d')}`]: { key: `lane:d:${git(f.repo, 'rev-parse', 'lane-d')}`, lane: 'd', commit: git(f.repo, 'rev-parse', 'lane-d'), status: 'blocked', at: Date.now() } } }, null, 2)
)
// e: HEAD is not the lane branch's tip
const e = halfMake(f, 'e')
writeFileSync(join(adminOf(e), 'HEAD'), `${f.first}\n`)
// g: a git that may still be writing it (a fresh index.lock)
const g = halfMake(f, 'g')
writeFileSync(join(adminOf(g), 'index.lock'), '')

const shape = (dir) => JSON.stringify({ lock: lockOf(dir), index: hasIndex(dir), files: onDisk(dir) })
const was = Object.fromEntries([b, c, d, e, g].map((dir) => [dir, shape(dir)]))
for (const [slot, dir, why] of [
  ['b', b, 'an untracked file'],
  ['c', c, 'a file that differs from HEAD'],
  ['d', d, 'an open recovery item'],
  ['e', e, 'HEAD that is not the branch tip'],
  ['g', g, 'a fresh index.lock']
]) {
  const got = f.claim(`sess-in-${slot}`, '--prefer', slot, '--cwd', dir)
  ok(`${slot} (${why}): a chat standing in it is sent elsewhere`, got.lane && got.lane !== slot, JSON.stringify(got))
  f.lane('release', '--session', `sess-in-${slot}`)
  ok(`${slot} (${why}): nothing was written, staged or unlocked`, shape(dir) === was[dir], `${was[dir].slice(0, 200)}\n${shape(dir).slice(0, 200)}`)
}
ok('the untracked file is still there', readFileSync(join(b, '.claude', 'settings.local.json'), 'utf8') === '{}\n')
ok('the edited file is still edited', readFileSync(join(c, 'src', 'f010.js'), 'utf8').includes('edited'))

// ------------------------------------------------------------------ the explicit command

{
  const h = fixture('explicit', ['a', 'b'])
  const dir = halfMake(h, 'a', { keep: 60 })
  const done = h.lane('finish-copy', '--lane', 'a')
  let said = {}
  try {
    said = JSON.parse(done.out)
  } catch {
    /* reported below */
  }
  ok('finish-copy finishes a half-made copy and says how many files it wrote', done.ok && said.finished === true && said.wrote === h.head.length - 60 && said.kept === 60, `${done.out}\n${done.err}`)
  const w = whole(h, dir)
  ok('and the copy is whole', w.ok, w.detail)
  const again = h.lane('finish-copy', '--lane', 'a')
  ok('a second run has nothing to do and says so', !again.ok && /never finished|not a copy/i.test(again.err + again.out), again.err + again.out)
  const other = halfMake(h, 'b')
  writeFileSync(join(other, 'stray.txt'), 'mine\n')
  const before = shape(other)
  const refused = h.lane('finish-copy', '--lane', 'b')
  ok('it refuses a copy with something in it that is not HEAD\'s, naming it', !refused.ok && /stray\.txt/.test(refused.err + refused.out), refused.err + refused.out)
  ok('and leaves it exactly as it was', shape(other) === before)
  // A lock that git abandoned long ago is not a live git: finished, and the stale lock goes.
  const stale = join(adminOf(other), 'index.lock')
  rmSync(join(other, 'stray.txt'))
  writeFileSync(stale, '')
  const old = (Date.now() - 10 * 60_000) / 1000
  utimesSync(stale, old, old)
  const finished = h.lane('finish-copy', '--lane', 'b')
  ok('an index.lock abandoned for 10 minutes does not stop it, and is cleared', finished.ok && !existsSync(stale) && whole(h, other).ok, finished.err + finished.out)
}

// ------------------------------------------------------------------ the pool, not just a chat that asks

{
  const p = fixture('pool', ['a'])
  p.claim('sess-main', '--prefer', 'main')
  const dir = halfMake(p, 'a')
  const got = p.claim('sess-next')
  ok('a plain claim with only the half-made copy left gets it, finished', got.lane === 'a' && whole(p, dir).ok, JSON.stringify(got))
}

// ------------------------------------------------------------------ the engine's own add, failing part way

{
  const p = fixture('fresh', ['a'])
  p.claim('sess-main', '--prefer', 'main')
  // A smudge filter that fails on TRIP: git dies mid-checkout with the head of HEAD written.
  git(p.repo, 'config', 'filter.trip.smudge', 'false')
  git(p.repo, 'config', 'filter.trip.required', 'true')
  const dir = `${p.repo}-a`
  const failedClaim = p.claim('sess-1')
  ok('a checkout that fails part way makes the claim fail', Boolean(failedClaim.error), JSON.stringify(failedClaim))
  ok('and takes back what that call made: no folder, no registration', !existsSync(dir) && !git(p.repo, 'worktree', 'list', '--porcelain').includes(dir), git(p.repo, 'worktree', 'list', '--porcelain'))
  git(p.repo, 'config', '--unset', 'filter.trip.smudge')
  git(p.repo, 'config', '--unset', 'filter.trip.required')
  const next = p.claim('sess-2')
  ok('the next claim builds it cleanly and whole', next.lane === 'a' && whole(p, dir).ok, JSON.stringify(next))
  // A folder that was there (proven empty) is put back empty, never deleted.
  const q = fixture('fresh-empty', ['a'])
  q.claim('sess-main', '--prefer', 'main')
  const qdir = `${q.repo}-a`
  mkdirSync(qdir)
  git(q.repo, 'config', 'filter.trip.smudge', 'false')
  git(q.repo, 'config', 'filter.trip.required', 'true')
  q.claim('sess-1')
  ok('an empty folder that was already there is left there, empty', existsSync(qdir) && readdirSync(qdir).length === 0, existsSync(qdir) ? readdirSync(qdir).join(',') : 'gone')
}

// ------------------------------------------------------------------ the completion clock

{
  const p = fixture('clock', ['a', 'b'], { remote: true })
  p.claim('sess-main', '--prefer', 'main')
  const dir = halfMake(p, 'a')
  const doubt = halfMake(p, 'b')
  writeFileSync(join(doubt, 'stray.txt'), 'mine\n')
  const r = p.lane('retry')
  const sent = existsSync(p.log) ? readFileSync(p.log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  ok('the clock runs', r.ok, r.err)
  ok('it finishes the half-made copy instead of sending a recovery pane at it', !sent.some((s) => /lane:a:/.test(s.key)) && whole(p, dir).ok, JSON.stringify(sent))
  ok('a half-made copy with doubt in it still gets its one diagnostic owner, untouched', sent.some((s) => /lane:b:/.test(s.key)) && existsSync(join(doubt, 'stray.txt')) && !hasIndex(doubt), JSON.stringify(sent))
}

// ------------------------------------------------------------------ the real thing: git killed mid-checkout

if (process.platform !== 'win32') {
  // Kill the checkout's parent outright (SIGKILL: no clean-up) and the checkout itself with
  // a signal it catches (it removes its index.lock and dies). Both measured shapes:
  // taskdriver.ai-d and -f had no index.lock left.
  const killer = 'kill -9 $(ps -o ppid= -p $PPID); kill -TERM $PPID; cat'
  {
    const p = fixture('killed-git', ['a'])
    const dir = `${p.repo}-a`
    git(p.repo, 'config', 'filter.trip.smudge', killer)
    try {
      git(p.repo, 'worktree', 'add', '-q', '-b', 'lane-a', dir, 'master')
    } catch {
      /* killed, as intended */
    }
    git(p.repo, 'config', '--unset', 'filter.trip.smudge')
    const files = existsSync(dir) ? onDisk(dir) : []
    ok(
      'control: a really killed `git worktree add` leaves exactly the hand-built shape',
      lockOf(dir) === 'initializing' && !hasIndex(dir) && !existsSync(join(adminOf(dir), 'index.lock')) && files.length > 0 && files.length < p.head.length && !files.includes(TRIP),
      `lock ${lockOf(dir)}, index ${hasIndex(dir)}, ${files.length} of ${p.head.length}`
    )
    p.claim('sess-main', '--prefer', 'main')
    const got = p.claim('sess-next')
    ok('and the next claim finishes it and hands it out whole', got.lane === 'a' && whole(p, dir).ok, JSON.stringify(got))
  }
  {
    // The engine itself killed mid-checkout (a hook deadline killing the whole process tree):
    // nothing in that run can clean up, so the next one has to recognise and finish it.
    const p = fixture('killed-engine', ['a'])
    p.claim('sess-main', '--prefer', 'main')
    const dir = `${p.repo}-a`
    git(p.repo, 'config', 'filter.trip.smudge', 'kill -9 $(ps -o ppid= -p $PPID) $PPID; cat')
    const died = p.claim('sess-1')
    git(p.repo, 'config', '--unset', 'filter.trip.smudge')
    ok('control: the engine really died mid-checkout and left a half-made copy', died.signal === 'SIGKILL' && existsSync(dir) && !hasIndex(dir) && lockOf(dir) !== null, `${JSON.stringify(died)} lock ${lockOf(dir)}`)
    const st = p.laneOf('a')
    ok('status says it is not usable', st.damaged === true, JSON.stringify(st))
    const got = p.claim('sess-2')
    ok('the next claim finishes it and hands it out whole', got.lane === 'a' && whole(p, dir).ok, JSON.stringify(got))
  }
}

console.log(failed ? `\n${failed} failed (${passed} ok)` : `\nall half-made-copy checks passed (${passed} ok)`)
process.exit(failed ? 1 : 0)
