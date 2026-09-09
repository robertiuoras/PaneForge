// The lane LEDGER (`scripts/lane.mjs`, `<repo>/.git/paneforge-lanes.json`) seen from the
// app, for the two moments a pane's agent is not running but the pane is not gone:
// sleeping and waking.
//
// Contract (lane-split 2026-09-04, workstream "sleep keeps its lane"):
//   ledgerSleep(cwd, paneId)  - before the CLI is killed for a sleep: the hold this pane's
//                               chat has in the repo owning `cwd` is marked `asleep`, so
//                               the CLI's own SessionEnd hook parks it instead of releasing
//                               it, and the idle sweep leaves it alone.
//   ledgerWake(cwd, paneId)   - after the CLI is spawned again: the mark comes off.
//   ledgerClosed(cwd, paneId) - the pane is gone (closed by hand, by the idle clock, by
//                               reclaim): every hold it has is released, asleep or not - a
//                               sleeping pane runs no SessionEnd hook when it is closed, so
//                               without this its hold sat for the seven-day asleep limit.
//   ledgerTakenFolders(paneId) - folders the ledger says ANOTHER chat holds right now,
//                               handed to `laneFor` as extra taken folders on wake, so a
//                               pane never wakes into a checkout somebody else took.
// All three are best-effort, synchronous-safe from main, and never throw.
//
// Talks to the engine the same way `laneBoard.ts` does - `execFile` against
// `scripts/lane.mjs`, never blocking main - but resolves the repo root itself rather than
// importing `laneBoard.ts`'s own `mainCheckout`, which is a private helper there and not
// this file's to reach past (lane ownership for this workstream stops at this file).

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { laneEngine } from './laneBoard'

const TIMEOUT_MS = 10_000

/**
 * The main checkout above `dir` - where the shared `.git`, and so the lane ledger, lives.
 * Same algorithm as `laneBoard.ts`'s private `mainCheckout`: a lane is a worktree, whose
 * `.git` is a FILE pointing at `<main>/.git/worktrees/<name>`, so a pane sitting in one
 * still answers `<main>`. No `git` spawn - this reads a couple of files at most.
 */
function mainCheckoutOf(dir: string): string | null {
  let at = resolve(dir)
  for (;;) {
    const dot = join(at, '.git')
    try {
      if (existsSync(dot)) {
        if (statSync(dot).isDirectory()) return at
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, 'utf8'))
        if (!m) return null
        return dirname(dirname(dirname(resolve(at, m[1].trim()))))
      }
    } catch {
      return null
    }
    const up = dirname(at)
    if (up === at) return null
    at = up
  }
}

/** Where a lane's checkout lives, the same shape `laneDir` in `scripts/lane.mjs` builds. */
function laneDirOf(main: string, laneId: string): string {
  return laneId === 'main' ? main : join(dirname(main), `${basename(main)}-${laneId}`)
}

/** Every repo on this machine with a lane ledger - same roots `laneBoard.ts` scans. */
function projectRoots(): string[] {
  return process.platform === 'darwin'
    ? [join(homedir(), 'Projects')]
    : [join(homedir(), 'Desktop', 'Projects'), join(homedir(), 'Projects')]
}

/**
 * ...cached for a beat. Every call reads a whole projects folder and asks each name
 * whether it has a ledger - 40-odd sync fs calls on this machine - and it is asked once
 * per pane in a batch, from main, while somebody waits for a pane to appear. Repos do not
 * come and go inside five seconds.
 */
let repoCache: { at: number; repos: string[] } | null = null
const REPOS_FRESH_MS = 5_000

function ledgerRepos(): string[] {
  const now = Date.now()
  if (repoCache && now - repoCache.at < REPOS_FRESH_MS) return repoCache.repos
  const repos = scanLedgerRepos()
  repoCache = { at: now, repos }
  return repos
}

function scanLedgerRepos(): string[] {
  const found: string[] = []
  for (const root of projectRoots()) {
    let names: string[] = []
    try {
      names = readdirSync(root)
    } catch {
      continue
    }
    for (const n of names) {
      const main = join(root, n)
      if (existsSync(join(main, '.git', 'paneforge-lanes.json'))) found.push(main)
    }
  }
  return found
}

function run(main: string, args: string[]): void {
  const engine = laneEngine(main)
  if (!engine) return
  execFile(
    process.execPath,
    [engine, ...args, '--repo', main],
    { cwd: main, windowsHide: true, timeout: TIMEOUT_MS, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
    (err) => {
      if (err) console.error(`laneLedger: ${args[0]} in ${basename(main)} failed - ${err.message}`)
    }
  )
}

export function ledgerSleep(cwd: string, paneId: string): void {
  try {
    const main = mainCheckoutOf(cwd)
    if (main) run(main, ['sleep', '--pane', paneId])
  } catch {
    /* best-effort: a sleep that cannot reach the ledger still sleeps the pane */
  }
}

export function ledgerWake(cwd: string, paneId: string): void {
  try {
    const main = mainCheckoutOf(cwd)
    if (main) run(main, ['wake', '--pane', paneId])
  } catch {
    /* best-effort: a wake that cannot reach the ledger still wakes the pane */
  }
}

export function ledgerClosed(cwd: string, paneId: string): void {
  try {
    const main = mainCheckoutOf(cwd)
    if (main) run(main, ['closed', '--pane', paneId])
  } catch {
    /* best-effort: a close that cannot reach the ledger still closes the pane */
  }
}

export function ledgerTakenFolders(paneId: string): string[] {
  try {
    const out: string[] = []
    for (const main of ledgerRepos()) {
      let state: { lanes?: Record<string, { pane?: string }> }
      try {
        state = JSON.parse(readFileSync(join(main, '.git', 'paneforge-lanes.json'), 'utf8'))
      } catch {
        continue
      }
      for (const [id, c] of Object.entries(state.lanes ?? {})) {
        if (c.pane && c.pane !== paneId) out.push(laneDirOf(main, id))
      }
    }
    return out
  } catch {
    return []
  }
}
