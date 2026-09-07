// What has happened to a copy, and the two ways a log like this lies.
//
// The arithmetic is a diff of two readings, so most of this is ordinary: a copy taken, a
// copy given back, a copy whose work went out. The checks that earn their place are the
// two failure modes a log built by polling has and a live strip does not:
//
//   1. INVENTION. The first reading of a run knows nothing about the past, and eight rows
//      saying "a chat started working in it" stamped with the moment the app launched are
//      eight lies on a list nobody can check. Only a fact carrying its own moment - a
//      disagreement's start, the release's own timestamp - may be written on a first read.
//   2. ABSENCE READ AS AN EVENT. A project stops being polled the moment its last chat
//      closes. If that read as "nobody is using it" the log would fill with sentences
//      about the app rather than about the work.
//
// The last section reads the SOURCE, the way activity-test.mjs does: the panel must be the
// same panel as the activity list (one look for one idea), and the row that opens it must
// be reachable from the keyboard - a reading nobody can get to with a keyboard is a
// reading half the app cannot use.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-lane-timeline-'))
const outfile = join(work, 'laneTimeline.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/laneTimeline.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const {
  laneChanges,
  addLaneEvent,
  eventsFor,
  laneEventId,
  laneEventLine,
  LANE_EVENT_WORDS,
  MAX_LANE_EVENTS,
  SAME_MS
} = createRequire(import.meta.url)(outfile)

let checks = 0
function check(what, ok, detail) {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` - got ${JSON.stringify(detail)}`}`)
}

const NOW = 1_800_000_000_000
const REPO = '/Users/x/Projects/PaneForge'
const name = () => 'PaneForge copy 3'

/** One lane row, with only the fields the diff reads. */
function lane(over = {}) {
  return {
    lane: 'b',
    dir: `${REPO}-b`,
    branch: 'lane-b',
    from: null,
    session: 'sess-1',
    ownerPane: null,
    held: false,
    seen: NOW,
    ready: false,
    conflicted: false,
    adoptable: false,
    resolver: null,
    device: 'mac',
    peer: false,
    ...over
  }
}

function board(lanes, over = {}) {
  return { repo: REPO, lanes, device: 'mac', releasing: null, lastShip: null, hold: null, ...over }
}

const kinds = (evts) => evts.map((e) => e.kind).sort()

// ---- 1. a first reading may not invent a past --------------------------------------

{
  const first = board([lane({ held: true }), lane({ lane: 'c', held: true, ready: true })])
  const got = laneChanges(undefined, first, name, NOW)
  check('a first reading writes nothing about a copy somebody merely holds', got.length === 0, kinds(got))
}

{
  const since = NOW - 3 * 3600_000
  const first = board([lane({ held: true, conflicted: true, conflictSince: since, conflictDetail: 'the same file' })])
  const got = laneChanges(undefined, first, name, NOW)
  check('a first reading DOES record a disagreement, which carries its own moment', kinds(got).join() === 'stuck', kinds(got))
  check('and stamps it when it actually started, not when the app opened', got[0].at === since, got[0].at)
  check('the reason is carried through', got[0].why === 'the same file', got[0].why)
}

{
  const at = NOW - 90 * 60_000
  const first = board([lane({ lane: 'f' }), lane({ lane: 'g' })], {
    lastShip: { version: 'v0.8.205', at, lanes: ['f', 'g'] }
  })
  const got = laneChanges(undefined, first, name, NOW)
  check('a first reading records what went out, per copy', kinds(got).join() === 'shipped,shipped', kinds(got))
  check('stamped with the release own moment', got.every((e) => e.at === at), got.map((e) => e.at))
  check('and naming the version', got[0].why === 'in v0.8.205', got[0].why)
  // A repo that merges without cutting a version records the release with none. `in null`
  // is what a template writes when nobody checked; this one is live in PaneForge's own
  // ledger right now (`"lastShip": { "version": null, ... }`).
  const noVersion = laneChanges(undefined, board([lane({ lane: 'g' })], {
    lastShip: { version: null, at, lanes: ['g'] }
  }), name, NOW)
  check('a release with no version says the true half', noVersion[0].why === undefined, noVersion[0].why)
  check('and still reads as a sentence', laneEventLine(noVersion[0]) === 'its work went out', laneEventLine(noVersion[0]))
  const again = laneChanges(first, board(first.lanes, { lastShip: first.lastShip }), name, NOW)
  check('the same release is not recorded twice', again.length === 0, kinds(again))
}

{
  // A release whose lanes name a slot the current reading no longer carries: the copy was
  // given back the moment its work went out, which is the ordinary case, and a row saying
  // nothing went out would be the wrong half of that.
  const prev = board([lane({ lane: 'f', held: true })])
  const next = board([], { lastShip: { version: 'v1', at: NOW - 1000, lanes: ['f'] } })
  const got = laneChanges(prev, next, name, NOW)
  check('work that went out is recorded even when its copy is already free', kinds(got).includes('shipped'), kinds(got))
}

// ---- 2. the ordinary diffs ----------------------------------------------------------

{
  const prev = board([lane()])
  const next = board([lane({ held: true })])
  check('a copy being taken', kinds(laneChanges(prev, next, name, NOW)).join() === 'taken')
  check('and given back', kinds(laneChanges(next, prev, name, NOW)).join() === 'given')
}

{
  const prev = board([lane({ held: true, session: 'sess-1' })])
  const next = board([lane({ held: true, session: 'sess-2' })])
  const got = laneChanges(prev, next, name, NOW)
  check('a hand-over is ONE event, not a give and a take', kinds(got).join() === 'taken', kinds(got))
}

{
  const prev = board([lane({ held: true })])
  const next = board([lane({ held: true, ready: true })])
  check('work finishing', kinds(laneChanges(prev, next, name, NOW)).join() === 'ready')
}

{
  const prev = board([lane({ held: true, conflicted: true, conflictSince: NOW - 60_000 })])
  const next = board([lane({ held: true })])
  check('a disagreement being settled', kinds(laneChanges(prev, next, name, NOW)).join() === 'unstuck')
}

{
  const prev = board([lane({ held: true })])
  const next = board([lane({ held: true, gone: true })])
  check('a chat that never came back', kinds(laneChanges(prev, next, name, NOW)).join() === 'gone')
}

{
  const prev = board([lane({ held: true })])
  const next = board([])
  check('a held copy that drops out of the reading was given back', kinds(laneChanges(prev, next, name, NOW)).join() === 'given')
  const prevFree = board([lane()])
  check('a copy nobody held dropping out is not an event', laneChanges(prevFree, next, name, NOW).length === 0)
}

{
  // The absence guard: a project that stops being polled must produce nothing, because
  // laneChanges is only ever asked about a board it was handed. A second project's board
  // may never write rows about the first.
  const other = { ...board([lane({ lane: 'a', held: true })]), repo: '/Users/x/Projects/other' }
  const got = laneChanges(undefined, other, name, NOW)
  check('a project is only ever spoken about by its own reading', got.every((e) => e.repo === other.repo), got.map((e) => e.repo))
}

{
  const next = board([lane({ held: true, conflicted: true, conflictSince: NOW + 60_000 })])
  const got = laneChanges(undefined, next, name, NOW)
  check('a moment in the future is clamped to now', got[0].at <= NOW, got[0].at)
}

// ---- 3. the list itself -------------------------------------------------------------

const ev = (over = {}) => {
  const base = { at: NOW, repo: REPO, lane: 'b', device: 'mac', kind: 'taken', what: 'PaneForge copy 3', ...over }
  return { id: laneEventId(base), ...base }
}

{
  const one = addLaneEvent([], ev())
  check('the same event twice is one row', addLaneEvent(one, ev()) === one)
  check(
    'and so is the same kind a beat later, which is one change seen by two readings',
    addLaneEvent(one, ev({ at: NOW + SAME_MS - 1 })) === one
  )
  check('a different kind at the same moment is a second row', addLaneEvent(one, ev({ kind: 'ready' })).length === 2)
}

{
  const list = addLaneEvent(addLaneEvent([], ev({ at: NOW })), ev({ kind: 'stuck', at: NOW - 3600_000 }))
  check('an older event lands BELOW a newer one, not on top of it', list[0].at > list[1].at, list.map((e) => e.at))
}

{
  let list = []
  for (let i = 0; i < MAX_LANE_EVENTS + 25; i++) list = addLaneEvent(list, ev({ at: NOW - i * 10_000, kind: 'taken' }))
  check('the list is capped', list.length === MAX_LANE_EVENTS, list.length)
  check('and it is the OLDEST that go', list[0].at === NOW, list[0].at)
}

{
  const list = [ev(), ev({ lane: 'c' }), ev({ repo: '/other' })]
  check('one copy at a time', eventsFor(list, REPO, 'b').length === 1, eventsFor(list, REPO, 'b').length)
}

// ---- 4. every word is read by somebody who has never used git ------------------------

{
  const jargon = /\b(lane|merge[sd]?|merging|conflict|trunk|worktree|branch|commit|checkout|rebase|slot)\b/i
  for (const [kind, word] of Object.entries(LANE_EVENT_WORDS)) {
    check(`"${word}" (${kind}) is plain`, !jargon.test(word), word)
  }
  for (const kind of Object.keys(LANE_EVENT_WORDS)) {
    const line = laneEventLine(ev({ kind, why: kind === 'shipped' ? 'in v1' : undefined }))
    check(`the ${kind} sentence is plain`, !jargon.test(line), line)
    check(`the ${kind} sentence does not repeat its own verb`, !line.toLowerCase().startsWith(LANE_EVENT_WORDS[kind].toLowerCase()), line)
  }
}

// ---- 5. the panel, read off the source ----------------------------------------------

{
  const fly = readFileSync(join(root, 'src/renderer/src/components/LaneTimelineFlyout.tsx'), 'utf8')
  check('the copy log is the activity list panel, not a second design', /className="act-fly lane-tl"/.test(fly))
  check('escape closes it', /e\.key === 'Escape'/.test(fly))
  check('it says which copy it is about', /aria-label=\{`What happened to \$\{title\}`\}/.test(fly))

  const strip = readFileSync(join(root, 'src/renderer/src/components/LaneStrip.tsx'), 'utf8')
  check('the row that opens it is a button', /role="button"/.test(strip))
  check('and is reachable from the keyboard', /tabIndex=\{0\}/.test(strip) && /onKeyDown=/.test(strip))
  check('Enter and Space both open it', /e\.key !== 'Enter' && e\.key !== ' '/.test(strip))

  const main = readFileSync(join(root, 'src/main/laneTimeline.ts'), 'utf8')
  check(
    'the readings are taken in main, so they keep happening with the window off screen',
    /setInterval/.test(main) && /watchLaneTimeline/.test(main)
  )
  check('and the timer never holds the app open', /unref/.test(main))
}

rmSync(work, { recursive: true, force: true })
console.log(`lane timeline: ${checks} checks passed`)
