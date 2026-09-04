// A pane header drops a control only when the row has really run out of space.
//
// Before this it dropped on the pane's WIDTH: below 760px the clear button, the folder
// button, restart, fix and the git badge went behind the ⋯, whatever else was on the row.
// In a narrow window that is the whole app, and the row is nearly empty - a pane called
// `PaneForge` leaves hundreds of pixels of nothing between its name and the clock, with
// the two most-pressed controls in a menu. Robert 2026-09-04: "we have a lot of space in
// this top bar ... theres enough space to have the most important buttons available".
//
// The arithmetic is pure, so it is checked here with no window; what needs one is the
// measuring, which `src/renderer/src/headerFit.ts` does and `npm run test:view` draws.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { climbLevel, TIGHT_GROUPS, MORE_FROM } = await import(
  pathToFileURL(join(root, 'src/shared/headerFit.ts')).href
)

let failed = 0
const ok = (what, cond, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${extra ? ` - ${extra}` : ''}`)
}

// The climb is asked of the row, so here it is asked of a fake one: a header that fits
// from rung `from` onwards.
const rowFitting = (from) => (level) => level >= from

console.log('the row is kept whole while it fits')
{
  const seen = []
  const level = climbLevel((l) => {
    seen.push(l)
    return rowFitting(0)(l)
  }, TIGHT_GROUPS.length)
  ok('a row that fits drops nothing', level === 0)
  ok('and it is asked once, not walked down the ladder', seen.length === 1, String(seen.length))
}

console.log('it goes down the ladder in order, and stops at the end')
{
  const seen = []
  const level = climbLevel((l) => {
    seen.push(l)
    return rowFitting(3)(l)
  }, TIGHT_GROUPS.length)
  ok('it stops at the first rung that fits', level === 3)
  ok('and asked every rung above it, in order', seen.join(',') === '0,1,2,3', seen.join(','))
  ok(
    'a row that never fits still draws its name at the last rung',
    climbLevel(() => false, TIGHT_GROUPS.length) === TIGHT_GROUPS.length
  )
}

console.log('the ladder is what a person reaches for')
{
  const at = (sel) => TIGHT_GROUPS.findIndex((g) => g.includes(sel))
  ok('the folder path goes first, the name already says it', at('.pt-path') === 0)
  ok('the git badge goes before the clear button', at('.git-badge') < at('.pt-clear'))
  ok('clear and open-the-folder are the last controls to go', at('.pt-clear') === 3 && at('.pt-reveal') === 3)
  ok('the agent picker goes before them', at('.agent-pick') < at('.pt-clear'))
  ok('the agent mark is last of all', at('.agent-logo') === TIGHT_GROUPS.length - 1)
  ok('the ⋯ appears as soon as anything is behind it', MORE_FROM === 2)
}

console.log('the stylesheet and the ladder are one fact')
{
  const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')
  for (const [i, group] of TIGHT_GROUPS.entries()) {
    for (const sel of group) {
      // Every selector must be hidden at its own rung and at every rung below it.
      const missing = []
      for (let level = i + 1; level <= TIGHT_GROUPS.length; level++) {
        const rule = `.pane-title[data-tight='${level}'] ${sel}`
        if (!css.includes(rule)) missing.push(level)
      }
      ok(`${sel} is hidden from rung ${i + 1} down`, missing.length === 0, missing.join(','))
    }
  }
  ok('the ⋯ is off until something is behind it', /\.pt-actions \.pt-more \{ display: none \}/.test(css))
  ok('and on when it is', /\.pane-title\[data-more='on'\] \.pt-more \{ display: inline-flex \}/.test(css))
  ok('a phone always has it, whatever the fit says', /html\.handheld \.pane-title \.pt-more \{\s*display: inline-flex/.test(css))
  ok(
    'nothing is hidden on the old width breakpoints any more',
    !/@container pane \(max-width: (760|560|300)px\)/.test(css)
  )
}

console.log('the measuring half never renders')
{
  const fit = readFileSync(join(root, 'src/renderer/src/headerFit.ts'), 'utf8')
  ok('it writes an attribute, not React state', /dataset\.tight/.test(fit) && !/useState/.test(fit))
  ok('it ASKS the row rather than adding widths up', /scrollWidth > .*clientWidth/.test(fit) && !/offsetWidth/.test(fit))
  ok('a clipped name counts as not fitting', /pt-name/.test(fit))
  ok('it re-measures when the header resizes', /new ResizeObserver/.test(fit))
  ok('and at most once a frame, because the climb reads layout back', /requestAnimationFrame/.test(fit))
  const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
  ok('and it is actually mounted', /useHeaderFits\(\[sessions\]\)/.test(app))
}

console.log(failed ? `\n${failed} failed` : '\nheader fit: all good')
process.exit(failed ? 1 : 0)
