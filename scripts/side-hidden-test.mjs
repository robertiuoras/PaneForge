#!/usr/bin/env node
/**
 * Hiding the list gives its width to the panes - all of it.
 *
 * Measured on 2026-09-04 in a 1002px window: pressing ◧ left `.panes` 42px wide (its 36px
 * reveal-button padding plus six), every pane crushed into a strip, while a 1fr track sat
 * empty beside it. The rule said `grid-template-columns: 0 1fr` and the two lines under it
 * put the sidebar and its grip at `display: none` - and an element that is `display: none`
 * is not in the grid at all, so auto-placement dropped `.panes` into the FIRST track, which
 * is the zero one. `0 1fr` only works while something still occupies column one.
 *
 * This is a source test on purpose: the trap is the DECLARATION (a track count that assumes
 * a hidden element still holds its column), and a source test cannot pass on a machine where
 * the window happens to be wide enough to hide it.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8').replace(/\r\n/g, '\n')

let failed = 0
const ok = (what, cond) => {
  if (cond) console.log(`ok  ${what}`)
  else {
    failed++
    console.log(`FAIL ${what}`)
  }
}

const rule = (selector) => {
  const i = css.indexOf(selector)
  if (i === -1) return null
  const open = css.indexOf('{', i)
  return open === -1 ? null : css.slice(open + 1, css.indexOf('}', open)).trim()
}

const hidden = rule('.app.side-hidden {')
ok('the hidden-sidebar layout still declares its own columns', hidden !== null)

const tracks = /grid-template-columns:\s*([^;]+)/.exec(hidden ?? '')?.[1]?.trim()
ok('it sets grid-template-columns', Boolean(tracks))

// The count is the whole assertion: one in-flow child, one track.
const count = tracks ? tracks.split(/\s+/).length : 0
ok(`one track for the one child that is left (got ${tracks ?? 'nothing'})`, count === 1)

// And the reason the count is one: both other children are gone, not merely narrow.
const gone = css.includes('.app.side-hidden .sidebar,\n.app.side-hidden .side-grip { display: none; }')
ok('the sidebar and its grip leave the grid rather than shrink inside it', gone)

// The way back must survive the hide, and it is positioned, not a grid child.
const reveal = rule('.side-reveal {')
ok('the reveal button is taken out of flow', /position:\s*absolute/.test(reveal ?? ''))
// 6px in from the edge, a 30px button, 6px of gap. A padding that no longer clears the
// button puts the first pane under the only way back to the list.
const pad = /padding-left:\s*(\d+)px/.exec(rule('.app.side-hidden .panes {') ?? '')?.[1]
const size = /min-width:\s*(\d+)px/.exec(reveal ?? '')?.[1]
ok(`the reveal button is at least 30px (got ${size ?? 'none'})`, Number(size) >= 30)
ok(`the panes clear it (padding ${pad ?? 'none'}, needs ${Number(size) + 12})`, Number(pad) >= Number(size) + 12)

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nside-hidden ok')
