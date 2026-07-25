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
//   node scripts/lane.mjs release --session <id>   give the lane back (SessionEnd)

import { execFileSync } from 'node:child_process'
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
const POOL = ['main', 'a', 'b']
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
    s.release ??= null
    s.lastShip ??= null
    return s
  } catch {
    return { lanes: {}, ready: {}, release: null, lastShip: null }
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

function ready(session) {
  const state = reap(read())
  const mine = Object.entries(state.lanes).find(([, c]) => c.session === session)
  if (!mine) throw new Error('this session holds no lane')
  const [id] = mine
  const dir = laneDir(id)
  const dirty = git(dir, 'status', '--porcelain')
  if (dirty) throw new Error(`commit your changes first:\n${dirty}`)
  if (id === 'main') {
    state.ready.main = { at: now(), commit: git(dir, 'rev-parse', 'HEAD') }
    write(state)
    return { lane: id, note: 'master is the release branch - nothing to merge, ship when you want' }
  }
  const ahead = git(MAIN, 'rev-list', '--count', `master..${laneBranch(id)}`)
  if (ahead === '0') throw new Error(`lane ${id} has no commits master does not already have`)
  state.ready[id] = { at: now(), commit: git(dir, 'rev-parse', 'HEAD'), commits: Number(ahead) }
  write(state)
  return { lane: id, commits: Number(ahead), note: 'will go out with the next ship, no separate release' }
}

function releaseClaim(session) {
  const state = reap(read())
  let freed = null
  for (const [id, c] of Object.entries(state.lanes)) {
    if (c.session === session) {
      delete state.lanes[id]
      freed = id
    }
  }
  if (state.release?.session === session) state.release = null
  write(state)
  return { freed }
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
    for (const [id, mark] of Object.entries(state.ready)) {
      if (id === 'main') continue
      const branch = laneBranch(id)
      const ahead = gitSafe(MAIN, 'rev-list', '--count', `master..${branch}`)
      if (!ahead.ok || ahead.out === '0') continue
      const m = gitSafe(MAIN, 'merge', '--no-ff', '-m', `merge lane ${id}`, branch)
      if (!m.ok) {
        gitSafe(MAIN, 'merge', '--abort')
        throw new Error(`lane ${id} conflicts with master. Resolve it in ${laneDir(id)} first:\n${m.out}`)
      }
      merged.push({ lane: id, commits: Number(ahead.out), commit: mark.commit })
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
      return { shipped: false, reason: `nothing new since v${pkg.version}` }
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
    fresh.ready = {}
    fresh.release = null
    fresh.lastShip = { version: next, at: now(), lanes: merged.map((m) => m.lane) }
    write(fresh)

    return { shipped: true, version: next, merged, rebased }
  } catch (e) {
    const s = read()
    if (s.release?.session === (session ?? 'unknown')) {
      s.release = null
      write(s)
    }
    throw e
  }
}

function status() {
  const state = reap(read())
  return {
    main: MAIN,
    lanes: POOL.map((id) => ({
      lane: id,
      dir: laneDir(id),
      branch: laneBranch(id),
      exists: existsSync(laneDir(id)),
      heldBy: state.lanes[id]?.session ?? null,
      from: state.lanes[id]?.cwd ?? null,
      ready: Boolean(state.ready[id])
    })),
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
  if (cmd === 'claim') console.log(JSON.stringify(claim(session, arg('cwd'), arg('prefer')), null, 2))
  else if (cmd === 'guard') {
    const reason = guard(session, arg('path'))
    if (reason) {
      console.log(reason)
      process.exit(2)
    }
  } else if (cmd === 'ready') console.log(JSON.stringify(ready(session), null, 2))
  else if (cmd === 'release') console.log(JSON.stringify(releaseClaim(session), null, 2))
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
  } else if (cmd === 'status') console.log(JSON.stringify(status(), null, 2))
  else {
    console.error(`Unknown command "${cmd}".`)
    process.exit(1)
  }
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
