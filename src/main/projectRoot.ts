// Which folder does "open the folder" mean for a pane running in a lane?
//
// A lane is a git WORKTREE - a second checkout of the same repository, made by the app
// (`<repo>-a`) or by an agent's own tooling (`worktree-<slug>`). It is scratch: its
// branch is merged back and its untracked files are nobody's, so a file dropped into it
// is a file that gets swept. The project - the thing somebody means when they press a
// folder button to put something somewhere - is the trunk checkout.
//
// The answer is read from git, never from the folder NAME. `service-a` is a real project
// on this machine and stripping its suffix would open a folder that does not exist, or
// worse, a different project's; and a name rule cannot see `worktree-<slug>` at all.
// `--git-common-dir` is the `.git` shared by every checkout of a repository, so for a
// worktree it points OUT of the folder being asked about and its parent is the trunk.

import { execFile } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { copySuffixOf } from '../shared/place'

/** How long one folder keeps its answer. A checkout does not become a worktree. */
const TTL = 60_000
/** A git call on a button press: long enough to answer, short enough not to hang a click. */
const TIMEOUT = 4000

const cache = new Map<string, { at: number; root: string }>()

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile('git', ['-C', cwd, ...args], { timeout: TIMEOUT }, (err, out) =>
      done(err ? null : String(out).trim())
    )
  })
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * The trunk checkout of the repository `cwd` belongs to, or `cwd` itself.
 *
 * Never throws and never returns a folder that is not there: everything that is not a
 * worktree of a real repository - a plain checkout, a folder with no git in it, a git
 * that will not answer - falls through to the path it was handed, which is exactly the
 * behaviour this had before.
 */
export async function projectRoot(cwd: string): Promise<string> {
  if (!cwd) return cwd
  const hit = cache.get(cwd)
  if (hit && Date.now() - hit.at < TTL) return hit.root

  // git first, always - it is the only reading that can see `worktree-<slug>`, and the
  // only one that knows `service-a` is a project rather than a copy of `service`. The name
  // is the FALLBACK, for the times git cannot be asked at all: no git on PATH, a call that
  // timed out on a cold disk, a folder whose worktree registration was pruned. Without it
  // those all quietly answered "this folder", which is the copy - the one folder this
  // button exists to keep people out of.
  const read1 = await read(cwd)
  const root = read1 === cwd ? (trunkBeside(cwd) ?? cwd) : read1
  cache.set(cwd, { at: Date.now(), root })
  return root
}

async function read(cwd: string): Promise<string> {
  // Absolute on both sides or the comparison below is a path-format bug, not a reading.
  const common = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common) return cwd
  const top = await git(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel'])
  if (!top) return cwd

  const trunk = dirname(resolve(common))
  // A trunk checkout's own common dir is `<top>/.git`, so this says "same folder" and the
  // fall-through below returns it unchanged. Only a worktree points somewhere else.
  if (resolve(trunk) === resolve(top)) return cwd
  // A bare repository has no working tree to open, and a worktree of one resolves to the
  // bare `.git` folder's parent - which may hold nothing anybody wants to look at.
  if (!isDir(trunk) || !isDir(resolve(trunk, '.git'))) return cwd
  return trunk
}

/**
 * The project folder a COPY sits beside, proved off the disk rather than off the name.
 *
 * `place.ts` names the copy shapes (`-a`, legacy `-w2`) and refuses to guess beyond them,
 * because `service-a` is a legitimate project. The second leg is the one that decides:
 * a sibling folder by the un-suffixed name that is really a git repository. That is the
 * same two-legged test `ensureLaneFolder` and `detectLane` make before touching a folder.
 *
 * Null for everything else, so every caller falls through to the path it was handed.
 */
export function trunkBeside(dir: string): string | null {
  const project = copySuffixOf(basename(dir))
  if (!project) return null
  const trunk = join(dirname(dir), project)
  return existsSync(join(trunk, '.git')) ? trunk : null
}
