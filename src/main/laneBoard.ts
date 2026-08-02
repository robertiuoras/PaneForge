// What the other chats editing PaneForge are doing, read straight off disk.
//
// PaneForge is built from several chats at once, each holding one checkout ("lane" -
// see scripts/lane.mjs). That system already works; what it had no way of doing was
// telling a human. A lane that finished but conflicts with master is left out of every
// release until someone resolves it, and the only place that was ever said was inside
// the text a hook prints into whichever chat happens to send the next prompt. Lane b sat
// conflicted for a day that way. So the app shows it: the lanes are on screen, and a
// stuck one glows until it is not.
//
// This reads the lane state file (in the repo's shared .git, written by lane.mjs) and
// nothing else - no git, no child process, a few hundred bytes every few seconds. On a
// machine that has no PaneForge checkout there is no file, this returns null, and the
// renderer draws nothing.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { LaneBoard, LaneBoardEntry } from '../shared/types'

/** Same order as the POOL in scripts/lane.mjs, so the strip reads like the lane list. */
const POOL = ['main', 'a', 'b', 'c']
/** Matches ADOPT_MS in scripts/lane.mjs: a conflict this stale is anyone's to fix. */
const ADOPT_MS = 45 * 60 * 1000
/** The state file changes at most a few times a minute; polling is cheap but not free. */
const TTL = 4000

interface RawLane {
  session?: string
  cwd?: string | null
  claimed?: number
  seen?: number
  /** Reserved by a chat that only mentioned PaneForge and has not written in the lane. */
  tentative?: boolean
}
interface RawConflict {
  at?: number
  since?: number
  detail?: string
  resolver?: string | null
  resolverAt?: number
}
interface RawState {
  lanes?: Record<string, RawLane>
  ready?: Record<string, { at?: number; commits?: number }>
  conflicts?: Record<string, RawConflict>
  release?: { session: string; at: number } | null
  lastShip?: { version: string; at: number; lanes: string[] } | null
}

/** How often the app is willing to ask lane.mjs to re-try; its own throttle is longer. */
const RETRY_EVERY = 2 * 60 * 1000
/** A retry that clears a conflict ends in a release, and a release is not quick. */
const RETRY_TIMEOUT = 10 * 60 * 1000

let repo: string | null | undefined
/** Which set of open panes produced `repo`, so closing the last pane on a repo re-resolves. */
let repoFrom: string | null = null
let cache: { at: number; board: LaneBoard | null } = { at: 0, board: null }
let retryAt = 0
let retrying = false

/**
 * The main checkout, which is where the shared .git (and so the lane state) lives.
 *
 * A lane worktree is a sibling folder named `<repo>-a`, and the app usually runs from
 * one of those in development, so "the folder I am in" is not the answer. The env var is
 * the escape hatch for a checkout somewhere else entirely.
 */
function findRepo(panes: LanePane[] = []): string | null {
  // Re-resolved rather than remembered forever if the folder it found is gone: the
  // checkout family is being renamed to PaneForge* (scripts/rename-repo.mjs, which waits
  // for a moment when no chat is in it), and this app runs for days at a time. Both names
  // are looked for so a machine mid-rename, either way round, still finds its lanes.
  const key = panes.map((p) => p.cwd).sort().join('|')
  if (repo !== undefined && repoFrom === key && (repo === null || existsSync(repo))) return repo
  repoFrom = key
  repo = resolveRepo(panes)
  return repo
}

/**
 * Lanes belong to whatever repo the chats are actually in.
 *
 * This used to look in four hardcoded folders for a checkout literally named `PaneForge`
 * or `claude-orchestrator`, under `~/Desktop/Projects` or `~/Projects`. On the machine
 * PaneForge is built on that is always right, and it is wrong for every other person who
 * installs it: the CLI half of lanes takes `--repo <anywhere>` and drives any project, the
 * hooks ship in the installer and wire themselves up, so a user's chats really are getting
 * lanes - and then the strip that is supposed to show them found nothing, drew nothing,
 * and said nothing about why. Same for anyone here whose work is not that one repo.
 *
 * The panes are the answer, because a lane exists precisely because a chat is sitting in a
 * checkout, and the app knows where every pane is. So the rule is now sayable in one line:
 * THE STRIP SHOWS THE LANES OF THE REPO YOUR PANES ARE IN. If none of them is in a repo
 * that uses lanes, it shows nothing - rather than, as it used to, showing PaneForge's
 * lanes to a window doing something else entirely, which is its own kind of confusing.
 *
 * `PANEFORGE_REPO` still overrides everything, and the old folder guesses are kept for the
 * one case they are still the only answer: no panes open at all, which is how the updater
 * asks for `lastShip()`. On macOS that also means one less blind `~/Desktop` probe on the
 * way up (that path is behind TCC and prompts).
 */
function resolveRepo(panes: LanePane[]): string | null {
  const lanes = (main: string): boolean => existsSync(join(main, '.git', 'paneforge-lanes.json'))
  if (process.env.PANEFORGE_REPO && lanes(process.env.PANEFORGE_REPO)) return process.env.PANEFORGE_REPO

  if (panes.length) {
    // Panes in lane worktrees of one repo all resolve to that repo's main checkout, so the
    // usual case is unanimous. When two repos really are open, the one more panes are in
    // wins, and ties break by name so the strip does not flip between them every poll.
    const votes = new Map<string, number>()
    for (const p of panes) {
      const main = p.cwd && mainCheckout(p.cwd)
      if (main && lanes(main)) votes.set(main, (votes.get(main) ?? 0) + 1)
    }
    return [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
  }

  const roots =
    process.platform === 'darwin'
      ? [join(homedir(), 'Projects')]
      : [join(homedir(), 'Desktop', 'Projects'), join(homedir(), 'Projects')]
  const guesses = roots.flatMap((r) => [join(r, 'PaneForge'), join(r, 'claude-orchestrator')])
  return guesses.find(lanes) ?? null
}

/**
 * The main checkout above `dir`, which is where the shared `.git` - and so the lane state -
 * lives. A lane is a worktree, whose `.git` is a FILE pointing at
 * `<main>/.git/worktrees/<name>`, so a pane sitting in one still answers `<main>`.
 *
 * Deliberately no `git` here: this runs on a poll, and the module's whole cost story is
 * that it reads a file and spawns nothing.
 */
function mainCheckout(dir: string): string | null {
  let at = resolve(dir)
  for (;;) {
    const dot = join(at, '.git')
    try {
      if (existsSync(dot)) {
        if (statSync(dot).isDirectory()) return at
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, 'utf8'))
        if (!m) return null
        // <main>/.git/worktrees/<name> -> <main>
        return dirname(dirname(dirname(resolve(at, m[1].trim()))))
      }
    } catch {
      return null
    }
    const up = dirname(at)
    if (up === at) return null
    at = up
  }
}

/**
 * The branch lanes are cut from, the same way lane.mjs decides it: `.lanes.json` if the
 * repo says, else whatever HEAD is on. Hardcoding `master` printed the wrong branch on the
 * strip for every repo that uses `main`, which is most of them and all the new ones.
 */
function mainBranch(main: string): string {
  try {
    const cfg = JSON.parse(readFileSync(join(main, '.lanes.json'), 'utf8')) as { branch?: string }
    if (typeof cfg.branch === 'string' && cfg.branch) return cfg.branch
  } catch {
    // no .lanes.json, or not ours to read - HEAD still knows
  }
  try {
    const head = /^ref:\s*refs\/heads\/(.+)$/m.exec(readFileSync(join(main, '.git', 'HEAD'), 'utf8'))
    if (head) return head[1].trim()
  } catch {
    // detached, or unreadable
  }
  return 'master'
}

const laneDir = (main: string, id: string): string =>
  id === 'main' ? main : join(dirname(main), `${basename(main)}-${id}`)

/**
 * The lane engine to run against a repo.
 *
 * There is one engine on the machine and it drives every project, so where it lives has
 * nothing to do with which repo it is pointed at. Looking for it at `<repo>/scripts/
 * lane.mjs` found it exactly once - when the repo was PaneForge's own checkout - and for
 * any other project silently spawned a path that does not exist. That is what the two
 * automatic halves of the strip are: the retry that clears conflicts on their own and the
 * hand-back of a dead chat's lane. Both were dead for everyone but this repo, quietly,
 * because a spawn failure here has nowhere to be seen.
 *
 * An installed copy ships it under resources/ (see `extraResources` in package.json); a
 * dev run has it in the checkout. `PANEFORGE_ENGINE` overrides both. `--repo` then says
 * which project, which is the flag the engine has always taken.
 */
export function laneEngine(main: string): string | null {
  // Not `process.resourcesPath` directly: that property is Electron's, and this file is
  // compiled on its own (without electron's types) by the lane tests.
  const resources = (process as unknown as { resourcesPath?: string }).resourcesPath
  const tries = [
    process.env.PANEFORGE_ENGINE,
    join(main, 'scripts', 'lane.mjs'),
    resources ? join(resources, 'scripts', 'lane.mjs') : undefined
  ].filter(Boolean) as string[]
  return tries.find((p) => existsSync(p)) ?? null
}

/**
 * One line per lane worth showing. A lane nobody holds, with nothing in it, is not a
 * fact about today's work - it is an empty slot, and it stays off the strip.
 */
export function laneBoard(panes: LanePane[] = []): LaneBoard | null {
  const now = Date.now()
  if (now - cache.at < TTL) return cache.board
  cache = { at: now, board: read(panes) }
  return cache.board
}

/**
 * Ask lane.mjs to try the stuck lanes again, and to put out anything that is waiting.
 *
 * Both halves only ever happened as a side effect of a chat running some other lane
 * command. Half of these conflicts stop existing on their own - the change they disagreed
 * with ships, or rerere learns the resolution in another lane - and finished work that
 * arrives inside the release cooldown goes out on the next trigger. On an evening where
 * nobody types there is no next trigger, so a lane that would merge fine reads "stuck"
 * until morning and finished work sits on master beside it. The app has a clock, so it
 * does both: no window, no output, nothing on screen.
 *
 * Cheap by construction. It only runs while a lane is actually conflicted or waiting to
 * go out, at most every RETRY_EVERY, and on the other side lane.mjs skips a lane whose
 * master has not moved and returns from the release without work in one `rev-list`.
 */
export function laneRetry(panes: LanePane[] = []): void {
  const board = laneBoard(panes)
  if (!board || retrying) return
  if (!board.lanes.some((l) => l.conflicted || l.ready)) return
  const engine = laneEngine(board.repo)
  if (!engine) return
  const now = Date.now()
  if (now - retryAt < RETRY_EVERY) return
  retryAt = now
  retrying = true
  execFile(
    process.execPath,
    [engine, 'retry', '--repo', board.repo],
    {
      cwd: board.repo,
      windowsHide: true,
      timeout: RETRY_TIMEOUT,
      // process.execPath is Electron here; this makes that binary behave as plain node,
      // so the retry does not depend on node being on the app's PATH.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    },
    (_err, stdout, stderr) => {
      retrying = false
      // What it said, kept. This runs with no window and its output went nowhere, so a
      // release that refuses every ten minutes ("No release yet: ...") was invisible:
      // lane a stayed finished-but-unshipped for a day and the only way to find out why
      // was to re-run the command by hand. See noteRetry.
      noteRetry(board.repo, `${stdout ?? ''}${stderr ?? ''}`)
      // Whatever it did (cleared a lane, marked one ready, shipped) is in the state file
      // now; drop the TTL cache so the strip shows it on its next poll, not in 4s.
      cache = { at: 0, board: null }
    }
  )
}

/** Enough retry log to see a pattern, small enough to never be a problem. */
const RETRY_LOG_MAX = 64 * 1024

/**
 * One line per thing the timed retry actually said, in the repo's own .git.
 *
 * Not a real logger: silence is the normal case, so this file only ever grows when
 * something is stuck, and the oldest half is dropped rather than rotated.
 */
function noteRetry(main: string, out: string): void {
  const said = out.trim()
  if (!said) return
  const file = join(main, '.git', 'paneforge-lane-retry.log')
  try {
    let prev = ''
    try {
      prev = readFileSync(file, 'utf8')
    } catch {
      /* first line */
    }
    const next = `${prev}${new Date().toISOString()} ${said.replace(/\s*\n\s*/g, ' | ')}\n`
    writeFileSync(file, next.length > RETRY_LOG_MAX ? next.slice(-RETRY_LOG_MAX) : next, 'utf8')
  } catch {
    /* a log we cannot write is not worth losing the retry over */
  }
}

/** As much of a pane as lane ownership depends on. */
export interface LanePane {
  id: string
  cwd: string
  /** the conversation this pane is in - the same id a lane hold records as its chat */
  resumeId?: string
}

/**
 * One folder, one spelling. A lane's folder is whatever a chat's hook passed to lane.mjs
 * and a pane's is whatever it was started with, so one of them arrives with backslashes,
 * a trailing one, or the drive letter in the other case.
 */
const samePath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const under = (a: string, b: string): boolean => a === b || a.startsWith(b + '/')

/**
 * Say which pane each lane's chat is actually in.
 *
 * This used to be done by folder alone, in the renderer, and it was wrong in the one case
 * that matters: every chat that starts in the main checkout records THAT folder, whichever
 * lane it is handed. Two chats died holding lanes `main` and `a`, both recorded from
 * `...\PaneForge`; the strip listed them (correctly) as lanes nobody was in - and then a
 * new chat opened in the same folder and *both* vanished from it, because one pane matched
 * both by cwd. The dead holds were still there, still counting down their 12h staleness,
 * with nothing on screen saying so. Chat ids are unique where folders are not, so a hold is
 * matched to the pane whose conversation IS that chat.
 *
 * The folder is still the fallback, but only for a pane whose conversation cannot be named
 * yet (a transcript is written on the first prompt), and only once per pane - so a pane can
 * own one lane, never three.
 */
export function attachLaneOwners(board: LaneBoard | null, panes: LanePane[]): LaneBoard | null {
  if (!board) return board
  const taken = new Set<string>()
  return { ...board, lanes: board.lanes.map((l) => ({ ...l, ownerPane: ownerOf(l, panes, taken) })) }
}

function ownerOf(lane: LaneBoardEntry, panes: LanePane[], taken: Set<string>): string | null {
  if (lane.session) {
    const exact = panes.find((p) => p.resumeId && p.resumeId === lane.session)
    if (exact) {
      taken.add(exact.id)
      return exact.id
    }
  }
  const from = lane.from ? samePath(lane.from) : null
  if (!from) return null
  // Either path may be the deeper one (a chat that `cd`s into a subfolder reports it, and a
  // pane may be opened on a subfolder of a lane), so containment is checked both ways and
  // the longest match wins.
  const pick = panes
    .filter((p) => !p.resumeId && !taken.has(p.id))
    .filter((p) => under(from, samePath(p.cwd)) || under(samePath(p.cwd), from))
    .sort((a, b) => samePath(b.cwd).length - samePath(a.cwd).length)[0]
  if (!pick) return null
  taken.add(pick.id)
  return pick.id
}

/**
 * A hold whose chat is in no pane and has said nothing for this long belongs to a chat that
 * is gone. Generous on purpose: `seen` moves on every prompt, so this is fifteen minutes of
 * a chat neither typing nor existing on screen, and a pane that is merely idle still holds
 * its lane because the pane is still there to be matched.
 */
const GONE_MS = 15 * 60 * 1000

/**
 * The chats whose lanes should be given back, because nothing on this machine is them.
 *
 * `living` is every chat any RUNNING copy of PaneForge says it is hosting, not just this
 * one's panes. More than one copy is normal here - `npm run try` opens a second one all
 * day - and a test copy hosts no chats at all, so a window judging liveness by its own
 * panes alone would decide that every chat in the real window had died and hand out
 * checkouts people are typing in. That is worse than the bug this fixes.
 */
export function goneLanes(board: LaneBoard | null, living: Set<string>, now = Date.now()): string[] {
  return (board?.lanes ?? [])
    .filter((l) => l.held && l.session && !l.ownerPane && !living.has(l.session))
    .filter((l) => now - l.seen > GONE_MS)
    .map((l) => l.session as string)
}

/** Where the running copies of the app say which chats they are hosting. */
const panesFile = (main: string): string => join(main, '.git', 'paneforge-panes.json')
/** An entry from a copy that has not said anything for this long is a copy that has quit. */
const BEAT_STALE_MS = 5 * 60 * 1000
/** This copy, for as long as it runs. Profiles mean two copies share nothing else. */
const INSTANCE = `pf-${process.pid}`

interface Beat {
  at: number
  chats: string[]
}

/**
 * Say which chats this window is hosting, and read back what every other copy says.
 *
 * Deliberately NOT the lane state file: that one is lane.mjs's, written by hooks from
 * several chats at once, and a second writer on a different clock is how a state file
 * gets half-written. This is a separate file, written the same way (write then rename),
 * and nothing but this function reads it.
 */
function heartbeat(main: string, chats: string[]): Set<string> {
  const file = panesFile(main)
  let all: Record<string, Beat> = {}
  try {
    all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Beat>
  } catch {
    /* first run, or something else wrote there - ours is the only entry that matters */
  }
  const now = Date.now()
  all[INSTANCE] = { at: now, chats }
  for (const [id, beat] of Object.entries(all)) {
    if (now - (beat?.at ?? 0) > BEAT_STALE_MS) delete all[id]
  }
  try {
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(all), 'utf8')
    renameSync(tmp, file)
  } catch {
    /* a read-only or vanished .git is not worth a crash on a heartbeat */
  }
  return new Set(Object.values(all).flatMap((b) => b?.chats ?? []))
}

let reclaiming = false

/**
 * Give back a lane whose chat died without ending.
 *
 * `release` is exactly what that chat's SessionEnd hook would have run: any committed work
 * is marked done, the lane is freed, its leftover test copy is closed and the release it
 * was holding up goes out. Until now nothing ever ran it for a chat that was killed rather
 * than closed, so the lane stayed held for the full 12h staleness window - visible to every
 * other chat as "a chat has it", and blocking the automatic release the whole time.
 *
 * One lane per tick: each release ends in an autoship, and there is no reason to run two at
 * once when the tick comes round every minute.
 */
export function laneReclaim(panes: LanePane[]): void {
  if (reclaiming) return
  const main = findRepo(panes)
  if (!main) return
  const board = attachLaneOwners(laneBoard(panes), panes)
  // Our own panes are in this list too, so a chat is never judged dead by the window it
  // is running in - only by every window agreeing it is nowhere.
  const living = heartbeat(
    main,
    panes.map((p) => p.resumeId).filter((c): c is string => Boolean(c))
  )
  const gone = goneLanes(board, living)
  if (!board || !gone.length) return
  const engine = laneEngine(board.repo)
  if (!engine) return
  reclaiming = true
  execFile(
    process.execPath,
    [engine, 'release', '--repo', board.repo, '--session', gone[0]],
    {
      cwd: board.repo,
      windowsHide: true,
      timeout: RETRY_TIMEOUT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    },
    () => {
      reclaiming = false
      cache = { at: 0, board: null }
    }
  )
}

function readState(panes: LanePane[] = []): RawState | null {
  const main = findRepo(panes)
  if (!main) return null
  const file = join(main, '.git', 'paneforge-lanes.json')
  try {
    // A half-written file is impossible (lane.mjs writes then renames), so a parse
    // failure means something else wrote there - drawing nothing is the right answer.
    if (!statSync(file).isFile()) return null
    return JSON.parse(readFileSync(file, 'utf8')) as RawState
  } catch {
    return null
  }
}

/**
 * The last release cut on this machine, read fresh.
 *
 * The updater asks this to know a version exists before GitHub can serve it (see
 * `chasing()` there). Deliberately not the cached board: it is asked once every few
 * minutes, and a stale answer is the difference between chasing a release and waiting
 * out the idle poll.
 */
export function lastShip(): { version: string; at: number } | null {
  const ship = readState()?.lastShip
  return ship?.version && ship.at ? { version: ship.version, at: ship.at } : null
}

function read(panes: LanePane[] = []): LaneBoard | null {
  const main = findRepo(panes)
  if (!main) return null
  const state = readState(panes)
  if (!state) return null
  const mb = mainBranch(main)

  const lanes: LaneBoardEntry[] = []
  const now = Date.now()
  for (const id of POOL) {
    const raw = state.lanes?.[id]
    const conflict = state.conflicts?.[id]
    const ready = Boolean(state.ready?.[id])
    // A lane a chat reserved by saying "PaneForge" in a chat about something else is not a
    // fact about this screen: it put a "PF lane main" chip on a Jarvis pane whose chat had
    // never opened the repo. It becomes a real hold the moment that chat writes in it
    // (lane.mjs `guard`), and until then only its own lane file knows about it.
    const held = raw?.tentative ? undefined : raw
    if (!held && !conflict && !ready) continue
    const seen = held?.seen ?? held?.claimed ?? 0
    // A chat that took a conflict over and then died kept the claim forever, because
    // nothing here ever aged it out: the strip drew "a chat has it", the automatic
    // hand-over skipped the lane on that word, and the fix button was hidden. lane.mjs
    // has always expired the claim after the same silence it allows a lane's own chat -
    // this is that rule, so both halves of the app agree on who owns a conflict.
    const claimStale = Boolean(conflict?.resolver) && now - (conflict?.resolverAt ?? 0) > ADOPT_MS
    const resolver = claimStale ? null : (conflict?.resolver ?? null)
    lanes.push({
      lane: id,
      dir: laneDir(main, id),
      branch: id === 'main' ? mb : `lane-${id}`,
      from: held?.cwd ?? null,
      session: held?.session ?? null,
      // Filled in by attachLaneOwners, which is the only place that knows what panes exist.
      ownerPane: null,
      held: Boolean(held),
      seen,
      ready,
      conflicted: Boolean(conflict),
      conflictSince: conflict?.since ?? conflict?.at,
      conflictDetail: conflict?.detail,
      // The same rule lane.mjs applies: a conflict whose chat has gone quiet can be
      // taken over by any other chat, which is the thing worth telling a human. A live
      // resolver owns it on the same terms, so it is not adoptable while one is fresh.
      adoptable: Boolean(conflict) && !resolver && (!held || now - seen > ADOPT_MS),
      resolver
    })
  }

  return {
    repo: main,
    lanes,
    releasing: state.release?.at ?? null,
    lastShip: state.lastShip ?? null
  }
}
