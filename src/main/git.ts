// Branch + dirty state for a session's folder. This is the one piece of repo context
// worth showing next to a running agent: it answers "which branch is this agent about
// to commit on, and has it changed anything yet" without leaving the app.
//
// One `git status` per folder answers all of it, and results are cached briefly so a
// grid of panes polling at the same time costs one process, not one each.

import { execFile } from 'node:child_process'
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
  info: GitInfo | null
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

  const job = read(cwd)
    .then((info) => {
      const prev = cache.get(cwd)
      const same = prev && identical(prev.info, info) ? prev.same + 1 : 0
      cache.set(cwd, { at: Date.now(), info, same })
      return info
    })
    .finally(() => inFlight.delete(cwd))
  inFlight.set(cwd, job)
  return job
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
async function read(cwd: string): Promise<GitInfo | null> {
  let out: string
  try {
    out = await new Promise<string>((resolve, reject) => {
      execFile(
        'git',
        ['status', '--porcelain=v1', '--branch', '--untracked-files=all'],
        { cwd, encoding: 'utf8', windowsHide: true, timeout: 4000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout))
      )
    })
    if (!out) return null
  } catch {
    // Not a repo, git missing, or a status slow enough to hit the timeout.
    return null
  }

  const lines = out.split(/\r?\n/).filter(Boolean)
  // First line is always `## <branch>...<upstream> [ahead N, behind M]`, or
  // `## HEAD (no branch)` on a detached checkout.
  const head = lines[0]?.startsWith('##') ? lines[0].slice(3) : ''
  const branch = head.split('...')[0].split(' ')[0] || 'HEAD'
  const ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0)
  const behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0)

  let dirty = 0
  let staged = 0
  for (const line of lines.slice(1)) {
    dirty++
    // Column 1 is the index status: anything but space or ? means it is staged.
    if (line[0] !== ' ' && line[0] !== '?') staged++
  }

  return { branch, ahead, behind, dirty, staged, detached: head.startsWith('HEAD (') }
}
