// Run the lane retry for every project on this machine, on a clock the app is not part of.
//
// Why this exists. `lane.mjs retry` is the sweep that unsticks everything: it re-tries
// conflicts that have stopped being conflicts, marks orphaned lanes ready, clears a release
// lock left by a killed chat, and calls autoship so work that arrived during the release
// cooldown actually goes out. Every six hours it also starts `lane.mjs sweep`, which
// removes checkout folders nobody has used (their work saved first) - see lane.mjs. Until now the only clock driving it was a setInterval inside
// the Electron app (src/main/index.ts). That has two holes, both measured on 2026-08-01:
//
//   - PaneForge closed means no retry at all. The retry log has a gap from 00:33 to 08:29
//     UTC, during which a stale release lock and a tagged-but-unpushed v0.4.14 sat for
//     about eight hours. Anything blocked by the cooldown strands overnight the same way.
//   - Even with the app open, Windows throttles background timers. The cadence in that same
//     log degraded from 2 minutes to 47 minutes to 8 hours before going silent entirely.
//
// And it only ever retried PaneForge - `laneRetry()` drives the board's own repo - while
// lanes now run in every project on the machine.
//
// So: one scheduled task, no app, no AI, no window. It walks the registry the prompt hook
// keeps (~/.claude/lane-repos.json, one entry per project that has ever used lanes) and
// runs the retry in each. Silence is the normal outcome; anything a repo actually says is
// appended to that repo's own .git/paneforge-lane-retry.log, the same file and the same
// format the app writes, so the two clocks read as one history.
//
//   node scripts/lane-cron.mjs [--repo <dir>] [--quiet]
//
// Install (Windows, every 10 minutes):
//   schtasks /Create /TN PaneForgeLaneRetry /SC MINUTE /MO 10 /F ^
//     /TR "node <this file>"
//
// One tick at a time, and nothing left behind (measured on the PC 2026-10-09). The task runs
// through a VBS shim that does not wait, so Task Scheduler never sees a tick still running
// and starts the next one beside it: 63 ticks that day, 8 longer than 10 minutes, up to 4 at
// once. And on Windows the `git` on PATH is Git\cmd\git.exe, a launcher: when lane.mjs's
// 20-second git timeout kills it, the git under it (`git remote-https` and its download)
// loses its parent and keeps running, so the next tick fetched the same repo again beside
// it - 2,757 `git fetch --tags` starts in thirteen hours, minutes with 400+ git starts, and
// hooks timing out in those minutes. So a tick takes a lock and leaves quietly when another
// holds it, tells git to give up on a stalled download, kills a retry that overruns
// together with everything under it, and after a slow retry kills any read-only git that
// lost its parent while it ran. scripts/lane-cron-test.mjs proves each.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const argOf = (name) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const quiet = argv.includes('--quiet')
const REGISTRY = process.env.LANE_REGISTRY || join(homedir(), '.claude', 'lane-repos.json')

/** How long one repo's retry may take before it is killed and the next one is tried. */
const PER_REPO_MS = Number(process.env.LANE_CRON_PER_REPO_MS) || 4 * 60 * 1000
/** Enough retry log to see a pattern, small enough to never be a problem. Matches laneBoard.ts. */
const RETRY_LOG_MAX = 64 * 1024

/**
 * Every project that has ever used lanes, as the prompt hook recorded it.
 *
 * The registry is the right list rather than "every folder under Projects": it is written by
 * the hook the moment a chat is given a lane anywhere, it already knows which repos opted
 * out, and it cannot wander into somebody's unrelated git checkout. PaneForge itself is
 * added regardless - this script ships inside it, so it is always a repo worth sweeping,
 * and it is the one whose releases everything else waits on.
 */
function repos() {
  const asked = argOf('repo')
  if (asked) return [mainOf(asked) ?? asked]
  const found = new Set([join(here, '..')])
  try {
    for (const dir of Object.keys(JSON.parse(readFileSync(REGISTRY, 'utf8')).repos ?? {})) found.add(dir)
  } catch {
    /* no registry: lanes have never run here, and PaneForge alone is the whole list */
  }
  // Deduped by MAIN checkout, not by the path that led here. This script ships inside
  // PaneForge, so on a machine where a chat is working in PaneForge-a it is running FROM a
  // lane - and sweeping `PaneForge-a` and `PaneForge` separately is the same repo twice,
  // with two log lines saying the same thing.
  const mains = new Set()
  for (const dir of found) {
    const main = mainOf(dir)
    if (main) mains.add(main)
  }
  return [...mains]
}

/** The main checkout of whatever `dir` is part of, or null when it is not a git repo. */
function mainOf(dir) {
  if (!existsSync(dir)) return null
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true
  })
  if (r.status !== 0 || !r.stdout?.trim()) return null
  return dirname(r.stdout.trim())
}

/** One line per thing the retry actually said, in that repo's own .git. Matches laneBoard.ts. */
function note(repo, said) {
  const text = said.trim()
  if (!text) return
  const file = join(repo, '.git', 'paneforge-lane-retry.log')
  try {
    let prev = ''
    try {
      prev = readFileSync(file, 'utf8')
    } catch {
      /* first line */
    }
    // `[cron]` so a gap in this file can be read for what it is - the app being closed, or
    // the scheduled task not running - rather than as "nothing was stuck".
    const next = `${prev}${new Date().toISOString()} [cron] ${text.replace(/\s*\n\s*/g, ' | ')}\n`
    writeFileSync(file, next.length > RETRY_LOG_MAX ? next.slice(-RETRY_LOG_MAX) : next, 'utf8')
  } catch {
    /* a log we cannot write is not worth losing the retry over */
  }
}

/** Next to the registry, so a test that points LANE_REGISTRY elsewhere gets its own lock. */
const LOCK = join(dirname(REGISTRY), 'lane-cron.lock')
/** A tick that has held the lock this long is wedged, not working: the longest seen was 33 minutes. */
const LOCK_STALE_MS = 3 * 60 * 60 * 1000

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/**
 * True when this tick may run. False when another tick is running: the clock fires again in
 * ten minutes, so stepping aside loses nothing, and running beside it is what piled git up.
 */
function takeLock() {
  try {
    mkdirSync(dirname(LOCK), { recursive: true })
  } catch {
    /* the write below says whether it matters */
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' })
      return true
    } catch (e) {
      // A lock we cannot write at all must not stop the sweep for good.
      if (e.code !== 'EEXIST') return true
    }
    let held = null
    try {
      held = JSON.parse(readFileSync(LOCK, 'utf8'))
    } catch {
      // Unreadable: half-written by a tick starting this instant, or left broken.
      try {
        if (Date.now() - statSync(LOCK).mtimeMs < 60_000) return false
      } catch {
        continue
      }
    }
    if (held && alive(held.pid) && Date.now() - held.at < LOCK_STALE_MS) return false
    try {
      unlinkSync(LOCK)
    } catch {
      /* somebody else cleared it first; the next attempt finds out who holds it now */
    }
  }
  return false
}

function dropLock() {
  try {
    if (JSON.parse(readFileSync(LOCK, 'utf8')).pid === process.pid) unlinkSync(LOCK)
  } catch {
    /* not ours, or already gone */
  }
}

/**
 * git under the retry gives up on a download that has stalled (under 1000 B/s for 15 s)
 * instead of sitting on it until lane.mjs's timeout orphans it, and never waits on a
 * password prompt nobody will see. A value already set by whoever started us wins.
 */
const gitEnv = {
  GIT_HTTP_LOW_SPEED_LIMIT: '1000',
  GIT_HTTP_LOW_SPEED_TIME: '15',
  GIT_TERMINAL_PROMPT: '0',
  ...process.env
}

/** Kill `child` and everything under it. taskkill /T walks the tree only from a live root. */
function killTree(child) {
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 30_000 })
    if (r.status === 0) return
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
}

/** One repo's `lane.mjs retry`: what it said, and when it started. */
function retry(repo) {
  return new Promise((resolve) => {
    const started = Date.now()
    let out = ''
    let err = ''
    let done = false
    let limit
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(limit)
      resolve({ said: `${out}${err}`.trim(), started })
    }
    const child = spawn(process.execPath, [join(here, 'lane.mjs'), 'retry', '--repo', repo, '--session', 'lane-cron'], {
      cwd: repo,
      env: gitEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d))
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d))
    limit = setTimeout(() => killTree(child), PER_REPO_MS)
    child.on('error', finish)
    child.on('close', finish)
    // Something it started may still hold its output open; its exit is the end of the retry.
    child.on('exit', () => setTimeout(finish, 2000).unref())
  })
}

/**
 * git commands that only read, so killing one mid-way loses nothing. Not `status`: it can
 * refresh the index and leave index.lock behind.
 */
const READ_ONLY = new Set(
  'fetch ls-remote remote-https remote-http fetch-pack index-pack rev-list rev-parse cat-file ls-files ls-tree for-each-ref show-ref log show diff merge-base cherry describe'.split(' ')
)
/** Options before the verb that take the next word as their value. */
const TAKES_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path'])

/** The git subcommand a Windows command line runs, or '' when it cannot be told. */
function gitVerb(name, cmd) {
  const remote = /^git-(remote-https?)\.exe$/i.exec(name)
  if (remote) return remote[1].toLowerCase()
  const words = [...String(cmd ?? '').matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]).slice(1)
  for (let i = 0; i < words.length; i++) {
    if (TAKES_VALUE.has(words[i])) i++
    else if (!words[i].startsWith('-')) return words[i]
  }
  return ''
}

/**
 * Windows: kill the read-only git that lost its parent while a retry ran. The launcher on
 * PATH is what lane.mjs's timeout kills; the git under it lives on. Only processes born
 * since `since`, whose parent is gone or is a newer process wearing a reused pid, and only
 * read-only verbs - an orphaned commit or merge is left alone (orphan-reaper-win.mjs in
 * claude-config handles long-dead ones). Returns how many it killed.
 */
function reapOrphanGit(since) {
  const ps = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | % { [pscustomobject]@{ p = $_.ProcessId; pp = $_.ParentProcessId; n = $_.Name; c = $_.CommandLine; ' +
        't = $(if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }) } } | ConvertTo-Json -Compress'
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }
  )
  let procs
  try {
    procs = [].concat(JSON.parse(ps.stdout))
  } catch {
    return 0
  }
  const born = new Map(procs.map((p) => [p.p, p.t]))
  let killed = 0
  for (const p of procs) {
    if (!/^git(-remote-https?)?\.exe$/i.test(p.n ?? '') || p.t < since - 1000) continue
    const parentBorn = born.get(p.pp)
    if (parentBorn !== undefined && parentBorn <= p.t) continue
    if (!READ_ONLY.has(gitVerb(p.n, p.c))) continue
    const r = spawnSync('taskkill', ['/PID', String(p.p), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 30_000 })
    if (r.status === 0) killed++
  }
  return killed
}

/** A retry this slow may have hit lane.mjs's git timeout; a quick one cannot have. */
const SLOW_RETRY_MS = 15_000

if (!takeLock()) {
  if (!quiet) console.log('Another lane sweep is still running - leaving it to finish.')
  process.exit(0)
}
process.on('exit', dropLock)

let spoke = 0
for (const repo of repos()) {
  const { said, started } = await retry(repo)
  if (process.platform === 'win32' && Date.now() - started >= SLOW_RETRY_MS) {
    const killed = reapOrphanGit(started)
    if (killed) note(repo, `killed ${killed} read-only git left running without a parent`)
  }
  if (!said) continue
  spoke++
  note(repo, said)
  if (!quiet) console.log(`${repo}: ${said.replace(/\s*\n\s*/g, ' | ')}`)
}

// A sweep where every repo was quiet is the normal outcome and says so once, so a person
// running this by hand can tell "nothing to do" from "it did not run".
if (!quiet && !spoke) console.log('Every project is quiet - nothing stuck, nothing waiting to go out.')
