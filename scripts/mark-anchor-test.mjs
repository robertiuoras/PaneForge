// A prompt tag that survives the CLI moving the lines under it.
//
// The rail's tags are xterm markers, and a marker dies for two reasons that look identical
// from the outside: the buffer forgot that line, or something spliced the line array. Codex
// does the second constantly - reverse index inside a scroll region, 94 of them in one
// 72 KB pane log - and every marker inside the range that moved is disposed, which is why
// that pane had no tags to jump to.
//
// So the control here matters as much as the check: a bare marker is put through the same
// reverse index and asserted DEAD. If that ever stops being true this file should say so
// rather than quietly passing.
//
//   node scripts/mark-anchor-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-mark-anchor-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const outfile = join(work, 'anchor.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/markAnchor.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const require_ = createRequire(import.meta.url)
const { anchorMark, echoKey, onEchoRow, findEcho } = require_(outfile)

let checks = 0
const check = (what, ok, detail) => {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` — ${detail}`}`)
}
const eq = (what, got, want) =>
  check(what, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

let Terminal
try {
  ;({ Terminal } = require_('@xterm/headless'))
} catch {
  console.log('mark anchor: SKIPPED - @xterm/headless is not installed')
  process.exit(0)
}

const ROWS = 24
const write = (t, s) => new Promise((r) => t.write(s, r))
const tick = () => new Promise((r) => setTimeout(r, 0))

/** A pane's worth of terminal with `n` lines of history already in it. */
async function pane(n = 40) {
  const t = new Terminal({ rows: ROWS, cols: 60, scrollback: 1000, allowProposedApi: true })
  for (let i = 1; i <= n; i++) await write(t, `line ${i}\r\n`)
  return t
}

/** A marker on a line the erase below will reach. */
const inRegion = (t) => t.registerMarker(-(t.buffer.active.cursorY - 10))

const hostFor = (t) => ({
  cursor: () => t.buffer.active.baseY + t.buffer.active.cursorY,
  length: () => t.buffer.active.length,
  register: (offset) => t.registerMarker(offset),
  defer: (fn) => queueMicrotask(fn)
})

/**
 * What Codex really sends when it repaints: put the cursor part way up the screen and
 * erase from there down. Claude Code erases a line at a time (`CSI 2 K`) and that is the
 * whole difference - erase-in-LINE leaves markers alone, erase-in-DISPLAY does not.
 */
const ERASE_BELOW = '\x1b[5;1H\x1b[J'

// --- the control: this is the bug ------------------------------------------------------
{
  const t = await pane()
  const bare = inRegion(t)
  const before = bare.line
  check('a marker starts on a real line', before > 0, String(before))
  await write(t, ERASE_BELOW)
  await tick()
  check(
    'a bare marker does NOT survive an erase-in-display - which is the reported bug',
    bare.line < 0,
    `line ${bare.line}`
  )
  t.dispose()
}

// --- anchored --------------------------------------------------------------------------
{
  const t = await pane()
  const host = hostFor(t)
  const marker = inRegion(t)
  const entry = { marker, line: marker.line }
  const at = marker.line
  let dropped = false
  let changed = 0
  anchorMark(host, entry, marker, {
    alive: () => !dropped,
    drop: () => {
      dropped = true
    },
    changed: () => changed++
  })
  await write(t, ERASE_BELOW)
  await tick()
  check('the tag is not dropped', !dropped)
  check('it is on a live marker again', entry.marker.line >= 0, `line ${entry.marker.line}`)
  eq('on the line it was on', entry.marker.line, at)
  eq('and the rail was told to redraw', changed, 1)
  check('the replacement is a different marker', entry.marker !== marker)
  t.dispose()
}

// --- it keeps surviving ------------------------------------------------------------------
// One re-anchor is not the promise; a pane runs for hours and Codex does this all turn.
{
  const t = await pane()
  const host = hostFor(t)
  const marker = inRegion(t)
  const entry = { marker, line: marker.line }
  let dropped = false
  const hooks = {
    alive: () => !dropped,
    drop: () => {
      dropped = true
    },
    changed: () => {}
  }
  anchorMark(host, entry, marker, hooks)
  for (let i = 0; i < 12; i++) {
    await write(t, ERASE_BELOW)
    await tick()
    if (entry.marker.line >= 0) entry.line = entry.marker.line
  }
  check('twelve rounds later it is still there', !dropped && entry.marker.line >= 0)
  t.dispose()
}

// --- and it still ends when the line really goes -----------------------------------------
// A tag whose prompt has fallen out of the scrollback is over. Re-anchoring must not
// resurrect one, or the rail fills with tags pointing at lines the buffer no longer holds.
{
  const t = new Terminal({ rows: ROWS, cols: 60, scrollback: 5, allowProposedApi: true })
  for (let i = 1; i <= 10; i++) await write(t, `line ${i}\r\n`)
  const host = hostFor(t)
  const marker = t.registerMarker(0)
  const entry = { marker, line: marker.line }
  let dropped = false
  anchorMark(host, entry, marker, {
    alive: () => !dropped,
    drop: () => {
      dropped = true
    },
    changed: () => {}
  })
  // Far more output than the scrollback holds, so that line is genuinely forgotten.
  for (let i = 0; i < 200; i++) {
    await write(t, `filler ${i}\r\n`)
    if (entry.marker.line >= 0) entry.line = entry.marker.line
  }
  await tick()
  check('a trimmed line ends the tag', dropped, `line ${entry.marker.line}`)
  t.dispose()
}

// --- a dead pane re-anchors nothing --------------------------------------------------------
{
  const t = await pane()
  const host = hostFor(t)
  const marker = inRegion(t)
  const entry = { marker, line: marker.line }
  let drops = 0
  anchorMark(host, entry, marker, {
    alive: () => false,
    drop: () => drops++,
    changed: () => {}
  })
  await write(t, ERASE_BELOW)
  await tick()
  eq('a closed pane neither re-anchors nor reports a drop', drops, 0)
  check('and it is left dead rather than replaced', entry.marker === marker)
  t.dispose()
}

// The Claude Code flush (2026-09-03). The reply streams INSIDE the screen; the next submit
// erases from the top of the frame and writes the whole reply plus the prompt's echo out
// into scrollback. The tag registered at the composer keeps its row number and loses its
// content; the echo is the only thing that says where the prompt now is.
{
  const t = await pane(0)
  // The screen after reply 1 streamed: a prompt echo, a few rows of reply, the composer.
  await write(t, '❯ first ask\r\n')
  for (let i = 1; i <= 8; i++) await write(t, `  ${i}\r\n`)
  await write(t, '❯ Print the numbers 1 to 120 one per line, then MARKER2\r\n')
  const composer = t.buffer.active.baseY + t.buffer.active.cursorY - 1
  const entry = { marker: t.registerMarker(-1), line: 0 }
  entry.line = entry.marker.line
  eq('the tag starts on the composer row', entry.line, composer)
  let moved = 0
  anchorMark(hostFor(t), entry, entry.marker, { alive: () => true, drop: () => {}, changed: () => moved++ })
  // The flush: cursor to the frame's top, erase below, the previous reply in full, then the
  // new prompt's echo, then the composer.
  await write(t, '\x1b[2;1H\x1b[J')
  for (let i = 1; i <= 120; i++) await write(t, `  ${i}\r\n`)
  await write(t, '❯ Print the numbers 1 to 120 one per line, then MARKER2\r\n')
  await write(t, '❯ \r\n')
  await tick()
  const b = t.buffer.active
  const row = (i) => b.getLine(i)?.translateToString(true)
  check('the same-row re-anchor put the tag back on a row that is now reply text', moved >= 1 && /^\s*\d+$/.test(row(entry.marker.line) ?? ''), row(entry.marker.line))
  const key = echoKey('Print the numbers 1 to 120 one per line, then MARKER2')
  eq('the key is the first 24 characters', key, 'Print the numbers 1 to 1')
  check('so the row no longer reads as this prompt', !onEchoRow(row(entry.marker.line), key))
  const at = findEcho(row, 0, b.length, key)
  check('and the echo is found where the flush wrote it, 120 rows down', at > entry.marker.line + 100 && onEchoRow(row(at), key), `at ${at} from ${entry.marker.line}`)
  eq('the first ask is not mistaken for it', findEcho(row, -1, b.length, echoKey('first ask')), 0)
  eq('an empty key finds nothing', findEcho(row, -1, b.length, ''), -1)
  eq('a shell pane row is not an echo', onEchoRow('PS C:\\> Print the numbers 1 to 120', key), false)
  // The pane's swap: bind the entry to the echo's marker, then dispose the old one - the
  // anchor must NOT put the entry back on the old row.
  const fresh = t.registerMarker(at - (b.baseY + b.cursorY))
  const old = entry.marker
  anchorMark(hostFor(t), entry, fresh, { alive: () => true, drop: () => {}, changed: () => moved++ })
  const before = moved
  old.dispose()
  await tick()
  eq('disposing the marker the entry moved off changes nothing', moved, before)
  check('the entry stays on the echo row', entry.marker === fresh && entry.marker.line === at)
  t.dispose()
}

console.log(`mark anchor: ${checks} checks passed`)
