// The other half of a lane: what happens to the work in it.
//
// lanes.ts makes the lane - a second session in one repo is moved into `<repo>-a` on
// branch `lane-a` so two agents cannot clobber each other. Until now that was the whole
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
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { feedDraft, LANE_OPTIONS } from '../shared/draft'
import type { LaneMergeResult, LaneWork } from '../shared/types'

/**
 * The lane folder shapes: `<repo>-a` (what lanes.ts and scripts/lane.mjs both create) and
 * `<repo>-w2` (what this app made before the two naming schemes were merged).
 *
 * The old shape is still read, merged and swept - a lane that exists on someone's disk with
 * real commits in it must not become invisible because the app renamed a convention. It is
 * simply never created again, so old lanes drain away and the folder shape goes with them.
 *
 * A single letter is a legitimate ending for a real project name (`service-a`), so a folder
 * only counts as a lane when it also sits beside its repo and is named after it - which is
 * what laneLabel checks, and why this regex alone is never the answer.
 */
const LANE_DIR = /-(w\d+|[a-z])$/

export type { LaneMergeResult, LaneWork }

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
  return new Promise((done) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const text = stdoutOnly ? (stdout ?? '') : (stdout ?? '') + (stderr ?? '')
        // execFile reports a non-zero exit as an Error carrying the code; a git that
        // could not be started at all has no numeric code, and -1 keeps that distinct
        // from "git ran and said 1", which merge-tree gives real meaning to.
        const code = (err as (Error & { code?: number | string }) | null)?.code
        done({
          status: err ? (typeof code === 'number' ? code : -1) : 0,
          ok: !err,
          out: text.trim()
        })
      }
    )
  })
}

const git = (cwd: string, args: string[], timeout = 20000): Promise<GitRun> =>
  run(cwd, args, timeout, false)

/** stdout only, for the commands whose stderr is progress noise. */
const gitOut = (cwd: string, args: string[], timeout = 20000): Promise<GitRun> =>
  run(cwd, args, timeout, true)

/** Windows paths differ in case and slash direction for the same folder. */
export function samePath(a: string, b: string): boolean {
  // realpath, not resolve alone: every path git hands back is already real, and on macOS
  // the folder that matters is /var, a symlink to /private/var. A lane living under a
  // symlinked parent therefore compared unequal to the same lane as git spells it, and
  // laneWork() called the folder "not a lane" of its own repo. A path that is not on disk
  // keeps the old answer rather than throwing.
  const norm = (p: string): string => {
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
  return norm(a) === norm(b)
}

/** The main checkout of whatever repo this folder belongs to, worktree or not. */
async function mainRepo(cwd: string): Promise<string | null> {
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

async function dirtyCount(cwd: string): Promise<number> {
  const r = await gitOut(cwd, ['status', '--porcelain'])
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
 * The branch a lane with this label carries. `lane-a` now; `pf/w2` for the lanes made
 * before the schemes were merged, which are still on disk until their work lands.
 */
function laneBranches(label: string): string[] {
  return [`lane-${label}`, `pf/${label}`]
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
  const ahead = counted.ok ? Number(counted.out) || 0 : 0
  const [dirty, baseDirty] = await Promise.all([dirtyCount(dir), dirtyCount(repo)])
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
    baseDirty: baseDirty > 0,
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
export async function mergeLaneBack(
  dir: string,
  opts: { busy?: string[] } = {}
): Promise<LaneMergeResult> {
  const work = await laneWork(dir)
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

  const merged = await git(work.repo, [
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
    const conflicts = (await gitOut(work.repo, ['diff', '--name-only', '--diff-filter=U'])).out
      .split(/\r?\n/)
      .filter(Boolean)
    await git(work.repo, ['merge', '--abort'])
    return conflicts.length
      ? { ok: false, reason: 'conflict', conflicts }
      : { ok: false, reason: 'failed', detail: merged.out.split(/\r?\n/)[0] }
  }

  // Merged and empty: the folder is now pure cost. It only goes if no session is in it.
  const held =
    (opts.busy ?? []).some((b) => samePath(b, work.dir)) ||
    (await heldAsProcessCwd(work.dir))
  const removed = held ? false : await removeLane(work.repo, work.dir, work.branch)
  return { ok: true, commits: work.ahead, base: work.base, branch: work.branch, removed }
}

/**
 * Delete a lane folder and its branch. Git refuses if the worktree has changes in it,
 * which is the safety net: this is only ever called on a lane that has just been proven
 * empty, and if that changed in between, git says no and nothing is lost.
 */
async function removeLane(repo: string, dir: string, branch: string): Promise<boolean> {
  await git(repo, ['worktree', 'remove', dir], 120_000)
  if (!(await finished(repo, dir))) return false
  // -d, never -D: a branch with unmerged commits keeps existing, folder or no folder.
  await git(repo, ['branch', '-d', branch])
  await git(repo, ['worktree', 'prune'])
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
async function finished(repo: string, dir: string): Promise<boolean> {
  if ((await laneFolders(repo)).some((p) => samePath(p, dir))) return false
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

/**
 * Is a process still rooted in this folder even though PaneForge has no pane metadata
 * for it?
 *
 * CLI agents keep one process alive between prompts. On POSIX a directory can be
 * unlinked while that process still uses it, so `git worktree remove` succeeds and the
 * next prompt fails before its hook can rebuild the lane. Windows refuses the removal
 * itself. `lsof -d cwd` asks the missing question on macOS/Linux without walking the
 * lane's files; if lsof is unavailable, preserving a clean lane is safer than making a
 * live session unusable.
 */
async function heldAsProcessCwd(dir: string): Promise<boolean> {
  if (process.platform === 'win32') return false
  return new Promise((done) => {
    execFile(
      'lsof',
      ['-t', '-a', '-d', 'cwd', '--', dir],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
      (err, stdout) => {
        if (!err) return done(Boolean(stdout.trim()))
        // lsof uses status 1 for the ordinary "no matching process" answer. Any other
        // failure leaves the lane intact because it could not prove the cwd is unused.
        done(Number((err as NodeJS.ErrnoException).code) !== 1)
      }
    )
  })
}

/** The main checkout a folder belongs to (itself, when it is not a worktree). */
export function repoOf(cwd: string): Promise<string | null> {
  return mainRepo(cwd)
}

/** Lane folders of this repo, whether or not anything is in them. */
export async function laneFolders(repo: string): Promise<string[]> {
  const list = await gitOut(repo, ['worktree', 'list', '--porcelain'])
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
async function absorbed(repo: string, work: LaneWork): Promise<'patch' | null> {
  const cherry = await gitOut(repo, ['cherry', work.base, work.branch])
  if (!cherry.ok) return null
  const unique = cherry.out
    .split(/\r?\n/)
    .filter(Boolean)
    .some((l) => l.startsWith('+'))
  return unique ? null : 'patch'
}

/**
 * A lane is held for as long as scripts/lane.mjs would still honour its claim.
 *
 * Matches IDLE_EMPTY_MS there on purpose: a claim lane.mjs would refuse to hand to
 * anyone else is one this file must not delete, and a claim it would hand away is fair
 * game. Two windows that disagree is how a lane gets deleted and re-created forever.
 */
const CLAIM_HELD_MS = 60 * 60 * 1000

/**
 * Which lanes somebody holds without SITTING in them.
 *
 * `busy` - the folder each live pane is in - is the whole story when this app put an
 * agent in a lane itself. It is not the story when scripts/lane.mjs hands a lane to a CLI
 * session: the hook tells that chat to work in `<repo>-a` while its pane stays in the main
 * checkout, so between the claim and the chat's first write the folder is empty, clean and
 * looks abandoned. It was then deleted out from under a chat that had been told to use it,
 * on every sweep, which reads as the worktree "vanishing" seconds after `lane claim`
 * returned its path.
 *
 * A lane waiting on a release counts as held too. `ready` and `conflicts` are work that
 * finished and has nowhere to go yet, not work nobody wants.
 */
async function heldLanes(repo: string): Promise<Set<string>> {
  const held = new Set<string>()
  // Worktrees share one ledger, and in a worktree `.git` is a file - ask git rather than
  // joining a path that only happens to be right in the main checkout.
  const common = await gitOut(repo, ['rev-parse', '--git-common-dir'])
  if (!common.ok) return held
  const file = resolve(repo, common.out.trim(), 'paneforge-lanes.json')
  let state: {
    lanes?: Record<string, { seen?: number; claimed?: number }>
    ready?: Record<string, unknown>
    conflicts?: Record<string, unknown>
  }
  try {
    // lane.mjs writes then renames, so a half-written file is impossible: a parse failure
    // means something else owns that name, and `busy` is then the only answer available.
    state = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return held
  }
  const now = Date.now()
  for (const [id, claim] of Object.entries(state.lanes ?? {}))
    if (now - (claim?.seen ?? claim?.claimed ?? 0) < CLAIM_HELD_MS) held.add(id)
  for (const id of Object.keys(state.ready ?? {})) held.add(id)
  for (const id of Object.keys(state.conflicts ?? {})) held.add(id)
  return held
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
  const held = await heldLanes(repo)
  for (const dir of await laneFolders(repo)) {
    // A pane that cd'd into a subfolder of the lane reports that subfolder, and it is
    // just as much "somebody is in there" as the lane root is.
    if (busy.some((b) => inside(b, dir))) continue
    const work = await laneWork(dir)
    if (!work || work.dirty > 0) continue
    // Claimed by a chat that is not in the folder yet. See heldLanes().
    if (held.has(work.lane)) continue
    // Ours to delete, or somebody else's worktree that happens to sit at `<repo>-a` and
    // be tidy today. laneWork() reads any lane-shaped folder on purpose - the panel should
    // describe one either way - but nothing is REMOVED unless this app or scripts/lane.mjs
    // made it, which is what the branch name says: `lane-a` now, `pf/w2` for the lanes that
    // predate the two schemes being merged.
    if (!laneBranches(work.lane).includes(work.branch)) continue
    const how = work.empty ? 'history' : await absorbed(repo, work)
    if (!how) continue
    // A paused CLI session is invisible to `busy`: its PaneForge pane can remain in the
    // main checkout while the agent process is rooted here. POSIX permits deleting that
    // cwd, but the agent cannot start its next turn afterwards.
    if (await heldAsProcessCwd(dir)) continue
    await exec(repo, ['worktree', 'remove', dir], 120_000)
    // Not the exit code - see finished(). A lane can be gone and still make git unhappy.
    if (!(await finished(repo, dir))) continue
    // `-d` is the safe delete and refuses anything the base branch does not have. A
    // squash-merged lane is exactly that case and always will be, and its patches have
    // just been shown to be in the project, so that one is deleted outright.
    await exec(repo, ['branch', how === 'history' ? '-d' : '-D', work.branch], 20_000)
    removed.push(dir)
  }
  if (removed.length) await exec(repo, ['worktree', 'prune'], 20_000)
  await dropEmptyShells(repo)
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
 * Only ever an EMPTY lane-shaped folder beside the repo, so there is nothing to lose. That
 * is also what clears the last of the old `-w<N>` folders off a machine: they stop being
 * created, their work is merged by the normal path, and the shell goes here.
 */
async function dropEmptyShells(repo: string): Promise<void> {
  const registered = await laneFolders(repo)
  const parent = dirname(repo)
  let siblings: string[] = []
  try {
    siblings = readdirSync(parent)
  } catch {
    return
  }
  for (const name of siblings) {
    if (!name.startsWith(`${basename(repo)}-`) || !LANE_DIR.test(name)) continue
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
  const work = await laneWork(cwd)
  if (!work || !work.empty) return null
  if (taken.some((t) => samePath(t, work.repo))) return null
  return work.repo
}
