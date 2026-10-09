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
//   node scripts/lane.mjs status                   the same facts as JSON, for the app
//   node scripts/lane.mjs doctor                   ...and in sentences, for a person
//   node scripts/lane.mjs resolve --session <id> [--lane b]   take over a stuck lane
//   node scripts/lane.mjs ready --session <id>     mark this lane's branch shippable
//   node scripts/lane.mjs ship [patch|minor|major] merge ready lanes, one release
//   node scripts/lane.mjs autoship                 ship, but only if no chat is mid-work
//   node scripts/lane.mjs retry                    re-try stuck lanes (the app, on a timer)
//   node scripts/lane.mjs park --session <id> --lane <slot> --ref <ref>
//                                                    remember a committed snapshot outside the pool
//   node scripts/lane.mjs sweep [--dry-run]        remove unused checkout folders, work saved first
//   node scripts/lane.mjs release --session <id>   give the lane back (SessionEnd)
//
// Nothing above is typed by hand. `ready` and `release` both end in `autoship`, so the
// release happens by itself the moment the LAST chat with unfinished PaneForge work
// stops having any: whoever finishes last cuts the version, for everyone.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, hostname, tmpdir } from 'node:os'
import { closeTestApps } from './test-app.mjs'

// kill(-1) signals every process the user owns and kill(0) this process's own group, so a pid of 0 or 1 is never
// signalled (2026-10-06: a fake pid 1 quit every app on the Mac). Own copy of scripts/signal-guard.mjs: lane.mjs is
// copied around alone. test:signalguard fails on any other raw process.kill( that is not a signal-0 probe.
function signalGroup(pid, name) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false
  try { process.kill(-pid, name); return true } catch { return false }
}
import { countedSuffixes, maskCounts, mergeAutoConflicts, mergeImportConflicts, mergeJsonListAdds, mergeListAddConflicts, recount } from './lane-merge.mjs'
import {
  CLAIM_NS,
  LOCK_REF,
  RELEASE_SLOT,
  claimRef,
  heldByPeer,
  lockIsStale,
  needsRefresh,
  ownedRefs,
  parseClaims,
  peerWords,
  refSafe,
  supersededRefs
} from './lane-peers.mjs'
import { bumpFor, hasChanges, nextVersion, notes, smallOnly, unpublished, versionTags } from './release-notes.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------- repo geography

// Every git call gets a deadline. A `git rev-parse --git-common-dir` left over from a
// dead chat sat in this folder for 23 hours on 2026-07-27, and its bash and conhost
// parents with it: the hook kills the lane.mjs it spawned after 25s, but nothing killed
// the git underneath, and a live conhost holding the checkout is what blocked the
// PaneForge rename for two days (EBUSY, no cwd in the folder - a stray handle).
// Timing out throws, which gitSafe already reports and the callers already handle.
const GIT_TIMEOUT_MS = 20_000
// Push and fetch move the repository's contents over the network, and their size is the
// user's: a release of ~55 MB of mp4 renders (videos, Mac, 2026-10-09) was killed at 20s,
// git-remote-https finished the upload anyway, and the release reported origin as refusing
// a push origin had taken. These get a deadline sized for a big transfer on a slow uplink.
const NET_TIMEOUT_MS = 10 * 60_000
const deadlineFor = (args) => (args[0] === 'push' || args[0] === 'fetch' ? NET_TIMEOUT_MS : GIT_TIMEOUT_MS)
// A lifecycle hook's parent deadline also bounds its children. Keep 300ms for
// the engine and canonical hook to report failure before their own timeouts.
function hookTimeout(normal) {
  const deadline = Number(process.env.PANEFORGE_HOOK_DEADLINE)
  if (!Number.isFinite(deadline) || !deadline) return normal
  const remaining = deadline - Date.now() - 300
  if (remaining < 1) throw new Error('Lane hook deadline reached')
  return Math.min(normal, remaining)
}

function git(cwd, ...args) {
  const timeout = hookTimeout(deadlineFor(args))
  try {
    return execFileSync('git', args, { windowsHide: true,
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      killSignal: 'SIGKILL'
    }).trim()
  } catch (e) {
    // Said instead of whatever the killed git had printed so far, which is either nothing
    // or a half-finished line that reads like a reason.
    if (e.code === 'ETIMEDOUT') e.timedOut = `git ${args[0]} timed out after ${Math.round(timeout / 1000)} s`
    throw e
  }
}
/**
 * `git cherry <upstream> <head>` that skips the walk when `head` has nothing upstream lacks.
 * cherry builds a patch-id for every commit on the UPSTREAM side as well, so a lane parked
 * on an old trunk commit made `git cherry main lane-b` take over a minute on taskdriver.ai
 * (hundreds of commits behind, 2026-10-09), and a claim looks at several lanes. A head
 * with no commits of its own lists nothing, so the answer is the same and costs one rev-list.
 */
function gitCherry(cwd, upstream, head) {
  const own = gitSafe(cwd, 'rev-list', '-n1', `${upstream}..${head}`)
  if (own.ok && !own.out) return { ok: true, out: '' }
  return gitSafe(cwd, 'cherry', upstream, head)
}
function gitSafe(cwd, ...args) {
  try {
    return { ok: true, out: git(cwd, ...args) }
  } catch (e) {
    const out = errText(e)
    // Git refusing to start is not an answer about the code. Clear the lock that stopped
    // it when we can prove the lock is abandoned, and take the one retry - so the callers
    // below never have to tell "these branches disagree" apart from "git was busy".
    if (dropStaleLock(cwd, out, e)) {
      try {
        return { ok: true, out: git(cwd, ...args) }
      } catch (again) {
        const retried = errText(again)
        return { ok: false, out: retried, locked: lockedOut(retried), died: died(again), code: again.status ?? null }
      }
    }
    return { ok: false, out, locked: lockedOut(out), died: died(e), code: e.status ?? null }
  }
}

// Safety decisions must see ordinary untracked output even when a repository hides it
// from interactive status for performance. Ignored files remain outside this predicate:
// they may be seeded dependencies, and only destructive sweep treats them as a hold.
const WORK_STATUS = ['status', '--porcelain', '--untracked-files=all']

// A git killed at its deadline said nothing: stderr and stdout are '' (not null, so `??` never
// reached the message), and that empty answer was stored as a lane's conflict (2026-10-09).
const errText = (e) =>
  e.timedOut ||
  [e.stderr, e.stdout].map((s) => String(s ?? '').trim()).find(Boolean) ||
  String(e.message || e.code || 'git failed and said nothing').trim()

/**
 * A git that never answered: killed at its deadline (ETIMEDOUT, SIGKILL), stopped by a hook
 * deadline, or never started. It has no exit status, so it said nothing about the branches.
 */
const died = (e) => e.status == null

/**
 * A lock is not a conflict.
 *
 * Git writes "another git process seems to be running" into the same channel it uses for
 * real disagreements, so a merge that simply lost a race came back through the conflict
 * path: the lane was recorded as CONFLICTED with `Unable to create index.lock: File
 * exists` stored where the list of disagreeing files goes, and it stayed out of every
 * release until a person deleted that file by hand. On this machine that went unnoticed
 * for seven hours (2026-08-02). Nobody running this anywhere else can be asked to know
 * that a file called index.lock exists, let alone that deleting it is safe.
 */
function lockedOut(out) {
  return (
    /Unable to create '.*\.lock': File exists/i.test(out) ||
    /another git process seems to be running/i.test(out) ||
    // Newer git says only this. Measured 2026-08-07 on git 2.50.1 (Apple Git-155): with an
    // index.lock present, `git merge` prints `fatal: Unable to write index.` and nothing
    // else - no path, no "File exists", no advice line. The message the two patterns above
    // match is what OLD git said, so on a modern machine every locked merge came back
    // through the conflict path with that sentence stored where the disagreeing files go,
    // and the lane stayed out of every release. Matching it here is safe because clearing
    // is still gated on the lock's own mtime: with no abandoned lock, nothing is deleted.
    /Unable to write (?:new )?index(?: file)?\./i.test(out)
  )
}

// How long a .lock has to have sat untouched before it is certainly abandoned. Every git
// this file runs that can hold one is dead within GIT_TIMEOUT_MS (push and fetch run
// longer but take no index, HEAD or MERGE_HEAD lock), and a real merge holds the index for
// milliseconds, so five minutes is far past anything legitimate.
const STALE_LOCK_MS = 5 * 60_000

// dropStaleLock asks git where the locks live, and that ask goes through gitSafe. One
// flag keeps a failing rev-parse from trying to heal the lock it is looking for.
let clearingLock = false

/**
 * Delete a lock whose owner is provably gone, and say whether anything was freed.
 *
 * This file MAKES stale locks: git() kills anything running past GIT_TIMEOUT_MS, and a
 * git killed mid-write leaves its .lock behind with nobody to clean it up. So the cases
 * are two, with a different proof each:
 *
 *   we killed it   the lock existed for at least GIT_TIMEOUT_MS before the kill, so a
 *                  lock younger than that belongs to some other, live git - not ours
 *   it is old      nothing legitimate holds an index for STALE_LOCK_MS
 *
 * Both compare against the lock's own mtime, so a live git's fresh lock is never touched.
 */
function dropStaleLock(cwd, out, err) {
  if (clearingLock) return false
  const killed = Boolean(err?.killed) || err?.signal === 'SIGKILL'
  if (!killed && !lockedOut(out)) return false
  clearingLock = true
  try {
    const paths = new Set()
    // The message names the exact file when there is a message; a killed git leaves none.
    const named = /Unable to create '(.+?)': File exists/i.exec(out)?.[1]
    if (named) paths.add(resolve(named))
    for (const name of ['index.lock', 'HEAD.lock', 'MERGE_HEAD.lock']) {
      const g = gitSafe(cwd, 'rev-parse', '--git-path', name)
      if (g.ok && g.out) paths.add(resolve(cwd, g.out))
    }
    const minAge = killed ? GIT_TIMEOUT_MS : STALE_LOCK_MS
    let dropped = false
    for (const p of paths) {
      try {
        if (!existsSync(p)) continue
        if (now() - statSync(p).mtimeMs < minAge) continue
        unlinkSync(p)
        dropped = true
      } catch {
        /* gone already, or genuinely held by something we cannot see - leave it */
      }
    }
    return dropped
  } finally {
    clearingLock = false
  }
}

// This file can live in a worktree, so "the repo" always means the MAIN checkout:
// git-common-dir points at <main>/.git from anywhere inside any worktree.
//
// And "the repo" is not always this one. Lanes were built for PaneForge because PaneForge
// is where several chats collide, but nothing about the problem is about PaneForge: two
// chats in one checkout of anything overwrite each other's edits and race the same index.
// So the repository is an argument - `--repo <dir>`, or LANE_REPO - and the hook that
// claims lanes passes whichever repository the chat is actually sitting in. There is ONE
// copy of this engine, the one inside PaneForge, driving every project on the machine. A
// copy per project would drift, and the only symptom of that drift would be two chats
// quietly sharing one checkout, which is the exact thing this exists to prevent.
function argOf(name) {
  const a = process.argv
  const eq = a.find((x) => x.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = a.indexOf(`--${name}`)
  return i >= 0 ? a[i + 1] : undefined
}

// And when nobody says which repo, the answer is the one you are standing in - not the one
// this file happens to ship inside. Both are "obvious"; only one of them is what a human
// typing the command meant. Without this, `lane.mjs status` run from any other checkout
// answered about PaneForge - PaneForge's lanes, PaneForge's branch, PaneForge's folders -
// which reads exactly like a right answer and is not one. Every note that ever said "run
// it from the repo" described THIS behaviour and never got it, because the flag was the
// only thing that worked (2026-08-02). The flag still wins, then LANE_REPO, then the
// checkout around cwd; only when cwd is in no repo at all does this file's own repo answer.
function cwdRepo() {
  const at = process.cwd()
  const found = gitSafe(at, 'rev-parse', '--git-common-dir')
  if (!found.ok) return null
  return dirname(resolve(at, found.out))
}
const asked = argOf('repo') ?? process.env.LANE_REPO ?? cwdRepo()
const own = resolve(join(here, '..'))
const commonDir = resolve(asked ? resolve(asked) : own, git(asked ? resolve(asked) : own, 'rev-parse', '--git-common-dir'))
const MAIN = dirname(commonDir)
const STATE = join(commonDir, 'paneforge-lanes.json')
const RECOVERY = join(commonDir, 'paneforge-recovery.json')

/**
 * Is the repo being driven the checkout this script ships in?
 *
 * Only two things turn on it, and both are PaneForge's alone: releases default to cutting
 * a version here and to merging everywhere else, and the `npm run try` copies a lane opens
 * are only ever closed in the repo that has them. `--repo <this repo>` (which the hook
 * always passes, PaneForge included) still counts as its own checkout - the flag says
 * WHICH repo, not that it is somebody else's.
 */
const OWN = (() => {
  if (!asked) return true
  try {
    return dirname(resolve(own, git(own, 'rev-parse', '--git-common-dir'))) === MAIN
  } catch {
    return false
  }
})()

/**
 * Per-repository settings, read from `.lanes.json` in the repo root. Every field is
 * optional and the defaults are what PaneForge has always done:
 *
 *   { "lanes": false }        this repo does not use lanes at all (the hook obeys it)
 *   { "branch": "main" }      the branch lanes are cut from and merged back into
 *   { "release": "merge" }    what finishing a lane does - see below
 *   { "pool": ["main","a"] }  how many chats may work here at once
 *
 * `release` is the whole difference between PaneForge and everything else, and it is a
 * declaration rather than a guess on purpose. "version" bumps package.json, tags, pushes
 * and publishes - which in a repo that deploys on push IS a production release, and no
 * project should start doing that because a script recognised an npm script name. A repo
 * that is not this one therefore defaults to "merge": finished lanes are merged into the
 * branch and pushed, batched exactly the same way, and no version is ever cut. Opting a
 * repo into real releases is one line in its own `.lanes.json`.
 */
/**
 * The names of the lane checkouts, and there is only one set of them.
 *
 * `main` is the repository folder itself; every other lane is `<repo>-<letter>` on branch
 * `lane-<letter>`, sitting beside it. PaneForge's own window creates exactly those folders
 * when a second pane opens the same project (src/main/lanes.ts), which is the point: a pane
 * sitting in `Toolstash-b` and a chat holding lane b are the SAME checkout, so the prompt
 * hook can ask for "the lane matching the folder I am in" and be given it. While the two
 * halves of this used different names - `<repo>-a` here, `<repo>-w2` there - that request
 * asked for a lane called `w2`, and this file would have gone and made `lane-w2` on top of
 * the `pf/w2` worktree that was already sitting at that path.
 *
 * Eight letters because that is how many the window offers. A repo that wants fewer, more,
 * or different says so in its own `.lanes.json` `pool`.
 */
const DEFAULT_POOL = ['main', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']

function loadProfile() {
  let cfg = {}
  try {
    cfg = JSON.parse(readFileSync(join(MAIN, '.lanes.json'), 'utf8'))
  } catch {
    /* no file, or unreadable - the defaults below are the whole of the behaviour */
  }
  const branch = cfg.branch || trunkName()
  // `PF_RELEASE` is how a release is ASKED FOR in a repo whose standing answer is "merge".
  //
  // PaneForge sets `"release": "merge"` on purpose - finishing work merges and pushes, and
  // a version is cut only when Robert says so. The only way to honour that ask was to edit
  // `.lanes.json`, and that is a trap with no way out: the edit makes the main checkout
  // dirty, and `ship` refuses a dirty checkout, so the release never happens and the
  // policy file is left flipped if anything throws in between. Measured 2026-08-24 -
  // `ship patch` answered `main checkout is dirty, commit first: M .lanes.json`.
  //
  // An environment variable is the right shape for it because the ask is per-invocation,
  // exactly like the ask itself. The FILE stays the standing policy, which is the thing
  // that must not drift; nothing automatic sets this, so a scheduled `autoship` still
  // obeys the file.
  const release = process.env.PF_RELEASE || cfg.release || (OWN ? 'version' : 'merge')
  if (!['version', 'merge', 'none'].includes(release))
    throw new Error(`.lanes.json: unknown release "${release}" - use "version", "merge" or "none"`)
  return {
    branch,
    release,
    pool: Array.isArray(cfg.pool) && cfg.pool.length ? cfg.pool : DEFAULT_POOL,
    enabled: cfg.lanes !== false
  }
}
/**
 * The trunk, when `.lanes.json` does not name it: origin's default branch, else `main` or
 * `master`. Never "whatever the main folder has checked out".
 *
 * That was the rule until 2026-09-23, and it merged finished lanes into a feature branch for
 * 35 hours: taskdriver.ai's main folder had been left on `feat/github-actions-usage-card`,
 * every `ready` merged into it, and it was 171 commits ahead of origin/main before anybody
 * noticed. Nothing compared the target with origin's default. A folder's checkout is a
 * fact about what somebody was last doing there, not a declaration of where work goes.
 *
 * When both `main` and `master` exist and there is no origin to ask, the one the main folder
 * is on wins - that is a choice between two trunk-shaped names, not a side branch. The main
 * folder's own branch is the last resort only for a repo with neither name and no origin,
 * where there is no other name to use.
 */
function trunkName() {
  const o = gitSafe(MAIN, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')
  if (o.ok && o.out) return o.out.replace(/^origin\//, '')
  const has = (b) => gitSafe(MAIN, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`).ok
  const head = gitSafe(MAIN, 'symbolic-ref', '--quiet', '--short', 'HEAD')
  const on = head.ok ? head.out : ''
  if ((on === 'main' || on === 'master') && has(on)) return on
  for (const b of ['main', 'master']) if (has(b)) return b
  return on || 'master'
}
const PROFILE = loadProfile()

/** The branch lanes are cut from and merged back into. `master` here, `main` elsewhere. */
const MB = PROFILE.branch
/** What this repo does with finished work: cut a version, merge and push, or neither. */
const RELEASE = PROFILE.release

/** Lane pool. `main` first: one chat alone should never be pushed onto a branch. */
// Worktrees are only created when a lane is first handed out, so headroom is free.
const POOL = PROFILE.pool
const laneDir = (id) => (id === 'main' ? MAIN : join(dirname(MAIN), `${basename(MAIN)}-${id}`))
const laneBranch = (id) => (id === 'main' ? MB : `lane-${id}`)
/** Matches scripts/try.mjs, which derives the PaneForge profile from the folder name. */
const laneProfile = (id) => (id === 'main' ? 'dev' : `dev-${id}`)
// Taskdriver's full verification runs on the PC. The shared verifier reads the
// PC evidence for this exact tree; a missing verifier or proof holds the release.
const TASKDRIVER_PC = process.platform === 'darwin' && basename(MAIN) === 'taskdriver.ai'
// Beside the REPO, not beside this script: an installed copy runs from inside the app
// bundle, where dirname(own) is Contents/ and the verifier is never found.
const TASKDRIVER_PROOF = join(dirname(MAIN), 'claude-memory', 'claude-config', 'taskdriver-pc-proof.mjs')

/**
 * Take a lane's folder out of Finder, on macOS.
 *
 * `clients-a` .. `clients-c` sat beside `clients` in every Finder window, four rows of
 * near-identical names above the one folder a person means - and opening the wrong one is
 * editing work a merge throws away. The `hidden` flag is Finder's own answer, and git,
 * `ls`, `cd` and every path in this file ignore it completely, so nothing else changes.
 *
 * Called on creation and again on every `status`, which is what makes lanes created before
 * this existed catch up without anybody typing: setting the flag twice is a no-op. Never
 * waited on and never fatal - a copy that could not be hidden is a copy somebody can see.
 * `main` is never hidden: that is the project itself. Mirrors src/main/hideCopy.ts, which
 * does the same for lanes the app makes; this file cannot import TypeScript.
 */
function hideLane(id) {
  if (process.platform !== 'darwin' || id === 'main') return
  const dir = laneDir(id)
  if (!existsSync(dir)) return
  try {
    spawnSync('chflags', ['hidden', dir], { windowsHide: true, stdio: 'ignore', timeout: hookTimeout(10000) })
  } catch {
    /* no chflags: the folder stays visible, which is where it was anyway */
  }
}

/**
 * Close the `npm run try` copies a lane left running - PaneForge's own, and nobody else's.
 *
 * The sweep matches processes by the folder they were launched from, so pointing it at
 * some other project's lane would find nothing anyway. Gating it is about not spawning a
 * process sweep, on every claim, in every repository on the machine, to find nothing.
 */
function closeLaneApps(dir) {
  if (OWN) closeTestApps(dir)
}

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
// A hold whose chat ENDED ITS TURN with the lane clean is parked (`park`, run by the Stop
// hook). Parked is not stale: the window is open and the chat may speak again - but the
// evidence says nobody is mid-anything, so the wait for its lane is minutes, not the hour
// the idle sweep needs. A parked hold from a VISITOR chat - one whose own project is a
// different repo, which claimed here only because its shell happened to be standing in
// this folder - is stealable immediately: that is the chat that held taskdriver.ai's
// `main` for half an hour on 2026-08-09 with nothing in it, three minutes of work done,
// committed and pushed, while every real taskdriver chat was sent to a letter lane.
const PARK_STEAL_MS = 10 * 60 * 1000
// A hold whose pane put itself to sleep (`sleep`, run by the app before it kills the CLI)
// is not given up on any clock this file already has - it is not idle, it is paused, and
// waking it must land in the same checkout it fell asleep in. Seven days is long enough
// that nobody plausibly meant to come back to it; past that it is treated as an ordinary
// stale hold, same as any other.
const ASLEEP_MAX_MS = 7 * 24 * 60 * 60 * 1000
// A chat that only MENTIONED PaneForge gets a lane on approval, not on the word. Saying
// "why does PaneForge show X" from a Jarvis chat used to claim a real lane: the pane then
// wore a "PF lane main" chip for a chat that never opened the repo, and a chat that did
// want to edit could be told every lane was busy by three of those. Such a claim is
// tentative - it reserves a checkout so the agent knows where to work, it is invisible to
// the app and to every other chat, it never delays a release, and it disappears on its own
// after this long unless the chat actually writes in the lane (`guard` promotes it).
const TENTATIVE_MS = 20 * 60 * 1000
// How long a lane may hold everyone else's finished work out of a release.
//
// `busyLanes` waits for a lane with unfinished work in it, which is right, and it had no
// bound at all, which is not: the wait ended when the holding chat committed, marked ready
// or died, and a chat that does none of those three waits for ever. `idle-main-test.mjs`
// fixed the CLAIM half of exactly this squat on 2026-08-07 - taskdriver.ai's `main` held
// from a chat in another project - and left the RELEASE half open, which is the half that
// costs something: one stray uncommitted file in `main` and every other lane's verified,
// pushed work sits unmerged behind it. Measured that same day: lane a's three commits were
// reported to Robert as "queued behind another active chat" with no timer that would ever
// clear it short of the 12h stale sweep, and the chat in front was not typing.
//
// Liveness is the wrong question here. That squatter's heartbeat was 4 minutes old - a
// window being open is not a person editing - so this is measured off the WORK instead:
// the newest mtime among the uncommitted files, and the newest commit the release does not
// have. Untouched for this long means nobody is mid-anything, whatever the ledger says.
//
// Nothing can be lost by not waiting. An ignored lane's work stays on its own branch and
// merges with the next release the moment its chat marks it ready.
const HOLD_BUSY_MS = 60 * 60 * 1000
// How long a main-folder file must sit untouched, with the chat that left it gone, before it
// is called stranded (`mainStranded`). The app's own figure for "no window hosts this chat and
// it has been quiet": GONE_MS in src/main/laneBoard.ts. With a chat still holding the folder
// the bound is HOLD_BUSY_MS above, the measured "untouched this long is not mid-edit".
const STRANDED_QUIET_MS = 15 * 60 * 1000
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
//
// Two hours, not the half hour it was until 2026-08-20. Measured that day: 130 releases
// in the 14 days since v0.8.0 - 9 to 13 a day, peak 18, at 3.8 commits each. "A release
// costs nothing to ignore" is true of the update PROMPT and false of everything else: on
// the dev channel each one is a build to install, a restart to take it, and a version
// number that has to be read to know what is in it. Half an hour is shorter than one
// build-and-verify cycle, so it batched almost nothing - a release carried whatever one
// chat had just finished, which is the same thing as no batching at all. Two hours is
// still same-day for every fix and roughly quarters the number of builds anybody has to
// take. Nothing waits longer to be SAFE; it waits longer for company.
const COOLDOWN_MS = 2 * 60 * 60 * 1000
// And a longer window when everything waiting is SMALL - only fix/docs/chore subjects and
// under 150 changed lines between them (`smallOnly` in release-notes.mjs, which explains
// why it is both halves). A version is a claim that something changed, and a release whose
// entire content is one CSS line teaches you to stop reading the number; six hours is long
// enough that a one-line fix picks up company and short enough that it is out the same day.
// Nothing waits for this on its own: the fix is committed, pushed and backed up the moment
// it verifies, it simply travels with the next release. `npm run ship` still goes now.
const SMALL_HOLD_MS = 6 * 60 * 60 * 1000
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
    s.passed ??= {}
    // Explicit snapshots parked outside the configured pool. Known parked naming
    // conventions are inventoried for review, but never become lane work by discovery.
    s.parkedWork ??= {}
    // Why the last automatic release did not go out. See noteHold below.
    s.hold ??= null
    // What THIS device last told the other one, so a turn ending can tell whether a
    // refresh is due without asking the network on every turn.
    s.peer ??= null
    // What the OTHER devices last said, kept so a reader that must not touch the network
    // can still answer "who has the trunk". See the note in write().
    s.peers ??= null
    return readRecovery(s)
  } catch {
    return readRecovery({ lanes: {}, ready: {}, conflicts: {}, passed: {}, parkedWork: {}, release: null, lastShip: null, hold: null, peer: null, peers: null })
  }
}

// Ordinary lane writers cannot overwrite a completion reservation read earlier.
// Only the recovery-lock owner writes this separate transaction file.
function readRecovery(state) {
  state.recovery = { items: {} }
  try {
    if (existsSync(RECOVERY)) {
      const r = JSON.parse(readFileSync(RECOVERY, 'utf8'))
      if (!r || !r.items || Array.isArray(r.items) || typeof r.items !== 'object') throw new Error('invalid recovery state')
      state.recovery = r
    }
  } catch { state.recoveryError = 'recovery ownership is unreadable; explicit diagnosis required' }
  return state
}

function writeRecovery(state) {
  if (state.recoveryError) throw new Error(state.recoveryError)
  const tmp = `${RECOVERY}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state.recovery, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, RECOVERY)
}

function write(state) {
  // Whatever origin told us this process, written down on the way past.
  //
  // The app draws the lane strip every five seconds from this file and nothing else - no
  // git, no child process - which is the whole reason the strip is cheap enough to poll.
  // So the one fact it could never show was the one that only origin knows: that the trunk
  // is held at the OTHER desk. An `ls-remote` on a five-second timer is not an option, and
  // this costs nothing: `peerRefs` is already cached per process, so nothing new is asked
  // of the network - the answer is simply no longer thrown away when the process exits.
  // Each claim carries its own timestamp, so a cache nobody refreshes ages out by itself.
  if (Array.isArray(refsCache)) state.peers = { at: now(), refs: refsCache }
  // Write-then-rename: two hooks can fire at the same moment from two chats, and a
  // half-written state file would strand every lane at once.
  const tmp = `${STATE}.${process.pid}.tmp`
  const { recovery, recoveryError, ...ledger } = state
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n', 'utf8')
  renameSync(tmp, STATE)
}

// ---------------------------------------------------------------------------
// The other machine.
//
// Everything above this line is one desk's ledger, inside one `.git`, and that is the
// right shape for all of it but the trunk - see the header of scripts/lane-peers.mjs for
// which two things really collide across devices and why the letters do not.
//
// Three rules hold for every line below:
//
//   - **It never blocks a chat.** A repo with no origin, an origin that is unreachable, a
//     laptop on a train: every one of those falls straight through to the behaviour this
//     file had before any of it existed. A lane claim that waits on the network is a
//     prompt that waits on the network.
//   - **It costs nothing on the ordinary path.** A chat re-claiming the lane it already
//     holds returns long before here. Only handing out the TRUNK to a chat that does not
//     have it asks origin anything, and only a turn ending more than REFRESH_MS after the
//     last one pushes.
//   - **Our own device is never consulted through the remote.** The local ledger knows
//     about dirty worktrees and parked turns; a ref name does not.
// ---------------------------------------------------------------------------

/**
 * Which desk this is. The hostname, because it is the one name that is stable across a
 * reboot, an update and a network change, and because it is what a person reading
 * `doctor` on the other machine will recognise. Sanitised for a ref name, and a hostname
 * that survives none of that sanitising (all punctuation) simply turns the feature off
 * here rather than publishing a claim under a name that collides with somebody else's.
 */
const DEVICE = refSafe(process.env.PF_DEVICE || hostname(), 40)
/** The pane this chat is running in, when the app started it. Survives `/clear`, which the
 * session id does not - see the hold-per-pane rule in `claim`. */
const PANE = (process.env.PF_PANE || '').trim()

/** Repos with no remote never had lanes to share, and have no channel to share them on. */
let originKnown
function hasOrigin() {
  if (originKnown === undefined) originKnown = Boolean(DEVICE) && gitSafe(MAIN, 'remote', 'get-url', 'origin').ok
  return originKnown
}

/**
 * Every device's claims, read in ONE `ls-remote`.
 *
 * No fetch and no object transferred: the claim is the ref's NAME. `null` means we could
 * not ask - never an empty list, because "nobody holds the trunk" and "origin did not
 * answer" lead to opposite decisions and must not share a shape.
 */
let refsCache
function peerRefs() {
  if (refsCache !== undefined) return refsCache
  if (!hasOrigin()) return (refsCache = null)
  const r = gitSafe(MAIN, 'ls-remote', 'origin', `${CLAIM_NS}/*`)
  refsCache = r.ok
    ? r.out
        .split('\n')
        .map((l) => l.split('\t')[1]?.trim())
        .filter(Boolean)
    : null
  return refsCache
}

/** A commit origin already has, so publishing a claim transfers no objects at all. */
function remoteTip() {
  for (const rev of [`refs/remotes/origin/${MB}`, 'HEAD']) {
    const r = gitSafe(MAIN, 'rev-parse', rev)
    if (r.ok && /^[0-9a-f]{40}$/.test(r.out.trim())) return r.out.trim()
  }
  return null
}

function pushRefs(specs) {
  if (!specs.length) return false
  return gitSafe(MAIN, 'push', '--quiet', 'origin', ...specs).ok
}

/**
 * Take down the remote copy of any lane branch the trunk on origin already contains.
 *
 * Nothing here ever pushes a lane branch on purpose: autosync does, because a lane
 * worktree's current branch IS `lane-<id>` and autosync commits and pushes whatever the
 * current branch is. That backup is wanted while the lane is being worked. What was
 * missing is the other end - once the lane's commits are in the trunk the remote name is
 * pure noise, and seven of them had piled up in `clients` by 2026-09-11, every one of
 * them 0 commits ahead of main, making GitHub's branch list read as unmerged work.
 *
 * Deleting is safe only against the trunk AS ORIGIN HAS IT, and only for a tip this
 * device can actually resolve: a branch another machine pushed and we have never fetched
 * fails `merge-base` and is left alone rather than guessed at.
 */
function pruneRemoteLanes() {
  if (!hasOrigin()) return []
  const listed = gitSafe(MAIN, 'ls-remote', '--heads', 'origin', 'refs/heads/lane-*', 'refs/heads/pf/w*')
  if (!listed.ok) return []
  const trunk = gitSafe(MAIN, 'rev-parse', `refs/remotes/origin/${MB}`)
  if (!trunk.ok || !/^[0-9a-f]{40}$/.test(trunk.out.trim())) return []
  const merged = []
  for (const line of listed.out.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/)
    if (!/^[0-9a-f]{40}$/.test(sha ?? '') || !ref?.startsWith('refs/heads/')) continue
    if (!gitSafe(MAIN, 'merge-base', '--is-ancestor', sha, trunk.out.trim()).ok) continue
    merged.push(ref)
  }
  if (!merged.length) return []
  // One round trip for all of them, and a failure is silent: a remote that refused the
  // delete is a tidier that did not run, never a release that did not happen.
  if (!pushRefs(merged.map((ref) => `:${ref}`))) return []
  return merged.map((ref) => ref.slice('refs/heads/'.length))
}

/**
 * Say that this device holds `slot`, and take our own older names for it down.
 *
 * Create-then-delete rather than force-update, because the time is in the name: an update
 * would leave the old name behind and a peer would read this device as holding the trunk
 * at two different times. What we publish is mirrored into the local ledger (`state.peer`)
 * so a turn ending can decide whether a refresh is due without asking the network.
 */
function publishClaim(state, slot, session) {
  if (!hasOrigin()) return null
  const tip = remoteTip()
  if (!tip) return null
  const at = now()
  const ref = claimRef({ device: DEVICE, slot, session, at })
  if (!ref) return null
  // One round trip: the new name goes up and the name it replaces comes down together.
  // The name being replaced is the one we wrote down last time, so the ordinary refresh
  // never asks the remote what it is holding - that read is what made a publishing turn
  // end cost 3.0s against GitHub, where a push plus a delete costs 1.3s.
  const known = state.peer?.slot === slot && state.peer.ref && state.peer.ref !== ref ? [`:${state.peer.ref}`] : []
  if (!pushRefs([`--force`, `${tip}:${ref}`, ...known])) return null
  state.peer = { ref, slot, session, at }
  // Only when we have no record of our own - a ledger that was deleted, a first publish
  // after an upgrade - is the remote asked to list what this device left behind.
  if (!known.length) {
    const stale = supersededRefs(peerRefs() ?? [], { device: DEVICE, slot, keep: ref })
    if (stale.length) pushRefs(stale.map((r) => `:${r}`))
  }
  refsCache = undefined
  return state.peer
}

/**
 * Is the release `state.release` names this session's, and is the process cutting it alive.
 *
 * A release can outlive the chat that started it: `autoship` run from a background shell
 * goes on through /clear. Measured 2026-10-09 on the PC: the chat cleared mid-push, its
 * SessionEnd dropped the release claim (so the lock read as abandoned), cleared the marker
 * because the session matched, and started a second release. Two pushes of master raced
 * and GitHub refused the running one. In a repo that cuts versions that is two versions.
 */
function releaseRunning(state, session) {
  return state.release?.session === session && state.release.pid > 0 && processAlive(state.release.pid)
}

/**
 * Give back what this device published for a session. Failure is silent: it ages out.
 * A claim beside a release that is still running stays: it is what makes the cross-device
 * lock read as held, and that release gives it back itself (`dropReleaseLock`).
 */
function dropPublished(state, session) {
  const keep = releaseRunning(state, session) ? RELEASE_SLOT : null
  if (state.peer && (!session || state.peer.session === session) && state.peer.slot !== keep) state.peer = null
  if (!hasOrigin()) return
  const mine = ownedRefs(peerRefs() ?? [], { device: DEVICE, session }).filter((r) => parseClaims([r])[0]?.slot !== keep)
  if (mine.length) {
    pushRefs(mine.map((r) => `:${r}`))
    refsCache = undefined
  }
}

/**
 * Take the cross-device release lock, or say who has it.
 *
 * `state.release` already stops two chats on THIS machine from cutting a version at once,
 * and it cannot see the other desk at all - two machines releasing the same minute is two
 * tags, two GitHub releases and the one-legged feed this repo has shipped for real.
 *
 * The lock is a plain, NON-forced push of a ref whose name never changes, pointing at a
 * commit **only this device could have made**. Both halves of that are load-bearing, and
 * the obvious version of it does not work:
 *
 *   - Reading the ref and then deciding has a window in the middle that both devices fit
 *     inside. The push has to BE the decision, so that the server does the comparing.
 *   - Pushing the branch tip, which is what this first did, is not a decision at all:
 *     both desks are at the same commit, and pushing the sha a ref already holds is a
 *     no-op that SUCCEEDS. Measured against a real bare repo (`test:lanedevice`, case 5):
 *     the second desk "took" a lock the first one was holding, every time.
 *   - `--force-with-lease=<ref>:` reads like the fix and is not one. The lease is checked
 *     against the pusher's OWN remote-tracking ref, and a desk that has never heard of
 *     this ref believes it absent - so it passed the lease and took the lock too.
 *
 * An orphan commit over an empty tree, carrying this device's name and the clock, is a
 * sha no other machine will produce. The remote's ref then points at a history the other
 * desk's commit is not a descendant of, its push is a non-fast-forward, and git refuses
 * it without being asked to compare anything. The holder re-pushing its own sha is still
 * the no-op it should be.
 *
 * The winner immediately publishes a timestamped claim beside it, which is the only way a
 * later run can tell a release that is still running from a lock left behind by a machine
 * that was shut down mid-release.
 *
 * Every failure here returns `ok` - a release that cannot reach origin is a release this
 * repo has always cut anyway, and turning an unreachable remote into a stuck release
 * would be a worse bug than the one being fixed.
 */
function lockToken() {
  // An identity is not configured in every checkout, and `commit-tree` will not run
  // without one. Supplying it here keeps the lock working in a repo that has never had a
  // commit made from this machine, rather than silently falling through to no lock.
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'paneforge',
    GIT_AUTHOR_EMAIL: 'paneforge@localhost',
    GIT_COMMITTER_NAME: 'paneforge',
    GIT_COMMITTER_EMAIL: 'paneforge@localhost'
  }
  const run = (input, ...args) => {
    try {
      return execFileSync('git', args, { windowsHide: true,
        cwd: MAIN,
        encoding: 'utf8',
        input,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: hookTimeout(GIT_TIMEOUT_MS),
        killSignal: 'SIGKILL',
        env
      }).trim()
    } catch {
      return null
    }
  }
  const tree = run('', 'mktree')
  if (!tree) return null
  const sha = run('', 'commit-tree', tree, '-m', `paneforge release lock ${DEVICE} ${now()} ${process.pid}`)
  return /^[0-9a-f]{40}$/.test(sha ?? '') ? sha : null
}

function takeReleaseLock(state, session) {
  if (!hasOrigin()) return { ok: true, held: false }
  const tip = lockToken()
  if (!tip) return { ok: true, held: false }
  let got = gitSafe(MAIN, 'push', '--quiet', 'origin', `${tip}:${LOCK_REF}`).ok
  if (!got) {
    // Somebody holds it. Only a lock with no live claim beside it is cleared, and then
    // only once - a second failure means a real release started in between, which is
    // exactly the outcome this is for.
    const refs = peerRefs()
    if (refs && lockIsStale(refs, { now: now() })) {
      pushRefs([`:${LOCK_REF}`])
      refsCache = undefined
      got = gitSafe(MAIN, 'push', '--quiet', 'origin', `${tip}:${LOCK_REF}`).ok
    }
  }
  if (!got) {
    const who = peerHolding(RELEASE_SLOT)
    return {
      ok: false,
      held: false,
      reason: who
        ? `${peerWords(who, { now: now() })} is cutting a release for this repo right now. The work here goes out with it or with the next one - do not ship again.`
        : 'another device is cutting a release for this repo right now. Do not ship again.'
    }
  }
  publishClaim(state, RELEASE_SLOT, session ?? 'release')
  return { ok: true, held: true }
}

/** Give the lock back. Left behind, it clears itself after LOCK_STALE_MS. */
function dropReleaseLock(state, session) {
  if (!hasOrigin()) return
  pushRefs([`:${LOCK_REF}`])
  refsCache = undefined
  const mine = ownedRefs(peerRefs() ?? [], { device: DEVICE, session: null }).filter((r) =>
    parseClaims([r])[0] && parseClaims([r])[0].slot === RELEASE_SLOT
  )
  if (mine.length) {
    pushRefs(mine.map((r) => `:${r}`))
    refsCache = undefined
  }
  if (state.peer?.slot === RELEASE_SLOT) state.peer = null
  void session
}

/** Is another desk holding this slot right now, and unmistakably still alive. */
function peerHolding(slot) {
  const refs = peerRefs()
  if (!refs) return null
  return heldByPeer(refs, { device: DEVICE, slot, now: now() })
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
 * Rescue the finished work in a lane whose chat is not coming back.
 *
 * Committed, clean, and master does not have it yet: that is work somebody wrote and meant
 * to ship, and the only thing missing is the sentence saying so. Anything else is left
 * exactly where it is - uncommitted edits are half-finished by definition, a lane already
 * marked ready needs nothing, and a lane that will not merge is recorded by name rather
 * than marked ready and failing at release time with nobody around to read the failure.
 *
 * Called from the two places a lane stops having an owner without anyone declaring it
 * done: a claim going stale (the chat was killed) and the unclaimed sweep in `retry` (the
 * claim was dropped before this existed, or by an older version of this file). Returns the
 * markReady result, or null when there was nothing to rescue.
 */
// Unready abandoned work needs a verification owner, not an automatic ready mark.
// These records are durable dispositions, keyed by the reviewed snapshot. In
// particular, a blocked parked ref must not open a fresh pane every timer tick.
function recoveryFor(state, session, lane) {
  return Object.values(state.recovery?.items ?? {}).find((r) => r.owner === session && r.lane === lane && !['complete', 'reviewed'].includes(r.status))
}

function recoveryLiving() {
  try {
    const living = new Set()
    let known = false
    const see = (beat, pid) => {
      if (!beat || !Number.isFinite(beat.at) || !Array.isArray(beat.chats) || !beat.chats.every((s) => typeof s === 'string')) throw new Error('invalid inventory')
      if (pid) {
        try { process.kill(pid, 0) } catch (e) {
          if (e.code === 'ESRCH') return
          throw e // permission/unknown is not dead-owner evidence
        }
      }
      known = true
      for (const session of beat.chats) living.add(session)
    }
    const legacy = join(commonDir, 'paneforge-panes.json')
    if (existsSync(legacy)) {
      const beats = JSON.parse(readFileSync(legacy, 'utf8'))
      if (!beats || Array.isArray(beats) || typeof beats !== 'object') return null
      for (const [id, beat] of Object.entries(beats)) {
        const match = /^pf-(\d+)$/.exec(id)
        if (!match) return null
        see(beat, Number(match[1]))
      }
    }
    const dir = join(commonDir, 'paneforge-panes')
    if (existsSync(dir)) for (const name of readdirSync(dir)) {
      if (name.endsWith('.tmp')) continue
      const match = /^pf-(\d+)\.json$/.exec(name)
      if (!match) return null
      see(JSON.parse(readFileSync(join(dir, name), 'utf8')), Number(match[1]))
    }
    return known ? living : null
  } catch { return null }
}

// A nonempty directory permits atomic takeover without unlinking a contender's lock.
// The deterministic tombstone stays nonempty: a delayed stale observer cannot rename
// a newly acquired live lock over it. Unknown or half-written owners fail closed.
function recoveryLock() {
  const path = join(commonDir, 'paneforge-recovery.lock')
  const owner = join(path, 'owner')
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(path, { mode: 0o700 })
      const token = `${process.pid}:${randomUUID()}`
      writeFileSync(owner, token, { mode: 0o600 })
      return () => {
        try {
          if (readFileSync(owner, 'utf8') === token) { unlinkSync(owner); rmdirSync(path) }
        } catch { /* an unknown lock is never removed */ }
      }
    } catch (e) {
      if (e.code !== 'EEXIST') return null
      try {
        const token = readFileSync(owner, 'utf8')
        const pid = Number(token.split(':')[0])
        if (!Number.isInteger(pid) || pid < 1 || !token.includes(':')) return null
        try { process.kill(pid, 0); return null } catch (error) { if (error.code !== 'ESRCH') return null }
        const dead = `${path}.dead-${createHash('sha256').update(token).digest('hex')}`
        // rename refuses to replace a nonempty destination, including on Windows.
        renameSync(path, dead)
      } catch { return null }
    }
  }
  return null
}

function preservedRecovery(state, lane) {
  if (state.recoveryError) throw new Error(state.recoveryError)
  return Object.values(state.recovery?.items ?? {}).find((r) => !r.ref && r.lane === lane && !['complete', 'reviewed'].includes(r.status))
}

// Trunk holds the item's pinned commit and, when it has one, its receipt commit.
function inTrunkRecovery(r) {
  const inTrunk = (c) => typeof c === 'string' && /^[a-f0-9]{40,64}$/.test(c) && gitSafe(MAIN, 'merge-base', '--is-ancestor', c, MB).ok
  return inTrunk(r.commit) && (r.receipt?.commit == null ? !r.dirty : inTrunk(r.receipt.commit))
}

// A lane item whose pinned commit (and recorded receipt commit, if any) trunk already
// contains has nothing left to preserve. An owner that ended mid-recovery at `owned` left
// it unfinished forever otherwise: only that owner may `recover` the key and the clock
// revisits only `recovery.active`, so every later `ready` on the lane threw. Measured on
// research-lab 2026-10-03: lane:b:dc8c599, owner ended 2026-10-02, dc8c599 already in
// origin/main. Same proof against the same local trunk as the parked-ref closure in
// dispatchCompletion. `session` holds the lane, so the recorded owner no longer works in
// it; the caller's own item keeps its verification gate. Contention fails closed.
// Ancestry proves nothing about uncommitted changes: an item pinned for them (`dirty`)
// needs its receipt commit in trunk, and a checkout holding hand edits is never closed.
function closeShippedRecovery(state, session, lane) {
  const shipped = (r) => !r.ref && r.lane === lane && r.owner !== session && !['complete', 'reviewed'].includes(r.status) && inTrunkRecovery(r)
  if (state.recoveryError || !Object.values(state.recovery?.items ?? {}).some(shipped)) return
  // A folder that no longer exists holds no uncommitted work; one that exists must read clean.
  if (existsSync(laneDir(lane))) {
    const status = gitSafe(laneDir(lane), ...WORK_STATUS)
    if (!status.ok || (status.out && !machineWrittenPaths(laneDir(lane)))) return
  }
  const unlock = recoveryLock()
  if (!unlock) return
  try {
    const fresh = readRecovery({})
    if (fresh.recoveryError) return
    const closed = Object.entries(fresh.recovery.items).filter(([, r]) => shipped(r))
    for (const [key, r] of closed) {
      fresh.recovery.items[key] = { ...r, status: 'reviewed', at: now(), reason: 'included by trunk ancestry' }
      if (fresh.recovery.active === key) delete fresh.recovery.active
    }
    if (closed.length) writeRecovery(fresh)
    state.recovery = fresh.recovery
  } finally { unlock() }
}

// An item a cleared owner's next chat can still finish: this lane's, not closed or blocked,
// and not one trunk already holds (closeShippedRecovery closes those).
function carryableRecovery(r, lane) {
  return r.lane === lane && !['complete', 'reviewed', 'blocked'].includes(r.status) && !inTrunkRecovery(r)
}

// A recovery owner's pane cleared: claim carried its ended hold to the pane's new chat, and
// that chat must own the hold's unfinished recovery items too, or nobody can finish them -
// `recover` refuses another owner, `begin` refuses the HEAD the owner already moved, `ready`
// refuses the foreign item, and the old session holds no lane to verify from. Measured on
// assistant lane a 2026-10-04: the item stayed on 42113999 after the hold went to 21c80996.
// Only sessions this hold was carried from (`carriedFrom`: ended, same pane, by claim's
// filter), only this lane's items. A busy lock keeps `carriedFrom` so the next claim retries.
// An item trunk already holds stays put: carried, it would be the caller's own and `ready`
// would refuse it instead of closing it (closeShippedRecovery).
function carryRecovery(state, session, lane, hold) {
  const earlier = (r) => hold.carriedFrom.includes(r.owner) && carryableRecovery(r, lane)
  if (Object.values(state.recovery?.items ?? {}).some(earlier)) {
    const unlock = recoveryLock()
    if (!unlock) return
    try {
      const fresh = readRecovery({})
      if (fresh.recoveryError) return
      const carried = Object.values(fresh.recovery.items).filter(earlier)
      for (const r of carried) { r.owner = session; r.at = now() }
      if (carried.length) writeRecovery(fresh)
      state.recovery = fresh.recovery
    } finally { unlock() }
  }
  delete hold.carriedFrom
}

function preservedCheckout(state, lane) {
  const r = preservedRecovery(state, lane)
  if (!r) return null
  const dir = laneDir(lane)
  const head = gitSafe(dir, 'rev-parse', 'HEAD')
  const index = gitSafe(dir, 'ls-files', '-z')
  const tree = gitSafe(dir, 'ls-tree', '-r', '--name-only', 'HEAD')
  if (!isWorktree(dir) || !head.ok || !index.ok || !tree.ok || (!index.out && tree.out))
    throw new Error('preserved recovery checkout needs backup and explicit diagnosis before claim; no automatic repair')
  return dir
}

function recoveryBrief(key, r) {
  // The subcommand comes first: the entry reads it from argv[0], so a leading `--repo`
  // made every command in this brief `Unknown command "--repo"` (2026-10-01, pane 22).
  const cli = (sub) => `node ${JSON.stringify(join(here, 'lane.mjs'))} ${sub} --repo ${JSON.stringify(MAIN)}`
  return `Complete preserved abandoned work in ${MAIN}. Recovery key: ${key}. Pinned commit: ${r.commit}.
You are not alone. Preserve other owners, staged edits, private files and task intent. This is verification and authorized integration only; NEVER cut, tag, publish or install a release. Use the existing included native CLI provider route, no API credentials or pool fallback.
First read AGENTS.md and lane docs, back up the target files/index/ref before any repair. ${r.problem ?? ''} Missing/foreign worktrees or an empty index with tracked HEAD files require preservation and diagnosis; NEVER auto-stage deletions, reset, remove or reconstruct files on that evidence.
${r.ref ? `Review the pinned ref ${r.ref} at ${r.commit} against current trunk by content. Do not cherry-pick a moved ref or blindly merge by name. Claim an empty ordinary lane, assert its heldBy is your actual native conversation ID, then explicitly park --ref ${JSON.stringify(r.ref)} --lane <slot> before resuming reviewed intent. If no safe slot or ambiguous intent, record blocked/reviewed disposition.` : `Claim the exact lane: ${cli('claim')} --prefer ${r.lane} --cwd ${JSON.stringify(laneDir(r.lane))} --session <actual-native-id>. Assert the returned lane/dir and fresh status heldBy; a fallback slot is NOT authority to edit the original. If ownership changed, stop.`}
If this key is already owned by a chat whose pane is gone, a successor that holds the exact lane takes it over with ${cli('recover')} --key ${JSON.stringify(key)} --session <actual-native-id> --disposition adopt (refused while the old owner runs or if the lane no longer contains the pinned commit), then re-verifies.
Bind this recovery after the ownership readback: ${cli('recover')} --key ${JSON.stringify(key)} --session <actual-native-id> --disposition begin${r.ref ? ' --lane <claimed-slot>' : ''}.
Review intent and content equivalence, finish only intended work, run the repository's required PC checks (no Mac build/full-check fallback), obtain independent review, and commit verified work. Save a JSON receipt with commit, nonempty checks array of {command, exitCode: 0}, and review: {reviewer: <independent owner>, result: "accepted"}. Then ${cli('recover')} --key ${JSON.stringify(key)} --session <actual-native-id> --disposition verified --receipt <json-file>; normal ready requires this pinned verification before integration.
Run ${cli('ready')} --session <actual-native-id> --lane <owned-slot>. Read the real merge/push outcome and remote inclusion, then ${cli('recover')} --key ${JSON.stringify(key)} --session <actual-native-id> --disposition complete. A ready flag is not completion. Version-mode publication remains for Robert's publisher.
If blocked or content already equivalent, save a JSON receipt with reason/evidence and use --disposition blocked or reviewed with --receipt <file>. Keep the pinned work preserved. Do not leave an acknowledgment loop or silently abandon this pane.`
}

function dispatchCompletion() {
  // A corrupt ledger must never be interpreted as no owners.
  try { JSON.parse(readFileSync(STATE, 'utf8')) } catch { return null }
  const state = read()
  const living = recoveryLiving()
  const panes = openPanes()
  if (!living || !panes || state.release || state.recoveryError) return null
  const dirs = panes.dirs
  const processes = processDirs()
  if (!processes) return null
  state.recovery ??= { items: {} }
  state.recovery.items ??= {}
  const items = state.recovery.items
  // An item that lost the slot (an older recovery cleared `active` for another key) is still
  // owed a look: adopt the first unfinished one so the dead-owner check below resumes or
  // blocks it instead of leaving it `dispatched` forever (2026-10-04).
  if (!items[state.recovery.active]) {
    const lost = Object.values(items).find((r) => !['complete', 'reviewed', 'blocked'].includes(r.status))
    if (lost) state.recovery.active = lost.key ?? Object.keys(items).find((k) => items[k] === lost)
  }
  const active = items[state.recovery.active]
  let resume = null
  if (active && !['complete', 'reviewed', 'blocked'].includes(active.status)) {
    if (active.status === 'ready') {
      const remote = gitSafe(MAIN, 'ls-remote', '--exit-code', 'origin', `refs/heads/${MB}`)
      const tip = remote.out.split(/\s/)[0]
      if (remote.ok && /^[a-f0-9]{40,64}$/.test(tip) && gitSafe(MAIN, 'merge-base', '--is-ancestor', active.readyCommit, tip).ok) {
        active.status = 'complete'; active.remoteCommit = tip; active.at = now(); delete state.recovery.active; writeRecovery(state)
      } else return null
    } else {
      // A stopped turn, sleeping CLI, relocated pane or unknown open result is not death.
      if (active.pane === '?' || (active.owner && living.has(active.owner)) || (active.lane && state.lanes[active.lane]) || panes.ids.includes(active.pane) || now() - active.at < RETRY_MS) return null
      const current = active.ref ? parkedCommit(active.ref) : gitSafe(MAIN, 'rev-parse', '--verify', laneBranch(active.lane)).out
      if (active.status === 'dispatching' || !active.owner || current !== active.commit || (active.attempts ?? 1) >= 3) {
        const interrupted = active.status === 'dispatching'
        active.status = 'blocked'
        active.reason = interrupted ? 'interrupted pane delivery requires explicit inspection' : !active.owner ? 'completion pane ended without an adopted native owner; delivery and task intent require explicit inspection' : current !== active.commit ? 'completion owner ended after the pinned commit changed; explicit review required' : 'completion owner ended repeatedly; explicit review required'
        delete state.recovery.active; writeRecovery(state)
      } else resume = { ...active, owner: null }
    }
  }
  // Conflict recovery owns its own pane; do not create a second completion owner.
  if (Object.values(state.conflicts).some((c) => c.resolver || c.dispatch)) return null
  const candidates = []
  for (const id of POOL) {
    if (id === 'main' || state.lanes[id] || state.ready[id] || state.conflicts[id]) continue
    const dir = laneDir(id)
    if ([...dirs, ...processes].some((d) => within(d, dir))) continue
    const tip = gitSafe(MAIN, 'rev-parse', '--verify', laneBranch(id))
    if (!tip.ok) continue
    const diff = gitCherry(MAIN, MB, tip.out)
    const merged = gitSafe(MAIN, 'merge-base', '--is-ancestor', tip.out, MB)
    if (!diff.ok || (!merged.ok && merged.code !== 1)) continue
    let problem = null
    let dirt = ''
    if (!existsSync(dir)) problem = 'The checkout is missing; pinned local commits must be backed up before rebuilding.'
    else if (!isWorktree(dir)) problem = 'The folder is foreign or damaged; preserve it and diagnose before any repair.'
    else {
      // A copy a killed checkout left half made is not abandoned work: finish it when the
      // proof holds (finishCopy) and there is then nothing here to dispatch.
      if (halfMade(dir)) finishCopy(id, state)
      else dropFinishedLock(dir)
      const head = gitSafe(dir, 'rev-parse', 'HEAD')
      const status = gitSafe(dir, ...WORK_STATUS)
      const index = gitSafe(dir, 'ls-files', '-z')
      const tree = gitSafe(dir, 'ls-tree', '-r', '--name-only', 'HEAD')
      if (!head.ok || head.out !== tip.out || !status.ok || !index.ok || !tree.ok) continue
      dirt = status.out
      if (!index.out && tree.out) problem = 'HEAD has tracked files but the index is empty. Staged deletions are NOT established intent.'
      // A catch-up killed part way leaves trunk's own files here, not anybody's work: finish
      // it (tornCatchUp), or wait while a git may still be writing. Never a recovery chat.
      if (dirt && !problem && merged.ok) {
        const torn = tornCatchUp(dir)
        if (torn?.wait) continue
        if (torn?.finished) {
          console.log(`Lane ${id} finished catching up with ${MB}: an interrupted update had already written ${torn.paths.length} of its files.`)
          continue
        }
      }
    }
    // A release that rebased master onto origin gave a merged lane's commits new shas: the tip
    // is no longer an ancestor, yet every commit is '-'. With no merge commit (cherry never
    // lists merges, and one can carry content of its own) that lane holds nothing (ownsNothing).
    // PaneForge lane a 2026-10-09: 5f440ebc dispatched a recovery chat though master held it.
    // A git that fails to answer is "not nothing".
    if (!dirt && !/^\+ /m.test(diff.out)) {
      const merges = merged.ok ? null : gitSafe(MAIN, 'rev-list', '--merges', '-n1', `${MB}..${tip.out}`)
      if (merged.ok || (merges.ok && !merges.out)) continue
    }
    const key = `lane:${id}:${tip.out}`
    // `dirty`: the pinned work includes uncommitted changes, so trunk holding `commit` is
    // not proof it shipped (closeShippedRecovery).
    if (!items[key] || resume?.key === key) candidates.push({ ...(resume?.key === key ? resume : {}), key, lane: id, commit: tip.out, problem, ...(dirt && !machineWrittenPaths(dir) ? { dirty: true } : {}) })
  }
  discoveredParked(state)
  for (const p of [...Object.values(state.parkedWork ?? {}), ...unregisteredWip(state)]) {
    const key = `ref:${p.ref}:${p.commit}`
    if (items[key] && resume?.key !== key) continue
    const current = parkedCommit(p.ref)
    if (!current || current !== p.commit) {
      items[key] = { ...p, status: 'blocked', at: now(), reason: 'pinned ref moved or vanished; explicit review required' }
      continue
    }
    const merged = gitSafe(MAIN, 'merge-base', '--is-ancestor', p.commit, MB)
    if (merged.ok) { items[key] = { ...p, status: 'reviewed', at: now(), reason: 'included by trunk ancestry' }; continue }
    if (merged.code !== 1) continue
    candidates.push({ ...(resume?.key === key ? resume : {}), key, ref: p.ref, commit: p.commit, lane: null })
  }
  const r = candidates[0]
  if (!r) { writeRecovery(state); return null }
  const ctl = join(here, 'pf-ctl.mjs')
  const log = process.env.LANE_COMPLETION_LOG
  if (!log && (process.env.PF_CTL_NO_APP || !existsSync(ctl))) { writeRecovery(state); return null }
  const dir = r.lane && !r.problem ? laneDir(r.lane) : MAIN
  items[r.key] = { ...r, status: 'dispatching', at: now(), dispatcher: process.pid, attempts: (items[r.key]?.attempts ?? 0) + 1 }
  state.recovery.active = r.key
  writeRecovery(state) // reservation precedes any observable pane launch
  const prompt = recoveryBrief(r.key, r)
  let pane = null
  if (log) {
    appendFileSync(log, JSON.stringify({ key: r.key, dir, prompt }) + '\n')
    pane = 'logged'
  } else {
    seedTrust(dir)
    const opened = spawnSync(process.execPath, [ctl, 'open', dir, '--here', '--close-when-done', '--title', 'Finish preserved work', '--prompt', prompt], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
    if (opened.status === 0) pane = /(?:opened|sent to) (\S+)/.exec(opened.stdout ?? '')?.[1] ?? '?'
  }
  const fresh = read()
  const reserved = fresh.recovery?.items?.[r.key]
  if (reserved?.dispatcher !== process.pid) return null
  if (!pane) {
    reserved.status = 'blocked'
    reserved.reason = 'pane open failed or timed out; inspect delivery before explicit retry'
    delete fresh.recovery.active
  } else { reserved.status = 'dispatched'; reserved.pane = pane }
  writeRecovery(fresh)
  return pane ? { key: r.key, pane } : null
}

// Why `session` may NOT adopt lane item `r`, or null when it may. ONE predicate for `recover
// --disposition adopt` (holding: the caller must already hold the lane) and for claim's
// swap off `main` (holding: false, the lane is not yet the caller's), so they cannot drift.
function adoptRefusal(state, session, r, { holding }) {
  if (r.ref) return 'adopt is for lane items; a parked ref is reviewed through begin'
  if (!r.owner || r.owner === session) return 'this item has no other owner to take over from; use begin'
  if (!['owned', 'verified'].includes(r.status)) return `a ${r.status} item cannot be adopted; use begin or review it`
  if (holding && state.lanes[r.lane]?.session !== session) return 'claim the exact ordinary lane first: only its holder can adopt'
  if (Object.values(state.lanes).some((l) => l.session === r.owner)) return 'the previous owner still holds a lane'
  // null = inventory unknown. Allowed: the lane hold is the proof the old owner cannot
  // continue, since a lane is held by one chat at a time and the old owner holds none.
  if (recoveryLiving()?.has(r.owner)) return 'its owner is still running'
  if (!gitSafe(laneDir(r.lane), 'merge-base', '--is-ancestor', r.commit, 'HEAD').ok) return 'this lane does not contain the pinned commit; its work is not a continuation'
  return null
}

function recover(session, key, disposition, receiptPath, wanted) {
  if (!session || !key) throw new Error('recover needs an actual session and pinned key')
  const unlock = recoveryLock()
  if (!unlock) throw new Error('another recovery transaction owns this repository')
  try {
    const state = read()
    const r = state.recovery?.items?.[key]
    if (!r) throw new Error('unknown recovery key')
    if (disposition === 'adopt') {
      // A successor chat in ANOTHER pane takes over a dead owner's item (2026-10-07,
      // taskdriver-mobile): carryRecovery only follows a same-pane clear.
      const refusal = adoptRefusal(state, session, r, { holding: true })
      if (refusal) throw new Error(refusal)
      r.adoptedFrom = [...(r.adoptedFrom ?? []), r.owner]
      r.owner = session; r.status = 'owned' // a verified receipt belonged to the old owner
      r.at = now()
      writeRecovery(state)
      return r
    }
    if (r.owner && r.owner !== session) throw new Error('another recovery owner holds this key')
    if (disposition === 'begin') {
      if (['complete', 'reviewed', 'blocked'].includes(r.status)) throw new Error('this snapshot has a durable disposition; review it explicitly before retry')
      const lane = r.ref ? wanted : r.lane
      if (!lane || state.lanes[lane]?.session !== session) throw new Error('claim the exact ordinary lane and verify its owner first')
      if (r.ref && parkedCommit(r.ref) !== r.commit) throw new Error('pinned ref changed')
      if (!r.ref && gitSafe(laneDir(lane), 'rev-parse', 'HEAD').out !== r.commit) throw new Error('pinned lane HEAD changed before adoption')
      r.owner = session; r.lane = lane; r.status = 'owned'
    } else if (disposition === 'complete') {
      if (r.owner !== session || r.status !== 'ready' || !r.readyCommit) throw new Error('verified normal ready must precede completion')
      const remote = gitSafe(MAIN, 'ls-remote', '--exit-code', 'origin', `refs/heads/${MB}`)
      if (!remote.ok) throw new Error('cannot read remote inclusion')
      const tip = remote.out.split(/\s/)[0]
      if (!/^[a-f0-9]{40,64}$/.test(tip) || !gitSafe(MAIN, 'merge-base', '--is-ancestor', r.readyCommit, tip).ok) throw new Error('ready commit is not proven included in the remote trunk')
      r.status = 'complete'; r.remoteCommit = tip
    } else {
      if (!['verified', 'blocked', 'reviewed'].includes(disposition) || !receiptPath) throw new Error('supply a verified/blocked/reviewed disposition and JSON receipt')
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
      if (disposition === 'verified') {
        const head = gitSafe(laneDir(r.lane), 'rev-parse', 'HEAD')
        const checked = Array.isArray(receipt.checks) && receipt.checks.length && receipt.checks.every((c) => typeof c.command === 'string' && c.command.trim() && c.exitCode === 0)
        const reviewed = typeof receipt.review?.reviewer === 'string' && receipt.review.reviewer.trim() && receipt.review.reviewer !== session && receipt.review.result === 'accepted'
        if (r.owner !== session || state.lanes[r.lane]?.session !== session || !head.ok || receipt.commit !== head.out || !checked || !reviewed) throw new Error('verification receipt needs owned current commit, successful checks and accepted independent review')
      } else if (!receipt.reason) throw new Error('blocked/reviewed receipt requires an exact reason')
      r.receipt = receipt; r.status = disposition
    }
    r.at = now()
    // Only the item that holds the slot frees it: recording a disposition for another key
    // used to clear `active`, so the dispatched item was never looked at again (2026-10-04).
    if (['complete', 'reviewed', 'blocked'].includes(r.status) && state.recovery.active === key) delete state.recovery.active
    writeRecovery(state)
    return r
  } finally { unlock() }
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

/**
 * Has this hold's chat, by the evidence, stopped needing the checkout?
 *
 * Three ways to say yes, weakest first: an hour of silence (the original idle sweep - a
 * window open with nothing said and nothing left behind), a parked hold past its grace
 * (the Stop hook saw the turn END with the lane clean, so the wait is minutes), and a
 * parked VISITOR hold (a chat that lives in another project and stood here in passing -
 * the moment its turn ends clean it has no claim on anybody's patience at all). Callers
 * still check dirty/ready/conflict themselves - this only answers the liveness half.
 */
function holdGivenUp(c) {
  // A sleeping pane has not gone anywhere - its chat is paused, not idle - so within
  // ASLEEP_MAX_MS neither the silence sweep nor a park steal may take its lane. Past
  // that it falls through to the same reading everything else gets.
  if (c.asleep && now() - c.asleep <= ASLEEP_MAX_MS) return false
  if (now() - (c.seen ?? c.claimed ?? 0) > IDLE_EMPTY_MS) return true
  if (!c.parked) return false
  if (c.visitor) return true
  return now() - c.parked > PARK_STEAL_MS
}

/**
 * The Stop hook's word that a chat's turn ended with its lane clean.
 *
 * Records `parked` on every hold this session has whose lane holds no uncommitted work.
 * Nothing is released here and nothing can be lost: the chat keeps its lane, and speaks
 * again by claiming - which deletes the mark. All this changes is what another chat's
 * claim may conclude: a parked `main` is handed over in minutes (PARK_STEAL_MS, or at
 * once for a visitor) instead of the hour the silence sweep needs.
 */
/** A parked ref is deliberately narrower than a git revision expression. */
function parkedRef(raw) {
  if (!raw) throw new Error('park needs --ref')
  const ref = raw.startsWith('refs/') ? raw : raw.startsWith('origin/') ? `refs/remotes/${raw}` : `refs/heads/${raw}`
  if (!/^refs\/(?:heads|remotes\/origin)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes('..') || ref.endsWith('/'))
    throw new Error(`parked work needs a branch ref, not "${raw}"`)
  return ref
}

function parkedCommit(ref) {
  const r = gitSafe(MAIN, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`)
  return r.ok && /^[0-9a-f]{40}$/i.test(r.out.trim()) ? r.out.trim() : null
}

// Inventory only the three established parked-work spellings. The slot in the name is a
// useful recovery hint, not authority to alter a worktree: a ref can be an active branch,
// stale backup, or already-integrated work. An operator must explicitly park it before
// ordinary claim/cherry-pick/ready work can resume it.
function discoveredParked(state) {
  const r = gitSafe(MAIN, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin/lane-*', 'refs/remotes/origin/wip/lane-*', 'refs/remotes/origin/park/lane-*')
  if (!r.ok) return []
  const found = []
  for (const ref of r.out.split('\n').filter(Boolean)) {
    const m = /^refs\/remotes\/origin\/(?:lane-|wip\/lane-|park\/lane-)([A-Za-z0-9]+)-[A-Za-z0-9._-]+$/.exec(ref)
    if (!m || !POOL.includes(m[1])) continue
    const commit = parkedCommit(ref)
    if (!commit) continue
    found.push({ ref, commit, lane: m[1] })
    if (state.parkedWork[ref]) continue
    state.parkedWork[ref] = { ref, commit, lane: m[1], session: null, parkedAt: now(), discovered: true, reviewRequired: true }
    reaped = true
  }
  return found
}

function unregisteredWip(state) {
  const r = gitSafe(MAIN, 'for-each-ref', '--format=%(refname)', 'refs/heads/*-wip')
  if (!r.ok) return []
  return r.out
    .split('\n')
    .filter((ref) => /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*-wip$/.test(ref) && !state.parkedWork[ref])
    .map((ref) => ({ ref, commit: parkedCommit(ref), action: 'inspect, then park --ref <ref> --lane <empty slot>' }))
    .filter((p) => p.commit)
}

function registerParked(state, { ref: raw, lane, session }) {
  if (!lane || lane === 'main' || !POOL.includes(lane)) throw new Error('parked work needs a non-main configured --lane')
  const ref = parkedRef(raw)
  const commit = parkedCommit(ref)
  if (!commit) throw new Error(`cannot park ${raw}: that ref does not name a commit in this repository`)
  const old = state.parkedWork[ref]
  state.parkedWork[ref] = {
    ref,
    commit,
    lane,
    session: session ?? null,
    parkedAt: old?.parkedAt ?? now()
  }
  return state.parkedWork[ref]
}

function park(session, { ended = false, ref, lane } = {}) {
  if (!session) throw new Error('park needs --session')
  const state = reap(read())
  // Registering an external snapshot is independent of the Stop hook. In particular,
  // it must not mark the caller's active lane parked or update its session lifecycle.
  if (ref) {
    const saved = registerParked(state, { ref, lane, session })
    write(state)
    return { saved }
  }
  const parked = []
  for (const [id, c] of Object.entries(state.lanes)) {
    if (c.session !== session || c.parked) continue
    if (state.ready[id] || state.conflicts[id]) continue
    if (laneWork(id).dirty) continue
    c.parked = now()
    parked.push(id)
  }
  // A Stop hook is a chat finishing a turn: it was heard from, and it is not asleep. Not
  // bumping `seen` here is what let a hold read "last heard from 64h ago" under a pane
  // that had parked two minutes earlier.
  // `ended` (the SessionEnd hook, before its detached release): this session is over for
  // good - the one sign that a hold under an older session id in the same pane is that
  // pane's previous chat and not a live parent (see `claim`).
  // A sleeping pane's agent is stopped on purpose and comes back as the same session, so
  // its SessionEnd neither ends the hold nor wakes it (`releaseClaim` keeps asleep holds).
  for (const c of Object.values(state.lanes)) {
    if (c.session !== session) continue
    c.seen = now()
    if (!ended) delete c.asleep
    else if (!c.asleep) c.ended = now()
  }
  // A turn ending is the heartbeat. Only the trunk is ever published, and only once the
  // last thing we said is old enough that the other desk is about to stop believing it -
  // so an ordinary turn pushes nothing and a chat that works all afternoon keeps its
  // claim alive without anybody typing a command.
  const holdsTrunk = state.lanes.main?.session === session
  // An ending chat publishes nothing: its release, right behind, drops the claim anyway.
  if (!ended && holdsTrunk && needsRefresh(state.peer?.slot === 'main' ? state.peer : null, { now: now() }))
    publishClaim(state, 'main', session)
  else if (!holdsTrunk && state.peer?.slot === 'main' && state.peer.session === session) dropPublished(state, session)
  write(state)
  return { parked }
}

function reap(state) {
  discoveredParked(state)
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
    // A hold on a checkout that is not on disk. The folder was deleted, or the worktree was
    // never built, so nothing can ever be typed in it and no heartbeat will ever arrive -
    // and STALE_MS is twelve hours, so the row sat in `LANES ELSEWHERE` all day saying a
    // chat had a lane it could not have. 2026-08-24, `assistant`: three rows, a/b/c, each
    // "quiet 10h", against a repo whose only worktree was the trunk.
    //
    // The wait is TENTATIVE_MS rather than nothing, because a claim is written before the
    // worktree is built and a claim made seconds ago with no folder yet is a lane being
    // set up, not a ghost.
    //
    // A branch master does not have is the one thing that stops this. `drainLane` cannot
    // rescue it - every step it takes (`laneWork`, `catchUp`) needs a checkout, so with
    // the folder gone it returns null and the commits become invisible to a release, which
    // is lesson_release_decisions_read_local_tags' bug arriving by a different road. So a
    // ghost carrying commits is left to STALE_MS exactly as before, where the twelve-hour
    // path can rebuild nothing either but at least does not quietly widen the hole.
    if (
      id !== 'main' &&
      !existsSync(laneDir(id)) &&
      now() - (c.seen ?? c.claimed ?? 0) > TENTATIVE_MS &&
      !state.ready[id] &&
      !state.conflicts[id] &&
      aheadOf(laneBranch(id)) === 0
    ) {
      dropClaims(state, c.session)
      delete state.lanes[id]
      reaped = true
      continue
    }
    // A sleeping hold is not stale by silence - see holdGivenUp - until ASLEEP_MAX_MS says
    // otherwise, at which point it falls straight into the ordinary STALE_MS reading below.
    if (c.asleep && now() - c.asleep <= ASLEEP_MAX_MS) continue
    if (now() - (c.seen ?? c.claimed ?? 0) > STALE_MS) {
      // A chat that died without a SessionEnd hook never released its lane, and never
      // closed the `npm run try` window it left running either. Both go here - but its
      // COMMITS do not. A session that ends properly marks finished work ready on the way
      // out (releaseClaim); one that was killed, or that slept through a reboot, never
      // reached that line, and dropping its claim silently is what left real commits
      // sitting on a lane branch with nothing pointing at them. `shippable()` only counts
      // lanes that are marked ready, so the work was invisible until some later chat
      // happened to be handed that exact lane - days later, in the case this was found in.
      // Preserved unready work is dispatched for verification, never declared finished
      // merely because its checkout is clean and its commits survived.
      // Silence alone is not a dead native conversation. The all-copy inventory,
      // or an actual SessionEnd marker, must establish that this owner ended.
      const living = recoveryLiving()
      if (!c.ended && (!living || living.has(c.session))) continue
      dropClaims(state, c.session)
      delete state.lanes[id]
      closeLaneApps(laneDir(id))
      reaped = true
    }
  }
  if (state.release && now() - state.release.at > LOCK_MS) state.release = null
  // A conflict or a ready mark for work master already has is noise that never clears
  // itself: it made `status` report a lane as conflicted long after the conflict was
  // resolved, and left chats resolving something that had already gone out. Usually
  // zero iterations - this only walks lanes that are actually flagged.
  // Except while a merge is still open in the lane's folder: the record is what lets its
  // resolver write and commit there, and what lets retryConflicts drop an abandoned one.
  // Dropped anyway, `resolve --lane c` recorded the resolver and the next `status` erased
  // it, so the guard refused the very commit that finishes the merge (card 2, 2026-09-28).
  // (aheadOf is 0 for a lane whose only work of its own is a merge commit - cherry skips
  // merges - so this is not only the ownsNothing case, which `resolve` settles itself.)
  for (const id of Object.keys(state.conflicts)) {
    if (id === 'main' || aheadOf(laneBranch(id)) !== 0) continue
    if (existsSync(laneDir(id)) && gitSafe(laneDir(id), 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD').ok) continue
    delete state.conflicts[id]
  }
  for (const id of Object.keys(state.ready)) {
    if (id !== 'main' && aheadOf(laneBranch(id)) === 0) {
      // Dropping it is right - there is nothing of that lane's left to merge. Dropping it
      // in SILENCE is what cost a production fix on 2026-08-28: from every other chat, and
      // from the ledger, a lane that was quietly passed over looks exactly like one that
      // shipped. So the mark goes and a note stays, until that lane marks ready again.
      state.passed ??= {}
      state.passed[id] = { at: now(), commit: state.ready[id]?.commit ?? null, why: `nothing on ${laneBranch(id)} that ${MB} does not already have` }
      delete state.ready[id]
    }
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
    if (moved || Boolean(gitSafe(dir, ...WORK_STATUS).out)) delete state.ready[id]
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
 * Settle the conflicts that are not disagreements, in a lane nobody is sitting in.
 *
 * All-or-nothing on purpose: every conflicted file is read and resolved in memory first,
 * and one file it cannot take means nothing is written. Half a merge left in a worktree is
 * the state that stalled a lane for a day the last time it happened.
 *
 * Nothing is lost either way - the merge is still open, `--abort` still puts the lane back,
 * and rerere records what this did so the mirror-image conflict at release time replays it.
 */
function autoResolve(dir, files) {
  const writes = []
  for (const f of files) {
    let text
    try {
      text = readFileSync(join(dir, f), 'utf8')
    } catch {
      return []
    }
    const merged = mergeFromSides(dir, f, text)
    if (merged === null) return []
    writes.push([join(dir, f), merged])
  }
  if (!writes.length) return []
  for (const [p, text] of writes) writeFileSync(p, text)
  return files
}

/**
 * The marker rules (`mergeAutoConflicts`), plus the rules that need the three whole versions
 * rather than the markers: a generated JSON list (git cuts its hunks mid-entry), and markdown
 * list items (only the base tells an added row from a rewritten one) under count lines both
 * sides bumped (`countedSuffixes`). Read from the index stages an open merge holds - 1 base,
 * 2 ours, 3 theirs - so it is the same on the lane side and the release side. Markdown tries
 * the sides first: the marker rule joins two bullet lists and leaves the count above them one
 * short. null = not settled.
 */
function mergeFromSides(dir, f, text) {
  const marked = () => mergeAutoConflicts(text, f)
  const json = f.endsWith('.json')
  if (!json && !f.endsWith('.md')) return marked()
  const run = (args) =>
    execFileSync('git', args, { windowsHide: true,
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: hookTimeout(GIT_TIMEOUT_MS),
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024
    })
  let base, ours, theirs
  try {
    // Raw, not through git(): its trim() would eat the file's last newline.
    ;[base, ours, theirs] = [1, 2, 3].map((n) => run(['show', `:${n}:${f}`]))
  } catch {
    return marked() // added on both sides, deleted on one: no base for these rules
  }
  if (json) return marked() ?? mergeJsonListAdds(base, ours, theirs)
  const counted = countedSuffixes([base, ours, theirs])
  const tmp = mkdtempSync(join(tmpdir(), 'pf-merge-'))
  try {
    const paths = [['ours', ours], ['base', base], ['theirs', theirs]].map(([name, side]) => {
      writeFileSync(join(tmp, name), maskCounts(side, counted))
      return join(tmp, name)
    })
    let listed = null
    try {
      // Exit 0: with the counts set aside nothing conflicts at all.
      listed = run(['merge-file', '-p', '--diff3', '-L', 'ours', '-L', 'base', '-L', 'theirs', ...paths])
    } catch (e) {
      // It exits with the number of conflicts, and that is the case this is for.
      const diff3 = e.status > 0 && e.status < 128 && typeof e.stdout === 'string' ? e.stdout : null
      listed = diff3 === null ? null : mergeListAddConflicts(diff3)
    }
    const settled = listed ?? marked()
    return settled === null ? null : recount(settled, counted)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * Nothing checked out in `dir` that master lacks, asked strictly enough to throw a branch
 * away on: every commit `git cherry` lists is '-' (master has the same patch under another
 * sha) and there is no merge commit, because cherry never lists merges and a merge can
 * carry content of its own (a resolution, an evil merge). A git that fails to answer is
 * "not nothing" - `aheadOf` reads a failure as 0, which is fine for a count and wrong for
 * a reset. Reads HEAD, so mid-merge it asks about the lane's own side.
 */
function ownsNothing(dir) {
  const cherry = gitCherry(dir, MB, 'HEAD')
  if (!cherry.ok || cherry.out.split('\n').some((l) => l.startsWith('+'))) return false
  const merges = gitSafe(dir, 'rev-list', '--merges', '-n1', `${MB}..HEAD`)
  return merges.ok && !merges.out
}

/**
 * Two chats that each add "the next" database migration both pick the same number, and
 * git merges the two files without a word - they have different names - so the clash only
 * shows when the migrations run. taskdriver.ai's history has it done by hand ("Renumber
 * client-emails migration to 210 (main took 209 for x-monitor)"). So right after a merge
 * commit lands in `dir`, a file `mine` added under a `migrations` folder that has the same
 * number as one `other` added in that folder is given the next free number there, and the
 * merge commit is amended to carry the rename. Only `mine`'s file moves: the other side's
 * may already have run somewhere.
 *
 * Numbers are 1-6 digits followed by - or _ (`supabase-migration-210-x.sql`, `0012_add.sql`);
 * timestamps (8+ digits) never collide this way and are left alone. Returns ['old -> new'].
 */
const MIGRATION_NAME = /^(.*?)(?<!\d)(\d{1,6})([-_].+)$/

function renumberMigrations(dir, mine, other) {
  if (!gitSafe(dir, 'rev-parse', '--verify', '-q', 'HEAD^2').ok) return []
  const base = gitSafe(dir, 'merge-base', mine, other)
  if (!base.ok || !base.out) return []
  const parse = (path) => {
    const parts = path.split('/')
    if (!parts.slice(0, -1).some((p) => p.toLowerCase() === 'migrations')) return null
    const m = MIGRATION_NAME.exec(parts[parts.length - 1])
    return m && { path, dir: parts.slice(0, -1).join('/'), name: parts[parts.length - 1], prefix: m[1], n: Number(m[2]), width: m[2].length, rest: m[3] }
  }
  const added = (side) => {
    const r = gitSafe(dir, 'diff', '--name-only', '--no-renames', '--diff-filter=A', base.out, side)
    return r.ok ? r.out.split('\n').filter(Boolean).map(parse).filter(Boolean) : []
  }
  const theirs = added(other)
  if (!theirs.length) return []
  const renamed = []
  for (const f of added(mine)) {
    const clash = theirs.some((o) => o.dir === f.dir && o.prefix === f.prefix && o.n === f.n && o.name !== f.name)
    if (!clash) continue
    // The index, not HEAD: a rename made a moment ago in this loop has taken its number.
    const inDir = gitSafe(dir, 'ls-files', '--', `${f.dir}/`).out.split('\n').filter(Boolean).map(parse)
    const top = Math.max(...inDir.filter((x) => x && x.dir === f.dir && x.prefix === f.prefix).map((x) => x.n))
    const name = `${f.prefix}${String(top + 1).padStart(f.width, '0')}${f.rest}`
    const to = `${f.dir}/${name}`
    if (gitSafe(dir, 'mv', '--', f.path, to).ok) renamed.push([f.path, to])
  }
  if (!renamed.length) return []
  if (!gitSafe(dir, 'commit', '-q', '--amend', '--no-edit', '--no-verify').ok) {
    // Put the names back rather than leave renames staged on top of a finished merge.
    for (const [from, to] of renamed) gitSafe(dir, 'mv', '--', to, from)
    return []
  }
  return renamed.map(([from, to]) => `${from} -> ${to}`)
}

/**
 * The lane's own typecheck, run in the lane folder after it took in master's newer work.
 * Two sides that each compile can stop compiling together (2026-10-02: a "clean" merge of
 * master into a lane left three PC suites red, because nothing re-checked after it). null
 * means pass, or nothing to say: no typecheck script, a run that never started (no
 * node_modules in the lane folder), a timeout, or the taskdriver PC proof owning it.
 */
function laneTypecheckFailure(dir) {
  if (TASKDRIVER_PC) return null
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
  if (!pkg.scripts?.typecheck) return null
  const r = spawnSync('npm run --silent typecheck', { cwd: dir, shell: true, timeout: 150_000, windowsHide: true, encoding: 'utf8' })
  if (r.status === 0 || r.signal || r.error) return null
  const all = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  if (cannotRun(all)) return null
  const errors = all.split('\n').map((l) => l.trim()).filter((l) => /error TS/.test(l)).slice(0, 3)
  return errors.length ? errors.join('; ') : firstLine(all)
}

/**
 * Finish a catch-up fast-forward that was killed part way through, when nothing in the
 * folder can be anybody's work.
 *
 * A fast-forward writes the incoming files first and the index last, so a kill in between
 * (the app stops `retry` at 10s) leaves the lane on its old commit with some of trunk's files
 * on disk and git's index.lock behind. That reads as uncommitted work, and on 2026-10-08
 * (clients repo, lane b: 16 of 31 files written) it opened a "Finish preserved work" chat for
 * files that were byte for byte trunk's.
 *
 * The proof, every part required: no merge, rebase, cherry-pick or revert is open; HEAD is
 * strictly behind trunk; every dirty path is a changed, added or untracked regular file (no
 * deletion, rename, type change or conflict) whose content IS trunk's blob for that path; and
 * no git holds the index (an index.lock younger than STALE_LOCK_MS, the dropStaleLock rule,
 * means wait). Then the abandoned lock goes, exactly those paths are staged, and the lane
 * fast-forwards to trunk (`--ff-only`: nothing on disk can be overwritten). Nothing is lost:
 * every byte that was there is the byte trunk puts there.
 *
 * null = not this shape (the caller carries on as before); { wait, why } = the shape, but a
 * git may be running; { finished: true, paths }; { finished: false, why } = the proof held but
 * git refused, so the lane is real work again for whoever looks next.
 */
function tornCatchUp(dir) {
  // Cheapest first: a lane with its own commits, or a clean one, is answered in a few calls.
  const head = gitSafe(dir, 'rev-parse', '--verify', 'HEAD')
  const trunk = gitSafe(dir, 'rev-parse', '--verify', `refs/heads/${MB}`)
  if (!head.ok || !trunk.ok || head.out === trunk.out) return null
  if (!gitSafe(dir, 'merge-base', '--is-ancestor', head.out, trunk.out).ok) return null
  const status = rawStatus(dir)
  if (!status) return null
  for (const h of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    if (gitSafe(dir, 'rev-parse', '--verify', '--quiet', h).ok) return null
  }
  const paths = []
  for (const entry of status.split('\0')) {
    if (!entry) continue
    const x = entry[0]
    const y = entry[1]
    const path = entry.slice(3)
    const untracked = x === '?' && y === '?'
    if (!path || path.includes('\n') || (!untracked && (!' MA'.includes(x) || !' M'.includes(y)))) return null
    paths.push(path)
  }
  if (!paths.length) return null
  const listing = gitWith(dir, ['ls-tree', '-r', '-z', '--full-tree', trunk.out])
  if (!listing.ok) return null
  const blobs = new Map()
  for (const rec of listing.out.split('\0')) {
    const tab = rec.indexOf('\t')
    if (tab < 0) continue
    const [mode, type, sha] = rec.slice(0, tab).split(' ')
    if (type === 'blob' && (mode === '100644' || mode === '100755')) blobs.set(rec.slice(tab + 1), sha)
  }
  for (const p of paths) {
    if (!blobs.has(p)) return null
    try {
      if (!lstatSync(join(dir, p)).isFile()) return null
    } catch {
      return null
    }
  }
  // Content as git would store it: the path's own clean filters and line endings applied.
  const hashed = gitWith(dir, ['hash-object', '--stdin-paths'], { input: paths.join('\n') + '\n' })
  if (!hashed.ok) return null
  const shas = hashed.out.split('\n')
  if (shas.length !== paths.length || paths.some((p, i) => shas[i] !== blobs.get(p))) return null
  const lockPath = gitSafe(dir, 'rev-parse', '--git-path', 'index.lock')
  if (!lockPath.ok) return null
  const lock = resolve(dir, lockPath.out)
  try {
    if (existsSync(lock)) {
      if (now() - statSync(lock).mtimeMs < STALE_LOCK_MS && !finisherGone(lock)) return { wait: true, why: 'a git process may still be writing this folder' }
      // Moved aside first so two of these racing cannot both think they freed it.
      const aside = `${lock}.paneforge-${process.pid}`
      renameSync(lock, aside)
      rmSync(aside, { force: true })
    }
  } catch {
    return { wait: true, why: 'its index.lock could not be cleared' }
  }
  const staged = gitWith(dir, ['--literal-pathspecs', 'add', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: paths.join('\0') + '\0' })
  if (!staged.ok) return { finished: false, why: `git add: ${firstLine(staged.out)}` }
  const ff = gitSafe(dir, 'merge', '--ff-only', trunk.out)
  if (!ff.ok) return { finished: false, why: `git merge --ff-only: ${firstLine(ff.out)}` }
  const after = gitSafe(dir, 'rev-parse', 'HEAD')
  if (!after.ok || after.out !== trunk.out || gitSafe(dir, ...WORK_STATUS).out) return { finished: false, why: 'the fast-forward left changes behind' }
  return { finished: true, paths }
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
  // An earlier catch-up of this lane killed part way through is finished, not called dirty.
  const torn = tornCatchUp(dir)
  if (torn?.wait) return { moved: false, conflicts: [], dirty: false, blocked: torn.why }
  if (torn?.finished) return { moved: true, conflicts: [], dirty: false, torn: torn.paths }
  // Never merge on top of someone's uncommitted edit. A file the repo itself declares
  // machine-written is not one: it is committed first, so a lane whose hook rewrites its
  // ledger at every turn boundary is not dirty forever (see commitMachineWritten).
  if (gitSafe(dir, ...WORK_STATUS).out && !commitMachineWritten(dir)) {
    return { moved: false, conflicts: [], dirty: true }
  }
  // Already contains master -> nothing to do (and no empty merge commit).
  if (gitSafe(dir, 'merge-base', '--is-ancestor', MB, 'HEAD').ok) {
    return { moved: false, conflicts: [], dirty: false }
  }
  enableRerere()
  const m = gitSafe(dir, 'merge', '--no-edit', MB)
  if (m.ok) return { moved: true, conflicts: [], dirty: false, renamed: renumberMigrations(dir, 'HEAD^1', 'HEAD^2') }
  // A lock that outlived the retry in gitSafe is a live git somewhere else, not a
  // disagreement: report "not now" so the caller leaves the lane alone and tries again,
  // instead of recording a conflict that no amount of resolving would ever clear.
  if (m.locked) {
    gitSafe(dir, 'merge', '--abort')
    return { moved: false, conflicts: [], dirty: false, blocked: 'another git is using this repository' }
  }
  // Same for a git that never answered, or stopped with no file unmerged: not a conflict.
  const unmerged = m.died ? null : gitSafe(dir, 'diff', '--name-only', '--diff-filter=U')
  let conflicts = unmerged?.ok ? unmerged.out.split('\n').filter(Boolean) : []
  if (!conflicts.length) {
    gitSafe(dir, 'merge', '--abort')
    return { moved: false, conflicts: [], dirty: false, blocked: `git stopped the merge with no file in disagreement: ${firstLine(m.out)}` }
  }
  // Import-block collisions are settled here rather than being handed to whoever reads the
  // status next. They are the commonest conflict two lanes on one feature produce and the
  // only one with a right answer that needs no context.
  const healed = conflicts.length ? autoResolve(dir, conflicts) : []
  if (healed.length) {
    for (const f of healed) gitSafe(dir, 'add', '--', f)
    const left = gitSafe(dir, 'diff', '--name-only', '--diff-filter=U')
      .out.split('\n')
      .filter(Boolean)
    if (!left.length && gitSafe(dir, 'commit', '--no-edit').ok) {
      return { moved: true, conflicts: [], dirty: false, healed, renamed: renumberMigrations(dir, 'HEAD^1', 'HEAD^2') }
    }
    conflicts = left
  }
  // A lane whose every commit master already has under another sha (`git cherry` '-': its
  // work was rebased or cherry-picked onto master) has nothing of its own to keep, and
  // master's later edits to those files make the catch-up merge conflict with a stale copy
  // of its own work. It was called "finished but conflicts" on every release with nothing
  // to ship (taskdriver.ai 2026-09-28, lanes c/d). The folder is clean (checked above), so
  // the lane simply moves to master (a hard reset also drops the open merge); the old tip
  // stays in the branch's reflog. Asked strictly (ownsNothing), never through aheadOf.
  if (conflicts.length && ownsNothing(dir) && gitSafe(dir, 'reset', '--hard', '-q', MB).ok)
    return { moved: true, conflicts: [], dirty: false, nothingOwn: true }
  // The half-merge is only left in the tree for the chat that asked to finish this lane
  // (`ready`), which is the one moment someone is there to resolve it. Every other caller
  // gets the lane back the way it found it - a conflicted checkout nobody owns is what
  // stalled lane-b for a day and made auto-sync pop "unmerged files" every run.
  if (!keepConflict || !conflicts.length) gitSafe(dir, 'merge', '--abort')
  return { moved: false, conflicts, dirty: false }
}

/**
 * A dirty path is not somebody's uncommitted edit when the repository itself says a
 * machine writes it: its .gitattributes gives it a `union` or `take-incoming` merge
 * driver, which is only ever declared for append-only ledgers, logs and per-session
 * checkpoints. (2026-09-19, claude-memory lane-a: the session holding the lane rewrote
 * its checkpoint json, three ledger jsonl files and the prompt log at EVERY hook
 * boundary, so the lane read as dirty on every retry and never caught up with master
 * until somebody merged it by hand.)
 *
 * Asked of git (`check-attr`), never of a path list, so nothing here knows any repo's
 * layout. Every dirty path must qualify: one hand edit beside them keeps the old
 * refusal. Nothing is committed while a merge or rebase is open, and an unmerged path
 * never qualifies whatever its driver says.
 */
const MACHINE_MERGE_DRIVERS = new Set(['union', 'take-incoming'])
const LEDGER_SUBJECT = 'chore: session ledger + prompt log'

// `status --porcelain -z`, or null when git could not answer. Raw, not through git(): its
// trim() eats the leading space of ` M path`, and the first path would come back one
// character short.
function rawStatus(dir) {
  try {
    return execFileSync('git', [...WORK_STATUS, '-z'], { windowsHide: true,
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: hookTimeout(GIT_TIMEOUT_MS),
      killSignal: 'SIGKILL'
    })
  } catch {
    return null
  }
}

function machineWrittenPaths(dir) {
  if (gitSafe(dir, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD').ok) return null
  if (gitSafe(dir, 'rev-parse', '--verify', '--quiet', 'REBASE_HEAD').ok) return null
  const status = rawStatus(dir)
  if (!status) return null
  const paths = []
  const fields = status.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]
    if (!entry) continue
    const x = entry[0]
    const y = entry[1]
    const path = entry.slice(3)
    // A rename or copy carries its source in the next field; the source path is the
    // one that vanished, which no ledger does.
    if (x === 'R' || x === 'C') return null
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return null
    if (!path) return null
    paths.push(path)
  }
  if (!paths.length) return null
  // `-z --stdin`: one path per NUL in, `path NUL attr NUL value NUL` out.
  let attr
  try {
    attr = execFileSync('git', ['check-attr', '-z', '--stdin', 'merge'], { windowsHide: true,
      cwd: dir,
      input: paths.join('\0') + '\0',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: hookTimeout(GIT_TIMEOUT_MS),
      killSignal: 'SIGKILL'
    })
  } catch {
    return null
  }
  const answered = new Map()
  const out = attr.split('\0')
  for (let i = 0; i + 2 < out.length; i += 3) answered.set(out[i], out[i + 2])
  for (const p of paths) {
    if (!MACHINE_MERGE_DRIVERS.has(answered.get(p))) return null
  }
  return paths
}

/** Commit the machine-written dirt so the lane can merge; false when it is a real edit. */
function commitMachineWritten(dir) {
  const paths = machineWrittenPaths(dir)
  if (!paths) return false
  if (!gitSafe(dir, 'add', '--', ...paths).ok) return false
  if (!gitSafe(dir, 'commit', '-q', '--no-verify', '-m', LEDGER_SUBJECT, '--', ...paths).ok) return false
  // Still dirty means something was written between the two reads: not ours to judge.
  return !gitSafe(dir, ...WORK_STATUS).out
}

/**
 * The git operation a checkout is in the middle of - merge, rebase, cherry-pick or revert -
 * or null. Everything a half-done operation keeps (MERGE_HEAD, the rebase folders, the
 * staged resolution) lives in the checkout's own git folder, so one lookup answers all four.
 * A folder git will not answer about reads as "in the middle of something": the caller is
 * deciding whether it may undo work, and "unknown" is not permission.
 */
function openOperation(dir) {
  const g = gitSafe(dir, 'rev-parse', '--absolute-git-dir')
  if (!g.ok || !g.out) return 'unknown'
  const found = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'].find((n) =>
    existsSync(join(g.out, n))
  )
  return found ?? null
}

/**
 * Make a free lane safe to hand to a new chat.
 *
 * Nothing here can lose work - it only touches a lane no live session holds, and only resets
 * a branch whose commits master already has. A checkout with a merge, rebase, cherry-pick or
 * revert open is not touched at all (2026-10-02, claude-memory lane b: a claim aborted the
 * merge a chat was finishing and reset the folder, its staged resolution gone). The chooser
 * never hands out a lane with uncommitted work on its own, so the only claim that reaches
 * a half-done operation is one that asked for that exact folder - a chat protecting the work
 * in it - and undoing the operation is the one thing that chat cannot be given back.
 */
function healLane(id) {
  const dir = laneDir(id)
  if (id === 'main' || !existsSync(dir)) return null
  // Nothing below can be asked of a folder git will not answer about, and asking anyway
  // is what made a broken lane look like one with uncommitted work in it. ensureWorktree
  // owns that repair; every caller here has already been through it.
  if (!isWorktree(dir)) return null
  if (openOperation(dir)) return null
  const did = []
  const clean = !gitSafe(dir, ...WORK_STATUS).out
  if (clean && aheadOf(laneBranch(id)) === 0) {
    // Every change in this lane is already in master: start the next chat from master
    // instead of from a branch full of commits that only look unshipped.
    if (gitSafe(dir, 'reset', '--hard', MB).ok) did.push(`reset to ${MB}`)
  } else if (clean) {
    const c = catchUp(id)
    if (c.moved) did.push(`merged ${MB}`)
    if (c.conflicts.length) did.push(`conflicts with ${MB} in ${c.conflicts.join(', ')}`)
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
    // The card this conflict episode already raised (see clashCards). Kept across
    // re-records - a release rebuilds the whole conflict list - so no tick raises a second.
    card: was?.card ?? null,
    master: gitSafe(MAIN, 'rev-parse', MB).out,
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
function mergeFiles(out, unmerged) {
  const files = new Set()
  for (const line of out.split('\n')) {
    const conflict = /Merge conflict in (.+)$/.exec(line)
    const preimage = /Recorded preimage for '(.+)'/.exec(line)
    if (conflict) files.add(conflict[1].trim())
    else if (preimage) files.add(preimage[1])
  }
  // Git's sentences name only content conflicts (and only on the channel errText kept);
  // the unmerged list git itself reports always names the files.
  return (files.size ? [...files] : unmerged).join(', ')
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
  const head = gitSafe(MAIN, 'rev-parse', MB).out
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
    // Git busy or killed: the retry did not happen, so the conflict neither clears nor changes.
    if (caught.blocked) continue
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
  const r = gitSafe(MAIN, 'merge-tree', '--write-tree', '--name-only', MB, laneBranch(id))
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

/**
 * Give Claude Code's trust entry for the repo to `dir`, so a pane opened there does not
 * stop on "Do you trust the files in this folder?" with "No, exit" preselected - the
 * queued prompt's Enter answers it and the chat exits within seconds (2026-09-12, two
 * panes lost that way). Nothing is granted the repo did not already have; a folder with
 * its own entry keeps it and only gains trust (Claude Code writes an untrusted default
 * there itself). Same idea as seedClaudeProjectSettings in lanes.ts.
 */
function seedTrust(dir) {
  const home = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
  const path = [join(home, '.claude.json'), join(homedir(), '.claude.json')].find((p) => existsSync(p))
  if (!path) return
  const forms = (p) => [resolve(p), resolve(p).replace(/\\/g, '/')]
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    if (!data.projects) return
    // Claude Code writes an untrusted default entry the first time it runs in a folder;
    // only trust is added to that, the rest of it is the folder's own.
    const own = forms(dir).filter((k) => data.projects[k])
    const untrusted = own.filter((k) => data.projects[k].hasTrustDialogAccepted !== true)
    if (own.length && !untrusted.length) return
    const from = forms(MAIN)
      .map((k) => data.projects[k])
      .find((e) => e?.hasTrustDialogAccepted === true)
    if (!from) return
    if (own.length) {
      for (const k of untrusted) data.projects[k] = { ...data.projects[k], hasTrustDialogAccepted: true }
    } else {
      const KEEP = ['allowedTools', 'mcpContextUris', 'mcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers',
        'hasTrustDialogAccepted', 'hasCompletedProjectOnboarding', 'projectOnboardingSeenCount',
        'hasClaudeMdExternalIncludesApproved', 'hasClaudeMdExternalIncludesWarningShown']
      const entry = {}
      for (const k of KEEP) if (k in from) entry[k] = from[k]
      for (const k of forms(dir)) data.projects[k] = { ...entry }
    }
    const tmp = `${path}.lane.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, path)
  } catch {
    /* unreadable or mid-write by a live CLI - the pane may ask, which is the old behaviour */
  }
}

/** The number a person sees for a lane's folder: copy 2 is lane a (see place.ts copyNumber). */
function copyName(id) {
  return /^[a-z]$/.test(id) ? `copy ${id.charCodeAt(0) - 97 + 2}` : `copy ${id}`
}

/**
 * A repository in the OS temp folder is a test fixture, never a person's project. The suites
 * build real repos there and run the real engine, and a card from one of them reached
 * GuardDeck for real ("Two chats changed the same lines in demo", 2026-10-02), so no card is
 * ever sent for one - tests that want to see a card set LANE_DISPATCH_LOG.
 */
function inTempFolder(dir) {
  try {
    const t = realpathSync(tmpdir())
    const d = realpathSync(dir)
    return d === t || d.startsWith(t + sep)
  } catch {
    return false
  }
}

/**
 * Write this chat's hold down where the SessionEnd hook looks for it.
 *
 * The hook (lane-hook.mjs) gives back only the repos listed under `sessions[<chat>]` in
 * ~/.claude/lane-repos.json, and until now only the hook's own prompt/guard claims wrote
 * there. A hold taken by `lane.mjs claim` from a chat's shell (the engine's own CLI) was
 * never listed, so when that chat ended nothing parked it as `ended`, and the pane's next
 * chat after /clear could not carry it (carry needs `c.ended`): the lane sat stranded under
 * the dead chat's id with its work (Toolstash lane c, 2026-10-09).
 *
 * Only `sessions` is touched - `repos` is the guard's cache of "this repo has lanes" and
 * its `release`/`own` come from the hook's own look at the claim. Same tmp-then-rename as
 * the hook's writeRegistry so a half-written file cannot blind the guard. Never throws, and
 * a registry that exists but does not parse is left alone rather than overwritten. A repo in
 * the temp folder (every suite's fixtures) is skipped unless LANE_REGISTRY points the write
 * at a scratch file, so no test can leave a throwaway repo in the real registry.
 */
function registerSession(session) {
  try {
    if (!session) return
    const override = process.env.LANE_REGISTRY
    if (!override && inTempFolder(MAIN)) return
    const path = override || join(homedir(), '.claude', 'lane-repos.json')
    let reg = { repos: {}, sessions: {} }
    if (existsSync(path)) {
      try {
        reg = JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        return
      }
      if (!reg || typeof reg !== 'object' || Array.isArray(reg)) return
    } else {
      mkdirSync(dirname(path), { recursive: true })
    }
    if (!reg.repos || typeof reg.repos !== 'object') reg.repos = {}
    if (!reg.sessions || typeof reg.sessions !== 'object') reg.sessions = {}
    let repo = MAIN
    try {
      repo = realpathSync(MAIN)
    } catch {
      /* keep the path as given */
    }
    const fold = process.platform === 'win32' || process.platform === 'darwin'
    const key = (p) => (fold ? String(p).toLowerCase() : String(p))
    const mine = Array.isArray(reg.sessions[session]) ? reg.sessions[session] : []
    if (mine.some((p) => key(p) === key(repo))) return
    reg.sessions[session] = [...mine, repo]
    const tmp = `${path}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n', 'utf8')
      renameSync(tmp, path)
    } catch (e) {
      // A lost rename must not leave this pid's tmp behind (the hook's writer left ~90).
      try {
        unlinkSync(tmp)
      } catch {
        /* already gone, or never written */
      }
      throw e
    }
  } catch {
    /* the hook still gives back what it registered itself, which is the old behaviour */
  }
}

/**
 * Raise ONE card for each conflict nobody is going to settle.
 *
 * This used to open a resolver chat of its own ("Settle lane X"). Measured from the
 * transcripts: 11 of those in the week of 21 Sep and 4 more in the next five days, plus the
 * take-over nudges that landed in unrelated chats - 162 minutes of chat time since 31 Aug,
 * for conflicts the retry, rerere and autoResolve below had already failed to settle, i.e.
 * the ones that need somebody who knows what both sides meant. A card says so once, to a
 * person, with the one line to paste into whichever chat they pick.
 *
 * Only for a conflict that is adoptable (its chat is quiet or gone and no resolver holds
 * it), and once per conflict episode: `c.card.since` remembers which `since` it was raised
 * for, so a conflict still sitting there hours later is not raised again, and one that
 * cleared and came back is. Runs after retryConflicts, so anything autoResolve settles is
 * already gone. Never opens a pane and never asks pf-ctl, so it runs with no app as well
 * (PF_CTL_NO_APP). Delivered through GuardDeck's notifier; when that is not on this
 * machine nothing is recorded, so the next tick tries again. `LANE_DISPATCH_LOG` stands in
 * for the notifier in tests: each card is appended to it as one JSON line.
 */
function clashCards(state) {
  const raised = []
  const log = process.env.LANE_DISPATCH_LOG
  const notify = [
    join(homedir(), 'Projects', 'claude-memory', 'claude-config', 'notify.mjs'),
    ...(process.platform === 'win32' ? [join(homedir(), 'Desktop', 'Projects', 'claude-memory', 'claude-config', 'notify.mjs')] : [])
  ].find((p) => existsSync(p))
  if (!log && (!notify || inTempFolder(MAIN))) return raised
  const engine = join(here, 'lane.mjs')
  for (const [id, c] of Object.entries(state.conflicts)) {
    if (id === 'main' || !existsSync(laneDir(id)) || !adoptable(state, id)) continue
    if (c.card?.since === c.since) continue
    const dir = laneDir(id)
    const title = `Two chats changed the same lines in ${basename(MAIN)}`
    const detail =
      `${basename(MAIN)} ${copyName(id)} (${dir}) and the main copy both changed ${c.detail || 'the same files'}, ` +
      `and the chat that wrote ${copyName(id)} has gone quiet. Its finished work waits until somebody keeps both changes. ` +
      `Paste this into any chat: Settle the clash in ${dir}: run node "${engine}" resolve --repo "${MAIN}" ` +
      `--session <that chat's id> --lane ${id}, keep both changes, commit, then ready --lane ${id}.`
    let via = null
    if (log) {
      appendFileSync(log, JSON.stringify({ lane: id, dir, card: true, title, detail }) + '\n')
      via = 'logged'
    } else {
      // The app's timer runs this under Electron-as-node; the notifier is plain node.
      const r = spawnSync(process.execPath, [notify, '--title', title, '--detail', detail, '--actor', 'paneforge'], {
        encoding: 'utf8',
        timeout: 20_000,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })
      if (r.status !== 0) continue
      via = 'GuardDeck'
    }
    c.card = { at: now(), since: c.since, via }
    raised.push({ id, via })
  }
  return raised
}

// ---------------------------------------------------------------- worktree setup

/**
 * Is this folder a checkout git will actually act on?
 *
 * `existsSync` used to be the whole test, and a lane folder can exist without being a
 * worktree: git prunes the registration when a branch goes away, an interrupted `worktree
 * add` leaves the folder, a crashed chat leaves the folder. What is left is an empty
 * directory wearing a lane's name - and because a git failure's text comes back in `out`,
 * every command in it reads as OUTPUT, which reads as uncommitted work. So the lane was
 * permanently "dirty": never healed, never rebuilt, never released from, and still handed
 * to the next chat as a working checkout, which then failed on its first git command.
 * PaneForge-a sat in exactly that state, and `claim` answered `"fresh": true` about it
 * (2026-08-02).
 *
 * And a checkout is not the same thing as a checkout OF THIS REPOSITORY. `--is-inside-work-tree`
 * was the whole test, so a separate CLONE of the same remote sitting at `<repo>-c` answered
 * yes and was adopted as lane c. Nothing errors and nothing says anything: the lane's commits
 * go into the other clone's object database while every ref decision here - `aheadOf`,
 * `drainLane`, the ready-mark check, `shippable` - reads THIS repo's refs, so the lane simply
 * never has anything to release, for ever. Measured on taskdriver.ai 2026-08-15, where
 * `taskdriver.ai-c` was a full clone on `lane-c` and doctor reported it as a held lane.
 *
 * The object database is the identity, never the path: a real worktree shares MAIN's
 * `--git-common-dir` and a clone has its own. That path is printed relative to the command's
 * cwd, so it is resolved against the folder it was asked about rather than trusted as written.
 */
function repoOf(dir) {
  const r = gitSafe(dir, 'rev-parse', '--git-common-dir')
  if (!r.ok || !r.out) return null
  return resolve(dir, r.out).toLowerCase()
}
/** MAIN's object database. Asked once - it cannot change while this process runs. */
let ownRepo
function isWorktree(dir) {
  if (gitSafe(dir, 'rev-parse', '--is-inside-work-tree').out !== 'true') return false
  ownRepo ??= repoOf(MAIN)
  const theirs = repoOf(dir)
  return Boolean(ownRepo && theirs && ownRepo === theirs)
}

/**
 * A lane copy whose checkout never finished.
 *
 * `git worktree add` writes `locked` = "initializing" into the new worktree's gitdir, checks
 * the files out, writes the index LAST, and only then removes the lock. Killed part way - the
 * 20s git deadline, a hook deadline taking the whole process tree - it leaves a registered
 * worktree with that lock, NO index and only the head of HEAD's files (index order) on disk.
 * isWorktree() calls that whole, so nothing rebuilt it; damageOf() calls it damaged (every
 * file reads as a staged deletion), so it left the pool for good; and the completion clock
 * sent a recovery pane at it. Measured on taskdriver.ai 7 Oct 2026: lane d (1,401 of 4,832
 * files missing) and lane f (531 of 4,831), every present file byte-identical to HEAD.
 *
 * ensureWorktree now adds with `--no-checkout` under its own lock (MAKING) and writes the
 * files itself (finishCopy), so the same kill leaves the same recognisable shape. Read from
 * the filesystem only: this runs for every lane on every `status`.
 */
const MAKING = 'paneforge: copy still being made'
// Writing a whole checkout is the one slow git call here (4,800 files ~9s on a Mac). It gets
// its own bound; a hook deadline still caps it (hookTimeout), and a kill leaves MAKING behind.
const CHECKOUT_TIMEOUT_MS = 10 * 60_000
function adminOf(dir) {
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(join(dir, '.git'), 'utf8'))
    return m ? resolve(dir, m[1]) : null
  } catch {
    return null
  }
}
function halfMade(dir) {
  const admin = adminOf(dir)
  if (!admin || existsSync(join(admin, 'index'))) return null
  let lock
  try {
    lock = readFileSync(join(admin, 'locked'), 'utf8').trim()
  } catch {
    return null
  }
  return lock === 'initializing' || lock === MAKING ? { admin, lock } : null
}

/** git with its own env, stdin and bound; never throws (same contract as gitSafe). */
function gitWith(cwd, args, { env, input, timeout = GIT_TIMEOUT_MS } = {}) {
  try {
    const out = execFileSync('git', args, {
      windowsHide: true,
      cwd,
      encoding: 'utf8',
      input,
      env: env ? { ...process.env, ...env } : undefined,
      stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
      timeout: hookTimeout(timeout),
      killSignal: 'SIGKILL'
    })
    return { ok: true, out: out.trim() }
  } catch (e) {
    return { ok: false, out: errText(e) }
  }
}

// What finishCopy writes into the index.lock it holds. git's own lock holds index bytes, never
// this, so a lock carrying it whose process is gone is abandoned now, not in STALE_LOCK_MS.
const FINISHING = 'paneforge finishing this copy, process '
function finisherGone(lock) {
  try {
    const fd = openSync(lock, 'r')
    const head = Buffer.alloc(80)
    const n = readSync(fd, head, 0, 80, 0)
    closeSync(fd)
    const m = new RegExp(`^${FINISHING}(\\d+)\n`).exec(head.toString('utf8', 0, n))
    if (!m) return false
    process.kill(Number(m[1]), 0)
    return false
  } catch (e) {
    return e.code === 'ESRCH'
  }
}

/** The lock left on a copy that IS whole: a kill landed between the index and the lock. */
function dropFinishedLock(dir) {
  const admin = adminOf(dir)
  if (!admin || !existsSync(join(admin, 'index'))) return
  try {
    const lock = readFileSync(join(admin, 'locked'), 'utf8').trim()
    // git writes the index last and only then unlinks "initializing"; ours goes the same way.
    if (lock === 'initializing' || lock === MAKING) unlinkSync(join(admin, 'locked'))
  } catch {
    /* no lock, or a person's own `git worktree lock` - left alone */
  }
}

/**
 * Finish a half-made lane copy (halfMade) - only when nothing in it can be anybody's work.
 *
 * The gate, every part of it required: the gitdir lock is git's "initializing" or ours, there
 * is no index, no git is writing it now (no index.lock younger than STALE_LOCK_MS), HEAD is
 * the lane branch and its tip, no open recovery item is pinned to the lane (`state`; only
 * reviewed/complete ones pass), nothing on disk is outside HEAD (no untracked or ignored
 * file), and every file that IS there is HEAD's byte for byte. It holds index.lock from the
 * file check to the end, so no git command can write the index meanwhile. Then: the index is
 * built from HEAD in a side file, ONLY the missing files are written - into a folder in the
 * gitdir first, each then linked in whole, so a kill never leaves a cut-off file in the copy -
 * git must report nothing, the side file becomes the index (two renames through the lock),
 * and the lock goes last. A kill anywhere in here leaves a copy this recognises again.
 * Files already there are never rewritten.
 *
 * Anything short of that is `{ finished: false, why }` and the copy is left as it was (an
 * abandoned index.lock aside): still damaged, never handed out, for a person
 * (docs/agents/lanes-and-releases.md). A refusal over file contents is remembered against the
 * files' sizes and times, so an unchanged copy is not read again on every claim (4,879 files
 * took 4.4s to read on a Mac).
 */
function finishCopy(id, state) {
  const dir = laneDir(id)
  const made = id !== 'main' && existsSync(dir) ? halfMade(dir) : null
  if (!made) return { finished: false, why: `lane ${id}'s copy is not one that never finished being made` }
  const no = (why) => ({ finished: false, why })
  const index = join(made.admin, 'index')
  const live = join(made.admin, 'index.lock')
  let held = false
  try {
    if (state && preservedRecovery(state, id)) return no('a recovery item is still open on it')
    if (existsSync(live) && now() - statSync(live).mtimeMs < STALE_LOCK_MS && !finisherGone(live)) return no('a git process may still be writing it (its index.lock is fresh)')
    const branch = laneBranch(id)
    const sym = gitWith(dir, ['symbolic-ref', '-q', 'HEAD'])
    const head = gitWith(dir, ['rev-parse', '--verify', '-q', 'HEAD'])
    const tip = gitWith(MAIN, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`])
    if (!sym.ok || sym.out !== `refs/heads/${branch}` || !head.ok || !tip.ok || head.out !== tip.out) return no(`its HEAD is not the tip of ${branch}`)
    // Abandoned (older than STALE_LOCK_MS, or a killed run of this, checked above). Moved
    // aside first so two of these racing for it cannot both take the lock: one rename finds it.
    const aside = `${live}.paneforge-${process.pid}`
    try {
      renameSync(live, aside)
      rmSync(aside, { force: true })
    } catch {
      /* none, or another one got it first - the exclusive create below settles which */
    }
    try {
      const fd = openSync(live, 'wx')
      held = true
      writeFileSync(fd, `${FINISHING}${process.pid}\n`)
      closeSync(fd)
    } catch {
      if (!held) return no('a git process started writing it')
      throw new Error('could not mark its index.lock as held')
    }
    if (existsSync(index)) return no('git wrote its index meanwhile')
    // What a killed run of this left in the gitdir (only reachable holding the lock).
    for (const n of readdirSync(made.admin)) if (/^(index\.paneforge-|index\.lock\.paneforge-|paneforge-stage-)\d+$/.test(n)) rmSync(join(made.admin, n), { recursive: true, force: true })
    const listing = gitWith(dir, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'])
    if (!listing.ok || !listing.out) return no(`git could not list HEAD: ${listing.out}`)
    const tracked = new Map()
    for (const rec of listing.out.split('\0')) {
      const tab = rec.indexOf('\t')
      if (tab < 0) continue
      const [mode, , sha] = rec.slice(0, tab).split(' ')
      tracked.set(rec.slice(tab + 1), { mode, sha })
    }
    const folders = new Set()
    for (const p of tracked.keys()) for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) folders.add(p.slice(0, i))
    // Stops at the first thing HEAD does not have: a chat's file, a build output, an ignored
    // folder - never walked into, so a stray node_modules costs one readdir, not a million.
    const present = []
    const walk = (rel) => {
      for (const e of readdirSync(rel ? join(dir, rel) : dir, { withFileTypes: true })) {
        const p = rel ? `${rel}/${e.name}` : e.name
        if (!rel && e.name === '.git') continue
        const t = tracked.get(p)
        if (e.isDirectory()) {
          if (t?.mode === '160000' && !readdirSync(join(dir, p)).length) {
            present.push({ path: p, gitlink: true, ...t })
            continue
          }
          if (!folders.has(p)) return p
          const stray = walk(p)
          if (stray) return stray
        } else if (!t || t.mode === '160000') return p
        else present.push({ path: p, link: e.isSymbolicLink(), ...t })
      }
      return null
    }
    const stray = walk('')
    if (stray) return no(`${stray} is in it and is not a file of HEAD (untracked or ignored)`)
    const memo = join(made.admin, 'paneforge-refused')
    const fp = createHash('sha256').update(head.out)
    for (const x of present) {
      const st = lstatSync(join(dir, x.path))
      fp.update(`\0${x.path}\0${st.size}\0${st.mtimeMs}\0${st.mode}`)
    }
    const key = fp.digest('hex')
    let seen = null
    try {
      seen = JSON.parse(readFileSync(memo, 'utf8'))
    } catch {
      /* none yet */
    }
    if (seen?.key === key && seen.why) return no(`${seen.why} (no file in it has changed since)`)
    const differs = (why) => {
      writeFileSync(memo, JSON.stringify({ key, why }))
      return no(why)
    }
    const files = present.filter((x) => !x.link && !x.gitlink)
    if (files.some((x) => x.path.includes('\n'))) return no('a file name in it has a line break')
    if (files.length) {
      const sums = gitWith(dir, ['hash-object', '--stdin-paths'], { input: files.map((x) => x.path).join('\n') + '\n', timeout: CHECKOUT_TIMEOUT_MS })
      if (!sums.ok) return no(`git could not read the files in it: ${sums.out}`)
      const got = sums.out.split('\n')
      // A plain file where HEAD has a link is how Windows checks a link out; anywhere else it differs.
      const off = files.find((x, i) => got[i] !== x.sha || (x.mode === '120000' && process.platform !== 'win32'))
      if (off) return differs(`${off.path} differs from HEAD`)
    }
    for (const x of present.filter((y) => y.link)) {
      const sum = x.mode === '120000' ? gitWith(dir, ['hash-object', '--stdin'], { input: readlinkSync(join(dir, x.path)) }) : null
      if (!sum?.ok || sum.out !== x.sha) return differs(`${x.path} differs from HEAD`)
    }
    const have = new Set(present.map((x) => x.path))
    const missing = [...tracked].filter(([p]) => !have.has(p))
    const side = join(made.admin, `index.paneforge-${process.pid}`)
    const stage = join(made.admin, `paneforge-stage-${process.pid}`)
    const env = { GIT_INDEX_FILE: side }
    try {
      let r = gitWith(dir, ['read-tree', 'HEAD'], { env })
      const write = missing.filter(([, t]) => t.mode !== '160000').map(([p]) => p)
      if (r.ok && write.length) {
        mkdirSync(stage)
        r = gitWith(dir, ['checkout-index', `--prefix=${stage.split(sep).join('/')}/`, '-z', '--stdin'], { env, input: write.join('\0'), timeout: CHECKOUT_TIMEOUT_MS })
      }
      if (!r.ok) return no(`git could not write the missing files: ${r.out}`)
      for (const p of write) {
        const from = join(stage, p)
        const to = join(dir, p)
        mkdirSync(dirname(to), { recursive: true })
        try {
          if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), to)
          else linkSync(from, to)
        } catch (e) {
          // Something put a file there since the walk: git status below judges it.
          if (e.code === 'EEXIST') continue
          if (e.code !== 'EXDEV') throw e
          // The gitdir on another disk: a plain copy, never over a file (cut off only by a kill).
          copyFileSync(from, to, fsConstants.COPYFILE_EXCL)
        }
      }
      // Not checked out = an empty folder, which is what git status expects to find.
      for (const [p] of missing.filter(([, t]) => t.mode === '160000')) mkdirSync(join(dir, p), { recursive: true })
      gitWith(dir, ['update-index', '-q', '--refresh'], { env, timeout: CHECKOUT_TIMEOUT_MS })
      const left = gitWith(dir, ['status', '--porcelain', '--untracked-files=all', '--ignored'], { env, timeout: CHECKOUT_TIMEOUT_MS })
      if (!left.ok || left.out) return no(`git still reports changes after the missing files were written: ${left.out.split('\n').slice(0, 3).join('; ')}`)
      if (existsSync(index)) return no('git wrote its index meanwhile')
      // git's own way in: the new index replaces the lock file, which then becomes the index.
      renameSync(side, live)
      renameSync(live, index)
      held = false
    } finally {
      rmSync(side, { force: true })
      rmSync(stage, { recursive: true, force: true })
    }
    rmSync(memo, { force: true })
    rmSync(join(made.admin, 'locked'), { force: true })
    return { finished: true, wrote: missing.length, kept: present.length }
  } catch (e) {
    return no(e.message)
  } finally {
    if (held) rmSync(live, { force: true })
  }
}

/**
 * What is in a folder that is not a checkout, besides the node_modules link this file put
 * there: the entries `ensureWorktree` refuses to build over. Callers ask only about a folder
 * already known not to be a worktree (`laneWork().broken`), so this costs one readdir.
 */
function strayIn(dir) {
  try {
    return readdirSync(dir).filter((name) => !(name === 'node_modules' && isLink(join(dir, name))))
  } catch (e) {
    return e?.code === 'ENOENT' ? [] : ['(unreadable)']
  }
}

function ensureWorktree(id) {
  const dir = laneDir(id)
  if (id === 'main') return dir
  // Left half made by a killed checkout (halfMade): finished when nothing in it can be
  // anybody's work, otherwise refused - never handed out with most of its files gone.
  if (existsSync(dir) && halfMade(dir) && isWorktree(dir)) {
    const done = finishCopy(id, read())
    if (!done.finished) throw new Error(`lane ${id}'s copy never finished being made and cannot be finished safely: ${done.why}`)
  } else if (existsSync(dir)) dropFinishedLock(dir)
  if (!existsSync(dir) || !isWorktree(dir)) {
    const branch = laneBranch(id)
    if (existsSync(dir)) {
      // Two things block `worktree add` on a folder that is already there, and this file
      // put both of them there itself: the node_modules junction below, and a stale
      // registration pointing at a worktree that no longer has a .git. Clear ours, then
      // ask git to forget what it is still holding.
      dropModulesLink(dir)
      gitSafe(MAIN, 'worktree', 'prune')
      // Anything else in there was somebody's work. Never guess at deleting it - say what
      // is in the way and which folder, which is the one thing a person can act on.
      let left = []
      try {
        left = readdirSync(dir)
      } catch {
        /* unreadable is its own answer below */
      }
      if (left.length) {
        // A folder that IS a checkout, of some other repository, is the one case where
        // "not a git worktree and is not empty" reads as nonsense - it looks like a
        // perfectly good lane to anybody standing in it. Name what it really is.
        const foreign = gitSafe(dir, 'rev-parse', '--is-inside-work-tree').out === 'true'
        throw new Error(
          foreign
            ? `lane ${id}'s folder is a separate clone, not a worktree of this checkout. Commits made ` +
              `there are invisible to ${basename(MAIN)} and nothing will ever merge or release them. ` +
              `Move ${dir} out of the way (or push its work to the remote first) and the lane rebuilds itself.`
            : `lane ${id}'s folder is not a git worktree and is not empty (${left.slice(0, 5).join(', ')}). ` +
              `Check what is in ${dir}, move it out, and it rebuilds itself.`
        )
      }
    }
    const known = gitSafe(MAIN, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).ok
    const existed = existsSync(dir)
    // Registered without its files, under our own lock: the checkout is the slow part and is
    // done below by finishCopy, so no kill can leave a copy nothing recognises (halfMade).
    const quick = ['--no-checkout', '--lock', '--reason', MAKING]
    // A reused lane branch may be behind master; start it fresh from master when new.
    const add = known
      ? ['worktree', 'add', ...quick, dir, branch]
      : ['worktree', 'add', ...quick, '-b', branch, dir, MB]
    let r = gitSafe(MAIN, ...add)
    // The branch still counts as checked out in a folder git has not been told is gone.
    // Only reachable once the folder above was proven empty, so nothing can be lost here.
    if (!r.ok && known) r = gitSafe(MAIN, 'worktree', 'add', '--force', ...quick, dir, branch)
    if (!r.ok) throw new Error(`could not create lane ${id}: ${r.out}`)
    const done = finishCopy(id, null)
    // Another process (the completion clock) may have finished it meanwhile (an index now),
    // or still be writing it (its index.lock): that copy is theirs to hand out, not ours to undo.
    const admin = adminOf(dir)
    if (!done.finished && halfMade(dir) && !(admin && existsSync(join(admin, 'index.lock')))) {
      // Everything in the folder is what this call just made (it was absent or proven empty
      // above), so taking it back loses nothing and the next claim starts clean. A folder
      // that was there stays there. If even this cannot run, the lock stays and the next
      // claim finishes the copy instead.
      const undone = gitSafe(MAIN, 'worktree', 'remove', '--force', '--force', dir)
      if (undone.ok && existed) mkdirSync(dir, { recursive: true })
      throw new Error(`could not create lane ${id}: its files could not be written (${done.why})`)
    }
    if (!done.finished && halfMade(dir)) throw new Error(`lane ${id}'s copy is still being made by another process: ${done.why}`)
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
  excludeModules(dir)
  hideLane(id)
  return dir
}

/**
 * Remove a lane's node_modules link WITHOUT following it.
 *
 * lstat, never stat, and never a recursive delete: a junction reports the shape of what
 * it points at, and deleting through one is how a lane took the MAIN checkout's real
 * node_modules with it and left a tree with no dependencies at all (2026-08-01). unlink
 * is the POSIX answer for a symlink and rmdir is the Windows answer for a junction; try
 * both and give up quietly rather than ever touching the target.
 */
function dropModulesLink(dir) {
  const link = join(dir, 'node_modules')
  let st
  try {
    st = lstatSync(link)
  } catch {
    return
  }
  if (!st.isSymbolicLink()) return
  try {
    unlinkSync(link)
  } catch {
    try {
      rmdirSync(link)
    } catch {
      /* a link we cannot remove is reported by the caller as a folder in the way */
    }
  }
}

/**
 * Keep the link above out of git from the worktree's own side.
 *
 * `.gitignore` said `node_modules/` for a long time, and a trailing slash matches a
 * directory and not a link - so `git add -A` in a lane committed the junction. Merging
 * that lane replaced the main checkout's REAL node_modules with a symlink pointing at
 * itself and the tree the merge landed in had no dependencies at all (2026-08-01, lane
 * a). The .gitignore is fixed, but a lane branch cut before that fix still carries the
 * old one; `info/exclude` lives in the shared .git, applies to the main checkout and
 * every lane worktree at once, and is on no branch at all - so it holds whatever the
 * lane has checked out. Run on every ensureWorktree rather than only at creation, so
 * lanes made before this pick it up the next time they are used.
 */
function excludeModules(dir) {
  const r = gitSafe(dir, 'rev-parse', '--git-path', 'info/exclude')
  if (!r.ok) return
  const raw = r.out.trim()
  if (!raw) return
  const file = resolve(dir, raw)
  try {
    const cur = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (/^node_modules\/?$/m.test(cur)) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}node_modules\n`, 'utf8')
  } catch {
    /* an exclude we cannot write is not a reason to fail the lane */
  }
}

// ---------------------------------------------------------------- commands

/**
 * One folder, one spelling. A hold's `cwd` is whatever a chat's hook passed in and a lane's
 * dir is built here, so the two arrive with different separators, cases and trailing slashes.
 */
const samePath = (p) => {
  let t = resolve(String(p ?? ''))
  // Symlinks, not spelling, are what actually bite here: on macOS the temp root and
  // `/var` are links, so one side of the comparison arrives as `/var/...` and the other as
  // `/private/var/...` and two names for one folder read as two folders. A path that is
  // not on disk keeps the name it was given - that is still the best answer available.
  try {
    t = realpathSync(t)
  } catch {
    /* not on disk (a lane not built yet, a cwd that has since gone) */
  }
  return t.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}
const inside = (at, dir) => Boolean(dir) && (at === dir || at.startsWith(dir + '/'))
/**
 * A path as the file system matches it: case folded where case is ignored (macOS, Windows).
 * A chat's paths keep the case it typed (`paneforge-a`) while lane dirs are built from the
 * repo's on-disk name (`PaneForge-a`); compared raw, a write through the other spelling
 * matched no lane and the guard let it through (2026-10-04).
 */
const foldCase = (p) => (process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p)
/**
 * What follows `dir` at the start of `target` (`''` = the folder itself, else `<sep>...`), or
 * null when `target` is not inside it. A case-folded prefix of the same ORIGINAL length is
 * compared: lowercasing can change a string's length, so a folded copy is never sliced.
 */
function restUnder(target, dir) {
  if (target.length < dir.length || foldCase(target.slice(0, dir.length)) !== foldCase(dir)) return null
  const rest = target.slice(dir.length)
  return rest === '' || rest.startsWith(sep) ? rest : null
}

/**
 * The lanes some OTHER chat is physically standing in, whichever lane that chat was given.
 *
 * The whole point is the mismatch: a hold knows the folder its chat is in (`cwd`) and the
 * lane it owns, and when those disagree the chat's SHELL is what decides which files get
 * written. So the folder, not the ledger row, is what makes a lane unsafe to hand out.
 */
function squattedLanes(state, session) {
  const out = new Set()
  for (const [id, c] of Object.entries(state.lanes)) {
    if (!c.cwd || c.session === session) continue
    const at = samePath(c.cwd)
    for (const other of POOL) {
      // A chat standing in its own lane is exactly what is supposed to happen.
      if (other === id) continue
      // `main` is the repository itself, which is where nearly every chat STARTS: it opens
      // in the repo, is handed a letter lane, and is told in prose to work in the worktree.
      // Counting that as squatting would mark `main` unsafe in almost every session - the
      // cheapest lane, the one with no worktree to pay for - and it is already covered:
      // the write guard refuses an edit in a checkout this chat does not hold. Only
      // standing in ANOTHER LETTER LANE's folder is the anomaly this is for.
      if (other === 'main') continue
      if (inside(at, samePath(laneDir(other)))) out.add(other)
    }
  }
  return out
}

/**
 * Which lane's checkout this chat is STANDING in, when it is not the one it holds.
 *
 * `null` for the normal case - the chat is in its own lane, or nowhere near any of them.
 * A chat in a SUBDIRECTORY of a checkout counts as being in it, because that is where its
 * relative paths land.
 */
function squatOf(cwd, id) {
  if (!cwd) return null
  const at = samePath(cwd)
  if (inside(at, samePath(laneDir(id)))) return null
  // `main` deliberately excluded, for the reason squattedLanes gives: a chat standing in
  // the repository it was opened in is the normal case, not a warning.
  return POOL.find((other) => other !== 'main' && inside(at, samePath(laneDir(other)))) ?? null
}

function claim(session, cwd, prefer, tentative = false, visitor = false) {
  if (!session) throw new Error('claim needs --session')
  const state = reap(read())
  if (state.recoveryError) throw new Error(state.recoveryError)
  // Cheap, throttled, and the reason most conflicts never reach a human.
  retryConflicts(state)

  // The app can reopen a checkout after its former pane closed, before the gone-owner
  // sweep has removed the claim. Do not route a pinned task elsewhere merely because
  // that empty claim remains. An all-copy inventory must identify THIS native chat and
  // prove the former app owner absent; unknown inventory, external owners, sleeping
  // panes and every kind of unfinished work keep their protection.
  const empty = (id) => {
    const w = laneWork(id)
    return !w.damaged && !w.dirty && w.ahead === 0 && !state.ready[id] && !state.conflicts[id] && !preservedRecovery(state, id)
  }
  const requested = prefer && prefer !== 'main' && POOL.includes(prefer) && cwd && inside(samePath(cwd), samePath(laneDir(prefer)))
  // A recovery pane is dispatched to the exact lane its item is pinned to, but may be handed
  // a fallback at SessionStart while the old hold is unreaped (2026-10-07, taskdriver.ai).
  // Its own un-owned dispatched item must not stop it returning there. Another pane, or an
  // item someone already owns, gets nothing. The swap only moves the hold: no catch-up, no
  // reset, because `begin` checks HEAD === the pinned commit.
  // The lane may carry an older blocked item beside the dispatched one (2026-10-09,
  // paneforge-next lane e: the first preserved item shadowed it and the swap never ran), so
  // look for the item dispatched to this pane, not merely the first preserved one.
  const dispatchedItem = (id) => PANE ? Object.values(state.recovery?.items ?? {}).find((r) =>
    !r.ref && r.lane === id && r.status === 'dispatched' && !r.owner && r.pane === PANE) : undefined
  const dispatchedHere = (id) => {
    if (state.recoveryError) throw new Error(state.recoveryError)
    return Boolean(dispatchedItem(id))
  }
  // A blocked item whose pinned commit trunk already holds was only closed for a lane the
  // caller already HELD, so nothing could ever clear it and the lane stayed unclaimable (D).
  if (requested) closeShippedRecovery(state, session, prefer)
  if (requested) {
    const owner = state.lanes[prefer]
    if (owner?.pane && owner.session !== session && !owner.asleep && empty(prefer)) {
      const living = recoveryLiving()
      if (living?.has(session) && !living.has(owner.session)) {
        dropClaims(state, owner.session)
        delete state.lanes[prefer]
      }
    }
    // A previous prompt may already have allocated an empty fallback. Returning to the
    // checkout recorded at the original claim is safe only while BOTH copies are empty
    // and the requested one is unheld. A visit to another checkout never moves a hold.
    const held = Object.keys(state.lanes).find((id) => state.lanes[id].session === session)
    // A chat whose SessionStart claim gave it `main` while standing in the lane's own folder
    // can never claim that lane otherwise, and the only way off `main` (`release`) marks a
    // clean ahead main ready (2026-10-07, taskdriver-mobile). Allowed only when this caller
    // can take the lane's preserved item (dispatched to its pane, or adoptable), the lane is
    // free, and main has nothing uncommitted beyond machine-written paths and no merge under
    // way. The swap only moves the hold: no ready mark, no catch-up, no reset; main's commits
    // stay on its branch for the next main holder.
    if (held === 'main' && !state.lanes[prefer] && !state.conflicts[prefer] &&
        !laneWork(prefer).damaged && !squattedLanes(state, session).has(prefer)) {
      const mine = dispatchedItem(prefer)
      const item = mine ?? preservedRecovery(state, prefer)
      const status = gitSafe(MAIN, ...WORK_STATUS)
      const dispatched = Boolean(mine) && gitSafe(laneDir(prefer), 'rev-parse', 'HEAD').out.trim() === mine.commit
      if (item && (dispatched || !adoptRefusal(state, session, item, { holding: false })) &&
          status.ok && (!status.out || machineWrittenPaths(MAIN)) && !openOperation(MAIN) && !state.conflicts.main) {
        delete state.lanes.main
      }
    }
    if (held && held !== 'main' && held !== prefer && !state.lanes[prefer] && state.lanes[held].cwd &&
        inside(samePath(state.lanes[held].cwd), samePath(laneDir(prefer))) && empty(held) && (empty(prefer) || dispatchedHere(prefer))) {
      delete state.lanes[held]
    }
  }

  // ONE PANE IS ONE CHAT, so a pane may hold one lane and never two.
  //
  // A chat's id changes when it is cleared or resumed (`/clear` starts a new session id in
  // the same pane), and the hold the OLD id took is still in the ledger: nothing tells the
  // ledger that chat ended, and the stale hold is not idle enough for any sweep to take.
  // The board then draws the same pane twice - once as the copy it is really in, once as
  // whatever lane the dead id holds - and the chat is told, in its own hook, that another
  // chat is working beside it. Measured here 2026-09-04: this pane held `main` as
  // d30e8ebe and `b` as fb4c882b, a session id that no longer resolves to a conversation.
  //
  // The pane id is the identity that survives the clear (`PF_PANE`, set by the app on
  // every pane it starts), so a claim drops every other hold wearing the same pane. A
  // hold with no pane id - claimed by hand, or from a terminal outside the app - is left
  // alone: it belongs to nobody this can identify.
  //
  // Dropping alone stranded work (2026-09-28, taskdriver.ai): a hold with a finished commit
  // or an uncommitted edit was never given up, so it stayed on the dead session id and the
  // pane's NEW chat was handed a different lane - every write into its own folder refused,
  // `resolve` saying "not conflicted", no sanctioned way back. So the earlier chat's hold is
  // CARRIED to this one, work or no work: when this chat holds nothing, or holds only an
  // empty lane while the earlier hold has work (the empty one is then let go).
  //
  // Carried only from a session that has ENDED (`ended`, stamped by the SessionEnd hook
  // before the release it spawns; that release can lose the race with this claim, which is
  // how the hold survived its session). A turn being over is not enough: `PF_PANE` is
  // inherited, so a `claude -p` or `codex exec` a chat runs inside the repo claims under the
  // same pane, and its parent - parked between turns, still alive - is not the pane's
  // previous chat (a pre-ship review reproduced a child taking a parked parent's lane).
  //
  // What is not carried is dropped only when it has ALSO been given up - parked by its own
  // Stop hook, or still tentative - and its lane holds no uncommitted work and no commits
  // of its own. Nothing here can lose work.
  if (PANE) {
    const hasWork = (id) => {
      const w = laneWork(id)
      return w.dirty || w.ahead > 0 || Boolean(state.ready[id]) || Boolean(state.conflicts[id])
    }
    const earlier = Object.entries(state.lanes)
      // A folder missing most of its files (damageOf) is not work to carry on: the pane's
      // new chat takes another lane and the earlier hold stays where it is for a person.
      .filter(([id, c]) => c.pane === PANE && c.session !== session && c.ended && !laneWork(id).damaged)
      .map(([id, c]) => ({ id, c, work: hasWork(id) }))
      // Work first, then the most recently heard from.
      .sort((x, y) => y.work - x.work || (y.c.seen ?? 0) - (x.c.seen ?? 0))
    const held = Object.keys(state.lanes).find((id) => state.lanes[id].session === session)
    const carry = earlier[0]
    if (carry && (!held || (carry.work && !hasWork(held)))) {
      if (held) delete state.lanes[held]
      // The same-session branch below does the rest of what a live claim does: parked,
      // asleep, ended and (for a real claim) tentative cleared, pane recorded - and the
      // earlier chat's unfinished recovery items follow it (carryRecovery).
      carry.c.carriedFrom = [...new Set([...(carry.c.carriedFrom ?? []), carry.c.session])]
      carry.c.session = session
      if (cwd) carry.c.cwd = cwd
    }
    for (const [id, c] of Object.entries(state.lanes)) {
      if (c.pane !== PANE || c.session === session) continue
      // A sleeping hold is not given up just because it also reads parked/tentative -
      // it is kept for the press that wakes it, not for the tidy ledger.
      if (c.asleep) continue
      if (!c.parked && !c.tentative) continue
      const w = laneWork(id)
      if (w.dirty || w.ahead > 0) continue
      delete state.lanes[id]
    }
  }

  for (const [id, c] of Object.entries(state.lanes)) {
    if (c.session === session) {
      c.seen = now()
      // The chat is back: whatever `park` said about its turn being over is no longer
      // true, and a claim that is not a visit clears the visitor word too - the hook
      // decides that from where the chat LIVES, so a home chat is never marked down for
      // one prompt sent from somewhere else.
      delete c.parked
      delete c.ended
      // A chat that is TALKING is awake, whatever the app said. `wake` is run by pane id
      // from the app's own resume path, and a pane that came back some other way (a
      // relaunch that restored the desk, a resume from outside the app) never gets it -
      // measured on toolstash 2026-09-07: `main` asleep for 55h, its chat parking every
      // turn, the lane immune to every sweep for the 7-day ASLEEP_MAX_MS and the next
      // toolstash chat sent to copy 4.
      delete c.asleep
      if (!visitor) delete c.visitor
      if (c.carriedFrom) carryRecovery(state, session, id, c)
      // A lane can stop being a checkout while its own chat is sitting in it - a pruned
      // worktree, an interrupted install, a folder deleted from underneath, a node_modules
      // link removed by a cleanup. The chat is then told, every prompt, to work in a folder
      // that no longer functions. Everything needed to put it back is in ensureWorktree and
      // all of it is idempotent, so a returning chat gets the same repair a new one does -
      // this branch used to hand the broken path straight back unchanged.
      if (id !== 'main') {
        try {
          if (!preservedCheckout(state, id)) ensureWorktree(id)
        } catch (error) {
          if (preservedRecovery(state, id)) throw error
          /* reported by `doctor`; a claim that cannot rebuild still returns the lane */
        }
      }
      // A hold records the folder its chat came from once, on the claim that created it -
      // and a lane claimed by hand (`lane.mjs claim --session <id>`, which is what a chat
      // refused by the guard is told to run) records nothing at all. That lane then reads
      // "a chat has it" on the strip forever, with no way to find out whose chat: the one
      // hold nobody can identify is the one held from outside this window, which is the
      // only kind the strip draws. Later claims carry the folder, so take the first one
      // that does rather than leaving the hold anonymous for its whole life.
      if (cwd && !c.cwd) c.cwd = cwd
      // Claimed before this chat was cleared, or before the pane id was recorded at all.
      if (PANE) c.pane = PANE
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
      registerSession(session)
      return {
        lane: id,
        dir: laneDir(id),
        branch: laneBranch(id),
        // The branch the lane MERGES INTO, which is not its own: a caller that said
        // "merges into ${branch}" told a chat in lane-a that its work merged into lane-a.
        mainBranch: MB,
        profile: laneProfile(id),
        repo: MAIN,
        release: RELEASE,
        own: OWN,
        fresh: false,
        tentative: Boolean(c.tentative),
        standingIn: squatOf(cwd ?? c.cwd, id)
      }
    }
  }

  // `prefer` is how a chat that was already mid-edit in a checkout when lanes were
  // switched on keeps that checkout, uncommitted work and all, instead of being sent
  // to an empty lane and losing sight of it.
  // A lane with finished work waiting on a release is free to hand out, but it is the LAST
  // one to hand out: a new chat that lands there starts on top of somebody else's shipped-
  // but-unreleased commits, and its pane reads "done" before it has done anything.
  // A preference for a lane this repo does not have is not a lane. The hook derives
  // `prefer` from the folder suffix a chat is sitting in, so a chat in a leftover
  // `<repo>-w2` asks for a lane called `w2` - and taking that at its word meant handing out
  // a lane whose branch (`lane-w2`) is not the branch that folder is on (`pf/w2`), i.e. two
  // different ideas of one checkout, which is the failure lanes exist to prevent. Ignoring
  // it puts that chat in a real lane instead.
  if (prefer && !POOL.includes(prefer)) prefer = null
  // A visitor prefers `main` only because its shell is standing there. Standing is not
  // work: unless the folder holds uncommitted edits to protect, the visitor is sent to a
  // letter lane and `main` stays what it is - the checkout of the repo's own chats. With
  // dirty work in the folder the preference is honoured exactly as before, because losing
  // sight of half an edit is worse than any squat.
  if (visitor && prefer === 'main' && !laneWork('main').dirty) prefer = null
  // Same idea for a visitor with no preference at all: hand out letters first, `main`
  // only when it is the last checkout left.
  const order = visitor ? [...POOL.filter((id) => id !== 'main'), ...POOL.filter((id) => id === 'main')] : POOL
  // A conflicted lane is not spare, whoever is or is not holding it: the last-resort
  // `spare[0]` below skips the chooser entirely, so filtering here is what makes "never
  // hand out a conflict" true on every path rather than on most of them.
  // An absent owner does not make their unfinished edits available to a new task.
  // Keep explicit recovery (`wanted`) and same-session resumes above, but exclude
  // dirty orphans from every automatic choice, including last-resort fallbacks.
  //
  // A folder missing most of its files (`damageOf`) is the same, only stricter: it is also
  // never handed to a chat that ASKS for it. `wanted` below goes around this chooser, and the
  // hook derives `prefer` from the folder a chat is standing in, so a new chat standing in a
  // damaged copy was handed it. Skipping it sends that chat to a working lane. Damaged
  // implies dirty (the deletions are the dirt), so every other path that refuses dirty lanes
  // (`idleEmpty`, the `main` takeover) already refuses it too; the other way in, carrying an
  // ended chat's hold to the pane's next chat, is closed above.
  const damaged = new Set()
  // A folder at a lane's path that is not a checkout of this repo and holds something
  // (`strayIn`) is somebody's, and `ensureWorktree` refuses it rather than delete it. The
  // chooser below prefers folders that already exist, so it picked exactly that one ahead of
  // lanes it could build, and the refusal failed the WHOLE claim (2026-10-09, taskdriver.ai on
  // the PC: `taskdriver.ai-h` held only `.local-schedule-shots/schedule.png`, and every new
  // chat read "could not assign a checkout" with lanes c-g unmade). Not handed out
  // automatically; asked for by name it still refuses with the sentence naming the folder.
  const blocked = new Set()
  const unfinished = new Set(order.filter((id) => {
    if (state.lanes[id]) return false
    let work = laneWork(id)
    // Half made by a killed checkout: finished here when the proof holds (finishCopy), and
    // then an ordinary empty lane; otherwise damaged like any other.
    if (work.halfMade && finishCopy(id, state).finished) work = laneWork(id)
    if (work.damaged) {
      damaged.add(id)
      return false
    }
    if (work.broken && strayIn(laneDir(id)).length) {
      blocked.add(id)
      return false
    }
    // `main` is the trunk itself: its `ahead` counts unreleased commits that are already
    // on the release branch, not lane work waiting to be merged, so only a letter lane
    // with unready commits is preserved work. (A checkout missing the release TAG counts
    // the whole history there and would never hand out `main`.)
    return work.dirty || (id !== 'main' && work.ahead > 0 && !state.ready[id])
  }))
  // A lane kept for a recovery item whose checkout is not whole (folder missing, not a
  // worktree, index emptied) is the recovery's to diagnose: `preservedCheckout` refuses to
  // hand it out, so the pool must not pick it - picked, the throw failed the WHOLE claim and
  // a new chat got no checkout at all (2026-10-04: lane c, item `blocked`, folder gone; the
  // pane's first prompt read "preserved recovery checkout needs backup ..."). Asked for by
  // name, it still refuses with that sentence.
  const kept = new Set(order.filter((id) => {
    if (state.lanes[id] || !preservedRecovery(state, id)) return false
    try {
      preservedCheckout(state, id)
      return false
    } catch {
      return true
    }
  }))
  const spare = order.filter(
    (id) => !state.lanes[id] && !state.conflicts[id] && !unfinished.has(id) && !damaged.has(id) && !blocked.has(id) && !kept.has(id)
  )
  // A lane whose FOLDER another chat is standing in is the last one to hand out.
  //
  // A hold records the chat's own cwd, and that is not always the lane it was given:
  // nothing moves a running shell. A chat sitting in `<repo>-a` that asks for lane a and is
  // refused (a was taken) is sent to lane b - and stays standing in `<repo>-a`. Hand lane a
  // to the next chat and two chats are pointed at one worktree, which is precisely the
  // failure lanes exist to prevent, with each of them told in prose that the folder is
  // theirs. Measured on `assistant` 2026-08-16: chat 0ea5827a held lane b from
  // `assistant-a`, and the next chat was handed lane a and told to work in `assistant-a`.
  //
  // A chat standing in its OWN lane is not a squatter, and this only ever REORDERS the
  // pool: a squatted lane is still handed out when it is the last one left, because a chat
  // with no checkout at all is worse than a shared one - and the hook says so out loud.
  // Squat beats readiness in this order, and the order is the whole point: landing on
  // somebody else's shipped-but-unreleased commits reads oddly for one prompt, landing in
  // the folder their shell is in is two chats writing one worktree. Anything unsquatted is
  // taken before anything squatted, whatever else is true of it.
  const squatted = squattedLanes(state, session)
  // A CONFLICTED lane is never handed out, at any tier. `ready` is a soft cost - the new
  // chat lands on somebody's shipped-but-unreleased commits and its pane reads odd for one
  // prompt - but a conflict is a half-finished merge somebody is expected to come back to,
  // and CLAUDE.md says it is the one state no other chat may touch. Tier 2 tested only for
  // a squat, so the "anything unsquatted beats anything squatted" rule quietly promoted a
  // conflicted lane over a clean squatted one. It is reachable with no holder at all:
  // `releaseClaim` calls `noteConflict` and then deletes the lane, and `reap` only clears a
  // conflict for a branch that is no longer ahead of master - which a real conflict is.
  const pick = (ids) => {
    // Reuse a checkout before paying to create one. Keep the safety tiers below:
    // existing does not outrank another chat's cwd or an unready clean lane.
    // Visitors still leave main for its home chat, even when no letter exists yet.
    const existing = ids.filter((id) => (!visitor || id !== 'main') && existsSync(laneDir(id)))
    const ordered = [...existing, ...ids.filter((id) => !existing.includes(id))]
    return ordered.find((id) => !squatted.has(id) && !state.ready[id] && !state.conflicts[id]) ??
      ordered.find((id) => !squatted.has(id) && !state.conflicts[id]) ??
      ordered.find((id) => !state.ready[id] && !state.conflicts[id])
  }
  // A preference is a chat protecting work in the folder it is standing in - but a folder
  // ANOTHER chat is also standing in protects nothing, it just moves the collision one lane
  // over. So a squatted preference is honoured only when there is no unsquatted lane left,
  // which is the same rule the pool itself follows.
  // Same rule as `pick`, and it has to be repeated here because `wanted` is the one path
  // that goes AROUND the chooser: a chat standing in `<repo>-a` asks for lane a by name,
  // and honouring that while a is mid-conflict hands it exactly what the tiers refuse.
  const wanted = prefer && !state.lanes[prefer] && !state.conflicts[prefer] && !damaged.has(prefer) ? prefer : null
  let free = (wanted && !squatted.has(wanted) ? wanted : null) ?? pick(spare) ?? wanted ?? spare[0]
  // A worktree is a cost - a second checkout, a branch, and a merge at the end - and a
  // chat alone in a repository should not pay it. `main` is the repository itself, so the
  // lane a solo chat belongs in is the one lane whose holder sitting on it costs somebody
  // else something; every other lane is interchangeable, which is why this is not a sweep.
  // A `main` held by a chat that has said nothing for an hour and left nothing behind is
  // handed to the chat that is about to be sent to a letter instead. Nothing can be lost:
  // one uncommitted character and it is left alone, and master's own commits are not the
  // holder's work - they are already everyone's, exactly as `busyLanes` reads them.
  // (2026-08-07: a chat in another project ran one command inside taskdriver.ai, held its
  // `main` for the six hours after its last word, and every taskdriver chat after it opened
  // in `lane-a` for no reason at all. The 12h stale sweep is for chats that DIED, and the
  // idle sweep below only runs when the pool is full - which it never is at two chats.)
  //
  // The guard is "did it GET the lane it asked for", not "did it ask": a preference is a
  // chat protecting work it already has in a checkout, and a preference that was refused
  // protects nothing - the folder it named belongs to somebody else and this chat is being
  // sent somewhere new either way. Reading the bare `prefer` meant a chat sitting in
  // `<repo>-a` while lane a was taken skipped the sweep on the strength of a wish it did
  // not get, and opened a THIRD checkout beside a `main` nobody had touched for hours.
  // Measured on taskdriver.ai 2026-08-09: main held by a chat last seen 2h53m earlier with
  // nothing in it, lane b claimed 5 minutes ago by a chat sitting in `taskdriver.ai-a` -
  // which is Robert's "why there's 2 lanes, main and lane-b".
  const gotPrefer = Boolean(prefer) && free === prefer
  if (free && free !== 'main' && !gotPrefer && POOL.includes('main') && !visitor) {
    const held = state.lanes.main
    if (
      held &&
      held.session !== session &&
      !state.ready.main &&
      !state.conflicts.main &&
      holdGivenUp(held) &&
      !laneWork('main').dirty
    ) {
      delete state.lanes.main
      closeLaneApps(MAIN)
      free = 'main'
    }
  }
  // A lane that is being held and not used: given up by the evidence (`holdGivenUp`, or
  // only ever reserved by a mention), nothing in it, not waiting on anything. The oldest
  // one first, so a chat that has at least been seen recently keeps its checkout.
  const idleEmpty = (mentionsToo) =>
    Object.entries(state.lanes)
      .filter(([id, c]) => {
        if (!holdGivenUp(c) && !(mentionsToo && c.tentative)) return false
        if (state.ready[id] || state.conflicts[id]) return false
        if (squatted.has(id)) return false
        const w = laneWork(id)
        return !w.dirty && w.ahead === 0
      })
      .sort((a, b) => (a[1].seen ?? 0) - (b[1].seen ?? 0))[0]?.[0]
  // Nothing free: before refusing, take one of those.
  if (!free) free = idleEmpty(true)
  // Something free, but it is a copy that does not exist yet. Until 2026-09-07 this went
  // straight to `ensureWorktree` and the idle sweep ran only when the pool was full, so a
  // repo whose chats had all gone home - every lane at the same commit as main, nothing
  // in any of them - still handed the next chat copy 4, then copy 5, each a fresh worktree
  // beside three empty ones nobody was in. Robert, on toolstash: "session 1 is copy 4,
  // wouldn't the other copies all be merged already?" They were. Reusing an abandoned
  // empty copy costs nothing (its chat had left by the same evidence that would have let
  // a full pool take it) and keeps the numbers on the board meaning something. A copy
  // that already exists on disk and is unheld is still taken first: nobody at all beats
  // somebody who has probably left.
  // Not for a chat that asked for the folder it is standing in (`gotPrefer`), and not for
  // a mention: a tentative reservation evicts nobody, and a hold that is only tentative is
  // not "abandoned" - it is a chat that was told where to work twenty minutes ago.
  else if (free !== 'main' && !gotPrefer && !tentative && !existsSync(laneDir(free))) free = idleEmpty(false) ?? free
  if (free && state.lanes[free]) {
    delete state.lanes[free]
    closeLaneApps(laneDir(free))
  }
  // The other desk. `main` is the one lane that is not this machine's alone - it IS the
  // shared branch - so a chat about to be handed it asks whether the other device is
  // already sitting there. A letter lane never asks: `lane-a` here and `lane-a` there are
  // two local-only branches in two folders on two disks, and coordinating them would buy
  // a network round trip per prompt and prevent nothing.
  //
  // Being sent to a letter costs this chat a worktree and a merge at the end, which is
  // exactly what a second chat on THIS machine already pays. Being handed a trunk another
  // desk is committing to costs everybody a tangled push.
  let peerTrunk = null
  if (free === 'main' && !state.ready.main && !state.conflicts.main) {
    peerTrunk = peerHolding('main')
    if (peerTrunk) {
      // Same chooser as the pool above, so there is one definition of "a lane worth
      // handing out" rather than a second one here that nothing exercises.
      const spare = pick(
        order.filter((id) => id !== 'main' && !state.lanes[id] && !unfinished.has(id) && !damaged.has(id) && !blocked.has(id) && !kept.has(id))
      )
      // No letter left is not a reason to refuse a chat a checkout: the local ledger is
      // still the authority on this machine, and a shared trunk that is reported is a far
      // smaller problem than a chat that cannot start. The word travels either way -
      // `claim` returns it, and `doctor` prints it.
      if (spare) free = spare
    }
  }

  if (!free) {
    // Every lane is held by a live session. Better to say so than to hand out a
    // checkout two chats are already sharing.
    const held = Object.entries(state.lanes).map(([id, c]) => `${id} (${c.cwd ?? '?'})`)
    // Conflicted lanes are named separately, because "busy" reads as "wait" while a
    // conflict reads as "somebody has to run `lane.mjs resolve`" - and a chat refused a
    // checkout with no idea why goes and works somewhere it should not.
    const stuck = Object.keys(state.conflicts).filter((id) => POOL.includes(id))
    const why = [
      held.join(', '),
      stuck.length && `conflicted: ${stuck.join(', ')}`,
      unfinished.size && `uncommitted: ${[...unfinished].join(', ')} (preserved; explicitly claim the original checkout to recover)`,
      kept.size && `kept for recovery: ${[...kept].join(', ')} (its folder needs checking before anyone works in it)`,
      damaged.size &&
        `missing most of its files: ${[...damaged].join(', ')} (a copy that never finished being made; not handed to any chat - check it and move it out of the way)`,
      ...[...blocked].map(
        (id) => `lane ${id}'s folder is not a git worktree and is not empty (${strayIn(laneDir(id)).slice(0, 5).join(', ')}): check what is in ${laneDir(id)}, move it out, and it rebuilds itself`
      )
    ].filter(Boolean).join('; ')
    throw new Error(`all lanes busy: ${why}`)
  }

  const preserved = preservedCheckout(state, free)
  const dir = preserved ?? ensureWorktree(free)
  enableRerere()
  // A lane is handed over clean and current, never mid-merge and never stale: whatever the
  // last chat left behind is settled here, before this one writes a line.
  const unreadyAhead = !state.ready[free] && laneWork(free).ahead > 0
  const healed = preserved || unreadyAhead ? null : healLane(free)
  if (healed) {
    if (/conflicts with /.test(healed)) noteConflict(state.conflicts, free, healed)
    else delete state.conflicts[free]
  }
  state.lanes[free] = {
    session,
    cwd: cwd ?? null,
    // Which desk. Redundant inside this file - it is one machine's ledger - and not
    // redundant once the app draws several ledgers and a peer's published claims in one
    // list, where every row needs to be able to say where it is.
    device: DEVICE,
    // Which pane, when the app started this chat: the one identity that survives a clear.
    ...(PANE ? { pane: PANE } : {}),
    claimed: now(),
    seen: now(),
    ...(tentative ? { tentative: true } : {}),
    ...(visitor ? { visitor: true } : {})
  }
  // Taking the trunk is the only thing worth telling the other desk about, and it is told
  // at the moment it becomes true rather than on a timer.
  if (free === 'main') publishClaim(state, 'main', session)
  write(state)
  registerSession(session)
  return {
    lane: free,
    dir,
    branch: laneBranch(free),
    // Named, not just flagged: an agent that is told only "you were moved" reports a bug.
    peerTrunk: peerTrunk ? { device: peerTrunk.device, words: peerWords(peerTrunk, { now: now() }) } : null,
    sharedTrunk: Boolean(peerTrunk) && free === 'main',
    // The branch the lane MERGES INTO, which is not its own: a caller that said
    // "merges into ${branch}" told a chat in lane-a that its work merged into lane-a.
    mainBranch: MB,
    profile: laneProfile(free),
    repo: MAIN,
    release: RELEASE,
    own: OWN,
    fresh: true,
    healed,
    tentative,
    // The lane this chat's SHELL is standing in, when that is not the lane it was given.
    // Nothing here can move a running shell, so the only defence is saying it out loud.
    standingIn: squatOf(cwd, free)
  }
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
  const inside = (dir) => restUnder(target, dir) !== null

  const owned = POOL.map((id) => ({ id, dir: laneDir(id) })).filter((l) => inside(l.dir))
  if (!owned.length) return null
  // Longest path wins: <repo>-a also starts with <repo> on the string level only, but
  // resolve()+sep already prevents that. Sort anyway for nested oddities.
  owned.sort((x, y) => y.dir.length - x.dir.length)
  const lane = owned[0]

  const state = reap(read())
  const holder = state.lanes[lane.id]
  const conflict = state.conflicts[lane.id]
  if (holder?.session === session) {
    holder.seen = now()
    if (conflict?.resolver === session) conflict.resolverAt = holder.seen
    // Writing in the lane is the moment a reservation becomes a real claim: this chat is
    // editing PaneForge, not talking about it, so the lane is now its lane - and a chat
    // that is writing has plainly not finished its turn, whatever `park` recorded.
    delete holder.tentative
    delete holder.parked
    delete holder.ended
    write(state)
    return null
  }
  // A chat that took over a stuck conflict has to be able to write in that lane, even
  // though another session still nominally holds it. Without this the takeover is
  // advice rather than a mechanism.
  if (conflict?.resolver === session) {
    // An adopted merge can take longer than ADOPT_MS. Authorized writes prove its
    // resolver is still working; retry must not abort that resolver's draft.
    conflict.resolverAt = now()
    write(state)
    return null
  }
  if (!holder) {
    // Unclaimed checkout: claim THIS one for the session rather than refusing. An
    // agent that opened the repo directly, or was already working here before lanes
    // existed, should simply carry on.
    try {
      const got = claim(session, dirname(target), lane.id)
      if (got.lane === lane.id) return null
      return `${basename(MAIN)}: this session's lane is ${got.dir}. Make the change there, not in ${lane.dir}.`
    } catch (e) {
      // A guard that cannot decide refuses: `return null` here waved a write into a copy
      // nobody held whenever the claim threw, and a chat wrote into the main copy that way
      // on 2026-09-25 (`test:laneoverlap`).
      return `${basename(MAIN)}: ${lane.dir} could not be given to this chat, so the write is refused: ${e?.message ?? e}`
    }
  }
  const mine = Object.entries(state.lanes).find(([, c]) => c.session === session)
  const where = mine ? laneDir(mine[0]) : null
  return (
    `${basename(MAIN)}: ${lane.dir} belongs to another chat right now.` +
    (where
      ? ` Yours is ${where} - make the same change there.`
      : ` Run \`node ${join(own, 'scripts', 'lane.mjs')} claim --repo ${MAIN} --session <id>\` to get your own checkout.`)
  )
}

/**
 * Is somebody else already changing this file?
 *
 * A conflict is two lanes editing the same lines of one file, and the moment it is cheap
 * to know is the FIRST edit, not the merge: lanes c and d both put a hundred lines into
 * `laneFor` in src/main/index.ts one afternoon (2026-09-02), neither told the other, and
 * lane c sat conflicted while master carried d. Nothing here refuses anything - it is one
 * paragraph of additionalContext on the edit, naming the lane, the folder and the line
 * ranges it changed, so the chat can move its change, message the other chat, or carry
 * on knowing it will resolve a merge.
 *
 * The reading is `git diff <merge-base with the release branch> -- <file>` in every other
 * lane: a commit against the WORKING TREE, so committed-but-unmerged and uncommitted edits are one read, and a
 * lane whose work master already carries reads as empty. Said once per session, file and
 * ten minutes; a file nobody else touches is re-read at most once a minute.
 */
const OVERLAP_SAID_MS = 10 * 60 * 1000
const OVERLAP_CLEAR_MS = 60 * 1000

/** Turn a `-U0` diff's `@@` headers into `[start, end]` line ranges. Shared by the local
 * working-tree read and the remote commit-to-commit read below. */
function parseHunkRanges(diffOut) {
  const out = []
  for (const m of diffOut.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1])
    const n = m[2] === undefined ? 1 : Number(m[2])
    out.push([start, n ? start + n - 1 : start])
  }
  return out
}

function hunksOf(dir, rel) {
  // Merge-base to WORKING TREE. `git diff <branch>...` looks right and is not: with one
  // side omitted it diffs to HEAD, so an uncommitted edit - the one a live chat is making
  // right now - never showed. A commit on the left and no commit on the right is the tree.
  const base = gitSafe(dir, 'merge-base', MB, 'HEAD')
  if (!base.ok || !base.out) return []
  const r = gitSafe(dir, 'diff', '-U0', base.out, '--', rel)
  if (!r.ok || !r.out) return []
  return parseHunkRanges(r.out)
}

/** Merge-base to a COMMIT, not a working tree - `ref` is `origin/lane-<id>`, a branch
 * nobody here has a checkout of. */
function remoteHunksOf(ref, rel) {
  const base = gitSafe(MAIN, 'merge-base', MB, ref)
  if (!base.ok || !base.out) return []
  const r = gitSafe(MAIN, 'diff', '-U0', base.out, ref, '--', rel)
  if (!r.ok || !r.out) return []
  return parseHunkRanges(r.out)
}

/**
 * The same overlap read as `hunksOf`, but for a lane the OTHER machine pushed.
 *
 * Autosync commits and pushes whatever a lane worktree's current branch is - see
 * `pruneRemoteLanes` above - so a lane branch on origin can be this desk's own copy, or a
 * same-named lane on the other machine, and the two look identical by name alone. On
 * 2026-09-23 three moves reached the PC in one session and both desks had lanes open on
 * this repo at once; the guard only ever read this desk's own lane directories, so a
 * lane the PC was editing never showed up here at all. Told apart by commit, not name: a
 * local lane dir for the same id whose HEAD matches the remote sha is this desk's own
 * lane, already covered by `hunksOf`, and is skipped so the same work is never reported
 * twice under two different labels.
 *
 * The fetch is throttled the same OVERLAP_SAID_MS as the "said" half of the cache below,
 * recorded in the cache file itself (`__fetchedAt`) so a quiet file nobody else edits
 * costs one `ls-remote`-sized fetch per ten minutes, not one per guard call.
 */
function remoteLaneHunks(rel, cache, t) {
  if (!hasOrigin()) return []
  if (!cache.__fetchedAt || t - cache.__fetchedAt >= OVERLAP_SAID_MS) {
    // Silent on failure: no network is "read whatever refs we already have," never a
    // reason to tell the chat we could not check.
    gitSafe(MAIN, 'fetch', '--quiet', 'origin', '+refs/heads/lane-*:refs/remotes/origin/lane-*')
    cache.__fetchedAt = t
  }
  const listed = gitSafe(MAIN, 'for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/remotes/origin/lane-*')
  if (!listed.ok || !listed.out) return []
  const out = []
  for (const line of listed.out.split('\n')) {
    const [ref, sha] = line.trim().split(/\s+/)
    if (!ref || !sha) continue
    const id = ref.slice('origin/lane-'.length)
    if (!id) continue
    const dir = laneDir(id)
    if (existsSync(dir)) {
      const head = gitSafe(dir, 'rev-parse', 'HEAD')
      if (head.ok && head.out.trim() === sha) continue // this desk's own lane - already read above
    }
    const hunks = remoteHunksOf(ref, rel)
    if (hunks.length) out.push({ id, ref, hunks })
  }
  return out
}

function overlap(session, path) {
  if (!session || !path) return null
  const target = resolve(path)
  const inside = (dir) => restUnder(target, dir) !== null
  const mine = POOL.map((id) => ({ id, dir: laneDir(id) }))
    .filter((l) => inside(l.dir))
    .sort((x, y) => y.dir.length - x.dir.length)[0]
  if (!mine) return null
  // Same length either spelling, so the part below the lane folder is cut, not `relative`d
  // (which compares case and would answer `../../paneforge-a/...`).
  const rel = restUnder(target, mine.dir).slice(1)
  if (!rel || rel.startsWith('..')) return null

  const cachePath = join(dirname(STATE), 'paneforge-overlap.json')
  let cache = {}
  try {
    cache = JSON.parse(readFileSync(cachePath, 'utf8'))
  } catch {
    cache = {}
  }
  const t = now()
  const key = `${session}\n${rel}`
  const was = cache[key]
  if (was && t - was.at < (was.hit ? OVERLAP_SAID_MS : OVERLAP_CLEAR_MS)) return null

  const state = read()
  const found = []
  for (const id of POOL) {
    if (id === mine.id) continue
    const dir = laneDir(id)
    if (!existsSync(dir)) continue
    const hunks = hunksOf(dir, rel)
    if (!hunks.length) continue
    const holder = state.lanes[id]
    found.push({ id, dir, hunks, held: Boolean(holder && holder.session !== session) })
  }
  for (const r of remoteLaneHunks(rel, cache, t)) found.push({ id: r.id, ref: r.ref, hunks: r.hunks, remote: true })
  for (const k of Object.keys(cache)) {
    if (k === '__fetchedAt') continue // a timestamp, not a `{ at, hit }` entry - the prune below does not apply
    if (t - (cache[k]?.at ?? 0) > OVERLAP_SAID_MS) delete cache[k]
  }
  cache[key] = { at: t, hit: found.length > 0 }
  try {
    writeFileSync(cachePath, JSON.stringify(cache))
  } catch {
    /* a cache that cannot be written only costs a re-read */
  }
  if (!found.length) return null

  const ranges = (hs) => {
    const shown = hs.slice(0, 6).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`))
    return shown.join(', ') + (hs.length > 6 ? ` and ${hs.length - 6} more` : '')
  }
  const rows = found.map((f) =>
    f.remote
      ? `lane ${f.id} on the other machine (${f.ref}, not yet merged) at lines ${ranges(f.hunks)}`
      : `${f.id === 'main' ? 'the main checkout' : `lane ${f.id}`} (${f.dir}, ${
          f.held ? 'another chat is in it' : 'nobody in it, work not yet merged'
        }) at lines ${ranges(f.hunks)}`
  )
  return (
    `${basename(MAIN)}: ${rel} is also changed, not yet on ${MB}, in ${rows.join('; ')}. ` +
    'An edit in the same region conflicts when both lanes merge. Different region: carry on. ' +
    'Same function: message that chat first (SendMessage) so one of you owns it, or plan to resolve the merge yourself.'
  )
}

// ---------------------------------------------------------------- what a lane holds

/**
 * Work sitting on the release branch that has not gone anywhere yet.
 *
 * What "gone anywhere" means is the repo's own answer. Where finishing cuts a version it
 * is the last tag, so anything after `v<package.json version>` still has to go out. Where
 * finishing only merges and pushes, it is `origin/<branch>`: a commit nobody else can see
 * yet is exactly the thing a release would hand over. A repo that neither tags nor pushes
 * has nothing to count.
 */
function unreleasedOnMaster() {
  try {
    if (RELEASE === 'none') return 0
    if (RELEASE === 'merge') {
      const r = gitSafe(MAIN, 'rev-list', '--count', `origin/${MB}..HEAD`)
      return r.ok ? Number(r.out) : 0
    }
    return commitsSinceVersion(JSON.parse(readFileSync(join(MAIN, 'package.json'), 'utf8')).version)
  } catch {
    return 0
  }
}

/**
 * Commits since the tag for `version`, and everything when there is no such tag.
 *
 * PaneForge has always had a tag for whatever is in its package.json, so `v<version>..HEAD`
 * was safe. It is not safe anywhere else: a repository that has just turned releases on has
 * a version in package.json and no tag matching it anywhere, and git answers that with a
 * fatal "ambiguous argument", which surfaced as `No release yet: Command failed` - a repo
 * that could never cut its first release and said nothing about why.
 */
function commitsSinceVersion(version) {
  const tag = `v${version}`
  const known = gitSafe(MAIN, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}`).ok
  const r = gitSafe(MAIN, 'rev-list', '--count', known ? `${tag}..HEAD` : 'HEAD')
  return r.ok ? Number(r.out) : 0
}

/**
 * Commits in a lane that master does not already have the CHANGE of.
 *
 * `rev-list --count` counts commit ids, and a lane whose history was rewritten (a rebase
 * anywhere near it) is full of new ids for changes master shipped long ago - a lane that
 * reads as 5 commits of work forever, blocking releases and merging nothing. `git cherry`
 * compares patches, so a duplicate counts as what it is: already released.
 */
/**
 * Did this commit really reach origin's copy of the branch?
 *
 * `true`, `false`, and `null` are three different answers and the third one is the point:
 * a repo with no origin, an origin that cannot be reached, or a commit git has never heard
 * of is "nobody could check", which may not be reported as a merge that did not happen -
 * and may not block a chat either. Only an ANSWERED `false` is a lane that did not go out.
 */
/**
 * Push, and when the push says it failed, ask origin before believing it.
 *
 * A push killed at its deadline, or one whose connection dropped after the upload, can
 * leave origin holding exactly what was sent (videos, 2026-10-09: "refused", then "Everything
 * up-to-date"). `ref` is what the push carries (`refs/heads/<trunk>` or `refs/tags/vX`):
 * origin having this machine's value for it is the push having happened.
 */
function pushChecked(ref, ...args) {
  const r = gitSafe(MAIN, 'push', ...args)
  if (r.ok) return r
  const mine = gitSafe(MAIN, 'rev-parse', ref)
  const there = gitSafe(MAIN, 'ls-remote', 'origin', ref)
  const theirs = there.ok ? there.out.split(/\s+/)[0] : ''
  if (!mine.ok || !theirs || theirs !== mine.out) return r
  // The push that died never moved this machine's idea of origin's branch either.
  if (ref.startsWith('refs/heads/')) gitSafe(MAIN, 'update-ref', `refs/remotes/origin/${ref.slice(11)}`, theirs)
  return { ok: true, out: r.out, landed: true }
}

/** What a failed `pushChecked` was: a push that never finished is not a refusal. */
const pushFailed = (r) => `${r.died ? 'the push to origin did not finish' : 'origin refused the push'}: ${r.out.slice(0, 200)}`

/** `pushChecked` for a push nothing can continue without: throws what went wrong. */
function mustPush(ref, ...args) {
  const r = pushChecked(ref, ...args)
  if (!r.ok) throw new Error(pushFailed(r))
}

function landedOnOrigin(commit) {
  if (!commit) return null
  const remote = gitSafe(MAIN, 'ls-remote', 'origin', `refs/heads/${MB}`)
  if (!remote.ok) return null
  const sha = remote.out.trim().split(/\s+/)[0]
  if (!sha) return null
  const known = gitSafe(MAIN, 'cat-file', '-e', `${sha}^{commit}`)
  if (!known.ok) return null
  return gitSafe(MAIN, 'merge-base', '--is-ancestor', commit, sha).ok
}

function aheadOf(branch) {
  const r = gitCherry(MAIN, MB, branch)
  if (!r.ok) return 0
  return r.out.split('\n').filter((l) => l.startsWith('+')).length
}

/**
 * When the work in a lane last moved, in wall-clock ms - 0 when there is no work.
 *
 * The ledger's `seen` answers a different question: whether a chat still has a window
 * open. That is not what a release needs to know. It needs to know whether anyone is
 * mid-edit, and the honest evidence for that is the files and the commits themselves -
 * the newest mtime among the uncommitted paths, and the newest commit the release does
 * not have. See HOLD_BUSY_MS for what this is measured against, and why.
 *
 * Reads only; a lane is polled while agents are typing in it.
 */
function lastTouched(dir, porcelain, branch) {
  let t = 0
  // Bounded: a lane with 10k untracked files (a stray build output) is not worth 10k
  // stat calls on a poll, and the newest of the first 200 is already newer than any
  // threshold this feeds.
  for (const line of porcelain.split('\n').slice(0, 200)) {
    // `XY path` or `XY old -> new` for a rename; git quotes a path with odd bytes in it.
    // Matched, never sliced at a fixed offset: `git()` trims its output, so the FIRST
    // line of `XY` codes whose X is a space - ` M path`, the commonest state there is -
    // arrives one character short. `slice(3)` then ate the path's first letter, every
    // stat threw, `touchedAt` came back 0, and `busyLanes` reads a 0 as "age unknown, be
    // careful" - so one uncommitted edit in a lane held every other lane's release for
    // as long as the file sat there. Measured on taskdriver.ai 2026-08-28: lane c dirty
    // with `scratchpad/current-run.txt` untouched for 131 minutes still printed
    // "waiting on chats still working in: c" with no age beside it, 188 minutes after
    // the last merge, with two finished lanes queued behind it.
    const m = /^([ MADRCU?!]{1,2})[ \t]+(.*)$/.exec(line)
    if (!m) continue
    let rel = m[2].trim()
    if (!rel) continue
    if (rel.includes(' -> ')) rel = rel.split(' -> ').pop()
    if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1)
    try {
      t = Math.max(t, lstatSync(join(dir, rel)).mtimeMs)
    } catch {
      /* deleted, or a path this platform cannot spell - it tells us nothing either way */
    }
  }
  if (branch) {
    const r = gitSafe(dir, 'log', '-1', '--format=%ct', branch)
    const secs = Number(r.ok ? r.out.trim() : '')
    if (Number.isFinite(secs) && secs > 0) t = Math.max(t, secs * 1000)
  }
  return t
}

/** Work sitting in a lane: uncommitted files, and commits the release does not have. */
// Set only for the span of one `status` call - see there. Every other caller reads live,
// because `release` and `ready` change what a lane holds between two reads.
let workMemo = null
function laneWork(id) {
  if (workMemo?.has(id)) return workMemo.get(id)
  const w = laneWorkNow(id)
  workMemo?.set(id, w)
  return w
}
function laneWorkNow(id) {
  const dir = laneDir(id)
  if (!existsSync(dir)) return { dirty: false, ahead: 0, touchedAt: 0 }
  // A folder that is not a worktree answers every git command with an error, and the
  // error text is text, so `dirty` was true forever - the lane looked like a chat was
  // mid-edit in it and was left alone by everything that would have rebuilt it. It has no
  // uncommitted work because it has no work: say so, and let ensureWorktree repair it.
  if (id !== 'main' && !isWorktree(dir))
    return { dirty: false, ahead: aheadOf(laneBranch(id)), broken: true, touchedAt: 0 }
  const porcelain = gitSafe(dir, ...WORK_STATUS).out
  const dirty = Boolean(porcelain)
  const branch = id === 'main' ? MB : laneBranch(id)
  const ahead = id === 'main' ? unreleasedOnMaster() : aheadOf(laneBranch(id))
  // A copy a killed checkout left half made (halfMade) is unusable however few files it lacks.
  const half = id !== 'main' && halfMade(dir) ? { damaged: true, halfMade: true } : {}
  return { dirty, ahead, touchedAt: lastTouched(dir, porcelain, ahead > 0 ? branch : null), ...damageOf(dir, porcelain), ...half }
}

/**
 * A folder that IS a worktree but never finished being made: git still lists every file of
 * the branch, almost none of them are on disk. Measured on taskdriver.ai-a 2026-09-30
 * (8:45pm): 4,461 staged deletions, only `.claude/` and `..app/` left. `laneWorkNow` read
 * that as `dirty: true, broken: false` - a chat mid-edit - and the folder was handed to a
 * new chat, whose SessionStart hook crashed on a missing module because the scripts it runs
 * were among the files that were gone.
 *
 * Damaged = more than half of the files tracked at HEAD are missing (deleted in the index or
 * on disk). Nothing here repairs or stages anything: those deletions are not anybody's
 * intent, and what is left in the folder is for a person to diagnose (recorded decision,
 * docs/agents/lanes-and-releases.md: damaged folders are backed up and diagnosed, never
 * rebuilt by the engine).
 *
 * Costs nothing for a normal lane: the porcelain is already in hand, and only a lane showing
 * DAMAGED_MIN_DELETED deletions asks git anything more (one `ls-tree`). `ls-tree`, not
 * `ls-files` - in this state the index has been emptied too, so it would answer "almost
 * nothing is tracked" and nothing would be half gone. A failed count is "cannot tell", never
 * "damaged".
 */
const DAMAGED_MIN_DELETED = 10
function damageOf(dir, porcelain) {
  let missing = 0
  for (const line of porcelain.split('\n')) {
    // `XY path`; X = index against HEAD, Y = disk against index. `git()` trims its output,
    // so the first line may arrive with only one code (` D a` is `D a`) - either way a D
    // there is "tracked at HEAD, gone now". `AD`/`RD` were never at HEAD under that name.
    const m = /^([ MADRCUT?!]{1,2})[ \t]+/.exec(line)
    if (m && m[1].includes('D') && !/^[ARC]/.test(m[1])) missing++
  }
  if (missing < DAMAGED_MIN_DELETED) return {}
  const tree = gitSafe(dir, 'ls-tree', '-r', '--name-only', 'HEAD')
  const tracked = tree.ok && tree.out ? tree.out.split('\n').length : 0
  if (!tracked || missing * 2 <= tracked) return {}
  return { damaged: true, missingFiles: missing, trackedFiles: tracked }
}

/**
 * Chats that would lose by a release happening right now: still holding a lane, work in
 * it, and not done with it. Half-finished work is the only reason to wait - a lane that
 * is idle, or already marked ready, is no reason for everyone else's work to sit.
 */
function busyLanes(state) {
  return Object.keys(state.lanes).filter((id) => {
    if (state.ready[id]) return false
    // A claim made on the word "PaneForge" reserves a checkout and nothing else. That it
    // "never delays a release" is written into TENTATIVE_MS as the contract and was
    // enforced nowhere: a tentative holder with one stray file in its lane gated everyone.
    if (state.lanes[id]?.tentative) return false
    const w = laneWork(id)
    // `main` is master, which is the release branch: a commit there is not work in
    // progress, it is work that is already in the next release, and counting it as
    // half-finished held every other lane's work behind whichever chat happened to hold
    // main until that chat closed its window. It waits while master is DIRTY - an edit
    // nobody has committed - and not a moment longer.
    const unfinished = id === 'main' ? w.dirty : w.dirty || w.ahead > 0
    if (!unfinished) return false
    // ...and not longer than HOLD_BUSY_MS either. Work nobody has touched in an hour is
    // not work in progress. A lane whose age cannot be read is given the benefit of the
    // doubt, because the failure that matters here is releasing over somebody's edit.
    return !w.touchedAt || now() - w.touchedAt < HOLD_BUSY_MS
  })
}

/**
 * What holds a release right now. In `merge` mode a release is `git merge && git push` into
 * the main folder and nothing else: another lane's half-done work is never touched by it
 * (`finish` leaves busy lanes where they are), so the only thing that can hold it is an
 * edit in the main folder the merge would land on - `mainBlockers`. Measured 2026-09-23 over
 * the previous 7 days: median 4 minutes from a lane's last commit to its merge, but p90
 * 84-103 minutes and worst 241, every long one waiting on a chat in some other lane.
 */
function releaseHolds(state) {
  if (RELEASE !== 'merge') return busyLanes(state)
  return mainBlockers(state) ? ['main'] : []
}

/** One busy lane, said the way a person needs to hear it: what is in it, and how stale. */
function busyDetail(id) {
  const w = laneWork(id)
  const what = []
  if (w.damaged) what.push('a folder missing most of its files')
  else if (w.dirty) what.push('uncommitted edits')
  if (id !== 'main' && w.ahead > 0) what.push(`${w.ahead} unmerged commit${w.ahead === 1 ? '' : 's'}`)
  const age = w.touchedAt ? `, last touched ${Math.round((now() - w.touchedAt) / 60000)}m ago` : ''
  return `${id} (${what.join(' + ') || 'work'}${age})`
}

/**
 * The tags origin has, before anything local reads them to decide a release.
 *
 * Every release decision in this file is made from LOCAL tags - `bumpFor` reads the newest
 * one to find the commits about to ship, and `commitsSinceVersion` asks whether the current
 * version's tag exists at all. Neither is true of a checkout that has the commits but not
 * the tags, which is the normal state of the second machine: `git pull` brings a release
 * commit across without necessarily bringing its tag, and nothing here ever fetched one.
 *
 * That is not theoretical either. Between v0.4.62 and v0.7.1, on 2026-08-07, FOUR of six
 * releases carried no work at all, and two of them moved the MINOR:
 *
 *   v0.5.0  cut with the newest local tag at v0.4.61, so the range still held
 *           `feat(release): read the version bump off the commits` - already shipped in
 *           v0.4.62 an hour earlier. Read as a feature, bumped the minor, released nothing.
 *   v0.7.0  the same shape one tag later, re-reading `feat: cap what transcripts cost`.
 *
 * `commitsSinceVersion` could not catch either: with the version's own tag missing locally
 * it falls back to counting the WHOLE history, which is never zero. So the guard that
 * exists precisely to say "nothing new since vX" was answering about a tag it could not
 * see. One fetch ahead of the decision makes every one of those reads true.
 *
 * It never fails a release: offline, no origin, or a repo that has none at all just leaves
 * the local tags as they were, which is exactly today's behaviour.
 */
let tagsSyncedAt = 0
function syncTags() {
  // The retry timer calls autoship every minute for as long as the process lives; the
  // answer cannot change faster than a release, so once a minute is already generous.
  if (now() - tagsSyncedAt < 60_000) return
  tagsSyncedAt = now()
  gitSafe(MAIN, 'fetch', '--tags', 'origin')
}

/**
 * Is the trunk diverged from origin: commits here that origin lacks AND commits there that
 * this machine lacks? Fetches first; false whenever that cannot be told.
 */
function trunkDiverged() {
  if (!hasOrigin()) return false
  if (!gitSafe(MAIN, 'fetch', 'origin', MB).ok) return false
  const count = (range) => {
    const r = gitSafe(MAIN, 'rev-list', '--count', range)
    return r.ok ? Number(r.out.trim()) : 0
  }
  return count(`origin/${MB}..${MB}`) > 0 && count(`${MB}..origin/${MB}`) > 0
}

/**
 * Take origin's commits on the trunk when they are a straight fast-forward.
 *
 * Never a merge and never a rebase: this runs with a release lock held and a clean main
 * checkout, and the only state it is allowed to fix is the boring one - this machine has
 * nothing origin does not, origin has commits this machine lacks. Anything else (diverged
 * trunks, no origin, a fetch that fails) is left exactly as it was for the dry-run push
 * to refuse on, which is the behaviour that existed before.
 */
function fastForwardMain() {
  if (!hasOrigin()) return
  if (!gitSafe(MAIN, 'fetch', 'origin', MB).ok) return
  const ahead = gitSafe(MAIN, 'rev-list', '--count', `origin/${MB}..${MB}`)
  if (!ahead.ok || ahead.out.trim() !== '0') return
  // --no-autostash: a configured merge.autoStash is the save-reset-restore landLane avoids.
  gitSafe(MAIN, 'merge', '--ff-only', '--no-autostash', `origin/${MB}`)
}

/**
 * Why the main folder cannot simply be put back on the trunk, or null when it can.
 *
 * "Put back" is two ref writes and no file change: the trunk moves forward to the commit
 * the folder already has, and the folder's HEAD is pointed at the trunk. That is only true
 * when the trunk is behind (or level with) the folder's commit, nothing is half-done in the
 * folder, and no other checkout has the trunk open - moving a branch under another checkout
 * makes that checkout look edited.
 */
function trunkBlocker(on) {
  if (!on) return 'It is not on any branch, so there is nothing to move back.'
  const trunk = gitSafe(MAIN, 'rev-parse', '--verify', '--quiet', `refs/heads/${MB}`)
  if (!trunk.ok) return `There is no ${MB} branch on this computer to move it back to.`
  if (gitSafe(MAIN, ...WORK_STATUS).out) return 'It has unsaved edits, so it is left alone until they are committed.'
  if (gitSafe(MAIN, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD').ok)
    return 'A merge is half-finished in it, so it is left alone.'
  if (!gitSafe(MAIN, 'merge-base', '--is-ancestor', `refs/heads/${MB}`, 'HEAD').ok)
    return `${on} and ${MB} have each got work the other lacks, so a person has to decide where it goes.`
  // Proof the folder was parked, not being worked on: finished chats have already merged
  // into it (`ship` writes `merge lane <x>`). A branch somebody made on purpose and has only
  // their own commits on is theirs - moving it to the trunk would put their next commit
  // there and the next release would push it (pre-ship review, 2026-09-23).
  const merges = gitSafe(MAIN, 'log', '--merges', '--format=%s', `refs/heads/${MB}..HEAD`).out
  if (!/^merge lane /m.test(merges))
    return `Nothing a finished chat did is on ${on}, so somebody may be using it on purpose. Switch the main folder back to ${MB} when that work is done.`
  const other = gitSafe(MAIN, 'worktree', 'list', '--porcelain').out.split('\n\n').find((block) => {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    return path && resolve(path) !== resolve(MAIN) && block.includes(`\nbranch refs/heads/${MB}`)
  })
  if (other) return `${MB} is open in another folder (${/^worktree (.+)$/m.exec(other)[1]}), so it cannot be moved from here.`
  return null
}

/**
 * Make sure finished lanes merge into the trunk, not into whatever the main folder is on.
 *
 * `ship` merges in the main folder, so a folder parked on a side branch receives every
 * lane (taskdriver.ai, 2026-09-23: 35 hours, 171 commits, see trunkName). When it is safe
 * (trunkBlocker) the folder is put back without touching a file; when it is not, nothing
 * merges, the lanes keep their ready marks for the next retry, and `state.trunk` carries
 * the sentence `doctor` prints. Returns that sentence, or null when the folder is on the
 * trunk. Writes the state itself: its callers throw straight after.
 */
function trunkHome(state) {
  const head = gitSafe(MAIN, 'symbolic-ref', '--quiet', '--short', 'HEAD')
  const on = head.ok ? head.out : ''
  if (on === MB) {
    if (state.trunk?.stuck) {
      state.trunk = null
      write(state)
    }
    return null
  }
  const blocker = trunkBlocker(on)
  if (!blocker) {
    const tip = git(MAIN, 'rev-parse', 'HEAD')
    const was = git(MAIN, 'rev-parse', `refs/heads/${MB}`)
    // Old value given, so a trunk that moved since the check is refused rather than rewound.
    git(MAIN, 'update-ref', '-m', `lanes: main folder back on ${MB}`, `refs/heads/${MB}`, tip, was)
    git(MAIN, 'symbolic-ref', '-m', `lanes: main folder back on ${MB}`, 'HEAD', `refs/heads/${MB}`)
    state.trunk = {
      at: now(),
      text: `The main folder had been left on ${on}, which already had everything in ${MB}. It is back on ${MB}; no file in it changed.`
    }
    write(state)
    return null
  }
  const text = `The main folder is on a side branch (${on || 'none'}), so finished chats are waiting. ${blocker}`
  state.trunk = { stuck: true, at: state.trunk?.stuck ? state.trunk.at : now(), text }
  write(state)
  return text
}

/** Anything a release would actually put out. */
function shippable(state) {
  if (unreleasedOnMaster() > 0) return true
  return Object.keys(state.ready).some((id) => id !== 'main' && laneWork(id).ahead > 0)
}

/** The first line worth quoting out of a command that failed. */
function firstLine(out) {
  const line = out
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^npm (WARN|notice)/.test(l))
  return (line ?? 'no output').slice(0, 160)
}

/** A command that never started, as opposed to one that ran and disagreed with the code. */
function cannotRun(out) {
  // A completed suite verdict wins over an injected ENOENT/missing-module error inside
  // its output. Those errors are also legitimate things for a regression test to exercise.
  if (failLines(out)) return false
  // `Tests deferred:` is scripts/test-remote.mjs finding the PC unreachable. Cached as red,
  // it pinned master as failing on its commit after the PC came back (2026-09-23).
  return /is not recognized|command not found|ENOENT|Cannot find module|npm ERR! missing script|sh: .*: not found|Tests deferred:/i.test(out)
}

/** Does this checkout declare dependencies it has not got? */
function dependenciesMissing(pkg) {
  const required = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter((name) => !Object.hasOwn(pkg.optionalDependencies ?? {}, name))
  if (!required.length) return false
  const mods = join(MAIN, 'node_modules')
  try {
    return required.some((name) => !existsSync(join(mods, name, 'package.json')))
  } catch {
    return true
  }
}

/**
 * Put the dependencies back rather than blaming the code for their absence.
 *
 * A checkout with no node_modules fails `npm run typecheck` exactly the way broken code
 * does, and the release said the broken-code sentence about a tree that compiles
 * perfectly: "master does not typecheck, fix it and it goes out by itself". Nothing in
 * that is actionable, and it never stops being true on its own, so every release after it
 * was silently held. It is also self-inflicted - a lane once committed its node_modules
 * junction and the merge replaced the real one (2026-08-01) - which is the strongest
 * argument for healing it here: the tool broke it, and the repair is one command with
 * only one right answer.
 *
 * Returns null when the dependencies are there afterwards, a sentence when they are not.
 */
function installDeps() {
  const cmd = existsSync(join(MAIN, 'package-lock.json')) ? 'npm ci' : 'npm install'
  const r = spawnSync(cmd, { windowsHide: true, cwd: MAIN, encoding: 'utf8', timeout: 900_000, shell: true })
  if (r.status === 0) return null
  return (
    `${basename(MAIN)} is missing declared dependencies and \`${cmd}\` could not install them, so nothing was ` +
    `released - ${firstLine(`${r.stdout ?? ''}${r.stderr ?? ''}`)}. The code is not the problem; the checkout is.`
  )
}

const RBUILD = join(homedir(), '.claude', 'rbuild.mjs')

/** How long one try waits on a PC job before handing the job to the next try. */
const PC_WAIT_S = 900

/**
 * The tree id of everything rbuild would ship from `dir`: the commit plus every edit and
 * new file .gitignore keeps, staged into a throwaway index so the real one is never
 * touched. Null when git cannot say, and then nothing is reused.
 */
function workingTree(dir) {
  const index = join(tmpdir(), `lane-tree-${process.pid}-${randomUUID()}`)
  try {
    const real = gitSafe(dir, 'rev-parse', '--git-path', 'index')
    if (!real.ok) return null
    // A copy of the real index keeps git's stat cache, so only changed files are re-read.
    copyFileSync(resolve(dir, real.out), index)
    const env = { ...process.env, GIT_INDEX_FILE: index }
    const opts = { cwd: dir, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 }
    if (spawnSync('git', ['add', '-A'], opts).status !== 0) return null
    const tree = spawnSync('git', ['write-tree'], opts)
    return tree.status === 0 ? tree.stdout.trim() : null
  } catch {
    return null
  } finally {
    try {
      unlinkSync(index)
    } catch {}
  }
}

/**
 * On the Mac the typecheck and the test suite run on the PC through rbuild: nothing heavy
 * runs on the laptop, and a loaded Mac timed the local ones out (see `typecheckFailure`).
 * A repo under the temp dir stays local: the fixture tests stub npm and must not reach the PC.
 */
function onPc() {
  if (process.platform !== 'darwin' || !existsSync(RBUILD)) return false
  const tmp = tmpdir()
  return ![tmp, `/private${tmp}`].some((t) => MAIN.startsWith(t))
}

/**
 * One ledger entry - `[key]`, or `[key, sub]` inside an object - written onto the ledger AS
 * IT IS NOW (null removes it), and onto `state` too because the caller goes on using it. A
 * PC wait holds `state` for up to 15 minutes and must not write back a stale copy of
 * everything else, same as the suite verdict below.
 */
function remember(state, [key, sub], value) {
  const fresh = read()
  for (const s of [state, fresh]) {
    const box = sub === undefined ? s : (s[key] = { ...s[key] })
    const name = sub ?? key
    if (value) box[name] = value
    else delete box[name]
  }
  write(fresh)
}

/** The tree `dir` has committed (HEAD's), or null. The tree a push sends, so the one a PC verdict must be on. */
function headTree(dir) {
  const t = gitSafe(dir, 'rev-parse', 'HEAD^{tree}')
  return t.ok ? t.out : null
}

/**
 * Queue `words` on the PC for exactly `tree`, the committed tree of `dir`. rbuild uploads the
 * folder as it stands, so while another chat has uncommitted edits in it the job tested a tree
 * no commit has, and the pre-push hook (`treeVerdict` on the pushed commit's tree) never found a
 * verdict: 2026-10-07 master sat 9 commits ahead of origin, lanes b and d merged and unpushed,
 * for as long as main was being edited. A folder that is not exactly `tree` ships a throwaway
 * copy of `tree` instead (`git archive`, 0.3 s for PaneForge), named like the folder so the PC
 * labels it the same; rbuild has read every file by the time it returns, so the copy goes then.
 */
function submitPcTree(dir, tree, words) {
  if (!tree || workingTree(dir) === tree) return submitPcJob(dir, words)
  const box = mkdtempSync(join(tmpdir(), 'lane-pc-'))
  try {
    const copy = join(box, basename(dir))
    mkdirSync(copy)
    const tar = join(box, 'tree.tar')
    const a = gitSafe(dir, 'archive', '--format=tar', '-o', tar, tree)
    if (!a.ok) return { failed: `could not copy the committed files out of git: ${firstLine(a.out)}` }
    const x = spawnSync('tar', ['-xf', tar, '-C', copy], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
    if (x.status !== 0) return { failed: `could not unpack the committed files: ${firstLine(`${x.stderr ?? ''}`) || `exit ${x.status}`}` }
    rmSync(tar, { force: true })
    return submitPcJob(copy, words)
  } finally {
    rmSync(box, { recursive: true, force: true })
  }
}

/** Queue `words` on the PC for `dir` without waiting: `{ id }`, or `{ failed }` with why not. */
function submitPcJob(dir, words) {
  const at = process.argv.indexOf('--session')
  const session =
    (at >= 0 && process.argv[at + 1]) || process.env.CLAUDE_SESSION_ID || process.env.CODEX_THREAD_ID || `lane-${hostname()}`
  const sent = spawnSync(process.execPath, [RBUILD, '--repo', dir, '--session', session, '--no-wait', ...words], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 600_000
  })
  const id = /rbuild: job ([0-9a-f-]{36}) saved/.exec(sent.stderr ?? '')?.[1]
  if (id) return { id }
  const all = `${sent.stdout ?? ''}${sent.stderr ?? ''}`
  return { failed: all.trim() ? firstLine(all) : sent.error?.message || `exit ${sent.status}` }
}

/**
 * Wait up to `seconds` on one PC job. `pending` while it is still queued or running - and
 * when this waiter was itself killed, because the job keeps its place on the PC and a dead
 * waiter is never a verdict on the code (dropping the job there queued a fresh one at the
 * back, the livelock below). `why` is rbuild's own final line when it printed one.
 *
 * A clock tick (`!suiteWaits()`) never waits on a job still in line. It ran this whole wait
 * inside `retry`, holding the recovery lock: 2026-10-04 1:12pm-1:27pm one sat 15 minutes in
 * `--wait <id> 900` and every `recover` from another chat failed, and the clocks kill a tick
 * long before (lane-cron at 4 minutes). So a tick first asks the job's state once with
 * `rbuild --resume` - one short ssh, no wait: it finishes an upload that was cut off and
 * reports the state (exit 0 passed, 1 ended, 75 still in line), and the PC counts the ask as
 * a waiter, so a job only ticks look at is not cancelled as orphaned after 10 minutes. Still
 * in line: pending, and the next tick asks again. Ended: the wait below returns at once with
 * its output (rbuild's 60 s is only the cap), so a finished job's verdict still lands.
 * `once` asks the same way from a caller that does wait, before it picks a job to wait on.
 */
function waitPcJob(id, seconds = PC_WAIT_S, once = !suiteWaits()) {
  if (once) {
    const asked = rbuildOnce(['--resume', id], 180)
    // Anything but an ended job is still in line to a tick, rbuild refusing included (another
    // process is mid-upload of it): a chat's own full wait settles the rest, as it always did.
    if (asked.status !== 0 && asked.status !== 1) return { ...asked, pending: true }
    seconds = 60
  }
  return rbuildOnce(['--wait', id, String(seconds)], seconds + 300)
}

/** One rbuild call about a submitted job, read the way `waitPcJob` describes. */
function rbuildOnce(args, timeoutS) {
  const r = spawnSync(process.execPath, [RBUILD, ...args], {
    windowsHide: true,
    encoding: 'utf8',
    // The job's whole output comes back here; past the default 1 MB spawnSync kills rbuild.
    maxBuffer: 64 * 1024 * 1024,
    // rbuild ends its own wait at `seconds` (+120s for its ssh); this is only a backstop.
    timeout: timeoutS * 1000
  })
  const stderr = r.stderr ?? ''
  const out = `${r.stdout ?? ''}${stderr}`
  // The LAST status line: rbuild relays every PC progress line as `rbuild: <text>` too.
  const final = stderr.match(/^rbuild: (succeeded|failed|timed_out|cancelled)\b.*$/gm)?.at(-1)
  return {
    pending: r.status === 75 || r.status == null,
    status: r.status,
    // rbuild names a job that ran and exited red `failed`; cancelled and timed_out never ran to a verdict.
    ran: /^rbuild: failed\b/.test(final ?? ''),
    // It got as far as running on the PC: exited red, or stopped there after minutes of running
    // (2026-10-08 paneforge-next main: "timed_out after 11 min running, 0 min waiting, peak memory
    // 8.1 of 8.0 GB; Stalled: no output ..."). Still no verdict; `pcSuite` calls it `died`.
    started: /^rbuild: (failed\b|timed_out\b.*\bafter [1-9]\d* min running)/.test(final ?? ''),
    out,
    why: final ?? (out.trim() ? firstLine(out) : r.error?.message || `exit ${r.status}`)
  }
}

/** A suite sentence that is not a verdict on the code: queued on the PC, already running here, or the runner failed. */
const SUITE_UNSETTLED = /test suite (is already running|ended without an answer|(is still waiting its turn on|could not (run on|be sent to)) the PC)/
/**
 * The unsettled case not worth waiting out: the suite started on the PC and ended red with no
 * failing test named (`died` in `pcSuite`). Asking master again cannot end it when the cause
 * is master's own tree, and the lane carrying the fix was never asked (2026-10-08
 * paneforge-next: `npm test` started every file at once, 8.1 of 8.0 GB, so the lane capping
 * it sat marked done behind "could not run", then behind "timed_out after 11 min running ...
 * Stalled"). The ready lanes are asked instead. A job that never ran (cancelled, timed out in
 * line, unsent, tooling missing) still waits: that is the runner, not a tree.
 */
const SUITE_DIED = /test suite could not run on the PC, .* each finished lane is tried on its own/

const pcWaiting = (what, id) =>
  `${MB}'s ${what} is still waiting its turn on the PC (job ${id.slice(0, 8)}), so nothing was released yet. ` +
  `The next try waits on that same job rather than queueing another.`

/** Store one tree's PC typecheck job/verdict; entries older than 48 h are dropped on the way. */
function rememberTypecheck(state, tree, entry) {
  remember(state, ['typecheckTrees', tree], entry)
  const cutoff = now() - 48 * 3600_000
  for (const [t, e] of Object.entries(read().typecheckTrees ?? {})) {
    if (t !== tree && !(e?.at > cutoff)) remember(state, ['typecheckTrees', t], null)
  }
}

/**
 * `undefined` means "not handled here, run it locally"; null means it passed; a sentence
 * means it did not.
 *
 * One PC job per tree, remembered in the ledger (`state.typecheckTrees[tree]`), and a try that runs
 * out of time leaves it for the next try instead of queueing another. Measured 2026-10-01:
 * with 25 jobs in the PC queue every try submitted a fresh job at the back, was killed
 * 20 minutes later still queued (its ssh waiter orphaned, its job still bound to run for
 * nobody), and the retry timer started over at the back - three copies of one master
 * typecheck queued 09:32-09:50 and lane e's finished fix never merged. The wait now ends
 * inside rbuild (`--wait` with a budget), so nothing is killed mid-connection.
 */
function remoteTypecheckFailure(state) {
  if (!onPc()) return undefined
  const tree = headTree(MAIN)
  // Fresh: another chat's try may have queued this tree's job since `state` was read.
  // Per tree, not one slot: a release asks about master's tree and then the merged tree, and
  // with one slot each tick evicted the other's job and re-queued it forever (2026-10-09:
  // ledger typecheck.id fb318349 -> ac5b0e3a -> 482b5466 -> 3b6cd590 in 20 min, lane b never landed).
  const known = (tree && read().typecheckTrees?.[tree]) || null
  if (known && 'verdict' in known) return known.verdict
  let id = known?.id
  if (!id) {
    const sent = submitPcTree(MAIN, tree, ['typecheck'])
    if (sent.failed) {
      return `${MB}'s typecheck could not be sent to the PC, so nothing was released - ${sent.failed}. That is the remote runner, not the code.`
    }
    id = sent.id
    if (tree) rememberTypecheck(state, tree, { id, at: now() })
  }
  const r = waitPcJob(id)
  if (r.pending) return pcWaiting('typecheck', id)
  const detail = r.out
    .split('\n')
    .filter((l) => /error TS/.test(l))
    .slice(0, 3)
    .join('; ')
  if (r.status === 0 || detail) {
    const verdict = detail ? `${MB} does not typecheck, so it was not released - ${detail}. Fix it and it goes out by itself.` : null
    if (tree) rememberTypecheck(state, tree, { id, at: now(), verdict })
    return verdict
  }
  // Cancelled, timed out on the PC, or a job rbuild no longer knows: the next try sends a new one.
  if (tree) remember(state, ['typecheckTrees', tree], null)
  return `${MB}'s typecheck could not run on the PC, so nothing was released - ${r.why}. That is the remote runner, not the code.`
}

/** test-all.mjs prints one line per check; the FAIL lines are the whole answer and the rest is noise. */
function failLines(all) {
  return all
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(?:(?:fail|FAIL|not ok)\b|[✗✖]\s)/.test(l) && !/^[✗✖]\s+failing tests:$/.test(l))
    .slice(0, 4)
    .join('; ')
}

/** The check names in a `failLines` string: `FAIL  stickyselect  24.7s; ...` -> { stickyselect, ... }. */
function failNames(text) {
  return new Set(text.split('; ').map((p) => {
    // Node's spec reporter names individual tests, which can share their first word.
    const spec = p.match(/^[✗✖]\s+(.+?)(?:\s+\([\d.]+ms\))?$/)
    return spec?.[1] ?? p.match(/^(?:fail|FAIL|not ok)\s+(\S+)/)?.[1]
  }).filter(Boolean))
}

/**
 * The test suite of `dir` on the PC: one job per tree, remembered through `save` (master's
 * in `state.pcSuite`, a lane's in `state.pcLaneSuite[id]`), whose last value is `known`.
 * Not `state.suite`: every chat's installed lane.mjs still keys that one on the commit and
 * runs the old blocking suite when it does not match, so sharing it would have each copy
 * overwrite the other's record and queue the job again.
 *
 * The typecheck's livelock (above) with a worse ending. `npm test` on the Mac is
 * test-remote.mjs, a blocking rbuild; the gate killed it at 20 minutes while it was still
 * QUEUED behind 25 jobs, ran it again to "confirm", and cached "did not finish within 20
 * minutes" as master's red verdict on the commit. Master only moves by a merge, which that
 * verdict blocks: lanes e, i, d, a and f sat ready all evening (2026-10-01), and the lane
 * fix below queued two more 20-minute kills per lane (one try took 1h45m).
 *
 * - `{ pending: id }`: still queued or running. Never cached, never confirmed; the next try
 *   waits on that same id.
 * - `{ cannot, why }`: the job never ran to a verdict (could not be sent, cancelled, timed
 *   out on the PC, unknown to rbuild, tooling missing, or red with no failing check named
 *   - a dependency install or an out-of-memory kill on the PC, which caching would pin until
 *   a merge). Dropped, so the next try sends a new one. `died` when it did run on the PC
 *   (red, or stopped after minutes of running) with no tooling missing: a tree CAN cause
 *   that one (2026-10-08 paneforge-next: `npm test` started every file at once, 8.1 of
 *   8.0 GB), so the gate asks the ready lanes too.
 * - `{ red }`: ran and failed checks it names, then failed again on one confirming job (the
 *   confirm-once rule in `suiteFailure`; the confirming job is remembered too), repeating a
 *   check the first job failed. Two reds on different checks mean every check passed in one
 *   of the runs (lane d, 2026-10-02: `promptsubmit`, then `stickyselect`, a PC-load flake,
 *   pinned it red): that passes, with `flaky` on the record. Cached on the tree.
 * - null: passed. Cached on the tree.
 *
 * `known` must be a fresh read, not a `state` loaded before a 15-minute wait: two chats
 * trying at once would each queue the same tree. `sendOnly` queues the job (or finds the
 * cached answer) without waiting; `once` reads a finished job's answer without waiting on
 * one still in line (`waitPcJob`); `waitS` is the wait budget.
 */
function pcSuite(dir, known, save, { sendOnly = false, once = false, waitS = PC_WAIT_S } = {}) {
  const tree = headTree(dir)
  const mine = tree && known?.tree === tree ? known : null
  if (mine && 'ok' in mine) return mine.ok ? null : { red: mine.reason }
  let id = mine?.id
  let confirming = Boolean(mine?.confirming)
  // The first job's FAIL lines, kept across tries: the confirming job is judged against them.
  let firstRed = mine?.firstRed
  for (;;) {
    if (!id) {
      // The repo's own suite, as `npm test` on the PC runs it (test-all.mjs runs in place
      // on Windows). The typecheck is its own gate, already passed for this tree.
      const sent = submitPcTree(dir, tree, ['--', 'npm', 'test'])
      // The record is left as it is: after a red first job it still names that job, and
      // the next try reads its answer again rather than running it again.
      if (sent.failed) return { cannot: 'be sent to', why: sent.failed }
      id = sent.id
      if (tree) save({ tree, id, at: now(), ...(confirming && { confirming, firstRed }) })
    }
    if (sendOnly) return { pending: id }
    const r = waitPcJob(id, waitS, once || !suiteWaits())
    if (r.pending) return { pending: id }
    if (r.status === 0) {
      if (tree) save({ tree, ok: true, at: now() })
      return null
    }
    const failed = failLines(r.out)
    if (!r.ran || cannotRun(r.out) || !failed) {
      if (tree) save(null)
      return { cannot: 'run on', why: r.why, ...(r.started && !cannotRun(r.out) && { died: true }) }
    }
    if (confirming) {
      // No record of the first red (an older lane.mjs wrote it), a shared check, or a list
      // `failLines` may have cut at 4 (the shared one could be past the cut): as before.
      const first = failNames(firstRed ?? '')
      const again = failNames(failed)
      const whole = (names) => names.size > 0 && names.size < 4
      if (whole(first) && whole(again) && ![...again].some((n) => first.has(n))) {
        if (tree) save({ tree, ok: true, at: now(), flaky: `${firstRed} / ${failed}` })
        return null
      }
      if (tree) save({ tree, ok: false, at: now(), reason: failed })
      return { red: failed }
    }
    confirming = true
    firstRed = failed
    id = null
  }
}

/** Empty when master compiles (or has no typecheck script), a sentence when it does not. */
function taskdriverProofFailure(dir, ref) {
  const r = spawnSync(process.execPath, [TASKDRIVER_PROOF, '--repo', dir, '--ref', ref], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true
  })
  if (r.status === 0) return null
  return `Taskdriver PC verification for ${ref.slice(0, 8)} is required before release - ${firstLine(`${r.stderr ?? ''}\n${r.stdout ?? ''}`)}.`
}

/** The proof has a GitHub run under way for the tree: waiting is the answer, not a fix. */
const PROOF_PENDING = /release-check is still running|started GitHub release-check/i

function taskdriverPreflightFailure(state) {
  const head = gitSafe(MAIN, 'rev-parse', 'HEAD')
  if (!head.ok) return 'Taskdriver PC verification could not identify main HEAD, so nothing was released.'
  // A ready lane has already merged main. Its verified tree may repair a red main,
  // but only the actual combined tree is accepted below before any push.
  let laneFailure = null
  for (const [id, mark] of Object.entries(state.ready)) {
    if (id === 'main') continue
    const dir = laneDir(id)
    const tip = gitSafe(dir, 'rev-parse', 'HEAD')
    if (!tip.ok || tip.out !== mark.commit ||
        !gitSafe(dir, 'merge-base', '--is-ancestor', head.out, tip.out).ok) continue
    const failed = taskdriverProofFailure(dir, tip.out)
    if (!failed) return null
    if (!laneFailure || (PROOF_PENDING.test(failed) && !PROOF_PENDING.test(laneFailure))) laneFailure = failed
  }
  // That lane's tree is main plus its repair, so its answer is the one the release waits
  // on. Quoting main's instead told a lane whose check had just started that main's tests
  // (which the lane fixes) were red (taskdriver.ai 2026-09-28, run 36353863879); and main's
  // proof is not worth running while the lane's is under way.
  if (laneFailure && PROOF_PENDING.test(laneFailure)) return laneFailure
  const mainFailure = taskdriverProofFailure(MAIN, head.out)
  return mainFailure && (laneFailure ?? mainFailure)
}

function typecheckFailure(state) {
  if (TASKDRIVER_PC) return taskdriverPreflightFailure(state)
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(MAIN, 'package.json'), 'utf8'))
  } catch {
    return null
  }
  if (!pkg.scripts?.typecheck) return null
  if (dependenciesMissing(pkg)) {
    const failed = installDeps()
    if (failed) return failed
  }
  const remote = remoteTypecheckFailure(state)
  if (remote !== undefined) return remote
  // One string + shell: npm on Windows is npm.cmd, which cannot be spawned directly.
  const r = spawnSync('npm run --silent typecheck', { windowsHide: true,
    cwd: MAIN,
    encoding: 'utf8',
    timeout: 150_000,
    shell: true
  })
  if (r.status === 0) return null
  // Killed by the timeout is not a type error either. Measured 2026-09-23: taskdriver.ai's
  // typecheck ran past 150s on a Mac at load 44-88 and `ship` said "main does not typecheck"
  // twice, with no error line, about a tree the PC compiled clean in 52.9s.
  if (r.error?.code === 'ETIMEDOUT' || r.signal) {
    return `${MB}'s typecheck was stopped after 150s, so nothing was released. That is this machine's load, not the code.`
  }
  const all = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const detail = all
    .split('\n')
    .filter((l) => /error TS/.test(l))
    .slice(0, 3)
    .join('; ')
  // A typecheck that could not START is not a typecheck that failed. Both used to produce
  // "master does not typecheck", which sends whoever reads it looking for a type error
  // that does not exist - and hides the one thing that would fix it.
  if (!detail && cannotRun(all)) {
    return (
      `${MB}'s typecheck could not run, so nothing was released - ${firstLine(all)}. ` +
      `That is this checkout's tooling, not the code.`
    )
  }
  return `${MB} does not typecheck, so it was not released${detail ? ` - ${detail}` : ''}. Fix it and it goes out by itself.`
}

// A suite that has not finished in this long is not going to. (PF_SUITE_TIMEOUT_MS: tests only.)
const SUITE_TIMEOUT_MS = Number(process.env.PF_SUITE_TIMEOUT_MS) || 20 * 60 * 1000

/**
 * One test suite at a time per repository on this computer, whatever tree it is on.
 * `suiteRunning` below stops a second run of the SAME commit; this stops the rest: on
 * 2 Oct 2026 the PC had 10 of PaneForge's suites running at once (~1 GB and 20-30
 * processes each), each slower for the others, timing out at 20 minutes and being started
 * again. A second caller waits for the first one's answer. Stale after two full runs.
 */
const SUITE_LOCK = join(commonDir, 'paneforge-suite.lock')
const SUITE_LOCK_STALE_MS = 2 * SUITE_TIMEOUT_MS + 5 * 60 * 1000

/** How long the suite holding SUITE_LOCK has run, as words. */
function suiteBusy() {
  let at = 0
  try {
    at = Number(readFileSync(SUITE_LOCK, 'utf8').trim().split(/\s+/)[1])
  } catch {
    /* finished meanwhile */
  }
  return at ? `${Math.max(1, Math.round((now() - at) / 60000))} min so far` : 'just finishing'
}

/** What master's gate says while SUITE_LOCK is another run's. Never cached: not a verdict. */
const masterSuiteBusy = () =>
  `${MB}'s test suite is already running for another chat on this computer (${suiteBusy()}), so this one waits for that answer instead of starting a second copy.`

/**
 * `npm test` in `dir`, and when it is killed for time, everything it started is killed too.
 *
 * spawnSync's timeout kills the one process it started. On Windows that is cmd.exe, and
 * npm, test-all and every suite under them run on with nobody reading the answer. Measured
 * on the PC 2026-10-02 10:28pm: 10 full suites at once, 4 of them orphans of a timed-out
 * gate, CPU ~70%, and each new gate run then timed out too because of the others. Windows
 * keeps a dead parent's id on its children, so they are found by it and killed whole.
 */
function runNpmTest(dir) {
  const r = spawnSync('npm test --silent', { windowsHide: true, cwd: dir, encoding: 'utf8', timeout: SUITE_TIMEOUT_MS, shell: true })
  if (r.pid && (r.error || r.signal)) killChildrenOf(r.pid)
  return r
}

/** Windows: kill every process tree whose parent was `parent` (dead or alive). Elsewhere a no-op. */
function killChildrenOf(parent) {
  if (process.platform !== 'win32') return
  const kids = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId=${parent}" | ForEach-Object { $_.ProcessId }`],
    { windowsHide: true, encoding: 'utf8', timeout: 60_000 }
  )
  for (const pid of (kids.stdout ?? '').split(/\s+/).filter((p) => /^\d+$/.test(p))) {
    spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true, timeout: 60_000 })
  }
}

/**
 * Whether another process is running `npm test` in `dir` on `commit` right now.
 *
 * The verdict is only written when a run ENDS, so without this every caller during a run -
 * each `ready`, every ending chat's `release`, the retry timer - missed the cache and started
 * a full suite of its own on the same tree (the 10 above). A live pid on the same commit is
 * the answer "wait for it"; a record older than two passes is a run that died unrecorded.
 *
 * A record whose process is gone was KILLED mid-run (lane-cron SIGKILLs its tick at 4
 * minutes, the app's retry has its own timeout). Node's kill-on-close job usually takes the
 * suite down with it; anything that escaped the job is killed here before another starts.
 */
function suiteRunning(dir, commit) {
  const run = read().suiteRun?.[dir]
  if (!run || run.pid === process.pid) return false
  let alive
  try {
    process.kill(run.pid, 0)
    alive = true
  } catch (e) {
    alive = e.code !== 'ESRCH'
  }
  if (!alive) {
    killChildrenOf(run.pid)
    const fresh = read()
    if (fresh.suiteRun?.[dir]?.pid === run.pid) {
      delete fresh.suiteRun[dir]
      write(fresh)
    }
  }
  if (!commit || run.commit !== commit || now() - run.at > 2 * SUITE_TIMEOUT_MS + 5 * 60_000) return false
  return alive
}

/**
 * `judge()` with `dir`'s run on `commit` written down for `suiteRunning`, and taken off after.
 * `job`: this process is a detached `suite-job`, which `stopStaleSuiteJob` may kill.
 */
function withSuiteRun(state, dir, commit, judge, job = false) {
  if (!commit) return judge()
  remember(state, ['suiteRun', dir], { commit, pid: process.pid, at: now(), ...(job ? { job } : {}) })
  try {
    return judge()
  } finally {
    if (read().suiteRun?.[dir]?.pid === process.pid) remember(state, ['suiteRun', dir], null)
  }
}

/**
 * Whether this command waits for a suite it started, or for a PC job (`waitPcJob`). A clock
 * tick does not: lane-cron SIGKILLs `retry` at 4 minutes (scripts/lane-cron.mjs) and the app
 * kills `retry` and `release --gone` at 10 (src/main/laneBoard.ts RETRY_TIMEOUT), each far
 * inside one 20-minute run, so the tick says "already running" and the next tick reads the
 * answer. A chat's `ready`, `release` or `autoship` waits for it, as it always did.
 */
const suiteWaits = () => !(cmd === 'retry' || (cmd === 'release' && argv.includes('--gone')))

/**
 * Run `dir`'s suite on `commit` as a process of its own (`suite-job`) and return its pid,
 * recorded in `state.suiteRun` before this returns. Null when it could not be started.
 *
 * The suite used to run inside whoever asked, and two of the askers are clocks with a time
 * limit (`suiteWaits`). A killed tick took its suite down with it - libuv puts a node
 * process's children in a kill-on-close job - so every tick burned up to 10 minutes of a
 * full suite and never produced a verdict, and the tick after started another (2026-10-02,
 * PC). Detached, the job leaves that job object, finishes, and writes the verdict where every
 * later try reads it (`state.suite` / `state.laneSuite`) plus its own answer
 * (`state.suiteLast`) for the one caller that waits on it.
 *
 * The record is written FIRST, under this process's pid, so nothing starts a second run in
 * the moment before the job writes its own; it is then handed to the job's pid unless the
 * job already did (or already finished). The last job's answer is cleared first, so the
 * caller never reads an older job's answer as this one's (Windows reuses pids).
 */
function startSuiteJob(state, dir, commit, kind) {
  remember(state, ['suiteLast', dir], null)
  remember(state, ['suiteRun', dir], { commit, pid: process.pid, at: now() })
  let pid
  try {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), 'suite-job', '--repo', MAIN, '--dir', dir, '--commit', commit, '--kind', kind],
      { detached: true, stdio: 'ignore', windowsHide: true, cwd: dir }
    )
    child.on('error', () => {})
    child.unref()
    pid = child.pid
  } catch {
    /* no pid: handled below */
  }
  const fresh = read()
  if (fresh.suiteRun?.[dir]?.pid === process.pid) {
    if (pid) fresh.suiteRun[dir] = { commit, pid, at: now(), job: true }
    else delete fresh.suiteRun[dir]
    write(fresh)
  }
  syncSuiteKeys(state)
  return pid ?? null
}

/** The suite keys of `state` as the ledger has them now: another process (`suite-job`) wrote them. */
function syncSuiteKeys(state) {
  const fresh = read()
  for (const key of ['suite', 'laneSuite', 'suiteRun', 'suiteLast']) {
    if (fresh[key] === undefined) delete state[key]
    else state[key] = fresh[key]
  }
}

/**
 * Wait for the suite job `pid` on `dir` to answer: its `state.suiteLast` entry, or null when
 * it ended without one (killed, crashed) or ran past two full passes.
 */
function awaitSuiteJob(state, dir, pid, commit) {
  const until = now() + 2 * SUITE_TIMEOUT_MS + 5 * 60_000
  for (;;) {
    const s = read()
    const last = s.suiteLast?.[dir]
    if (last?.pid === pid && last.commit === commit) {
      syncSuiteKeys(state)
      return last
    }
    const run = s.suiteRun?.[dir]
    if (run?.pid !== pid || !processAlive(pid) || now() > until) {
      // A job killed mid-run leaves its record and maybe a suite with nobody reading it.
      if (run?.pid === pid) suiteRunning(dir, run.commit)
      syncSuiteKeys(state)
      return null
    }
    sleep(5000)
  }
}

/**
 * `suite-job`: the run itself, in its own process (`startSuiteJob`), answer written down.
 * `job` false is the in-process fallback when no job could be started.
 *
 * SUITE_LOCK is taken HERE, by the process that runs the suite: taken by the caller it would
 * carry a clock tick's pid, look dead the moment the tick is killed, and be taken over while
 * the suite still ran. Another tree's run taking it between the caller's look and now is an
 * answer of "busy", never a verdict.
 */
function runSuiteJob(state, dir, commit, kind, job = false) {
  return withSuiteRun(
    state,
    dir,
    commit,
    () => {
      const unlock = takeLock(SUITE_LOCK, SUITE_LOCK_STALE_MS)
      let reason
      try {
        if (!unlock) reason = kind === 'lane' ? LANE_SUITE_RUNNING : masterSuiteBusy()
        else reason = kind === 'lane' ? laneVerdict(state, dir, commit) : masterVerdict(state, commit)
      } finally {
        unlock?.()
      }
      // Before the record comes off, so a caller that sees the record gone finds the answer.
      remember(state, ['suiteLast', dir], { commit, pid: process.pid, ok: !reason, reason: reason ?? undefined, at: now() })
      return reason
    },
    job
  )
}

/**
 * Kill a suite job still testing an OLDER commit of `dir`: that tree moved on, so its verdict
 * answers a question nobody will ask, and it would hold SUITE_LOCK for up to two full passes
 * while the current commit waits. Only a `job` record is ever killed - any other record is a
 * chat's own lane.mjs running the suite in-process.
 */
function stopStaleSuiteJob(dir, commit) {
  const run = read().suiteRun?.[dir]
  if (!run?.job || run.commit === commit || run.pid === process.pid || !processAlive(run.pid)) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(run.pid), '/T', '/F'], { windowsHide: true, timeout: 60_000 })
  else {
    // Detached, so the job leads its own process group: npm and every suite under it go too.
    // signalGroup refuses pid 0 and 1 (kill(-1) is every process the user owns).
    signalGroup(run.pid, 'SIGKILL')
  }
  const fresh = read()
  if (fresh.suiteRun?.[dir]?.pid === run.pid) {
    delete fresh.suiteRun[dir]
    write(fresh)
  }
}

/**
 * Empty when the release branch's own test suite passes, a sentence when it does not.
 *
 * The typecheck above was the ONLY thing between a commit and a tag, and a typecheck
 * proves the types agree - never that the app works. That is how 130 dev builds went out
 * in 14 days carrying bugs the checked-in suite already knew about, and the cost lands
 * entirely on whoever runs the dev channel: the app updates itself, restarts, and is
 * still wrong. `npm test` is 81 checks in ~145s and needs no window, no network and no
 * agent CLI - which is exactly why it is the right gate and why it was worth having
 * before this was written. Nobody is watching an automatic release; it checks itself.
 *
 * **Cached on the COMMIT**, in the ledger every worktree shares, because the app's retry
 * timer asks this every minute. Without the cache a red branch burns the whole suite once
 * a minute for as long as it stays red, and a green one re-proves itself for every
 * attempt that then loses on some other check. A new commit is the only thing that
 * invalidates it, which is the only thing that should: the suite is a fact about a tree.
 *
 * A suite that could not START is reported as this checkout's tooling, never as a failing
 * test - same distinction `typecheckFailure` draws, and for the same reason: the sentence
 * decides where the next person looks. That case is deliberately NOT cached; a missing
 * node_modules is fixed outside this file and the next attempt should find out.
 *
 * On the Mac it runs on the PC instead (`pcSuite`, cached in `state.pcSuite`) on the TREE
 * MAIN has committed - never another chat's uncommitted edits, which no push sends (`submitPcTree`).
 *
 * `npm run ship` still bypasses all of it - it exists for a build somebody needs in their
 * hands now, and it is typed by a person who is watching.
 */
function suiteFailure(state) {
  // The Taskdriver PC proof above covers its full offline verify suite too.
  if (TASKDRIVER_PC) return null
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(MAIN, 'package.json'), 'utf8'))
  } catch {
    return null
  }
  // A repo with no suite is not held to one. Nor is npm's own "no test specified" stub,
  // which exits 1 by design and would block every release in a repo that never had tests.
  const script = pkg.scripts?.test
  if (!script || /no test specified/i.test(script)) return null

  if (onPc()) {
    const v = pcSuite(MAIN, read().pcSuite, (rec) => remember(state, ['pcSuite'], rec))
    if (!v) return null
    if (v.pending) return pcWaiting('test suite', v.pending)
    if (v.died) {
      return `${MB}'s test suite could not run on the PC, so nothing was released - ${v.why}. It started and stopped without naming a failing test, so each finished lane is tried on its own.`
    }
    if (v.cannot) {
      return `${MB}'s test suite could not ${v.cannot} the PC, so nothing was released - ${v.why}. That is the remote runner, not the code.`
    }
    return `${MB} fails its own test suite, so it was not released - ${v.red}. Fix it and it goes out by itself.`
  }

  const head = gitSafe(MAIN, 'rev-parse', 'HEAD')
  const commit = head.ok ? head.out : null
  // A fresh read, not `state`: that copy can predate a run another process just finished.
  const cached = read().suite
  if (commit && cached?.commit === commit && (cached.ok || !cannotRun(cached.reason ?? ''))) {
    state.suite = cached
    return cached.ok ? null : cached.reason
  }
  const running = `${MB}'s test suite is already running on this commit for another check, so nothing was released yet. The next try reads its answer rather than starting another.`
  if (suiteRunning(MAIN, commit)) return running

  if (dependenciesMissing(pkg)) {
    const failed = installDeps()
    if (failed) return failed
  }
  if (!commit) return runSuiteJob(state, MAIN, null, 'master')
  stopStaleSuiteJob(MAIN, commit)
  if (lockHeld(SUITE_LOCK, SUITE_LOCK_STALE_MS)) return masterSuiteBusy()
  const pid = startSuiteJob(state, MAIN, commit, 'master')
  if (!pid) return runSuiteJob(state, MAIN, commit, 'master')
  if (!suiteWaits()) return running
  const answer = awaitSuiteJob(state, MAIN, pid, commit)
  if (answer) return answer.ok ? null : answer.reason
  return `${MB}'s test suite ended without an answer on this commit, so nothing was released yet. The next try runs it again.`
}

/**
 * Run master's suite and return the verdict: null when green, a sentence when not. A green
 * or red answer on `commit` is written to `state.suite`; one that could not run is not.
 */
function masterVerdict(state, commit) {
  // One string + shell, same as the typecheck above: npm on Windows is npm.cmd.
  const runSuite = () => runNpmTest(MAIN)
  /**
   * The verdict, written onto the ledger AS IT IS NOW rather than onto the copy this
   * process read minutes ago.
   *
   * `write()` replaces the whole file, and the suite is the one thing in here that holds a
   * `state` across a span of real time - up to 20 minutes for one run, and twice that since
   * a red answer is confirmed. Another chat marking a lane ready, a claim, a peer ref: all
   * of it lands on disk inside that window and all of it was overwritten by the stale copy.
   * So the suite key is merged into a fresh read; the in-memory `state` is updated too,
   * because the caller goes on to use it.
   */
  const cacheSuite = (verdict) => {
    if (!commit) return
    state.suite = verdict
    const fresh = read()
    fresh.suite = verdict
    write(fresh)
  }
  const pass = (r) => {
    if (r.status !== 0) return false
    cacheSuite({ commit, ok: true, at: now() })
    return true
  }
  let r = runSuite()
  if (pass(r)) return null
  /**
   * A red answer is CONFIRMED before it is written down, because the verdict is cached on
   * the commit and the retry timer never asks again - so one flaky run pins a green tree
   * as broken until somebody hand-edits `.git/paneforge-lanes.json`, which nobody would
   * ever guess to do.
   *
   * Measured 2026-08-22 on the commit below this one: the gate failed twice, once as
   * `could not run` and once as `FAIL conflict / the lane is stuck`, while the same suite
   * passed standalone twice in a row (91 tests, exit 0). The conflict test drives real git
   * repositories and is timing-sensitive on a loaded machine.
   *
   * Only the second run's answer counts, so a genuinely red suite costs one extra pass
   * (~2 min) and a flake costs the release nothing. `cannotRun` is judged on the LAST run
   * for the same reason: missing tooling does not repair itself between two runs, but a
   * spawn that lost a race does.
   */
  const first = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (!cannotRun(first)) {
    r = runSuite()
    if (pass(r)) return null
  }
  const all = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (cannotRun(all)) {
    return (
      `${MB}'s test suite could not run, so nothing was released - ${firstLine(all)}. ` +
      `Required tooling or remote transport is unavailable; this is not a code verdict.`
    )
  }
  // A suite with some other shape than test-all.mjs falls back to its first real line.
  const failed = failLines(all)
  const reason =
    r.signal || (r.status == null && !all.trim())
      ? `${MB}'s test suite did not finish within ${Math.round(SUITE_TIMEOUT_MS / 60000)} minutes, so nothing was released. Run \`npm test\` and see what hangs.`
      : `${MB} fails its own test suite, so it was not released${failed ? ` - ${failed}` : ` - ${firstLine(all)}`}. Fix it and it goes out by itself.`
  cacheSuite({ commit, ok: false, at: now(), reason })
  return reason
}

/** What `suiteFailureInLane` says while another process is testing that same tree. */
const LANE_SUITE_RUNNING = 'already being tested by another check'

/**
 * The same run/retry/classify `suiteFailure` does, aimed at a lane's OWN checkout instead
 * of master, and never touching `state.suite` - that cache is keyed on master's commit and
 * would otherwise hold a verdict about a tree that was never master's.
 *
 * Returns null when green (or the checkout has no suite), a short reason when red, and
 * `LANE_SUITE_RUNNING` while another process is testing the same tree. Never shown to a
 * person on its own - see `readyLaneFix`, which is what asks.
 *
 * Cached on the lane's commit (`state.laneSuite`), like master's verdict and for the same
 * reason: while master is red every try asked every ready lane again, twice each, uncached.
 *
 * `onlyCached`: read a verdict already written and start nothing - an untested tree is
 * `LANE_SUITE_RUNNING` (still to be tested).
 */
function suiteFailureInLane(state, dir, onlyCached = false) {
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
  const script = pkg.scripts?.test
  if (!script || /no test specified/i.test(script)) return null
  const head = gitSafe(dir, 'rev-parse', 'HEAD')
  const commit = head.ok ? head.out : null
  const cached = read().laneSuite?.[dir]
  if (commit && cached?.commit === commit) return cached.ok ? null : cached.reason
  if (suiteRunning(dir, commit)) return LANE_SUITE_RUNNING
  if (onlyCached) return LANE_SUITE_RUNNING
  if (!commit) return runSuiteJob(state, dir, null, 'lane')
  stopStaleSuiteJob(dir, commit)
  // Another tree's suite holds the computer: ask again next try, never cached as red.
  if (lockHeld(SUITE_LOCK, SUITE_LOCK_STALE_MS)) return LANE_SUITE_RUNNING
  const pid = startSuiteJob(state, dir, commit, 'lane')
  if (!pid) return runSuiteJob(state, dir, commit, 'lane')
  if (!suiteWaits()) return LANE_SUITE_RUNNING
  const answer = awaitSuiteJob(state, dir, pid, commit)
  // Ended without an answer: still to be tested, and the next try runs it again.
  if (!answer) return LANE_SUITE_RUNNING
  return answer.ok ? null : answer.reason
}

/** Run a lane's suite and return its reason (null when green), cached on `commit` unless it could not run. */
function laneVerdict(state, dir, commit) {
  let r = runNpmTest(dir)
  let reason = null
  if (r.status !== 0) {
    const first = `${r.stdout ?? ''}${r.stderr ?? ''}`
    if (!cannotRun(first)) r = runNpmTest(dir)
  }
  if (r.status !== 0) {
    const all = `${r.stdout ?? ''}${r.stderr ?? ''}`
    const failed = failLines(all)
    reason = cannotRun(all)
      ? `could not run - ${firstLine(all)}`
      : r.signal || (r.status == null && !all.trim())
        ? `did not finish within ${Math.round(SUITE_TIMEOUT_MS / 60000)} minutes`
        : failed || firstLine(all)
  }
  // Tooling that could not start is fixed outside this file; the next try should find out.
  if (commit && !reason?.startsWith('could not run')) {
    remember(state, ['laneSuite', dir], { commit, ok: !reason, reason, at: now() })
  }
  return reason
}

/**
 * Whether the deadlock the gate would otherwise be is actually a lane already carrying
 * the fix.
 *
 * `suiteFailure` above only ever asks master, and a lane whose whole reason to exist is
 * fixing master's own red suite can never pass that question - master stays red until the
 * merge that only happens once the gate says yes. `ready()` already merges master into a
 * lane before marking it, so a ready lane whose branch contains master's HEAD is the
 * ordinary state a fixing lane sits in, not a special case: try each ready lane's OWN tree,
 * in the order `ship()` would merge them, and if one is green there, that is the answer -
 * `ship()` will merge it and master inherits the fix.
 *
 * Returns the id of the first ready lane whose own suite passes, or null when none does
 * (with `tried` naming whether one was even eligible to ask, so the refusal can say so, and
 * `pending` whether one is still being tested, on the PC or by another check here).
 *
 * On the Mac each lane's tree is one remembered PC job, like master's (`state.pcLaneSuite`).
 * Every job is queued before any is waited on: the PC runs several at once, and a local
 * `npm test` per lane was a 20-minute kill per lane, twice (2026-10-01: one try, 1h45m).
 */
function readyLaneFix(state) {
  const masterHead = gitSafe(MAIN, 'rev-parse', MB)
  if (!masterHead.ok) return { lane: null, tried: false }
  const lanes = Object.keys(state.ready).filter(
    (id) =>
      id !== 'main' &&
      existsSync(laneDir(id)) &&
      gitSafe(MAIN, 'merge-base', '--is-ancestor', masterHead.out, laneBranch(id)).ok
  )
  const tried = lanes.length > 0
  if (!onPc()) {
    let pending = false
    let started = false
    for (const id of lanes) {
      // A tick that does not wait starts at most one run: past the first lane still being
      // tested it only reads verdicts already written, so a lane further down that is
      // already green still ships, and the next tick goes on with the rest.
      const v = suiteFailureInLane(state, laneDir(id), started)
      if (!v) return { lane: id, tried }
      if (v === LANE_SUITE_RUNNING) {
        pending = true
        if (!suiteWaits()) started = true
      }
    }
    return { lane: null, tried, pending }
  }
  const ask = (id, opts) =>
    pcSuite(laneDir(id), read().pcLaneSuite?.[id], (rec) => remember(state, ['pcLaneSuite', id], rec), opts)
  for (const id of lanes) ask(id, { sendOnly: true })
  // A lane whose job has already finished answers before any wait starts. Waiting in merge
  // order kept a green lane behind the one ahead of it: 2026-10-04 lane c's job passed at
  // 2:45pm, the release spent its whole budget on lane b's job still in line, then only
  // queued c, and nothing read c's verdict. A tick's waits below are this same read already.
  if (suiteWaits()) {
    for (const id of lanes) if (!ask(id, { once: true })) return { lane: id, tried }
  }
  // One wait budget for all of them, not one each: five queued lanes were 75 minutes a try.
  // Past it, a lane only reads an answer that is already there and the next try waits on its job.
  const until = now() + PC_WAIT_S * 1000
  let pending = false
  for (const id of lanes) {
    const left = Math.round((until - now()) / 1000)
    const v = ask(id, left > 0 ? { waitS: Math.max(60, left) } : { once: true })
    if (!v) return { lane: id, tried }
    if (v.pending) pending = true
  }
  return { lane: null, tried, pending }
}

/**
 * The release nobody has to ask for. Called at the end of `ready` and of `release`, so
 * the version goes out the moment the last chat with unfinished work finishes it - and
 * silently does nothing while any chat is still mid-edit.
 */
/**
 * A release attempt, with its answer written down where the app can read it.
 *
 * The gate has always known exactly why nothing went out - a lane still being typed in,
 * the two-hour batching window, a red suite - and said so to whichever hook happened to
 * ask. Nothing kept it, so the one surface a person actually looks at drew a finished
 * lane as "done - ships with the next update" for hours with no way to tell a release
 * that is ten minutes away from one that is blocked on a failing test. Robert's report
 * was that sentence read literally: "it says done, and it says releasing, and neither is
 * true".
 *
 * `hold.at` is when this reason STARTED, not when it was last checked - "waiting 40m" has
 * to be the wait itself, or every poll resets the clock and nothing ever looks stuck.
 */
function autoship(kind = 'auto', session = 'auto') {
  const out = autoshipRun(kind, session)
  noteHold(out)
  return out
}

/** Record (or clear) why the work is being held. Never allowed to break the release. */
function noteHold(out) {
  try {
    const state = read()
    const reason = out?.shipped ? null : (out?.reason ?? null)
    // "nothing to release" is the ordinary quiet state, not a hold: there is no finished
    // work waiting, so there is nothing for a person to be told about.
    const keep = reason && !/^nothing to release/i.test(reason) ? reason : null
    if (keep && state.hold?.reason === keep) state.hold.seen = now()
    else state.hold = keep ? { reason: keep, at: now(), seen: now() } : null
    write(state)
  } catch {
    // A ledger this cannot write is a ledger the release itself already survived without.
  }
}

function autoshipRun(kind = 'auto', session = 'auto') {
  // Before `shippable` asks whether anything is unreleased - that question is answered
  // against local tags, and a stale one turns "already released" into "release it again".
  syncTags()
  const state = reap(read())
  if (state.recoveryError) return { shipped: false, reason: state.recoveryError }
  if (RELEASE === 'version' && Object.values(state.recovery?.items ?? {}).some((r) => r.status === 'ready')) {
    return { shipped: false, reason: 'verified recovered work awaits Robert’s release publisher' }
  }
  // A conflict that has quietly stopped being a conflict should not keep work out of
  // this release: try them all again before deciding what is shippable.
  if (retryConflicts(state)) write(state)
  if (state.release) return { shipped: false, reason: 'another chat is mid-release' }
  const busy = releaseHolds(state)
  // Same shape as the sentence below so the sidebar's `holdWords` reads it as "main copy",
  // with the file named, because committing that one file is the whole fix.
  if (busy.length && RELEASE === 'merge') {
    const blockers = mainBlockers(state)
    const files = blockerFiles(blockers)
    const more = files.length > 1 ? ` and ${files.length - 1} more` : ''
    // Said differently once nobody is on it: agents repeat this sentence, and "chats still
    // working" was repeated all day on 7 Oct about a chat that had died at 10:25am.
    const stuck = mainStranded(state, blockers)
    if (stuck) return { shipped: false, reason: strandedReason(stuck) }
    return { shipped: false, reason: `waiting on chats still working: main (uncommitted edits to ${files[0]}${more} that finished work changes)` }
  }
  // Named with the evidence, not just the lane. An agent repeats this reason to a person
  // verbatim, and "waiting on chats still working: main" was read - correctly, from what
  // it says - as "somebody is mid-feature", when the truth was an untouched file and an
  // open window. Saying how long ago the work last moved makes the two distinguishable
  // without anyone opening the ledger.
  if (busy.length) return { shipped: false, reason: `waiting on chats still working: ${busy.map(busyDetail).join(', ')}` }
  if (!shippable(state)) return { shipped: false, reason: 'nothing to release' }
  const since = state.lastShip ? now() - state.lastShip.at : Infinity
  // The hold below is a RELEASE cadence device, and its entire cost model is a build to
  // install, a restart to take it and a version number somebody has to read - the note on
  // COOLDOWN_MS says so in as many words. A repo in `merge` mode cuts none of those:
  // shipping is `git merge && git push`, nobody installs the result, and no update prompt
  // appears anywhere. There is therefore nothing for finished work to wait for COMPANY
  // for, and the wait is pure latency.
  //
  // Measured 2026-08-28 on taskdriver.ai: a verified lane was told "went out 115m ago -
  // it merges and goes out with the next release (about 5m)", and then sat on its lane
  // for another 45 minutes, because on this machine nothing calls autoship on a clock
  // unless a chat is mid-turn (the in-app timer is per open pane; lane-cron.mjs is
  // installed on the PC only). The same shape wedged four ready lanes for 576 minutes
  // eight days earlier. Both times a person had to ask why their work had not landed.
  //
  // Repos that deploy on push already govern cadence at the layer that can see the
  // change - taskdriver's Vercel `ignoreCommand` reads the commit SUBJECT, so `auto-sync:`
  // work batches and a descriptive subject ships. A second, blind, two-hour timer on top
  // of that cannot batch anything it understands; it only ever loses work.
  const window_ = RELEASE === 'version' ? (smallOnly(MAIN) ? SMALL_HOLD_MS : COOLDOWN_MS) : 0
  if (since < window_) {
    const small = smallOnly(MAIN)
    const wait = Math.ceil((window_ - since) / 60000)
    return {
      shipped: false,
      // Says "still on its lane", not "on master": the merge happens inside ship(),
      // which this return skips. An agent told the work is already on master goes
      // looking for it there, does not find it, and starts undoing a release that was
      // only ever waiting on the clock. Cost that exactly once, 2026-07-28.
      reason:
        `v${state.lastShip.version} went out ${Math.round(since / 60000)}m ago. The work is committed and still on its lane; it merges and goes out with the next release (about ${wait}m). Do not ship it separately - run autoship again then.` +
        (small
          ? ' Everything waiting is small (fixes only, under 150 changed lines), so it is waiting for company rather than cutting a version of its own - anything bigger landing here releases the lot at once.'
          : '')
    }
  }
  // Nobody is watching an automatic release, so it checks itself first. A tag that fails
  // to compile costs a broken GitHub build and a version number that never produced an
  // installer - and the next chat inherits both.
  const broken = typecheckFailure(state)
  if (broken) return { shipped: false, reason: broken }
  // ...and then whether it WORKS, which the typecheck never answered. Second because it
  // is ten times the cost and a tree that does not compile cannot pass it anyway.
  const red = suiteFailure(state)
  if (red) {
    // No verdict yet - master's suite is still queued on the PC, already running in another
    // check, or its job never ran (cancelled, timed out, unsent). Testing every finished lane
    // now would only stack more runs. One that ran and died there goes on to the lanes
    // (`SUITE_DIED`).
    if (SUITE_UNSETTLED.test(red) && !SUITE_DIED.test(red)) return { shipped: false, reason: red }
    // The lane that fixes a red master can never merge if the gate only ever asks
    // master, because master stays red until the merge that only happens once the gate
    // says yes - the deadlock this exists for. A ready lane already carries master's
    // HEAD (`ready()` merges it in before marking), so its own tree passing is the fix,
    // not a second bug: let `ship()` merge it and master inherits the fix.
    const fix = readyLaneFix(state)
    if (!fix.lane) {
      return {
        shipped: false,
        reason: fix.pending
          ? `${red} The finished work waiting to ship is still being tested${onPc() ? ' on the PC' : ''}; the next try waits on the same ${onPc() ? 'jobs' : 'runs'}.`
          : fix.tried
            ? `${red} The finished work waiting to ship was tried the same way and it still fails.`
            : red
      }
    }
  }
  try {
    return ship(kind, session, { gated: true })
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
    return { lane: id, note: `${MB} is the release branch - nothing to merge` }
  }
  const ahead = aheadOf(laneBranch(id))
  if (!ahead) throw new Error(`lane ${id} has no commits ${MB} does not already have`)
  state.ready[id] = { at: now(), commit: git(dir, 'rev-parse', 'HEAD'), commits: ahead, session }
  if (state.passed?.[id]) delete state.passed[id]
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
  // A merge left open in the worktree with nothing in the ledger saying so - a chat that
  // ran `git merge` itself and went away, or a record a lost write dropped. It is a
  // conflict all the same, and "not conflicted" left it with no way to be finished
  // (2026-09-28, taskdriver.ai). With no live chat on the lane it is recorded here and
  // adopted like any other; the guard then lets this chat write there.
  if (!state.conflicts[id] && POOL.includes(id) && id !== 'main' && existsSync(laneDir(id))) {
    const holder = state.lanes[id]
    const unowned = !holder || holder.session === session || now() - (holder.seen ?? holder.claimed ?? 0) > ADOPT_MS
    const open = gitSafe(laneDir(id), 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD').ok
    const files = open ? gitSafe(laneDir(id), 'diff', '--name-only', '--diff-filter=U').out.split('\n').filter(Boolean) : []
    if (unowned && files.length) noteConflict(state.conflicts, id, files.join(', '))
    // A live chat's own merge is its to finish; say so rather than "not conflicted".
    else if (files.length) {
      const idle = Math.round((now() - (holder.seen ?? holder.claimed ?? 0)) / 60000)
      throw new Error(
        `lane ${id} has a merge open that its chat, active ${idle}m ago, is still finishing. ` +
          `Adoptable after ${Math.round(ADOPT_MS / 60000)}m of silence.`
      )
    }
  }
  if (!state.conflicts[id]) throw new Error(`lane ${id} is not conflicted`)

  const holder = state.lanes[id]
  const mine = holder?.session === session
  if (!mine && !adoptable(state, id) && state.conflicts[id].resolver !== session) {
    // No holder here means another chat ADOPTED it and is still inside the merge (2026-10-03:
    // lane a, its own chat gone, an adopter 1m in - this line threw "reading 'seen'").
    if (!holder) {
      const idle = Math.round((now() - (state.conflicts[id].resolverAt ?? 0)) / 60000)
      throw new Error(
        `lane ${id} was taken over by another chat (${state.conflicts[id].resolver}) that was active ${idle}m ago - it is fixing it. ` +
          `Ask that chat to hand it over, or it is adoptable after ${Math.round(ADOPT_MS / 60000)}m of silence.`
      )
    }
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
  let nothingOwn = false
  if (open && ownsNothing(dir)) {
    // The lane's own side has nothing master lacks, so the merge only pits a stale copy of
    // master's own work against master: whatever a resolver chose, the best answer is
    // master's, and a stale pick would undo master's later edit once the lane shipped.
    // Put the lane on master instead of handing the merge over (card 2, 2026-09-28: lane
    // c, 165c40d2 patch-identical to main, two add/add files).
    gitSafe(dir, 'merge', '--abort')
    if (gitSafe(dir, ...WORK_STATUS).out || !gitSafe(dir, 'reset', '--hard', '-q', MB).ok)
      throw new Error(`lane ${id} has uncommitted changes in ${dir} - commit or discard them first`)
    nothingOwn = true
  } else if (open) {
    files = gitSafe(dir, 'diff', '--name-only', '--diff-filter=U').out.split('\n').filter(Boolean)
  } else {
    const caught = catchUp(id, { keepConflict: true })
    // Uncommitted work in there is not something to merge on top of, and it means the
    // lane's chat is alive after all.
    if (caught.dirty) throw new Error(`lane ${id} has uncommitted changes in ${dir} - commit or discard them first`)
    files = caught.conflicts
    nothingOwn = Boolean(caught.nothingOwn)
  }

  if (nothingOwn) {
    delete state.conflicts[id]
    write(state)
    return { lane: id, dir, resolved: true, nothingOwn: true, marked: null, release: null }
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
    return { lane: id, dir, resolved: true, marked, release: autoship('auto', session) }
  }

  state.conflicts[id] = {
    ...noteConflict({}, id, files.join(', ') || 'merge open with every file settled, not yet committed', state.conflicts),
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
  //
  // Two marks let this session finish a lane it never claimed. The resolver mark is one,
  // but on its own it is a dead end: `retryConflicts()` re-attempts the merge on every
  // lane command, and the resolving commit is exactly what makes it succeed, so the
  // conflict record - the adopter's only claim - is dropped somewhere in the minutes
  // between the resolution and `ready`. Then `ready --lane b` said this session does not
  // hold lane b while `resolve --lane b` said lane b is not conflicted: the two steps
  // pointed at each other and fifteen finished commits sat out every release for a day.
  // So the second mark is the lane having no chat at all, which is the same authority
  // `retry` already grants itself on a clock. A lane a live chat still holds is untouched.
  if (wanted && wanted !== id) {
    const unheld = !state.lanes[wanted] && existsSync(laneDir(wanted))
    if (state.conflicts[wanted]?.resolver !== session && !unheld) {
      throw new Error(`this session does not hold lane ${wanted} - run resolve --lane ${wanted} first`)
    }
    id = wanted
  }
  if (!id) throw new Error('this session holds no lane')
  let recovery = recoveryFor(state, session, id)
  if (!recovery) {
    closeShippedRecovery(state, session, id)
    recovery = preservedRecovery(state, id)
  }
  if (recovery && (recovery.owner !== session || recovery.status !== 'verified' || recovery.receipt?.commit !== gitSafe(laneDir(id), 'rev-parse', 'HEAD').out)) {
    throw new Error('recovered work requires a current verification receipt and independent review before ready')
  }
  // Declaring work finished is the other way a reservation becomes real.
  if (state.lanes[id]) delete state.lanes[id].tentative
  // The same allowance catchUp makes: a lane dirty with nothing but the files its own
  // hooks write is committed for, not refused.
  if (git(laneDir(id), ...WORK_STATUS)) commitMachineWritten(laneDir(id))
  const dirty = git(laneDir(id), ...WORK_STATUS)
  if (dirty) throw new Error(`commit your changes first:\n${dirty}`)

  // Merge master in HERE, while this chat is still around, rather than letting the release
  // discover the conflict later with nobody left who knows the code. Resolving it now also
  // teaches rerere the answer, so the release's own merge replays it untouched.
  const caught = catchUp(id, { keepConflict: true })
  if (caught.conflicts.length) {
    noteConflict(state.conflicts, id, caught.conflicts.join(', '))
    write(state)
    throw new Error(
      `lane ${id} and ${MB} both changed:\n  ${caught.conflicts.join('\n  ')}\n` +
        `The merge is open in ${laneDir(id)}. Resolve those files, ` +
        `\`git add\` them, \`git commit\`, then run ready again - the release then merges by itself.`
    )
  }
  // A merge that went in cleanly is not proof the two sides still work together, so the
  // lane is checked again on the merged tree before it is called finished.
  if (caught.moved) {
    const red = laneTypecheckFailure(laneDir(id))
    if (red) {
      write(state)
      throw new Error(`lane ${id} took in ${MB}'s latest work and no longer typechecks: ${red}. Fix it, commit, and run ready again.`)
    }
  }

  const marked = markReady(state, id)
  if (recovery) {
    recovery.status = 'ready'; recovery.readyCommit = state.ready[id].commit
    writeRecovery(state)
  }
  delete state.conflicts[id]
  write(state)
  // `ready` is the end of this lane's work, so the test copy it opened has nothing left
  // to test. Waiting for the chat to END to close it (releaseClaim) left a minimized
  // "PaneForge - dev-b" sitting in Alt+Tab for as long as the chat stayed open - which,
  // when the release is blocked on another lane, is hours. Close it at the moment the
  // work is declared done instead.
  closeLaneApps(laneDir(id))
  // Last one out cuts the release. If another chat is still mid-edit this is a no-op
  // and THEIR `ready` (or the end of their session) will cut it instead.
  return { ...marked, renamed: caught.renamed ?? [], release: autoship('auto', session) }
}

/**
 * `gone` is the APP's word, never a chat's own hook: no running copy of PaneForge hosts the
 * pane this chat was in, so a hold marked asleep has no pane left to wake it. Without it
 * a sleeping hold is parked, not dropped (see below); with it the hold ends like any other
 * chat's. Measured 2026-09-09: 26 of 41 holds on this machine were asleep and owned by
 * chats no window had, immune to every sweep for ASLEEP_MAX_MS - the strip read
 * `Other copies (21)` for three days over checkouts nobody was in.
 *
 * `cleared` is the chat's own SessionEnd for `/clear` (lane-hook passes it for reason
 * "clear"): the same pane goes on with a new session id, so its unfinished lane is kept for
 * that next chat to carry (claim) instead of being given up - see below.
 */
function releaseClaim(session, { gone = false, cleared = false } = {}) {
  const state = reap(read())
  // The chat is going. Whatever this device told the other one on its behalf stops being
  // true now rather than in PEER_STALE_MS - otherwise the desk that ends its day first
  // holds the trunk against the other one for the next 45 minutes.
  dropPublished(state, session)
  // Outside the loop below on purpose: adopting somebody else's conflict does not give a
  // chat a lane, so a chat can be holding a claim and no lane at all. Ending gives back
  // both.
  dropClaims(state, session)
  let freed = null
  let marked = null
  for (const [id, c] of Object.entries(state.lanes)) {
    if (c.session === session) {
      // The chat's agent was stopped on purpose (sleep), not ended - the lane is still
      // its own and may hold half a feature. Park it exactly as the Stop hook would:
      // no markReady, no catchUp, nothing merged out from under a pane that is resting.
      // It expires like any other stale hold once ASLEEP_MAX_MS passes (see `reap`) - or
      // now, when the app says the pane it was kept for is in no window (`gone`).
      if (c.asleep && !gone) {
        c.parked = now()
        continue
      }
      // A chat that ends with committed, clean work meant that work to go out - it just
      // never said so. Uncommitted work is the opposite: nobody released half an edit.
      const w = laneWork(id)
      const own = recoveryFor(state, session, id)
      // A recovery owner's /clear: SessionEnd stamped the hold ended, and this detached
      // release often beats the pane's next claim. Dropped, the hold leaves the item on a
      // dead session with no lane to finish it from; kept, the next chat in the same pane
      // carries both (claim, carryRecovery). A pane nobody types in again is swept by the
      // app's `--gone` release, or STALE_MS. Its test copy still closes with the chat.
      if (c.ended && c.pane && !gone && Object.values(state.recovery?.items ?? {}).some((r) => r.owner === session && carryableRecovery(r, id))) {
        closeLaneApps(laneDir(id))
        continue
      }
      // Any chat's /clear, recovery item or not (2026-10-04, PaneForge on the Mac): the pane
      // held lane a with a pushed commit and six uncommitted files, this release beat the
      // pane's next prompt and deleted the hold, and the new chat - nothing left to carry -
      // was sent to lane b while lane a sat unheld and dirty, every write to it refused.
      // Unfinished is uncommitted work, or commits not yet marked ready (`main`: uncommitted
      // only - its commits are not a lane's to finish). An empty or ready lane, a hold no
      // pane wore, and a pane the app says is gone are given up exactly as before; claim
      // carries a kept hold only to the SAME pane, so nobody else can take it.
      // On `--gone` markReady is skipped on purpose: marking clean-ahead work ready at /clear is the recorded bug (memory bug_clear_mid_recovery_marks_lane_ready_2026-10-02); unready orphan work belongs to the completion dispatcher.
      if (cleared && c.pane && !gone && (w.dirty || (id !== 'main' && w.ahead > 0 && !state.ready[id]))) {
        c.ended ??= now()
        closeLaneApps(laneDir(id))
        continue
      }
      if (!gone && !own) closeShippedRecovery(state, session, id)
      if (!gone && !own && !preservedRecovery(state, id) && !state.ready[id] && !w.dirty && w.ahead > 0) {
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
      // Who walked away from uncommitted files in the main folder, so the card about them
      // (strandedCard) can still name the chat after its hold is gone.
      if (id === 'main') {
        if (w.dirty) state.mainLeft = { session, at: now() }
        else delete state.mainLeft
      }
      // The test copy this chat opened belongs to the chat, not to the next one that
      // claims the lane - and `--minimized` means nobody sees it to close it by hand.
      closeLaneApps(laneDir(id))
      freed = id
    }
  }
  // This chat's own release still running (see releaseRunning): it finishes the job, and a
  // second one started beside it is what raced it.
  if (releaseRunning(state, session)) {
    write(state)
    return { freed, marked, release: { shipped: false, reason: 'this chat’s release is still running' } }
  }
  if (state.release?.session === session) state.release = null
  write(state)
  return { freed, marked, release: autoship('auto', session) }
}

/**
 * The app, before it kills a pane's agent: mark every hold that pane has in this repo
 * asleep, so `releaseClaim` parks it instead of giving it away and the idle sweeps leave
 * it alone (see `holdGivenUp`, `reap`).
 *
 * Matched by SESSION when the caller has one (a chat typing `sleep` itself); by PANE
 * otherwise, because the app only ever knows the pane id (`PF_PANE`) at the moment it is
 * about to end the process - the CLI's own session id belongs to the hook, not to it.
 */
function sleepLane(session, pane) {
  if (!session && !pane) throw new Error('sleep needs --session or --pane')
  const state = reap(read())
  const asleep = []
  for (const [id, c] of Object.entries(state.lanes)) {
    if (session ? c.session !== session : c.pane !== pane) continue
    c.asleep = now()
    asleep.push(id)
  }
  write(state)
  return { asleep }
}

/**
 * The app, once a sleeping pane's agent is spawned again: clear the mark so the hold reads
 * exactly as an ordinary one again - `claim` (the CLI's own hook, next) then behaves as it
 * always has, because by the time it runs `asleep` is already gone.
 */
function wakeLane(session, pane) {
  if (!session && !pane) throw new Error('wake needs --session or --pane')
  const state = reap(read())
  const woken = []
  for (const [id, c] of Object.entries(state.lanes)) {
    if (session ? c.session !== session : c.pane !== pane) continue
    if (!c.asleep) continue
    delete c.asleep
    c.seen = now()
    woken.push(id)
  }
  write(state)
  return { woken }
}

/**
 * Say the release still exists.
 *
 * LOCK_MS decides how long a release may go quiet before the next command assumes it
 * crashed and clears the lock - and a release that is still running when that happens is
 * the worst case this file has, because the chat that clears it goes on to cut a second
 * version on top of the first. Twenty minutes was picked when GitHub Actions built the
 * installers and `ship` was over in one; the account's Actions are disabled, so this
 * machine now runs electron-vite and electron-builder itself and uploads the artifacts,
 * which is comfortably longer than the lock. Rather than guess a bigger number - the build
 * gets slower every time the app grows - the release says it is alive as it goes, and the
 * lock keeps meaning what it says: nothing has happened here for twenty minutes.
 */
function beatRelease(session) {
  try {
    const s = read()
    if (s.release?.session !== (session ?? 'unknown')) return
    s.release.at = now()
    write(s)
  } catch {
    /* a heartbeat that cannot be written must never take the release down with it */
  }
}

/**
 * What in the main checkout stops a release from merging into it.
 *
 * A MODIFIED tracked file always does: the merge would land on top of somebody's edit.
 * An UNTRACKED file does not - git merges around it - unless a ready lane brings a file
 * of the same path, which is the one case git itself refuses ("would be overwritten").
 *
 * Every untracked file used to count. Measured 2026-09-09: assistant's main held two
 * `.claude/agent-memory/...` notes an agent had left, clients' main a `clients/simon-hubspot/`
 * folder, neither touched by any lane - and every finished lane in both repos sat unmerged
 * behind `main checkout is dirty, commit first` for a day, while the strip drew both mains
 * as dirty copies nobody could clear from a chat.
 *
 * In `merge` mode an UNSTAGED edit to a tracked file is the same case as an untracked one.
 * git merges around it and refuses only when the merge touches that file, and `merge
 * --abort` loses an edit only in a file the merge touched - so a file no ready lane brings
 * is safe. A STAGED change still blocks (git will not merge over an index that differs
 * from HEAD), and `version` mode keeps the whole rule because it commits package.json on
 * top of this folder. Measured 2026-09-23: taskdriver.ai's main held one chat's
 * unrelated x-agent work, and eight finished lanes had waited 43-113 minutes behind it.
 */
function mainBlockers(state) {
  return mainDirt(state).blockers
}

const blockerFiles = (blockers) => blockers.split('\n').filter(Boolean).map((l) => l.replace(/ \(.*\)$/, ''))

/**
 * A main-folder blocker nobody is going to clear, or null.
 *
 * Measured 7 Oct 2026 in clients: a Codex chat holding `main` left an untracked
 * write-ledger.jsonl there and died at 10:25am; a finished lane brought the same path, and
 * every release from 11:57am to 8:10pm was held behind it as "waiting on chats still
 * working", four finished lanes deep, with nothing ever telling a person. Across every repo
 * on the Mac that week, main-folder holds lasted a median 82 minutes and a p90 of 630, and
 * none of them raised anything.
 *
 * Stranded is read off the files first, like HOLD_BUSY_MS: untouched for STRANDED_QUIET_MS
 * and nobody holds the folder any more (its chat's app released the hold - Next's lane clock
 * and old PaneForge's sweep do that for a closed chat - or SessionEnd stamped it ended), or
 * untouched for HOLD_BUSY_MS whoever holds it. A chat still holding the folder is never
 * called gone from here: a Next chat is in no inventory this engine can read, so a live one
 * would read as dead. A file whose age cannot be read is never stranded: the failure that
 * matters is calling somebody's open edit abandoned. Reads only; nothing here touches the files.
 */
function mainStranded(state, blockers = mainBlockers(state)) {
  if (RELEASE !== 'merge' || !blockers) return null
  const files = blockerFiles(blockers)
  let touched = 0
  for (const f of files) {
    try {
      touched = Math.max(touched, lstatSync(join(MAIN, f)).mtimeMs)
    } catch {
      /* deleted, or a name this platform cannot spell */
    }
  }
  if (!touched) return null
  const quiet = now() - touched
  if (quiet < STRANDED_QUIET_MS) return null
  const hold = state.lanes.main
  // The chat that released the folder with these files in it, unless somebody wrote them since.
  const left = !hold?.session && state.mainLeft?.at >= touched ? state.mainLeft : null
  const session = hold?.session ?? left?.session ?? null
  const gone = !hold?.session || Boolean(hold.ended)
  if (!gone && quiet < HOLD_BUSY_MS) return null
  const waiting = Object.keys(state.ready).filter((id) => id !== 'main').sort()
  return { files, session, gone, waiting }
}

function strandedWho(s) {
  if (!s.session) return 'no chat holds the main folder'
  if (s.gone) return `the chat that left them (${s.session.slice(0, 8)}) has ended`
  return `the chat holding the main folder (${s.session.slice(0, 8)}) has not touched them for over an hour`
}

function strandedReason(s) {
  const more = s.files.length > 1 ? ` and ${s.files.length - 1} more` : ''
  return (
    `nobody is working on it - uncommitted edits to ${s.files[0]}${more} in the main folder that finished work changes, and ${strandedWho(s)}. ` +
    `Nothing is lost while it waits; the lane clock puts one card in front of a person to commit them.`
  )
}

/** The GuardDeck card id for this repo's stranded main folder: one per repo, replaced, then cleared. */
const strandedCardId = () => `lane-main-${basename(MAIN).replace(/[^A-Za-z0-9._-]/g, '-')}`.slice(0, 64)

/**
 * Put ONE waiting card in front of a person for a stranded main folder, and take it down
 * once the folder no longer blocks anything.
 *
 * Not a recovery: the stranded bytes are somebody's half-done work in a folder every chat
 * shares, and on 7 Oct they were a client write ledger whose rows said which writes had
 * already happened. Moving them anywhere a chat stops seeing them risks the writes being
 * made twice; committing them as finished is the choice nobody made. So the bytes stay
 * exactly where they are and a person gets the file, the holder and the waiting lanes, with
 * the one line to paste. Raised once per blocker (files + holder), from the lane clock
 * only (`retry`), never from a chat's own `ready`. LANE_DISPATCH_LOG stands in for GuardDeck
 * in tests, as in clashCards; a card that could not be posted is tried again next tick.
 */
function strandedCard(state) {
  const log = process.env.LANE_DISPATCH_LOG
  const tool = [
    join(homedir(), 'Projects', 'claude-memory', 'claude-config', 'waiting-card.mjs'),
    ...(process.platform === 'win32' ? [join(homedir(), 'Desktop', 'Projects', 'claude-memory', 'claude-config', 'waiting-card.mjs')] : [])
  ].find((p) => existsSync(p))
  if (!log && (!tool || inTempFolder(MAIN))) return null
  const send = (args, line) => {
    if (log) {
      appendFileSync(log, JSON.stringify(line) + '\n')
      return 'logged'
    }
    const r = spawnSync(process.execPath, [tool, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    return r.status === 0 ? 'GuardDeck' : null
  }
  const id = strandedCardId()
  const blockers = RELEASE === 'merge' ? mainBlockers(state) : ''
  const was = state.stranded
  if (!blockers) {
    if (!was) return null
    if (was.card && !send(['--clear', '--id', id], { id, clear: true })) return null
    // Posting takes up to 30 s, and a chat's claim or release written meanwhile must survive.
    const fresh = read()
    delete fresh.stranded
    write(fresh)
    return was.card ? 'The main folder no longer holds the release - took its card down.' : null
  }
  const stuck = mainStranded(state, blockers)
  if (!stuck) return null
  const key = JSON.stringify([stuck.files, stuck.session])
  if (was?.key === key && was.card) return null
  const repo = basename(MAIN)
  const names = stuck.files.join(', ')
  const lanes = stuck.waiting.length ? `finished lane${stuck.waiting.length === 1 ? '' : 's'} ${stuck.waiting.join(', ')}` : 'finished work'
  const title = `Finished work in ${repo} waits on a file nobody is working on`
  const detail =
    `${MAIN} has uncommitted ${names}, and ${lanes} change${stuck.waiting.length === 1 ? 's' : ''} it, so nothing merges. ` +
    `${strandedWho(stuck)[0].toUpperCase()}${strandedWho(stuck).slice(1)}. Nothing is lost. ` +
    `Paste into a chat in ${repo}: commit ${names} in ${MAIN} as it is (keep both sides if a lane changes it), then run lane.mjs retry --repo ${MAIN}`
  const via = send(['--id', id, '--title', title, '--detail', detail, '--not-browser'], { id, card: true, title, detail })
  if (!via) return null
  const fresh = read()
  fresh.stranded = { key, since: was?.since ?? now(), card: { at: now(), via } }
  write(fresh)
  return `The main folder holds the release with ${names} and nobody is on it - raised one card for a person (${via}).`
}

/**
 * What in the main folder would stop a merge, and what only looks as if it would.
 *
 * `same` is an uncommitted file whose working-tree bytes are exactly what a ready lane
 * brings (`git hash-object` of it === the lane's blob for it). That is not somebody's
 * unsaved work - the bytes are already on the lane's branch - and counting it held every
 * merge (2026-09-28, taskdriver.ai: a package.json edit the lane itself had committed).
 * `ship` puts those files back just before merging (`restoreSame`). Anything whose bytes
 * differ, even by one, is still a blocker; a staged one only counts when the index agrees too.
 */
function mainDirt(state) {
  const porcelain = git(MAIN, ...WORK_STATUS)
  if (!porcelain) return { blockers: '', same: [] }
  // Asked by name, not read off the porcelain columns: `git()` trims, so the first line's
  // leading space (the "unstaged" column) is gone and ` M app.js` reads as staged `M app.js`.
  const names = (...args) => git(MAIN, ...args).split('\n').filter(Boolean)
  const staged = names('diff', '--cached', '--name-only')
  const dirty = new Set([...staged, ...names('diff', '--name-only'), ...names('ls-files', '--others', '--exclude-standard')])
  const brings = new Map()
  for (const id of Object.keys(state.ready)) {
    if (id === 'main') continue
    const r = gitSafe(MAIN, 'diff', '--name-only', `${MB}...${laneBranch(id)}`)
    if (!r.ok) continue
    for (const f of r.out.split('\n')) if (f) brings.set(f, [...(brings.get(f) ?? []), id])
  }
  const same = []
  for (const f of dirty) {
    if (!brings.has(f)) continue
    const here = gitSafe(MAIN, 'hash-object', '--', f)
    if (!here.ok || !here.out) continue
    if (staged.includes(f) && gitSafe(MAIN, 'rev-parse', `:${f}`).out !== here.out) continue
    if (brings.get(f).some((id) => gitSafe(MAIN, 'rev-parse', '--verify', '--quiet', `${laneBranch(id)}:${f}`).out === here.out))
      same.push({ file: f, blob: here.out })
  }
  const isSame = (f) => same.some((x) => x.file === f)
  const tracked = porcelain.split('\n').filter((l) => l && !l.startsWith('??'))
  if (RELEASE !== 'merge') {
    const left = tracked.filter((l) => !isSame(l.trim().replace(/^\S+\s+/, '').split(' -> ').pop()))
    if (left.length) return { blockers: left.join('\n'), same }
  }
  const stagedLeft = staged.filter((f) => !isSame(f))
  if (stagedLeft.length) return { blockers: stagedLeft.map((f) => `${f} (staged)`).join('\n'), same }
  const blocked = []
  for (const [f, ids] of brings) if (dirty.has(f) && !isSame(f)) blocked.push(`${f} (lane ${ids[0]} brings this file)`)
  return { blockers: blocked.join('\n'), same }
}

/** Put back the files `mainDirt` found identical to a ready lane's, so its merge applies.
 * Re-hashed first: a file edited since it was read is left alone for the merge to refuse. */
function restoreSame(same) {
  for (const { file, blob } of same) {
    if (gitSafe(MAIN, 'hash-object', '--', file).out !== blob) continue
    if (gitSafe(MAIN, 'cat-file', '-e', `HEAD:${file}`).ok) gitSafe(MAIN, 'checkout', 'HEAD', '--', file)
    else {
      gitSafe(MAIN, 'rm', '--cached', '-q', '--ignore-unmatch', '--', file)
      try {
        unlinkSync(join(MAIN, file))
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Land one ready lane on the trunk without the main folder ever holding a half-done merge.
 *
 * `git merge` in the main folder is not safe there. Other chats and hooks edit that folder's
 * tracked files while a release runs, and when a merge fails git saves the folder's edits
 * away, resets every file, and puts the edits back - and if anything writes in between,
 * the putting back fails and the edits exist only in a commit nothing points at. Measured
 * 2026-10-04 11:59am on claude-memory's main folder (a plain `git merge`, hooks writing
 * its ledger): "Index was not unstashed. / Merge with strategy ort failed", 21 files of
 * other chats' work gone into dangling commit 09deeb523. `merge.ff=only` there does not
 * reach this path: `--no-ff` on the command line overrides it.
 *
 * So the merge commit is built where no file of the main folder is involved, and the main
 * folder only ever fast-forwards to it - which git refuses, touching nothing, when an edit
 * there is in a file the lane brings. A clean merge is `merge-tree` + `commit-tree`, objects
 * only. One with conflicts gets today's real merge (rerere, merge drivers, `autoResolve`) in
 * a scratch folder that holds just the files the merge writes.
 *
 * { landed: true } | { conflict: '<files>' } | { busy: '<why>' } - busy keeps the ready
 * mark and goes with the next release, like git being busy always has.
 */
function landLane(id, branch) {
  return landBranch(branch, `merge lane ${id}`)
}

/** What landLane does for a lane, for any branch or ref and any merge message. */
function landBranch(branch, message) {
  const head = gitSafe(MAIN, 'rev-parse', '--verify', 'HEAD')
  const tip = gitSafe(MAIN, 'rev-parse', '--verify', `${branch}^{commit}`)
  if (!head.ok || !tip.ok) return { busy: (head.ok ? tip : head).out }
  let made
  try {
    const tree = git(MAIN, 'merge-tree', '--write-tree', head.out, tip.out).split('\n')[0]
    const c = gitSafe(MAIN, 'commit-tree', tree, '-p', head.out, '-p', tip.out, '-m', message)
    if (!c.ok) return { busy: c.out }
    made = c.out
  } catch (e) {
    // A merge-tree that never answered (killed at its deadline on a saturated machine) says
    // nothing about the branches, and the heavier merge below would only die the same way.
    if (died(e)) return { busy: `git did not finish the merge: ${firstLine(errText(e))}` }
    // Exit 1 is a conflict; anything else is a git without `merge-tree --write-tree` (older
    // than 2.38). Either way the real merge decides, off to the side.
    const r = scratchMerge(head.out, tip.out, message)
    if (!r.commit) return r
    made = r.commit
  }
  // --no-autostash: a configured merge.autoStash would bring back the save-reset-restore.
  const ff = gitSafe(MAIN, 'merge', '--ff-only', '--no-autostash', '-q', made)
  if (ff.ok) return { landed: true }
  // Git names the files on the line after its sentence; both lines are the reason.
  const said = ff.out.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' ')
  return { busy: `${MB} was not moved onto it: ${said.slice(0, 240)}` }
}

/**
 * The real merge of `tip` into `head`, in a throwaway folder with no files checked out: git
 * writes only the files the merge touches, so a 10,000-file repo costs what the conflict
 * costs. Returns { commit } | { conflict } | { busy }.
 */
function scratchMerge(head, tip, message) {
  const holder = mkdtempSync(join(tmpdir(), 'pfm-'))
  const dir = join(holder, 'w')
  try {
    const add = gitSafe(MAIN, 'worktree', 'add', '-q', '--no-checkout', '--detach', dir, head)
    if (!add.ok) return { busy: firstLine(add.out) }
    const index = gitSafe(dir, 'read-tree', 'HEAD')
    if (!index.ok) return { busy: firstLine(index.out) }
    const m = gitSafe(dir, '-c', 'core.longpaths=true', 'merge', '--no-ff', '--no-autostash', '-m', message, tip)
    if (!m.ok && (m.locked || m.died)) return { busy: firstLine(m.out) }
    if (!m.ok) {
      // Only files git left unmerged are a conflict. A merge that stopped with none - git
      // refusing, or killed part way under load - is "not now": recorded as a conflict it
      // kept a fast-forward lane out of releases with an empty detail (clients, 2026-10-09).
      const unmerged = gitSafe(dir, 'diff', '--name-only', '--diff-filter=U')
      const open = unmerged.out.split('\n').filter(Boolean)
      if (!unmerged.ok || !open.length) return { busy: `git stopped the merge with no file in disagreement: ${firstLine(m.out)}` }
      // Same union rule as the lane side, for the release side of the same collision:
      // two lanes that each added an import cannot both have merged cleanly, and the
      // second one to arrive here is not a decision anybody needs to make.
      const fixed = autoResolve(dir, open)
      for (const f of fixed) gitSafe(dir, 'add', '--', f)
      const left = gitSafe(dir, 'diff', '--name-only', '--diff-filter=U').out.split('\n').filter(Boolean)
      const stuck = !fixed.length || left.length || !gitSafe(dir, 'commit', '--no-edit').ok
      if (stuck) return { conflict: mergeFiles(m.out, left.length ? left : open) }
    }
    const made = gitSafe(dir, 'rev-parse', 'HEAD')
    return made.ok ? { commit: made.out } : { busy: firstLine(made.out) }
  } finally {
    gitSafe(MAIN, 'worktree', 'remove', '--force', dir)
    rmSync(holder, { recursive: true, force: true })
    gitSafe(MAIN, 'worktree', 'prune')
  }
}

/**
 * Does a push of the trunk need a passing suite on the tree it pushes? Only PaneForge's own
 * repo with a real test script: the same rule `suiteFailure` holds a release to. The
 * Taskdriver PC has its own proof, and a repo with no suite is not held to one.
 */
function pushGateApplies() {
  if (!OWN || TASKDRIVER_PC) return false
  try {
    const script = JSON.parse(readFileSync(join(MAIN, 'package.json'), 'utf8')).scripts?.test
    return !!script && !/no test specified/i.test(script)
  } catch {
    return false
  }
}

/**
 * What the ledger knows about a tree's test suite: `{ ok: true }`, `{ ok: false, reason }`,
 * or null when nothing ever ran it. Every record kind that names a tree or a commit counts,
 * because a verdict on a tree is a verdict wherever it was earned. Green wins over red: a red
 * is confirmed twice before it is written, and a later green run of the same tree is newer.
 */
function treeVerdict(state, tree) {
  const records = []
  const add = (r) => {
    if (r && typeof r === 'object' && 'ok' in r) records.push(r)
  }
  const onTree = (r) => {
    if (r?.tree === tree) add(r)
  }
  const onCommit = (r) => {
    if (!r || !('ok' in r) || !r.commit) return
    const t = gitSafe(MAIN, 'rev-parse', `${r.commit}^{tree}`)
    if (t.ok && t.out === tree) add(r)
  }
  onTree(state.pushSuite)
  onTree(state.pcSuite)
  for (const r of Object.values(state.pcLaneSuite ?? {})) onTree(r)
  onCommit(state.suite)
  for (const r of Object.values(state.laneSuite ?? {})) onCommit(r)
  if (state.pushOk?.tree === tree) return { ok: true }
  if (records.some((r) => r.ok)) return { ok: true }
  const red = records.find((r) => !r.ok)
  return red ? { ok: false, reason: red.reason ?? 'its suite failed' } : null
}

/** One word for a person about a sha. */
const sha8 = (sha) => String(sha).slice(0, 8)

/**
 * The refusal sentence for a trunk push at `sha`, or null when its tree has a green suite.
 * `verdict` is `treeVerdict`'s answer.
 */
function pushRefusal(sha, verdict) {
  // Master's own copy, by absolute path: a lane folder's copy can be older and lack this gate.
  const tool = `node ${join(MAIN, 'scripts', 'lane.mjs')}`
  const ready = `${tool} ready --repo ${MAIN} --session <your session id>`
  const autoship = `${tool} autoship --repo ${MAIN} --session <your session id>`
  if (verdict?.ok) return null
  if (verdict)
    return `PaneForge refused this push: ${MB} at ${sha8(sha)} fails its own test suite - ${verdict.reason}. Fix it on your lane and run \`${ready}\`.`
  return `PaneForge refused this push: nothing has run the test suite on ${MB} at ${sha8(sha)}, and an untested ${MB} blocks every finished lane. Commit on your lane and run \`${ready}\`, which tests the exact tree it pushes; if ${MB} already holds the merged work (an older copy merged it and its push was refused), run \`${autoship}\` instead, which re-tests ${MB} as it stands and pushes it.`
}

/**
 * The git pre-push hook's judge (`lane.mjs prepush`, stdin is git's own list of refs about to
 * move). Exits the process: 0 lets git push, 1 stops it with one sentence on stderr.
 */
function prepush() {
  let input = ''
  try {
    input = readFileSync(0, 'utf8')
  } catch {
    input = ''
  }
  if (!pushGateApplies()) process.exit(0)
  const zero = /^0+$/
  for (const line of input.split('\n')) {
    const [, sha, remoteRef] = line.trim().split(/\s+/)
    if (remoteRef !== `refs/heads/${MB}` || !sha || zero.test(sha)) continue
    const tree = gitSafe(MAIN, 'rev-parse', `${sha}^{tree}`)
    const verdict = tree.ok ? treeVerdict(read(), tree.out) : null
    const refusal = pushRefusal(sha, verdict)
    if (refusal) {
      console.error(refusal)
      process.exit(1)
    }
  }
  process.exit(0)
}

const PUSH_GATE_MARK = 'paneforge-push-gate'

/** Where git looks for the pre-push hook of this repo (shared by every worktree), or null. */
function prePushPath() {
  const p = gitSafe(MAIN, 'rev-parse', '--git-path', 'hooks/pre-push')
  return p.ok && p.out ? resolve(MAIN, p.out) : null
}

/**
 * The hook itself. `runtime` is what ran the install: the app runs this file as
 * `ELECTRON_RUN_AS_NODE=1 <PaneForge>`, and a `git push` it spawns may have no `node` on
 * PATH, so the hook falls back to that same runtime rather than refusing every push.
 */
function pushGateBody(engine, runtime) {
  return `#!/bin/sh
# ${PUSH_GATE_MARK}: written by PaneForge's scripts/lane.mjs. A push of the trunk needs a
# passing test-suite verdict for that exact tree (docs/agents/lanes-and-releases.md).
top=$(git rev-parse --show-toplevel)
for e in '${engine}' "$top/scripts/lane.mjs"; do
  if [ -f "$e" ] && grep -q prepush "$e"; then
    if command -v node >/dev/null 2>&1; then exec node "$e" prepush --repo "$top" "$@"; fi
    if [ -x '${runtime}' ]; then ELECTRON_RUN_AS_NODE=1 exec '${runtime}' "$e" prepush --repo "$top" "$@"; fi
  fi
done
echo "PaneForge refused this push: it could not run the check in scripts/lane.mjs (no copy of it, or no Node to run it with)." >&2
exit 1
`
}

/** `ours`, `foreign`, or `missing` for the pre-push hook file. */
function prePushState(path) {
  if (!existsSync(path)) return { kind: 'missing' }
  let body = ''
  try {
    body = readFileSync(path, 'utf8')
  } catch {
    return { kind: 'foreign' }
  }
  if (!body.includes(PUSH_GATE_MARK)) return { kind: 'foreign' }
  const engine = /^for e in '([^']*)'/m.exec(body)?.[1]
  // A hook from before the runtime fallback has no `-x` line: it counts as out of date.
  const runtime = /^\s*if \[ -x '([^']*)' \]/m.exec(body)?.[1]
  return { kind: 'ours', engine, runtime }
}

/**
 * Put the pre-push hook in place so a plain `git push` of the trunk from anywhere (a chat in
 * the main folder, Codex, a terminal) meets the same rule `ship` holds itself to. A hook that
 * is not ours is never touched, and ours is only rewritten when the copy of this file it
 * names is gone - two checkouts must not take turns rewriting it.
 */
function installPushGate() {
  if (!pushGateApplies()) return
  const path = prePushPath()
  if (!path) return
  const st = prePushState(path)
  if (st.kind === 'foreign') return
  if (st.kind === 'ours' && st.engine && st.runtime && existsSync(st.runtime)) {
    try {
      if (existsSync(st.engine) && readFileSync(st.engine, 'utf8').includes('prepush')) return
    } catch {
      /* rewrite below */
    }
  }
  const engine = fileURLToPath(import.meta.url).replace(/\\/g, '/')
  const runtime = process.execPath.replace(/\\/g, '/')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, pushGateBody(engine, runtime), { encoding: 'utf8', mode: 0o755 })
  try {
    chmodSync(path, 0o755)
  } catch {
    /* Windows has no mode bits; Git for Windows runs the hook anyway */
  }
}

/**
 * Put the trunk back where it stood before this release merged anything, keeping every edit
 * other chats and hooks have in the main folder: `--keep` moves only the files the merges
 * brought and refuses, changing nothing, when one of those has an edit of its own. `--hard`
 * here wiped every uncommitted edit in the folder. Only while HEAD is still the last merge this
 * release made: a commit somebody made in the folder since is not this release's to drop.
 * `merged` lanes get back the ready marks they went in with (`marks`): while this release
 * waited on its checks, any other chat's lane command saw their commits on the trunk and
 * dropped the marks (`reap`), so once the trunk is put back nothing said their finished work
 * still had to go out (PaneForge lane a, 7 Oct 2026 8:36-8:51pm). null, or why it could not.
 */
function undoMerges(to, landed, merged, marks) {
  const head = gitSafe(MAIN, 'rev-parse', 'HEAD').out
  if (head !== landed)
    return `${MB} is left on the merge, unpushed, because a commit was made in its folder after it (${head.slice(0, 8)}) and putting ${MB} back would drop it`
  const r = gitSafe(MAIN, 'reset', '--keep', '-q', to)
  if (!r.ok) return `${MB} is left on the merge, unpushed, because putting it back would have overwritten an unsaved edit in its folder: ${firstLine(r.out)}`
  const fresh = read()
  for (const { lane } of merged) {
    if (fresh.ready[lane] || !marks[lane]) continue
    fresh.ready[lane] = marks[lane]
    if (fresh.passed) delete fresh.passed[lane]
  }
  write(fresh)
  return null
}


/**
 * Why the merged tree about to be pushed may not go: null when its suite is green (or
 * unknown to be needed), a sentence when red, not run, or still waiting its turn on the PC.
 * Nothing has been pushed whichever it says.
 */
function pushedTreeFailure(state) {
  const head = gitSafe(MAIN, 'rev-parse', 'HEAD^{tree}')
  if (!head.ok) return `${MB}'s merged tree could not be read, so nothing was pushed.`
  const tree = head.out
  const redSentence = (reason) =>
    `${MB} fails its own test suite with the finished work merged in, so nothing was pushed - ${reason}. Fix it and it goes out by itself.`
  const known = treeVerdict(read(), tree)
  if (known) return known.ok ? null : redSentence(known.reason)
  if (onPc()) {
    const v = pcSuite(MAIN, read().pushSuite, (rec) => remember(state, ['pushSuite'], rec))
    if (!v) return null
    if (v.pending) return pcWaiting('test suite', v.pending)
    if (v.cannot)
      return `${MB}'s test suite could not ${v.cannot} the PC, so nothing was pushed - ${v.why}. That is the remote runner, not the code.`
    return redSentence(v.red)
  }
  const commit = gitSafe(MAIN, 'rev-parse', 'HEAD')
  const reason = laneVerdict(state, MAIN, commit.ok ? commit.out : null)
  if (!reason) return null
  if (reason.startsWith('could not run'))
    return `${MB}'s test suite could not run with the finished work merged in, so nothing was pushed - ${reason}. That is not a code verdict.`
  return redSentence(reason)
}

/** Record that a person (or a version release) chose to push this exact tree without its suite. */
function recordPushOk(state, why) {
  const t = gitSafe(MAIN, 'rev-parse', 'HEAD^{tree}')
  if (t.ok) remember(state, ['pushOk'], { tree: t.out, at: now(), why })
}

function ship(kind, session, { gated = false } = {}) {
  if (!['auto', 'patch', 'minor', 'major'].includes(kind)) throw new Error(`unknown bump "${kind}"`)
  // Version mode creates another commit after the exact-tree proof. Taskdriver's
  // merge workflow must not push that newly changed, unverified tree.
  if (TASKDRIVER_PC && RELEASE === 'version')
    throw new Error('Taskdriver PC verification requires merge mode; version mode changes the verified tree')
  // `ship` is also reachable without going through autoship (`npm run ship`, `ship major`),
  // and it reads the same local tags to pick the bump. Same fetch, same reason.
  syncTags()
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
  // The same question the line above asks, asked of the OTHER desk. It goes after the
  // local check so a second chat on this machine still gets the local sentence (which
  // knows more), and before anything is merged or committed - a release that discovers
  // the other machine won halfway through has already moved lanes onto the trunk.
  const lock = takeReleaseLock(state, session)
  if (!lock.ok) return { shipped: false, reason: lock.reason }

  state.release = { session: session ?? 'unknown', at: now(), pid: process.pid }
  write(state)

  try {
    // First: every merge below lands on whatever the main folder has checked out.
    const offTrunk = trunkHome(state)
    if (offTrunk) throw new Error(offTrunk)
    const { blockers: dirty, same } = mainDirt(state)
    if (dirty) throw new Error(`main checkout is dirty, commit first:\n${dirty}`)
    restoreSame(same)
    // Read before anything merges: a merge-mode release no longer waits for these, so it
    // must not reach into them either (see `finish`).
    const working = new Set(busyLanes(state))

    // A hand-cut release skips the SUITE, deliberately - it is Robert asking for a build
    // of work he has already watched being verified - but it may not skip the compiler.
    // Measured 2026-08-26: v0.8.160 was cut this way over a master carrying a duplicate
    // import, both platform builds died on `TS2300: Duplicate identifier`, the notes job
    // printed `No release v0.8.160 - both builds must have failed`, and the only thing on
    // the channel was a tag with no installer behind it. Nothing on this machine said a
    // word. A typecheck is ~15s and answers exactly that question, so it runs before the
    // version is committed rather than eight minutes later in somebody else's CI.
    const broken = typecheckFailure(state)
    if (broken) throw new Error(broken)

    // An expired token used to surface only after the version was committed and
    // tagged, which stranded the release (the resume path below is the recovery).
    // Refuse up front instead: a dry-run push exercises credentials and the network
    // and transfers nothing, so a release that cannot be pushed never gets cut.
    // A repo configured to push nothing is not asked to prove it can push.
    if (RELEASE !== 'none') {
      // Behind origin is the normal state of a two-machine repo, not a broken one. The
      // other desk pushes to the trunk all day; the dry-run then reports `! [rejected]
      // (fetch first)` and the release refuses, so finished lanes sit until a person
      // happens to pull. Measured on taskdriver.ai 2026-08-28: two lanes finished, the
      // last merge 192 minutes earlier, main three commits behind origin, and every
      // `autoship` answered "origin will not take a push, releasing would strand".
      // A fast-forward is the whole fix for a trunk that is purely behind.
      //
      // A DIVERGED trunk used to need a person, because merging was inventing untested
      // code under a lock. Measured 2026-10-04: the main folder held an unpushed
      // `merge lane b` (an old engine merged it and origin's pre-push gate refused the
      // push), the other machine pushed six commits, and from then on every autoship and
      // every ready answered "origin will not take a push" for good - `ready` could not
      // help, because this refusal comes before any lane lands. A GATED release now
      // re-tests the exact merged tree (pushedTreeFailure) before anything is pushed and
      // puts the trunk back when it is red, so for that push the merge is no longer
      // untested: origin's commits are landed here the way a lane lands (landBranch: built
      // off to the side, the folder only fast-forwards, unsaved edits are never touched).
      // beforeMerge is read after this, so a red suite goes back to just after it, unpushed.
      // Still refused as before: a diverged trunk when the push is not re-tested (a
      // person's own ship, a repo with no suite), and when git is busy. Real conflicts stop
      // the release with the files named.
      fastForwardMain()
      if (gated && pushGateApplies() && trunkDiverged()) {
        const m = landBranch(`origin/${MB}`, `merge origin/${MB}`)
        if (m.conflict)
          throw new Error(
            `origin/${MB} and this computer's ${MB} each have work the other lacks and they do not merge cleanly (${m.conflict}), so nothing was released; somebody has to merge them by hand.`
          )
      }
      // --no-verify: this probe is about credentials and fast-forward only. With the hook,
      // taskdriver.ai's pre-push proof judged main's UNMERGED head, so a red main whose
      // ready lane was the repair was refused on every try (2026-09-28, 6cf7e0b8 red, lane
      // tip green in run 36354812354). The real push after the merge still runs the hook.
      const origin = gitSafe(MAIN, 'push', '--dry-run', '--no-verify')
      if (!origin.ok)
        throw new Error(`origin will not take a push, releasing would strand: ${origin.out.slice(0, 200)}`)
    }

    // The ready marks this release took. One set while it ran is not its to clear (finish).
    const batch = { ...state.ready }
    const merged = []
    // Where master stood before any lane landed: a merged tree that does not compile goes back here.
    const beforeMerge = gitSafe(MAIN, 'rev-parse', 'HEAD').out
    // ...and where the last lane this release landed left it.
    let landedHead = beforeMerge
    const conflicts = {}
    // Lanes that could not be merged because git was busy, which is not the same thing as
    // a lane that cannot be merged. They keep their ready mark and nothing is recorded
    // against them.
    const blocked = []
    // Lanes that were passed over with nothing recorded against them. A silent skip and a
    // successful merge look identical from every other chat, which is how a fix sat on an
    // unmerged lane while the ship reported it as gone out.
    const skipped = []
    // Migration files a lane added under a number master took meanwhile, renumbered on
    // the way in (renumberMigrations), as 'old -> new'.
    const renamed = []
    for (const [id, mark] of Object.entries(state.ready)) {
      if (id === 'main') continue
      const branch = laneBranch(id)
      const ahead = aheadOf(branch)
      if (!ahead) {
        // Nothing of this lane's is missing from the branch, so there is nothing to merge -
        // but a lane that vanishes out of `ready` with no word said about it cannot be told
        // apart from one that merged, which is exactly the confusion of 2026-08-28. Say so.
        skipped.push({ lane: id, why: `nothing on ${branch} that ${MB} does not already have` })
        continue
      }
      // Built off to the side and fast-forwarded onto, never merged in the main folder
      // (landLane says why).
      const m = landLane(id, branch)
      // An empty conflict used to read as landed below: the lane was counted as merged.
      if (!m.landed && !m.conflict) m.busy ||= 'git gave no answer about the merge'
      if (m.busy) {
        // Same rule as the lane side: git being busy says nothing about this branch. The
        // lane keeps its ready mark (see `finish`) and goes out of the next release, which
        // is minutes away - rather than being marked conflicted, which is hours away and
        // needs a person. This is the seven-hour stall of 2026-08-02, from the other side.
        // An unsaved edit in the main folder to a file this lane brings is the same: it is
        // somebody's work in progress, not a disagreement between branches.
        blocked.push({ lane: id, why: m.busy })
        continue
      }
      if (m.conflict) {
        // One lane that cannot merge used to stop everyone's release. It does not any
        // more: the conflict is that lane's problem, it stays marked ready, and it is
        // reported by name so the next chat in it fixes it. Everything else goes out.
        noteConflict(conflicts, id, m.conflict, state.conflicts)
        continue
      }
      renamed.push(...renumberMigrations(MAIN, 'HEAD^2', 'HEAD^1'))
      merged.push({ lane: id, commits: ahead, commit: mark.commit })
      landedHead = gitSafe(MAIN, 'rev-parse', 'HEAD').out
    }

    // The typecheck above read master BEFORE any lane landed. Two lanes that each compile
    // can still not compile together: faec0266 (2026-09-25) merged lane a, whose new call
    // passed one argument to a function master had just given a second, and pushed it.
    // Master stayed red until someone else's queue job tripped over it. So the merged tree
    // is checked again, and a red one is put back to what origin already has, unpushed.
    if (merged.length && !TASKDRIVER_PC) {
      const red = typecheckFailure(state)
      if (red) {
        const stuck = undoMerges(beforeMerge, landedHead, merged, state.ready)
        throw new Error(`the lanes did not compile once merged, so nothing was pushed: ${red}${stuck ? `. ${stuck}` : ''}`)
      }
    }

    // The same question for the SUITE, on the tree that is about to be pushed. Master's suite
    // was read before any lane landed, so the merge result - the only tree that ever reaches
    // origin - was never tested: c2a39f8b (2026-10-04) merged a lane, passed the typecheck and
    // went out with two red suites. A person's own `ship` skips it by design but leaves a mark
    // saying so, which is what lets the pre-push hook tell it from a stray `git push`.
    const pushes = RELEASE !== 'none' && pushGateApplies()
    if (pushes && gated) {
      const red = pushedTreeFailure(state)
      if (red) {
        const stuck = undoMerges(beforeMerge, landedHead, merged, state.ready)
        throw new Error(`${red}${stuck ? ` ${stuck}` : ''}`)
      }
    } else if (pushes) {
      recordPushOk(state, 'a person ran ship')
    }

    // A set of individually checked lanes can produce a different merge tree.
    // Fail closed here, with the local merge retained for a PC recheck, before
    // any push can expose unverified combined work.
    if (TASKDRIVER_PC) {
      const tip = gitSafe(MAIN, 'rev-parse', 'HEAD')
      if (!tip.ok) throw new Error('Taskdriver PC verification could not identify merged HEAD')
      const failed = taskdriverProofFailure(MAIN, tip.out)
      if (failed) throw new Error(failed)
    }

    /**
     * The half of a release every repo has: put the lanes that just went out back on top
     * of the branch, keep the ready marks of the ones that could not merge, and record
     * what went out. `version` is null where no version was cut.
     */
    const finish = (version, built) => {
      // Every lane that just shipped catches up, so the next feature in that lane does not
      // start from a stale base and conflict on the release commit. A real merge, not
      // ff-only: a lane with its own commits can never fast-forward, which is exactly the
      // lane that drifts and conflicts. A lane that cannot merge cleanly is recorded and
      // told to its own chat, not silently skipped.
      const rebased = []
      for (const id of POOL) {
        if (id === 'main' || working.has(id)) continue
        // A lane holding a preserved recovery item keeps its pinned commit: merging trunk in
        // moved it, blocked the item ("pinned commit changed") and re-dispatched it under a
        // new key. A ledger that cannot be read skips every lane (fail closed).
        if (state.recoveryError || preservedRecovery(state, id)) continue
        const c = catchUp(id)
        if (c.moved) rebased.push(id)
        if (c.conflicts.length) noteConflict(conflicts, id, `${MB} merge: ${c.conflicts.join(', ')}`, state.conflicts)
      }

      // A lane is only reported as shipped once its own commit is PROVED to be on origin's
      // copy of the branch. Recording the intent is the empty-as-success shape: on
      // 2026-08-28 a ship named four lanes, three of them had really merged, and the fourth
      // kept a production fix while every other chat read it as gone out. `null` is "nobody
      // could check" (no origin, no network) and is left exactly as it was, because nothing
      // here may block a chat.
      const unproved = []
      const shippedLanes = []
      for (const m of merged) {
        const landed = landedOnOrigin(m.commit)
        if (landed === false) unproved.push({ ...m, why: `${m.commit?.slice(0, 8)} is not on origin/${MB}` })
        else shippedLanes.push(m.lane)
      }

      const fresh = read()
      // A lane that could not merge keeps its ready mark: its work still has to go out,
      // in the next release, once someone has resolved it - or, for a lane that only lost
      // a race with another git, as soon as the next release runs and nobody is asked
      // anything at all. A lane whose merge could not be PROVED keeps it for the same
      // reason: its work is still not out there.
      const keep = new Set(unproved.map((m) => m.lane))
      fresh.ready = Object.fromEntries(
        Object.entries(fresh.ready).filter(
          ([id, mark]) =>
            conflicts[id] || blocked.some((b) => b.lane === id) || keep.has(id) ||
            // Marked done while this release ran (PaneForge lane b, 9 Oct 2026: "another chat is
            // mid-release", then this line cleared a mark it had never seen): the next one ships it.
            batch[id]?.commit !== mark.commit
        )
      )
      fresh.conflicts = conflicts
      fresh.release = null
      fresh.lastShip = { version, at: now(), lanes: shippedLanes }
      write(fresh)

      // The trunk is on origin by now, so every lane name up there that it contains is
      // finished. Swept here rather than reported by `doctor`, which is where the pile
      // used to be noticed, by hand, long after it stopped meaning anything.
      const prunedRemotes = pruneRemoteLanes()

      return { shipped: true, version, merged, rebased, conflicts, blocked, skipped, unproved, built, prunedRemotes, renamed }
    }

    // A repository that does not cut versions is finished at the merge. It still gets the
    // whole of the rest: one lock, one batch, one cooldown, lanes brought back up to date.
    // Only the version number is missing, and the version number is the part that is
    // genuinely PaneForge's - `release: "version"` in its .lanes.json is what asks for it.
    if (RELEASE !== 'version') {
      if (!merged.length && !unreleasedOnMaster()) {
        const s = read()
        s.conflicts = conflicts
        s.release = null
        write(s)
        return { shipped: false, reason: 'nothing to release', conflicts, skipped, blocked }
      }
      if (RELEASE === 'merge') {
        const pushed = pushChecked(`refs/heads/${MB}`)
        // The lanes are already merged locally at this point, so say that rather than
        // "release failed": the work is on the branch and one `git push` finishes it.
        if (!pushed.ok)
          throw new Error(`lanes merged into ${MB}, but ${pushFailed(pushed)}`)
      }
      return finish(null, { by: 'skipped' })
    }

    const pkgPath = join(MAIN, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    // "auto" is what every unattended release asks for: the commits about to go out say
    // what they are, so the bump is read off them rather than defaulted to patch. A bump
    // named on the command line is always obeyed as given - and below 1.0 an automatic one
    // only ever moves the patch, which is `nextVersion`'s rule and documented there.
    const next = nextVersion(pkg.version, kind === 'auto' ? bumpFor(MAIN) : kind, kind !== 'auto')

    const unreleased = commitsSinceVersion(pkg.version)
    if (unreleased === 0) {
      // A release that died between the tag and the push (expired token, dropped
      // network) leaves master looking released while origin never heard of it - and
      // "nothing new since vX" means no later attempt would ever push it. Finish that
      // release instead of bailing: the commit and tag already exist, only the pushes
      // are missing. (Happened for real on v0.3.42, 2026-07-28.)
      const tagOnOrigin = gitSafe(MAIN, 'ls-remote', '--tags', 'origin', `refs/tags/v${pkg.version}`)
      if (tagOnOrigin.ok && !tagOnOrigin.out.trim()) {
        if (pushes) recordPushOk(state, 'version release')
        mustPush(`refs/heads/${MB}`)
        mustPush(`refs/tags/v${pkg.version}`, 'origin', `v${pkg.version}`)
        const resumedBuilt = publishFallback(pkg.version, () => beatRelease(session))
        const s = read()
        s.conflicts = conflicts
        s.release = null
        s.lastShip = {
          version: pkg.version,
          at: now(),
          lanes: merged.filter((m) => landedOnOrigin(m.commit) !== false).map((m) => m.lane)
        }
        write(s)
        return { shipped: true, version: pkg.version, merged, rebased: [], conflicts, resumed: true, built: resumedBuilt }
      }
      const s = read()
      s.conflicts = conflicts
      s.release = null
      write(s)
      return { shipped: false, reason: `nothing new since v${pkg.version}`, conflicts, skipped, blocked }
    }

    pkg.version = next
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    git(MAIN, 'add', 'package.json')
    // The lockfile carries the version TWICE and neither copy was ever bumped, so it had
    // drifted nine releases behind the tag (0.8.105 against 0.8.114) - a stale answer to
    // "what version is this" for every tool that reads the lockfile rather than the
    // manifest, and the shape of drift nothing ever complains about out loud. Rewritten
    // here rather than by running `npm install`, which would also churn the dependency
    // tree in a commit whose only job is a number. Silent when there is no lockfile.
    try {
      const lockPath = join(MAIN, 'package-lock.json')
      if (existsSync(lockPath)) {
        const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
        if (lock.version !== undefined) lock.version = next
        if (lock.packages?.['']?.version !== undefined) lock.packages[''].version = next
        writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8')
        git(MAIN, 'add', 'package-lock.json')
      }
    } catch {
      /* a lockfile we cannot parse is not a reason to hold a release */
    }
    git(MAIN, 'commit', '-m', `release: v${next}`)
    git(MAIN, 'tag', `v${next}`)
    if (pushes) recordPushOk(state, 'version release')
    mustPush(`refs/heads/${MB}`)
    mustPush(`refs/tags/v${next}`, 'origin', `v${next}`)
    return finish(next, publishFallback(next, () => beatRelease(session)))
  } catch (e) {
    const s = read()
    if (s.release?.session === (session ?? 'unknown')) {
      s.release = null
      write(s)
    }
    throw e
  } finally {
    // Both ways out, including the throw above: a lock that outlives its release blocks
    // the other desk until it goes stale, and the whole point of holding it was to be the
    // one device cutting THIS version. It is not the local `state.release`, which the
    // catch above clears on its own schedule.
    if (lock.held) {
      const s = read()
      dropReleaseLock(s, session)
      write(s)
    }
  }
}

// ---------------------------------------------------------------- local publish fallback

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Quote one argument so cmd.exe passes it through as text.
 *
 * `shell: true` concatenates the arguments into a single command line WITHOUT
 * escaping them - Node says so itself (DEP0190). Every character cmd reads as
 * syntax then cuts the command in half: a space, and `& | < > ^`. That is not
 * theoretical. `?event=push&per_page=10` ran as `gh api ...?event=push` followed
 * by a second command `per_page=10 --jq ...`, which is not a program; the first
 * half answered without the `--jq`, the second half exited 1, and `spawnSync`
 * reports the LAST status - so the call returned `ok: false` with a body that was
 * actually fine. See `publishFallback`, which read that as "Actions never ran".
 *
 * Inside double quotes cmd treats all of those as ordinary characters, so wrapping
 * is the whole fix. The backslash dance is for the callee's own parser: a run of
 * backslashes is only special immediately before a quote, where each pair collapses
 * to one, so those runs are doubled and an embedded quote is escaped.
 *
 * `%VAR%` still expands inside quotes and cannot be escaped there - no caller in
 * this file passes a `%`, and one that needs to must not go through here.
 */
function cmdQuote(arg) {
  const s = String(arg)
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}

function runSafe(cmd, args, opts = {}) {
  const shell = process.platform === 'win32' // npx and gh are .cmd shims on Windows
  const r = spawnSync(cmd, shell ? args.map(cmdQuote) : args, {
    cwd: MAIN,
    encoding: 'utf8',
    shell,
    windowsHide: true,
    timeout: opts.timeout ?? 30_000,
    killSignal: 'SIGKILL',
    env: opts.env ?? process.env
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
  return { ok: r.status === 0, out }
}

// GitHub Actions normally builds the installers when the tag lands. On 2026-07-28
// GitHub disabled Actions for the whole account (anti-abuse flag; support ticket is
// the only way back and takes days), which turned every release into a tag with no
// installers: the updater feed never moved and nobody was told. So after the tag is
// pushed, watch briefly for the workflow run; if none appears, build THIS platform
// here and publish it exactly the way .github/workflows/release.yml would have -
// same assets, same fixed-name copies, same notes. When Actions comes back the run
// shows up in the first poll and the fallback stands down by itself.
function publishFallback(version, beat = () => {}) {
  // The throwaway repos the lane tests build have no publish config: nothing to do.
  const pub = JSON.parse(readFileSync(join(MAIN, 'package.json'), 'utf8')).build?.publish?.[0]
  if (!pub || pub.provider !== 'github') return { by: 'skipped' }
  const repo = `${pub.owner}/${pub.repo}`
  for (let i = 0; i < 3; i++) {
    beat()
    sleep(15_000)
    const r = runSafe('gh', [
      'api',
      `repos/${repo}/actions/runs?event=push&per_page=10`,
      '--jq',
      '[.workflow_runs[].head_branch]'
    ])
    if (r.ok && r.out.includes(`v${version}`)) return { by: 'actions' }
  }

  const token = runSafe('gh', ['auth', 'token'])
  if (!token.ok) return { by: 'failed', reason: 'gh has no token, cannot publish locally' }
  const env = { ...process.env, GH_TOKEN: token.out, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  const target = process.platform === 'darwin' ? '--mac' : '--win'

  beat()
  const vite = runSafe('npx', ['electron-vite', 'build'], { env, timeout: 300_000 })
  if (!vite.ok) return { by: 'failed', reason: `electron-vite build failed: ${vite.out.slice(-200)}` }
  beat()
  const eb = runSafe('npx', ['electron-builder', target, '--publish', 'always'], {
    env,
    timeout: 600_000
  })
  if (!eb.ok) return { by: 'failed', reason: `electron-builder failed: ${eb.out.slice(-200)}` }
  beat()

  // Fixed-name copies (PaneForge-Setup.exe etc), so install.sh / install.ps1 keep
  // finding the newest build by name - same renaming the workflow does. Nothing in
  // the repo LINKS these files; that is what got the account flagged on 2026-07-28.
  const dist = join(MAIN, 'dist')
  for (const name of readdirSync(dist)) {
    if (!name.includes(version) || !/\.(exe|dmg|zip)$/.test(name)) continue
    const fixed = name
      .replace(new RegExp(`[ -]?${version.replace(/\./g, '\\.')}`), '')
      .replace(/ /g, '-')
    const copy = join(dist, fixed)
    copyFileSync(join(dist, name), copy)
    beat()
    runSafe('gh', ['release', 'upload', `v${version}`, copy, '--clobber'], { env, timeout: 300_000 })
  }

  // Same body the workflow would have written, changes and all - `notes` reads the
  // template and the commit range itself, so the two paths cannot drift apart.
  if (existsSync(join(MAIN, '.github', 'release-notes.md'))) {
    const tmp = join(dist, 'release-notes.txt')
    writeFileSync(tmp, notes(MAIN, version), 'utf8')
    runSafe('gh', ['release', 'edit', `v${version}`, '--notes-file', tmp], { env, timeout: 60_000 })
  }
  return { by: 'local' }
}

// A release page is worth reading for an hour after it is cut, and not worth an API
// call after that.
const NOTES_MS = 60 * 60 * 1000

/**
 * Write "what changed" onto the newest release, after whoever built it is finished.
 *
 * The workflow publishes the body itself, from a template it substitutes `{{VERSION}}`
 * into and nothing else - and `.github/workflows/` cannot be edited from this machine
 * (the `gh` token has `repo` but not `workflow`, so the push is rejected by name). So
 * the changes are written here instead, from the retry timer that already runs every
 * minute: the workflow's notes job lands a few minutes after the tag, this notices the
 * body has no "## What changed" in it, and fills it in. Being a check-then-write rather
 * than a one-shot is what makes it correct - CI overwriting the body is simply seen on
 * the next tick and put back.
 *
 * It costs nothing on a quiet machine: no release in the last hour, no call at all.
 */
function reconcileNotes(state) {
  const last = state.lastShip
  if (RELEASE !== 'version') return null
  if (!last?.version || !last.at || Date.now() - last.at > NOTES_MS) return null
  if (!existsSync(join(MAIN, '.github', 'release-notes.md'))) return null

  const tag = `v${last.version}`
  const view = runSafe('gh', ['release', 'view', tag, '--json', 'body', '--jq', '.body'], {
    timeout: 30_000
  })
  // No release yet (the build is still running), or gh cannot answer: try again in a
  // minute. Nothing here is worth failing a retry over.
  if (!view.ok || hasChanges(view.out)) return null

  const body = notes(MAIN, last.version)
  if (!hasChanges(body)) return null
  const tmp = join(MAIN, 'dist', 'release-notes.txt')
  try {
    mkdirSync(join(MAIN, 'dist'), { recursive: true })
    writeFileSync(tmp, body, 'utf8')
  } catch {
    return null
  }
  const edit = runSafe('gh', ['release', 'edit', tag, '--notes-file', tmp], { timeout: 60_000 })
  return edit.ok ? last.version : null
}

/**
 * Two publishers, one release.
 *
 * Actions builds the installers when the tag lands, and `publishFallback` builds them here
 * when no run appears within its 45s window. When the poll is merely SLOW rather than right,
 * BOTH publish - and the second binary cannot take a name the first already holds, so it
 * lands beside it as `PaneForge.Setup.0.4.27.exe` next to `PaneForge-Setup-0.4.27.exe`.
 * Those duplicates are harmless. `latest.yml` is not: it is overwritten rather than skipped,
 * so whichever job finishes last publishes a feed naming the file the OTHER one uploaded.
 *
 * v0.4.27 went out exactly that way - a feed declaring sha512 and size for a build 33 bytes
 * shorter than the asset it pointed at. Nothing looks wrong: the release page is complete,
 * both jobs are green, the installer downloads and runs. Only electron-updater ever compares
 * the two, silently, on somebody else's machine, and refuses the update. It is the one break
 * with no reporter, because the people it happens to are the people whose app never changes.
 *
 * So the feed is checked against the asset it actually names, on the timer that already
 * fixes the notes and for the same hour. Check-then-write, never one-shot: the job that
 * overwrote it may still have been running when we looked. Our own `dist` feed is only
 * put back when it agrees with what the release is really serving - a repair that cannot
 * verify itself is worse than the mismatch, which at least fails closed.
 */
function reconcileFeed(state) {
  const last = state.lastShip
  if (RELEASE !== 'version') return null
  if (!last?.version || !last.at || Date.now() - last.at > NOTES_MS) return null

  const tag = `v${last.version}`
  const name = process.platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml'
  const local = join(MAIN, 'dist', name)
  if (!existsSync(local)) return null

  // What the release is serving right now, not what we uploaded.
  const served = runSafe('gh', ['release', 'download', tag, '-p', name, '-O', '-'], {
    timeout: 60_000
  })
  if (!served.ok) return null
  const declared = /^\s*-?\s*url:\s*(\S+)[\s\S]*?size:\s*(\d+)/m.exec(served.out)
  if (!declared) return null
  const [, file, size] = declared

  // Parsed here rather than filtered with `--jq`, which is now only a preference:
  // `runSafe` quotes its arguments, so a filter carrying spaces or `|` survives cmd.
  // It did not used to, and reading the earlier note here as "the calls with no
  // spaces are fine" is what left the real one broken for a fortnight - the `&` in
  // `?event=push&per_page=10` cuts a command just as cleanly as a pipe does, and the
  // failure is silent `ok: false`, which this function reads as "cannot tell" and
  // answers by doing nothing. Assume nothing about an argument; see `cmdQuote`.
  const listed = runSafe('gh', ['release', 'view', tag, '--json', 'assets'], { timeout: 30_000 })
  if (!listed.ok) return null
  let real
  try {
    real = JSON.parse(listed.out).assets?.find((a) => a.name === file)?.size
  } catch {
    return null
  }
  // An asset the feed names that does not exist is a different failure and not one a
  // reupload of our own feed can fix - leave it and let `doctor` be the thing that says so.
  if (real == null) return null
  if (String(real) === size) return null

  // Only our own feed, and only when it describes the bytes actually being served.
  const mine = /^\s*-?\s*url:\s*(\S+)[\s\S]*?size:\s*(\d+)/m.exec(readFileSync(local, 'utf8'))
  if (!mine || mine[1] !== file || mine[2] !== String(real)) return null

  const up = runSafe('gh', ['release', 'upload', tag, local, '--clobber'], { timeout: 120_000 })
  return up.ok ? { version: last.version, name, was: size, now: mine[2] } : null
}

/** This repo's GitHub publish target, or null - the throwaway test repos have none. */
function githubPublish() {
  try {
    const pub = JSON.parse(readFileSync(join(MAIN, 'package.json'), 'utf8')).build?.publish?.[0]
    return pub?.provider === 'github' ? `${pub.owner}/${pub.repo}` : null
  } catch {
    return null
  }
}

/**
 * Promotion is the ONLY door from the dev channel to everybody's app.
 *
 * Every automatic release is cut as a GitHub PRERELEASE. Installs opted into the dev
 * channel (Settings, `devUpdates`) take it within the half hour; everyone else's updater
 * resolves /releases/latest, which GitHub keeps pointed at the newest PROMOTED release.
 * So a broken build is a dev-channel event, fixed by the next `ready` without anybody's
 * daily app ever seeing it - and nothing reaches a stable install until this command
 * says a named build proved itself: `node scripts/lane.mjs promote [version]`.
 *
 * It refuses, by name, what the feed lessons taught. A release missing either platform's
 * feed is a build that silently strands every install on that platform (v0.7.2 went out
 * Windows-only and v0.8.0 Mac-only, neither run red). A feed whose declared size
 * disagrees with the asset actually being served fails every update's hash check on
 * somebody else's machine with no reporter (v0.4.27). Promoting is asserting both are
 * right, so both are checked here, not assumed.
 */
function promote(versionArg) {
  const repo = githubPublish()
  if (!repo) return { promoted: false, reason: 'this repo has no GitHub publish config - nothing releases to a channel' }

  let tag
  if (versionArg) {
    tag = `v${String(versionArg).replace(/^v/, '')}`
    const view = runSafe('gh', ['api', `repos/${repo}/releases/tags/${tag}`], { timeout: 30_000 })
    if (!view.ok) return { promoted: false, reason: `no release ${tag} on ${repo}` }
    let rel
    try {
      rel = JSON.parse(view.out)
    } catch {
      return { promoted: false, reason: 'releases API answered something unreadable' }
    }
    if (rel.draft) return { promoted: false, reason: `${tag} is still a draft - its build has not finished uploading` }
    if (!rel.prerelease) return { promoted: false, reason: `${tag} is already promoted` }
  } else {
    const list = runSafe('gh', ['api', `repos/${repo}/releases?per_page=20`], { timeout: 30_000 })
    if (!list.ok) return { promoted: false, reason: `cannot list ${repo}'s releases (is gh logged in?)` }
    let releases
    try {
      releases = JSON.parse(list.out)
    } catch {
      return { promoted: false, reason: 'releases API answered something unreadable' }
    }
    const newest = releases.find((r) => !r.draft)
    if (!newest) return { promoted: false, reason: 'no releases exist at all' }
    if (!newest.prerelease)
      return { promoted: false, reason: `newest release ${newest.tag_name} is already promoted - nothing is waiting on the dev channel` }
    tag = newest.tag_name
  }

  const listed = runSafe('gh', ['release', 'view', tag, '--json', 'assets'], { timeout: 30_000 })
  if (!listed.ok) return { promoted: false, reason: `cannot read ${tag}'s assets` }
  let assets
  try {
    assets = JSON.parse(listed.out).assets ?? []
  } catch {
    return { promoted: false, reason: `unreadable asset list on ${tag}` }
  }
  for (const name of ['latest.yml', 'latest-mac.yml']) {
    if (!assets.some((a) => a.name === name))
      return {
        promoted: false,
        reason: `${tag} has no ${name} - that platform's build is missing, and promoting a one-legged release strands every install on it`
      }
    const feed = runSafe('gh', ['release', 'download', tag, '-p', name, '-O', '-'], { timeout: 60_000 })
    if (!feed.ok) return { promoted: false, reason: `cannot read ${name} from ${tag}` }
    const declared = /^\s*-?\s*url:\s*(\S+)[\s\S]*?size:\s*(\d+)/m.exec(feed.out)
    if (!declared) return { promoted: false, reason: `${name} on ${tag} declares no installer` }
    const [, file, size] = declared
    const real = assets.find((a) => a.name === file)?.size
    if (real == null) return { promoted: false, reason: `${name} names ${file}, which is not among ${tag}'s assets` }
    if (String(real) !== size)
      return {
        promoted: false,
        reason: `${name} describes a ${size}-byte ${file} and the release is serving ${real} bytes - every update would fail its hash check`
      }
  }

  const edit = runSafe('gh', ['release', 'edit', tag, '--prerelease=false', '--latest'], { timeout: 60_000 })
  if (!edit.ok) return { promoted: false, reason: `gh release edit failed: ${edit.out.slice(-200)}` }
  // The claim is what /releases/latest actually answers now, not that the edit exited 0.
  const latest = runSafe('gh', ['api', `repos/${repo}/releases/latest`, '--jq', '.tag_name'], { timeout: 30_000 })
  if (!latest.ok || latest.out.trim() !== tag)
    return { promoted: false, reason: `edited ${tag}, but /releases/latest answers "${latest.out.trim()}" - the promotion did not take` }
  return { promoted: true, tag }
}

const PROMOTE_SOAK_MS = Number(process.env.PF_PROMOTE_SOAK_MS ?? 3 * 24 * 60 * 60 * 1000)
const PROMOTE_POLL_MS = Number(process.env.PF_PROMOTE_POLL_MS ?? 60 * 60 * 1000)

/**
 * Stable follows the big-company shape (Chrome, VS Code, Firefox): the dev channel
 * churns per release, stable takes batched, proven jumps. The signal is a SOAK - the
 * build being promoted has been on the dev channel PROMOTE_SOAK_MS, so dev installs ran
 * it that long and nothing needed a fix. electron-updater downloads the full installer
 * of whatever /releases/latest names, so the versions stable skips cost it nothing.
 *
 * The soak is that BUILD's age, not a quiet period across the channel. Requiring the
 * NEWEST build to sit untouched for three days sounds stricter and is really a promise
 * that stable never moves at all: something ships here most days, every release resets
 * the clock, and the measurement on 2026-08-14 is what that produces - 20 unpromoted
 * dev builds, stable still on v0.8.32, and a Mac that could not update itself out of a
 * broken build because no restart and no poll was ever going to find a newer stable
 * one. A superseded build is not automatically a bad build; the proof that a build is
 * good is that it ran for three days, which this still requires of whatever it picks.
 *
 * Rides the same minute timer as everything else here, throttled to one releases
 * lookup per PROMOTE_POLL_MS (state.promoteAt), and hands the actual flip to
 * `promote()` - so every refusal that protects a hand promotion (one-legged release,
 * lying feed) protects this one. A refusal is reported and re-tried on the next poll,
 * never faster; `promote [version]` by hand still works for "stable needs this now".
 *
 * Returns null when it did nothing at all; any non-null means state.promoteAt moved
 * and the caller should write.
 */
function autoPromote(state) {
  // Every mode that releases at all, not only 'version'. In 'merge' mode versions are cut
  // by hand on Robert's word, and gating this on 'version' froze stable on v0.8.179 for
  // 24 days (2026-08-31 to 09-24) while 46 dev builds shipped; a friend on the public
  // build never saw any of them. Robert, 2026-09-24: stable keeps up by itself after the
  // soak. A hand-cut build still has to soak and pass promote()'s checks.
  if (RELEASE === 'none') return null
  const repo = githubPublish()
  if (!repo) return null
  if (state.promoteAt && now() < state.promoteAt) return null
  state.promoteAt = now() + PROMOTE_POLL_MS
  // 20, not 5: the ripe build can be well down the list after a run of dev releases, and
  // a window that cannot see it reads as "nothing to promote" for ever.
  const list = runSafe('gh', ['api', `repos/${repo}/releases?per_page=20`], { timeout: 30_000 })
  if (!list.ok) return { checked: true }
  let releases
  try {
    releases = JSON.parse(list.out)
  } catch {
    return { checked: true }
  }
  const live = releases.filter((r) => !r.draft)
  // Already promoted at the top means stable is current: nothing to do.
  if (!live[0]?.prerelease) return { checked: true }
  // The newest build that has itself soaked. Newer builds on top of it do not block it -
  // they are the next promotions, once they are three days old too.
  const ripe = live.find((r) => {
    if (!r.prerelease) return false
    const born = Date.parse(r.published_at ?? '')
    return Number.isFinite(born) && now() - born >= PROMOTE_SOAK_MS
  })
  if (!ripe) return { checked: true }
  return { checked: true, tag: ripe.tag_name, ...promote(String(ripe.tag_name ?? '').replace(/^v/, '')) }
}

function status(session, { held = false } = {}) {
  const state = reap(read())
  // Asking is not writing, except when the asking found something to throw away: an
  // expired reservation that is only ever computed and never stored is not expired at all.
  if (reaped) write(state)
  // One answer per lane for the whole of this status: `busyLanes` and `shippable` below
  // ask `laneWork` for the same held lanes the table just measured, and each ask was a
  // fresh `git status` + `git cherry`. Nothing writes between here and the return, so the
  // second reading could only ever agree with the first.
  workMemo = new Map()
  try {
    return statusOf(state, session, held)
  } finally {
    workMemo = null
  }
}

function statusOf(state, session, held) {
  // A lane nobody holds has no chat in it, and the prompt hook - which runs `status` on
  // EVERY prompt in every chat - prints only held lanes. Measuring the other eight
  // (two `rev-parse`, a `git status`, a `git cherry` each) was 41 of the 49 child
  // processes behind a 1.0s hook, 2-5s under load. `--held` reads them off the ledger
  // alone; the app's board and a person's `status` still measure every lane.
  const workOf = (id) => (held && !state.lanes[id]?.session ? { dirty: false, ahead: 0, touchedAt: 0 } : laneWork(id))
  // Read once: null (inventory unknown) must never be reported as "the chat is gone".
  const parkLiving = Object.keys(state.parkedWork ?? {}).length ? recoveryLiving() : null
  return {
    main: MAIN,
    // What this repository is, in the three words a caller needs to phrase anything: the
    // branch lanes live off, what finishing does here, and whether this is the checkout
    // the engine ships in. The hook reads these to know whether to talk about releases.
    repo: basename(MAIN),
    branch: MB,
    // NOT `release` - that name is already taken below by the in-flight release lock, and
    // an object literal with the same key twice keeps the LAST one, so this read `null`
    // for every repo until the collision was noticed.
    mode: RELEASE,
    own: OWN,
    lanes: POOL.map((id) => {
      // The catch-up: a copy made before this hid them, or one a person un-hid, goes back
      // out of Finder here. Setting a flag that is already set costs one no-op call and
      // means nobody ever has to run a command to tidy their own Projects folder.
      hideLane(id)
      const w = workOf(id)
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
        // The Stop hook saw this hold's chat end a turn with the lane clean - the hold
        // survives, but any chat that needs the checkout takes it in minutes.
        parked: state.lanes[id]?.parked ?? null,
        // Claimed by a chat whose own project is a different repo - it stood here.
        visitor: Boolean(state.lanes[id]?.visitor),
        // The pane holding this lane put its own agent to sleep - the hold survives on
        // purpose (see holdGivenUp, reap), a press away from being what it was.
        asleep: state.lanes[id]?.asleep ?? null,
        from: state.lanes[id]?.cwd ?? null,
        // Which pane the holder lives in, and when its chat ended: the two facts `claim`
        // uses to hand a hold to the same pane's next chat after a /clear. A caller that
        // must not start a new copy for a chat (the prompt hook, in a repo that never gets
        // lanes) reads them to tell "that pane's earlier chat" from "somebody else".
        pane: state.lanes[id]?.pane ?? null,
        ended: state.lanes[id]?.ended ?? null,
        // When the HOLD was last refreshed - a heartbeat bumped by that chat's turns
        // ending, so it says how long ago the chat was last alive rather than anything
        // about work. Without it every hold reads the same: taskdriver.ai printed five
        // lanes "held by a chat" for two live chats and three that had been gone for
        // hours, and nothing on the machine could tell them apart (2026-08-15). Null when
        // nobody holds the lane. `touchedAt` below is the other half - when work moved.
        seenAt: state.lanes[id] ? (state.lanes[id].seen ?? state.lanes[id].claimed ?? null) : null,
        // The folder is there and is not a checkout of this repository - a leftover, or a
        // separate clone squatting on the lane's path. Nothing here merges or releases it.
        broken: Boolean(w.broken),
        // The folder is a worktree of this repo and most of its files are gone (see
        // damageOf). Separate from `broken`, which stays "not a worktree at all".
        damaged: Boolean(w.damaged),
        // Of those, one a killed checkout left half made (halfMade), which finishCopy can finish.
        halfMade: Boolean(w.halfMade),
        missingFiles: w.missingFiles ?? 0,
        trackedFiles: w.trackedFiles ?? 0,
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
        ahead: w.ahead,
        // When the WORK last moved, not when the chat last spoke. A caller explaining a
        // held-up release to a person needs this to tell "somebody is typing" from "a
        // window is open" - reporting the second as the first is what made a squat read
        // as normal traffic for hours. 0 when the lane holds nothing.
        touchedAt: w.touchedAt ?? 0
      }
    }),
    // Why a finished lane has not gone out yet, in one field.
    blockedBy: releaseHolds(state),
    // Registered or discovered recovery work is intentionally separate from `lanes`.
    // Discovery is a review prompt only; ordinary claim/cherry-pick/ready owns resumption.
    parkedWork: Object.values(state.parkedWork ?? {}).map((p) => {
      const current = parkedCommit(p.ref)
      const key = `ref:${p.ref}:${p.commit}`
      const item = state.recovery?.items?.[key]
      const recovery = item ? { key, status: item.status, reason: item.reason ?? item.receipt?.reason ?? null, pane: item.pane ?? null, owner: item.owner ?? null, landed: item.readyCommit ?? null } : null
      const onTrunk = gitSafe(MAIN, 'merge-base', '--is-ancestor', p.commit, MB).ok
      return {
        ...p,
        recovery,
        parkerGone: p.session && parkLiving ? !parkLiving.has(p.session) : false,
        present: Boolean(current),
        moved: Boolean(current && current !== p.commit),
        merged: Boolean(onTrunk),
        action: onTrunk
          ? 'already on trunk by ancestry; no recovery needed (a cherry-picked equivalent cannot be inferred)'
          : recovery?.status === 'complete' && current && current === p.commit
            ? `nothing left: landed on ${MB} as ${(recovery.landed ?? '').slice(0, 12)}`
            : recovery?.status === 'reviewed' && current && current === p.commit
              ? `nothing left: ${String(recovery.reason ?? '').slice(0, 160)}`
              : recovery?.status === 'blocked' && current && current === p.commit
                ? `nothing picks this up again by itself: inspect it, land what is still wanted through a claimed lane and ready, then recover --key "${key}" --session <id> --disposition reviewed --receipt <json with reason>`
          : p.reviewRequired
            ? `inspect then park --ref ${p.ref.replace(/^refs\/remotes\//, '')} --lane <empty slot>`
            : `claim a lane, cherry-pick ${p.commit.slice(0, 12)}, then ready`
      }
    }),
    // A local *-wip branch gives no safe lane assignment. Show it without registering or
    // merging it, so its owner can choose a slot explicitly.
    unregisteredParked: unregisteredWip(state),
    pending: shippable(state),
    release: state.release,
    lastShip: state.lastShip,
    passed: state.passed ?? {},
    recovery: state.recovery ?? null,
    recoveryError: state.recoveryError ?? null
  }
}

/**
 * The whole state of this repo's lanes, in sentences, for a person.
 *
 * `status` answers the same questions as JSON for the app and the hooks. This is the one
 * for whoever has just been handed the machine and wants to know what a lane is, where the
 * work is, and why nothing has gone out - without reading this file.
 *
 * It also names the debris, which is the thing no other command does. Folders that LOOK
 * like lanes and are not registered worktrees are what made this system confusing to read:
 * `Toolstash-w2` sat beside `Toolstash-a` for days after git had stopped knowing about it,
 * and nothing on the machine would ever have mentioned it.
 */
/**
 * How long ago, for a person reading a list.
 *
 * Minutes stop being readable somewhere around an hour and a half - "341m ago" is a number
 * to do arithmetic on rather than an answer - and the whole point of printing an age here
 * is that "5h" and "3m" must not look alike at a glance.
 */
function ago(at) {
  const m = Math.max(0, Math.round((now() - at) / 60000))
  if (m < 90) return `${m}m`
  const h = m / 60
  return h < 36 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`
}

function doctor() {
  const s = status(null)
  const out = []
  const say = (line = '') => out.push(line)

  say(`${basename(MAIN)}  ${MAIN}`)
  say(
    RELEASE === 'version'
      ? `Lanes branch off ${MB}. Finishing one cuts a version, tags it and publishes the installers.`
      : RELEASE === 'merge'
        ? `Lanes branch off ${MB}. Finishing one merges into ${MB} and pushes. Readiness does not cut a version; explicitly requested releases use the project's manual release workflow.`
        : `Lanes branch off ${MB}. Finishing one does nothing else - this repo neither tags nor pushes.`
  )
  say()
  if (pushGateApplies()) {
    const hook = prePushPath()
    const st = hook ? prePushState(hook) : { kind: 'missing' }
    if (st.kind !== 'ours')
      say(
        `Nothing stops a plain \`git push\` of ${MB} from sending work no test has run: the push check is ${st.kind === 'foreign' ? 'another tool\'s hook, which is left alone' : 'not installed yet (any lane command installs it)'}.`
      ), say()
  }

  // Said before anything else, because nothing below goes out while it is true.
  {
    const st = read()
    const head = gitSafe(MAIN, 'symbolic-ref', '--quiet', '--short', 'HEAD')
    const on = head.ok ? head.out : ''
    if (on !== MB) {
      say('MAIN FOLDER')
      say(`  ${st.trunk?.stuck ? st.trunk.text : `The main folder is on a side branch (${on || 'none'}), so finished chats are waiting. ${trunkBlocker(on) ?? 'The next release puts it back by itself.'}`}`)
      say()
    } else if (st.trunk && !st.trunk.stuck && now() - st.trunk.at < 24 * 60 * 60 * 1000) {
      say('MAIN FOLDER')
      say(`  ${st.trunk.text} (${ago(st.trunk.at)} ago)`)
      say()
    }
  }

  say('LANES')
  const live = s.lanes.filter((l) => l.exists || l.heldBy || l.ready || l.conflicted || l.ahead > 0)
  for (const l of live) {
    const what = []
    if (l.heldBy)
      what.push(
        (l.asleep
          ? 'held by a chat whose pane is asleep - kept for it, not handed out'
          : l.tentative
          ? 'reserved by a chat that has not written here'
          : l.parked
            ? `held by a chat whose turn ended ${Math.round((now() - l.parked) / 60000)}m ago - taken over the moment anyone needs it`
            : l.visitor
              ? 'held by a visiting chat from another project'
              : 'held by a chat') +
          // A hold with no age on it reads as a person typing, whatever its real age, and
          // that is the whole reason this list was unreadable: three of taskdriver.ai's
          // five holds had been dead for hours and said exactly what the two live ones
          // said. `parked` already carries its own clock, so it is not repeated there.
          (l.parked || l.seenAt == null ? '' : `, last heard from ${ago(l.seenAt)} ago`)
      )
    if (l.broken)
      what.push(
        `its folder is NOT a worktree of this repo - a leftover or a separate clone at that path. Nothing here merges or releases what is in it`
      )
    if (l.halfMade)
      what.push(
        `its copy never finished being made (git was stopped part way through writing its files). It is not handed to a new chat; it is finished automatically when nothing in it differs from ${l.branch}, and \`node ${join(own, 'scripts', 'lane.mjs')} finish-copy --repo ${MAIN} --lane ${l.lane}\` says why not`
      )
    else if (l.damaged)
      what.push(
        `its folder is missing most of its files (${l.missingFiles} of ${l.trackedFiles}) - a copy that never finished being made. It is not handed to a new chat; check it and move it out of the way`
      )
    // The deletions of a damaged folder are not edits anybody made.
    if (l.dirty && !l.damaged) what.push('uncommitted edits')
    if (l.ahead) what.push(`${l.ahead} commit${l.ahead === 1 ? '' : 's'} ${MB} does not have`)
    if (l.ready) what.push('finished, waiting for the next release')
    if (l.conflicted) what.push(`conflicts with ${MB} (${l.conflict?.detail || 'unknown files'})`)
    say(`  ${l.lane.padEnd(5)} ${l.branch.padEnd(10)} ${what.length ? what.join('; ') : 'empty'}`)
    // A path that is not there is not an address. A lane can be held before its folder is
    // ever made (the folders are cut on first use), and printing the path anyway sent
    // whoever read this looking for a directory that has never existed.
    say(l.exists ? `        ${l.dir}` : `        no folder yet - it is made the first time that chat writes here`)
  }
  const spare = s.lanes.length - live.length
  if (spare > 0) say(`  ${spare} more lane${spare === 1 ? '' : 's'} free - their folders are only made when handed out.`)
  say()

  // The other desk. Only ever printed when there is something to print: a one-machine
  // repo must not grow a section telling it every day that it is alone.
  {
    const refs = peerRefs()
    if (refs === null && hasOrigin()) {
      say('OTHER DEVICES')
      say('  Could not reach origin, so this desk cannot tell whether another one holds the trunk.')
      say('  Lanes still work exactly as they did before; only the cross-device check is skipped.')
      say()
    } else if (refs) {
      const others = parseClaims(refs).filter((c) => c.device !== DEVICE && now() - c.at <= 45 * 60 * 1000)
      if (others.length) {
        say('OTHER DEVICES')
        for (const c of others)
          say(
            c.slot === RELEASE_SLOT
              ? `  ${peerWords(c, { now: now() })} is cutting a release.`
              : `  ${peerWords(c, { now: now() })} holds the ${c.slot} checkout. Chats here are sent to a letter lane instead.`
          )
        say()
      }
    }
  }

  say('RELEASE')
  if (s.release) say(`  A release started ${Math.round((now() - s.release.at) / 60000)}m ago and is still running.`)
  else if (s.blockedBy.length) say(`  Waiting on chats still working in: ${s.blockedBy.map(busyDetail).join(', ')}`)
  else if (!s.pending) say('  Nothing is waiting to go out.')
  else {
    const since = s.lastShip ? now() - s.lastShip.at : Infinity
    // The same two windows autoship uses, and it says WHICH one it is on: "6 hours" with
    // no reason reads as a stuck release rather than as small work waiting for company.
    const small = smallOnly(MAIN)
    const window_ = small ? SMALL_HOLD_MS : COOLDOWN_MS
    if (since < window_)
      say(
        `  Work is ready. It goes out in about ${Math.ceil((window_ - since) / 60000)}m - releases batch, so one release carries all of it.` +
          (small ? '\n  Everything waiting is small, so it is waiting for company rather than cutting a version of its own.' : '')
      )
    else say('  Work is ready and nothing is blocking it. The next lane command releases it.')
  }
  if (s.lastShip)
    say(`  Last ${s.lastShip.version ? `release: v${s.lastShip.version}` : 'merge'}, ${Math.round((now() - s.lastShip.at) / 60000)}m ago.`)
  // A lane whose ready mark was dropped because its work was already on the branch. Said
  // out loud, or it cannot be told apart from a lane that shipped.
  for (const [id, p] of Object.entries(s.passed ?? {}))
    say(`  Lane ${id} was passed over ${Math.round((now() - p.at) / 60000)}m ago - ${p.why}.`)

  // What the next release page will NOT say, although the commit changed the app. The
  // notes drop every subject that is not feat/fix/perf and say nothing about it, so a
  // real fix worded as a sentence publishes a page reading "see the commit history"
  // (v0.8.92). This is the last moment the subject can still be reworded, so it is
  // named here and nowhere else - the published page is never guessed at.
  if (RELEASE === 'version') {
    // Read once: two calls are two `git tag --list` runs, and a tag landing between them
    // builds the range against a tag the condition never saw.
    const newest = versionTags(MAIN)[0]
    const ranges = [newest ? `${newest}..${MB}` : MB]
    for (const l of s.lanes) if (l.ahead > 0 && l.branch !== MB) ranges.push(`${MB}..${l.branch}`)
    const missed = [...new Set(ranges.flatMap((r) => unpublished(MAIN, r)))]
    if (missed.length) {
      say(`  ${missed.length === 1 ? 'This change' : 'These changes'} touched the app and will NOT appear on the release page:`)
      for (const m of missed) say(`    ${m}`)
      say('  The page carries feat:/fix:/perf: subjects only. Reword the commit before it ships.')
    }
  }

  // What the dev channel is holding that stable installs have not seen. One API call,
  // only in doctor - status must stay offline - and a gh that cannot answer says nothing:
  // an absent fact is not a known-empty channel.
  const repo = RELEASE === 'version' ? githubPublish() : null
  if (repo) {
    const list = runSafe('gh', ['api', `repos/${repo}/releases?per_page=20`], { timeout: 15_000 })
    try {
      const releases = JSON.parse(list.ok ? list.out : '[]').filter((r) => !r.draft)
      const pending = []
      for (const r of releases) {
        if (!r.prerelease) break
        pending.push(r.tag_name)
      }
      if (pending.length) {
        // A page of 20 that is ALL prereleases means the newest stable is off the end of
        // it, not that there isn't one - and "stable installs are on nothing" is a
        // frightening sentence to read when a stable release exists and is merely old.
        // /releases/latest is the same thing a stable install resolves, so ask it rather
        // than inferring an absence from a window that ran out.
        let stable = releases.find((r) => !r.prerelease)
        // Three different endings, and collapsing any two of them is the bug this repo
        // keeps re-committing: a 404 is the KNOWN answer "there has never been a stable
        // release", while a timeout or an unauthenticated gh is "this desk cannot tell".
        // Printing the same sentence for both is a degraded reading becoming a claim.
        let why = null
        if (!stable) {
          const one = runSafe('gh', ['api', `repos/${repo}/releases/latest`], { timeout: 15_000 })
          if (one.ok) {
            try {
              stable = JSON.parse(one.out)
            } catch {
              why = 'a release this could not read'
            }
          } else why = /\b404\b|not found/i.test(one.out) ? 'nothing - there is no stable release yet' : 'a release this desk could not reach GitHub to name'
        }
        say(
          `  Dev channel: ${pending.join(', ')} not yet promoted - stable installs are on ${stable?.tag_name ?? why ?? 'a release this could not read'}.`
        )
        // The one that goes next is the OLDEST pending build, because the soak is that
        // build's own age - newer ones ripen behind it rather than holding it back.
        const next = releases.filter((r) => r.prerelease).slice(-1)[0] ?? releases[0]
        const born = Date.parse(next?.published_at ?? '')
        const wait = Number.isFinite(born) ? Math.max(0, PROMOTE_SOAK_MS - (now() - born)) : null
        say(
          wait == null
            ? '  The oldest promotes to stable by itself once it has soaked; sooner by hand: node scripts/lane.mjs promote'
            : wait === 0
              ? `  ${next.tag_name} has soaked and promotes on the next poll; sooner by hand: node scripts/lane.mjs promote`
              : `  ${next.tag_name} auto-promotes in ~${Math.ceil(wait / 3600000)}h; sooner by hand: node scripts/lane.mjs promote`
        )
      }
    } catch {
      /* gh answered something unreadable - doctor stays quiet rather than guessing */
    }
  }
  say()

  // Status JSON reaches the board, but doctor is the existing human-facing recovery
  // surface. Keep discovered snapshots unmistakably separate from lanes and releases.
  if (s.parkedWork.length || s.unregisteredParked.length) {
    say('PARKED WORK')
    // pf-ctl is asked only when some item is still being finished; unknown never reads "gone".
    const unfinished = (p) => p.recovery && !['complete', 'reviewed', 'blocked'].includes(p.recovery.status)
    const living = s.parkedWork.some(unfinished) ? recoveryLiving() : null
    const panes = s.parkedWork.some((p) => unfinished(p) && !p.recovery.owner) ? openPanes() : null
    for (const p of s.parkedWork) {
      const r = p.recovery
      const gone = unfinished(p) ? (r.owner ? living && !living.has(r.owner) : panes && !panes.ids.includes(r.pane)) : false
      const state = !p.present ? 'ref is gone' : p.moved ? 'ref moved' : p.merged ? 'already on trunk'
        : r && ['complete', 'reviewed'].includes(r.status) ? `done (${r.status})`
        : r?.status === 'blocked' ? `blocked: ${String(r.reason ?? '').slice(0, 120)}`
        : r ? (gone ? `its finishing chat ${r.pane ?? r.owner} is gone; the next retry marks it blocked for inspection` : `being finished by ${r.pane ?? r.owner}`)
        : p.parkerGone ? 'the chat that parked it is gone; nobody is working on it'
        : p.reviewRequired ? 'review required' : 'registered'
      say(`  ${p.ref} (${p.commit.slice(0, 12)}): ${state}; ${p.action}`)
    }
    for (const p of s.unregisteredParked) say(`  ${p.ref} (${p.commit.slice(0, 12)}): unregistered; ${p.action}`)
    say()
  }

  // ---- debris: folders and branches that look like lanes and are not
  const registered = new Set(
    gitSafe(MAIN, 'worktree', 'list', '--porcelain')
      .out.split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => resolve(l.slice(9).trim()).toLowerCase())
  )
  const pool = new Set(POOL.map((id) => resolve(laneDir(id)).toLowerCase()))
  const strays = []
  const legacy = []
  try {
    for (const name of readdirSync(dirname(MAIN))) {
      if (!name.startsWith(`${basename(MAIN)}-`)) continue
      const dir = join(dirname(MAIN), name)
      if (!existsSync(dir)) continue
      const key = resolve(dir).toLowerCase()
      if (pool.has(key)) continue
      // A worktree git still knows about, at a path this repo's lanes never use: a lane
      // from the old `-w<N>` naming, which merges and sweeps normally but will never be
      // handed to a chat again. Worth naming so it is not mistaken for a live lane.
      if (registered.has(key)) legacy.push(dir)
      else strays.push(dir)
    }
  } catch {
    /* the parent folder is not readable - nothing to report rather than a crash */
  }
  const remotes = gitSafe(MAIN, 'branch', '-r', '--format=%(refname:short)')
    .out.split('\n')
    .map((b) => b.trim())
    .filter((b) => /^origin\/(lane-|pf\/w)/.test(b))

  if (strays.length || legacy.length || remotes.length) {
    say('LEFTOVERS')
    for (const dir of strays)
      say(`  ${dir} looks like a lane but git does not know about it. Nothing merges it and nothing will clean it up - check what is in it, then delete it.`)
    for (const dir of legacy) {
      const branch = gitSafe(dir, 'rev-parse', '--abbrev-ref', 'HEAD').out || '?'
      const ahead = gitCherry(MAIN, MB, branch).out.split('\n').filter((l) => l.startsWith('+')).length
      say(
        `  ${dir} is a lane from the old naming (${branch}). ` +
          (ahead
            ? `It still has ${ahead} commit${ahead === 1 ? '' : 's'} ${MB} does not have - merge it, and it is swept once it is empty.`
            : `Everything in it is already in ${MB}: git worktree remove "${dir}" && git branch -d ${branch}`)
      )
    }
    for (const b of remotes)
      say(`  ${b} is a lane branch on the remote. Lanes are local scratch, so this only makes GitHub look like work is behind: git push origin --delete ${b.replace(/^origin\//, '')}`)
    say()
  }

  // What the sweep removed, so a folder that vanished can be traced to where its work went.
  const swept = (read().swept ?? []).filter((r) => now() - r.at < 7 * 24 * 60 * 60 * 1000)
  if (swept.length) {
    say('CLEANED UP')
    for (const r of swept) say(`  ${ago(r.at)} ago: ${r.text}`)
    say()
  }

  return out.join('\n')
}

// ---------------------------------------------------------------- sweep: folders nobody uses

// Measured 2026-09-23: taskdriver.ai had 18 checkout folders, ~36 GB, on a disk 94% full.
// Nothing above ever deleted one - `idleEmpty` frees a ledger row, never a folder - and a
// checkout that is not `<repo>-<letter>` was invisible to this file altogether. Lane folders
// come back in minutes when a chat needs one (lane c was deleted at 05:11 and made again at
// 05:12). A lane folder goes as soon as its work is all in the project and nothing uses it
// (keepReason); a folder somebody made by hand for a branch gets three idle days.
const SWEEP_OTHER_IDLE_MS = 3 * 24 * 60 * 60 * 1000
/** Rebuilt by an install or a build, so never archived. One `production-build` was 2.1 GB and stalled a tar for 7 minutes. */
const REGENERABLE =
  /(^|\/)(node_modules|\.next(-[^/]*)?|production-build|build|dist|\.turbo|__pycache__|\.pytest_cache|\.cache|coverage|test-results|playwright-report|\.codegraph|graphify-out|ios-derived-data)(\/|$)|\.tsbuildinfo$|(^|\/)\.DS_Store$/
const TAR_EXCLUDES = ['node_modules', '.next*', 'production-build', 'build', 'dist', '.turbo', '__pycache__']
/**
 * Windows' own tar (bsdtar, System32\tar.exe), named outright. A shell started from Git for
 * Windows - Git Bash, every chat's Bash tool - puts GNU tar first on PATH, and GNU tar reads
 * the `C:` in `-czf C:\...\x.tgz` as a remote host ("Cannot connect to C: resolve failed"),
 * so the sweep kept every finished lane it was asked to archive. GNU's `--force-local` is
 * refused by bsdtar, so pick the binary instead of a flag.
 */
const SYSTEM_TAR = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
const TAR = process.platform === 'win32' && existsSync(SYSTEM_TAR) ? SYSTEM_TAR : 'tar'
const SWEEP_KEEP = 20
/** How often `retry` starts a sweep. Folders only become removable after six idle hours anyway. */
const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000
const SWEEP_STAMP = join(commonDir, 'paneforge-sweep-at')

/**
 * Whether a sweep is due, taking the slot when it is. Stamped BEFORE the sweep runs, so one
 * that crashes or is killed waits its six hours rather than restarting on every retry tick.
 * A repo with no stamp only starts the clock: the first sweep happens six hours after the
 * first retry, never in the first minute of a repo lanes have just met - or of a test's.
 */
function sweepDue() {
  let last = null
  try {
    last = Number(readFileSync(SWEEP_STAMP, 'utf8').trim()) || 0
  } catch {
    /* never swept */
  }
  if (last !== null && now() - last < SWEEP_EVERY_MS) return false
  try {
    writeFileSync(SWEEP_STAMP, `${now()}\n`, 'utf8')
  } catch {
    return false // a stamp that cannot be written would sweep on every tick
  }
  return last !== null
}

const pathKey = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))
/** `child` is `dir` or somewhere under it. */
const within = (child, dir) => {
  const c = pathKey(child)
  const d = pathKey(dir)
  return c === d || c.startsWith(d.endsWith(sep) ? d : d + sep)
}
/** How a folder is named to a person: beside the project when it is, its full path when not. */
function folderWords(dir) {
  const rel = relative(dirname(MAIN), dir)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : dir
}
const stamp = (t = new Date()) => t.toISOString().slice(0, 10).replace(/-/g, '')

/** Every checkout of this repo git knows about, the main folder excluded. */
function worktreesOf() {
  const r = gitSafe(MAIN, 'worktree', 'list', '--porcelain')
  if (!r.ok) throw new Error(`could not list this project's folders: ${firstLine(r.out)}`)
  return r.out
    .split(/\n\s*\n/)
    .map((block) => ({
      dir: /^worktree (.+)$/m.exec(block)?.[1]?.trim(),
      head: /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1] ?? null,
      branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]?.trim() ?? null,
      locked: /^locked\b/m.test(block),
      prunable: /^prunable\b/m.test(block)
    }))
    .filter((w) => w.dir && pathKey(w.dir) !== pathKey(MAIN))
}

/**
 * The folders PaneForge has a live pane in, from `pf list` - or null when the app could not
 * be asked. Null stops the whole sweep: "no panes" and "no answer" must never read the same.
 * `LANE_PANES_FILE` stands in for the app in tests (the same five tab-separated columns).
 */
function openPanes() {
  let out
  if (process.env.LANE_PANES_FILE) {
    try {
      out = readFileSync(process.env.LANE_PANES_FILE, 'utf8')
    } catch {
      return null
    }
  } else {
    const env = { ...process.env }
    // pf-ctl exits 0 having asked nothing when this is set - an empty list that is not one.
    delete env.PF_CTL_NO_APP
    const r = spawnSync(process.execPath, [join(here, 'pf-ctl.mjs'), 'list'], {
      encoding: 'utf8',
      timeout: 30_000,
      env,
      windowsHide: true
    })
    if (r.status !== 0) return null
    out = r.stdout ?? ''
  }
  const rows = out.split('\n').filter((l) => l.trim()).map((l) => l.split('\t'))
  // A row is `card number, pane id, state, title, folder` (`pf-ctl.mjs list`). The first
  // column is the NUMBER on the card, so ids read from it never matched a pane id and a
  // live completion pane was marked ended 10 min after it opened (2026-10-02).
  if (rows.some((c) => c.length < 5 || !c[1].trim() || !c[4].trim())) return null
  return {
    ids: rows.map((c) => c[1].trim()),
    // Every listed pane, `exited` included: an ASLEEP pane lists as exited and wakes back
    // into its folder, so a removed folder would be a pane resuming into nothing.
    dirs: rows.map((c) => c[4].trim())
  }
}

function openPaneDirs() { return openPanes()?.dirs ?? null }

/**
 * Where every process on this computer is running from: a dev server or a terminal left in
 * a folder is somebody using it, pane or not. macOS/Linux only (`lsof`); an empty answer on
 * Windows is unknown, so automatic recovery/sweep fail closed. Null = could not be asked.
 */
function processDirs() {
  if (process.env.LANE_PROCESSES_FILE) {
    try {
      const dirs = JSON.parse(readFileSync(process.env.LANE_PROCESSES_FILE, 'utf8'))
      return Array.isArray(dirs) && dirs.every((d) => typeof d === 'string' && isAbsolute(d)) ? dirs : null
    } catch { return null }
  }
  if (process.platform === 'win32') return null
  const r = spawnSync('lsof', ['-a', '-d', 'cwd', '-Fn'], { windowsHide: true, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })
  // A partial lsof answer is unknown activity, not an empty or complete inventory.
  if (r.status !== 0 || !r.stdout) return null
  return r.stdout
    .split('\n')
    .filter((l) => l.startsWith('n/'))
    .map((l) => l.slice(1))
}

/**
 * The newest change anywhere in a checkout, or anything newer than `since` - the walk
 * stops at the first file that proves the folder is in use, so a busy one costs a handful
 * of stats. Dependencies and build output are skipped: an install is not somebody working.
 * The checkout's own HEAD and reflog are counted too, because a commit changes no file.
 * The index is NOT: any read-only `git status` rewrites it when a file's stat data moved
 * (this script's own `retry` did, so the sweep it started read every folder as used a
 * moment ago and removed nothing; PaneForge's card badge runs `git status` too).
 */
function newestTouch(dir, since, gitState = true) {
  let newest = 0
  const see = (p) => {
    try {
      newest = Math.max(newest, lstatSync(p).mtimeMs)
    } catch {
      /* gone while we looked */
    }
  }
  const gitDir = gitSafe(dir, 'rev-parse', '--absolute-git-dir')
  if (gitState && gitDir.ok) for (const f of ['HEAD', join('logs', 'HEAD')]) see(join(gitDir.out, f))
  const stack = [dir]
  while (stack.length && newest <= since) {
    const d = stack.pop()
    see(d)
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.next')) continue
      const p = join(d, e.name)
      if (e.isDirectory()) stack.push(p)
      else see(p)
      if (newest > since) break
    }
  }
  return newest
}

/**
 * Why this folder must stay, or null when it is a candidate. `ctx` is read once per sweep;
 * `ctx.idle === false` skips the clock, for the last-moment re-check after this sweep's own
 * `git status` may have refreshed the folder's index.
 */
function keepReason(w, ctx) {
  if (w.locked) return 'somebody locked it on purpose'
  const id = POOL.find((l) => l !== 'main' && pathKey(laneDir(l)) === pathKey(w.dir)) ?? null
  const state = read()
  if (id && state.lanes[id]) return 'a chat holds it'
  if (Object.values(state.lanes).some((c) => c.cwd && within(c.cwd, w.dir))) return 'a chat is working in it'
  if (id && (state.ready[id] || state.conflicts[id])) return 'its finished work is still waiting to go out'
  if (ctx.all.some((o) => o.dir !== w.dir && within(o.dir, w.dir))) return 'another checkout sits inside it'
  if (ctx.panes.some((p) => within(p, w.dir))) return 'a PaneForge pane is open in it'
  const work = unmergedWork(w)
  if (work) return work
  // A lane folder whose work is all in the project is removed as soon as nothing is using
  // it: the copies are the app's scratch, and a finished one left on disk is what Robert
  // saw as "other copies (6)", every row saying `done` (2026-09-23). A folder somebody made
  // by hand for a branch still gets its three idle days.
  if (ctx.idle !== false && !id) {
    const limit = SWEEP_OTHER_IDLE_MS
    const touched = newestTouch(w.dir, now() - limit)
    if (touched > now() - limit) return `it was used ${ago(touched)} ago`
  }
  // Last, because it is the one slow question (one lsof, ~4s) and most folders never reach it.
  ctx.procs ??= processDirs()
  if (ctx.procs === null) return 'could not check whether a program is running in it'
  if (ctx.procs.some((p) => within(p, w.dir))) return 'a program is running in it'
  return null
}

/**
 * What a folder holds that the project does not have yet, or null when everything in it is
 * already on origin's trunk. A folder with ANY such work is never removed - not after six
 * idle hours, not with its work pushed somewhere first: to a person who does not read git,
 * work that now lives only on a `wip/` branch is work that disappeared (brief 2026-09-23).
 * Ignored files are not work in this sense; sweepOne archives the ones nothing rebuilds.
 */
function unmergedWork(w) {
  const ahead = gitSafe(w.dir, 'rev-list', '--count', `origin/${MB}..HEAD`)
  if (!ahead.ok) return 'could not check whether its work is in the main copy'
  const commits = Number(ahead.out.trim()) || 0
  if (commits) return `it has ${commits} saved change${commits === 1 ? '' : 's'} not in the main copy yet`
  const status = gitSafe(w.dir, 'status', '--porcelain')
  if (!status.ok) return 'could not check it for unsaved changes'
  const files = status.out.split('\n').filter(Boolean).length
  if (files) return `it has ${files} unsaved file${files === 1 ? '' : 's'}`
  return null
}

/** Push `spec` to origin; true when origin took it. */
function pushed(spec) {
  return gitSafe(MAIN, 'push', '--quiet', 'origin', spec).ok
}

/** Origin (not a stale or foreign remote) has `sha` on some branch. Fetch first. */
function onOrigin(sha) {
  return Boolean(gitSafe(MAIN, 'branch', '-r', '--contains', sha, '--list', 'origin/*').out.trim())
}

/**
 * The folder's whole working state as a git tree - committed, staged, edited and untracked
 * (not ignored) - built in a private index so the folder's own staging is never touched.
 */
function workTree(dir, label) {
  const tmpIndex = join(tmpdir(), `lane-sweep-${process.pid}-${label}.index`)
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex }
  const run = (...args) =>
    execFileSync('git', args, { windowsHide: true, cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60_000 }).trim()
  try {
    copyFileSync(resolve(dir, git(dir, 'rev-parse', '--git-path', 'index')), tmpIndex)
    run('add', '-A')
    return run('write-tree')
  } finally {
    try {
      unlinkSync(tmpIndex)
    } catch {
      /* never made */
    }
  }
}

/**
 * Save everything in one folder where it survives the folder, then remove it. Returns the
 * sentence to report, or throws with the reason nothing was removed. The order is the
 * zero-loss order from the 2026-09-23 cleanup, which ran for real on taskdriver.ai:
 * commits to origin, unsaved edits to origin as a snapshot commit, untracked and ignored
 * files to an archive, proof on origin, a last look that nothing moved meanwhile, and only
 * then the removal.
 */
function sweepOne(w) {
  const started = now()
  const name = basename(w.dir)
  const wip = `wip/${name}-${stamp()}`
  if (!gitSafe(MAIN, 'fetch', '--quiet', '--prune', 'origin').ok) throw new Error('origin could not be reached to check what it has')
  const head = git(w.dir, 'rev-parse', 'HEAD')
  const subject = git(w.dir, 'log', '-1', '--format=%s', head)
  // A deploy-on-push repo builds a `release:` tip; pushing one is a release, never a backup.
  if (/^release\b/i.test(subject)) throw new Error(`its last commit is a release ("${subject.slice(0, 60)}"), which is not pushed without a person`)

  const savedAs = []
  // 1. A named branch goes up under its own name, unless origin already has exactly this.
  //    Asked first: with nothing to send, git hands a pre-push hook no ref lines, and
  //    taskdriver's hook reads that as a hand-typed push and demands proof from the PC.
  //    Never the trunk or a lane branch: a push to the trunk is a release in a deploy-on-
  //    push repo, and lane branches are scratch - both go up as a snapshot below instead.
  if (w.branch && w.branch !== MB && !/^lane-/.test(w.branch)) {
    const there = gitSafe(MAIN, 'ls-remote', 'origin', `refs/heads/${w.branch}`)
    if (!there.ok) throw new Error('origin could not be asked what it has')
    if (there.out.split(/\s/)[0] === head || pushed(`${head}:refs/heads/${w.branch}`)) savedAs.push(w.branch)
  }
  // 2. Unsaved edits become a commit whose parent is HEAD, so it carries the folder's
  //    commits too.
  const headTree = git(w.dir, 'rev-parse', `${head}^{tree}`)
  const tree = workTree(w.dir, name)
  const keep =
    tree === headTree ? head : git(w.dir, 'commit-tree', tree, '-p', head, '-m', `wip: ${name} - unsaved edits, kept before the folder was removed (${stamp()})`)
  // 3. Whatever origin still lacks - the snapshot, or commits only this folder has - goes
  //    up as `wip/<folder>-<date>`.
  if (keep !== head || (!savedAs.length && !onOrigin(head))) {
    // Same folder swept twice in a day (lanes come back): the second snapshot gets a time.
    const later = `${wip}-${Date.now()}`
    const as = pushed(`${keep}:refs/heads/${wip}`) ? wip : pushed(`${keep}:refs/heads/${later}`) ? later : null
    if (!as) throw new Error(keep !== head ? 'its unsaved edits could not be sent to origin' : 'its commits could not be sent to origin')
    savedAs.push(as)
  }

  // 4. Files git does not keep, to an archive. Only the ones nothing can rebuild. NUL-
  //    separated end to end: a quoted non-ASCII name would fail the tar on every sweep.
  let archive = null
  const listed = [
    ...gitSafe(w.dir, 'ls-files', '-z', '-o', '--exclude-standard', '--directory').out.split('\0'),
    ...gitSafe(w.dir, 'ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory').out.split('\0')
  ]
  const files = [...new Set(listed.filter((f) => f && !REGENERABLE.test(f.replace(/\/$/, ''))))]
  if (files.length) {
    const dir = join(homedir(), '.local', 'share', 'worktree-archive', stamp())
    mkdirSync(dir, { recursive: true })
    archive = join(dir, `${name}.tgz`)
    if (existsSync(archive)) archive = join(dir, `${name}-${Date.now()}.tgz`)
    const list = join(tmpdir(), `lane-sweep-${process.pid}-${name}.list`)
    writeFileSync(list, files.join('\0') + '\0', 'utf8')
    try {
      const tar = spawnSync(
        TAR,
        ['-czf', archive, ...TAR_EXCLUDES.map((x) => `--exclude=${x}`), '-C', w.dir, '--null', '-T', list],
        { encoding: 'utf8', timeout: 15 * 60_000, windowsHide: true }
      )
      if (tar.status !== 0) throw new Error(`its untracked files could not be archived: ${firstLine(`${tar.stderr}${tar.error?.message ?? ''}`)}`)
      const check = spawnSync(TAR, ['-tzf', archive], { encoding: 'utf8', timeout: 5 * 60_000, maxBuffer: 256 * 1024 * 1024, windowsHide: true })
      if (check.status !== 0) throw new Error('the archive of its untracked files did not read back')
    } finally {
      try {
        unlinkSync(list)
      } catch {
        /* already gone */
      }
    }
  }

  // 5. Proof, not intent: after a fresh fetch, ORIGIN must hold the commit this folder is on
  //    (or the snapshot that carries it). A push that "worked" and is not there is not a backup.
  if (!gitSafe(MAIN, 'fetch', '--quiet', '--prune', 'origin').ok || !onOrigin(keep))
    throw new Error('origin does not have its latest commit, so it was kept')

  // 6. The minutes the pushes and the tar took are minutes somebody could have come back.
  //    Every question again - a fresh process list included - plus: no file in it written
  //    since this started, the same commit, the same unsaved work.
  const again = keepReason(w, { all: worktreesOf(), panes: openPaneDirs() ?? [w.dir], procs: processDirs(), idle: false })
  if (again) throw new Error(`kept at the last moment: ${again}`)
  if (newestTouch(w.dir, started, false) > started) throw new Error('kept at the last moment: something in it changed while it was being saved')
  if (git(w.dir, 'rev-parse', 'HEAD') !== head || workTree(w.dir, `${name}-again`) !== tree)
    throw new Error('kept at the last moment: its work changed while it was being saved')
  const on = /github\.com/i.test(gitSafe(MAIN, 'remote', 'get-url', 'origin').out) ? 'GitHub' : 'the server'
  const saved = `${savedAs.length ? `its work is on ${on} as ${savedAs.join(' and ')}` : `everything in it was already on ${on}`}${archive ? `; files git does not keep are in ${archive}` : ''}`

  // Moved aside whole, then deleted. `git worktree remove` ran under git()'s 20-second limit
  // and was killed part way through a big folder: taskdriver.ai-c lost 36 of its 45 top-level
  // entries at 6:23am on 2 Oct, kept its name and its registration, and a chat was then sent
  // into the half-empty copy. A move is all or nothing, so the copy's own folder is either
  // whole or gone, and whatever a stopped delete leaves sits under a name nothing opens
  // until the next sweep finishes it. On Windows the move also answers what lsof answers
  // elsewhere: a folder a program has something open in cannot be moved there.
  dropModulesLink(w.dir)
  if (isLink(join(w.dir, 'node_modules'))) throw new Error("its link to the main copy's dependencies could not be taken out, and deleting through it would delete those")
  const aside = `${w.dir}${ASIDE}${Date.now()}`
  try {
    renameSync(w.dir, aside)
  } catch (e) {
    throw new Error(process.platform === 'win32' ? 'kept at the last moment: a program has something in it open' : `it could not be moved out of the way to be removed (${e.code ?? e.message})`)
  }
  // Written down before the delete starts: a sweep that dies part way still leaves the
  // next one a note of what to finish.
  const state = read()
  state.leftovers = [...(state.leftovers ?? []), aside]
  write(state)
  // Its pointer into this project's git goes first, so nothing left behind can reach a copy
  // git later gives the same name; then git forgets the folder, which frees its branch.
  rmSync(join(aside, '.git'), { force: true })
  gitSafe(MAIN, 'worktree', 'prune')
  const stopped = deleteAside(aside)
  if (stopped) {
    const e = new Error(`the delete stopped part way (${stopped})`)
    e.record = `Could not finish removing the ${folderWords(w.dir)} folder (${saved}). The delete stopped part way (${stopped}); what is left is in ${aside}, and the next clean-up tries again.`
    throw e
  }
  return `Removed the ${folderWords(w.dir)} folder (${saved}).`
}

/** The ending a folder gets while it is being deleted (`sweepOne`). */
const ASIDE = '.removing-'

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/** Delete a folder moved aside by `sweepOne`. Null when it is gone, else why it stopped. */
function deleteAside(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    return null
  } catch (e) {
    return e.code ?? e.message
  }
}

/**
 * `lane.mjs sweep [--dry-run]`: remove the checkout folders nobody is using, never their
 * work. Lane folders with no chat, no pane, no program in them and no change for six hours;
 * any other checkout of this repo after three days. Every removal is reported in
 * `state.swept`, which `doctor` prints. Returns the lines to show.
 */
function sweep({ dryRun = false } = {}) {
  // Started by several clocks and events now (retry, ready, release, ship, a pane closing
  // in the app), so two can meet. One at a time per repo; the second has nothing to add.
  const unlock = dryRun ? () => {} : sweepLock()
  if (!unlock) return ['Nothing removed: another sweep of this project is running.']
  try {
    return sweepOnce({ dryRun })
  } finally {
    unlock()
  }
}

const SWEEP_LOCK = join(commonDir, 'paneforge-sweep.lock')
/** A sweep that died holding the lock frees it after this long (archiving one big folder took 7 min). */
const SWEEP_LOCK_STALE_MS = 60 * 60 * 1000

/** The process is running (signal 0 asks without sending anything). */
function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

/** Whether a live process holds the lock `file` (one older than `staleMs` holds nothing). */
function lockHeld(file, staleMs) {
  let pid = 0
  let at = 0
  try {
    ;[pid, at] = readFileSync(file, 'utf8').trim().split(/\s+/).map(Number)
  } catch {
    /* no lock, or it vanished meanwhile */
  }
  return Boolean(pid && now() - at < staleMs && processAlive(pid))
}

/** Take the lock `file`, or null when a live process holds it (stale after `staleMs`). Returns the release. */
function takeLock(file, staleMs) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, `${process.pid} ${now()}\n`, { flag: 'wx' })
      return () => {
        try {
          unlinkSync(file)
        } catch {
          /* already gone */
        }
      }
    } catch {
      if (lockHeld(file, staleMs)) return null
      try {
        unlinkSync(file)
      } catch {
        /* someone else cleared it */
      }
    }
  }
  return null
}

/** Take the sweep lock, or null when a live sweep holds it. Returns the release. */
function sweepLock() {
  return takeLock(SWEEP_LOCK, SWEEP_LOCK_STALE_MS)
}

/**
 * Start a sweep in the background. Detached: archiving one big folder took 7 minutes on
 * 2026-09-23 and nothing that calls this should wait on it. What it removes lands in
 * `state.swept`, which doctor prints.
 */
function sweepSoon() {
  try {
    spawn(process.execPath, [fileURLToPath(import.meta.url), 'sweep', '--repo', MAIN], {
      cwd: MAIN,
      // A hook's deadline is the hook's: inherited, it cuts every git call in a sweep that
      // runs on long after the hook has returned.
      env: { ...process.env, PANEFORGE_HOOK_DEADLINE: '' },
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }).unref()
  } catch {
    /* no sweep this time; the next landing or the six-hour clock starts one */
  }
}

function sweepOnce({ dryRun }) {
  const out = []
  const panes = openPaneDirs()
  if (panes === null) return ['Nothing removed: PaneForge could not be asked which folders have a pane open (is it running with Phone on?).']
  if (!dryRun && !hasOrigin()) return ['Nothing removed: this project has no origin to keep a copy of the work on.']
  if (!dryRun) gitSafe(MAIN, 'fetch', '--quiet', 'origin')
  const all = worktreesOf()
  const ctx = { all, panes, procs: undefined }
  const removed = []
  // What a stopped delete left (`sweepOne`) goes first. Its work was proven on origin before
  // it was moved aside, and nothing opens a folder by that name, so no keep question applies.
  for (const dir of read().leftovers ?? []) {
    if (!existsSync(dir)) continue
    const name = folderWords(dir).replace(/\.removing-\d+$/, '')
    if (dryRun) {
      out.push(`Would finish removing the ${name} folder: an earlier clean-up had to leave it part way.`)
      continue
    }
    const stopped = deleteAside(dir)
    if (stopped) {
      // Written down once, by the sweep that moved it aside, with where its work went.
      out.push(`Could not finish removing the ${name} folder: the delete stopped part way (${stopped}). What is left is in ${dir}, and the next clean-up tries again.`)
      continue
    }
    const text = `Finished removing the ${name} folder, which an earlier clean-up had to leave part way.`
    out.push(text)
    removed.push(text)
  }
  for (const w of all) {
    const name = folderWords(w.dir)
    if (w.prunable || !existsSync(w.dir)) continue
    const why = keepReason(w, ctx)
    if (why) {
      out.push(`Keeping ${name}: ${why}.`)
      continue
    }
    if (dryRun) {
      out.push(`Would remove ${name} (${w.branch ?? 'no branch'}): everything in it is already in the main copy.`)
      continue
    }
    try {
      removed.push(sweepOne(w))
      out.push(removed[removed.length - 1])
    } catch (e) {
      out.push(e.record ?? `Kept ${name}: ${e.message}.`)
      // A delete that started and stopped is written down: unrecorded, the half-empty
      // taskdriver.ai-c of 2 Oct could only be traced back to a sweep by guesswork.
      if (e.record) removed.push(e.record)
    }
  }
  if (!dryRun) {
    gitSafe(MAIN, 'worktree', 'prune')
    const state = read()
    const left = (state.leftovers ?? []).filter((dir) => existsSync(dir))
    if (removed.length || left.length !== (state.leftovers ?? []).length) {
      state.leftovers = left
      state.swept = [...(state.swept ?? []), ...removed.map((text) => ({ at: now(), text }))].slice(-SWEEP_KEEP)
      write(state)
    }
  }
  return out
}

// ---------------------------------------------------------------- entry

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'status'
const arg = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ??
  (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined)

try {
  // `{"lanes": false}` in a repo's .lanes.json is that repo saying it does not want any of
  // this. The hook obeys it too, but the engine is where it has to be final: a chat that
  // runs a lane command by hand in an opted-out repo must not create a worktree in it.
  if (!PROFILE.enabled && cmd !== 'status') {
    console.log(`${basename(MAIN)} has lanes turned off in its .lanes.json - nothing done.`)
    process.exit(0)
  }
  if (cmd === 'prepush') prepush()
  // Never allowed to break the command that was asked for.
  try {
    installPushGate()
  } catch {
    /* a hook that cannot be written is reported by doctor */
  }
  const session = arg('session')
  const sayBuilt = (b) =>
    b?.by === 'local'
      ? // Not "Actions is disabled" any more. It WAS, for two days in July, and the sentence
        // outlived the outage by a week - printed on every release while Actions was green
        // and building the very same installers. Say what was observed (no run appeared in
        // time) rather than the reason we guessed for it, because when both publish the
        // feed can end up describing the other build: see reconcileFeed.
        'No GitHub Actions run appeared for this tag in time, so this machine built and published the installer itself. If Actions was merely slow it will publish too; the feed is checked and repaired on the retry timer. Running copies update within 30 minutes.'
      : b?.by === 'failed'
        ? `Tag is pushed but NO installers exist: ${b.reason}. Fix and run: node scripts/lane.mjs ship`
        : 'GitHub is building Windows and macOS. Dev-channel copies update within 30 minutes; stable installs move only when this build is promoted (node scripts/lane.mjs promote, once it has proved itself).'
  const sayRelease = (r) => {
    if (!r) return
    if (r.shipped) {
      // Only lanes whose commits were PROVED on origin may be named here. Naming the ones
      // that were merely attempted is how a chat reads its own unshipped fix as gone out.
      const went = (r.merged ?? []).filter((m) => !(r.unproved ?? []).some((u) => u.lane === m.lane))
      const lanes = went.length ? ` (lanes ${went.map((m) => m.lane).join(', ')})` : ''
      // No version means this repo merges rather than releases: say what actually
      // happened. "Released vnull" is how a message stops being read at all.
      if (r.version) {
        console.log(`Released v${r.version} automatically${lanes}.`)
        console.log(sayBuilt(r.built))
      } else {
        console.log(`Finished work merged into ${MB}${RELEASE === 'merge' ? ' and pushed' : ''}${lanes}.`)
      }
    } else if (r.reason && r.reason !== 'nothing to release') {
      console.log(`No release yet: ${r.reason}`)
    }
    // Said on every path, shipped or not: a lane left behind with nothing recorded against
    // it is indistinguishable from one that went out.
    for (const u of r.unproved ?? [])
      console.log(
        `Lane ${u.lane} is NOT out - ${u.why}. It keeps its ready mark and goes with the next release.`
      )
    for (const b of r.blocked ?? [])
      console.log(`Lane ${b.lane} is NOT out - ${b.why}. It keeps its ready mark and goes with the next release.`)
    for (const k of r.skipped ?? []) console.log(`Lane ${k.lane} had nothing to merge - ${k.why}.`)
    if (r.renamed?.length) console.log(`Renumbered migration files that took a number ${MB} already used: ${r.renamed.join(', ')}`)
    for (const [id, c] of Object.entries(r.conflicts ?? {})) {
      console.log(
        `Lane ${id} is finished but conflicts with ${MB}, so it was left out of the release. ` +
          `It is retried by itself every ${Math.round(RETRY_MS / 60000)}m and goes out on its own if ${MB} stops ` +
          `disagreeing with it. To finish it now: node ${join(own, 'scripts', 'lane.mjs')} resolve --repo ${MAIN} --session <id> --lane ${id} ` +
          `(opens the merge in ${c.dir}).`
      )
    }
  }

  if (cmd === 'claim') {
    // The hook always says where its chat is; a chat typing this itself usually does not,
    // and its own working directory is the answer it would have given. Better a folder
    // that might be a PaneForge checkout than a hold nothing can put a name to.
    const info = claim(session, arg('cwd') ?? process.cwd(), arg('prefer'), argv.includes('--tentative'), argv.includes('--visitor'))
    // `--status`: the held-only roster in the same answer, so the prompt hook starts this
    // 4,000-line engine once per prompt instead of twice (claim, then status): measured
    // ~150 ms of the hook's remaining ~500 ms was the second node start.
    if (argv.includes('--status')) info.status = status(session, { held: true })
    console.log(JSON.stringify(info, null, 2))
  } else if (cmd === 'guard') {
    const reason = guard(session, arg('path'))
    if (reason) {
      console.log(reason)
      process.exit(2)
    }
    // Allowed. Exit 0 with text is a heads-up, never a refusal: the hook folds it into
    // the edit's context and the edit goes ahead.
    const warn = overlap(session, arg('path'))
    if (warn) console.log(warn)
  } else if (cmd === 'ready') {
    const snapshot = read()
    if (snapshot.recoveryError) throw new Error(snapshot.recoveryError)
    const recovering = Object.values(snapshot.recovery.items).some((r) => r.owner === session && !['complete', 'reviewed'].includes(r.status))
    const unlock = recovering ? recoveryLock() : null
    if (recovering && !unlock) throw new Error('another recovery transaction owns this repository')
    let r
    try { r = ready(session, arg('lane')) } finally { unlock?.() }
    console.log(`Lane ${r.lane} marked done${r.commits ? ` (${r.commits} commit${r.commits === 1 ? '' : 's'})` : ''}.`)
    if (r.renamed?.length) console.log(`Renumbered migration files that took a number ${MB} already used: ${r.renamed.join(', ')}`)
    sayRelease(r.release)
    // Work that just landed leaves a folder with nothing in it; it goes once its chat lets go.
    if (r.release?.shipped) sweepSoon()
  } else if (cmd === 'resolve') {
    const r = resolveConflict(session, arg('lane'))
    if (r.nothingOwn) {
      console.log(`Lane ${r.lane} had nothing ${MB} does not already have, so it now matches ${MB} - nothing to resolve and nothing to ship.`)
    } else if (r.resolved) {
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
    // `--gone` is passed only by the app's reclaim sweep (src/main/laneBoard.ts), which has
    // asked every running copy and found no pane hosting this chat. `--cleared` only by
    // lane-hook's SessionEnd for /clear.
    const r = releaseClaim(session, { gone: argv.includes('--gone'), cleared: argv.includes('--cleared') })
    if (r.marked) console.log(`Lane ${r.marked.lane} had finished work - marked done on the way out.`)
    sayRelease(r.release)
    // The chat let go of its folder: the moment a finished copy becomes removable.
    sweepSoon()
  } else if (cmd === 'sleep') {
    console.log(JSON.stringify(sleepLane(session, arg('pane') ?? PANE)))
  } else if (cmd === 'wake') {
    console.log(JSON.stringify(wakeLane(session, arg('pane') ?? PANE)))
  } else if (cmd === 'park') {
    // The Stop hook: this chat's turn ended. Holds on clean lanes are marked parked so a
    // chat that needs one takes it in minutes; the mark clears itself on the next claim.
    const r = park(session, { ended: argv.includes('--ended'), ref: arg('ref'), lane: arg('lane') })
    console.log(JSON.stringify(r))
  } else if (cmd === 'autoship') sayRelease(autoship((argv[1] && !argv[1].startsWith('--') ? argv[1] : 'auto').toLowerCase(), session ?? 'auto'))
  else if (cmd === 'ship') {
    const r = ship((argv[1] && !argv[1].startsWith('--') ? argv[1] : 'auto').toLowerCase(), session)
    if (r.shipped) {
      console.log(r.version ? `Shipped v${r.version}.` : `Merged into ${MB}${RELEASE === 'merge' ? ' and pushed' : ''}.`)
      const went = r.merged.filter((m) => !r.unproved?.some((u) => u.lane === m.lane))
      if (went.length) console.log(`Included lanes: ${went.map((m) => m.lane).join(', ')}`)
      // Never silent: a lane that was passed over, or one whose merge could not be proved on
      // origin, is named here rather than being left to look like one that went out.
      for (const u of r.unproved ?? [])
        console.log(`Lane ${u.lane} is NOT out - ${u.why}. It keeps its ready mark and goes with the next release.`)
      for (const b of r.blocked ?? [])
        console.log(`Lane ${b.lane} is NOT out - ${b.why}. It keeps its ready mark and goes with the next release.`)
      for (const k of r.skipped ?? []) console.log(`Lane ${k.lane} had nothing to merge - ${k.why}.`)
      if (r.rebased.length) console.log(`Lanes brought up to date: ${r.rebased.join(', ')}`)
      if (r.renamed?.length) console.log(`Renumbered migration files that took a number ${MB} already used: ${r.renamed.join(', ')}`)
      if (r.version) console.log(sayBuilt(r.built))
    } else {
      console.log(`Not shipped: ${r.reason}`)
      for (const b of r.blocked ?? [])
        console.log(`Lane ${b.lane} is NOT out - ${b.why}. It keeps its ready mark and goes with the next release.`)
    }
  } else if (cmd === 'promote') {
    const r = promote(argv[1] && !argv[1].startsWith('--') ? argv[1] : '')
    if (r.promoted)
      console.log(
        `Promoted ${r.tag}. /releases/latest now serves it, and every stable install updates within the half hour.`
      )
    else console.log(`Not promoted: ${r.reason}`)
  } else if (cmd === 'finish-copy') {
    // By hand, for a copy the chooser keeps passing over: the same proof, and the reason when it fails.
    const lane = arg('lane')
    if (!lane || !POOL.includes(lane) || lane === 'main') throw new Error('finish-copy needs --lane <letter> from this repo\'s pool')
    const done = finishCopy(lane, read())
    console.log(JSON.stringify({ lane, ...done }))
    if (!done.finished) throw new Error(`lane ${lane} not finished: ${done.why}`)
  } else if (cmd === 'recover') {
    console.log(JSON.stringify(recover(session, arg('key'), arg('disposition'), arg('receipt'), arg('lane'))))
  } else if (cmd === 'retry') {
    const unlock = recoveryLock()
    if (!unlock) process.exit(0)
    try {
    // Invalid state is unknown ownership, never an empty repository.
    JSON.parse(readFileSync(STATE, 'utf8'))
    // Every other retry rides on a chat happening to run a lane command, so on a quiet
    // machine a conflict was never re-tried at all: it stayed on the strip long after the
    // change it disagreed with had shipped. The app calls this on a timer instead. When
    // master has not moved and RETRY_MS has not passed this is one `rev-parse` per lane.
    const state = reap(read())
    if (state.recoveryError) throw new Error(state.recoveryError)
    // The timer is also what puts a main folder left on a side branch back, before anything
    // below merges into it. Said once when it changes, not on every tick.
    {
      const before = state.trunk?.at
      trunkHome(state)
      if (state.trunk && state.trunk.at !== before) console.log(state.trunk.text)
    }
    // Conflicts retain their established resolver path. Unready orphan work below gets
    // one preservation and verification owner instead of an unchecked ready mark.
    const before = Object.keys(state.conflicts)
    if (retryConflicts(state)) write(state)
    const cleared = before.filter((id) => !state.conflicts[id])
    if (cleared.length) console.log(`Lane${cleared.length === 1 ? '' : 's'} ${cleared.join(', ')} merge cleanly now.`)
    else if (before.length) console.log(`Still conflicted: ${before.join(', ')}.`)
    // What is left is a real disagreement. One nobody is on gets one card for a person.
    const sent = clashCards(state)
    if (sent.length) {
      // Each card took up to 20 s to post; a chat's claim or release written meanwhile must survive.
      const fresh = read()
      for (const o of sent) if (fresh.conflicts[o.id]) fresh.conflicts[o.id].card = state.conflicts[o.id].card
      write(fresh)
      for (const o of sent) console.log(`Lane ${o.id} still conflicts and nobody is on it - raised one card for a person (${o.via}).`)
    }
    const completion = dispatchCompletion()
    if (completion) console.log(`Preserved work ${completion.key} has one verification owner (${completion.pane}).`)
    // And then try the release, every time. Every other trigger is a chat doing something
    // - a `ready`, a session ending - so finished work that arrived during the cooldown
    // window sat on master until somebody typed, which on a quiet evening is the morning.
    // The clock is what was missing. autoship is a no-op unless there is something to put
    // out, nobody is mid-edit and the cooldown has passed.
    sayRelease(autoship('auto', session ?? 'auto'))
    // A main folder holding that release with a file nobody is on gets one card, and loses it
    // once it holds nothing (strandedCard).
    const stranded = strandedCard(reap(read()))
    if (stranded) console.log(stranded)
    // The folder sweep rides the same clocks (the app's timer on the Mac, lane-cron on the
    // PC), every SWEEP_EVERY_MS. Detached, because archiving one big folder took 7 minutes
    // on 2026-09-23 and the retry must not wait on it; what it removes lands in
    // `state.swept`, which doctor prints.
    if (sweepDue() && !Object.values(read().recovery?.items ?? {}).some((r) => r.status !== 'complete' && r.status !== 'reviewed')) sweepSoon()
    // Last, because the release above may be the one that needs describing.
    const described = reconcileNotes(reap(read()))
    if (described) console.log(`Wrote what changed onto the v${described} release page.`)
    const feed = reconcileFeed(reap(read()))
    if (feed)
      console.log(
        `Put ${feed.name} back on the v${feed.version} release: it described a ${feed.was}-byte ` +
          `build and the installer being served is ${feed.now} bytes, so every update would ` +
          `have failed its hash check.`
      )
    // Stable moves by itself: a dev build that soaked with nothing shipped on top of it
    // is the proof promotion was waiting for, so the timer flips it.
    {
      const st = reap(read())
      const p = autoPromote(st)
      if (p) write(st)
      if (p?.promoted)
        console.log(
          `Promoted ${p.tag} to stable: it sat on the dev channel ${Math.round(PROMOTE_SOAK_MS / 3600000)}h ` +
            `with nothing shipped on top of it. Stable installs update within the half hour.`
        )
      else if (p?.reason) console.log(`Stable promotion of ${p.tag} waits: ${p.reason}`)
    }
    } finally { unlock() }
  } else if (cmd === 'sweep') {
    if (argv.includes('--if-due') && !sweepDue()) process.exit(0)
    for (const line of sweep({ dryRun: argv.includes('--dry-run') })) console.log(line)
  } else if (cmd === 'suite-job') {
    // Never typed: `startSuiteJob` starts it, detached, and it outlives whoever started it.
    runSuiteJob(read(), arg('dir'), arg('commit'), arg('kind'), true)
  } else if (cmd === 'doctor') console.log(doctor())
  else if (cmd === 'status') console.log(JSON.stringify(status(session, { held: argv.includes('--held') }), null, 2))
  else {
    console.error(`Unknown command "${cmd}".`)
    process.exit(1)
  }
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
