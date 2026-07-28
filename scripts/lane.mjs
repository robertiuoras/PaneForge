// Lanes: how several chats work on PaneForge at the same time without stepping on
// each other, and without anyone having to type a command to set it up.
//
// The problem this solves. PaneForge is edited from chats that live inside PaneForge,
// and those chats start in whatever project folder they happen to be in - one in
// Toolstash asks for a feature, one in assistant asks for a bugfix, minutes apart.
// Sharing one checkout means: two `npm run build` runs writing the same out/ (the
// second app to launch is half-written, with no error anywhere), two version bumps
// racing to tag, and two GitHub releases going out back to back for what should have
// been one.
//
// A lane is one checkout claimed by one session:
//
//   main   the repository itself, on master  - the first chat gets this, so solo work
//          is exactly as it always was, no branch, no merge
//   a, b   git worktrees beside it on branches lane-a / lane-b, with node_modules
//          junctioned back to main so there is no second 300 MB Electron install
//
// Claiming is automatic (a UserPromptSubmit hook calls `claim`), enforcement is
// automatic (a PreToolUse hook calls `guard`, which refuses an edit in someone else's
// lane), and releasing is serialized: lanes mark themselves `ready`, and `ship` merges
// every ready lane into ONE version bump behind a lock. A second chat that tries to
// ship while that is happening is told its work is already included, and exits
// successfully instead of cutting v0.3.6 thirty seconds after v0.3.5.
//
// CLI (all of it is called by hooks or by an agent, never by hand):
//   node scripts/lane.mjs claim --session <id>     -> JSON lane for this session
//   node scripts/lane.mjs guard --session <id> --path <file>
//   node scripts/lane.mjs status
//   node scripts/lane.mjs resolve --session <id> [--lane b]   take over a stuck lane
//   node scripts/lane.mjs ready --session <id>     mark this lane's branch shippable
//   node scripts/lane.mjs ship [patch|minor|major] merge ready lanes, one release
//   node scripts/lane.mjs autoship                 ship, but only if no chat is mid-work
//   node scripts/lane.mjs retry                    re-try stuck lanes (the app, on a timer)
//   node scripts/lane.mjs release --session <id>   give the lane back (SessionEnd)
//
// Nothing above is typed by hand. `ready` and `release` both end in `autoship`, so the
// release happens by itself the moment the LAST chat with unfinished PaneForge work
// stops having any: whoever finishes last cuts the version, for everyone.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestApps } from './test-app.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------- repo geography

// Every git call gets a deadline. A `git rev-parse --git-common-dir` left over from a
// dead chat sat in this folder for 23 hours on 2026-07-27, and its bash and conhost
// parents with it: the hook kills the lane.mjs it spawned after 25s, but nothing killed
// the git underneath, and a live conhost holding the checkout is what blocked the
// PaneForge rename for two days (EBUSY, no cwd in the folder - a stray handle).
// Timing out throws, which gitSafe already reports and the callers already handle.
const GIT_TIMEOUT_MS = 20_000

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL'
  }).trim()
}
function gitSafe(cwd, ...args) {
  try {
    return { ok: true, out: git(cwd, ...args) }
  } catch (e) {
    return { ok: false, out: String(e.stderr ?? e.stdout ?? e.message).trim() }
  }
}

// This file can live in a worktree, so "the repo" always means the MAIN checkout:
// git-common-dir points at <main>/.git from anywhere inside any worktree.
const commonDir = resolve(join(here, '..'), git(join(here, '..'), 'rev-parse', '--git-common-dir'))
const MAIN = dirname(commonDir)
const STATE = join(commonDir, 'paneforge-lanes.json')

/** Lane pool. `main` first: one chat alone should never be pushed onto a branch. */
// Worktrees are only created when a lane is first handed out, so headroom is free.
const POOL = ['main', 'a', 'b', 'c']
const laneDir = (id) => (id === 'main' ? MAIN : join(dirname(MAIN), `${basename(MAIN)}-${id}`))
const laneBranch = (id) => (id === 'main' ? 'master' : `lane-${id}`)
/** Matches scripts/try.mjs, which derives the PaneForge profile from the folder name. */
const laneProfile = (id) => (id === 'main' ? 'dev' : `dev-${id}`)

// A claim is dropped after this long without the session being seen. Sessions usually
// end with a SessionEnd hook that frees the lane properly; this is for the ones that
// die with the terminal.
const STALE_MS = 12 * 60 * 60 * 1000
// A lane that has nothing in it - clean tree, no commits master lacks, no ready mark, no
// conflict - and whose chat has not been seen for this long is given up when someone else
// needs a checkout and there is none. Four chats opened hours apart, three of them idle
// with nothing to show for it, is how a chat that had work to do got told "all lanes busy"
// and had to wait for a human to close a window. Nothing can be lost: a lane with so much
// as one uncommitted character is never taken, however long it has been quiet.
const IDLE_EMPTY_MS = 60 * 60 * 1000
// A chat that only MENTIONED PaneForge gets a lane on approval, not on the word. Saying
// "why does PaneForge show X" from a Jarvis chat used to claim a real lane: the pane then
// wore a "PF lane main" chip for a chat that never opened the repo, and a chat that did
// want to edit could be told every lane was busy by three of those. Such a claim is
// tentative - it reserves a checkout so the agent knows where to work, it is invisible to
// the app and to every other chat, it never delays a release, and it disappears on its own
// after this long unless the chat actually writes in the lane (`guard` promotes it).
const TENTATIVE_MS = 20 * 60 * 1000
// A ship that has not finished in this long crashed or was killed mid-way.
const LOCK_MS = 20 * 60 * 1000
// Automatic releases batch inside this window. Without it every finished chunk of work
// cut its own version - 15 releases in one day on 2026-07-26. That was expensive only
// because each release interrupted somebody with an update prompt; updates now install
// on exit instead (see src/main/updater.ts), so a release costs nothing to ignore and
// the window is short. Work is never lost by waiting: it sits on master and goes out
// with the next release, which every later `ready` and every SessionEnd triggers - so
// it ships the next time anyone finishes anything here, and `npm run ship` still
// releases immediately when something must go out now.
const COOLDOWN_MS = 30 * 60 * 1000
// A conflicted lane whose own chat has been quiet this long is nobody's problem, which
// is how lane b sat conflicted for a day: the one chat that could fix it had moved on,
// and every other chat was only told about it as a fact. After this, any live chat may
// take the conflict over (`resolve`), and the prompt hook tells them how.
const ADOPT_MS = 45 * 60 * 1000
// How often a conflict is re-tried by itself. Master moves under a conflicted lane all
// day; most conflicts stop existing the moment the other side of them ships, and rerere
// already knows the answer to a good few of the rest. Retrying costs one merge attempt
// that is aborted on failure, so the cheap half of "resolve it permanently" is free.
const RETRY_MS = 10 * 60 * 1000

// ---------------------------------------------------------------- state file
// Lives in .git/, which is shared by every worktree and never committed.

function now() {
  return Date.now()
}

function read() {
  try {
    const s = JSON.parse(readFileSync(STATE, 'utf8'))
    s.lanes ??= {}
    s.ready ??= {}
    s.conflicts ??= {}
    s.release ??= null
    s.lastShip ??= null
    return s
  } catch {
    return { lanes: {}, ready: {}, conflicts: {}, release: null, lastShip: null }
  }
}

function write(state) {
  // Write-then-rename: two hooks can fire at the same moment from two chats, and a
  // half-written state file would strand every lane at once.
  const tmp = `${STATE}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  renameSync(tmp, STATE)
}

/**
 * Give back every conflict a chat had taken over, because that chat is gone.
 *
 * Taking a conflict over is a claim on somebody else's lane, and until now nothing ever
 * ended one: a chat adopted a conflict, finished its session, and the claim outlived it.
 * The lane then read "a chat has it" with no chat behind it - the app's automatic
 * hand-over skips a claimed conflict on exactly that word, the fix button is hidden on it,
 * and `adoptable` holds every other chat off for another 45 minutes on behalf of a session
 * that no longer exists. That is how lane c stayed stuck with nobody near it. A claim now
 * ends when its chat's lane does; the ADOPT_MS clock stays as the backstop for a chat that
 * goes quiet without ever ending.
 */
function dropClaims(state, session) {
  if (!session) return
  for (const c of Object.values(state.conflicts)) {
    if (c.resolver === session) {
      c.resolver = null
      c.resolverAt = null
    }
  }
}

/**
 * Set by `reap` when it actually dropped something, so a read-only command can persist the
 * clean-up instead of doing it again on the next call.
 *
 * `status` reaps like every other command and then threw the result away, because it does
 * not write. That was invisible while everything reaped was hours old - but a tentative
 * reservation expires in 20 minutes, and `status` is what the app and the hooks call most,
 * so the expiry could be computed a hundred times and never once take effect. Anything
 * that reaps now has the option of writing it down.
 */
let reaped = false

function reap(state) {
  for (const [id, c] of Object.entries(state.lanes)) {
    // A lane reserved by a chat that only talked about PaneForge and never touched it.
    // Nothing can be lost - a tentative lane is by definition one nothing was written in -
    // but check anyway, because `guard` promotes on the first write and a crash between
    // the write and the promote must not throw the write away.
    if (c.tentative && now() - (c.claimed ?? 0) > TENTATIVE_MS) {
      const w = laneWork(id)
      if (!w.dirty && w.ahead === 0 && !state.ready[id] && !state.conflicts[id]) {
        dropClaims(state, c.session)
        delete state.lanes[id]
        reaped = true
        continue
      }
      delete c.tentative
      reaped = true
    }
    if (now() - (c.seen ?? c.claimed ?? 0) > STALE_MS) {
      // A chat that died without a SessionEnd hook never released its lane, and never
      // closed the `npm run try` window it left running either. Both go here.
      dropClaims(state, c.session)
      delete state.lanes[id]
      closeTestApps(laneDir(id))
    }
  }
  if (state.release && now() - state.release.at > LOCK_MS) state.release = null
  // A conflict or a ready mark for work master already has is noise that never clears
  // itself: it made `status` report a lane as conflicted long after the conflict was
  // resolved, and left chats resolving something that had already gone out. Usually
  // zero iterations - this only walks lanes that are actually flagged.
  for (const id of Object.keys(state.conflicts)) {
    if (id !== 'main' && aheadOf(laneBranch(id)) === 0) delete state.conflicts[id]
  }
  for (const id of Object.keys(state.ready)) {
    if (id !== 'main' && aheadOf(laneBranch(id)) === 0) delete state.ready[id]
  }
  // `ready.main` is a statement by one chat that ITS work on master is finished, and it
  // outlived that chat: the next chat to claim main inherited it, so its pane read "PF
  // lane main done" for work it had never seen, and the strip said a lane was waiting on a
  // release for a chat that had gone home. Nothing is lost by dropping it - master's
  // unreleased commits are what `shippable()` counts, with or without a mark - so the mark
  // means only what it says, and stops meaning it when the chat that made it is gone.
  if (state.ready.main?.session && state.lanes.main?.session !== state.ready.main.session) {
    delete state.ready.main
    reaped = true
  }
  // A chat that marked itself ready and then kept editing is working again, and its
  // ready mark is a lie. Left standing it stalled every release silently: `busyLanes`
  // trusts the mark and skips the lane, so `autoship` believed nobody was mid-work and
  // called `ship`, which aborted on the dirty checkout - and `autoship` swallows that
  // error, so nothing released and nothing said why until some other chat happened to
  // finish something. Dropping the mark puts the lane back in `busyLanes`, where the
  // wait is reported by name and the next `ready` releases for real.
  for (const [id, mark] of Object.entries(state.ready)) {
    if (!existsSync(laneDir(id))) continue
    const dir = laneDir(id)
    const moved = mark.commit && gitSafe(dir, 'rev-parse', 'HEAD').out !== mark.commit
    if (moved || Boolean(gitSafe(dir, 'status', '--porcelain').out)) delete state.ready[id]
  }
  return state
}

// ---------------------------------------------------------------- keeping lanes mergeable

/**
 * Resolve once, replay forever.
 *
 * A lane merges master and its chat fixes the conflict; the release later merges that lane
 * INTO master and meets the same conflict from the other side. rerere replays the recorded
 * resolution, so the second half of every conflict is settled without anyone being asked.
 * The setting lives in the shared .git dir, so every worktree inherits it.
 */
function enableRerere() {
  gitSafe(MAIN, 'config', 'rerere.enabled', 'true')
  gitSafe(MAIN, 'config', 'rerere.autoupdate', 'true')
}

/**
 * Bring one lane up to master.
 *
 * Conflicts are cheap here and expensive later: in the lane, the chat that wrote the code is
 * alive and holding the context. At release time it is a stranger's problem, the lane sits
 * conflicted for hours, and auto-sync starts shouting about unmerged files. So lanes catch
 * up early and often, and a conflict is left IN the lane for its own chat to resolve.
 *
 * Returns { moved, conflicts, dirty } - conflicts is the unmerged file list.
 */
function catchUp(id, { keepConflict = false } = {}) {
  const dir = laneDir(id)
  if (id === 'main' || !existsSync(dir)) return { moved: false, conflicts: [], dirty: false }
  // Never merge on top of someone's uncommitted edit.
  if (gitSafe(dir, 'status', '--porcelain').out) return { moved: false, conflicts: [], dirty: true }
  // Already contains master -> nothing to do (and no empty merge commit).
  if (gitSafe(dir, 'merge-base', '--is-ancestor', 'master', 'HEAD').ok) {
    return { moved: false, conflicts: [], dirty: false }
  }
  enableRerere()
  const m = gitSafe(dir, 'merge', '--no-edit', 'master')
  if (m.ok) return { moved: true, conflicts: [], dirty: false }
  const conflicts = gitSafe(dir, 'diff', '--name-only', '--diff-filter=U')
    .out.split('\n')
    .filter(Boolean)
  // The half-merge is only left in the tree for the chat that asked to finish this lane
  // (`ready`), which is the one moment someone is there to resolve it. Every other caller
  // gets the lane back the way it found it - a conflicted checkout nobody owns is what
  // stalled lane-b for a day and made auto-sync pop "unmerged files" every run.
  if (!keepConflict || !conflicts.length) gitSafe(dir, 'merge', '--abort')
  return { moved: false, conflicts, dirty: false }
}

/**
 * Make a free lane safe to hand to a new chat.
 *
 * A lane released by a chat that stopped mid-merge used to stay conflicted forever: no chat
 * owned it, so nobody resolved it, and every auto-sync run tripped over it. Nothing here can
 * lose work - it only touches a lane no live session holds, only aborts a merge that was
 * never finished, and only resets a branch whose commits master already has.
 */
function healLane(id) {
  const dir = laneDir(id)
  if (id === 'main' || !existsSync(dir)) return null
  const did = []
  if (gitSafe(dir, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD').ok) {
    gitSafe(dir, 'merge', '--abort')
    did.push('aborted an unfinished merge')
  }
  if (gitSafe(dir, 'rev-parse', '--verify', '--quiet', 'REBASE_HEAD').ok) {
    gitSafe(dir, 'rebase', '--abort')
    did.push('aborted an unfinished rebase')
  }
  const clean = !gitSafe(dir, 'status', '--porcelain').out
  if (clean && aheadOf(laneBranch(id)) === 0) {
    // Every change in this lane is already in master: start the next chat from master
    // instead of from a branch full of commits that only look unshipped.
    if (gitSafe(dir, 'reset', '--hard', 'master').ok) did.push('reset to master')
  } else if (clean) {
    const c = catchUp(id)
    if (c.moved) did.push('merged master')
    if (c.conflicts.length) did.push(`conflicts with master in ${c.conflicts.join(', ')}`)
  }
  return did.length ? did.join(', ') : null
}

// ---------------------------------------------------------------- conflicts

/**
 * Record a conflict without losing when it started.
 *
 * `since` is the whole point: a conflict that is minutes old belongs to the chat that
 * made it, and one that is hours old belongs to whoever is still here. Overwriting the
 * record on every release (which is what used to happen) reset the clock and made every
 * conflict look new forever, so nothing ever escalated.
 */
function noteConflict(bag, id, detail, previous) {
  const was = (previous ?? bag)[id]
  bag[id] = {
    at: now(),
    since: was?.since ?? now(),
    dir: laneDir(id),
    detail,
    resolver: was?.resolver ?? null,
    resolverAt: was?.resolverAt ?? null,
    master: gitSafe(MAIN, 'rev-parse', 'master').out,
    retryAt: now() + RETRY_MS
  }
  return bag[id]
}

/**
 * The files out of a failed merge's output. `git merge` says a great deal (auto-merging
 * this, recording a preimage for that) and the record kept all of it, so what the app
 * and the hooks showed a human was four lines of rerere bookkeeping instead of "these
 * files disagree".
 */
function mergeFiles(out) {
  const files = new Set()
  for (const line of out.split('\n')) {
    const conflict = /Merge conflict in (.+)$/.exec(line)
    const preimage = /Recorded preimage for '(.+)'/.exec(line)
    if (conflict) files.add(conflict[1].trim())
    else if (preimage) files.add(preimage[1])
  }
  return files.size ? [...files].join(', ') : out.split('\n').slice(0, 4).join('; ')
}

/**
 * Try every recorded conflict again, quietly.
 *
 * Half of these stop existing on their own: the change they conflicted with ships, or
 * rerere has since been taught the resolution in some other lane. Re-trying is one merge
 * that aborts itself on failure, throttled to RETRY_MS and skipped entirely while master
 * has not moved - so the common case costs a `rev-parse`.
 *
 * Returns true when the state changed and the caller should write it.
 */
function retryConflicts(state) {
  let changed = false
  const head = gitSafe(MAIN, 'rev-parse', 'master').out
  for (const [id, c] of Object.entries(state.conflicts)) {
    if (id === 'main' || !existsSync(laneDir(id))) continue
    if (c.retryAt && now() < c.retryAt && c.master === head) continue
    // A `ready` that hit a conflict leaves the merge open for its own chat to resolve.
    // When that chat never comes back, the open merge is what blocks the retry (a lane
    // mid-merge reads as dirty), so the conflict could never clear itself - the exact
    // shape of lane b sitting stuck for a day. Once the lane is adoptable the half-merge
    // has no owner: drop it and try again, with whatever rerere has learned since.
    if (adoptable(state, id) && gitSafe(laneDir(id), 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD').ok) {
      gitSafe(laneDir(id), 'merge', '--abort')
    }
    const caught = catchUp(id)
    // Someone left an uncommitted edit in there, so the merge cannot be done in the
    // worktree. That used to end the retry, which meant a lane whose chat stopped
    // mid-edit stayed flagged for as long as the edit sat there - the conflict could not
    // clear even after master moved past the thing it disagreed with. Lane c sat like
    // that. The flag is still answerable without touching any file: merge-tree does the
    // merge in the object database, so a lane that would merge cleanly stops being called
    // stuck. Advancing it still waits for the worktree to be clean.
    if (caught.dirty) {
      if (offTreeConflicts(id) === false) {
        delete state.conflicts[id]
        changed = true
      }
      continue
    }
    changed = true
    if (!caught.conflicts.length) {
      delete state.conflicts[id]
      // It merges now, so the work that was left out of a release goes into the next one
      // without anybody being asked. This is the case that used to need a human.
      if (!state.ready[id] && aheadOf(laneBranch(id)) > 0) {
        try {
          markReady(state, id)
        } catch {
          /* nothing mergeable after all */
        }
      }
      continue
    }
    c.master = head
    c.retryAt = now() + RETRY_MS
    c.detail = caught.conflicts.join(', ')
  }
  return changed
}

/**
 * Would this lane still conflict with master, asked without touching the worktree?
 *
 * `git merge-tree --write-tree` merges two commits in the object database and writes
 * nothing outside it, so this is safe to ask about a lane somebody has uncommitted edits
 * in - which is the only reason it exists. Returns true/false, or null when git is too
 * old to answer (the caller then leaves the conflict where it was).
 */
function offTreeConflicts(id) {
  const r = gitSafe(MAIN, 'merge-tree', '--write-tree', '--name-only', 'master', laneBranch(id))
  if (r.ok) return false
  if (/unknown option|usage:|not a valid object/i.test(r.out)) return null
  return true
}

/** A conflict nobody is fixing: its lane's chat has been quiet long enough to hand over. */
function adoptable(state, id) {
  const c = state.conflicts[id]
  if (!c) return false
  // A chat that already adopted this conflict is IN that worktree with a half-finished
  // merge open. Calling that unowned is how the retry below came to abort a resolution
  // in progress - so the adopter owns it on the same terms the lane's own chat does, and
  // loses it after the same silence.
  if (c.resolverAt && now() - c.resolverAt < ADOPT_MS) return false
  const holder = state.lanes[id]
  if (!holder) return true
  return now() - (holder.seen ?? holder.claimed ?? 0) > ADOPT_MS
}

// ---------------------------------------------------------------- worktree setup

function ensureWorktree(id) {
  const dir = laneDir(id)
  if (id === 'main') return dir
  if (!existsSync(dir)) {
    const branch = laneBranch(id)
    const known = gitSafe(MAIN, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).ok
    // A reused lane branch may be behind master; start it fresh from master when new.
    const add = known
      ? ['worktree', 'add', dir, branch]
      : ['worktree', 'add', '-b', branch, dir, 'master']
    const r = gitSafe(MAIN, ...add)
    if (!r.ok) throw new Error(`could not create lane ${id}: ${r.out}`)
  }
  const link = join(dir, 'node_modules')
  if (!existsSync(link)) {
    // 'junction' needs no admin rights on Windows; on macOS the type is ignored and
    // this is a plain directory symlink. Either way there is no second install.
    try {
      mkdirSync(dirname(link), { recursive: true })
      symlinkSync(join(MAIN, 'node_modules'), link, 'junction')
    } catch {
      /* npm install in the lane still works, it is just slower */
    }
  }
  return dir
}

// ---------------------------------------------------------------- commands

function claim(session, cwd, prefer, tentative = false) {
  if (!session) throw new Error('claim needs --session')
  const state = reap(read())
  // Cheap, throttled, and the reason most conflicts never reach a human.
  retryConflicts(state)

  for (const [id, c] of Object.entries(state.lanes)) {
    if (c.session === session) {
      c.seen = now()
      // Once a chat has written in its lane the lane is really held, and a later prompt
      // that happens not to mention PaneForge must not hand it back.
      if (!tentative) delete c.tentative
      else {
        // The other direction, for a lane claimed before any of this existed (or by a
        // chat that has since done nothing with it): a chat prompting from outside the
        // checkout family, with an untouched lane, is a chat talking about PaneForge.
        // Downgrading costs it nothing - the lane stays its lane - and it stops an idle
        // mention from wearing a chip and from being counted as another chat at work.
        // Work in the lane is the answer whatever the prompt said: a chat with an edit or
        // a commit in there is working on PaneForge even if this particular message was
        // sent from somewhere else and never named it.
        const w = laneWork(id)
        if (!w.dirty && w.ahead === 0) c.tentative = true
        else delete c.tentative
      }
      write(state)
      return {
        lane: id,
        dir: laneDir(id),
        branch: laneBranch(id),
        profile: laneProfile(id),
        fresh: false,
        tentative: Boolean(c.tentative)
      }
    }
  }

  // `prefer` is how a chat that was already mid-edit in a checkout when lanes were
  // switched on keeps that checkout, uncommitted work and all, instead of being sent
  // to an empty lane and losing sight of it.
  // A lane with finished work waiting on a release is free to hand out, but it is the LAST
  // one to hand out: a new chat that lands there starts on top of somebody else's shipped-
  // but-unreleased commits, and its pane reads "done" before it has done anything.
  const spare = POOL.filter((id) => !state.lanes[id])
  let free =
    (prefer && !state.lanes[prefer] ? prefer : null) ??
    spare.find((id) => !state.ready[id] && !state.conflicts[id]) ??
    spare[0]
  // Nothing free: before refusing, look for a lane that is being held and not used. The
  // oldest one goes, so a chat that has at least been seen recently keeps its checkout.
  if (!free) {
    const idle = Object.entries(state.lanes)
      .filter(([id, c]) => {
        // A lane only reserved by a mention is idle the moment anyone actually needs one.
        if (!c.tentative && now() - (c.seen ?? c.claimed ?? 0) < IDLE_EMPTY_MS) return false
        if (state.ready[id] || state.conflicts[id]) return false
        const w = laneWork(id)
        return !w.dirty && w.ahead === 0
      })
      .sort((a, b) => (a[1].seen ?? 0) - (b[1].seen ?? 0))[0]
    if (idle) {
      delete state.lanes[idle[0]]
      closeTestApps(laneDir(idle[0]))
      free = idle[0]
    }
  }
  if (!free) {
    // Every lane is held by a live session. Better to say so than to hand out a
    // checkout two chats are already sharing.
    const held = Object.entries(state.lanes).map(([id, c]) => `${id} (${c.cwd ?? '?'})`)
    throw new Error(`all lanes busy: ${held.join(', ')}`)
  }

  const dir = ensureWorktree(free)
  enableRerere()
  // A lane is handed over clean and current, never mid-merge and never stale: whatever the
  // last chat left behind is settled here, before this one writes a line.
  const healed = healLane(free)
  if (healed) {
    if (/conflicts with master/.test(healed)) noteConflict(state.conflicts, free, healed)
    else delete state.conflicts[free]
  }
  state.lanes[free] = { session, cwd: cwd ?? null, claimed: now(), seen: now(), ...(tentative ? { tentative: true } : {}) }
  write(state)
  return { lane: free, dir, branch: laneBranch(free), profile: laneProfile(free), fresh: true, healed, tentative }
}

/**
 * Does this session own the checkout it is about to write to?
 *
 * Returns null to allow. Returns a sentence to refuse with - the hook shows it to the
 * agent, which then does the same edit in the right folder. This is the part that has
 * to be a hook rather than an instruction: an agent that never read the instruction,
 * or forgot it 200k tokens later, still cannot corrupt another chat's checkout.
 */
function guard(session, path) {
  if (!session || !path) return null
  const target = resolve(path)
  const inside = (dir) => target === dir || target.startsWith(dir + sep)

  const owned = POOL.map((id) => ({ id, dir: laneDir(id) })).filter((l) => inside(l.dir))
  if (!owned.length) return null
  // Longest path wins: <repo>-a also starts with <repo> on the string level only, but
  // resolve()+sep already prevents that. Sort anyway for nested oddities.
  owned.sort((x, y) => y.dir.length - x.dir.length)
  const lane = owned[0]

  const state = reap(read())
  const holder = state.lanes[lane.id]
  if (holder?.session === session) {
    holder.seen = now()
    // Writing in the lane is the moment a reservation becomes a real claim: this chat is
    // editing PaneForge, not talking about it, so the lane is now its lane.
    delete holder.tentative
    write(state)
    return null
  }
  // A chat that took over a stuck conflict has to be able to write in that lane, even
  // though another session still nominally holds it. Without this the takeover is
  // advice rather than a mechanism.
  if (state.conflicts[lane.id]?.resolver === session) return null
  if (!holder) {
    // Unclaimed checkout: claim THIS one for the session rather than refusing. An
    // agent that opened the repo directly, or was already working here before lanes
    // existed, should simply carry on.
    try {
      const got = claim(session, dirname(target), lane.id)
      if (got.lane === lane.id) return null
      return `PaneForge: this session's lane is ${got.dir}. Make the change there, not in ${lane.dir}.`
    } catch {
      return null
    }
  }
  const mine = Object.entries(state.lanes).find(([, c]) => c.session === session)
  const where = mine ? laneDir(mine[0]) : null
  return (
    `PaneForge: ${lane.dir} belongs to another chat right now.` +
    (where
      ? ` Yours is ${where} - make the same change there.`
      : ' Run `node scripts/lane.mjs claim --session <id>` to get your own checkout.')
  )
}

// ---------------------------------------------------------------- what a lane holds

/** Commits on master that no tag has gone out with yet. */
function unreleasedOnMaster() {
  try {
    const version = JSON.parse(readFileSync(join(MAIN, 'package.json'), 'utf8')).version
    const r = gitSafe(MAIN, 'rev-list', '--count', `v${version}..HEAD`)
    return r.ok ? Number(r.out) : 0
  } catch {
    return 0
  }
}

/**
 * Commits in a lane that master does not already have the CHANGE of.
 *
 * `rev-list --count` counts commit ids, and a lane whose history was rewritten (a rebase
 * anywhere near it) is full of new ids for changes master shipped long ago - a lane that
 * reads as 5 commits of work forever, blocking releases and merging nothing. `git cherry`
 * compares patches, so a duplicate counts as what it is: already released.
 */
function aheadOf(branch) {
  const r = gitSafe(MAIN, 'cherry', 'master', branch)
  if (!r.ok) return 0
  return r.out.split('\n').filter((l) => l.startsWith('+')).length
}

/** Work sitting in a lane: uncommitted files, and commits the release does not have. */
function laneWork(id) {
  const dir = laneDir(id)
  if (!existsSync(dir)) return { dirty: false, ahead: 0 }
  const dirty = Boolean(gitSafe(dir, 'status', '--porcelain').out)
  if (id === 'main') return { dirty, ahead: unreleasedOnMaster() }
  return { dirty, ahead: aheadOf(laneBranch(id)) }
}

/**
 * Chats that would lose by a release happening right now: still holding a lane, work in
 * it, and not done with it. Half-finished work is the only reason to wait - a lane that
 * is idle, or already marked ready, is no reason for everyone else's work to sit.
 */
function busyLanes(state) {
  return Object.keys(state.lanes).filter((id) => {
    if (state.ready[id]) return false
    const w = laneWork(id)
    // `main` is master, which is the release branch: a commit there is not work in
    // progress, it is work that is already in the next release, and counting it as
    // half-finished held every other lane's work behind whichever chat happened to hold
    // main until that chat closed its window. It waits while master is DIRTY - an edit
    // nobody has committed - and not a moment longer.
    if (id === 'main') return w.dirty
    return w.dirty || w.ahead > 0
  })
}

/** Anything a release would actually put out. */
function shippable(state) {
  if (unreleasedOnMaster() > 0) return true
  return Object.keys(state.ready).some((id) => id !== 'main' && laneWork(id).ahead > 0)
}

/** Empty when master compiles (or has no typecheck script), a sentence when it does not. */
function typecheckFailure() {
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(MAIN, 'package.json'), 'utf8'))
  } catch {
    return null
  }
  if (!pkg.scripts?.typecheck) return null
  // One string + shell: npm on Windows is npm.cmd, which cannot be spawned directly.
  const r = spawnSync('npm run --silent typecheck', {
    cwd: MAIN,
    encoding: 'utf8',
    timeout: 150_000,
    shell: true
  })
  if (r.status === 0) return null
  const detail = `${r.stdout ?? ''}${r.stderr ?? ''}`
    .split('\n')
    .filter((l) => /error TS/.test(l))
    .slice(0, 3)
    .join('; ')
  return `master does not typecheck, so it was not released${detail ? ` - ${detail}` : ''}. Fix it and it goes out by itself.`
}

/**
 * The release nobody has to ask for. Called at the end of `ready` and of `release`, so
 * the version goes out the moment the last chat with unfinished work finishes it - and
 * silently does nothing while any chat is still mid-edit.
 */
function autoship(kind = 'patch', session = 'auto') {
  const state = reap(read())
  // A conflict that has quietly stopped being a conflict should not keep work out of
  // this release: try them all again before deciding what is shippable.
  if (retryConflicts(state)) write(state)
  if (state.release) return { shipped: false, reason: 'another chat is mid-release' }
  const busy = busyLanes(state)
  if (busy.length) return { shipped: false, reason: `waiting on chats still working: ${busy.join(', ')}` }
  if (!shippable(state)) return { shipped: false, reason: 'nothing to release' }
  const since = state.lastShip ? now() - state.lastShip.at : Infinity
  if (since < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - since) / 60000)
    return {
      shipped: false,
      // Says "still on its lane", not "on master": the merge happens inside ship(),
      // which this return skips. An agent told the work is already on master goes
      // looking for it there, does not find it, and starts undoing a release that was
      // only ever waiting on the clock. Cost that exactly once, 2026-07-28.
      reason: `v${state.lastShip.version} went out ${Math.round(since / 60000)}m ago. The work is committed and still on its lane; it merges and goes out with the next release (about ${wait}m). Do not ship it separately - run autoship again then.`
    }
  }
  // Nobody is watching an automatic release, so it checks itself first. A tag that fails
  // to compile costs a broken GitHub build and a version number that never produced an
  // installer - and the next chat inherits both.
  const broken = typecheckFailure()
  if (broken) return { shipped: false, reason: broken }
  try {
    return ship(kind, session)
  } catch (e) {
    // A release that cannot go out must never break the hook that asked for it.
    return { shipped: false, reason: e.message }
  }
}

function markReady(state, id) {
  const dir = laneDir(id)
  // Whose declaration this is. Only `main` uses it (see reap), but recording it everywhere
  // costs nothing and makes the file answer "who said this was done".
  const session = state.lanes[id]?.session ?? null
  if (id === 'main') {
    state.ready.main = { at: now(), commit: git(dir, 'rev-parse', 'HEAD'), session }
    return { lane: id, note: 'master is the release branch - nothing to merge' }
  }
  const ahead = aheadOf(laneBranch(id))
  if (!ahead) throw new Error(`lane ${id} has no commits master does not already have`)
  state.ready[id] = { at: now(), commit: git(dir, 'rev-parse', 'HEAD'), commits: ahead, session }
  return { lane: id, commits: ahead, note: 'goes out with the next release, not a separate one' }
}

/**
 * Take a stuck conflict over.
 *
 * A conflict belongs to the chat that wrote the code - right up until that chat stops
 * answering, and then it belongs to nobody and the work sits. This is the way out: any
 * live chat can adopt a conflict whose own chat has been quiet for ADOPT_MS, get the
 * half-merge opened in that lane's worktree, resolve it, commit, and finish it with
 * `ready --lane <id>`. The guard lets the resolver write there for as long as it holds
 * the conflict, and the lane's own chat can always resolve its own without waiting.
 */
function resolveConflict(session, wanted) {
  if (!session) throw new Error('resolve needs --session')
  const state = reap(read())
  if (retryConflicts(state)) write(state)
  const id = wanted ?? Object.keys(state.conflicts).find((l) => adoptable(state, l) || state.lanes[l]?.session === session)
  if (!id) throw new Error(Object.keys(state.conflicts).length ? 'the conflicted lanes still have active chats in them' : 'no lane is conflicted')
  if (!state.conflicts[id]) throw new Error(`lane ${id} is not conflicted`)

  const holder = state.lanes[id]
  const mine = holder?.session === session
  if (!mine && !adoptable(state, id) && state.conflicts[id].resolver !== session) {
    const idle = Math.round((now() - (holder.seen ?? holder.claimed ?? 0)) / 60000)
    throw new Error(
      `lane ${id} is held by another chat that was active ${idle}m ago - it fixes its own conflict. ` +
        `Adoptable after ${Math.round(ADOPT_MS / 60000)}m of silence.`
    )
  }

  const dir = laneDir(id)
  // A merge left open by an earlier attempt is the state we want; do not abort it.
  const open = gitSafe(dir, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD').ok
  let files = []
  if (open) {
    files = gitSafe(dir, 'diff', '--name-only', '--diff-filter=U').out.split('\n').filter(Boolean)
  } else {
    const caught = catchUp(id, { keepConflict: true })
    // Uncommitted work in there is not something to merge on top of, and it means the
    // lane's chat is alive after all.
    if (caught.dirty) throw new Error(`lane ${id} has uncommitted changes in ${dir} - commit or discard them first`)
    files = caught.conflicts
  }

  if (!open && !files.length) {
    // It merged on the way in. Nothing to resolve, and the work is shippable again.
    delete state.conflicts[id]
    let marked = null
    try {
      marked = markReady(state, id)
    } catch {
      /* the lane had nothing master lacks */
    }
    write(state)
    return { lane: id, dir, resolved: true, marked, release: autoship('patch', session) }
  }

  state.conflicts[id] = {
    ...noteConflict({}, id, files.join(', '), state.conflicts),
    resolver: session,
    resolverAt: now()
  }
  write(state)
  return { lane: id, dir, resolved: false, files, adopted: !mine }
}

function ready(session, wanted) {
  const state = reap(read())
  const mine = Object.entries(state.lanes).find(([, c]) => c.session === session)
  let id = mine?.[0]
  // `--lane b` is how the chat that took a stuck conflict over finishes it: the lane is
  // still held by the chat that made it, and that chat may never come back.
  if (wanted && wanted !== id) {
    if (state.conflicts[wanted]?.resolver !== session) {
      throw new Error(`this session does not hold lane ${wanted} - run resolve --lane ${wanted} first`)
    }
    id = wanted
  }
  if (!id) throw new Error('this session holds no lane')
  // Declaring work finished is the other way a reservation becomes real.
  if (state.lanes[id]) delete state.lanes[id].tentative
  const dirty = git(laneDir(id), 'status', '--porcelain')
  if (dirty) throw new Error(`commit your changes first:\n${dirty}`)

  // Merge master in HERE, while this chat is still around, rather than letting the release
  // discover the conflict later with nobody left who knows the code. Resolving it now also
  // teaches rerere the answer, so the release's own merge replays it untouched.
  const caught = catchUp(id, { keepConflict: true })
  if (caught.conflicts.length) {
    noteConflict(state.conflicts, id, caught.conflicts.join(', '))
    write(state)
    throw new Error(
      `lane ${id} and master both changed:\n  ${caught.conflicts.join('\n  ')}\n` +
        `The merge is open in ${laneDir(id)}. Resolve those files, ` +
        `\`git add\` them, \`git commit\`, then run ready again - the release then merges by itself.`
    )
  }

  const marked = markReady(state, id)
  delete state.conflicts[id]
  write(state)
  // `ready` is the end of this lane's work, so the test copy it opened has nothing left
  // to test. Waiting for the chat to END to close it (releaseClaim) left a minimized
  // "PaneForge - dev-b" sitting in Alt+Tab for as long as the chat stayed open - which,
  // when the release is blocked on another lane, is hours. Close it at the moment the
  // work is declared done instead.
  closeTestApps(laneDir(id))
  // Last one out cuts the release. If another chat is still mid-edit this is a no-op
  // and THEIR `ready` (or the end of their session) will cut it instead.
  return { ...marked, release: autoship('patch', session) }
}

function releaseClaim(session) {
  const state = reap(read())
  // Outside the loop below on purpose: adopting somebody else's conflict does not give a
  // chat a lane, so a chat can be holding a claim and no lane at all. Ending gives back
  // both.
  dropClaims(state, session)
  let freed = null
  let marked = null
  for (const [id, c] of Object.entries(state.lanes)) {
    if (c.session === session) {
      // A chat that ends with committed, clean work meant that work to go out - it just
      // never said so. Uncommitted work is the opposite: nobody released half an edit.
      const w = laneWork(id)
      if (!state.ready[id] && !w.dirty && w.ahead > 0) {
        // Same catch-up as `ready`, minus anyone to resolve a conflict: if it does not merge
        // cleanly it is recorded by name instead of being marked ready and failing later.
        const caught = catchUp(id)
        if (caught.conflicts.length) {
          noteConflict(state.conflicts, id, caught.conflicts.join(', '))
        } else {
          try {
            marked = markReady(state, id)
          } catch {
            /* nothing mergeable - leave it */
          }
        }
      }
      delete state.lanes[id]
      // The test copy this chat opened belongs to the chat, not to the next one that
      // claims the lane - and `--minimized` means nobody sees it to close it by hand.
      closeTestApps(laneDir(id))
      freed = id
    }
  }
  if (state.release?.session === session) state.release = null
  write(state)
  return { freed, marked, release: autoship('patch', session) }
}

function ship(kind, session) {
  if (!['patch', 'minor', 'major'].includes(kind)) throw new Error(`unknown bump "${kind}"`)
  const state = reap(read())

  if (state.release && state.release.session !== session) {
    // Do not fail: nothing is wrong. Another chat is mid-release and this lane's work
    // is either already merged or will be next time. Failing here is what makes an
    // agent "fix" it by shipping again.
    return {
      shipped: false,
      reason: `another chat started a release ${Math.round((now() - state.release.at) / 1000)}s ago. Your merged work is in it. Do not ship again.`
    }
  }
  state.release = { session: session ?? 'unknown', at: now() }
  write(state)

  try {
    const dirty = git(MAIN, 'status', '--porcelain')
    if (dirty) throw new Error(`main checkout is dirty, commit first:\n${dirty}`)

    // An expired token used to surface only after the version was committed and
    // tagged, which stranded the release (the resume path below is the recovery).
    // Refuse up front instead: a dry-run push exercises credentials and the network
    // and transfers nothing, so a release that cannot be pushed never gets cut.
    const origin = gitSafe(MAIN, 'push', '--dry-run')
    if (!origin.ok)
      throw new Error(`origin will not take a push, releasing would strand: ${origin.out.slice(0, 200)}`)

    const merged = []
    const conflicts = {}
    for (const [id, mark] of Object.entries(state.ready)) {
      if (id === 'main') continue
      const branch = laneBranch(id)
      const ahead = aheadOf(branch)
      if (!ahead) continue
      const m = gitSafe(MAIN, 'merge', '--no-ff', '-m', `merge lane ${id}`, branch)
      if (!m.ok) {
        // One lane that cannot merge used to stop everyone's release. It does not any
        // more: the conflict is that lane's problem, it stays marked ready, and it is
        // reported by name so the next chat in it fixes it. Everything else goes out.
        gitSafe(MAIN, 'merge', '--abort')
        noteConflict(conflicts, id, mergeFiles(m.out), state.conflicts)
        continue
      }
      merged.push({ lane: id, commits: ahead, commit: mark.commit })
    }

    const pkgPath = join(MAIN, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const [maj, min, pat] = pkg.version.split('.').map(Number)
    const next =
      kind === 'major'
        ? `${maj + 1}.0.0`
        : kind === 'minor'
          ? `${maj}.${min + 1}.0`
          : `${maj}.${min}.${pat + 1}`

    const unreleased = git(MAIN, 'rev-list', '--count', `v${pkg.version}..HEAD`)
    if (unreleased === '0') {
      // A release that died between the tag and the push (expired token, dropped
      // network) leaves master looking released while origin never heard of it - and
      // "nothing new since vX" means no later attempt would ever push it. Finish that
      // release instead of bailing: the commit and tag already exist, only the pushes
      // are missing. (Happened for real on v0.3.42, 2026-07-28.)
      const tagOnOrigin = gitSafe(MAIN, 'ls-remote', '--tags', 'origin', `refs/tags/v${pkg.version}`)
      if (tagOnOrigin.ok && !tagOnOrigin.out.trim()) {
        git(MAIN, 'push')
        git(MAIN, 'push', 'origin', `v${pkg.version}`)
        const s = read()
        s.conflicts = conflicts
        s.release = null
        s.lastShip = { version: pkg.version, at: now(), lanes: merged.map((m) => m.lane) }
        write(s)
        return { shipped: true, version: pkg.version, merged, rebased: [], conflicts, resumed: true }
      }
      const s = read()
      s.conflicts = conflicts
      s.release = null
      write(s)
      return { shipped: false, reason: `nothing new since v${pkg.version}`, conflicts }
    }

    pkg.version = next
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    git(MAIN, 'add', 'package.json')
    git(MAIN, 'commit', '-m', `release: v${next}`)
    git(MAIN, 'tag', `v${next}`)
    git(MAIN, 'push')
    git(MAIN, 'push', 'origin', `v${next}`)

    // Every lane that just shipped catches up to master, so the next feature in that lane
    // does not start from a stale base and conflict on the release commit. A real merge, not
    // ff-only: a lane with its own commits can never fast-forward, which is exactly the lane
    // that drifts and conflicts. A lane that cannot merge cleanly is recorded and told to
    // its own chat, not silently skipped.
    const rebased = []
    for (const id of POOL) {
      if (id === 'main') continue
      const c = catchUp(id)
      if (c.moved) rebased.push(id)
      if (c.conflicts.length) noteConflict(conflicts, id, `master merge: ${c.conflicts.join(', ')}`, state.conflicts)
    }

    const fresh = read()
    // A lane that could not merge keeps its ready mark: its work still has to go out,
    // in the next release, once someone has resolved it.
    fresh.ready = Object.fromEntries(Object.entries(fresh.ready).filter(([id]) => conflicts[id]))
    fresh.conflicts = conflicts
    fresh.release = null
    fresh.lastShip = { version: next, at: now(), lanes: merged.map((m) => m.lane) }
    write(fresh)

    return { shipped: true, version: next, merged, rebased, conflicts }
  } catch (e) {
    const s = read()
    if (s.release?.session === (session ?? 'unknown')) {
      s.release = null
      write(s)
    }
    throw e
  }
}

function status(session) {
  const state = reap(read())
  // Asking is not writing, except when the asking found something to throw away: an
  // expired reservation that is only ever computed and never stored is not expired at all.
  if (reaped) write(state)
  return {
    main: MAIN,
    lanes: POOL.map((id) => {
      const w = laneWork(id)
      return {
        lane: id,
        dir: laneDir(id),
        branch: laneBranch(id),
        exists: existsSync(laneDir(id)),
        heldBy: state.lanes[id]?.session ?? null,
        mine: session ? state.lanes[id]?.session === session : undefined,
        // Reserved by a chat that has not written here. Callers that describe lanes to a
        // human (the hook, the app) leave these out - they are not work, they are a word.
        tentative: Boolean(state.lanes[id]?.tentative),
        from: state.lanes[id]?.cwd ?? null,
        ready: Boolean(state.ready[id]),
        conflicted: Boolean(state.conflicts[id]),
        // Enough for a hook (or PaneForge) to say "this one is stuck, and here is who
        // may unstick it" rather than only "conflicted".
        conflict: state.conflicts[id]
          ? {
              since: state.conflicts[id].since ?? state.conflicts[id].at,
              detail: state.conflicts[id].detail ?? '',
              resolver: state.conflicts[id].resolver ?? null,
              adoptable: adoptable(state, id)
            }
          : null,
        dirty: w.dirty,
        ahead: w.ahead
      }
    }),
    // Why a finished lane has not gone out yet, in one field.
    blockedBy: busyLanes(state),
    pending: shippable(state),
    release: state.release,
    lastShip: state.lastShip
  }
}

// ---------------------------------------------------------------- entry

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'status'
const arg = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ??
  (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined)

try {
  const session = arg('session')
  const sayRelease = (r) => {
    if (!r) return
    if (r.shipped) {
      console.log(`Released v${r.version} automatically${r.merged?.length ? ` (lanes ${r.merged.map((m) => m.lane).join(', ')})` : ''}.`)
      console.log('GitHub is building Windows and macOS. Running copies update within 30 minutes.')
    } else if (r.reason && r.reason !== 'nothing to release') {
      console.log(`No release yet: ${r.reason}`)
    }
    for (const [id, c] of Object.entries(r.conflicts ?? {})) {
      console.log(
        `Lane ${id} is finished but conflicts with master, so it was left out of the release. ` +
          `It is retried by itself every ${Math.round(RETRY_MS / 60000)}m and goes out on its own if master stops ` +
          `disagreeing with it. To finish it now: node scripts/lane.mjs resolve --session <id> --lane ${id} ` +
          `(opens the merge in ${c.dir}).`
      )
    }
  }

  if (cmd === 'claim')
    console.log(JSON.stringify(claim(session, arg('cwd'), arg('prefer'), argv.includes('--tentative')), null, 2))
  else if (cmd === 'guard') {
    const reason = guard(session, arg('path'))
    if (reason) {
      console.log(reason)
      process.exit(2)
    }
  } else if (cmd === 'ready') {
    const r = ready(session, arg('lane'))
    console.log(`Lane ${r.lane} marked done${r.commits ? ` (${r.commits} commit${r.commits === 1 ? '' : 's'})` : ''}.`)
    sayRelease(r.release)
  } else if (cmd === 'resolve') {
    const r = resolveConflict(session, arg('lane'))
    if (r.resolved) {
      console.log(`Lane ${r.lane} merges cleanly now - nothing to resolve, it goes out with the next release.`)
      sayRelease(r.release)
    } else {
      console.log(
        `Lane ${r.lane}: merge open in ${r.dir}${r.adopted ? ' (adopted - its own chat went quiet)' : ''}.\n` +
          `Conflicted files:\n  ${r.files.join('\n  ')}\n` +
          `Resolve them there, git add, git commit, then: node scripts/lane.mjs ready --session ${session} --lane ${r.lane}`
      )
    }
  } else if (cmd === 'release') {
    const r = releaseClaim(session)
    if (r.marked) console.log(`Lane ${r.marked.lane} had finished work - marked done on the way out.`)
    sayRelease(r.release)
  } else if (cmd === 'autoship') sayRelease(autoship((argv[1] && !argv[1].startsWith('--') ? argv[1] : 'patch').toLowerCase(), session ?? 'auto'))
  else if (cmd === 'ship') {
    const r = ship((argv[1] && !argv[1].startsWith('--') ? argv[1] : 'patch').toLowerCase(), session)
    if (r.shipped) {
      console.log(`Shipped v${r.version}.`)
      if (r.merged.length) console.log(`Included lanes: ${r.merged.map((m) => m.lane).join(', ')}`)
      if (r.rebased.length) console.log(`Lanes brought up to date: ${r.rebased.join(', ')}`)
      console.log('GitHub is building Windows and macOS. Running copies update within 30 minutes.')
    } else {
      console.log(`Not shipped: ${r.reason}`)
    }
  } else if (cmd === 'retry') {
    // Every other retry rides on a chat happening to run a lane command, so on a quiet
    // machine a conflict was never re-tried at all: it stayed on the strip long after the
    // change it disagreed with had shipped. The app calls this on a timer instead. When
    // master has not moved and RETRY_MS has not passed this is one `rev-parse` per lane.
    const state = reap(read())
    const before = Object.keys(state.conflicts)
    if (retryConflicts(state)) write(state)
    const cleared = before.filter((id) => !state.conflicts[id])
    if (cleared.length) console.log(`Lane${cleared.length === 1 ? '' : 's'} ${cleared.join(', ')} merge cleanly now.`)
    else if (before.length) console.log(`Still conflicted: ${before.join(', ')}.`)
    // And then try the release, every time. Every other trigger is a chat doing something
    // - a `ready`, a session ending - so finished work that arrived during the cooldown
    // window sat on master until somebody typed, which on a quiet evening is the morning.
    // The clock is what was missing. autoship is a no-op unless there is something to put
    // out, nobody is mid-edit and the cooldown has passed.
    sayRelease(autoship('patch', session ?? 'auto'))
  } else if (cmd === 'status') console.log(JSON.stringify(status(session), null, 2))
  else {
    console.error(`Unknown command "${cmd}".`)
    process.exit(1)
  }
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
