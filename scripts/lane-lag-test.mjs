// Regression test for the freeze that lane inspection used to cause - src/main/laneWork.ts.
//
// This does not test what laneWork() ANSWERS (lane-work-test.mjs does that). It tests the
// thing that actually reached the user: whether asking the question stops the thread.
//
// Every git call in laneWork.ts was `spawnSync`, and laneWork() runs seven of them per
// lane. sweepEmptyLanes() calls it for every lane of every open project on a five-minute
// timer, all of it on the Electron main thread - the one that pumps the window's
// messages. Measured against the shipped v0.3.40 from outside the app, with
// SendMessageTimeout(WM_NULL) (the same question Windows asks before it writes
// "Not Responding" on a title bar):
//
//   p50 0.2ms, p90 1.3ms, p99 10.5ms, and then an 8,053ms freeze of the whole window.
//   Two of them, 17:42:47 and 17:47:47 - exactly 300s apart, the sweep interval.
//
// So the check is event-loop lag, which is the same defect measured on the same thread:
// hold a 10ms timer while the sweep runs and see how late it is. With spawnSync the timer
// cannot fire at all until git exits; with execFile it keeps ticking throughout.
//
//   node scripts/lane-lag-test.mjs

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'

const repoRoot = resolve(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'pf-lanelag-'))
let failures = 0

/**
 * The smallest number of timer ticks that must happen DURING one laneWork() call.
 *
 * Wall-clock lag is the wrong assertion here, and measuring proved it: against a fixture
 * repo in tmpdir every git call returns in ~10ms, so the old synchronous version blocked
 * for only ~70ms per lane and sailed past a generous millisecond threshold. It froze the
 * real app for eight seconds because the real repos are big and there are four of them.
 * A test that only fails on a slow enough machine is not a regression test.
 *
 * This is machine-independent instead: laneWork() runs seven git calls, and the question
 * is whether the thread is free BETWEEN them. Synchronous git yields nothing at all - a
 * 10ms timer gets exactly zero ticks no matter how fast the machine is. Async git yields
 * on every call. Two ticks cannot happen by luck and cannot happen at all if any of those
 * calls goes back to being synchronous.
 */
const MIN_TICKS = 2

function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` - ${detail}`}`)
  if (!ok) failures++
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`)
  return (r.stdout ?? '').trim()
}

/**
 * Get the real `laneWork.ts` as something node can import.
 *
 * This used to be `tsc <file>`, and it was red on master twice over without either failure
 * saying anything about lanes. First, a standalone tsc compiles with strictNullChecks OFF
 * (the project's tsconfig is not read), and under that setting an unrelated shared type
 * stops being assignable - so the test died on a type error `npm run typecheck` does not
 * have. Then, with that fixed, tsc emits the import specifiers exactly as written, and
 * node's ESM loader will not resolve an extensionless `../shared/draft`.
 *
 * esbuild answers both: it bundles rather than type-checks, so the module arrives as one
 * file with nothing left to resolve. The behaviour under test is git-call scheduling,
 * which no compiler has an opinion about.
 */
async function loadLaneWork() {
  const out = join(work, 'laneWork.mjs')
  buildSync({
    absWorkingDir: repoRoot,
    entryPoints: [join('src', 'main', 'laneWork.ts')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20'
  })
  return import(pathToFileURL(out).href)
}

const lw = await loadLaneWork()

/** A repo with `lanes` worktree lanes, each holding a commit - the shape that is slowest. */
function fixture(name, lanes) {
  const repo = join(work, name)
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'app.js'), 'const a = 1\n')
  git(repo, ['init', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'test'])
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'first'])
  const dirs = []
  for (let i = 2; i < 2 + lanes; i++) {
    const lane = `${repo}-w${i}`
    git(repo, ['worktree', 'add', '-b', `pf/w${i}`, lane])
    git(lane, ['config', 'user.email', 'test@example.com'])
    git(lane, ['config', 'user.name', 'test'])
    // A lane with a commit is the expensive path: it also runs `merge-tree`.
    writeFileSync(join(lane, `feature${i}.js`), `export const f = ${i}\n`)
    git(lane, ['add', '-A'])
    git(lane, ['commit', '-m', `work in w${i}`])
    dirs.push(lane)
  }
  return { repo, dirs }
}

/**
 * Run `fn` while a 10ms timer ticks, and report the worst gap between ticks.
 *
 * A synchronous child process shows up here exactly as it shows up in the app: the timer
 * simply does not run until the call returns.
 */
async function lagDuring(fn) {
  let worst = 0
  let ticks = 0
  let last = performance.now()
  const tick = setInterval(() => {
    const now = performance.now()
    worst = Math.max(worst, now - last - 10)
    last = now
    ticks++
  }, 10)
  // Let the timer settle before the work starts, so process warm-up is not counted.
  await new Promise((r) => setTimeout(r, 50))
  last = performance.now()
  ticks = 0
  const value = await fn()
  clearInterval(tick)
  return { worst, ticks, value }
}

// ---------------------------------------------------------------- the sweep's own cost

{
  // Four lanes is what this machine actually had when the 8s freeze was measured.
  const { repo, dirs } = fixture('lag', 4)

  // ONE lane, so nothing but laneWork()'s own git calls can be yielding.
  const one = await lagDuring(() => lw.laneWork(dirs[0]))
  check('reading a lane answers correctly', one.value?.ahead === 1 && one.value?.dirty === 0)
  check(
    `the thread stays free while one lane is read (${one.ticks} ticks, worst ${one.worst.toFixed(0)}ms)`,
    one.ticks >= MIN_TICKS,
    `${one.ticks} timer ticks during laneWork() - synchronous git yields none`
  )

  const read = await lagDuring(async () => {
    const all = []
    for (const dir of dirs) all.push(await lw.laneWork(dir))
    return all
  })
  check(
    'reading four lanes answers correctly',
    read.value.every((w) => w?.ahead === 1 && w.dirty === 0),
    JSON.stringify(read.value.map((w) => w && { lane: w.lane, ahead: w.ahead }))
  )

  // The whole sweep, which is what actually runs on the timer. Nothing here is empty, so
  // every lane is inspected and kept - the slowest case, and the one the user sits in.
  const swept = await lagDuring(() => lw.sweepLanes(repo, []))
  check('a sweep of lanes holding work removes nothing', swept.value.length === 0)
  check(
    `the thread stays free throughout a sweep (${swept.ticks} ticks, worst ${swept.worst.toFixed(0)}ms)`,
    swept.ticks >= MIN_TICKS,
    `${swept.ticks} timer ticks during the sweep - synchronous git yields none`
  )
}

// ---------------------------------------------------------------- the source guard
//
// The lag numbers above depend on the machine. This does not: the bug was one specific
// call shape, and it is worth failing loudly the moment it reappears in a file that runs
// on the main thread.

{
  const { readFileSync } = await import('node:fs')
  for (const file of ['laneWork.ts', 'lanes.ts', 'git.ts']) {
    const src = readFileSync(join(repoRoot, 'src', 'main', file), 'utf8')
    // Comments explain why it is gone; only real code counts.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    check(`${file} runs no synchronous child process`, !/spawnSync|execFileSync|execSync/.test(code))
  }
}

rmSync(work, { recursive: true, force: true })
console.log(failures ? `\n${failures} failed` : '\nall good')
process.exit(failures ? 1 : 0)

// Measured here (Windows 11, git 2.53), four lanes each holding a commit, by running this
// file against `git show master:src/main/laneWork.ts` and then against the fix:
//
//                       ticks during one laneWork()   ticks during a whole sweep
//   before (spawnSync)              0                            0
//   after  (execFile)              20                           93
//
// Wall-clock lag on this fixture was ~10ms either way, which is exactly why the assertion
// counts ticks instead: the fixture repos are small, the real ones are not. The app-level
// number is in laneWork.ts's run() - an 8,053ms window freeze, measured from outside the
// shipped build.
