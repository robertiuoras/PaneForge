// What an agent has actually done to the repo.
//
// Until this file the app answered that with a NUMBER - `git.ts` counts changed paths and
// the pane badge prints it - and the lane chip then asked you to merge on the strength of
// it. "17 changed" and a merge button is not review; it is trust with a count on it, and
// with four agents running it is the single question the app was worst at answering.
//
// Three rules, all of them consequences of where this runs:
//
//   - **Read-only, always.** Nothing here writes the index, checks anything out, or takes
//     a lock. `git diff` and `git ls-files` against a working tree an agent is actively
//     typing into is safe; `git add -N` (the usual trick for diffing an untracked file)
//     is not, so an untracked file's patch is synthesised from its bytes instead.
//   - **Never blocks the window.** Same rule as git.ts and laneWork.ts, for the same
//     reason - `execFile`, never `spawnSync`, because the main process owns the window's
//     message loop and a slow git is how the busy cursor happens.
//   - **The file list and the patches are separate calls.** A 300-file diff is 300
//     patches nobody scrolled to; the list is cheap, and a patch is read when a file is
//     selected.
//
// The parsing half is in shared/patch.ts and is tested without Electron
// (scripts/diff-test.mjs).

import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { zSplit } from '../shared/patch'
import type { DiffFile, DiffPatch, DiffScope, DiffSet } from '../shared/types'
import { laneWork } from './laneWork'

/** More changed files than anyone reviews in a dialog; the rest are counted, not listed. */
const MAX_FILES = 500
/** One file's patch. A generated lockfile is megabytes and nobody reads it as a diff. */
const MAX_PATCH = 400 * 1024
/** An untracked file worth showing whole. Bigger than this is a blob, not a change. */
const MAX_UNTRACKED = 256 * 1024

interface Run {
  ok: boolean
  out: string
  /** git's output hit maxBuffer, so `out` is a prefix of the truth */
  clipped: boolean
}

function git(cwd: string, args: string[], max = 8 * 1024 * 1024, timeout = 20000): Promise<Run> {
  return new Promise((done) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: max },
      (err, stdout) => {
        const out = stdout ?? ''
        // ERR_CHILD_PROCESS_STDIO_MAXBUFFER is the one failure where the output is still
        // worth having: it means the diff was too big, not that git could not run.
        const clipped = Boolean(err) && out.length >= max - 1024
        done({ ok: !err || clipped, out, clipped })
      }
    )
  })
}

async function branchOf(cwd: string): Promise<string> {
  const r = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return r.ok ? r.out.trim() : ''
}

async function exists(cwd: string, ref: string): Promise<boolean> {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return r.ok && Boolean(r.out.trim())
}

/**
 * What "the base" means for this folder, in the order the answers are trustworthy.
 *
 * A lane knows its own base and is asked first, because a lane's upstream is its OWN
 * branch on the remote - `origin/lane-a` - and a merge-base against that says the work is
 * empty, which is exactly the wrong answer in the one place this feature matters most.
 * After that: the tracked upstream, then whatever the remote calls its default, then the
 * usual trunk names. Nothing here falls back to comparing a branch with itself; a base we
 * cannot work out is reported as one, so the dialog can say so rather than show nothing
 * and let it read as "no changes".
 */
async function baseOf(cwd: string, branch: string): Promise<string | null> {
  const lane = await laneWork(cwd).catch(() => null)
  if (lane?.base && lane.base !== branch && (await exists(cwd, lane.base))) return lane.base

  const up = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  const upstream = up.ok ? up.out.trim() : ''
  // `origin/lane-a` for branch `lane-a` is this branch on the remote, not a base to
  // compare against; it would make every lane look empty until it was pushed behind.
  if (upstream && upstream !== branch && !upstream.endsWith(`/${branch}`)) return upstream

  const head = await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const dflt = head.ok ? head.out.trim() : ''
  if (dflt && dflt !== branch && !dflt.endsWith(`/${branch}`)) return dflt

  for (const name of ['main', 'master', 'develop', 'origin/main', 'origin/master']) {
    if (name === branch || name.endsWith(`/${branch}`)) continue
    if (await exists(cwd, name)) return name
  }
  return null
}

/** Statuses come from --name-status, counts from --numstat: neither carries both. */
function statusOf(code: string): DiffFile['status'] {
  const c = code[0]
  if (c === 'A') return 'added'
  if (c === 'D') return 'deleted'
  if (c === 'R' || c === 'C') return 'renamed'
  return 'modified'
}

/**
 * `--numstat -z`: `<add>\t<del>\t<path>\0`, and for a rename the path field is EMPTY and
 * two more NUL-separated fields follow. Getting that wrong shifts every subsequent record
 * by one, which is why the two lists are parsed by the same walker.
 */
function parseNumstat(out: string): Map<string, { added: number; removed: number; binary: boolean; oldPath: string | null }> {
  const parts = zSplit(out)
  const files = new Map<string, { added: number; removed: number; binary: boolean; oldPath: string | null }>()
  for (let i = 0; i < parts.length; i++) {
    const fields = parts[i].split('\t')
    if (fields.length < 3) continue
    const [addRaw, delRaw, inline] = fields
    let path = inline
    let oldPath: string | null = null
    if (!path) {
      oldPath = parts[++i] ?? ''
      path = parts[++i] ?? ''
    }
    if (!path) continue
    // git writes `-` for both counts on a file it treated as binary.
    const binary = addRaw === '-' || delRaw === '-'
    files.set(path, {
      added: binary ? 0 : Number(addRaw) || 0,
      removed: binary ? 0 : Number(delRaw) || 0,
      binary,
      oldPath
    })
  }
  return files
}

/** `--name-status -z`: `<code>\0<path>\0`, with a second path after a rename code. */
function parseNameStatus(out: string): Map<string, { status: DiffFile['status']; oldPath: string | null }> {
  const parts = zSplit(out)
  const files = new Map<string, { status: DiffFile['status']; oldPath: string | null }>()
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]
    if (!code || !/^[A-Z]/.test(code)) continue
    const status = statusOf(code)
    if (status === 'renamed') {
      const oldPath = parts[++i] ?? ''
      const path = parts[++i] ?? ''
      if (path) files.set(path, { status, oldPath })
    } else {
      const path = parts[++i] ?? ''
      if (path) files.set(path, { status, oldPath: null })
    }
  }
  return files
}

/** The `git diff` arguments a scope means, once its base is known. */
function rangeArgs(scope: DiffScope, mergeBase: string | null): string[] | null {
  if (scope === 'working') return ['HEAD']
  if (!mergeBase) return null
  // `<base> HEAD` compares two commits; `<base>` alone compares the commit with the
  // WORKING TREE, which is what makes `all` one command rather than two merged lists.
  return scope === 'branch' ? [mergeBase, 'HEAD'] : [mergeBase]
}

/** Files git has never been told about. They are the ones an agent most often just made. */
async function untrackedFiles(cwd: string): Promise<DiffFile[]> {
  const r = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (!r.ok) return []
  const out: DiffFile[] = []
  for (const path of zSplit(r.out)) {
    if (!path) continue
    let added = 0
    let binary = false
    try {
      const info = await stat(join(cwd, path))
      if (!info.isFile()) continue
      if (info.size > MAX_UNTRACKED) {
        binary = true
      } else {
        const buf = await readFile(join(cwd, path))
        // Same test git uses first: a NUL byte in the head of the file means binary.
        binary = buf.subarray(0, 8000).includes(0)
        if (!binary) {
          const lines = buf.toString('utf8').split('\n')
          // A file ending in a newline splits to a trailing empty string; that is the
          // end of the last line, not a line of its own.
          if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
          added = lines.length
        }
      }
    } catch {
      continue
    }
    out.push({ path, oldPath: null, status: 'added', added, removed: 0, binary, untracked: true })
  }
  return out
}

/**
 * The changed files for one scope. Cheap enough to call every time the dialog opens: two
 * `git diff` reads that touch no working tree, plus one `ls-files` when untracked files
 * are part of the question.
 */
export async function diffFiles(cwd: string, scope: DiffScope): Promise<DiffSet> {
  const branch = await branchOf(cwd)
  if (!branch) {
    return { scope, base: null, branch: '', files: [], truncated: false, problem: 'This folder is not a git checkout.' }
  }

  let base: string | null = null
  let mergeBase: string | null = null
  /**
   * The reason a scope could not be answered in full.
   *
   * Whether that is fatal depends on the scope, and getting it wrong is what a probe
   * caught: on the trunk of a repo whose only branch is the trunk there IS no base, so
   * `all` reported "0 files" - beside a folder with fourteen changed files in it. The
   * branch half of the question is genuinely unanswerable there; the uncommitted half is
   * not, and answering the half it can while saying which half is missing beats answering
   * neither. `branch` alone has no half left, so for that one this is the whole answer.
   */
  let short: string | null = null
  if (scope !== 'working') {
    base = await baseOf(cwd, branch)
    if (!base) {
      short = `Nothing to compare ${branch} against - it has no upstream and no main branch beside it.`
    } else {
      // The merge base, not the branch tip: comparing with the tip would show every commit
      // the base has gained since, as though this branch had deleted them.
      const mb = await git(cwd, ['merge-base', base, 'HEAD'])
      mergeBase = mb.ok ? mb.out.trim() : null
      if (!mergeBase) short = `${branch} and ${base} share no history.`
    }
    if (short && scope === 'branch') {
      return { scope, base, branch, files: [], truncated: false, problem: short }
    }
  }

  // `all` with no base is the uncommitted scope plus a sentence saying so.
  const effective: DiffScope = short ? 'working' : scope

  const range = rangeArgs(effective, mergeBase)
  if (!range) return { scope, base, branch, files: [], truncated: false, problem: short ?? 'Nothing to compare against.' }

  const [nums, names] = await Promise.all([
    git(cwd, ['diff', '--numstat', '-z', '--find-renames', ...range]),
    git(cwd, ['diff', '--name-status', '-z', '--find-renames', ...range])
  ])
  if (!nums.ok) {
    return { scope, base, branch, files: [], truncated: false, problem: 'git could not read the changes in this folder.' }
  }

  const counts = parseNumstat(nums.out)
  const statuses = parseNameStatus(names.out)
  const files: DiffFile[] = []
  for (const [path, c] of counts) {
    const s = statuses.get(path)
    files.push({
      path,
      oldPath: c.oldPath ?? s?.oldPath ?? null,
      status: s?.status ?? 'modified',
      added: c.added,
      removed: c.removed,
      binary: c.binary,
      untracked: false
    })
  }

  // `branch` is history only, and a file nobody has committed is not in it.
  if (effective !== 'branch') files.push(...(await untrackedFiles(cwd)))

  files.sort((a, b) => a.path.localeCompare(b.path))
  const truncated = nums.clipped || files.length > MAX_FILES
  return {
    scope,
    base,
    branch,
    files: files.slice(0, MAX_FILES),
    truncated,
    problem: short ? `${short} Showing what is uncommitted instead.` : null
  }
}

/** One file's patch. `untracked` is passed rather than re-derived: the list already knew. */
export async function diffPatch(
  cwd: string,
  scope: DiffScope,
  path: string,
  untracked: boolean
): Promise<DiffPatch> {
  if (untracked) return untrackedPatch(cwd, path)

  let mergeBase: string | null = null
  let effective = scope
  if (scope !== 'working') {
    const branch = await branchOf(cwd)
    const base = await baseOf(cwd, branch)
    if (base) {
      const mb = await git(cwd, ['merge-base', base, 'HEAD'])
      mergeBase = mb.ok ? mb.out.trim() : null
    }
    // Same fallback the file list makes, and it has to be the same one: a list that fell
    // back to the uncommitted scope and a patch reader that did not would list files whose
    // patch then came back empty, which reads as "this file did not really change".
    if (!mergeBase) {
      if (scope === 'branch') return { path, text: '', truncated: false }
      effective = 'working'
    }
  }
  const range = rangeArgs(effective, mergeBase)
  if (!range) return { path, text: '', truncated: false }

  const r = await git(
    cwd,
    // `--no-color` explicitly: a user's diff.color=always in ~/.gitconfig would otherwise
    // put escape sequences through a renderer that draws them literally.
    ['diff', '--no-color', '--find-renames', '--unified=3', ...range, '--', path],
    MAX_PATCH
  )
  return { path, text: r.out, truncated: r.clipped }
}

/**
 * A patch for a file git has never seen, written by hand.
 *
 * The usual way to get one is `git diff --no-index -- /dev/null <file>`, which needs a
 * null device path that differs per platform, and `git add -N`, which writes the index of
 * a repo an agent is working in. Neither is worth it: an untracked file is entirely
 * additions, which is a patch anyone can write.
 */
async function untrackedPatch(cwd: string, path: string): Promise<DiffPatch> {
  let buf: Buffer
  try {
    buf = await readFile(join(cwd, path))
  } catch {
    return { path, text: '', truncated: false }
  }
  if (buf.subarray(0, 8000).includes(0)) return { path, text: `Binary files /dev/null and b/${path} differ\n`, truncated: false }

  const truncated = buf.length > MAX_PATCH
  const text = buf.subarray(0, MAX_PATCH).toString('utf8')
  const lines = text.split('\n')
  // A file ending in a newline splits to a trailing empty string that is not a line.
  const hadFinalNewline = lines.length > 1 && lines[lines.length - 1] === ''
  if (hadFinalNewline) lines.pop()
  const body = lines.map((l) => `+${l}`)
  if (!hadFinalNewline && lines.length) body.push('\\ No newline at end of file')
  return {
    path,
    text: [`@@ -0,0 +1,${lines.length} @@`, ...body].join('\n') + '\n',
    truncated
  }
}
