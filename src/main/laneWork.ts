// The other half of a worktree lane: what happens to the work in it.
//
// lanes.ts makes the lane - a second session in one repo is moved into `<repo>-w2` on
// branch `pf/w2` so two agents cannot clobber each other. Until now that was the whole
// story: the commits stayed on a branch nobody ever merged, the folder stayed on disk
// forever, and a lane whose changes disagreed with main said so to nobody. Three days of
// that and a project has four stale checkouts and work in branches its owner has
// forgotten exist.
//
// So this file answers the three questions the lane raises after it is made:
//
//   laneWork()      what is in this lane - commits, uncommitted files, and whether it
//                   would conflict with the branch it came from (asked without touching
//                   a single working tree, so it is safe to poll)
//   mergeLaneBack() put it back on that branch, refusing rather than guessing whenever
//                   the merge is not clean
//   sweepLanes()    delete the lanes that hold nothing - merged, empty, and no session
//                   in them. Anything with work in it is never touched.
//
// Everything here is node builtins and `git`, so it is testable without Electron
// (scripts/lane-work-test.mjs) and cheap enough to call on a timer.

import { execFile } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { LaneMergeResult, LaneWork } from '../shared/types'

/** `<repo>-w2` - the folder shape lanes.ts creates, and the only shape swept here. */
const LANE_DIR = /-w(\d)$/

export type { LaneMergeResult, LaneWork }

function git(cwd: string, args: string[], timeout = 20000): { ok: boolean; out: string } {
  try {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout })
    return { ok: r.status === 0, out: ((r.stdout ?? '') + (r.stderr ?? '')).trim() }
  } catch {
    return { ok: false, out: '' }
  }
}

/** stdout only, for the commands whose stderr is progress noise. */
function gitOut(cwd: string, args: string[], timeout = 20000): { ok: boolean; out: string } {
  try {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout })
    return { ok: r.status === 0, out: (r.stdout ?? '').trim() }
  } catch {
    return { ok: false, out: '' }
  }
}

/** Windows paths differ in case and slash direction for the same folder. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** The main checkout of whatever repo this folder belongs to, worktree or not. */
function mainRepo(cwd: string): string | null {
  const common = gitOut(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common.ok || !common.out) return null
  const dir = common.out.split(/\r?\n/)[0]
  if (!/[\\/]\.git$/.test(dir)) return null
  const root = dirname(dir)
  return existsSync(root) ? root : null
}

function head(cwd: string): string {
  const r = gitOut(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return r.ok ? r.out : ''
}

function dirtyCount(cwd: string): number {
  const r = gitOut(cwd, ['status', '--porcelain'])
  if (!r.ok || !r.out) return 0
  return r.out.split(/\r?\n/).filter(Boolean).length
}

/**
 * The files a merge would fight over, worked out without merging anything.
 *
 * `merge-tree --write-tree` does the whole three-way merge in the object store: no
 * checkout is touched, nothing has to be aborted afterwards, and it is safe to call on a
 * timer while an agent is typing in both folders. Git 2.38+; on anything older this
 * returns an empty list and the real merge stays the thing that finds out.
 */
function conflictFiles(repo: string, base: string, branch: string): string[] {
  const r = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', base, branch], {
    cwd: repo,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000
  })
  // 0 = merges clean. 1 = conflicts, listed. Anything else (128) is an old git or a bad
  // ref, and claiming "no conflicts" there is the honest answer: we do not know.
  if (r.status !== 1) return []
  const lines = (r.stdout ?? '').split(/\r?\n/)
  const out: string[] = []
  // First line is the resulting tree oid; the file list runs to the first blank line,
  // after which git prints its human-readable conflict messages.
  for (const line of lines.slice(1)) {
    if (!line.trim()) break
    out.push(line.trim())
  }
  return out
}

/** The lane label for a folder, or null when it is not a `<repo>-wN` lane of `repo`. */
function laneLabel(dir: string, repo: string): string | null {
  const m = LANE_DIR.exec(basename(resolve(dir)))
  if (!m) return null
  // `<repo>-w2` must sit beside the repo and be named after it, or it is somebody
  // else's folder that happens to end in -w2.
  const expected = join(dirname(repo), `${basename(repo)}-w${m[1]}`)
  return samePath(dir, expected) ? `w${m[1]}` : null
}

/**
 * What is in a lane, or null when the folder is not a lane of its repo.
 *
 * Reads only: four git commands against the object store and the index, no working tree
 * is written. Safe to call while both the lane and the main checkout are in use.
 */
export function laneWork(dir: string): LaneWork | null {
  if (!existsSync(dir)) return null
  const repo = mainRepo(dir)
  if (!repo || samePath(repo, dir)) return null
  const lane = laneLabel(dir, repo)
  if (!lane) return null

  const branch = head(dir)
  const base = head(repo)
  if (!branch || !base || branch === 'HEAD' || base === 'HEAD') return null

  const counted = gitOut(dir, ['rev-list', '--count', `${base}..HEAD`])
  const ahead = counted.ok ? Number(counted.out) || 0 : 0
  const dirty = dirtyCount(dir)
  return {
    lane,
    dir: resolve(dir),
    repo,
    branch,
    base,
    ahead,
    dirty,
    // Only worth computing when there is something to merge.
    conflicts: ahead > 0 ? conflictFiles(repo, base, branch) : [],
    baseDirty: dirtyCount(repo) > 0,
    empty: ahead === 0 && dirty === 0
  }
}

/**
 * Put a lane's commits back on the branch it came from.
 *
 * Refuses instead of improvising, every time:
 *   - uncommitted work in the lane is the agent's, not ours to commit or stash
 *   - uncommitted work in the main checkout would end up inside somebody else's merge
 *   - a conflict is aborted and handed back as a file list, because resolving it needs
 *     the person who wrote both sides
 *
 * `--no-ff` on purpose: the merge commit is the record that lane w2 existed, which is
 * the only trace left once the folder is swept.
 */
export function mergeLaneBack(dir: string, opts: { busy?: string[] } = {}): LaneMergeResult {
  const work = laneWork(dir)
  if (!work) return { ok: false, reason: 'not-a-lane' }
  if (work.dirty > 0) {
    return {
      ok: false,
      reason: 'lane-dirty',
      detail: `${work.dirty} uncommitted file${work.dirty === 1 ? '' : 's'} in the lane - commit or discard them first.`
    }
  }
  if (work.ahead === 0) return { ok: false, reason: 'nothing' }
  if (work.baseDirty) {
    return {
      ok: false,
      reason: 'base-dirty',
      detail: `${work.repo} has uncommitted changes - a merge would land on top of them.`
    }
  }
  if (work.conflicts.length) return { ok: false, reason: 'conflict', conflicts: work.conflicts }

  const merged = git(work.repo, [
    'merge',
    '--no-ff',
    '--no-edit',
    '-m',
    `merge lane ${work.lane} (${work.branch})`,
    work.branch
  ])
  if (!merged.ok) {
    // Only merge-tree said it was clean, so this is a case it cannot see (a hook, a
    // locked file). Leave the checkout exactly as it was found.
    const conflicts = gitOut(work.repo, ['diff', '--name-only', '--diff-filter=U'])
      .out.split(/\r?\n/)
      .filter(Boolean)
    git(work.repo, ['merge', '--abort'])
    return conflicts.length
      ? { ok: false, reason: 'conflict', conflicts }
      : { ok: false, reason: 'failed', detail: merged.out.split(/\r?\n/)[0] }
  }

  // Merged and empty: the folder is now pure cost. It only goes if no session is in it.
  const held = (opts.busy ?? []).some((b) => samePath(b, work.dir))
  const removed = held ? false : removeLaneSync(work.repo, work.dir, work.branch)
  return { ok: true, commits: work.ahead, base: work.base, branch: work.branch, removed }
}

/**
 * Delete a lane folder and its branch. Git refuses if the worktree has changes in it,
 * which is the safety net: this is only ever called on a lane that has just been proven
 * empty, and if that changed in between, git says no and nothing is lost.
 */
function removeLaneSync(repo: string, dir: string, branch: string): boolean {
  git(repo, ['worktree', 'remove', dir], 120_000)
  if (!finished(repo, dir)) return false
  // -d, never -D: a branch with unmerged commits keeps existing, folder or no folder.
  git(repo, ['branch', '-d', branch])
  git(repo, ['worktree', 'prune'])
  return true
}

/**
 * Did the removal actually take, whatever git's exit code said?
 *
 * On Windows `git worktree remove` empties the folder and deregisters the worktree, and
 * then fails on the last step - deleting the folder itself - whenever any process still
 * has it as its current directory. The pane that was just moved out of the lane is
 * exactly such a process for a second or two. Reading git's exit code alone, that lane
 * kept its branch forever and was retried on every sweep: measured on git 2.53, the
 * folder was left behind, empty, with `pf/w2` still on the branch list.
 *
 * So the question asked is the one that matters - is this still a worktree of the repo -
 * and the empty shell of a folder is swept up separately.
 */
function finished(repo: string, dir: string): boolean {
  if (laneFolders(repo).some((p) => samePath(p, dir))) return false
  try {
    // Only ever an empty directory by this point: git deleted the contents itself.
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* still held - the next sweep gets it, and git no longer thinks it is a lane */
  }
  return true
}

const exec = (cwd: string, args: string[], timeout: number): Promise<boolean> =>
  new Promise((done) => {
    execFile('git', args, { cwd, windowsHide: true, timeout }, (err) => done(!err))
  })

/** The main checkout a folder belongs to (itself, when it is not a worktree). */
export function repoOf(cwd: string): string | null {
  return mainRepo(cwd)
}

/** Lane folders of this repo, whether or not anything is in them. */
export function laneFolders(repo: string): string[] {
  const list = gitOut(repo, ['worktree', 'list', '--porcelain'])
  if (!list.ok) return []
  return list.out
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
    .filter((p) => !samePath(p, repo) && Boolean(laneLabel(p, repo)))
}

/** Is `child` that folder, or somewhere inside it? */
function inside(child: string, parent: string): boolean {
  const norm = (p: string): string => resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  const c = norm(child)
  const p = norm(parent)
  return c === p || c.startsWith(p + '\\') || c.startsWith(p + '/')
}

/**
 * Has this lane's work ended up in the project by some route other than a merge?
 *
 * `empty` answers the ordinary case: the commits went back, so the branch is level with
 * base and there is nothing ahead. A squash merge never produces that - the commit is
 * rewritten under a new id, so the lane reads as one commit ahead of base forever and
 * its folder would outlive the work by weeks.
 *
 * `git cherry` is the question that survives the rewrite: it compares by patch rather
 * than by commit id and prints `+` for anything with no equivalent upstream. None of
 * those means every change in this lane is in the project already. A lane squashed from
 * SEVERAL commits is not patch-equivalent to the one commit that replaced it and keeps
 * its folder - the point here is to be sure, not to be thorough.
 */
function absorbed(repo: string, work: LaneWork): 'patch' | null {
  const cherry = gitOut(repo, ['cherry', work.base, work.branch])
  if (!cherry.ok) return null
  const unique = cherry.out
    .split(/\r?\n/)
    .filter(Boolean)
    .some((l) => l.startsWith('+'))
  return unique ? null : 'patch'
}

/**
 * Delete every lane of this repo that holds nothing and has no session in it.
 *
 * "Holds nothing" is deliberately strict - no commits of its own, no uncommitted file,
 * not even an untracked one - because the alternative is deleting an agent's work while
 * it is between commits. A lane whose commits were merged back passes this test on its
 * own, so merged lanes disappear a sweep later without anyone deciding to delete them.
 *
 * Removal is async: a lane's `node_modules` is tens of thousands of hardlinks, and
 * unlinking them on the main thread would freeze every pane in the window.
 */
export async function sweepLanes(repo: string, busy: string[] = []): Promise<string[]> {
  const removed: string[] = []
  for (const dir of laneFolders(repo)) {
    // A pane that cd'd into a subfolder of the lane reports that subfolder, and it is
    // just as much "somebody is in there" as the lane root is.
    if (busy.some((b) => inside(b, dir))) continue
    const work = laneWork(dir)
    if (!work || work.dirty > 0) continue
    // Ours to delete, or somebody else's worktree that happens to sit at `<repo>-w2`
    // and be tidy today. laneWork() reads any lane-shaped folder on purpose - the panel
    // should describe one either way - but nothing is REMOVED unless lanes.ts made it,
    // which is what the `pf/` branch says.
    if (work.branch !== `pf/${work.lane}`) continue
    const how = work.empty ? 'history' : absorbed(repo, work)
    if (!how) continue
    await exec(repo, ['worktree', 'remove', dir], 120_000)
    // Not the exit code - see finished(). A lane can be gone and still make git unhappy.
    if (!finished(repo, dir)) continue
    // `-d` is the safe delete and refuses anything the base branch does not have. A
    // squash-merged lane is exactly that case and always will be, and its patches have
    // just been shown to be in the project, so that one is deleted outright.
    await exec(repo, ['branch', how === 'history' ? '-d' : '-D', work.branch], 20_000)
    removed.push(dir)
  }
  if (removed.length) await exec(repo, ['worktree', 'prune'], 20_000)
  dropEmptyShells(repo)
  return removed
}

/**
 * Delete the empty folder a removed lane can leave behind.
 *
 * See finished(): git empties and deregisters the lane, then cannot delete the folder
 * itself while a process still has it as its working directory - which the pane that
 * just left the lane does, for a second or two. By the time that has passed, the folder
 * is no longer a worktree, so nothing was ever coming back for it. Verified in the app:
 * `lanedemo-w2` stayed on disk containing nothing at all.
 *
 * Only ever an EMPTY `<repo>-wN` folder beside the repo, so there is nothing to lose.
 */
function dropEmptyShells(repo: string): void {
  const registered = laneFolders(repo)
  const parent = dirname(repo)
  let siblings: string[] = []
  try {
    siblings = readdirSync(parent)
  } catch {
    return
  }
  for (const name of siblings) {
    if (!name.startsWith(`${basename(repo)}-w`) || !LANE_DIR.test(name)) continue
    const dir = join(parent, name)
    if (registered.some((p) => samePath(p, dir))) continue
    try {
      if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
    } catch {
      /* still held, or not a directory - either way not ours to force */
    }
  }
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
  let line = previous
  const submitted: string[] = []
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i)

    if (code === 27) {
      // An ESC that ends the chunk is the Escape key, and the line is abandoned.
      if (i === data.length - 1) {
        line = ''
        break
      }
      // Anything else starting with ESC is a control sequence the terminal is sending,
      // not something a person typed. This is the bug that made the whole thing look
      // broken: xterm reports focus as ESC [ O / ESC [ I, so the moment a pane lost
      // focus its next line began "[O" and never matched again - measured in the running
      // app, where /clear submitted the line "[O/clear".
      const next = data[i + 1]
      if (next === '[' || next === 'O') {
        i += 2
        // CSI/SS3 run to their final byte, which is anything in @ to ~.
        while (i < data.length) {
          const c = data.charCodeAt(i)
          if (c >= 0x40 && c <= 0x7e) break
          i++
        }
      } else if (next === ']') {
        // OSC (a title, a hyperlink) runs to BEL or ESC \.
        i += 2
        while (i < data.length) {
          if (data.charCodeAt(i) === 7) break
          if (data.charCodeAt(i) === 27 && data[i + 1] === '\\') {
            i++
            break
          }
          i++
        }
      } else i += 1
      continue
    }

    if (code === 13 || code === 10) {
      submitted.push(line.trim())
      line = ''
    } else if (code === 8 || code === 127) line = line.slice(0, -1)
    // Ctrl-C and Ctrl-U both throw away what has been typed so far.
    else if (code === 3 || code === 21) line = ''
    else if (code >= 32) line += data[i]
  }
  return { line: line.slice(-32), submitted }
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
export function returnToBase(cwd: string, taken: string[]): string | null {
  const work = laneWork(cwd)
  if (!work || !work.empty) return null
  if (taken.some((t) => samePath(t, work.repo))) return null
  return work.repo
}
