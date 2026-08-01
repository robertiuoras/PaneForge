// Run the lane retry for every project on this machine, on a clock the app is not part of.
//
// Why this exists. `lane.mjs retry` is the sweep that unsticks everything: it re-tries
// conflicts that have stopped being conflicts, marks orphaned lanes ready, clears a release
// lock left by a killed chat, and calls autoship so work that arrived during the release
// cooldown actually goes out. Until now the only clock driving it was a setInterval inside
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

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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

/** How long one repo's retry may take before it is abandoned and the next one is tried. */
const PER_REPO_MS = 4 * 60 * 1000
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
  const file = process.env.LANE_REGISTRY || join(homedir(), '.claude', 'lane-repos.json')
  try {
    for (const dir of Object.keys(JSON.parse(readFileSync(file, 'utf8')).repos ?? {})) found.add(dir)
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

let spoke = 0
for (const repo of repos()) {
  const r = spawnSync(
    process.execPath,
    [join(here, 'lane.mjs'), 'retry', '--repo', repo, '--session', 'lane-cron'],
    { cwd: repo, encoding: 'utf8', timeout: PER_REPO_MS, killSignal: 'SIGKILL', windowsHide: true }
  )
  const said = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  if (!said) continue
  spoke++
  note(repo, said)
  if (!quiet) console.log(`${repo}: ${said.replace(/\s*\n\s*/g, ' | ')}`)
}

// A sweep where every repo was quiet is the normal outcome and says so once, so a person
// running this by hand can tell "nothing to do" from "it did not run".
if (!quiet && !spoke) console.log('Every project is quiet - nothing stuck, nothing waiting to go out.')
