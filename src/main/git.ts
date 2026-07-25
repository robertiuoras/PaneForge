// Branch + dirty state for a session's folder. This is the one piece of repo context
// worth showing next to a running agent: it answers "which branch is this agent about
// to commit on, and has it changed anything yet" without leaving the app.
//
// One `git status` per folder answers all of it, and results are cached briefly so a
// grid of panes polling at the same time costs one process, not one each.

import { spawnSync } from 'node:child_process'
import type { GitInfo } from '../shared/types'

const TTL = 2500
const cache = new Map<string, { at: number; info: GitInfo | null }>()

export function gitInfo(cwd: string): GitInfo | null {
  const hit = cache.get(cwd)
  const now = Date.now()
  if (hit && now - hit.at < TTL) return hit.info

  const info = read(cwd)
  cache.set(cwd, { at: now, info })
  return info
}

function read(cwd: string): GitInfo | null {
  let out: string
  try {
    const r = spawnSync('git', ['status', '--porcelain=v1', '--branch', '--untracked-files=all'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000
    })
    if (r.status !== 0 || !r.stdout) return null
    out = r.stdout
  } catch {
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
