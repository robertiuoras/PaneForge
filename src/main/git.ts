// Branch + dirty state for a session's folder. This is the one piece of repo context
// worth showing next to a running agent: it answers "which branch is this agent about
// to commit on, and has it changed anything yet" without leaving the app.
//
// One `git status` per folder answers all of it, and results are cached briefly so a
// grid of panes polling at the same time costs one process, not one each.

import { gitRun } from './gitRun'
import type { GitInfo } from '../shared/types'

const TTL = 6000
/**
 * How long a folder nothing is happening in keeps its answer.
 *
 * The badge polls every six seconds per pane and each miss is a real `git status` against
 * a real working tree - measured at 30ms to several hundred on a big repo. But the only
 * thing that changes a working tree is an agent editing it, and a pane sitting idle with
 * an unchanged repo answered the same thing ten polls running. So: full rate while the
 * agent in that folder is working or while the answer is still moving, and a slow tick
 * once two polls in a row have said exactly the same thing about a folder nobody is
 * touching. A change anywhere puts it straight back to six seconds.
 */
const IDLE_TTL = 30_000
/** Identical answers in a row before the folder is treated as settled. */
const SETTLED_AFTER = 2

interface Entry {
  at: number
  /** When the read that answered was STARTED - what the folder looked like as of then. */
  from: number
  info: GitInfo | null
  /** The read did not answer (timeout, git refusing): `null` here is not "not a repo". */
  failed: boolean
  /** consecutive reads that came back identical */
  same: number
}
const cache = new Map<string, Entry>()
// One `git status` in flight per folder. Without this a grid of panes whose polls
// drift into the same tick each start their own process against the same repo.
const inFlight = new Map<string, Promise<GitInfo | null>>()

/**
 * `busy` is "an agent is working in this folder right now" - the only case where the
 * answer is expected to change under us, and the case that keeps the fast tick.
 */
export async function gitInfo(cwd: string, busy = false): Promise<GitInfo | null> {
  const hit = cache.get(cwd)
  const now = Date.now()
  const ttl = !busy && hit && hit.same >= SETTLED_AFTER ? IDLE_TTL : TTL
  if (hit && now - hit.at < ttl) return hit.info

  const running = inFlight.get(cwd)
  if (running) return running

  const from = Date.now()
  const job = read(cwd)
    .then((got) => {
      const failed = got === FAILED
      const info = failed ? null : got
      const prev = cache.get(cwd)
      // A failed read is never "settled": the next poll tries again at the fast rate.
      const same = !failed && prev && !prev.failed && identical(prev.info, info) ? prev.same + 1 : 0
      cache.set(cwd, { at: Date.now(), from, info, failed, same })
      return info
    })
    .finally(() => inFlight.delete(cwd))
  inFlight.set(cwd, job)
  return job
}

/** How old a cached answer `gitCached` still trusts. */
const CACHED_TRUST_MS = 60_000

/**
 * The cached answer for a folder, without waiting: a read no older than a minute, or
 * `'unread'` after starting one in the background for the next ask. For the finished-pane
 * close (`main/doneClose.ts`), which runs every fifteen seconds over the whole desk and
 * must never spawn a `git status` per pane per sweep - the badge already reads each
 * visible pane's folder, and one miss here costs at most one shared read.
 *
 * `since` is when the pane's turn ended: a read started before it may predate the agent's
 * last edit and say "clean" about a folder that is not, so it counts as unread. So does a
 * read that failed - a status that timed out is not a folder with nothing in it.
 */
export function gitCached(cwd: string, since = 0, now = Date.now()): GitInfo | null | 'unread' {
  const hit = cache.get(cwd)
  if (hit && !hit.failed && hit.from >= since && now - hit.at <= CACHED_TRUST_MS) return hit.info
  void gitInfo(cwd).catch(() => undefined)
  return 'unread'
}

/** Same branch, same counts: nothing a badge would have redrawn. */
function identical(a: GitInfo | null, b: GitInfo | null): boolean {
  if (!a || !b) return a === b
  return (
    a.branch === b.branch &&
    a.dirty === b.dirty &&
    a.staged === b.staged &&
    a.ahead === b.ahead &&
    a.behind === b.behind
  )
}

/**
 * Deliberately async.
 *
 * This used to be spawnSync, which blocks the Electron MAIN process - the process that
 * owns the window's message loop. A status on a large working tree takes anywhere from
 * 30ms to several hundred, it ran once every few seconds for every visible pane, and
 * Windows answers a message loop that stops answering by swapping the pointer for the
 * busy cursor. That is the "hourglass sticks near the edge of the pane until I move the
 * mouse" the app was reported for. Nothing here is on a critical path, so it waits.
 */
/** A read that did not answer: timed out, git would not start, or refused for a reason other than "not a repo". */
const FAILED = Symbol('git read failed')

async function read(cwd: string): Promise<GitInfo | null | typeof FAILED> {
  // Through the one gate (`gitRun.ts`): the badge polls every pane, and a desk of sixteen
  // panes across a dozen checkouts is the largest steady source of git in the app.
  const r = await gitRun(cwd, ['status', '--porcelain=v1', '--branch', '--untracked-files=all'], {
    timeout: 4000,
    maxBuffer: 4 * 1024 * 1024,
    read: true
  })
  // Not a repo is an answer (null); a timeout, a missing git or a refused folder is not.
  if (!r.ok) return /not a git repository/i.test(r.stderr) ? null : FAILED
  const out = r.stdout
  if (!out) return null

  const lines = out.split(/\r?\n/).filter(Boolean)
  // First line is always `## <branch>...<upstream> [ahead N, behind M]`, or
  // `## HEAD (no branch)` on a detached checkout.
  const head = lines[0]?.startsWith('##') ? lines[0].slice(3) : ''
  const branch = head.split('...')[0].split(' ')[0] || 'HEAD'
  let ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0)
  const behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0)
  const detached = head.startsWith('HEAD (')
  // No upstream (`## lane-a`) or one that is gone: `ahead` above reads 0 for commits that
  // were never pushed anywhere. Count what no remote has - the finished-pane close holds a
  // folder with work only this machine has, and the badge's "N to push" is then true too.
  if (!detached && (!head.includes('...') || head.includes('[gone]')) && !/^(No commits yet|Initial commit) on /.test(head)) {
    const u = await gitRun(cwd, ['rev-list', '--count', 'HEAD', '--not', '--remotes'], { timeout: 4000, read: true })
    if (!u.ok) return FAILED
    ahead = Number(u.stdout.trim()) || 0
  }

  let dirty = 0
  let staged = 0
  for (const line of lines.slice(1)) {
    dirty++
    // Column 1 is the index status: anything but space or ? means it is staged.
    if (line[0] !== ' ' && line[0] !== '?') staged++
  }

  return { branch, ahead, behind, dirty, staged, detached }
}
