// The master typecheck on the Mac runs on the PC through rbuild, one job per tree. A try
// that runs out of time must leave the job for the next try (same id, no new submit); a
// cancelled job is dropped so the next try sends a new one; a real verdict is cached.
// The rbuild here is a stub under a fake HOME: no PC, no network.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

if (process.platform !== 'darwin') {
  console.log('Remote typecheck job fixture requires macOS')
  process.exit(0)
}

const scripts = resolve(import.meta.dirname)
const root = mkdtempSync(join(tmpdir(), 'pf-typecheck-job-'))
const home = join(root, 'home')
const childTmp = join(root, 'tmp')
const projects = join(root, 'Projects')
const engineDir = join(projects, 'PaneForge', 'scripts')
const macRan = join(root, 'mac-ran')
const callsFile = join(root, 'calls.jsonl')
const modeFile = join(root, 'mode')
let failures = 0

function ok(name, pass, detail = '') {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${pass || !detail ? '' : ` - ${detail}`}`)
  if (!pass) failures++
}
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
function lane(repo, ...args) {
  const r = spawnSync(process.execPath, [join(engineDir, 'lane.mjs'), ...args, '--repo', repo], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, HOME: home, TMPDIR: childTmp }
  })
  return { code: r.status ?? 1, out: r.stdout.trim(), err: r.stderr.trim() }
}
const said = (r) => `${r.out}\n${r.err}`
function mode(m) { writeFileSync(modeFile, m) }
function calls() {
  try { return readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) }
  catch { return [] }
}
const submits = () => calls().filter((a) => a.includes('--no-wait'))
const waits = () => calls().filter((a) => a[0] === '--wait')
function contains(dir, sha, ref) {
  return spawnSync('git', ['merge-base', '--is-ancestor', sha, ref], { cwd: dir }).status === 0
}
function project(name) {
  const dir = join(projects, name, 'app')
  const remote = join(projects, name, 'origin.git')
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '--bare', '-q', remote])
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'test')
  writeFileSync(join(dir, '.lanes.json'), '{"release":"merge"}\n')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: {
    typecheck: `node -e "require('fs').writeFileSync('${macRan}', 'typecheck')"`,
    test: 'node -e "process.exit(0)"'
  } }))
  writeFileSync(join(dir, 'base.txt'), 'base\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  git(dir, 'remote', 'add', 'origin', remote)
  git(dir, 'push', '-q', '-u', 'origin', 'main')
  lane(dir, 'claim', '--session', 'hold-main', '--cwd', dir)
  return { dir, remote }
}
function work(repo, session, file) {
  const claimed = JSON.parse(lane(repo, 'claim', '--session', session, '--cwd', repo).out)
  writeFileSync(join(claimed.dir, file), `${file}\n`)
  git(claimed.dir, 'add', '-A')
  git(claimed.dir, 'commit', '-qm', `feat: ${file}`)
  return claimed
}

try {
  mkdirSync(engineDir, { recursive: true })
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(childTmp, { recursive: true })
  const original = readFileSync(join(scripts, 'lane.mjs'), 'utf8')
  const relocated = original.replace(/from '(\.\/[^']+)'/g, (_, p) =>
    `from '${pathToFileURL(resolve(scripts, p)).href}'`)
  writeFileSync(join(engineDir, 'lane.mjs'), relocated)
  writeFileSync(join(home, '.claude', 'rbuild.mjs'), `import { appendFileSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n')
const mode = readFileSync(${JSON.stringify(modeFile)}, 'utf8').trim()
if (args.includes('--no-wait')) {
  console.error('rbuild: job ' + randomUUID() + ' saved. queued behind 25')
  process.exit(75)
}
if (mode === 'queued') process.exit(75)
if (mode === 'pass') process.exit(0)
if (mode === 'ts') { console.log('src/x.ts(1,1): error TS2322: nope'); process.exit(2) }
console.log('rbuild: cancelled')
process.exit(1)
`)

  // a + b + c: one job per tree while the PC queue is long, then the verdict lands the lane.
  mode('queued')
  const q = project('queued')
  const a = work(q.dir, 'chat-a', 'feature.txt')
  const aTip = git(a.dir, 'rev-parse', 'HEAD')
  const first = lane(q.dir, 'ready', '--session', 'chat-a')
  ok('a: queued job is reported as waiting its turn', /still waiting its turn/.test(said(first)), said(first))
  ok('a: exactly one submit and one wait', submits().length === 1 && waits().length === 1,
    JSON.stringify(calls()))
  ok('a: nothing pushed while it waits', !contains(q.remote, aTip, 'main'))
  ok('a: typecheck did not run on the Mac', !existsSync(macRan))
  const jobId = submits().length ? waits()[0]?.[1] : undefined
  const sub0 = submits().length
  const wait0 = waits().length

  const again = lane(q.dir, 'autoship', '--session', 'chat-a')
  ok('b: second try submits no new job', submits().length === sub0, JSON.stringify(calls()))
  ok('b: second try waits once more', waits().length === wait0 + 1, JSON.stringify(calls()))
  ok('b: second try waits on the first job id', Boolean(jobId) && waits()[wait0]?.[1] === jobId,
    `${jobId} vs ${waits()[wait0]?.[1]}\n${said(again)}`)

  mode('pass')
  const wait1 = waits().length
  const third = lane(q.dir, 'autoship', '--session', 'chat-a')
  ok('c: first wait after the PC passes uses the same job id', waits()[wait1]?.[1] === jobId,
    `${jobId} vs ${waits()[wait1]?.[1]}`)
  ok('c: lane lands on origin main once the PC passes', contains(q.remote, aTip, 'main'), said(third))

  // d: a cancelled job is dropped, the next try sends a new one.
  mode('cancelled')
  const c = project('cancelled')
  work(c.dir, 'chat-c', 'c.txt')
  const dSub0 = submits().length
  const cancelled = lane(c.dir, 'ready', '--session', 'chat-c')
  ok('d: cancelled job is reported as could not run', /could not run on the PC/.test(said(cancelled)), said(cancelled))
  ok('d: first try submitted one job', submits().length === dSub0 + 1)
  mode('queued')
  lane(c.dir, 'ready', '--session', 'chat-c')
  ok('d: next try submits a new job (record dropped)', submits().length === dSub0 + 2, JSON.stringify(calls()))

  // e: a real compile error is cached for the same tree.
  mode('ts')
  const t = project('tserror')
  work(t.dir, 'chat-t', 't.txt')
  const bad = lane(t.dir, 'ready', '--session', 'chat-t')
  ok('e: compile error is quoted', /error TS2322/.test(said(bad)), said(bad))
  const before = calls().length
  const bad2 = lane(t.dir, 'ready', '--session', 'chat-t')
  ok('e: same tree again makes no rbuild call', calls().length === before, JSON.stringify(calls().slice(before)))
  ok('e: cached verdict is still quoted', /error TS2322/.test(said(bad2)), said(bad2))
} finally {
  rmSync(root, { recursive: true, force: true })
}
if (failures) process.exit(1)
