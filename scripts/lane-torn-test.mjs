// A catch-up fast-forward killed part way is finished, not handed to a recovery chat.
//
// 2026-10-08, clients repo: the timer's catch-up of unheld lane b (`git merge --no-edit
// main`, 9af9566 -> bd80f07) was killed after writing 16 of 31 incoming files and before
// the index (a 0-byte index.lock left behind, HEAD and index still on the old commit). Two
// minutes later the dispatcher saw a dirty lane and opened a "Finish preserved work" chat,
// although every dirty file was byte for byte trunk's and HEAD was behind trunk: nothing to
// recover. Real work beside it (lane f: own commits, some files unlike trunk) must still be
// dispatched - the negative cases below keep that.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'pf-torn-'))
let failures = 0
const check = (name, pass, detail = '') => { console.log(`${pass ? 'ok' : 'FAIL'} ${name}`); if (!pass) { failures++; console.log(detail) } }
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()

// Trunk moves on after the lane was made: one file changed, four added (two in a folder).
const TRUNK = {
  'source.txt': 'trunk edit\n',
  'added-1.txt': 'one\n',
  'added-2.txt': 'two\n',
  'deep/added-3.txt': 'three\n',
  'deep/added-4.txt': 'four\n'
}

// `unheld` = the dispatcher alone: the holder lets go while the lane is still clean (its copy
// then stays where it is), and only afterwards does trunk move on and the update tear. Without
// it the release comes after the tear, and the release's own catch-up of every idle lane is the
// first to meet it (catchUp).
function fixture(name, { unheld = false } = {}) {
  const repo = join(root, name)
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  installLane(here, repo)
  copyFileSync(join(here, 'lane-hook.mjs'), join(repo, 'scripts', 'lane-hook.mjs'))
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, version: '0.0.1' }))
  writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ release: 'merge', pool: ['main', 'a', 'b'] }))
  writeFileSync(join(repo, 'source.txt'), 'base\n')
  writeFileSync(join(repo, 'kept.txt'), 'kept\n')
  git(repo, 'init', '-q', '-b', 'master'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.com')
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base'); git(repo, 'tag', 'v0.0.1')
  const remote = join(root, `${name}-origin.git`)
  git(root, 'init', '--bare', '-q', remote); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-qu', 'origin', 'master', '--tags')
  const beatDir = join(repo, '.git', 'paneforge-panes')
  mkdirSync(beatDir)
  writeFileSync(join(beatDir, `pf-${process.pid}.json`), JSON.stringify({ at: Date.now(), chats: [] }))
  const panes = join(repo, '.git', 'panes.txt'); writeFileSync(panes, '')
  // `release` starts the folder sweep, which removes a lane copy once it is all in trunk (the
  // point of finishing it), racing the reads below. This process holds the sweep's lock.
  writeFileSync(join(repo, '.git', 'paneforge-sweep.lock'), `${process.pid} ${Date.now()}\n`)
  const log = join(repo, '.git', 'completion.jsonl')
  const processes = join(repo, '.git', 'processes.json'); writeFileSync(processes, '[]')
  const env = { ...process.env, LANE_PROCESSES_FILE: processes, PF_PANE: '', PF_CTL_NO_APP: '1', LANE_PANES_FILE: panes, LANE_COMPLETION_LOG: log, LANE_REGISTRY: join(repo, '.git', 'registry.json'), CLAUDE_CONFIG_DIR: join(root, 'claude') }
  const cli = join(repo, 'scripts', 'lane.mjs')
  const run = (...args) => {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd: repo, env, encoding: 'utf8', timeout: 90_000 })
    return { code: r.status, out: r.stdout, err: r.stderr }
  }
  const dir = JSON.parse(run('claim', '--prefer', 'a', '--session', 'original').out).dir
  const old = git(dir, 'rev-parse', 'HEAD')
  const release = () => run('release', '--session', 'original', '--gone')
  if (unheld && release().code !== 0) throw new Error('release failed')
  for (const [p, body] of Object.entries(TRUNK)) { mkdirSync(dirname(join(repo, p)), { recursive: true }); writeFileSync(join(repo, p), body) }
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'trunk moves on')
  const trunk = git(repo, 'rev-parse', 'master')
  const lock = join(git(dir, 'rev-parse', '--path-format=absolute', '--git-dir'), 'index.lock')
  const requests = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).key) : []
  // What a merge killed after writing some files leaves: those files, and git's lock.
  const tear = (paths, { lockAgeMs = 10 * 60_000 } = {}) => {
    for (const p of paths) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), TRUNK[p]) }
    writeFileSync(lock, '')
    const t = (Date.now() - lockAgeMs) / 1000
    utimesSync(lock, t, t)
  }
  const atTrunk = () => git(dir, 'rev-parse', 'HEAD') === trunk && git(dir, 'status', '--porcelain', '--untracked-files=all') === '' && !existsSync(lock)
  return { repo, dir, old, trunk, lock, run, release, requests, tear, atTrunk }
}

// 1. The 2026-10-08 shape, met by the dispatcher: an unheld lane, 3 of 5 incoming files
// written (one changed, two new, one in a new folder), a stale 0-byte index.lock.
{
  const f = fixture('torn', { unheld: true })
  f.tear(['source.txt', 'added-1.txt', 'deep/added-3.txt'])
  const r = f.run('retry')
  check('dispatcher: no recovery chat is dispatched for a torn catch-up', f.requests().length === 0, JSON.stringify(f.requests()) + r.err)
  check('dispatcher: the lane ends clean at trunk, its stale lock gone', f.atTrunk(), git(f.dir, 'log', '--oneline', '-3') + git(f.dir, 'status', '--porcelain'))
  check('dispatcher: every trunk file is in place', Object.entries(TRUNK).every(([p, b]) => existsSync(join(f.dir, p)) && readFileSync(join(f.dir, p), 'utf8') === b))
  check('dispatcher: says what it did', /finished catching up with master/.test(r.out), r.out)
}

// 2. Same shape while the lock is young: a live git may still be writing. Neither finished
// nor dispatched; once the lock is old the next tick finishes it.
{
  const f = fixture('fresh', { unheld: true })
  f.tear(['source.txt', 'added-2.txt'], { lockAgeMs: 60_000 })
  f.run('retry')
  check('fresh lock: no recovery chat is dispatched', f.requests().length === 0, JSON.stringify(f.requests()))
  check('fresh lock: the lane is left exactly as it was', git(f.dir, 'rev-parse', 'HEAD') === f.old && existsSync(f.lock) && readFileSync(join(f.dir, 'added-2.txt'), 'utf8') === TRUNK['added-2.txt'])
  const t = (Date.now() - 10 * 60_000) / 1000
  utimesSync(f.lock, t, t)
  f.run('retry')
  check('fresh lock: once abandoned, the next tick finishes it', f.requests().length === 0 && f.atTrunk())
}

// 3. The next unattended catch-up (catchUp, here the release's catch-up of idle lanes)
// finishes a torn one instead of calling the lane dirty.
{
  const f = fixture('catchup')
  f.tear(['source.txt', 'deep/added-4.txt'])
  check('catchUp: release of the gone holder succeeds', f.release().code === 0)
  check('catchUp: the lane ends clean at trunk', f.atTrunk(), git(f.dir, 'status', '--porcelain'))
  f.run('retry')
  check('catchUp: nothing is dispatched afterwards', f.requests().length === 0, JSON.stringify(f.requests()))
}

// 4. One dirty file differs from trunk (clients lane f's shape): real work, still dispatched,
// untouched by either path.
for (const unheld of [true, false]) {
  const f = fixture(`differs-${unheld}`, { unheld })
  f.tear(['source.txt', 'added-1.txt'])
  writeFileSync(join(f.dir, 'added-1.txt'), 'somebody edited this\n')
  if (!unheld) f.release()
  f.run('retry')
  const via = unheld ? 'dispatcher' : 'catchUp'
  check(`differs (${via}): a recovery chat is dispatched`, f.requests().length === 1, JSON.stringify(f.requests()))
  check(`differs (${via}): HEAD, bytes and lock are preserved`, git(f.dir, 'rev-parse', 'HEAD') === f.old && existsSync(f.lock) && readFileSync(join(f.dir, 'added-1.txt'), 'utf8') === 'somebody edited this\n' && readFileSync(join(f.dir, 'source.txt'), 'utf8') === TRUNK['source.txt'])
}

// 5. A deletion beside trunk-identical files is never taken as a torn catch-up.
{
  const f = fixture('deleted', { unheld: true })
  f.tear(['source.txt'])
  unlinkSync(join(f.dir, 'kept.txt'))
  f.run('retry')
  check('deletion: a recovery chat is dispatched', f.requests().length === 1, JSON.stringify(f.requests()))
  check('deletion: HEAD is unchanged', git(f.dir, 'rev-parse', 'HEAD') === f.old)
}

// 6. A lane with its own commit is not behind trunk: still dispatched, even when its dirt is trunk's.
{
  const f = fixture('owncommit')
  writeFileSync(join(f.dir, 'mine.txt'), 'my work\n'); git(f.dir, 'add', 'mine.txt'); git(f.dir, 'commit', '-qm', 'my work')
  const mine = git(f.dir, 'rev-parse', 'HEAD')
  f.tear(['added-1.txt'])
  f.release()
  f.run('retry')
  check('own commit: a recovery chat is dispatched', f.requests().length === 1, JSON.stringify(f.requests()))
  check('own commit: HEAD is unchanged', git(f.dir, 'rev-parse', 'HEAD') === mine)
}

rmSync(root, { recursive: true, force: true })
if (failures) { console.log(`${failures} failed`); process.exit(1) }
console.log('all passed')
