// A chat is told, on its first edit, that another lane already changed the same file.
//
// The bug this exists for, 2026-09-02: lane c (offload-first) and lane d (task brief) both
// inserted into `laneFor` in src/main/index.ts the same afternoon. Neither chat knew. d
// shipped first, c sat conflicted on master, and a pane spent its turn resolving a merge
// that one sentence at the first edit would have avoided. The peer-announce rule in
// CLAUDE.md said to message the other chat; nothing enforced it, so nothing happened.
//
// `lane.mjs guard` now exits 0 WITH TEXT when the file being edited has hunks in another
// lane's working tree that master does not carry; the hook folds it into the edit's
// context. Exit 2 (refuse) is untouched. Checked here:
//   1. a committed, unmerged change in another lane names that lane and its line range
//   2. an uncommitted edit in another lane counts too (working tree, not HEAD), and a lane
//      nobody holds is said to be empty
//   3. a file nobody else changed says nothing
//   4. the same session is told once per file, not on every edit
//   5. work master already carries is not an overlap
//   6. the main checkout's dirty edit is reported to a lane, named as the main checkout
//
//   node scripts/lane-overlap-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// realpath: tmpdir() is a symlink on macOS and the engine answers in resolved paths
const root = join(realpathSync(tmpdir()), 'paneforge-lane-overlap-test')
if (!process.env.KEEP) rmSync(root, { recursive: true, force: true })
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
const lines = (n, tag) => Array.from({ length: n }, (_, i) => `line ${i + 1} ${tag}`).join('\n') + '\n'
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1' }, null, 2) + '\n')
writeFileSync(join(repo, 'big.js'), lines(200, 'original'))
writeFileSync(join(repo, 'app.js'), 'console.log(1)\n')
writeFileSync(join(repo, 'quiet.js'), 'export const quiet = true\n')
writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ pool: ['main', 'a', 'b'] }, null, 2) + '\n')
installLane(here, repo)
git(repo, 'init', '-q', '-b', 'master')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'first')
git(repo, 'tag', 'v0.0.1')

const laneDir = (id) => (id === 'main' ? repo : `${repo}-${id}`)

const lane = (...args) => {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], {
        cwd: repo,
        encoding: 'utf8',
        stdio: 'pipe'
      }).trim()
    }
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '').toString().trim(), err: (e.stderr ?? '').toString().trim() }
  }
}
const claim = (session, cwd, prefer) => {
  const r = lane('claim', '--session', session, '--cwd', cwd, ...(prefer ? ['--prefer', prefer] : []))
  try {
    return JSON.parse(r.out)
  } catch {
    return { lane: null, err: r.out || r.err }
  }
}
const guard = (session, path) => lane('guard', '--session', session, '--path', path)

// ---------------------------------------------------------------- the real sequence

const s0 = claim('s0', repo)
ok('the repo chat holds main', s0.lane === 'main', JSON.stringify(s0))
const s1 = claim('s1', join(root, 'elsewhere'))
ok('a visiting chat gets lane a', s1.lane === 'a', JSON.stringify(s1))
const a = laneDir('a')

// 1. lane a rewrites lines 100-105 of big.js and commits. Nothing merged yet.
const edited = readFileSync(join(a, 'big.js'), 'utf8').split('\n')
for (let i = 99; i < 105; i++) edited[i] = `line ${i + 1} changed in lane a`
writeFileSync(join(a, 'big.js'), edited.join('\n'))
git(a, 'commit', '-qam', 'feat: lane a changes the middle of big.js')

const g1 = guard('s0', join(repo, 'big.js'))
ok('an allowed edit still exits 0', g1.code === 0, `code=${g1.code} ${g1.err}`)
ok('and names the other lane', /lane a/.test(g1.out), g1.out)
ok('with its line range', /lines 100-105/.test(g1.out), g1.out)
ok('and that another chat is in it', /another chat is in it/.test(g1.out), g1.out)

// 3. a file nobody else touched says nothing
const g3 = guard('s0', join(repo, 'quiet.js'))
ok('a file nobody else changed says nothing', g3.code === 0 && g3.out === '', g3.out)

// 4. the same session is told once per file
const g4 = guard('s0', join(repo, 'big.js'))
ok('the same session is not told twice about one file', g4.code === 0 && g4.out === '', g4.out)

// 2. an uncommitted edit in lane a counts, and a lane nobody holds says so
lane('release', '--session', 's1')
writeFileSync(join(a, 'app.js'), 'console.log(2)\n')
const g2 = guard('s0', join(repo, 'app.js'))
ok('an uncommitted edit in another lane counts', /lane a/.test(g2.out) && /lines 1\b/.test(g2.out), g2.out)
ok('and a lane nobody holds says so', /nobody in it, work not yet merged/.test(g2.out), g2.out)

// 6. the main checkout's dirty edit is reported to the lane, as the main checkout
writeFileSync(join(repo, 'quiet.js'), 'export const quiet = false\n')
const g6 = guard('s1', join(a, 'quiet.js'))
ok('a dirty main checkout is reported to a lane', /the main checkout/.test(g6.out) && /lines 1\b/.test(g6.out), g6.out)

// 5. once master carries lane a's commit, big.js is no overlap for a fresh session
git(repo, 'checkout', '-q', '--', 'quiet.js')
git(repo, 'merge', '-q', '--no-edit', 'lane-a')
const s2 = claim('s2', join(root, 'elsewhere2'))
ok('a third chat gets lane b', s2.lane === 'b', JSON.stringify(s2))
const g5 = guard('s2', join(laneDir('b'), 'big.js'))
ok('work master already carries is not an overlap', g5.code === 0 && g5.out === '', g5.out)

// the refusal path is untouched: s2 editing lane a (held again by s1) is still refused
claim('s1', join(root, 'elsewhere'), 'a')
const g7 = guard('s2', join(a, 'big.js'))
ok('a refusal is still exit 2 with a reason', g7.code === 2 && /belongs to another chat/.test(g7.out), `${g7.code} ${g7.out}`)

if (!process.env.KEEP) rmSync(root, { recursive: true, force: true })
if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall ok')
