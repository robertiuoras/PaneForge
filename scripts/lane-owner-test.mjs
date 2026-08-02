// Who holds a lane, and what happens when nobody does - src/main/laneBoard.ts.
//
// The bug this pins was visible on screen and invisible to every check: two chats died
// holding lanes `main` and `a`. The strip listed them correctly ("Lanes elsewhere (2)")
// until a NEW chat opened - in the main checkout, like every chat does - and both lanes
// vanished from it while still held. The old ownership rule matched a lane to a pane by
// FOLDER, and every lane records the folder its chat started in, so one pane matched two
// lanes at once and claimed them both. The holds were still in the state file, still
// blocking releases, with nothing anywhere saying so for the twelve hours of the
// staleness window.
//
// So this checks the two halves of the answer:
//   1. a lane belongs to the pane whose CONVERSATION is the chat holding it, and to at
//      most one pane, and to none when that chat is not on screen;
//   2. a hold nothing on screen is, quiet for GONE_MS, is handed back rather than left to
//      time out - which is what `laneReclaim` runs `lane.mjs release` for.
//
//   node scripts/lane-owner-test.mjs

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'pf-laneowner-'))
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
    // The project compiles strict. Without this flag the same files are compiled with
    // strictNullChecks OFF, where an unrelated shared type stops being assignable and
    // the test dies on a type error `npm run typecheck` does not have (three lane tests
    // were red on master for exactly this, saying nothing about lanes).
    '--strict'
  ],
  { cwd: repoRoot, stdio: 'pipe' }
)
writeFileSync(join(out, 'package.json'), '{"type":"module"}')

/**
 * A fresh copy of the module per case.
 *
 * laneBoard caches the board for four seconds and the repo path forever - both right for
 * an app that polls every five seconds, both wrong for a test that rewrites the state file
 * five times in one tick. A new module instance starts with empty caches.
 */
function load() {
  return import(`${pathToFileURL(join(out, 'main', 'laneBoard.js')).href}?n=${++loads}`)
}

/** Write the lane state file the app reads, in lane.mjs's own shape. */
function state(lanes) {
  mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(
    join(repo, '.git', 'paneforge-lanes.json'),
    JSON.stringify({ lanes, ready: {}, conflicts: {}, release: null, lastShip: null })
  )
}

process.env.PANEFORGE_REPO = repo

const now = Date.now()
const CHAT_MAIN = 'dbb1ac5b-6f9d-4f81-8840-a04a9ca07f3e'
const CHAT_A = 'be586715-e2c9-4e0b-8c96-760573c62d20'
const CHAT_B = 'c46f0272-db12-43ba-a12f-e9e8ca924337'

// The exact state that produced the bug: two dead chats, both recorded from the main
// checkout, quiet for hours.
const twoDead = {
  main: { session: CHAT_MAIN, cwd: repo, claimed: now - 4 * 3600_000, seen: now - 3 * 3600_000 },
  a: { session: CHAT_A, cwd: repo, claimed: now - 3 * 3600_000, seen: now - 2 * 3600_000 }
}

{
  // A new chat opens in the same folder. It is not either dead chat, so it owns neither.
  state(twoDead)
  const { attachLaneOwners, laneBoard } = await load()
  const board = attachLaneOwners(laneBoard(), [{ id: 'pane1', cwd: repo, resumeId: CHAT_B }])
  const owned = board.lanes.filter((l) => l.ownerPane)
  check('a new pane in the same folder owns neither dead chat’s lane', owned.length === 0,
    `owned ${owned.map((l) => l.lane).join(', ')}`)
  check('both dead holds stay on the strip', board.lanes.filter((l) => l.held).length === 2)
}

{
  // The chat holding lane a is alive in a pane: that lane is its, the other one is not.
  state(twoDead)
  const { attachLaneOwners, laneBoard } = await load()
  const board = attachLaneOwners(laneBoard(), [
    { id: 'pane1', cwd: repo, resumeId: CHAT_A },
    { id: 'pane2', cwd: repo, resumeId: CHAT_B }
  ])
  const byLane = Object.fromEntries(board.lanes.map((l) => [l.lane, l.ownerPane]))
  check('a lane is matched to the pane whose conversation holds it', byLane.a === 'pane1', JSON.stringify(byLane))
  check('and not to any other pane in the same folder', byLane.main === null, JSON.stringify(byLane))
}

{
  // A pane whose conversation cannot be named yet (nothing written since it opened) still
  // gets the folder fallback - but only once, or it collects every lane in the folder.
  state(twoDead)
  const { attachLaneOwners, laneBoard } = await load()
  const board = attachLaneOwners(laneBoard(), [{ id: 'pane1', cwd: repo }])
  const owned = board.lanes.filter((l) => l.ownerPane === 'pane1')
  check('a pane with no conversation id claims one lane by folder, not two', owned.length === 1,
    `owned ${owned.map((l) => l.lane).join(', ')}`)
}

{
  // A chat that `cd`s into a subfolder records it; the pane still reports where it opened.
  state({ c: { session: CHAT_B, cwd: join(repo, 'scripts'), claimed: now, seen: now } })
  const { attachLaneOwners, laneBoard } = await load()
  const board = attachLaneOwners(laneBoard(), [{ id: 'pane1', cwd: repo }])
  check('the folder fallback still matches a subfolder', board.lanes[0].ownerPane === 'pane1')
}

{
  // What gets handed back. Quiet and unowned is a dead chat; owned or recent is not.
  state({
    main: { session: CHAT_MAIN, cwd: repo, claimed: now - 4 * 3600_000, seen: now - 3 * 3600_000 },
    a: { session: CHAT_A, cwd: repo, claimed: now - 3 * 3600_000, seen: now - 2 * 3600_000 },
    b: { session: CHAT_B, cwd: repo, claimed: now - 60_000, seen: now - 60_000 }
  })
  const { attachLaneOwners, goneLanes, laneBoard } = await load()
  const board = attachLaneOwners(laneBoard(), [{ id: 'pane1', cwd: repo, resumeId: CHAT_A }])
  const gone = goneLanes(board, new Set([CHAT_A]), now)
  check('a hold no pane is, quiet for hours, is reclaimed', gone.includes(CHAT_MAIN), JSON.stringify(gone))
  check('a hold whose chat is in a pane is left alone', !gone.includes(CHAT_A), JSON.stringify(gone))
  check('a hold that spoke a minute ago is left alone', !gone.includes(CHAT_B), JSON.stringify(gone))

  // The case that makes this safe to run at all: a SECOND copy of the app (a test copy
  // from `npm run try`, which hosts no chats of its own) must not decide that the chats
  // in the real window have died. It sees them because every copy publishes what it hosts.
  const blind = attachLaneOwners(laneBoard(), [])
  const goneToTestCopy = goneLanes(blind, new Set([CHAT_MAIN, CHAT_A, CHAT_B]), now)
  check('a copy hosting no panes reclaims nothing another copy is hosting',
    goneToTestCopy.length === 0, JSON.stringify(goneToTestCopy))
}

{
  // The grace period is the whole safety margin: a chat that started two minutes ago and
  // has not been matched to a pane yet must not have its lane taken away.
  state({ a: { session: CHAT_A, cwd: repo, claimed: now - 120_000, seen: now - 120_000 } })
  const { attachLaneOwners, goneLanes, laneBoard } = await load()
  const board = attachLaneOwners(laneBoard(), [])
  check('a hold minutes old is not reclaimed even with no panes at all',
    goneLanes(board, new Set(), now).length === 0)
}

{
  // Two projects open on one desk, which is the normal case now that lanes are not this
  // repo's alone. `findRepo` votes and one project wins, and the winner used to be the
  // only one that got a heartbeat or a hand-back: every other repo's panes file went
  // stale, so no chat in it counted as living, no dead hold was ever given back, and every
  // chat that opened there was told another chat had the lane - for the full 12h staleness
  // window. Measured on a real desk before this: the losing repo's file was four hours old
  // and written by a copy that had quit.
  delete process.env.PANEFORGE_REPO
  const other = join(work, 'other-project')
  mkdirSync(join(other, '.git'), { recursive: true })
  const CHAT_C = 'f2c2a5f7-6c50-4f43-a2f2-6da1b6a2b8a1'
  // The winner of the vote (two panes) has nothing to reclaim: its one hold is a pane.
  state({ a: { session: CHAT_A, cwd: repo, claimed: now - 60_000, seen: now - 60_000 } })
  writeFileSync(
    join(other, '.git', 'paneforge-lanes.json'),
    JSON.stringify({
      lanes: { main: { session: CHAT_MAIN, cwd: other, claimed: now - 4 * 3600_000, seen: now - 3 * 3600_000 } },
      ready: {},
      conflicts: {},
      release: null,
      lastShip: null
    })
  )
  // The engine is spawned, never imported, so the fake one only has to write down its argv.
  const engine = join(work, 'fake-engine.mjs')
  const calls = join(work, 'calls.json')
  writeFileSync(engine, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2)))`)
  process.env.PANEFORGE_ENGINE = engine

  const { laneReclaim } = await load()
  laneReclaim([
    { id: 'pane1', cwd: repo, resumeId: CHAT_A },
    { id: 'pane2', cwd: repo, resumeId: CHAT_B },
    { id: 'pane3', cwd: other, resumeId: CHAT_C }
  ])

  const beat = (main) => JSON.parse(readFileSync(join(main, '.git', 'paneforge-panes.json'), 'utf8'))
  const chatsIn = (main) => Object.values(beat(main)).flatMap((b) => b.chats)
  check('the repo that wins the vote is told what this copy hosts', chatsIn(repo).includes(CHAT_A))
  check(
    'and so is every other repo a pane is in, with the whole machine’s chats',
    [CHAT_A, CHAT_B, CHAT_C].every((c) => chatsIn(other).includes(c)),
    JSON.stringify(chatsIn(other))
  )

  // The spawn is async, and a hand-back that never happens looks exactly like one that has
  // not happened yet - so this waits rather than asserting on the next line.
  const until = Date.now() + 5000
  while (!existsSync(calls) && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
  const argv = existsSync(calls) ? JSON.parse(readFileSync(calls, 'utf8')) : []
  check('a dead hold in the repo that LOST the vote is still handed back',
    argv[0] === 'release' && argv.includes(CHAT_MAIN), JSON.stringify(argv))
  check('and handed back against that repo, not the one on the strip',
    argv.includes(other), JSON.stringify(argv))
  delete process.env.PANEFORGE_ENGINE
}

rmSync(work, { recursive: true, force: true })
console.log(failures ? `\n${failures} failed` : '\nall good')
process.exit(failures ? 1 : 0)
