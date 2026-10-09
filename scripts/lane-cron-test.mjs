// Regression test for the lane clock that piled git onto the PC (measured 2026-10-09).
//
// The PaneForgeLaneRetry task starts `lane-cron.mjs` every 10 minutes through a VBS shim
// that does not wait, so Task Scheduler never saw a tick still running and started the next
// one on top of it: 63 ticks that day, 8 longer than 10 minutes, up to 4 running at once.
// Each tick runs `lane.mjs retry` per repo, and lane.mjs gives every git call 20 seconds.
// On Windows the `git` on PATH is Git\cmd\git.exe, a launcher: when the timeout kills it,
// the git underneath loses its parent and keeps going, so a slow fetch stayed alive after
// the retry gave up on it and the next tick started another one beside it - 2,757
// `git fetch --tags` starts in thirteen hours, bursts of 400+ git starts in one minute, and
// hooks timing out in the same minutes.
//
// What this proves, against a copy of lane-cron.mjs and a fake lane.mjs:
//   - a tick that finds another tick running does nothing (and a dead or 3-hour-old lock
//     does not stop it)
//   - lane.mjs runs with git told to give up on a stalled download and never prompt
//   - Windows: a git left running by a timed-out call inside the retry is gone when the
//     tick finishes, and a retry that runs past its limit is killed with everything under it
//
// No network: the "remote" is a local socket that accepts and never answers.
//
//   node scripts/lane-cron-test.mjs

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const win = process.platform === 'win32'
const root = mkdtempSync(join(tmpdir(), 'paneforge-lane-cron-test-'))
const scripts = join(root, 'scripts')
const repo = join(root, 'repo')
const claude = join(root, 'claude')
const lockFile = join(claude, 'lane-cron.lock')
const marker = join(root, 'ran.jsonl')
mkdirSync(scripts, { recursive: true })
mkdirSync(claude, { recursive: true })
copyFileSync(join(here, 'lane-cron.mjs'), join(scripts, 'lane-cron.mjs'))
writeFileSync(join(claude, 'lane-repos.json'), JSON.stringify({ repos: {} }))
spawnSync('git', ['init', '-q', repo], { windowsHide: true })

// The fake engine. LANE_CRON_TEST_MODE picks what it does; it reaches here through the
// environment lane-cron hands its child, which is part of what is being tested.
writeFileSync(
  join(scripts, 'lane.mjs'),
  `import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
const t0 = Date.now()
const mode = process.env.LANE_CRON_TEST_MODE
const url = 'http://127.0.0.1:' + process.env.LANE_CRON_TEST_PORT + '/' + process.env.LANE_CRON_TEST_TAG + '.git'
const lock = ${JSON.stringify(lockFile)}
const record = (extra) => appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ mode, ppid: process.ppid, ...extra }) + '\\n')
if (mode === 'record') {
  const e = process.env
  record({
    lock: existsSync(lock) ? JSON.parse(readFileSync(lock, 'utf8')) : null,
    env: { limit: e.GIT_HTTP_LOW_SPEED_LIMIT, time: e.GIT_HTTP_LOW_SPEED_TIME, prompt: e.GIT_TERMINAL_PROMPT }
  })
} else if (mode === 'orphan') {
  // lane.mjs's git(): execFileSync with a timeout. The stall guard is taken away so the
  // only thing that can clean up after this is the tick itself.
  const env = { ...process.env }
  delete env.GIT_HTTP_LOW_SPEED_LIMIT
  delete env.GIT_HTTP_LOW_SPEED_TIME
  try {
    execFileSync('git', ['fetch', url], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 2000, killSignal: 'SIGKILL' })
  } catch {}
  await new Promise((r) => setTimeout(r, Math.max(0, 16_000 - (Date.now() - t0))))
  record({})
} else if (mode === 'hang') {
  spawn('git', ['fetch', url], { windowsHide: true, stdio: 'ignore' })
  setInterval(() => {}, 1000)
}
`
)

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  }
}

const sockets = []
// A killed git resets its connection; that is expected here, not a crash.
const server = createServer((s) => sockets.push(s.on('error', () => {})))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const runs = () => (existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

/** One tick against the temp repo. Resolves with its exit code and how long it took. */
function tick(mode, { tag = 'none', env = {}, deadlineMs = 60_000 } = {}) {
  rmSync(marker, { force: true })
  const t0 = Date.now()
  const child = spawn(process.execPath, [join(scripts, 'lane-cron.mjs'), '--repo', repo, '--quiet'], {
    cwd: root,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      // Git\cmd first, as on the PC: the launcher is what turns a timeout into an orphan.
      PATH: win ? `C:\\Program Files\\Git\\cmd;${process.env.PATH}` : process.env.PATH,
      LANE_REGISTRY: join(claude, 'lane-repos.json'),
      LANE_CRON_TEST_MODE: mode,
      LANE_CRON_TEST_PORT: String(port),
      LANE_CRON_TEST_TAG: tag,
      ...env
    }
  })
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      child.kill('SIGKILL')
    }, deadlineMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, ms: Date.now() - t0 })
    })
  })
}

/** Processes whose command line carries `tag`, as "pid name". Windows only. */
function survivors(tag) {
  const out = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | ? { $_.CommandLine -match '${tag}' -and $_.Name -ne 'powershell.exe' } | % { "$($_.ProcessId) $($_.Name)" }`],
    { encoding: 'utf8', windowsHide: true }
  ).stdout.trim()
  return out ? out.split(/\r?\n/) : []
}
function reap(tag) {
  for (const line of survivors(tag)) spawnSync('taskkill', ['/PID', line.split(' ')[0], '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
}

try {
  // 1. A tick already running: the new one leaves without starting anything.
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }))
  let r = await tick('record')
  ok('a running tick holds the lock: the next one exits 0', r.code === 0, r)
  ok('a running tick holds the lock: the engine never starts', runs().length === 0, runs())
  ok('the lock it found is left alone', existsSync(lockFile) && JSON.parse(readFileSync(lockFile, 'utf8')).pid === process.pid)

  // 2. A lock whose owner is gone, and one held for over three hours, do not block.
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid
  writeFileSync(lockFile, JSON.stringify({ pid: dead, at: Date.now() }))
  r = await tick('record')
  ok("a dead tick's lock is taken over", runs().length === 1, runs())
  ok('the lock is held while the engine runs', runs()[0]?.lock?.pid === runs()[0]?.ppid, runs()[0])
  ok('the lock is gone when the tick ends', !existsSync(lockFile))
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() - 4 * 3600_000 }))
  r = await tick('record')
  ok('a lock over three hours old is taken over', runs().length === 1, runs())
  rmSync(lockFile, { force: true })

  // 3. git under the retry gives up on a stalled download instead of hanging, never prompts,
  //    and a value somebody already set is kept.
  r = await tick('record')
  ok('git is told to give up below 1000 B/s for 15 s and never prompt', JSON.stringify(runs()[0]?.env) === JSON.stringify({ limit: '1000', time: '15', prompt: '0' }), runs()[0]?.env)
  r = await tick('record', { env: { GIT_HTTP_LOW_SPEED_TIME: '40' } })
  ok('a stall limit already set is kept', runs()[0]?.env?.time === '40', runs()[0]?.env)

  if (win) {
    // 4. A git call inside the retry times out: the git it leaves behind dies with the tick.
    const tag = `lanecron${process.pid}o`
    r = await tick('orphan', { tag })
    ok('the retry with a timed-out git ran to the end', runs().length === 1 && r.code === 0, { r, runs: runs() })
    const left = survivors(tag)
    ok('no git is left running after the tick', left.length === 0, left)
    reap(tag)

    // 5. The retry itself runs past its limit: it is killed together with what it started.
    const tag2 = `lanecron${process.pid}h`
    r = await tick('hang', { tag: tag2, env: { LANE_CRON_PER_REPO_MS: '3000' }, deadlineMs: 45_000 })
    ok('a retry past its limit is cut off', r.code === 0 && r.ms < 30_000, r)
    const left2 = survivors(tag2)
    ok('nothing it started is left running', left2.length === 0, left2)
    reap(tag2)
  } else {
    console.log('skip  orphan and limit checks (Windows only: the Git\\cmd launcher is what leaves the orphan)')
  }
} finally {
  for (const s of sockets) s.destroy()
  server.close()
  rmSync(root, { recursive: true, force: true })
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
