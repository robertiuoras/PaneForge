// Branch + dirty state for a session's folder. This is the one piece of repo context
// worth showing next to a running agent: it answers "which branch is this agent about
// to commit on, and has it changed anything yet" without leaving the app.
//
// One `git status` per folder answers all of it, and results are cached briefly so a
// grid of panes polling at the same time costs one process, not one each.

import { execFile } from 'node:child_process'
import type { GitInfo } from '../shared/types'

const TTL = 6000
const cache = new Map<string, { at: number; info: GitInfo | null }>()
// One `git status` in flight per folder. Without this a grid of panes whose polls
// drift into the same tick each start their own process against the same repo.
const inFlight = new Map<string, Promise<GitInfo | null>>()

export async function gitInfo(cwd: string): Promise<GitInfo | null> {
  const hit = cache.get(cwd)
  const now = Date.now()
  if (hit && now - hit.at < TTL) return hit.info

  const running = inFlight.get(cwd)
  if (running) return running

  const job = read(cwd)
    .then((info) => {
      cache.set(cwd, { at: Date.now(), info })
      return info
    })
    .finally(() => inFlight.delete(cwd))
  inFlight.set(cwd, job)
  return job
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
