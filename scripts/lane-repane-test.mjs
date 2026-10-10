// Regression test: a chat reopened in a NEW PaneForge pane lost its lane (2026-10-10, Mac,
// videos repo).
//
// PaneForge's memory send-off ends a chat's CLI to move it to the PC; when the move fails it
// starts the same conversation again in a new pane, with a new PF_PANE (paneforge-next
// server/cli-routes.mjs, `terminal.create` after `terminal.end`). Measured that morning:
//
//   10:28am  /clear in pane 64257da2: SessionEnd stamped the old chat's hold on lane c
//            (39 uncommitted files) ended and kept it for the pane's next chat.
//   10:46am  the send-off's move failed and the card reopened in pane 10d6b2fa.
//   10:48am  /clear in 10d6b2fa; its new chat claimed with --prefer c and was handed lane d
//            ("standingIn": "c"): the carry only matched `pane === PF_PANE`, and the hold
//            still wore 64257da2. Every write to videos-c was refused.
//   11:04am  the next failed move ended the CLI again; its SessionEnd release gave the
//            dirty hold up outright (only /clear kept one), so lane c sat unheld.
//
// The card (PF_CHAT, the app's id for the chat, the same in every pane it is reopened in)
// is what survives a reopen. A hold records it, the carry matches it, and an ended card's
// unfinished hold is kept for that card instead of being given away. Nothing else may take it.
//
// Real git repos in the temp folder, real lane.mjs, no stubs.
//
//   node scripts/lane-repane-test.mjs

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'paneforge-lane-repane-test-'))

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${String(detail).split('\n').join('\n      ')}`)
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

function fixture(name) {
  const repo = join(root, name)
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: name.toLowerCase(), version: '0.0.1' }, null, 2) + '\n')
  writeFileSync(join(repo, 'app.js'), 'console.log(1)\n')
  writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ lanes: true, pool: ['main', 'a', 'b', 'c'] }, null, 2) + '\n')
  installLane(here, repo)
  git(repo, 'init', '-q', '-b', 'master')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'first')
  git(repo, 'tag', 'v0.0.1')

  /** `at` is where the chat runs: `{ pane, chat }` - PF_PANE and PF_CHAT as the app sets them. */
  const lane = (at, ...args) => {
    const env = { ...process.env, PF_RELEASE: 'version' }
    delete env.PF_PANE
    delete env.PF_CHAT
    if (at.pane) env.PF_PANE = at.pane
    if (at.chat) env.PF_CHAT = at.chat
    try {
      return { ok: true, out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], { cwd: repo, encoding: 'utf8', stdio: 'pipe', env }).trim() }
    } catch (e) {
      return { ok: false, out: String(e.stdout ?? '').trim(), err: String(e.stderr ?? '').trim() }
    }
  }
  const statePath = join(repo, '.git', 'paneforge-lanes.json')
  const state = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { lanes: {}, ready: {}, conflicts: {} })
  const patchState = (fn) => {
    const s = state()
    fn(s)
    writeFileSync(statePath, JSON.stringify(s, null, 2) + '\n', 'utf8')
  }
  const claim = (at, session, ...more) => {
    const r = lane(at, 'claim', '--session', session, ...more)
    return r.ok ? JSON.parse(r.out) : { error: r.err || r.out }
  }
  const laneOf = (session) => Object.entries(state().lanes).find(([, c]) => c.session === session)?.[0] ?? null
  /** SessionEnd as lane-hook runs it: the holds stamped ended in-line, then the release. */
  const sessionEnd = (at, session, reason) => {
    lane(at, 'park', '--session', session, '--ended')
    return lane(at, 'release', '--session', session, reason === 'clear' ? '--cleared' : '--closed')
  }
  // No release attempts in a repo with no remote.
  patchState((s) => (s.lastShip = { version: '0.0.1', at: Date.now(), lanes: [] }))
  return { repo, lane, state, claim, laneOf, sessionEnd }
}

/** Lane c held by `session`, with uncommitted files in it - the work that must not be stranded. */
function heldWithWork(f, at, session) {
  const c = f.claim(at, session, '--cwd', f.repo, '--prefer', 'c')
  writeFileSync(join(c.dir, 'wip.js'), 'thirty-nine files of video work, uncommitted\n')
  return c
}

const A = { pane: 'pane-64257da2', chat: 'card-c32cd7f7' }
const B = { pane: 'pane-10d6b2fa', chat: 'card-c32cd7f7' }
const C = { pane: 'pane-cd8c848b', chat: 'card-c32cd7f7' }

// ------------------------------------------- A. the measured sequence

{
  const f = fixture('Measured')
  const c = heldWithWork(f, A, 'first-chat')
  f.sessionEnd(A, 'first-chat', 'clear')
  ok('A: (setup) the cleared hold is kept for the pane, ended', f.state().lanes.c?.session === 'first-chat' && f.state().lanes.c?.ended, JSON.stringify(f.state().lanes))
  // The pane's next chat never touches this repo; the card is then reopened in pane B and
  // that chat is cleared too, so the hold's own session never comes back.
  f.sessionEnd(B, 'second-chat', 'clear')
  const got = f.claim(B, 'third-chat', '--cwd', c.dir, '--prefer', 'c')
  ok('A: the reopened card\'s next chat is handed the lane its earlier chat held', got.lane === 'c', JSON.stringify(got))
  ok('A: and stands in its own folder', got.standingIn === null, JSON.stringify(got))
  ok('A: the earlier session id holds nothing', !f.laneOf('first-chat'), JSON.stringify(f.state().lanes))
  ok('A: its uncommitted work is untouched', existsSync(join(c.dir, 'wip.js')))
  const write = f.lane(B, 'guard', '--session', 'third-chat', '--path', join(c.dir, 'wip.js'))
  ok('A: and it may write in its own folder', write.ok && !write.out, write.out || write.err)
  ok('A: the hold now wears the pane it lives in', f.state().lanes.c?.pane === B.pane && f.state().lanes.c?.chat === B.chat, JSON.stringify(f.state().lanes.c))
}

{
  // The incident's chat sat in another repo's folder (claude-memory) and worked in this one
  // by writing into it: no prompt hook claims a repo the chat is not in, so its first write
  // is the first the engine hears of it.
  const f = fixture('WriteFirst')
  const c = heldWithWork(f, A, 'first-chat')
  f.sessionEnd(A, 'first-chat', 'clear')
  f.sessionEnd(B, 'second-chat', 'clear')
  const write = f.lane(B, 'guard', '--session', 'third-chat', '--path', join(c.dir, 'wip.js'))
  ok('A: the reopened card\'s next chat may write in the lane straight away', write.ok && !write.out, write.out || write.err)
  ok('A: and the write carried the hold to it', f.state().lanes.c?.session === 'third-chat' && !f.state().lanes.c?.ended, JSON.stringify(f.state().lanes))
}

// ------------------------------------------- B. the chat itself goes on in the new pane

{
  // The literal shape: the same conversation resumes in pane B, writes in its lane, then /clear.
  const f = fixture('Resumed')
  const c = heldWithWork(f, A, 'resumed-chat')
  const write = f.lane(B, 'guard', '--session', 'resumed-chat', '--path', join(c.dir, 'wip.js'))
  ok('B: (setup) the resumed chat may write in its lane from the new pane', write.ok && !write.out, write.out || write.err)
  ok('B: its write moves the hold to the pane it now runs in', f.state().lanes.c?.pane === B.pane, JSON.stringify(f.state().lanes.c))
  f.sessionEnd(B, 'resumed-chat', 'clear')
  const got = f.claim(B, 'after-clear', '--cwd', c.dir, '--prefer', 'c')
  ok('B: after /clear the new pane\'s next chat gets the lane', got.lane === 'c', JSON.stringify(got))
}

{
  // Same, from an app that sets no card id (PaneForge Classic, or an older app): the write in
  // the new pane is the only word that the chat moved, and it is enough.
  const f = fixture('ResumedNoCard')
  const c = heldWithWork(f, { pane: A.pane }, 'resumed-chat')
  f.lane({ pane: B.pane }, 'guard', '--session', 'resumed-chat', '--path', join(c.dir, 'wip.js'))
  f.sessionEnd({ pane: B.pane }, 'resumed-chat', 'clear')
  const got = f.claim({ pane: B.pane }, 'after-clear', '--cwd', c.dir, '--prefer', 'c')
  ok('B: without a card id, a write from the new pane still lets its next chat carry the lane', got.lane === 'c', JSON.stringify(got))
}

// ------------------------------------------- C. the app ending the CLI (a move, a failed move)

{
  const f = fixture('Moved')
  const c = heldWithWork(f, B, 'moving-chat')
  f.sessionEnd(B, 'moving-chat', 'other')
  ok('C: the app ending a card\'s CLI does not give its unfinished lane away', f.state().lanes.c?.session === 'moving-chat' && f.state().lanes.c?.ended, JSON.stringify(f.state().lanes))
  // The failed move reopens the same conversation in pane C, and it speaks again.
  const back = f.claim(C, 'moving-chat', '--cwd', c.dir, '--prefer', 'c')
  ok('C: the conversation reopened in a new pane has its lane', back.lane === 'c' && !f.state().lanes.c?.ended, JSON.stringify(back))
  ok('C: worn by the new pane', f.state().lanes.c?.pane === C.pane, JSON.stringify(f.state().lanes.c))
}

{
  const f = fixture('MovedThenCleared')
  const c = heldWithWork(f, B, 'moving-chat')
  f.sessionEnd(B, 'moving-chat', 'other')
  // Reopened in pane C and cleared before it touched this repo again.
  f.sessionEnd(C, 'moving-chat', 'clear')
  const got = f.claim(C, 'after-clear', '--cwd', c.dir, '--prefer', 'c')
  ok('C: reopened, then cleared: the card\'s next chat carries the lane', got.lane === 'c', JSON.stringify(got))
}

{
  const f = fixture('MovedEmpty')
  f.claim(B, 'moving-chat', '--cwd', f.repo, '--prefer', 'c')
  f.sessionEnd(B, 'moving-chat', 'other')
  ok('C: an EMPTY lane is still given back when the CLI ends', !f.state().lanes.c, JSON.stringify(f.state().lanes))
}

{
  // A chat started outside the app (no card) that ends: given up exactly as before.
  const f = fixture('NoCardClosed')
  heldWithWork(f, { pane: B.pane }, 'plain-chat')
  f.sessionEnd({ pane: B.pane }, 'plain-chat', 'other')
  ok('C: a hold with no card is given up when its chat ends without /clear (unchanged)', !f.state().lanes.c, JSON.stringify(f.state().lanes))
}

{
  // A chat letting go of its lane by hand is not its CLI ending.
  const f = fixture('HandRelease')
  heldWithWork(f, B, 'giving-up')
  f.lane(B, 'release', '--session', 'giving-up')
  ok('C: `release` by hand still gives a dirty lane up (unchanged)', !f.state().lanes.c, JSON.stringify(f.state().lanes))
}

{
  // The app's sweep found no open card hosting it: the kept hold goes.
  const f = fixture('Gone')
  heldWithWork(f, B, 'closed-card')
  f.sessionEnd(B, 'closed-card', 'other')
  f.lane({}, 'release', '--session', 'closed-card', '--gone')
  ok('C: a card nobody has open any more lets it go', !f.state().lanes.c, JSON.stringify(f.state().lanes))
}

// ------------------------------------------- D. nobody else takes it

{
  const f = fixture('Others')
  const c = heldWithWork(f, A, 'first-chat')
  f.sessionEnd(A, 'first-chat', 'other')
  const other = f.claim({ pane: 'pane-other', chat: 'card-other' }, 'other-card', '--cwd', c.dir, '--prefer', 'c')
  ok('D: another card standing in the folder is not handed the ended card\'s lane', other.lane !== 'c' && f.state().lanes.c?.session === 'first-chat', JSON.stringify(other))
  const loose = f.claim({}, 'outside', '--cwd', c.dir, '--prefer', 'c')
  ok('D: nor a chat outside the app', loose.lane !== 'c' && f.state().lanes.c?.session === 'first-chat', JSON.stringify(loose))
  const samePaneOtherCard = f.claim({ pane: A.pane, chat: 'card-other-2' }, 'odd', '--cwd', c.dir, '--prefer', 'c')
  ok('D: nor a chat that shares the pane id but names another card (the card decides)', samePaneOtherCard.lane !== 'c' && f.state().lanes.c?.session === 'first-chat', JSON.stringify(samePaneOtherCard))
  const write = f.lane({ pane: 'pane-other', chat: 'card-other' }, 'guard', '--session', 'other-card', '--path', join(c.dir, 'wip.js'))
  ok('D: and another card\'s write into the folder is refused', /belongs to another chat/.test(`${write.out} ${write.err ?? ''}`) && f.state().lanes.c?.session === 'first-chat', write.out || write.err)
}

{
  // A `claude -p` the chat runs inherits PF_PANE and PF_CHAT: while its parent is alive (not
  // ended) it is not the card's next chat.
  const f = fixture('Child')
  const c = heldWithWork(f, B, 'parent')
  const child = f.claim(B, 'child', '--cwd', c.dir, '--prefer', 'c')
  ok('D: a child process of a live chat does not take its lane', child.lane !== 'c' && f.state().lanes.c?.session === 'parent', JSON.stringify(child))
}

rmSync(root, { recursive: true, force: true })
console.log(failed ? `\n${failed} FAIL` : '\nall ok')
process.exit(failed ? 1 : 0)
