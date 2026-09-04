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
const { fitLevel, needAt, NAME_MIN, SLACK, TIGHT_GROUPS, MORE_FROM } = await import(
  pathToFileURL(join(root, 'src/shared/headerFit.ts')).href
)

let failed = 0
const ok = (what, cond, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${extra ? ` - ${extra}` : ''}`)
}

// A header of a real shape: 240px that never goes, and five rungs worth 90, 150, 120, 70
// and 20 - the same order the app drops them in.
const need = { fixed: 240, groups: [90, 150, 120, 70, 20] }
const whole = needAt(need, 0)

console.log('the row is kept whole while it fits')
{
  ok('a wide header drops nothing', fitLevel(whole + 200, need) === 0)
  ok('and exactly enough room still drops nothing', fitLevel(whole + SLACK, need) === 0)
  ok('one pixel short drops the first rung', fitLevel(whole + SLACK - 1, need) === 1)
  ok('the name is never squeezed below its floor', needAt(need, 5) === 240 + NAME_MIN)
}

console.log('a long name costs a control exactly as a narrow window does')
{
  // The whole point: same available width, and what changes is what the row NEEDS.
  const short = fitLevel(700, need)
  const long = fitLevel(700, { ...need, fixed: 240 + 180 })
  ok('a header carrying more drops more', long > short, `${short} -> ${long}`)
  ok('and the level is the same whichever way the space went', fitLevel(700 - 180, need) === long)
}

console.log('it goes down the ladder in order, and stops at the end')
{
  const levels = []
  for (let w = whole + 40; w > 0; w -= 10) levels.push(fitLevel(w, need))
  ok('a level never goes back up as the row narrows', levels.every((l, i) => i === 0 || l >= levels[i - 1]))
  ok('nothing that fits nothing goes past the last rung', fitLevel(1, need) === TIGHT_GROUPS.length)
  ok('the last rung still leaves room for the name', needAt(need, TIGHT_GROUPS.length) < needAt(need, 0))
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
  ok('a hidden part still counts what it costs', /if \(live > before\)/.test(fit))
  ok('it re-measures when the header resizes', /new ResizeObserver/.test(fit))
  const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
  ok('and it is actually mounted', /useHeaderFits\(\[sessions\]\)/.test(app))
}

console.log(failed ? `\n${failed} failed` : '\nheader fit: all good')
process.exit(failed ? 1 : 0)
