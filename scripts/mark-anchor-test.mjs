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
const { anchorMark } = require_(outfile)

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

console.log(`mark anchor: ${checks} checks passed`)
