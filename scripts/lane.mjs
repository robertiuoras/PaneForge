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
//   node scripts/lane.mjs ready --session <id>     mark this lane's branch shippable
//   node scripts/lane.mjs ship [patch|minor|major] merge ready lanes, one release
//   node scripts/lane.mjs autoship                 ship, but only if no chat is mid-work
//   node scripts/lane.mjs release --session <id>   give the lane back (SessionEnd)
//
// Nothing above is typed by hand. `ready` and `release` both end in `autoship`, so the
// release happens by itself the moment the LAST chat with unfinished PaneForge work
// stops having any: whoever finishes last cuts the version, for everyone.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------- repo geography

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
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
// A ship that has not finished in this long crashed or was killed mid-way.
const LOCK_MS = 20 * 60 * 1000

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

function reap(state) {
  for (const [id, c] of Object.entries(state.lanes)) {
    if (now() - (c.seen ?? c.claimed ?? 0) > STALE_MS) delete state.lanes[id]
  }
  if (state.release && now() - state.release.at > LOCK_MS) state.release = null
  return state
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

function claim(session, cwd, prefer) {
  if (!session) throw new Error('claim needs --session')
  const state = reap(read())

  for (const [id, c] of Object.entries(state.lanes)) {
    if (c.session === session) {
      c.seen = now()
      write(state)
      return { lane: id, dir: laneDir(id), branch: laneBranch(id), profile: laneProfile(id), fresh: false }
    }
  }

  // `prefer` is how a chat that was already mid-edit in a checkout when lanes were
  // switched on keeps that checkout, uncommitted work and all, instead of being sent
  // to an empty lane and losing sight of it.
  const free = (prefer && !state.lanes[prefer] ? prefer : null) ?? POOL.find((id) => !state.lanes[id])
  if (!free) {
    // Every lane is held by a live session. Better to say so than to hand out a
    // checkout two chats are already sharing.
    const held = Object.entries(state.lanes).map(([id, c]) => `${id} (${c.cwd ?? '?'})`)
    throw new Error(`all lanes busy: ${held.join(', ')}`)
  }

  const dir = ensureWorktree(free)
  state.lanes[free] = { session, cwd: cwd ?? null, claimed: now(), seen: now() }
  write(state)
  return { lane: free, dir, branch: laneBranch(free), profile: laneProfile(free), fresh: true }
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
  if (state.release) return { shipped: false, reason: 'another chat is mid-release' }
  const busy = busyLanes(state)
  if (busy.length) return { shipped: false, reason: `waiting on chats still working: ${busy.join(', ')}` }
  if (!shippable(state)) return { shipped: false, reason: 'nothing to release' }
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
  if (id === 'main') {
    state.ready.main = { at: now(), commit: git(dir, 'rev-parse', 'HEAD') }
    return { lane: id, note: 'master is the release branch - nothing to merge' }
  }
  const ahead = aheadOf(laneBranch(id))
  if (!ahead) throw new Error(`lane ${id} has no commits master does not already have`)
  state.ready[id] = { at: now(), commit: git(dir, 'rev-parse', 'HEAD'), commits: ahead }
  return { lane: id, commits: ahead, note: 'goes out with the next release, not a separate one' }
}

function ready(session) {
  const state = reap(read())
  const mine = Object.entries(state.lanes).find(([, c]) => c.session === session)
  if (!mine) throw new Error('this session holds no lane')
  const [id] = mine
  const dirty = git(laneDir(id), 'status', '--porcelain')
  if (dirty) throw new Error(`commit your changes first:\n${dirty}`)
  const marked = markReady(state, id)
  write(state)
  // Last one out cuts the release. If another chat is still mid-edit this is a no-op
  // and THEIR `ready` (or the end of their session) will cut it instead.
  return { ...marked, release: autoship('patch', session) }
}

function releaseClaim(session) {
  const state = reap(read())
  let freed = null
  let marked = null
  for (const [id, c] of Object.entries(state.lanes)) {
    if (c.session === session) {
      // A chat that ends with committed, clean work meant that work to go out - it just
      // never said so. Uncommitted work is the opposite: nobody released half an edit.
      const w = laneWork(id)
      if (!state.ready[id] && !w.dirty && w.ahead > 0) {
        try {
          marked = markReady(state, id)
        } catch {
          /* nothing mergeable - leave it */
        }
      }
      delete state.lanes[id]
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
        conflicts[id] = { at: now(), dir: laneDir(id), detail: m.out.split('\n').slice(0, 6).join('\n') }
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

    // Every lane that just shipped catches up to master, so the next feature in that
    // lane does not start from a stale base and conflict on the release commit.
    const rebased = []
    for (const id of POOL) {
      if (id === 'main' || !existsSync(laneDir(id))) continue
      const dir = laneDir(id)
      if (git(dir, 'status', '--porcelain')) continue
      if (gitSafe(dir, 'merge', '--ff-only', 'master').ok) rebased.push(id)
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
        from: state.lanes[id]?.cwd ?? null,
        ready: Boolean(state.ready[id]),
        conflicted: Boolean(state.conflicts[id]),
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
          `Resolve it in ${c.dir} (git merge master), commit, and it goes out with the next one.`
      )
    }
  }

  if (cmd === 'claim') console.log(JSON.stringify(claim(session, arg('cwd'), arg('prefer')), null, 2))
  else if (cmd === 'guard') {
    const reason = guard(session, arg('path'))
    if (reason) {
      console.log(reason)
      process.exit(2)
    }
  } else if (cmd === 'ready') {
    const r = ready(session)
    console.log(`Lane ${r.lane} marked done${r.commits ? ` (${r.commits} commit${r.commits === 1 ? '' : 's'})` : ''}.`)
    sayRelease(r.release)
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
  } else if (cmd === 'status') console.log(JSON.stringify(status(session), null, 2))
  else {
    console.error(`Unknown command "${cmd}".`)
    process.exit(1)
  }
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
