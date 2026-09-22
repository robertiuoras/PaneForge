#!/usr/bin/env node
/**
 * The main process may not flood the machine with git.
 *
 * 2026-09-22, installed 0.8.221: load average 390-430, 135-270 `git` children of the
 * PaneForge main process (`worktree list` x19, `status --untracked-files=all` x18, ...) and
 * 28 zombies. The lane sweep had no single-flight and every `sessions` event reset its
 * five-minute throttle, so sweeps overlapped every three seconds.
 *
 * Pure half: `src/shared/gitGate.ts` (the cap, the joining, the sweep clock), including a
 * replay of the storm under the old and the new sweep rule. Real half: `src/main/gitRun.ts`
 * bundled with esbuild against a scratch repository - identical reads share one process,
 * and a git that hangs is killed at its timeout and leaves no child behind.
 *
 *   node scripts/git-gate-test.mjs
 */
import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const G = await import(pathToFileURL(join(root, 'src/shared/gitGate.ts')).href)
const { GitGate, GIT_MAX, capFor, sweepDue, sweepGap } = G

let bad = 0
const ok = (what, cond, extra = '') => {
  console.log((cond ? 'ok    ' : 'FAIL  ') + what + (extra ? `  (${extra})` : ''))
  if (!cond) bad++
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

console.log('the cap')
ok('four at once on an unloaded machine', GIT_MAX === 4 && capFor(4, 0.5) === 4)
ok('half while loaded (2 per core)', capFor(4, 2.5) === 2)
ok('one while badly loaded (4 per core)', capFor(4, 400 / 12) === 1)
ok('Windows reports load 0: still the full cap, never unlimited', capFor(4, 0) === 4)
{
  const gate = new GitGate(4)
  let live = 0
  let peakLive = 0
  const jobs = []
  for (let i = 0; i < 40; i++)
    jobs.push(
      gate.run(`k${i}`, async () => {
        live++
        peakLive = Math.max(peakLive, live)
        await tick(5)
        live--
        return i
      })
    )
  ok('forty distinct reads wait their turn', gate.active === 4 && gate.waiting === 36, `${gate.active} running, ${gate.waiting} waiting`)
  const out = await Promise.all(jobs)
  ok('never more than four running', peakLive === 4 && gate.peak === 4, `peak ${peakLive}`)
  ok('every one answered, in its own order', out.every((v, i) => v === i))
  ok('nothing left over', gate.active === 0 && gate.waiting === 0)
}
{
  let load = 5
  const gate = new GitGate(4, () => load)
  const jobs = Array.from({ length: 6 }, (_, i) => gate.run(`k${i}`, () => tick(5)))
  ok('a machine at load 5 per core gets one git at a time', gate.active === 1)
  load = 0
  await jobs[0]
  await tick(0)
  ok('and the full cap back once it recovers', gate.active === 4, `${gate.active} running`)
  await Promise.all(jobs)
}

console.log('single-flight')
{
  const gate = new GitGate(4)
  let runs = 0
  const same = Array.from({ length: 19 }, () =>
    gate.run('/repo\0worktree\0list\0--porcelain', async () => {
      runs++
      await tick(5)
      return 'worktree /repo'
    })
  )
  const answers = await Promise.all(same)
  ok('19 identical `worktree list` asks start ONE git', runs === 1, `${runs} runs, ${gate.joined} joined`)
  ok('and all 19 get its answer', answers.every((a) => a === 'worktree /repo'))
  await gate.run('/repo\0worktree\0list\0--porcelain', async () => runs++)
  ok('the next ask after it finished runs again (no stale answer kept)', runs === 2)
}
{
  const gate = new GitGate(4)
  let runs = 0
  await Promise.all([1, 2, 3].map(() => gate.run(null, async () => runs++)))
  ok('a command with no key (a merge, a remove) is never joined', runs === 3)
}
{
  const gate = new GitGate(1)
  const failed = gate.run('boom', async () => {
    throw new Error('git exploded')
  })
  const after = gate.run('fine', async () => 'ran')
  let msg = ''
  await failed.catch((e) => (msg = e.message))
  ok('a failing job rejects its caller', msg === 'git exploded')
  const ran = await after
  await tick(0)
  ok('and frees its slot for the next one', ran === 'ran' && gate.active === 0)
  const threw = gate.run('sync', () => {
    throw new Error('sync throw')
  })
  let m2 = ''
  await threw.catch((e) => (m2 = e.message))
  await tick(0)
  ok('a job that throws before its promise is a rejection, not a stuck slot', m2 === 'sync throw' && gate.active === 0)
}

console.log('the sweep clock')
const base = { now: 0, startedAt: 0, tookMs: 0, running: false, soon: false, loadPerCore: 0 }
ok('never swept: sweep', sweepDue(base))
ok('one already running: never a second', !sweepDue({ ...base, running: true, soon: true }))
ok('a pane ended 3s after the last sweep began: not yet (the old rule said yes)', !sweepDue({ ...base, now: 3_000, startedAt: 1, soon: true }))
ok('a pane ended, a minute on: yes', sweepDue({ ...base, now: 60_001, startedAt: 1, soon: true }))
ok('ordinary clock: four minutes no', !sweepDue({ ...base, now: 4 * 60_000, startedAt: 1 }))
ok('ordinary clock: five minutes yes', sweepDue({ ...base, now: 5 * 60_000 + 1, startedAt: 1 }))
ok('a sweep that took 60s waits ten minutes', sweepGap({ tookMs: 60_000, soon: true, loadPerCore: 0 }) === 10 * 60_000)
ok('a loaded machine waits four times as long', sweepGap({ tookMs: 0, soon: false, loadPerCore: 2.5 }) === 20 * 60_000)
ok('but never longer than half an hour', sweepGap({ tookMs: 600_000, soon: false, loadPerCore: 30 }) === 30 * 60_000)

// The storm, replayed. Sixteen panes make a `sessions` event about every second; under load
// one sweep of every project took about a minute. Old rule: each event zeroed the throttle
// and swept 3s later, with nothing stopping a sweep that overlaps the last one.
console.log('the storm, replayed for ten minutes')
function replay(rule) {
  const SWEEP_TOOK = 60_000
  const running = []
  let started = 0
  let peak = 0
  const s = { startedAt: 0, tookMs: 0, running: false, soon: false }
  for (let t = 1000; t < 601_000; t += 1000) {
    while (running.length && running[0] <= t) running.shift()
    s.running = running.length > 0
    if (!s.running && started) s.tookMs = SWEEP_TOOK
    const go =
      rule === 'old'
        ? t % 3000 === 0 // an event every second, debounced to one sweep per 3s
        : sweepDue({ now: t, ...s, soon: true, loadPerCore: 30 })
    if (go) {
      started++
      s.startedAt = t
      running.push(t + SWEEP_TOOK)
      running.sort((a, b) => a - b)
      peak = Math.max(peak, running.length)
    }
  }
  return { started, peak }
}
const before = replay('old')
const after = replay('new')
console.log(`      before: ${before.started} sweeps started, ${before.peak} running at once`)
console.log(`      after:  ${after.started} sweeps started, ${after.peak} running at once`)
ok('the old rule overlapped ~20 sweeps (the 19x `worktree list` that was measured)', before.peak >= 19)
ok('the new rule never runs two', after.peak === 1)
ok('and on a loaded machine sweeps at most twice in ten minutes', after.started <= 2)

console.log('real git, through src/main/gitRun.ts')
const scratch = mkdtempSync(join(tmpdir(), 'pf-gitgate-'))
try {
  const out = join(scratch, 'gitRun.mjs')
  buildSync({
    entryPoints: [join(root, 'src', 'main', 'gitRun.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'silent'
  })
  const { gitRun } = await import(pathToFileURL(out).href)
  const repo = join(scratch, 'repo')
  execFileSync('git', ['init', '-q', repo])
  writeFileSync(join(repo, 'a.txt'), 'x')

  const reads = await Promise.all(
    Array.from({ length: 12 }, () =>
      gitRun(repo, ['status', '--porcelain', '-z', '--untracked-files=all'], { timeout: 10_000, read: true })
    )
  )
  ok('twelve identical status reads all answer', reads.every((r) => r.ok && r.stdout.includes('a.txt')))
  ok('a read leaves no index.lock behind', !existsSync(join(repo, '.git', 'index.lock')))

  // `hash-object --stdin` waits on a stdin nobody closes: the model of a wedged git.
  const t0 = Date.now()
  const hung = await gitRun(repo, ['hash-object', '--stdin'], { timeout: 300, read: false })
  const took = Date.now() - t0
  ok('a hung git is killed at its timeout (it would otherwise never exit)', !hung.ok && hung.status === -1 && took < 10_000, `${took}ms`)
  await tick(100)
  const left =
    process.platform === 'win32'
      ? ''
      : execFileSync('ps', ['-Ao', 'ppid=,stat=,command='], { encoding: 'utf8' })
          .split('\n')
          .filter((l) => l.trim().startsWith(`${process.pid} `) && /git/.test(l))
          .join('\n')
  ok('and leaves no child, running or zombie', left === '', left)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(bad ? `\n${bad} FAILED` : '\nall passed')
process.exit(bad ? 1 : 0)
