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
//   node scripts/lane.mjs release --session <id>   give the lane back (SessionEnd)
//
// Nothing above is typed by hand. `ready` and `release` both end in `autoship`, so the
// release happens by itself the moment the LAST chat with unfinished PaneForge work
// stops having any: whoever finishes last cuts the version, for everyone.

import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostname } from 'node:os'
import { closeTestApps } from './test-app.mjs'
import { mergeImportConflicts } from './lane-merge.mjs'
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
    const out = errText(e)
    // Git refusing to start is not an answer about the code. Clear the lock that stopped
    // it when we can prove the lock is abandoned, and take the one retry - so the callers
    // below never have to tell "these branches disagree" apart from "git was busy".
    if (dropStaleLock(cwd, out, e)) {
      try {
        return { ok: true, out: git(cwd, ...args) }
      } catch (again) {
        const retried = errText(again)
        return { ok: false, out: retried, locked: lockedOut(retried) }
      }
    }
    return { ok: false, out, locked: lockedOut(out) }
  }
}

const errText = (e) => String(e.stderr ?? e.stdout ?? e.message).trim()

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
// this file runs is dead within GIT_TIMEOUT_MS, and a real merge holds the index for
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
  // The branch the main checkout has checked out IS the branch lanes belong to: it is what
  // `main` (the lane) sits on, so a repo whose default is `main` rather than `master` needs
  // no configuration at all. origin/HEAD is the fallback for a detached main checkout.
  let branch = cfg.branch
  if (!branch) {
    const head = gitSafe(MAIN, 'symbolic-ref', '--quiet', '--short', 'HEAD')
    if (head.ok && head.out) branch = head.out
    else {
      const o = gitSafe(MAIN, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')
      branch = o.ok && o.out ? o.out.replace(/^origin\//, '') : 'master'
    }
  }
  const release = cfg.release ?? (OWN ? 'version' : 'merge')
  if (!['version', 'merge', 'none'].includes(release))
    throw new Error(`.lanes.json: unknown release "${release}" - use "version", "merge" or "none"`)
  return {
    branch,
    release,
    pool: Array.isArray(cfg.pool) && cfg.pool.length ? cfg.pool : DEFAULT_POOL,
    enabled: cfg.lanes !== false
  }
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
    // What THIS device last told the other one, so a turn ending can tell whether a
    // refresh is due without asking the network on every turn.
    s.peer ??= null
    // What the OTHER devices last said, kept so a reader that must not touch the network
    // can still answer "who has the trunk". See the note in write().
    s.peers ??= null
    return s
  } catch {
    return { lanes: {}, ready: {}, conflicts: {}, release: null, lastShip: null, peer: null, peers: null }
  }
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
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
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

/** Give back what this device published for a session. Failure is silent: it ages out. */
function dropPublished(state, session) {
  if (state.peer && (!session || state.peer.session === session)) state.peer = null
  if (!hasOrigin()) return
  const mine = ownedRefs(peerRefs() ?? [], { device: DEVICE, session })
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
      return execFileSync('git', args, {
        cwd: MAIN,
        encoding: 'utf8',
        input,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: GIT_TIMEOUT_MS,
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
function drainLane(state, id) {
  if (id === 'main') return null // master IS the release branch - its commits are already counted
  if (state.ready[id] || state.conflicts[id]) return null
  if (!existsSync(laneDir(id))) return null
  const w = laneWork(id)
  if (w.dirty || w.ahead === 0) return null
  const caught = catchUp(id)
  if (caught.conflicts.length) {
    noteConflict(state.conflicts, id, caught.conflicts.join(', '))
    return null
  }
  try {
    return markReady(state, id)
  } catch {
    /* nothing mergeable after the catch-up - leave the branch alone */
    return null
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
function park(session) {
  if (!session) throw new Error('park needs --session')
  const state = reap(read())
  const parked = []
  for (const [id, c] of Object.entries(state.lanes)) {
    if (c.session !== session || c.parked) continue
    if (state.ready[id] || state.conflicts[id]) continue
    if (laneWork(id).dirty) continue
    c.parked = now()
    parked.push(id)
  }
  // A turn ending is the heartbeat. Only the trunk is ever published, and only once the
  // last thing we said is old enough that the other desk is about to stop believing it -
  // so an ordinary turn pushes nothing and a chat that works all afternoon keeps its
  // claim alive without anybody typing a command.
  const holdsTrunk = state.lanes.main?.session === session
  if (holdsTrunk && needsRefresh(state.peer?.slot === 'main' ? state.peer : null, { now: now() }))
    publishClaim(state, 'main', session)
  else if (!holdsTrunk && state.peer?.slot === 'main' && state.peer.session === session) dropPublished(state, session)
  write(state)
  return { parked }
}

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
      // closed the `npm run try` window it left running either. Both go here - but its
      // COMMITS do not. A session that ends properly marks finished work ready on the way
      // out (releaseClaim); one that was killed, or that slept through a reboot, never
      // reached that line, and dropping its claim silently is what left real commits
      // sitting on a lane branch with nothing pointing at them. `shippable()` only counts
      // lanes that are marked ready, so the work was invisible until some later chat
      // happened to be handed that exact lane - days later, in the case this was found in.
      // Draining uses releaseClaim's rule, because it is the same situation arriving by a
      // worse road: committed and clean means it was meant to go out, uncommitted means
      // nobody ever released half an edit.
      drainLane(state, id)
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
    const merged = mergeImportConflicts(text)
    if (merged === null) return []
    writes.push([join(dir, f), merged])
  }
  if (!writes.length) return []
  for (const [p, text] of writes) writeFileSync(p, text)
  return files
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
  if (gitSafe(dir, 'merge-base', '--is-ancestor', MB, 'HEAD').ok) {
    return { moved: false, conflicts: [], dirty: false }
  }
  enableRerere()
  const m = gitSafe(dir, 'merge', '--no-edit', MB)
  if (m.ok) return { moved: true, conflicts: [], dirty: false }
  // A lock that outlived the retry in gitSafe is a live git somewhere else, not a
  // disagreement: report "not now" so the caller leaves the lane alone and tries again,
  // instead of recording a conflict that no amount of resolving would ever clear.
  if (m.locked) {
    gitSafe(dir, 'merge', '--abort')
    return { moved: false, conflicts: [], dirty: false, blocked: 'another git is using this repository' }
  }
  let conflicts = gitSafe(dir, 'diff', '--name-only', '--diff-filter=U')
    .out.split('\n')
    .filter(Boolean)
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
      return { moved: true, conflicts: [], dirty: false, healed }
    }
    conflicts = left
  }
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
  // Nothing below can be asked of a folder git will not answer about, and asking anyway
  // is what made a broken lane look like one with uncommitted work in it. ensureWorktree
  // owns that repair; every caller here has already been through it.
  if (!isWorktree(dir)) return null
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

function ensureWorktree(id) {
  const dir = laneDir(id)
  if (id === 'main') return dir
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
    // A reused lane branch may be behind master; start it fresh from master when new.
    const add = known
      ? ['worktree', 'add', dir, branch]
      : ['worktree', 'add', '-b', branch, dir, MB]
    let r = gitSafe(MAIN, ...add)
    // The branch still counts as checked out in a folder git has not been told is gone.
    // Only reachable once the folder above was proven empty, so nothing can be lost here.
    if (!r.ok && known) r = gitSafe(MAIN, 'worktree', 'add', '--force', dir, branch)
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
  excludeModules(dir)
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
  // Cheap, throttled, and the reason most conflicts never reach a human.
  retryConflicts(state)

  for (const [id, c] of Object.entries(state.lanes)) {
    if (c.session === session) {
      c.seen = now()
      // The chat is back: whatever `park` said about its turn being over is no longer
      // true, and a claim that is not a visit clears the visitor word too - the hook
      // decides that from where the chat LIVES, so a home chat is never marked down for
      // one prompt sent from somewhere else.
      delete c.parked
      if (!visitor) delete c.visitor
      // A lane can stop being a checkout while its own chat is sitting in it - a pruned
      // worktree, an interrupted install, a folder deleted from underneath, a node_modules
      // link removed by a cleanup. The chat is then told, every prompt, to work in a folder
      // that no longer functions. Everything needed to put it back is in ensureWorktree and
      // all of it is idempotent, so a returning chat gets the same repair a new one does -
      // this branch used to hand the broken path straight back unchanged.
      if (id !== 'main') {
        try {
          ensureWorktree(id)
        } catch {
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
  const spare = order.filter((id) => !state.lanes[id] && !state.conflicts[id])
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
  const pick = (ids) =>
    ids.find((id) => !squatted.has(id) && !state.ready[id] && !state.conflicts[id]) ??
    ids.find((id) => !squatted.has(id) && !state.conflicts[id]) ??
    ids.find((id) => !state.ready[id] && !state.conflicts[id])
  // A preference is a chat protecting work in the folder it is standing in - but a folder
  // ANOTHER chat is also standing in protects nothing, it just moves the collision one lane
  // over. So a squatted preference is honoured only when there is no unsquatted lane left,
  // which is the same rule the pool itself follows.
  // Same rule as `pick`, and it has to be repeated here because `wanted` is the one path
  // that goes AROUND the chooser: a chat standing in `<repo>-a` asks for lane a by name,
  // and honouring that while a is mid-conflict hands it exactly what the tiers refuse.
  const wanted = prefer && !state.lanes[prefer] && !state.conflicts[prefer] ? prefer : null
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
  // Nothing free: before refusing, look for a lane that is being held and not used. The
  // oldest one goes, so a chat that has at least been seen recently keeps its checkout.
  if (!free) {
    const idle = Object.entries(state.lanes)
      .filter(([id, c]) => {
        // A lane only reserved by a mention is idle the moment anyone actually needs one.
        if (!c.tentative && !holdGivenUp(c)) return false
        if (state.ready[id] || state.conflicts[id]) return false
        const w = laneWork(id)
        return !w.dirty && w.ahead === 0
      })
      .sort((a, b) => (a[1].seen ?? 0) - (b[1].seen ?? 0))[0]
    if (idle) {
      delete state.lanes[idle[0]]
      closeLaneApps(laneDir(idle[0]))
      free = idle[0]
    }
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
      const spare = pick(order.filter((id) => id !== 'main' && !state.lanes[id]))
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
    const why = stuck.length ? `${held.join(', ')}; conflicted: ${stuck.join(', ')}` : held.join(', ')
    throw new Error(`all lanes busy: ${why}`)
  }

  const dir = ensureWorktree(free)
  enableRerere()
  // A lane is handed over clean and current, never mid-merge and never stale: whatever the
  // last chat left behind is settled here, before this one writes a line.
  const healed = healLane(free)
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
    claimed: now(),
    seen: now(),
    ...(tentative ? { tentative: true } : {}),
    ...(visitor ? { visitor: true } : {})
  }
  // Taking the trunk is the only thing worth telling the other desk about, and it is told
  // at the moment it becomes true rather than on a timer.
  if (free === 'main') publishClaim(state, 'main', session)
  write(state)
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
    // editing PaneForge, not talking about it, so the lane is now its lane - and a chat
    // that is writing has plainly not finished its turn, whatever `park` recorded.
    delete holder.tentative
    delete holder.parked
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
      return `${basename(MAIN)}: this session's lane is ${got.dir}. Make the change there, not in ${lane.dir}.`
    } catch {
      return null
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
function aheadOf(branch) {
  const r = gitSafe(MAIN, 'cherry', MB, branch)
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
    let rel = line.slice(3).trim()
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
function laneWork(id) {
  const dir = laneDir(id)
  if (!existsSync(dir)) return { dirty: false, ahead: 0, touchedAt: 0 }
  // A folder that is not a worktree answers every git command with an error, and the
  // error text is text, so `dirty` was true forever - the lane looked like a chat was
  // mid-edit in it and was left alone by everything that would have rebuilt it. It has no
  // uncommitted work because it has no work: say so, and let ensureWorktree repair it.
  if (id !== 'main' && !isWorktree(dir))
    return { dirty: false, ahead: aheadOf(laneBranch(id)), broken: true, touchedAt: 0 }
  const porcelain = gitSafe(dir, 'status', '--porcelain').out
  const dirty = Boolean(porcelain)
  const branch = id === 'main' ? MB : laneBranch(id)
  const ahead = id === 'main' ? unreleasedOnMaster() : aheadOf(laneBranch(id))
  return { dirty, ahead, touchedAt: lastTouched(dir, porcelain, ahead > 0 ? branch : null) }
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

/** One busy lane, said the way a person needs to hear it: what is in it, and how stale. */
function busyDetail(id) {
  const w = laneWork(id)
  const what = []
  if (w.dirty) what.push('uncommitted edits')
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
  return /is not recognized|command not found|ENOENT|Cannot find module|npm ERR! missing script|sh: .*: not found/i.test(out)
}

/** Does this checkout declare dependencies it has not got? */
function dependenciesMissing(pkg) {
  if (!Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length) return false
  const mods = join(MAIN, 'node_modules')
  try {
    return !existsSync(mods) || readdirSync(mods).length === 0
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
  const r = spawnSync(cmd, { cwd: MAIN, encoding: 'utf8', timeout: 900_000, shell: true })
  if (r.status === 0) return null
  return (
    `${basename(MAIN)} has no dependencies installed and \`${cmd}\` could not install them, so nothing was ` +
    `released - ${firstLine(`${r.stdout ?? ''}${r.stderr ?? ''}`)}. The code is not the problem; the checkout is.`
  )
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
  if (dependenciesMissing(pkg)) {
    const failed = installDeps()
    if (failed) return failed
  }
  // One string + shell: npm on Windows is npm.cmd, which cannot be spawned directly.
  const r = spawnSync('npm run --silent typecheck', {
    cwd: MAIN,
    encoding: 'utf8',
    timeout: 150_000,
    shell: true
  })
  if (r.status === 0) return null
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

/**
 * The release nobody has to ask for. Called at the end of `ready` and of `release`, so
 * the version goes out the moment the last chat with unfinished work finishes it - and
 * silently does nothing while any chat is still mid-edit.
 */
function autoship(kind = 'auto', session = 'auto') {
  // Before `shippable` asks whether anything is unreleased - that question is answered
  // against local tags, and a stale one turns "already released" into "release it again".
  syncTags()
  const state = reap(read())
  // A conflict that has quietly stopped being a conflict should not keep work out of
  // this release: try them all again before deciding what is shippable.
  if (retryConflicts(state)) write(state)
  if (state.release) return { shipped: false, reason: 'another chat is mid-release' }
  const busy = busyLanes(state)
  // Named with the evidence, not just the lane. An agent repeats this reason to a person
  // verbatim, and "waiting on chats still working: main" was read - correctly, from what
  // it says - as "somebody is mid-feature", when the truth was an untouched file and an
  // open window. Saying how long ago the work last moved makes the two distinguishable
  // without anyone opening the ledger.
  if (busy.length) return { shipped: false, reason: `waiting on chats still working: ${busy.map(busyDetail).join(', ')}` }
  if (!shippable(state)) return { shipped: false, reason: 'nothing to release' }
  const since = state.lastShip ? now() - state.lastShip.at : Infinity
  const small = smallOnly(MAIN)
  const window_ = small ? SMALL_HOLD_MS : COOLDOWN_MS
  if (since < window_) {
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
    return { lane: id, note: `${MB} is the release branch - nothing to merge` }
  }
  const ahead = aheadOf(laneBranch(id))
  if (!ahead) throw new Error(`lane ${id} has no commits ${MB} does not already have`)
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
    return { lane: id, dir, resolved: true, marked, release: autoship('auto', session) }
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
      `lane ${id} and ${MB} both changed:\n  ${caught.conflicts.join('\n  ')}\n` +
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
  closeLaneApps(laneDir(id))
  // Last one out cuts the release. If another chat is still mid-edit this is a no-op
  // and THEIR `ready` (or the end of their session) will cut it instead.
  return { ...marked, release: autoship('auto', session) }
}

function releaseClaim(session) {
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
      closeLaneApps(laneDir(id))
      freed = id
    }
  }
  if (state.release?.session === session) state.release = null
  write(state)
  return { freed, marked, release: autoship('auto', session) }
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

function ship(kind, session) {
  if (!['auto', 'patch', 'minor', 'major'].includes(kind)) throw new Error(`unknown bump "${kind}"`)
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

  state.release = { session: session ?? 'unknown', at: now() }
  write(state)

  try {
    const dirty = git(MAIN, 'status', '--porcelain')
    if (dirty) throw new Error(`main checkout is dirty, commit first:\n${dirty}`)

    // An expired token used to surface only after the version was committed and
    // tagged, which stranded the release (the resume path below is the recovery).
    // Refuse up front instead: a dry-run push exercises credentials and the network
    // and transfers nothing, so a release that cannot be pushed never gets cut.
    // A repo configured to push nothing is not asked to prove it can push.
    if (RELEASE !== 'none') {
      const origin = gitSafe(MAIN, 'push', '--dry-run')
      if (!origin.ok)
        throw new Error(`origin will not take a push, releasing would strand: ${origin.out.slice(0, 200)}`)
    }

    const merged = []
    const conflicts = {}
    // Lanes that could not be merged because git was busy, which is not the same thing as
    // a lane that cannot be merged. They keep their ready mark and nothing is recorded
    // against them.
    const blocked = []
    for (const [id, mark] of Object.entries(state.ready)) {
      if (id === 'main') continue
      const branch = laneBranch(id)
      const ahead = aheadOf(branch)
      if (!ahead) continue
      const m = gitSafe(MAIN, 'merge', '--no-ff', '-m', `merge lane ${id}`, branch)
      if (!m.ok && m.locked) {
        // Same rule as the lane side: git being busy says nothing about this branch. The
        // lane keeps its ready mark (see `finish`) and goes out of the next release, which
        // is minutes away - rather than being marked conflicted, which is hours away and
        // needs a person. This is the seven-hour stall of 2026-08-02, from the other side.
        gitSafe(MAIN, 'merge', '--abort')
        blocked.push(id)
        continue
      }
      if (!m.ok) {
        // Same union rule as the lane side, for the release side of the same collision:
        // two lanes that each added an import cannot both have merged cleanly, and the
        // second one to arrive here is not a decision anybody needs to make.
        const open = gitSafe(MAIN, 'diff', '--name-only', '--diff-filter=U')
          .out.split('\n')
          .filter(Boolean)
        const fixed = autoResolve(MAIN, open)
        for (const f of fixed) gitSafe(MAIN, 'add', '--', f)
        const stuck =
          !fixed.length ||
          gitSafe(MAIN, 'diff', '--name-only', '--diff-filter=U').out.trim() ||
          !gitSafe(MAIN, 'commit', '--no-edit').ok
        if (stuck) {
          // One lane that cannot merge used to stop everyone's release. It does not any
          // more: the conflict is that lane's problem, it stays marked ready, and it is
          // reported by name so the next chat in it fixes it. Everything else goes out.
          gitSafe(MAIN, 'merge', '--abort')
          noteConflict(conflicts, id, mergeFiles(m.out), state.conflicts)
          continue
        }
      }
      merged.push({ lane: id, commits: ahead, commit: mark.commit })
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
        if (id === 'main') continue
        const c = catchUp(id)
        if (c.moved) rebased.push(id)
        if (c.conflicts.length) noteConflict(conflicts, id, `${MB} merge: ${c.conflicts.join(', ')}`, state.conflicts)
      }

      const fresh = read()
      // A lane that could not merge keeps its ready mark: its work still has to go out,
      // in the next release, once someone has resolved it - or, for a lane that only lost
      // a race with another git, as soon as the next release runs and nobody is asked
      // anything at all.
      fresh.ready = Object.fromEntries(
        Object.entries(fresh.ready).filter(([id]) => conflicts[id] || blocked.includes(id))
      )
      fresh.conflicts = conflicts
      fresh.release = null
      fresh.lastShip = { version, at: now(), lanes: merged.map((m) => m.lane) }
      write(fresh)

      return { shipped: true, version, merged, rebased, conflicts, blocked, built }
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
        return { shipped: false, reason: 'nothing to release', conflicts }
      }
      if (RELEASE === 'merge') {
        const pushed = gitSafe(MAIN, 'push')
        // The lanes are already merged locally at this point, so say that rather than
        // "release failed": the work is on the branch and one `git push` finishes it.
        if (!pushed.ok)
          throw new Error(`lanes merged into ${MB}, but origin refused the push: ${pushed.out.slice(0, 200)}`)
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
        git(MAIN, 'push')
        git(MAIN, 'push', 'origin', `v${pkg.version}`)
        const resumedBuilt = publishFallback(pkg.version, () => beatRelease(session))
        const s = read()
        s.conflicts = conflicts
        s.release = null
        s.lastShip = { version: pkg.version, at: now(), lanes: merged.map((m) => m.lane) }
        write(s)
        return { shipped: true, version: pkg.version, merged, rebased: [], conflicts, resumed: true, built: resumedBuilt }
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
  if (RELEASE !== 'version') return null
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

function status(session) {
  const state = reap(read())
  // Asking is not writing, except when the asking found something to throw away: an
  // expired reservation that is only ever computed and never stored is not expired at all.
  if (reaped) write(state)
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
        // The Stop hook saw this hold's chat end a turn with the lane clean - the hold
        // survives, but any chat that needs the checkout takes it in minutes.
        parked: state.lanes[id]?.parked ?? null,
        // Claimed by a chat whose own project is a different repo - it stood here.
        visitor: Boolean(state.lanes[id]?.visitor),
        from: state.lanes[id]?.cwd ?? null,
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
    blockedBy: busyLanes(state),
    pending: shippable(state),
    release: state.release,
    lastShip: state.lastShip
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
        ? `Lanes branch off ${MB}. Finishing one merges into ${MB} and pushes. No version is cut here.`
        : `Lanes branch off ${MB}. Finishing one does nothing else - this repo neither tags nor pushes.`
  )
  say()

  say('LANES')
  const live = s.lanes.filter((l) => l.exists || l.heldBy || l.ready || l.conflicted || l.ahead > 0)
  for (const l of live) {
    const what = []
    if (l.heldBy)
      what.push(
        (l.tentative
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
    if (l.dirty) what.push('uncommitted edits')
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
      const ahead = gitSafe(MAIN, 'cherry', MB, branch).out.split('\n').filter((l) => l.startsWith('+')).length
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

  return out.join('\n')
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
      const lanes = r.merged?.length ? ` (lanes ${r.merged.map((m) => m.lane).join(', ')})` : ''
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
    for (const [id, c] of Object.entries(r.conflicts ?? {})) {
      console.log(
        `Lane ${id} is finished but conflicts with ${MB}, so it was left out of the release. ` +
          `It is retried by itself every ${Math.round(RETRY_MS / 60000)}m and goes out on its own if ${MB} stops ` +
          `disagreeing with it. To finish it now: node ${join(own, 'scripts', 'lane.mjs')} resolve --repo ${MAIN} --session <id> --lane ${id} ` +
          `(opens the merge in ${c.dir}).`
      )
    }
  }

  if (cmd === 'claim')
    // The hook always says where its chat is; a chat typing this itself usually does not,
    // and its own working directory is the answer it would have given. Better a folder
    // that might be a PaneForge checkout than a hold nothing can put a name to.
    console.log(
      JSON.stringify(
        claim(session, arg('cwd') ?? process.cwd(), arg('prefer'), argv.includes('--tentative'), argv.includes('--visitor')),
        null,
        2
      )
    )
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
  } else if (cmd === 'park') {
    // The Stop hook: this chat's turn ended. Holds on clean lanes are marked parked so a
    // chat that needs one takes it in minutes; the mark clears itself on the next claim.
    const r = park(session)
    console.log(JSON.stringify(r))
  } else if (cmd === 'autoship') sayRelease(autoship((argv[1] && !argv[1].startsWith('--') ? argv[1] : 'auto').toLowerCase(), session ?? 'auto'))
  else if (cmd === 'ship') {
    const r = ship((argv[1] && !argv[1].startsWith('--') ? argv[1] : 'auto').toLowerCase(), session)
    if (r.shipped) {
      console.log(r.version ? `Shipped v${r.version}.` : `Merged into ${MB}${RELEASE === 'merge' ? ' and pushed' : ''}.`)
      if (r.merged.length) console.log(`Included lanes: ${r.merged.map((m) => m.lane).join(', ')}`)
      if (r.rebased.length) console.log(`Lanes brought up to date: ${r.rebased.join(', ')}`)
      if (r.version) console.log(sayBuilt(r.built))
    } else {
      console.log(`Not shipped: ${r.reason}`)
    }
  } else if (cmd === 'promote') {
    const r = promote(argv[1] && !argv[1].startsWith('--') ? argv[1] : '')
    if (r.promoted)
      console.log(
        `Promoted ${r.tag}. /releases/latest now serves it, and every stable install updates within the half hour.`
      )
    else console.log(`Not promoted: ${r.reason}`)
  } else if (cmd === 'retry') {
    // Every other retry rides on a chat happening to run a lane command, so on a quiet
    // machine a conflict was never re-tried at all: it stayed on the strip long after the
    // change it disagreed with had shipped. The app calls this on a timer instead. When
    // master has not moved and RETRY_MS has not passed this is one `rev-parse` per lane.
    const state = reap(read())
    // Lanes nobody holds that are still carrying commits: the backstop for every way a
    // claim can disappear without its work being declared done. `reap` drains the claim it
    // is dropping right now, but a lane orphaned before that existed - or by a kill between
    // the drop and the drain - has no claim left to hang the rescue off. This finds those
    // by looking at the branches instead of at the bookkeeping. It is one `git cherry` per
    // free lane and it runs on the same clock as everything else here.
    const drained = []
    for (const id of POOL) {
      if (state.lanes[id]) continue
      if (drainLane(state, id)) drained.push(id)
    }
    if (drained.length) {
      write(state)
      console.log(
        `Lane${drained.length === 1 ? '' : 's'} ${drained.join(', ')} had finished work and no chat - marked done, ` +
          `so it goes out with the next release.`
      )
    }
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
    sayRelease(autoship('auto', session ?? 'auto'))
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
  } else if (cmd === 'doctor') console.log(doctor())
  else if (cmd === 'status') console.log(JSON.stringify(status(session), null, 2))
  else {
    console.error(`Unknown command "${cmd}".`)
    process.exit(1)
  }
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
