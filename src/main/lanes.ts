// Two agents in one folder is the one setup that reliably breaks: they clobber
// each other's edits, race the git index, and fight over the dev server port. A
// git worktree gives each session its own checkout and its own branch off the
// same repo, so "open a second session here" stops being a trap.
//
// This runs on the way in to a session start: the second session in a folder is
// moved into `<repo>-w2` without being asked, the third into `-w3`, and so on.
// Nothing is ever moved out of the original folder - the first session keeps it.

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'

/** Highest lane number offered. Past this the folder is genuinely oversubscribed. */
const MAX_LANES = 9

export interface Lane {
  /** folder the session should actually start in */
  cwd: string
  /** lane label ("w2") when the session was moved, undefined when it was not */
  lane?: string
  /** branch checked out in the lane, for the message shown to the user */
  branch?: string
  /** why no lane was made, when one was wanted - shown once, never fatal */
  note?: string
}

function git(cwd: string, args: string[], timeout = 15000): { ok: boolean; out: string } {
  try {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout })
    return { ok: r.status === 0, out: (r.stdout ?? '').trim() || (r.stderr ?? '').trim() }
  } catch {
    return { ok: false, out: '' }
  }
}

/** Windows paths differ in case and slash direction for the same folder. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * The repo a folder belongs to, following a worktree back to its main checkout.
 * `--git-common-dir` is the shared `.git` of the whole repo, so a lane asked to
 * spawn another lane still branches off the original, not off itself.
 */
function mainRepo(cwd: string): string | null {
  const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common.ok || !common.out) return null
  const dir = common.out.split(/\r?\n/)[0]
  // `<repo>/.git` normally; a bare or unusual layout is left alone.
  if (!/[\\/]\.git$/.test(dir)) return null
  const root = dirname(dir)
  return existsSync(root) ? root : null
}

/** Is this folder already a checkout of the same repo (ours to reuse)? */
function isWorktreeOf(candidate: string, repo: string): boolean {
  if (!existsSync(candidate)) return false
  const root = mainRepo(candidate)
  return Boolean(root && samePath(root, repo))
}

/**
 * Copy the files a fresh checkout cannot have: `.env` and friends are gitignored
 * by design, so a lane without them fails on the first run for reasons that look
 * nothing like "you are in a new folder". Root and one level down covers the
 * usual `backend/.env`, `mobile/.env` layout; nothing else is touched.
 */
function seedEnvFiles(repo: string, lane: string): void {
  const envish = (name: string): boolean => /^\.env(\.|$)/.test(name)
  const copy = (rel: string): void => {
    const from = join(repo, rel)
    const to = join(lane, rel)
    if (!existsSync(from) || existsSync(to)) return
    try {
      // The subfolder may not exist yet: a `backend/` that holds nothing but an
      // ignored .env is not in the checkout at all.
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
    } catch {
      /* locked or unreadable - the lane still works, it just needs its own copy */
    }
  }
  try {
    for (const e of readdirSync(repo, { withFileTypes: true })) {
      if (e.isFile() && envish(e.name)) copy(e.name)
      if (!e.isDirectory() || e.name === '.git' || e.name === 'node_modules') continue
      try {
        for (const f of readdirSync(join(repo, e.name), { withFileTypes: true })) {
          if (f.isFile() && envish(f.name)) copy(join(e.name, f.name))
        }
      } catch {
        /* unreadable subfolder */
      }
    }
  } catch {
    /* unreadable repo root - lane still usable */
  }
}

/**
 * Where a new session in `cwd` should really run, given the folders live sessions
 * already hold.
 *
 * Returns `cwd` unchanged when nothing else is using it, when it is not a git
 * repo (there is no safe way to split a plain folder), or when every lane is
 * taken. Creating a lane is a few git calls and only happens on the second and
 * later session in one repo, so the common launch pays nothing.
 */
export function resolveLane(cwd: string, taken: string[]): Lane {
  const clash = taken.some((t) => samePath(t, cwd))
  if (!clash) return { cwd }

  const repo = mainRepo(cwd)
  if (!repo) {
    return { cwd, note: 'Second session in the same folder - not a git repo, so both share it.' }
  }

  const parent = dirname(repo)
  const name = basename(repo)
  for (let i = 2; i <= MAX_LANES; i++) {
    const label = `w${i}`
    const path = join(parent, `${name}-${label}`)
    if (taken.some((t) => samePath(t, path))) continue

    const branch = `pf/${label}`
    if (existsSync(path)) {
      // Left behind by an earlier session and nobody is in it: reuse rather than
      // pile up folders. Anything at that path that is not this repo is skipped.
      if (!isWorktreeOf(path, repo)) continue
      seedEnvFiles(repo, path)
      const head = git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])
      return { cwd: path, lane: label, branch: head.ok ? head.out : branch }
    }

    // New branch off whatever the repo has checked out now. If the branch already
    // exists from a previous lane, check that out instead of failing.
    let made = git(repo, ['worktree', 'add', '-b', branch, path])
    if (!made.ok) made = git(repo, ['worktree', 'add', path, branch])
    if (!made.ok) {
      return { cwd, note: `Could not create a worktree lane: ${made.out.split('\n')[0]}` }
    }
    seedEnvFiles(repo, path)
    return { cwd: path, lane: label, branch }
  }

  return { cwd, note: `All ${MAX_LANES} lanes for ${name} are in use - this session shares the folder.` }
}

/**
 * Folders held by lanes that no longer have a session. Used to offer a tidy-up;
 * nothing is ever removed automatically, because a lane holds real work until it
 * is merged.
 */
export function laneFolders(repo: string): string[] {
  const list = git(repo, ['worktree', 'list', '--porcelain'])
  if (!list.ok) return []
  return list.out
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
    .filter((p) => !samePath(p, repo) && /-w\d$/.test(p))
}
