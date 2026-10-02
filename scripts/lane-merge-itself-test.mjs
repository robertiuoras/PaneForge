// Work from parallel chats merges itself: no rescue chats.
//
// Robert's ask (wr-04): two chats that touch the same repo should not need a third chat to
// put their work together. Pinned here, with real git repos, a real bare origin and the
// real lane.mjs (`release: "merge"`, taskdriver.ai's setting):
//
//   (a) two lanes edit different functions of the SAME file, both `ready`: both changes
//       land on master and origin, no conflict recorded, no card, no pane
//   (b) master adds migration 12-a while a lane adds its own 12-b: the lane's file becomes
//       13-b at `ready`, the merge is clean, and after the release master has 12-a and 13-b;
//       a lane already finished when master took the number is renumbered by the release
//   (c) a real clash on the same lines with its chat gone quiet: exactly one card across
//       many ticks, zero panes
//   (d) master's newer work merges cleanly into a lane but the two no longer typecheck
//       together: `ready` says so and does not mark the lane done
//
// `LANE_DISPATCH_LOG` stands in for GuardDeck's notifier (and would show any pane request).
//
//   node scripts/lane-merge-itself-test.mjs

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'paneforge-merge-itself-test-'))
process.on('exit', (code) => {
  if (!code) rmSync(root, { recursive: true, force: true })
})

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

const origin = join(root, 'origin.git')
const repo = join(root, 'demo')
git(root, 'init', '-q', '--bare', '-b', 'master', origin)
mkdirSync(join(repo, 'scripts'), { recursive: true })
mkdirSync(join(repo, 'src'), { recursive: true })
mkdirSync(join(repo, 'supabase', 'migrations'), { recursive: true })
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1' }, null, 2) + '\n')
writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ release: 'merge' }, null, 2) + '\n')
const twoFns =
  'export function one() {\n  return "one"\n}\n\n// ----\n// spacer\n// spacer\n// spacer\n// ----\n\n' +
  'export function two() {\n  return "two"\n}\n'
writeFileSync(join(repo, 'src', 'two.ts'), twoFns)
writeFileSync(join(repo, 'src', 'page.ts'), 'export function page() {\n  return "base"\n}\n')
writeFileSync(join(repo, 'supabase', 'migrations', 'supabase-migration-11-base.sql'), 'select 11;\n')
installLane(here, repo)
git(repo, 'init', '-q', '-b', 'master')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'first')
git(repo, 'remote', 'add', 'origin', origin)
git(repo, 'push', '-q', '-u', 'origin', 'master')

const dispatchLog = join(root, 'dispatch.jsonl')
const lane = (args, extraEnv = {}) => {
  const env = { ...process.env, LANE_DISPATCH_LOG: dispatchLog, ...extraEnv }
  try {
    return { code: 0, out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], { cwd: repo, encoding: 'utf8', stdio: 'pipe', env }).trim() }
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? '').trim(), err: String(e.stderr ?? '').trim() }
  }
}
const statePath = join(repo, '.git', 'paneforge-lanes.json')
const state = () => JSON.parse(readFileSync(statePath, 'utf8'))
const patchState = (fn) => {
  const s = state()
  fn(s)
  writeFileSync(statePath, JSON.stringify(s, null, 2) + '\n', 'utf8')
}
const requests = () => (existsSync(dispatchLog) ? readFileSync(dispatchLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const panes = () => requests().filter((x) => !x.card || 'prompt' in x)
const commit = (dir, file, text, msg) => {
  writeFileSync(join(dir, file), text)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', msg)
}
// The release cooldown is not what is under test: every ready/retry below may ship.
const noCooldown = () => { if (existsSync(statePath)) patchState((s) => { s.lastShip = { version: null, at: 0, lanes: [] } }) }
const onOrigin = (path) => {
  try {
    return git(repo, 'show', `origin/master:${path}`)
  } catch {
    return null
  }
}
const shipNow = () => {
  noCooldown()
  lane(['retry'])
  git(repo, 'fetch', '-q', 'origin')
}

lane(['claim', '--session', 'sess-main'])

// ---------------------------------------------------- (a) same file, different functions

const a = JSON.parse(lane(['claim', '--session', 'sess-a']).out)
const b = JSON.parse(lane(['claim', '--session', 'sess-b']).out)
ok('(a) two chats get two lanes', a.lane !== b.lane && a.lane !== 'main' && b.lane !== 'main', `${a.lane} ${b.lane}`)
commit(a.dir, 'src/two.ts', twoFns.replace('return "one"', 'return "one, from chat a"'), 'feat: one from a')
commit(b.dir, 'src/two.ts', twoFns.replace('return "two"', 'return "two, from chat b"'), 'feat: two from b')
noCooldown()
const ra = lane(['ready', '--session', 'sess-a'])
ok('(a) the first chat finishes', ra.code === 0, ra.err)
noCooldown()
const rb = lane(['ready', '--session', 'sess-b'])
ok('(a) the second chat finishes', rb.code === 0, rb.err)
shipNow()
const merged = onOrigin('src/two.ts') ?? ''
ok('(a) both changes are on origin', /one, from chat a/.test(merged) && /two, from chat b/.test(merged), merged)
ok('(a) and on master', git(repo, 'rev-parse', 'master') === git(repo, 'rev-parse', 'origin/master'))
ok('(a) no conflict recorded', Object.keys(state().conflicts).length === 0, JSON.stringify(state().conflicts))
ok('(a) no card and no pane', requests().length === 0, JSON.stringify(requests()))
lane(['release', '--session', 'sess-a'])
lane(['release', '--session', 'sess-b'])

// ---------------------------------------------------- (b) two migrations, one number

const m = JSON.parse(lane(['claim', '--session', 'sess-m']).out)
commit(repo, 'supabase/migrations/supabase-migration-12-a.sql', 'select 12;\n', 'feat: migration 12 on master')
git(repo, 'push', '-q', 'origin', 'master')
commit(m.dir, 'supabase/migrations/supabase-migration-12-b.sql', 'select 12 from the lane;\n', 'feat: migration 12 in the lane')
noCooldown()
const rm = lane(['ready', '--session', 'sess-m'])
ok('(b) ready takes master in and finishes', rm.code === 0, rm.err)
ok('(b) and says which file it renumbered', /supabase-migration-12-b\.sql -> supabase\/migrations\/supabase-migration-13-b\.sql/.test(rm.out), rm.out)
const laneFiles = git(m.dir, 'ls-files', 'supabase/migrations').split('\n')
ok('(b) the lane\'s file is now 13-b', laneFiles.includes('supabase/migrations/supabase-migration-13-b.sql') && !laneFiles.includes('supabase/migrations/supabase-migration-12-b.sql'), laneFiles.join(' '))
ok('(b) the rename rides the merge commit itself', git(m.dir, 'rev-list', '--parents', '-n1', 'HEAD').split(' ').length === 3 && git(m.dir, 'status', '--porcelain') === '')
shipNow()
const shipped = (onOrigin('supabase/migrations') ?? '').split('\n')
ok('(b) after the release master has 12-a and 13-b', shipped.includes('supabase-migration-12-a.sql') && shipped.includes('supabase-migration-13-b.sql') && !shipped.includes('supabase-migration-12-b.sql'), shipped.join(' '))
ok('(b) no conflict, no card, no pane', Object.keys(state().conflicts).length === 0 && requests().length === 0, JSON.stringify({ c: state().conflicts, r: requests() }))
lane(['release', '--session', 'sess-m'])

// The release side of the same clash: the lane was finished before master took the number.
const e = JSON.parse(lane(['claim', '--session', 'sess-e']).out)
commit(e.dir, 'supabase/migrations/supabase-migration-14-e.sql', 'select 14 from the lane;\n', 'feat: migration 14 in the lane')
// Another chat mid-release holds this one back, so the lane only waits at `ready`.
patchState((s) => { s.release = { session: 'sess-other', at: Date.now(), pid: process.pid } })
const re = lane(['ready', '--session', 'sess-e'])
ok('(b) a lane finished while master was level is marked done', re.code === 0 && Boolean(state().ready[e.lane]), re.err)
commit(repo, 'supabase/migrations/supabase-migration-14-main.sql', 'select 14;\n', 'feat: migration 14 on master')
patchState((s) => { s.release = null })
shipNow()
const atRelease = (onOrigin('supabase/migrations') ?? '').split('\n')
ok('(b) the release renumbers the lane\'s file on its way into master', atRelease.includes('supabase-migration-14-main.sql') && atRelease.includes('supabase-migration-15-e.sql') && !atRelease.includes('supabase-migration-14-e.sql'), atRelease.join(' '))
lane(['release', '--session', 'sess-e'])

// ---------------------------------------------------- (c) a real clash, chat gone quiet

const c = JSON.parse(lane(['claim', '--session', 'sess-c']).out)
commit(c.dir, 'src/page.ts', 'export function page() {\n  return "from the lane"\n}\n', 'feat: page in the lane')
commit(repo, 'src/page.ts', 'export function page() {\n  return "from master"\n}\n', 'feat: page on master')
noCooldown()
const rc = lane(['ready', '--session', 'sess-c'])
ok('(c) the clash is refused at ready, for its own chat', rc.code !== 0 && /page\.ts/.test(rc.err ?? ''), rc.err)
patchState((s) => { s.lanes[c.lane].seen = Date.now() - 46 * 60 * 1000 })
for (let i = 0; i < 4; i++) lane(['retry'])
const cards = requests().filter((x) => x.card && x.lane === c.lane)
ok('(c) exactly one card across four ticks', cards.length === 1, JSON.stringify(requests()))
ok('(c) zero panes', panes().length === 0, JSON.stringify(panes()))
ok('(c) the card names the file', /src\/page\.ts/.test(cards[0]?.detail ?? ''), cards[0]?.detail)
// Settled by hand, so (d) starts from a clean pool.
git(c.dir, 'merge', '--abort')
lane(['release', '--session', 'sess-c'])
patchState((s) => { delete s.conflicts[c.lane]; delete s.ready[c.lane] })
git(c.dir, 'reset', '-q', '--hard', 'master')

// ---------------------------------------------------- (d) clean merge, no longer compiles

// A typecheck that speaks tsc's error shape: every call to f() must pass as many arguments
// as src/api.ts declares.
writeFileSync(join(repo, 'check.mjs'), [
  "import { readFileSync, readdirSync } from 'node:fs'",
  "const arity = (/function f\\(([^)]*)\\)/.exec(readFileSync('src/api.ts', 'utf8'))[1].split(',').filter(Boolean)).length",
  "let bad = 0",
  "for (const f of readdirSync('src').filter((n) => n !== 'api.ts')) for (const m of readFileSync('src/' + f, 'utf8').matchAll(/\\bf\\(([^)]*)\\)/g)) {",
  "  const n = m[1].split(',').filter((x) => x.trim()).length",
  "  if (n !== arity) { console.log(`src/${f}(1,1): error TS2554: Expected ${arity} arguments, but got ${n}.`); bad++ }",
  "}",
  "process.exit(bad ? 1 : 0)",
  ''
].join('\n'))
writeFileSync(join(repo, 'src', 'api.ts'), 'export function f(a) {\n  return a\n}\n')
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
pkg.scripts = { typecheck: 'node check.mjs' }
writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'chore: typecheck')
const d = JSON.parse(lane(['claim', '--session', 'sess-d']).out)
commit(d.dir, 'src/use.ts', "import { f } from './api'\nexport const u = f(1)\n", 'feat: use f')
commit(repo, 'src/api.ts', 'export function f(a, b) {\n  return a + b\n}\n', 'feat: f takes two')
noCooldown()
const rd = lane(['ready', '--session', 'sess-d'])
ok('(d) ready refuses a lane that no longer typechecks with master', rd.code !== 0 && /took in master's latest work and no longer typechecks/.test(rd.err ?? ''), rd.err)
ok('(d) quoting the error TS line', /error TS2554/.test(rd.err ?? ''), rd.err)
ok('(d) and the lane is not marked done', !state().ready[d.lane], JSON.stringify(state().ready))

console.log(failed ? `\n${failed} failed, ${passed} passed` : `\nall ${passed} passed`)
process.exit(failed ? 1 : 0)
