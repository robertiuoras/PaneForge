// Rename this checkout family from `claude-orchestrator*` to `PaneForge*` - by itself,
// the moment it is safe to.
//
//   node scripts/rename-repo.mjs            rename now, or say why it cannot
//   node scripts/rename-repo.mjs --wait     watch, and do it the moment it becomes safe
//   node scripts/rename-repo.mjs --dry      say what it would do and stop
//   node scripts/rename-repo.mjs --to Name  a different target name
//
// Why a script and not four `mv`s:
//
// The repo is PaneForge everywhere that matters - the product, the installer, the GitHub
// remote - and only the folder is still called claude-orchestrator. Renaming it is four
// directories, not one: the main checkout plus a worktree per lane, whose `.git` files
// carry absolute paths in both directions. `git worktree move` and `git worktree repair`
// are what keep those pointers honest; renaming the folders by hand leaves every lane
// detached from the repo it belongs to.
//
// And the folders are usually LOCKED. Every chat working on PaneForge is a process whose
// working directory is one of them, and Windows refuses to rename a directory any process
// is sitting in. That is not a rare race - it is the normal state of this machine during
// the day, which is why the rename has been put off twice. So the guard is the feature:
// nothing moves while a lane is held by a live chat, while a merge is half-finished, or
// while any of the four directories is in use. `--wait` sits on those conditions and
// fires when they clear, which in practice is the moment the last chat closes.

import { spawnSync } from 'node:child_process'
import { existsSync, appendFileSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i < 0 ? fallback : args[i + 1]
}
const TO = flag('--to', 'PaneForge')
/** Where the checkout family lives, and what it is called now. Both exist so the whole
 *  thing can be run against a throwaway repo in a test (scripts/rename-repo-test.mjs). */
const ROOT = flag('--root', '')
const FROM = flag('--from', 'claude-orchestrator')
const WAIT = args.includes('--wait')
const DRY = args.includes('--dry')
/** A lane whose chat has been quiet this long is not mid-anything. */
const LANE_QUIET_MS = 45 * 60 * 1000
const POLL_MS = 30_000
const GIVE_UP_MS = 12 * 60 * 60 * 1000

const PROJECTS = ROOT || join(homedir(), 'Desktop', 'Projects')
const LOG = join(PROJECTS, '.autosync', 'paneforge-rename.log')

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`
  console.log(line)
  try {
    appendFileSync(LOG, line + '\n')
  } catch {
    /* the log is a convenience, never a reason to stop */
  }
}

const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' })

/** The main checkout: the one holding the shared .git and the lane state. */
function findMain() {
  const candidates = [join(PROJECTS, FROM), join(PROJECTS, TO)]
  if (!ROOT) candidates.push(join(homedir(), 'Projects', FROM), join(homedir(), 'Projects', TO))
  for (const dir of candidates) {
    if (existsSync(join(dir, '.git', 'paneforge-lanes.json'))) return dir
  }
  return null
}

/**
 * Can this directory be renamed at all? The only honest test on Windows is to try it:
 * there is no API that says "which process is sitting in this folder", and a process's
 * working directory holds the handle that refuses the move. Renaming it straight back
 * leaves nothing behind.
 */
function movable(dir) {
  const probe = `${dir}-rntest`
  try {
    renameSync(dir, probe)
    renameSync(probe, dir)
    return true
  } catch {
    try {
      if (existsSync(probe)) renameSync(probe, dir)
    } catch {
      /* nothing more to do - the original name is still there */
    }
    return false
  }
}

/** Everything that has to be true before anything moves. Returns a reason, or null. */
function blocked(main, worktrees) {
  const target = join(dirname(main), TO)
  if (basename(main) === TO) return 'already renamed'
  if (existsSync(target)) return `${target} already exists`

  // A chat that is still working in a lane. `seen` is stamped by the lane hook on every
  // prompt, so a stale one is a chat that has closed or moved on.
  try {
    const state = JSON.parse(readFileSync(join(main, '.git', 'paneforge-lanes.json'), 'utf8'))
    const now = Date.now()
    for (const [id, lane] of Object.entries(state.lanes ?? {})) {
      if (lane?.seen && now - lane.seen < LANE_QUIET_MS) {
        return `lane ${id} is held by a live chat (last seen ${Math.round((now - lane.seen) / 60000)}m ago)`
      }
    }
    if (Object.keys(state.conflicts ?? {}).length) return 'a lane is mid-conflict'
    if (state.release) return 'a release is in flight'
  } catch (e) {
    return `cannot read the lane state: ${e.message}`
  }

  for (const dir of [main, ...worktrees]) {
    // A half-finished merge is the one state no other process may touch.
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, '.git', 'MERGE_HEAD'))) {
      const r = git(dir, 'rev-parse', '--git-dir')
      const gitDir = r.status === 0 ? r.stdout.trim() : ''
      const abs = gitDir && (gitDir.startsWith('/') || /^[A-Za-z]:/.test(gitDir)) ? gitDir : join(dir, gitDir)
      if (gitDir && existsSync(join(abs, 'MERGE_HEAD'))) return `${basename(dir)} is mid-merge`
    }
    if (!movable(dir)) return `${basename(dir)} is in use by a running process`
  }
  return null
}

function worktreeDirs(main) {
  const r = git(main, 'worktree', 'list', '--porcelain')
  if (r.status !== 0) return []
  return r.stdout
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim().replace(/\//g, '\\'))
    .filter((d) => d.toLowerCase() !== main.toLowerCase())
}

function rename(main, worktrees) {
  const parent = dirname(main)
  const oldBase = basename(main)
  const target = join(parent, TO)

  // Worktrees first, while the main checkout is still where every `.git` file says it is.
  // `git worktree move` rewrites both ends of the pointer; a plain rename rewrites neither.
  for (const dir of worktrees) {
    const suffix = basename(dir).slice(oldBase.length) // '-a', '-b', ...
    const dest = join(parent, TO + suffix)
    const r = git(main, 'worktree', 'move', dir, dest)
    if (r.status !== 0) throw new Error(`worktree move ${basename(dir)}: ${r.stderr.trim()}`)
    log(`moved ${basename(dir)} -> ${basename(dest)}`)
  }

  renameSync(main, target)
  log(`moved ${oldBase} -> ${TO}`)

  // The worktrees' `.git` files still point at the old main path; repair rewrites them
  // from wherever the repo actually is now.
  const repair = git(target, 'worktree', 'repair', ...worktreeDirs(target))
  if (repair.status !== 0) log(`worktree repair said: ${repair.stderr.trim()}`)
  const check = git(target, 'worktree', 'list')
  log(`worktrees now:\n${check.stdout.trim()}`)

  // The lane state stores the folder each chat was launched from. Paths that pointed
  // into the old checkout would otherwise refuse the next chat its own lane.
  const stateFile = join(target, '.git', 'paneforge-lanes.json')
  try {
    const raw = readFileSync(stateFile, 'utf8')
    const fixed = raw.replaceAll(oldBase, TO).replaceAll(oldBase.replace(/\\/g, '/'), TO)
    if (fixed !== raw) {
      writeFileSync(stateFile, fixed)
      log('lane state paths rewritten')
    }
  } catch (e) {
    log(`could not rewrite the lane state: ${e.message}`)
  }

  return target
}

function main() {
  const started = Date.now()
  const run = () => {
    const repo = findMain()
    if (!repo) return { done: true, msg: 'no PaneForge checkout on this machine' }
    const worktrees = worktreeDirs(repo)
    const why = blocked(repo, worktrees)
    if (why === 'already renamed') return { done: true, msg: 'already renamed' }
    if (why) return { done: false, msg: why }
    if (DRY) {
      return {
        done: true,
        msg: `would rename ${basename(repo)} and ${worktrees.length} worktree(s) to ${TO}*`
      }
    }
    try {
      const target = rename(repo, worktrees)
      return { done: true, msg: `renamed to ${target}` }
    } catch (e) {
      return { done: true, msg: `FAILED: ${e.message}` }
    }
  }

  const tick = () => {
    const r = run()
    if (r.done) {
      log(r.msg)
      // Installed as a scheduled task (it has to survive a reboot: the folders are only
      // ever free when nothing is running in them, which can be days away), it takes
      // itself off the machine once there is nothing left to do.
      const task = flag('--task', '')
      if (task && !DRY && !r.msg.startsWith('FAILED')) {
        const del = spawnSync('schtasks', ['/Delete', '/TN', task, '/F'], { encoding: 'utf8' })
        log(del.status === 0 ? `scheduled task ${task} removed` : `could not remove ${task}: ${del.stderr?.trim()}`)
      }
      process.exit(0)
    }
    if (!WAIT) {
      log(`not renaming: ${r.msg}`)
      process.exit(1)
    }
    if (Date.now() - started > GIVE_UP_MS) {
      log(`gave up waiting: ${r.msg}`)
      process.exit(1)
    }
    setTimeout(tick, POLL_MS)
  }
  if (WAIT) log(`waiting for a safe moment to rename to ${TO}*`)
  tick()
}

main()
