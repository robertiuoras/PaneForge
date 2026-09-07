// Reading the checkout at both ends of a turn, so `shared/changedNothing.ts` can compare
// them.
//
// Why this does not reuse `main/git.ts`. That file already runs a `git status` per folder
// and already counts dirty files, so "no files changed" looks like `dirty === 0` read at
// the end of the turn. It is not, in both directions:
//
//   - a pane working in a folder that was ALREADY dirty when the turn started reads
//     `dirty > 0` at the end and would never be chipped, however little it did;
//   - a pane that made a real change and committed it reads `dirty === 0` and would be
//     chipped for work that landed.
//
// The question is not "is this folder clean", it is "is this folder the same as it was
// half an hour ago", and only two readings can answer that. So the reading here is the
// working tree AND the commit it sits on, taken twice.
//
// Everything else is borrowed from `main/git.ts`'s hard-won shape: `execFile`, never
// `spawnSync`, because this runs in the process that owns the window's message loop and a
// status on a big tree is tens to hundreds of milliseconds - that is the Windows busy
// cursor the badge was reported for. A timeout, because a status against a network folder
// can hang. And a failure comes back `undefined`, never an empty reading that would
// compare equal to another failure and chip the pane on two errors agreeing.
//
// Rate: this is not a poller. It runs exactly twice per turn, on the turn's own
// boundaries, so a desk of eight panes costs two `git status` calls per turn rather than
// one every six seconds.

import { execFile } from 'node:child_process'
import type { Shot } from '../shared/changedNothing'

/** Long enough for a cold status on a large tree, short enough not to outlive the turn. */
const TIMEOUT_MS = 4000

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout)
    )
  })
}

/**
 * One reading of a folder: the commit it is on, plus every file git would report.
 *
 * `--untracked-files=all` matters more here than it does for the badge. A turn whose only
 * product is a new file inside a new folder shows up as one line under `normal`, and as
 * every file under `all` - but the failure this whole feature is about is a turn that
 * produced NOTHING, and for that the difference is between two readings that agree and
 * two that do not. `all` is the reading that cannot miss a new file.
 *
 * `undefined` means the reading failed - not a repo, git missing, a status that timed
 * out - and nothing above may turn that into "nothing changed".
 */
export async function workShot(cwd: string | undefined): Promise<Shot | undefined> {
  if (!cwd) return undefined
  const head = await git(cwd, ['rev-parse', 'HEAD'])
  if (head === null) return undefined
  const status = await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (status === null) return undefined
  // The commit first, so a turn that only committed - clean tree at both ends, different
  // HEAD - is a turn that changed something.
  return `${head.trim()}\n${status}`
}
