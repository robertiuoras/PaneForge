// The other half of a lane: what happens to the work in it.
//
// lanes.ts makes the lane - a second session in one repo is moved into `<repo>-a` on
// branch `lane-a` so two agents cannot clobber each other. Until now that was the whole
// story: the commits stayed on a branch nobody ever merged, the folder stayed on disk
// forever, and a lane whose changes disagreed with main said so to nobody. Three days of
// that and a project has four stale checkouts and work in branches its owner has
// forgotten exist.
//
// So this file answers the question the lane raises after it is made:
//
//   laneWork()      what is in this lane - commits, uncommitted files, and whether it
//                   would conflict with the branch it came from (asked without touching
//                   a single working tree, so it is safe to poll)
//
// The copy sweep - deleting the lanes that hold nothing - is scripts/lane.mjs `sweep`.
//
// Everything here is node builtins and `git`, so it is testable without Electron
// (scripts/lane-work-test.mjs) and cheap enough to call on a timer.

import { gitRun, isRead } from './gitRun'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { feedDraft, LANE_OPTIONS } from '../shared/draft'
import type { LaneWork } from '../shared/types'

/**
 * The lane folder shapes: `<repo>-a` (what lanes.ts and scripts/lane.mjs both create) and
 * `<repo>-w2` (what this app made before the two naming schemes were merged).
 *
 * The old shape is still read and swept - a lane that exists on someone's disk with
 * real commits in it must not become invisible because the app renamed a convention. It is
 * simply never created again, so old lanes drain away and the folder shape goes with them.
 *
 * A single letter is a legitimate ending for a real project name (`service-a`), so a folder
 * only counts as a lane when it also sits beside its repo and is named after it - which is
 * what laneLabel checks, and why this regex alone is never the answer.
 */
const LANE_DIR = /-(w\d+|[a-z])$/

export type { LaneWork }

interface GitRun {
  /** git's exit code; -1 when it could not be run at all. */
  status: number
  ok: boolean
  out: string
}

/**
 * Run git WITHOUT stopping the window.
 *
 * These were `spawnSync`. Every one of them froze the Electron main process - the thread
 * that pumps the window's messages - until git exited, and laneWork() below runs seven of
 * them per lane, for every lane of every open project, on a five-minute timer.
 *
 * Measured against the shipped v0.3.40, from outside the app, with
 * SendMessageTimeout(WM_NULL) - which returns only when the main thread pumps, and is the
 * same question Windows asks before it writes "Not Responding" on a title bar:
 *
 *   p50 0.2ms, p90 1.3ms, p99 10.5ms  ... and then an 8,053ms freeze.
 *   Two of them, at 17:42:47 and 17:47:47 - exactly 300s apart, the sweep interval.
 *   The main process burned 0.3s of CPU across a 3.2s stall: it was not computing,
 *   it was sitting in spawnSync waiting on a child process.
 *
 * The timeouts made the worst case far worse than the average: one slow `git` (an
 * antivirus scan, a held index.lock, an orphaned rev-parse - there was a real one alive
 * for 25 minutes on this machine) blocked the window for the full 15-30s.
 *
 * execFile is the same command with a callback instead of a stall.
 */
function run(cwd: string, args: string[], timeout: number, stdoutOnly: boolean): Promise<GitRun> {
  // Through the one gate (`gitRun.ts`, `shared/gitGate.ts`): the sweep asks the same
  // questions of the same folders as the lane dialog and the Issues check, and on
  // 2026-09-22 they were 270 concurrent git processes with the load average at 400.
  return gitRun(cwd, args, { timeout, read: isRead(args) }).then((r) => ({
    // A non-zero exit keeps its code, which merge-tree gives real meaning to; a git that
    // could not be started, or was killed at its timeout, is -1.
    status: r.status,
    ok: r.ok,
    out: (stdoutOnly ? r.stdout : r.stdout + r.stderr).trim()
  }))
}

/** stdout only, for the commands whose stderr is progress noise. */
const gitOut = (cwd: string, args: string[], timeout = 20000): Promise<GitRun> =>
  run(cwd, args, timeout, true)

function physicalPath(p: string): string {
  let head = resolve(p)
  const rest: string[] = []
  // The deepest part that exists gets resolved and the rest is kept as spelt: a pane
  // names a folder that may not be on disk (a chat's cwd inside a lane that was swept),
  // and a half-resolved path must not compare unequal to a fully resolved one.
  for (;;) {
    try {
      head = realpathSync(head)
      break
    } catch {
      const up = dirname(head)
      if (up === head) break
      rest.unshift(basename(head))
      head = up
    }
  }
  return join(head, ...rest)
    .replace(/[\\/]+$/, '')
    .toLowerCase()
}

/** Windows paths differ in case and slash direction for the same folder. */
export function samePath(a: string, b: string): boolean {
  // realpath, not resolve alone: every path git hands back is already real, and on macOS
  // the folder that matters is /var, a symlink to /private/var. A lane living under a
  // symlinked parent therefore compared unequal to the same lane as git spells it, and
  // laneWork() called the folder "not a lane" of its own repo. A path that is not on disk
  // keeps the old answer rather than throwing.
  return physicalPath(a) === physicalPath(b)
}

/** The main checkout of whatever repo this folder belongs to, worktree or not. */
async function mainRepo(cwd: string): Promise<string | null> {
  // Asked for every folder on the desk and every project in the projects folder on each
  // sweep, and the answer only changes when a repository is made or deleted.
  // Only a found repository is kept: a folder that becomes one is seen on the next ask.
  const hit = repoCache.get(cwd)
  if (hit && Date.now() - hit.at < REPO_TTL_MS && existsSync(cwd) && existsSync(hit.repo))
    return hit.repo
  const repo = await readMainRepo(cwd)
  if (repo) repoCache.set(cwd, { at: Date.now(), repo })
  else repoCache.delete(cwd)
  return repo
}
const REPO_TTL_MS = 5 * 60_000
const repoCache = new Map<string, { at: number; repo: string }>()

async function readMainRepo(cwd: string): Promise<string | null> {
  const common = await gitOut(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common.ok || !common.out) return null
  const dir = common.out.split(/\r?\n/)[0]
  if (!/[\\/]\.git$/.test(dir)) return null
  const root = dirname(dir)
  return existsSync(root) ? root : null
}

async function head(cwd: string): Promise<string> {
  const r = await gitOut(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return r.ok ? r.out : ''
}

/**
 * Does the main checkout have ANY uncommitted file. Only the yes/no is used, so untracked
 * folders are not walked file by file (`normal`, not `all`) - this is the project's own
 * checkout, the largest tree the sweep reads, and it is read once per lane per sweep.
 */
async function baseDirty(cwd: string): Promise<boolean | null> {
  const r = await gitOut(cwd, ['status', '--porcelain', '-z', '--untracked-files=normal'])
  return r.ok ? r.out.length > 0 : null
}

/**
 * The uncommitted paths, as git spells them. One `status` for both the count and the names.
 *
 * `-z`, and that is the load-bearing part. Plain `--porcelain` QUOTES any path with a space
 * or a non-ASCII byte in it (`core.quotepath` is on by default), so `"file with spaces.txt"`
 * came back with its quotes attached and was drawn in the lane dialog that way - and a
 * non-ASCII name came back as octal escapes. `-z` is NUL-separated and unquoted by
 * construction, which is why every other reader in this repo uses it (`main/diff.ts`, and
 * `test:diff` pins the records) rather than trying to undo the quoting afterwards.
 *
 * A rename is two entries: the new path, then the old one, in that order. The new one is the
 * file that exists, so the pair is consumed together and only that half is kept.
 */
async function dirtyFiles(cwd: string): Promise<string[] | null> {
  // Do not let a repository preference hide an agent's scratch file.  In particular,
  // `status.showUntrackedFiles=no` is useful in a large checkout but must never turn
  // an untracked lane into one that cleanup is allowed to remove.
  const r = await gitOut(cwd, ['status', '--porcelain', '-z', '--untracked-files=all'])
  if (!r.ok) return null
  if (!r.out) return []
  const parts = r.out.split('\0').filter((p) => p.length > 0)
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    // `XY path`: two status letters and a space.
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    if (!path) continue
    out.push(path)
    // R/C carry their source as the NEXT record, which is not a changed file of its own.
    if (status.includes('R') || status.includes('C')) i++
  }
  return out
}

/**
 * The newest commit on this checkout, as a subject and a time.
 *
 * Read with `--no-walk` off HEAD, so it costs one object read and cannot be slowed by a
 * long history. An empty repository (no commit yet) answers with nothing rather than
 * failing the whole reading - a lane made a minute ago is the ordinary case for this.
 */
async function lastCommit(cwd: string): Promise<{ subject: string | null; at: number | null }> {
  const r = await gitOut(cwd, ['log', '-1', '--no-walk', '--format=%s%x00%ct'], 10000)
  if (!r.ok || !r.out) return { subject: null, at: null }
  const [subject, ct] = r.out.split('\0')
  const secs = Number(ct)
  return {
    subject: subject?.trim() ? subject.trim() : null,
    at: Number.isFinite(secs) && secs > 0 ? secs * 1000 : null
  }
}

/**
 * The files a merge would fight over, worked out without merging anything.
 *
 * `merge-tree --write-tree` does the whole three-way merge in the object store: no
 * checkout is touched, nothing has to be aborted afterwards, and it is safe to call on a
 * timer while an agent is typing in both folders. Git 2.38+; on anything older this
 * returns an empty list and the real merge stays the thing that finds out.
 */
async function conflictFiles(repo: string, base: string, branch: string): Promise<string[]> {
  const r = await run(repo, ['merge-tree', '--write-tree', '--name-only', base, branch], 30000, true)
  // 0 = merges clean. 1 = conflicts, listed. Anything else (128) is an old git or a bad
  // ref, and claiming "no conflicts" there is the honest answer: we do not know.
  if (r.status !== 1) return []
  const lines = r.out.split(/\r?\n/)
  const out: string[] = []
  // First line is the resulting tree oid; the file list runs to the first blank line,
  // after which git prints its human-readable conflict messages.
  for (const line of lines.slice(1)) {
    if (!line.trim()) break
    out.push(line.trim())
  }
  return out
}

/** The lane label for a folder, or null when it is not a lane of `repo`. */
function laneLabel(dir: string, repo: string): string | null {
  const m = LANE_DIR.exec(basename(resolve(dir)))
  if (!m) return null
  // `<repo>-a` must sit beside the repo and be named after it, or it is somebody else's
  // folder that happens to end in -a.
  const expected = join(dirname(repo), `${basename(repo)}-${m[1]}`)
  return samePath(dir, expected) ? m[1] : null
}

/**
 * What is in a lane, or null when the folder is not a lane of its repo.
 *
 * Reads only: seven git commands against the object store and the index, no working tree
 * is written. Safe to call while both the lane and the main checkout are in use.
 *
 * Seven, not four - and all of them used to be synchronous, which is what made the sweep
 * that calls this freeze the window for eight seconds every five minutes. They are async
 * now; see run() above for the measurement.
 */
export async function laneWork(dir: string): Promise<LaneWork | null> {
  if (!existsSync(dir)) return null
  const repo = await mainRepo(dir)
  if (!repo || samePath(repo, dir)) return null
  const lane = laneLabel(dir, repo)
  if (!lane) return null

  // The two checkouts are different folders, so these never queue behind each other.
  const [branch, base] = await Promise.all([head(dir), head(repo)])
  if (!branch || !base || branch === 'HEAD' || base === 'HEAD') return null

  const counted = await gitOut(dir, ['rev-list', '--count', `${base}..HEAD`])
  if (!counted.ok || !/^\d+$/.test(counted.out)) return null
  const ahead = Number(counted.out)
  const [touching, repoDirty, last] = await Promise.all([
    dirtyFiles(dir),
    baseDirty(repo),
    lastCommit(dir)
  ])
  if (touching === null || repoDirty === null) return null
  const dirty = touching.length
  return {
    lane,
    dir: resolve(dir),
    repo,
    branch,
    base,
    ahead,
    dirty,
    // Only worth computing when there is something to merge.
    conflicts: ahead > 0 ? await conflictFiles(repo, base, branch) : [],
    baseDirty: repoDirty,
    empty: ahead === 0 && dirty === 0,
    subject: last.subject,
    at: last.at,
    touching: touching.slice(0, 4)
  }
}

/** The main checkout a folder belongs to (itself, when it is not a worktree). */
export function repoOf(cwd: string): Promise<string | null> {
  return mainRepo(cwd)
}

/** Physical lane folders, or null when git could not answer safely. */
export async function inspectLaneFolders(repo: string): Promise<string[] | null> {
  const list = await gitOut(repo, ['worktree', 'list', '--porcelain'])
  if (!list.ok) return null
  return list.out
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
    .filter((p) => !samePath(p, repo) && Boolean(laneLabel(p, repo)))
}

/** Lane folders for lifecycle callers. A failed git read preserves every folder. */
export async function laneFolders(repo: string): Promise<string[]> {
  return (await inspectLaneFolders(repo)) ?? []
}

/** Is `child` that folder, or somewhere inside it? */
function inside(child: string, parent: string): boolean {
  const c = physicalPath(child)
  const p = physicalPath(parent)
  return c === p || c.startsWith(p + '\\') || c.startsWith(p + '/')
}

/**
 * Follow what a pane is typing, one chunk of keystrokes at a time, and report the lines
 * it submits.
 *
 * The only caller wants to know when a conversation was cleared, and `/clear` + Enter is
 * what the person types - far steadier than trying to recognise the banner each CLI
 * draws afterwards, which differs per agent and changes every release. Backspace and
 * delete are applied so an edited line is judged as it ends up; Escape and Ctrl-C throw
 * the line away, because neither ever submits one.
 *
 * Only the tail of a line is kept: a pasted prompt can be thousands of characters and
 * none of them can make the last word `/clear` on their own.
 */
export function trackTyped(previous: string, data: string): { line: string; submitted: string[] } {
  // The loop itself is `shared/draft.ts` now - one parser for the three places that
  // reconstruct what a pane is typing. `LANE_OPTIONS` is this caller's half of it: parse
  // escapes properly (xterm reports focus as ESC [ O / ESC [ I, and reading that as
  // typing is what once made /clear submit the line "[O/clear"), ignore pastes, and keep
  // only the last 32 characters.
  const r = feedDraft({ text: previous, certain: true, inPaste: false }, data, LANE_OPTIONS)
  return { line: r.state.text, submitted: r.submitted }
}

/**
 * Where a session sitting in a lane should really be, now that its context is gone.
 *
 * A lane is worth its folder while there is work in it. After a /clear there is no
 * conversation left to protect either, so an empty lane whose original folder is free is
 * simply a worse place to be: the agent is one folder away from the project it is
 * actually working on, with its own port and a branch nobody will merge. This returns the
 * original folder in exactly that case, and null in every other - work in the lane,
 * another session in the original, anything unreadable.
 */
export async function returnToBase(cwd: string, taken: string[]): Promise<string | null> {
  const top = await gitOut(cwd, ['rev-parse', '--show-toplevel'])
  if (!top.ok || !top.out) return null
  const work = await laneWork(top.out)
  if (!work || !work.empty) return null
  if (taken.some((t) => inside(t, work.repo))) return null
  const target = join(work.repo, relative(top.out, realpathSync(cwd)))
  return existsSync(target) ? target : null
}
