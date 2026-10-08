// The master typecheck and test suite on the Mac run on the PC through rbuild, one job per
// tree. A try that runs out of time must leave the job for the next try (same id, no new
// submit); a cancelled job is dropped so the next try sends a new one; a real verdict is
// cached. A red suite is confirmed once, and the confirming job is reused the same way.
// The rbuild here is a stub under a fake HOME: no PC, no network.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
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
const macSuiteRan = join(root, 'mac-suite-ran')
const callsFile = join(root, 'calls.jsonl')
const jobsFile = join(root, 'jobs.jsonl')
const modeFile = join(root, 'mode')
// Suite jobs answer from this file when it exists; comma-separated steps are used one per wait.
const suiteModeFile = join(root, 'mode-suite')
// While this file exists a wait on a job still in line takes 10 ms per second of its budget:
// the 900 s wait a clock tick held the recovery lock through is 9 s here.
const slowFile = join(root, 'slow')
// A suite job whose repo is named here answers with that one step every time, ahead of mode-suite:
// two lanes' jobs at once, one still in line and one finished.
const repoModesFile = join(root, 'mode-repos.json')
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
function mode(m) {
  writeFileSync(modeFile, m)
  try { unlinkSync(suiteModeFile) } catch {}
}
function suiteMode(m) { writeFileSync(suiteModeFile, m) }
function calls() {
  try { return readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) }
  catch { return [] }
}
const submits = () => calls().filter((a) => a.includes('--no-wait'))
const waits = () => calls().filter((a) => a[0] === '--wait')
const real = (p) => { try { return realpathSync(p) } catch { return p } }
const repoOf = (a) => real(a[a.indexOf('--repo') + 1])
const suiteSubmits = (dir) => submits().filter((a) => a.includes('--') && (!dir || repoOf(a) === real(dir)))
const suiteIds = () => {
  try { return readFileSync(jobsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((j) => j.kind === 'suite').map((j) => j.id) }
  catch { return [] }
}
const suiteWaits = () => waits().filter((a) => suiteIds().includes(a[1]))
function ledger(dir) { return JSON.parse(readFileSync(join(dir, '.git', 'paneforge-lanes.json'), 'utf8')) }
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
    test: `node -e "require('fs').writeFileSync('${macSuiteRan}', 'suite')"`
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
  // LANE_ENGINE=<file> runs these against another engine (an older commit's, to see it red).
  const original = readFileSync(process.env.LANE_ENGINE ?? join(scripts, 'lane.mjs'), 'utf8')
  const relocated = original.replace(/from '(\.\/[^']+)'/g, (_, p) =>
    `from '${pathToFileURL(resolve(scripts, p)).href}'`)
  writeFileSync(join(engineDir, 'lane.mjs'), relocated)
  writeFileSync(join(home, '.claude', 'rbuild.mjs'), `import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n')
if (args.includes('--no-wait') && args.includes('--') && existsSync(${JSON.stringify(join(home, '.claude', 'rbuild-unsent'))})) {
  console.error('ssh: connect to host pc port 22: Operation timed out')
  process.exit(255)
}
if (args.includes('--no-wait')) {
  const id = randomUUID()
  const repo = args.includes('--repo') ? realpathSync(args[args.indexOf('--repo') + 1]) : null
  // What the real rbuild would upload from that folder, read at submit time: base.txt's bytes
  // and whether an untracked stray.txt is there.
  const shipped = repo && existsSync(repo + '/base.txt') ? readFileSync(repo + '/base.txt', 'utf8') : null
  const stray = Boolean(repo) && existsSync(repo + '/stray.txt')
  appendFileSync(${JSON.stringify(jobsFile)}, JSON.stringify({ id, repo, kind: args.includes('--') ? 'suite' : 'typecheck', shipped, stray }) + '\\n')
  console.error('rbuild: job ' + id + ' saved. queued behind 25')
  process.exit(75)
}
const job = readFileSync(${JSON.stringify(jobsFile)}, 'utf8').trim().split('\\n').map(JSON.parse).find((j) => j.id === args[1])
const file = job?.kind === 'suite' && existsSync(${JSON.stringify(suiteModeFile)}) ? ${JSON.stringify(suiteModeFile)} : ${JSON.stringify(modeFile)}
const fixed = job?.kind === 'suite' && job.repo && existsSync(${JSON.stringify(repoModesFile)})
  ? JSON.parse(readFileSync(${JSON.stringify(repoModesFile)}, 'utf8'))[job.repo] : undefined
const steps = fixed ? [fixed] : readFileSync(file, 'utf8').trim().split(',')
// --resume: the job's state now, never a wait - from the step the next wait would take, not using it up.
if (args[0] === '--resume') process.exit(['queued', 'killed'].includes(steps[0]) ? 75 : steps[0] === 'pass' ? 0 : 1)
if (!fixed && steps.length > 1) writeFileSync(file, steps.slice(1).join(','))
const mode = steps[0]
if (mode === 'queued' && existsSync(${JSON.stringify(slowFile)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(args[2]) * 10)
if (mode === 'queued') process.exit(75)
if (mode === 'pass') process.exit(0)
if (mode === 'ts') { console.log('src/x.ts(1,1): error TS2322: nope'); process.exit(2) }
if (mode === 'red') { console.log('ok   fine'); console.log('FAIL broken - it broke'); console.error('rbuild: failed - exit 1'); process.exit(1) }
if (mode === 'red2') { console.log('ok   fine'); console.log('FAIL other - it broke'); console.error('rbuild: failed - exit 1'); process.exit(1) }
if (/^(node|tick)-red2?$/.test(mode)) {
  console.log('ENOENT: an error injected by a regression test')
  const name = 'tests/' + (mode.endsWith('2') ? 'other' : 'broken') + '.test.mjs (123ms)'
  console.log((mode.startsWith('node') ? '✖ Context ' : '✗ ') + name)
  if (mode.startsWith('node')) { console.log('ℹ fail 1'); console.log('✖ failing tests:'); console.log('✖ Context ' + name) }
  console.error('rbuild: failed - exit 1'); process.exit(1)
}
if (mode === 'killed') process.kill(process.pid, 'SIGKILL')
if (mode === 'oom') { console.error('rbuild: failed while installing'); console.log('npm error network ETIMEDOUT'); console.error('rbuild: failed - exit 1'); process.exit(1) }
// GuardDeck's own words for a job stopped on the PC, as rbuild relayed them on 2026-10-08.
if (mode === 'stalled') { console.log('ok   fine'); console.error('rbuild: timed_out - timed_out after 11 min running, 0 min waiting, peak memory 8.1 of 8.0 GB; Stalled: no output and under 5% of one CPU for 10 min (a test or server left waiting?); stopped after 11 min instead of at its 30 min limit.'); process.exit(1) }
if (mode === 'linetimeout') { console.error('rbuild: timed_out - timed_out after 0 min running, 30 min waiting'); process.exit(1) }
console.error('rbuild: cancelled')
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

  // f + g + h: the suite goes to the PC the same way - one job per tree, a queued job is
  // waited on by the next try, never killed and cached as "did not finish".
  mode('pass')
  suiteMode('queued')
  const sq = project('suitequeued')
  const f = work(sq.dir, 'chat-f', 'f.txt')
  const fTip = git(f.dir, 'rev-parse', 'HEAD')
  const fFirst = lane(sq.dir, 'ready', '--session', 'chat-f')
  ok('f: queued suite is reported as waiting its turn', /test suite is still waiting its turn on the PC/.test(said(fFirst)), said(fFirst))
  const fJob = suiteIds().at(-1)
  ok('f: exactly one suite submit and one suite wait', suiteSubmits(sq.dir).length === 1 &&
    suiteWaits().filter((a) => a[1] === fJob).length === 1, JSON.stringify(calls().slice(-4)))
  ok('f: suite did not run on the Mac', !existsSync(macSuiteRan))
  ok('f: nothing pushed while it waits', !contains(sq.remote, fTip, 'main'))
  ok('f: a waiting suite is not cached as a verdict', ledger(sq.dir).pcSuite?.id && !('ok' in ledger(sq.dir).pcSuite),
    JSON.stringify(ledger(sq.dir).pcSuite))
  ok('f: no finished lane is tested while master is only waiting', suiteSubmits(f.dir).length === 0, JSON.stringify(suiteSubmits()))
  const fSub = suiteSubmits().length
  const fWait = suiteWaits().length
  lane(sq.dir, 'autoship', '--session', 'chat-f')
  ok('g: second try submits no new suite job', suiteSubmits().length === fSub, JSON.stringify(suiteSubmits()))
  ok('g: second try waits on the first suite job', suiteWaits().length === fWait + 1 && suiteWaits().at(-1)?.[1] === fJob,
    JSON.stringify(suiteWaits()))
  suiteMode('pass')
  const fLand = lane(sq.dir, 'autoship', '--session', 'chat-f')
  ok('h: lane lands once the PC suite passes', contains(sq.remote, fTip, 'main'), said(fLand))
  ok('h: still one suite job for that tree', suiteSubmits(sq.dir).length === 1, JSON.stringify(suiteSubmits(sq.dir)))
  ok('h: suite never ran on the Mac', !existsSync(macSuiteRan))

  // i + j: a red suite is confirmed once, cached on the tree, and the next try asks nothing.
  mode('pass')
  suiteMode('red')
  const sr = project('suitered')
  const i = work(sr.dir, 'chat-i', 'i.txt')
  const iTip = git(i.dir, 'rev-parse', 'HEAD')
  const iRed = lane(sr.dir, 'ready', '--session', 'chat-i')
  ok('i: red suite is quoted with its FAIL line', /fails its own test suite/.test(said(iRed)) && /FAIL broken/.test(said(iRed)), said(iRed))
  ok('i: master red is confirmed by exactly one more job', suiteSubmits(sr.dir).length === 2, JSON.stringify(suiteSubmits(sr.dir)))
  ok('i: red verdict cached on the tree', ledger(sr.dir).pcSuite?.ok === false && Boolean(ledger(sr.dir).pcSuite?.tree),
    JSON.stringify(ledger(sr.dir).pcSuite))
  ok('i: the finished lane was tested on the PC, not the Mac', suiteSubmits(i.dir).length >= 1 && !existsSync(macSuiteRan),
    JSON.stringify(suiteSubmits()))
  ok('i: nothing pushed', !contains(sr.remote, iTip, 'main'))
  const iMaster = suiteSubmits(sr.dir).length
  const iLane = suiteSubmits(i.dir).length
  const iWaits = suiteWaits().length
  const iAgain = lane(sr.dir, 'autoship', '--session', 'chat-i')
  ok('j: same trees again make no suite call', suiteSubmits(sr.dir).length === iMaster && suiteSubmits(i.dir).length === iLane &&
    suiteWaits().length === iWaits, JSON.stringify(calls().slice(-4)))
  ok('j: cached red is still quoted', /FAIL broken/.test(said(iAgain)), said(iAgain))

  // k: a flaky red is confirmed green, and the lane lands.
  suiteMode('red,pass')
  const sk = project('suiteflake')
  const k = work(sk.dir, 'chat-k', 'k.txt')
  const kTip = git(k.dir, 'rev-parse', 'HEAD')
  const kOut = lane(sk.dir, 'ready', '--session', 'chat-k')
  ok('k: flaky red, green confirm: lane lands', contains(sk.remote, kTip, 'main'), said(kOut))
  ok('k: two suite jobs, both on the PC', suiteSubmits(sk.dir).length === 2 && !existsSync(macSuiteRan), JSON.stringify(suiteSubmits(sk.dir)))

  // k2: two reds on DIFFERENT checks (lane d, 2026-10-02): every check passed in one of the
  // runs, so the lane is not held red; the record keeps both runs' FAIL lines.
  suiteMode('red,red2')
  const sk2 = project('suitediffred')
  const k2 = work(sk2.dir, 'chat-k2', 'k2.txt')
  const k2Tip = git(k2.dir, 'rev-parse', 'HEAD')
  const k2Out = lane(sk2.dir, 'ready', '--session', 'chat-k2')
  ok('k2: reds on different checks: lane lands', contains(sk2.remote, k2Tip, 'main'), said(k2Out))
  ok('k2: first job plus one confirm, nothing on the Mac', suiteSubmits(sk2.dir).length === 2 && !existsSync(macSuiteRan),
    JSON.stringify(suiteSubmits(sk2.dir)))
  ok('k2: cached as a pass that names both runs', ledger(sk2.dir).pcSuite?.ok === true &&
    /broken/.test(ledger(sk2.dir).pcSuite?.flaky ?? '') && /other/.test(ledger(sk2.dir).pcSuite?.flaky ?? ''),
    JSON.stringify(ledger(sk2.dir).pcSuite))

  // Node's spec reporter uses ✖; the older ✗ reporter also needs a space boundary,
  // since a word boundary after a symbol does not match its normal failure lines.
  for (const [reporter, glyph] of [['node', '✖'], ['tick', '✗']]) {
    suiteMode(`${reporter}-red`)
    const repeated = project(`${reporter}-repeated`)
    const held = work(repeated.dir, `chat-${reporter}`, 'repair.txt')
    const red = lane(repeated.dir, 'ready', '--session', `chat-${reporter}`)
    ok(`${reporter}: symbol failure is quoted as a code failure`,
      /fails its own test suite/.test(said(red)) && said(red).includes(`${glyph}${reporter === 'node' ? ' Context' : ''} tests/broken.test.mjs`), said(red))
    ok(`${reporter}: repeated failure is confirmed and cached red`,
      suiteSubmits(repeated.dir).length === 2 && ledger(repeated.dir).pcSuite?.ok === false,
      JSON.stringify(ledger(repeated.dir).pcSuite))
    ok(`${reporter}: the spec summary is not a failed check`,
      !ledger(repeated.dir).pcSuite?.reason?.includes('failing tests:'), JSON.stringify(ledger(repeated.dir).pcSuite))
    ok(`${reporter}: a confirmed code failure reaches the lane repair gate`,
      suiteSubmits(held.dir).length === 2 && !contains(repeated.remote, git(held.dir, 'rev-parse', 'HEAD'), 'main'), said(red))

    suiteMode(`${reporter}-red,${reporter}-red2`)
    const different = project(`${reporter}-different`)
    const feature = work(different.dir, `chat-${reporter}-different`, 'feature.txt')
    const featureTip = git(feature.dir, 'rev-parse', 'HEAD')
    const flaky = lane(different.dir, 'ready', '--session', `chat-${reporter}-different`)
    ok(`${reporter}: different check names are recognized and the lane lands`,
      contains(different.remote, featureTip, 'main') && ledger(different.dir).pcSuite?.ok === true &&
      /broken/.test(ledger(different.dir).pcSuite?.flaky ?? '') && /other/.test(ledger(different.dir).pcSuite?.flaky ?? ''), said(flaky))
  }

  // l: the confirming job is remembered too: a try that runs out of time on it does not
  // queue a third job, and a red waiting for its confirm is not a verdict yet.
  suiteMode('red,queued')
  const sl = project('suiteconfirm')
  const l = work(sl.dir, 'chat-l', 'l.txt')
  const lTip = git(l.dir, 'rev-parse', 'HEAD')
  const lFirst = lane(sl.dir, 'ready', '--session', 'chat-l')
  ok('l: waiting on the confirm is reported as waiting', /test suite is still waiting its turn on the PC/.test(said(lFirst)), said(lFirst))
  ok('l: first job plus one confirm', suiteSubmits(sl.dir).length === 2, JSON.stringify(suiteSubmits(sl.dir)))
  ok('l: not cached as red while the confirm is queued', !('ok' in (ledger(sl.dir).pcSuite ?? {})), JSON.stringify(ledger(sl.dir).pcSuite))
  const confirmId = suiteIds().at(-1)
  lane(sl.dir, 'autoship', '--session', 'chat-l')
  ok('l: next try waits on the confirming job, no third submit',
    suiteSubmits(sl.dir).length === 2 && suiteWaits().at(-1)?.[1] === confirmId, JSON.stringify(suiteWaits().slice(-2)))
  suiteMode('pass')
  const lLand = lane(sl.dir, 'autoship', '--session', 'chat-l')
  ok('l: lane lands once the confirm passes', contains(sl.remote, lTip, 'main'), said(lLand))

  // m: a cancelled suite job is the runner, not the code: not cached, dropped, resent.
  suiteMode('cancelled')
  const sm = project('suitecancel')
  const m = work(sm.dir, 'chat-m', 'm.txt')
  const mOut = lane(sm.dir, 'ready', '--session', 'chat-m')
  ok('m: cancelled suite job is reported as could not run', /test suite could not run on the PC/.test(said(mOut)), said(mOut))
  ok('m: one suite job, no confirm for a job that never ran', suiteSubmits(sm.dir).length === 1, JSON.stringify(suiteSubmits(sm.dir)))
  ok('m: not cached', !ledger(sm.dir).pcSuite, JSON.stringify(ledger(sm.dir).pcSuite))
  ok('m: no finished lane tested over a runner problem', suiteSubmits(m.dir).length === 0, JSON.stringify(suiteSubmits(m.dir)))
  suiteMode('queued')
  lane(sm.dir, 'autoship', '--session', 'chat-m')
  ok('m: next try sends a new suite job', suiteSubmits(sm.dir).length === 2, JSON.stringify(suiteSubmits(sm.dir)))

  // n: the old commit-keyed "did not finish within 20 minutes" record is not a verdict on the tree.
  suiteMode('pass')
  const sn = project('suitestale')
  const nHead = git(sn.dir, 'rev-parse', 'HEAD')
  const n = work(sn.dir, 'chat-n', 'n.txt')
  const nTip = git(n.dir, 'rev-parse', 'HEAD')
  const stale = ledger(sn.dir)
  stale.suite = { commit: nHead, ok: false, at: Date.now(), reason: "main's test suite did not finish within 20 minutes, so nothing was released." }
  writeFileSync(join(sn.dir, '.git', 'paneforge-lanes.json'), JSON.stringify(stale, null, 2))
  const nOut = lane(sn.dir, 'ready', '--session', 'chat-n')
  ok('n: stale commit-keyed red is bypassed and the lane lands', contains(sn.remote, nTip, 'main'), said(nOut))
  ok('n: the old record is left for the old copies to read', ledger(sn.dir).suite?.commit === nHead, JSON.stringify(ledger(sn.dir).suite))
  ok('n: master was asked again, not rescued by the lane fix', suiteSubmits(sn.dir).length === 1 && suiteSubmits(n.dir).length === 0,
    JSON.stringify(suiteSubmits()))

  // o: master red (confirmed) + a finished lane whose own tree passes on the PC: it lands.
  // While the lane's job is queued, the next try waits on it rather than queueing another.
  suiteMode('red,red,queued')
  const so = project('suitefix')
  const o = work(so.dir, 'chat-o', 'o.txt')
  const oTip = git(o.dir, 'rev-parse', 'HEAD')
  const oWait = lane(so.dir, 'ready', '--session', 'chat-o')
  ok('o: a queued lane fix is reported as still being tested', /still (waiting its turn|being tested) on the PC/.test(said(oWait)), said(oWait))
  ok('o: one lane suite job', suiteSubmits(o.dir).length === 1, JSON.stringify(suiteSubmits(o.dir)))
  lane(so.dir, 'autoship', '--session', 'chat-o')
  ok('o: next try reuses the lane job and the cached master red', suiteSubmits(o.dir).length === 1 && suiteSubmits(so.dir).length === 2,
    JSON.stringify(suiteSubmits()))
  suiteMode('pass')
  const oLand = lane(so.dir, 'autoship', '--session', 'chat-o')
  ok('o: lane carrying the fix lands once its PC suite passes', contains(so.remote, oTip, 'main'), said(oLand))
  ok('o: no suite ran on the Mac', !existsSync(macSuiteRan))

  // p: a waiter killed mid-wait is not a verdict: the job is kept and waited on again.
  suiteMode('killed')
  const sp = project('suitekilled')
  const pl = work(sp.dir, 'chat-p', 'p.txt')
  const pTip = git(pl.dir, 'rev-parse', 'HEAD')
  const pOut = lane(sp.dir, 'ready', '--session', 'chat-p')
  ok('p: killed waiter is reported as waiting', /test suite is still waiting its turn on the PC/.test(said(pOut)), said(pOut))
  ok('p: job kept, not cached', Boolean(ledger(sp.dir).pcSuite?.id) && !('ok' in ledger(sp.dir).pcSuite), JSON.stringify(ledger(sp.dir).pcSuite))
  const pJob = suiteIds().at(-1)
  suiteMode('pass')
  const pLand = lane(sp.dir, 'autoship', '--session', 'chat-p')
  ok('p: next try waits on the same job and lands', suiteSubmits(sp.dir).length === 1 && suiteWaits().at(-1)?.[1] === pJob &&
    contains(sp.remote, pTip, 'main'), said(pLand))

  // q: red with no failing check named (an install error, an out-of-memory kill on the PC)
  // is the runner, not the code: never confirmed into a cached red on the tree.
  suiteMode('oom')
  const sqq = project('suiteoom')
  work(sqq.dir, 'chat-q', 'q.txt')
  const qOut = lane(sqq.dir, 'ready', '--session', 'chat-q')
  ok('q: unnamed red is reported as could not run', /test suite could not run on the PC/.test(said(qOut)), said(qOut))
  ok('q: no confirm job and nothing cached', suiteSubmits(sqq.dir).length === 1 && !ledger(sqq.dir).pcSuite,
    JSON.stringify([suiteSubmits(sqq.dir).length, ledger(sqq.dir).pcSuite]))
  ok('q: the reason is rbuild\'s last status line', /rbuild: failed - exit 1/.test(said(qOut)), said(qOut))

  // q2: master's suite cannot run on the PC at all (2026-10-08 paneforge-next: `npm test`
  // started every test file at once, peaked 8.1 of 8.0 GB and the PC job was stopped), and the
  // finished lane is the one that caps it. The gate stopped at "could not run" and never asked
  // the lane, so the fix could not land. A ready lane whose own tree passes is the answer.
  mode('pass')
  const sq2 = project('suitecannot')
  const q2 = work(sq2.dir, 'chat-q2', 'q2.txt')
  const q2Tip = git(q2.dir, 'rev-parse', 'HEAD')
  writeFileSync(repoModesFile, JSON.stringify({ [real(sq2.dir)]: 'oom', [real(q2.dir)]: 'pass' }))
  const q2Out = lane(sq2.dir, 'ready', '--session', 'chat-q2')
  rmSync(repoModesFile, { force: true })
  ok('q2: lane whose own suite passes lands while master cannot run', contains(sq2.remote, q2Tip, 'main'), said(q2Out))
  ok('q2: the lane was tested on the PC', suiteSubmits(q2.dir).length === 1, JSON.stringify(suiteSubmits(q2.dir)))
  ok('q2: master\'s cannot-run is not cached', !ledger(sq2.dir).pcSuite?.tree || !('ok' in ledger(sq2.dir).pcSuite),
    JSON.stringify(ledger(sq2.dir).pcSuite))

  // q3: master cannot be SENT to the PC (unreachable): no lane jobs are queued behind it.
  mode('pass')
  const sq3 = project('suiteunsent')
  const q3 = work(sq3.dir, 'chat-q3', 'q3.txt')
  writeFileSync(join(home, '.claude', 'rbuild-unsent'), '')
  const q3Out = lane(sq3.dir, 'ready', '--session', 'chat-q3')
  rmSync(join(home, '.claude', 'rbuild-unsent'), { force: true })
  ok('q3: unreachable PC is reported as could not be sent', /test suite could not be sent to the PC/.test(said(q3Out)), said(q3Out))
  ok('q3: no lane job queued behind an unreachable PC', suiteSubmits(q3.dir).length === 0, JSON.stringify(suiteSubmits(q3.dir)))

  // q4: the same master, the next try: the PC stopped its suite after 11 minutes of running
  // (stalled at 8.1 of 8.0 GB). It ran, so the lane is asked, as in q2.
  mode('pass')
  const sq4 = project('suitestalled')
  const q4 = work(sq4.dir, 'chat-q4', 'q4.txt')
  const q4Tip = git(q4.dir, 'rev-parse', 'HEAD')
  writeFileSync(repoModesFile, JSON.stringify({ [real(sq4.dir)]: 'stalled', [real(q4.dir)]: 'pass' }))
  const q4Out = lane(sq4.dir, 'ready', '--session', 'chat-q4')
  rmSync(repoModesFile, { force: true })
  ok('q4: lane lands while master\'s suite was stopped after running', contains(sq4.remote, q4Tip, 'main'), said(q4Out))
  ok('q4: the lane was tested on the PC', suiteSubmits(q4.dir).length === 1, JSON.stringify(suiteSubmits(q4.dir)))

  // q5: timed out in line, never started: the runner, so no lane job is stacked behind it.
  mode('pass')
  const sq5 = project('suitelinetimeout')
  const q5 = work(sq5.dir, 'chat-q5', 'q5.txt')
  writeFileSync(repoModesFile, JSON.stringify({ [real(sq5.dir)]: 'linetimeout', [real(q5.dir)]: 'pass' }))
  const q5Out = lane(sq5.dir, 'ready', '--session', 'chat-q5')
  rmSync(repoModesFile, { force: true })
  ok('q5: a job that never started is reported as could not run', /test suite could not run on the PC/.test(said(q5Out)), said(q5Out))
  ok('q5: no lane job queued behind it', suiteSubmits(q5.dir).length === 0, JSON.stringify(suiteSubmits(q5.dir)))

  // r: two finished lanes while master is red: both lane jobs are queued before either is
  // waited on, so the PC runs them side by side.
  mode('queued')
  const sr2 = project('suitetwo')
  const r1 = work(sr2.dir, 'chat-r1', 'r1.txt')
  const r2 = work(sr2.dir, 'chat-r2', 'r2.txt')
  lane(sr2.dir, 'ready', '--session', 'chat-r1')
  mode('pass')
  suiteMode('red,red,queued')
  const rFrom = calls().length
  const rOut = lane(sr2.dir, 'ready', '--session', 'chat-r2')
  const rCalls = calls().slice(rFrom)
  const laneSubmit = (dir) => rCalls.findIndex((a) => a.includes('--') && repoOf(a) === real(dir))
  const laneIds = suiteIds().slice(-2)
  const firstLaneWait = rCalls.findIndex((a) => a[0] === '--wait' && laneIds.includes(a[1]))
  ok('r: both lane jobs queued before either is waited on',
    laneSubmit(r1.dir) >= 0 && laneSubmit(r2.dir) >= 0 && firstLaneWait > Math.max(laneSubmit(r1.dir), laneSubmit(r2.dir)),
    JSON.stringify(rCalls))
  ok('r: both lanes waited on in the same try', rCalls.filter((a) => a[0] === '--wait' && laneIds.includes(a[1])).length === 2,
    JSON.stringify(rCalls))
  ok('r: reported as still being tested', /still being tested on the PC/.test(said(rOut)), said(rOut))

  // s + t: a clock tick (`retry`) never waits on a PC job still in line. 2026-10-04 one held
  // the recovery lock 15 minutes inside `--wait <id> 900` and every `recover` failed; lane-cron
  // SIGKILLs a tick at 4 minutes. A job that has finished is still read by the next tick, and a
  // chat's ready/autoship keeps the full wait.
  const TICK_S = 60
  const tick = (dir) => {
    const from = calls().length
    writeFileSync(slowFile, '')
    const t0 = Date.now()
    const out = lane(dir, 'retry', '--session', 'lane-cron')
    const ms = Date.now() - t0
    rmSync(slowFile, { force: true })
    return { out, ms, waits: calls().slice(from).filter((a) => a[0] === '--wait') }
  }
  mode('queued')
  const st = project('tick')
  const s1 = work(st.dir, 'chat-s', 's.txt')
  const sTip = git(s1.dir, 'rev-parse', 'HEAD')
  lane(st.dir, 'ready', '--session', 'chat-s')
  const sJob = waits().at(-1)?.[1]
  const sTick = tick(st.dir)
  console.log(`     s: tick with the typecheck still in line held ${sTick.ms} ms (${sTick.waits.map((a) => a[2]).join(',') || 'no'} s waits)`)
  ok('s: tick makes no wait on a typecheck still in line', sTick.waits.length === 0, JSON.stringify(sTick.waits))
  ok('s: tick ends inside a tenth of the 4-minute kill (stub time)', sTick.ms < 2400, `${sTick.ms} ms`)
  ok('s: tick says it is still waiting its turn', /still waiting its turn on the PC/.test(said(sTick.out)), said(sTick.out))
  ok('s: tick sends no new job', submits().filter((a) => repoOf(a) === real(st.dir)).length === 1, JSON.stringify(submits()))
  mode('pass')
  const sDone = tick(st.dir)
  ok('s: the next tick reads the finished job and the lane lands', contains(st.remote, sTip, 'main'), said(sDone.out))
  ok('s: that read is the same job, inside the tick budget',
    sDone.waits.length >= 1 && sDone.waits.every((a) => Number(a[2]) <= TICK_S) && sDone.waits[0][1] === sJob, JSON.stringify(sDone.waits))

  // t: master's suite confirmed red on a tick (both jobs finished), then a finished lane whose
  // own job is still in line: the tick queues it and leaves it; a chat's autoship waits on it.
  mode('queued')
  const sT = project('ticksuite')
  const t1 = work(sT.dir, 'chat-t1', 't1.txt')
  lane(sT.dir, 'ready', '--session', 'chat-t1')
  mode('pass')
  suiteMode('red,red,queued')
  const tTick = tick(sT.dir)
  const tLane = suiteIds().at(-1)
  console.log(`     t: tick with a lane suite still in line held ${tTick.ms} ms (${tTick.waits.map((a) => a[2]).join(',') || 'no'} s waits)`)
  ok('t: master red is read and confirmed on the tick', ledger(sT.dir).pcSuite?.ok === false, JSON.stringify(ledger(sT.dir).pcSuite))
  ok('t: every tick wait is a finished job inside the tick budget', tTick.waits.every((a) => Number(a[2]) <= TICK_S && a[1] !== tLane),
    JSON.stringify(tTick.waits))
  ok('t: tick ends inside a tenth of the 4-minute kill (stub time)', tTick.ms < 2400, `${tTick.ms} ms`)
  ok('t: the lane job was queued once', suiteSubmits(t1.dir).length === 1, JSON.stringify(suiteSubmits(t1.dir)))
  const tFrom = calls().length
  lane(sT.dir, 'autoship', '--session', 'chat-t1')
  const tFull = calls().slice(tFrom).filter((a) => a[0] === '--wait')
  ok('t: a chat\'s autoship still waits the full budget on the lane job', tFull.some((a) => a[1] === tLane && Number(a[2]) > TICK_S),
    JSON.stringify(tFull))

  // u: master red, two finished lanes, the first one's job still in line and the second's
  // already passed: the try reads the finished one and lands it, never waiting on the first.
  // 2026-10-04 lane c's job passed at 2:45pm; the release waited its whole 900 s on lane b's
  // job, still in line ahead of it, then only queued c again, and c's verdict was never read.
  mode('queued')
  const sU = project('suiteahead')
  const u1 = work(sU.dir, 'chat-u1', 'u1.txt')
  const u2 = work(sU.dir, 'chat-u2', 'u2.txt')
  const u2Tip = git(u2.dir, 'rev-parse', 'HEAD')
  lane(sU.dir, 'ready', '--session', 'chat-u1')
  lane(sU.dir, 'ready', '--session', 'chat-u2')
  mode('pass')
  suiteMode('red,red')
  writeFileSync(repoModesFile, JSON.stringify({ [real(u1.dir)]: 'queued', [real(u2.dir)]: 'pass' }))
  const uFrom = calls().length
  writeFileSync(slowFile, '')
  const u0 = Date.now()
  const uOut = lane(sU.dir, 'autoship', '--session', 'chat-u2')
  const uMs = Date.now() - u0
  rmSync(slowFile, { force: true })
  rmSync(repoModesFile, { force: true })
  const uWaits = calls().slice(uFrom).filter((a) => a[0] === '--wait')
  const u1Job = JSON.parse(`[${readFileSync(jobsFile, 'utf8').trim().split('\n').join(',')}]`).find((j) => j.repo === real(u1.dir))?.id
  console.log(`     u: try with the first lane still in line took ${uMs} ms (${uWaits.map((a) => a[2]).join(',') || 'no'} s waits)`)
  ok('u: the lane whose job already passed lands', contains(sU.remote, u2Tip, 'main'), said(uOut))
  ok('u: no long wait on the lane still in line', !uWaits.some((a) => a[1] === u1Job && Number(a[2]) > TICK_S), JSON.stringify(uWaits))
  ok('u: the try ends inside stub time for a short read (not the 900 s wait)', uMs < 6000, `${uMs} ms`)

  // v: another chat has uncommitted edits in the main folder (and a new file). The push gate
  // judges the COMMITTED tree, so master's typecheck and suite must test exactly that: ship
  // the committed files, and key the verdict on HEAD's tree. 2026-10-07: they shipped the
  // folder as it stood, the verdict was keyed on a tree no commit has, and the pre-push hook
  // refused master (9 commits, lanes b and d) for as long as the other chat kept editing.
  mode('pass')
  suiteMode('pass')
  const sv = project('suitedirty')
  const v = work(sv.dir, 'chat-v', 'v.txt')
  const vTip = git(v.dir, 'rev-parse', 'HEAD')
  writeFileSync(join(sv.dir, 'base.txt'), 'uncommitted edit\n')
  writeFileSync(join(sv.dir, 'stray.txt'), 'new file\n')
  // Master's committed tree before the lane lands: the tree its own suite is read on.
  const vBaseTree = git(sv.dir, 'rev-parse', 'HEAD^{tree}')
  const vJobs0 = readFileSync(jobsFile, 'utf8').trim().split('\n').length
  const vOut = lane(sv.dir, 'ready', '--session', 'chat-v')
  const vJobs = readFileSync(jobsFile, 'utf8').trim().split('\n').slice(vJobs0).map(JSON.parse)
  const vHeadTree = git(sv.dir, 'rev-parse', 'HEAD^{tree}')
  ok('v: the lane lands with the main folder dirty', contains(sv.remote, vTip, 'main'), said(vOut))
  ok('v: master was tested on the PC', vJobs.some((j) => j.kind === 'suite') && vJobs.some((j) => j.kind === 'typecheck'),
    JSON.stringify(vJobs))
  ok('v: every job shipped the committed files, not the uncommitted edit',
    vJobs.length > 0 && vJobs.every((j) => j.shipped === 'base\n' && !j.stray), JSON.stringify(vJobs))
  // The pre-push hook (`treeVerdict`) matches a record's tree to the pushed commit's tree exactly,
  // so a verdict keyed on the folder as it stood can never let a push through.
  ok('v: the suite verdict is on master\'s committed tree, not the folder as it stood',
    ledger(sv.dir).pcSuite?.tree === vBaseTree && ledger(sv.dir).pcSuite?.ok === true,
    `${JSON.stringify(ledger(sv.dir).pcSuite)} vs ${vBaseTree}`)
  ok('v: the typecheck verdict is on HEAD^{tree} too', Boolean(ledger(sv.dir).typecheckTrees?.[vHeadTree]),
    `${JSON.stringify(ledger(sv.dir).typecheckTrees)} vs ${vHeadTree}`)
  ok('v: the other chat keeps its uncommitted edit and new file',
    readFileSync(join(sv.dir, 'base.txt'), 'utf8') === 'uncommitted edit\n' && existsSync(join(sv.dir, 'stray.txt')))
  ok('v: no copy is left behind in the temp folder',
    !readdirSync(childTmp).some((n) => n.startsWith('lane-pc-')), readdirSync(childTmp).join(', '))

  // w: a release asks about master's tree, then the merged tree. On a clock tick (retry) each
  // used to find the one ledger slot holding the OTHER tree and queue a fresh PC job, forever
  // (2026-10-09, lane b). Each tree keeps its own job/verdict: the second tick submits nothing.
  mode('pass,queued')
  suiteMode('pass')
  const sw = project('twotrees')
  const w = work(sw.dir, 'chat-w', 'w.txt')
  lane(sw.dir, 'ready', '--session', 'chat-w')
  const wJobs = () => readFileSync(jobsFile, 'utf8').trim().split('\n').map(JSON.parse)
    .filter((j) => j.kind === 'typecheck' && j.repo === real(sw.dir))
  const wAfterReady = wJobs().length
  lane(sw.dir, 'retry', '--session', 'lane-cron')
  lane(sw.dir, 'retry', '--session', 'lane-cron')
  ok('w: ready queued master\'s and the merged tree\'s typecheck once each', wAfterReady === 2, `${wAfterReady}`)
  ok('w: later ticks on either tree reuse the stored job and submit nothing new', wJobs().length === wAfterReady,
    `${wJobs().length} jobs`)
  ok('w: both trees are remembered in the ledger', Object.keys(ledger(sw.dir).typecheckTrees ?? {}).length === 2,
    JSON.stringify(ledger(sw.dir).typecheckTrees))
} finally {
  rmSync(root, { recursive: true, force: true })
}
if (failures) process.exit(1)
