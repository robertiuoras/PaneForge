// Regression test for the test-suite gate stacking full runs on one tree and leaving orphans.
//
// Measured on the PC 2026-10-02 10:28pm: ten `npm test` runs of the same tree at once, four of
// them orphans of a gate that had timed out. spawnSync's timeout kills only the process it
// started - cmd.exe on Windows - so npm, test-all and every suite under it ran on with nobody
// reading the answer, and each new gate run then timed out too because of the others. Every
// caller during a run (each `ready`, every ending chat's `release`, the retry timer) also
// missed the verdict cache, because a verdict is only written when a run ENDS.
//
// What is asserted, in order:
//
//   A. another live process already running master's suite on the same commit: `ready` waits
//      ("already running") and starts no suite of its own
//   B. a record that must NOT block - a dead pid, a record from hours ago, a different commit
//      - runs the suite once, and takes its own record off afterwards
//   C. (Windows) a suite killed for time takes everything it started with it, and a red answer
//      is still confirmed by a second run
//   F. (Windows) a gate process that was itself killed mid-suite leaves its record behind with a
//      dead pid; the suite it started is still running with nobody reading it, and is killed
//      before the next run starts
//   D. while master is red, a ready lane's verdict is cached on the lane's commit: the second
//      try does not run the lane's suite again, and a new commit on the lane does
//   E. while master is red, a ready lane another process is already testing is "still being
//      tested", not tested a second time
//   G. a `retry` tick (lane-cron SIGKILLs it at 4 minutes, the app at 10) does not run the suite
//      inside itself: the suite is its own job, finishes after the tick is gone and writes its
//      verdict, and the next tick ships on that verdict without starting another run
//
// Real git, real lane.mjs, no network: `npm` is stubbed on PATH (same stub as lane-heal-test).
//
//   node scripts/lane-suite-run-test.mjs

import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// Its own folder per run: in `npm test` two gates (master's and a lane's) can run it at once.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'pf-lane-suite-run-')))

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${detail}`)
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

// ---------------------------------------------------------------- a repo with a suite

let blocks = 0
let repo = join(root, 'demo')
let laneA = join(root, 'demo-a')
let runsFile = join(root, 'runs')
// Extra environment for the next `lane` calls only (the suite timeout for case C).
let extraEnv = {}

const ledgerPath = () => join(repo, '.git', 'paneforge-lanes.json')
const ledger = () => JSON.parse(readFileSync(ledgerPath(), 'utf8'))
const norm = (p) => resolve(p).toLowerCase()

/**
 * A fresh repo whose suite is `node suite.cjs`. Every run appends `<cwd> <pid>` to a file OUTSIDE
 * the repo (an untracked file inside it would make master dirty), and a second file gets the
 * ledger's in-flight record as the suite sees it. `hang` sleeps instead of finishing.
 */
function makeRepo({ code = 0, hang = false, slowMs = 0 } = {}) {
  blocks++
  repo = join(root, `demo${blocks}`)
  laneA = `${repo}-a`
  runsFile = join(root, `runs${blocks}.log`)
  rmSync(repo, { recursive: true, force: true })
  rmSync(laneA, { recursive: true, force: true })
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.1', scripts: { test: 'node suite.cjs' } }, null, 2))
  // "none" keeps the whole release path offline: lanes merge, nothing is pushed or tagged.
  writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ release: 'none', lanes: ['main', 'a', 'b'] }))
  writeFileSync(join(repo, 'app.txt'), 'one\n')
  writeFileSync(
    join(repo, 'suite.cjs'),
    `const fs = require('node:fs')\n` +
      `fs.appendFileSync(${JSON.stringify(runsFile)}, process.cwd() + ' ' + process.pid + '\\n')\n` +
      `try { fs.appendFileSync(${JSON.stringify(`${runsFile}.ledger`)}, JSON.stringify(JSON.parse(fs.readFileSync(${JSON.stringify(ledgerPath())}, 'utf8')).suiteRun ?? null) + '\\n') } catch {}\n` +
      (hang
        ? `setTimeout(() => {}, 120000)\n`
        : slowMs
          ? `setTimeout(() => process.exit(${code}), ${slowMs})\n`
          : `console.log('FAIL  fixture suite'); process.exit(${code})\n`)
  )
  installLane(here, repo)
  git(repo, 'init', '-q', '-b', 'master')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'first')
  return repo
}

const lane = (...args) =>
  execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args, '--repo', repo], {
    cwd: repo,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, ...extraEnv, PATH: stubDir + delimiter + process.env.PATH, Path: stubDir + delimiter + (process.env.Path ?? process.env.PATH) }
  }).trim()

const claimLaneA = (session) => {
  lane('claim', '--session', 'holds-main', '--cwd', repo)
  return JSON.parse(lane('claim', '--session', session, '--cwd', repo))
}

/** A committed change sitting in lane a, ready to be merged. */
const workInLaneA = (text = 'lane work\n') => {
  writeFileSync(join(laneA, 'app.txt'), text)
  git(laneA, 'add', '-A')
  git(laneA, 'commit', '-qm', 'lane a work')
}

/** Every suite start so far: `{ cwd, pid }`, in order. */
const runs = () =>
  existsSync(runsFile)
    ? readFileSync(runsFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => ({ cwd: l.slice(0, l.lastIndexOf(' ')), pid: Number(l.slice(l.lastIndexOf(' ') + 1)) }))
    : []
const runsIn = (dir) => runs().filter((r) => norm(r.cwd) === norm(dir))
const seen = () =>
  existsSync(`${runsFile}.ledger`) ? readFileSync(`${runsFile}.ledger`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []

/** Write an in-flight record for `dir` into the ledger, as another process running its suite would. */
const seedRun = (dir, commit, pid, at = Date.now(), extra = {}) => {
  const l = ledger()
  l.suiteRun = { ...l.suiteRun, [dir]: { commit, pid, at, ...extra } }
  writeFileSync(ledgerPath(), JSON.stringify(l))
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code !== 'ESRCH'
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A process that is alive until killed. */
const liveProcess = () => spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { stdio: 'ignore', windowsHide: true })
/** A pid that belonged to a process that is gone. */
const deadPid = async () => {
  const p = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true })
  await new Promise((r) => p.on('exit', r))
  return p.pid
}

// ---------------------------------------------------------------- an npm that never phones home

// Same stub as lane-heal-test: `npm test` runs the script out of package.json with the shell.
const stubDir = join(root, 'stub')
mkdirSync(stubDir, { recursive: true })
writeFileSync(
  join(stubDir, 'npm-stub.mjs'),
  `import { mkdirSync, writeFileSync } from 'node:fs'\n` +
    `import { join } from 'node:path'\n` +
    `const args = process.argv.slice(2)\n` +
    `if (args[0] === 'ci' || args[0] === 'install') {\n` +
    `  mkdirSync(join(process.cwd(), 'node_modules', '.bin'), { recursive: true })\n` +
    `  writeFileSync(join(process.cwd(), 'node_modules', 'installed-by-stub'), '')\n` +
    `  process.exit(0)\n` +
    `}\n` +
    `if (args[0] === 'run' || args[0] === 'test') {\n` +
    `  const name = args[0] === 'test' ? 'test' : args.filter((a) => !a.startsWith('--'))[1]\n` +
    `  const pkg = JSON.parse((await import('node:fs')).readFileSync(join(process.cwd(), 'package.json'), 'utf8'))\n` +
    `  const cmd = pkg.scripts?.[name]\n` +
    `  if (!cmd) { console.error('npm ERR! missing script: ' + name); process.exit(1) }\n` +
    `  const { spawnSync } = await import('node:child_process')\n` +
    `  const r = spawnSync(cmd, { cwd: process.cwd(), stdio: 'inherit', shell: true })\n` +
    `  process.exit(r.status ?? 1)\n` +
    `}\n` +
    `process.exit(0)\n`
)
writeFileSync(join(stubDir, 'npm.cmd'), `@echo off\r\nnode "%~dp0npm-stub.mjs" %*\r\n`)
writeFileSync(join(stubDir, 'npm'), `#!/bin/sh\nexec node "$(dirname "$0")/npm-stub.mjs" "$@"\n`)
try {
  chmodSync(join(stubDir, 'npm'), 0o755)
} catch {
  /* Windows */
}

const spawned = []
// Pids of processes a case orphaned on purpose; killed on the way out if the code under test did not.
const strays = []
const cleanup = () => {
  for (const pid of strays) {
    try {
      process.kill(pid)
    } catch {
      /* already gone */
    }
  }
  for (const p of spawned) {
    try {
      p.kill()
    } catch {
      /* already gone */
    }
  }
  // A suite the timeout case left behind must not outlive a failing test.
  for (const r of runs()) if (alive(r.pid)) {
    try {
      process.kill(r.pid)
    } catch {
      /* gone */
    }
  }
}
process.on('exit', cleanup)

// ---------------------------------------------------------------- A: another process is running it

makeRepo()
claimLaneA('s1')
workInLaneA()
const headA = git(repo, 'rev-parse', 'HEAD')
const holder = liveProcess()
spawned.push(holder)
seedRun(repo, headA, holder.pid)
const waited = lane('ready', '--session', 's1')
ok('a suite another process is already running on this commit is waited for', /already running/i.test(waited), waited)
ok('and no second suite was started', runs().length === 0, JSON.stringify(runs()))
ok('and nothing was released on the strength of it', !/merged into master/i.test(waited) && !git(repo, 'log', '--oneline', 'master').includes('merge lane a'), waited)
ok('and the other process\'s record is left alone', ledger().suiteRun?.[repo]?.pid === holder.pid, JSON.stringify(ledger().suiteRun))

// Once that process is gone the same lane goes out, with no one asked anything.
holder.kill()
await new Promise((r) => holder.on('exit', r))
const after = lane('autoship', '--session', 's1')
ok('when the other process is gone the work goes out by itself', /merged into master/i.test(after), after)
ok('and the suite ran once', runs().length === 1, JSON.stringify(runs()))

// ---------------------------------------------------------------- B: records that must not block

const stale = [
  ['a pid that no longer exists', async () => ({ pid: await deadPid(), at: Date.now(), commit: git(repo, 'rev-parse', 'HEAD') })],
  ['a record from hours ago, even with a live pid', async () => {
    const p = liveProcess()
    spawned.push(p)
    return { pid: p.pid, at: Date.now() - 3 * 60 * 60 * 1000, commit: git(repo, 'rev-parse', 'HEAD') }
  }],
  ['a live pid running a different commit', async () => {
    const p = liveProcess()
    spawned.push(p)
    return { pid: p.pid, at: Date.now(), commit: '0'.repeat(40) }
  }]
]
for (const [name, make] of stale) {
  makeRepo()
  claimLaneA('s1')
  workInLaneA()
  const headBefore = git(repo, 'rev-parse', 'HEAD')
  const rec = await make()
  seedRun(repo, rec.commit, rec.pid, rec.at)
  const out = lane('ready', '--session', 's1')
  ok(`${name} does not stop the suite`, runs().length === 1 && /merged into master/i.test(out), `${out}\n${JSON.stringify(runs())}`)
  ok(`${name}: the run wrote its own record while it ran`, seen().length === 1 && seen()[0]?.[repo]?.commit === headBefore && seen()[0][repo].pid !== rec.pid && typeof seen()[0][repo].pid === 'number', JSON.stringify(seen()))
  ok(`${name}: and took it off afterwards`, ledger().suiteRun?.[repo] === undefined, JSON.stringify(ledger().suiteRun))
}

// ---------------------------------------------------------------- C: killed for time, killed whole

if (process.platform === 'win32') {
  makeRepo({ hang: true })
  claimLaneA('s1')
  workInLaneA()
  // 5s, not the 20 minutes of a real gate; a suite that sleeps never finishes in it.
  extraEnv = { PF_SUITE_TIMEOUT_MS: '5000' }
  let timedOut
  try {
    timedOut = lane('ready', '--session', 's1')
  } finally {
    extraEnv = {}
  }
  await sleep(3000)
  const started = runs()
  ok('a suite that never finishes is reported as one', /did not finish/i.test(timedOut), timedOut)
  ok('the red answer was confirmed by a second run of master', runsIn(repo).length === 2, JSON.stringify(started))
  ok('every suite the gate started is dead, not left running', started.length > 0 && started.every((r) => !alive(r.pid)), JSON.stringify(started.map((r) => [r.pid, alive(r.pid)])))
  ok('and no record of a run is left in the ledger', Object.keys(ledger().suiteRun ?? {}).length === 0, JSON.stringify(ledger().suiteRun))
} else {
  console.log('ok    skipped: the timed-out suite cleanup is Windows-only')
}

// ---------------------------------------------------------------- F: the gate itself was killed

// lane-cron SIGKILLs its `retry` after 4 minutes and the app's retry tick has a timeout too, both far
// inside one suite. The gate dies, its record stays, and npm/test-all keep running as orphans. The
// record's pid is dead, so the next caller kills what that pid started (Windows keeps a dead
// parent's id on its children) and takes the record off, whatever commit it was on.
if (process.platform === 'win32') {
  for (const [name, sameCommit] of [['another commit', false], ['this commit', true]]) {
    makeRepo()
    claimLaneA('s1')
    workInLaneA()
    // A parent that starts a long sleeper and exits. The sleeper is detached because libuv puts every
    // child of a node process in a job that dies with it (measured: an ordinary child is gone the
    // moment its parent exits). Detaching leaves its parent id pointing at the dead parent, which is
    // what the processes this case stands for - run through a detached or non-node launcher - look like.
    const parent = spawn(
      process.execPath,
      [
        '-e',
        `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { stdio: 'ignore', windowsHide: true, detached: true }); process.stdout.write(String(c.pid), () => process.exit(0))`
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
    )
    let printed = ''
    parent.stdout.on('data', (d) => (printed += d))
    await new Promise((r) => parent.on('exit', r))
    const orphan = Number(printed.trim())
    if (orphan) strays.push(orphan)
    ok(`(${name}) the orphan this case needs is running under a dead parent`, orphan > 0 && alive(orphan) && !alive(parent.pid), `orphan ${orphan} alive=${alive(orphan)}, parent ${parent.pid} alive=${alive(parent.pid)}`)
    seedRun(repo, sameCommit ? git(repo, 'rev-parse', 'HEAD') : '0'.repeat(40), parent.pid)
    const out = lane('ready', '--session', 's1')
    for (let i = 0; i < 12 && alive(orphan); i++) await sleep(250)
    ok(`(${name}) what a killed gate left running is killed before the next run`, !alive(orphan), `orphan ${orphan} still alive`)
    ok(`(${name}) and the suite then runs once and the work goes out`, runs().length === 1 && /merged into master/i.test(out), `${out}
${JSON.stringify(runs())}`)
    ok(`(${name}) and the dead record is gone`, ledger().suiteRun?.[repo] === undefined, JSON.stringify(ledger().suiteRun))
  }
} else {
  console.log('ok    skipped: killing what a killed gate left running is Windows-only')
}

// ---------------------------------------------------------------- D: a lane's verdict is cached

// Master and the lane both fail, so the gate asks the lane whether it carries the fix. The lane's
// answer is a fact about its tree, and used to be asked again, twice, on every try.
makeRepo({ code: 1 })
claimLaneA('s1')
workInLaneA()
const first = lane('ready', '--session', 's1')
ok('a red master with a red lane is not released', !/merged into master/i.test(first) && /fails its own test suite/.test(first), first)
ok('master was run and confirmed, the lane likewise', runsIn(repo).length === 2 && runsIn(laneA).length === 2, JSON.stringify(runs()))
const laneHead = git(laneA, 'rev-parse', 'HEAD')
let verdict = ledger().laneSuite?.[laneA]
ok('the lane\'s verdict is written down on its commit', verdict?.ok === false && verdict.commit === laneHead && Boolean(verdict.reason), JSON.stringify(ledger().laneSuite))
const second = lane('autoship', '--session', 's1')
ok('the second try says the same thing', /fails its own test suite/.test(second) && !/merged into master/i.test(second), second)
ok('and did not run the lane\'s suite again', runsIn(laneA).length === 2 && runsIn(repo).length === 2, JSON.stringify(runs()))

// A new commit on the lane is a new tree: it is tested again once the lane says it is done.
workInLaneA('lane work, more\n')
const third = lane('ready', '--session', 's1')
ok('a new commit on the lane is tested again', runsIn(laneA).length === 4, `${third}\n${JSON.stringify(runs())}`)
verdict = ledger().laneSuite?.[laneA]
ok('and the verdict moves to the new commit', verdict?.commit === git(laneA, 'rev-parse', 'HEAD'), JSON.stringify(ledger().laneSuite))

// ---------------------------------------------------------------- E: a lane someone else is testing

makeRepo({ code: 1 })
claimLaneA('s1')
workInLaneA()
const holderE = liveProcess()
spawned.push(holderE)
seedRun(laneA, git(laneA, 'rev-parse', 'HEAD'), holderE.pid)
const pending = lane('ready', '--session', 's1')
ok('a lane another process is already testing is reported as still being tested', /still being tested/.test(pending) && /same runs/.test(pending), pending)
ok('and its suite was not run a second time', runsIn(laneA).length === 0 && runsIn(repo).length === 2, JSON.stringify(runs()))
ok('and nothing is cached for it', ledger().laneSuite?.[laneA] === undefined, JSON.stringify(ledger().laneSuite))

// ---------------------------------------------------------------- G: the tick is killed, the run is not

// A `retry` is a clock tick with a time limit far inside one suite. When the suite ran inside the
// tick, killing the tick took the suite with it (libuv's kill-on-close job on Windows; on a Mac it
// ran on with nobody left to write the answer), so every tick burned a run and none produced a verdict.
{
  makeRepo({ slowMs: 20000 })
  claimLaneA('s1')
  workInLaneA()
  const head = git(repo, 'rev-parse', 'HEAD')
  // Marked ready while another check holds the suite, so nothing has run when the tick starts.
  const holderG = liveProcess()
  spawned.push(holderG)
  seedRun(repo, head, holderG.pid)
  lane('ready', '--session', 's1')
  holderG.kill()
  await new Promise((r) => holderG.on('exit', r))
  const env = { ...process.env, PATH: stubDir + delimiter + process.env.PATH, Path: stubDir + delimiter + (process.env.Path ?? process.env.PATH) }
  const tick = spawn(process.execPath, [join(repo, 'scripts', 'lane.mjs'), 'retry', '--repo', repo, '--session', 'lane-cron'], { cwd: repo, env, stdio: 'ignore', windowsHide: true })
  spawned.push(tick)
  let tickEnded = false
  tick.on('exit', () => (tickEnded = true))
  for (let i = 0; i < 60 && !runs().length; i++) await sleep(250)
  // The suite sleeps 20 s. A tick that runs it inside itself is still waiting 12 s in (room for
  // a loaded machine under npm test), and is killed then, as lane-cron's limit would.
  for (let i = 0; i < 48 && !tickEnded; i++) await sleep(250)
  const endedBySelf = tickEnded
  if (!tickEnded) {
    tick.kill('SIGKILL')
    await new Promise((r) => tick.on('exit', r))
  }
  ok('a retry tick started the suite', runs().length === 1, JSON.stringify(runs()))
  ok('and did not sit waiting for it', endedBySelf, 'still running 12 s into the suite, killed')
  for (let i = 0; i < 200 && ledger().suite?.commit !== head; i++) await sleep(250)
  ok('the suite finished with the tick gone and its verdict is written on the commit', ledger().suite?.commit === head && ledger().suite.ok === true, JSON.stringify(ledger().suite))
  for (let i = 0; i < 20 && ledger().suiteRun?.[repo]; i++) await sleep(250)
  ok('and its run record came off', ledger().suiteRun?.[repo] === undefined, JSON.stringify(ledger().suiteRun))
  const next = lane('retry', '--session', 'lane-cron')
  ok('the next tick ships on that verdict', /merged into master/i.test(next), next)
  ok('without running the suite again', runs().length === 1, JSON.stringify(runs()))
}

// ---------------------------------------------------------------- H: a job on an older commit

// Master moved while a suite job was still testing the commit before. Its verdict answers a
// question nobody will ask and it holds the one-suite-per-computer lock for up to two passes,
// so it is killed whole and the new commit runs once. A record that is NOT a job is a chat's own
// lane.mjs running the suite in-process: never killed.
{
  makeRepo()
  const detachedLive = () => spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { stdio: 'ignore', windowsHide: true, detached: true })
  const chat = detachedLive()
  spawned.push(chat)
  claimLaneA('s1')
  workInLaneA()
  seedRun(repo, 'f'.repeat(40), chat.pid)
  lane('ready', '--session', 's1')
  ok('a chat running the suite on an older commit is left alone', alive(chat.pid), JSON.stringify(ledger().suiteRun))
  ok('and the current commit is tested anyway', runsIn(repo).length === 1, JSON.stringify(runs()))
  chat.kill()

  workInLaneA('lane work, more\n')
  const head = git(repo, 'rev-parse', 'HEAD')
  const job = detachedLive()
  spawned.push(job)
  seedRun(repo, 'e'.repeat(40), job.pid, Date.now(), { job: true })
  const out = lane('ready', '--session', 's1')
  for (let i = 0; i < 20 && alive(job.pid); i++) await sleep(250)
  ok('a suite job still testing an older commit is killed', !alive(job.pid), out)
  ok('and the new commit runs once', runsIn(repo).length === 2, JSON.stringify(runs()))
  ok('and its verdict is written on the new commit', ledger().suite?.commit === head && ledger().suite.ok === true, JSON.stringify(ledger().suite))
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
