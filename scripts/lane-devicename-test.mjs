/**
 * Which desk a lane is on - src/main/laneBoard.ts.
 *
 * The strip's "Lanes elsewhere" list means one thing: no pane in THIS window is that
 * chat. It has never meant "this machine", and on a two-desk setup the most common row in
 * it - the trunk - was routinely a checkout on the other machine with nothing on the row
 * saying so. Robert's report was exactly that: "why shows main lanes elsewhere, can we
 * say which device, put the device name next to it".
 *
 * Two halves are checked here, and the second is the one with teeth:
 *
 *   1. Every row can name its desk. A lane out of this machine's own ledger is this
 *      machine's even when the record predates the stamp, and a claim another desk
 *      published becomes a row of its own naming that desk.
 *   2. Nothing local ever ACTS on a peer row. Its chat is alive on the other machine and
 *      is in no pane here by construction, so every existing test in `goneLanes` passes
 *      and the reclaim would run `lane.mjs release` on a checkout somebody is typing in.
 *
 *   node scripts/lane-devicename-test.mjs
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CLAIM_NS, refSafe } from './lane-peers.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'pf-lanedevice-'))
const repo = join(work, 'PaneForge')
let failures = 0
let loads = 0

function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` - ${detail}`}`)
  if (!ok) failures++
}

const out = join(work, 'build')
execFileSync(
  process.execPath,
  [
    join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    join('src', 'main', 'laneBoard.ts'),
    '--outDir',
    out,
    '--rootDir',
    'src',
    '--module',
    'es2022',
    '--target',
    'es2022',
    '--moduleResolution',
    'bundler',
    '--skipLibCheck',
    // Same reason as lane-owner-test.mjs: the project compiles strict, and without this
    // the shared types stop being assignable and the test dies on an error `npm run
    // typecheck` does not have.
    '--strict'
  ],
  { cwd: repoRoot, stdio: 'pipe' }
)
writeFileSync(join(out, 'package.json'), '{"type":"module"}')

/** laneBoard caches for four seconds and reads PF_DEVICE once, at load. */
function load() {
  return import(`${pathToFileURL(join(out, 'main', 'laneBoard.js')).href}?n=${++loads}`)
}

/** The lane state file the app reads, in lane.mjs's own shape. */
function state(extra) {
  mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(
    join(repo, '.git', 'paneforge-lanes.json'),
    JSON.stringify({ lanes: {}, ready: {}, conflicts: {}, release: null, lastShip: null, ...extra })
  )
}

const claim = (device, slot, session, at) => `${CLAIM_NS}/${device}/${slot}/${session}/${at}`

process.env.PANEFORGE_REPO = repo
process.env.PF_DEVICE = 'desk-here'

const now = Date.now()
const CHAT_LOCAL = 'be586715-e2c9-4e0b-8c96-760573c62d20'
const CHAT_AWAY = 'dbb1ac5b-6f9d-4f81-8840-a04a9ca07f3e'
const MINUTE = 60_000

// The spelling has to be the engine's, or the two halves disagree about who "we" are and
// this machine's own published claim comes back as a foreign desk holding the trunk.
{
  const { laneBoard } = await load()
  state({ lanes: { a: { session: CHAT_LOCAL, cwd: repo, claimed: now, seen: now } } })
  check('the board spells this desk the way the engine does', laneBoard()?.device === refSafe('desk-here', 40),
    String(laneBoard()?.device))
}

{
  // A record written before the stamp existed. The file is one machine's ledger, in a
  // local .git that no other machine writes, so "unstamped" is not "unknown".
  state({ lanes: { a: { session: CHAT_LOCAL, cwd: repo, claimed: now, seen: now } } })
  const { laneBoard } = await load()
  const a = laneBoard().lanes.find((l) => l.lane === 'a')
  check('an old record with no stamp is still named for this desk', a?.device === 'desk-here', String(a?.device))
  check('and is not mistaken for another machine’s claim', a?.peer === false, String(a?.peer))
}

{
  // The case on the desk today: the Mac holds master, this window has never been told.
  state({
    lanes: { a: { session: CHAT_LOCAL, cwd: repo, device: 'desk-here', claimed: now, seen: now } },
    peers: { at: now, refs: [claim('desk-away', 'main', CHAT_AWAY, now - 2 * MINUTE)] }
  })
  const { laneBoard } = await load()
  const board = laneBoard()
  const main = board.lanes.find((l) => l.lane === 'main')
  check('a trunk held at the other desk becomes a row of its own', Boolean(main),
    board.lanes.map((l) => l.lane).join(', '))
  check('named for the machine that has it', main?.device === 'desk-away', String(main?.device))
  check('flagged as somebody else’s, so nothing local touches it', main?.peer === true, String(main?.peer))
  check('and shown as held, because it is', main?.held === true, String(main?.held))
}

{
  // The teeth. A peer row satisfies every test goneLanes makes - held, has a session, no
  // pane here, older than GONE_MS - so without the guard the app would hand back a
  // checkout that is being typed in on the other machine.
  state({
    peers: { at: now, refs: [claim('desk-away', 'main', CHAT_AWAY, now - 40 * MINUTE)] }
  })
  const { goneLanes, laneBoard, attachLaneOwners } = await load()
  const board = attachLaneOwners(laneBoard(), [])
  const main = board.lanes.find((l) => l.lane === 'main')
  check('a peer claim is old enough to look abandoned from here', now - main.seen > 15 * 60_000)
  check('and is never handed back', goneLanes(board, new Set()).length === 0,
    goneLanes(board, new Set()).join(', '))
  check('nor matched to a pane', main.ownerPane === null, String(main.ownerPane))
}

{
  // Our own published claim is not another desk. Reading it back as one would draw this
  // machine as the peer holding the trunk it is actually holding itself.
  state({
    lanes: { main: { session: CHAT_LOCAL, cwd: repo, device: 'desk-here', claimed: now, seen: now } },
    peers: { at: now, refs: [claim('desk-here', 'main', CHAT_LOCAL, now - MINUTE)] }
  })
  const { laneBoard } = await load()
  const rows = laneBoard().lanes.filter((l) => l.lane === 'main')
  check('this desk’s own claim adds no second row', rows.length === 1, `${rows.length} rows`)
  check('and the one row is local', rows[0]?.peer === false, String(rows[0]?.peer))
}

{
  // A desk that went home. Staleness is judged on the claim's own timestamp, so a cache
  // nobody refreshes empties out instead of drawing a machine that is off.
  state({
    peers: { at: now, refs: [claim('desk-away', 'main', CHAT_AWAY, now - 90 * MINUTE)] }
  })
  const { laneBoard } = await load()
  check('a claim older than PEER_STALE_MS is not drawn at all', (laneBoard()?.lanes ?? []).length === 0,
    JSON.stringify(laneBoard()?.lanes))
}

{
  // The release lock is published in the same namespace and is not a lane. Drawing it
  // would put a row reading `release` in a strip whose every other row is a checkout.
  state({
    peers: { at: now, refs: [claim('desk-away', 'release', CHAT_AWAY, now - MINUTE)] }
  })
  const { laneBoard } = await load()
  check('a slot that is not a lane is ignored', (laneBoard()?.lanes ?? []).length === 0,
    JSON.stringify(laneBoard()?.lanes))
}

{
  // Anything that is not exactly the ref shape is dropped rather than guessed at: this
  // namespace lives on a shared remote and a ref from a future version must never be
  // drawn as somebody holding a checkout.
  state({
    peers: {
      at: now,
      refs: [
        'refs/paneforge/claims/desk-away/main/no-timestamp',
        'refs/heads/master',
        `${CLAIM_NS}/desk-away/main/${CHAT_AWAY}/not-a-number`
      ]
    }
  })
  const { laneBoard } = await load()
  check('a ref of the wrong shape is dropped, not guessed at', (laneBoard()?.lanes ?? []).length === 0,
    JSON.stringify(laneBoard()?.lanes))
}

rmSync(work, { recursive: true, force: true })
console.log(failures ? `\n${failures} failed` : '\nall good')
process.exit(failures ? 1 : 0)
