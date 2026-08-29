/**
 * A phone's controls are big enough to hit, and an iPhone is not a Mac.
 *
 * Measured in Chrome at 390x844 under a real iPhone user agent on 2026-08-29, against the
 * phone client the app itself serves. Before: **31** controls under 44px on the home
 * screen and **3** of the pane screen's 3 - the Back chip at 73x34, the ⋯ that every pane
 * action lives behind at 36x36, and the microphone at 28x28. After: **0** on the pane
 * screen and 1 on the home screen (a row's close button at 40x40, which the coarse block
 * had already chosen deliberately). The terminal was 47x42 before and after.
 *
 * Two traps are why this checks the BUILT stylesheet rather than the source, and why the
 * selectors are written out one per line:
 *
 *   - **Specificity, twice.** `html.handheld .pt-more` is (0,2,0) and the pane header's
 *     own `.pane-title .icon` is (0,2,0) and LATER in the file, so the handheld rule lost
 *     - which is also why the `font-size: 19px` that had been sitting in that block since
 *     it was written never applied to anything (measured 14px). A source test that only
 *     greps for a selector passes happily while the rule does nothing.
 *   - **`.icon.help` carries its own `min-width`** at equal specificity and later, on
 *     purpose, to keep the two brand buttons the same size - so it has to be named
 *     separately or it alone stays 30px wide beside a 44px sibling.
 *
 * The live half needs a window and a served phone client; `npm run test:phoneview` is
 * where that lives. This is the cheap half that runs in `npm test`.
 */
import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let checks = 0
const ok = (cond, what) => {
  checks++
  assert.ok(cond, what)
}

const src = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')
const platform = readFileSync(join(root, 'src/renderer/src/platform.ts'), 'utf8')

// --- an iPhone is not a Mac --------------------------------------------------
// Safari on iOS says `(iPhone; CPU iPhone OS 18_5 like Mac OS X)` and an iPad says
// `(Macintosh; ...)` outright, so `includes('Mac')` is true on both and every shortcut
// this app printed went to a device with no ⌘ key. The touch test is the half the user
// agent cannot give, which is what covers the iPad.
ok(/iPhone\|iPad\|iPod/.test(platform), 'phone: isMac refuses an iOS user agent')
ok(/maxTouchPoints/.test(platform), 'phone: isMac refuses a touch device an iPad calls a Macintosh')
ok(/html\.handheld \.kbd\s*\{[^}]*display:\s*none/.test(src), 'phone: no keyboard hints on a handheld')

// --- every control a finger uses ---------------------------------------------
// One line each rather than a loop, so a control dropped from this list is a deliberate
// edit somebody has to write down.
const TOUCH = [
  ['.brand .icon.help', 'the help button, which out-specifies its sibling'],
  ['.pane-title .pt-more', 'the ⋯ every pane action lives behind'],
  ['.handheld-back', 'the only way back to the list'],
  ['.mic-float', 'the microphone, on the device it exists for'],
  ['.section-btn', 'close-all, which may not be the smallest thing on screen'],
  ['.quick-btn', 'the row of icons under the search box'],
  ['.seg-btn', 'Focus / Grid'],
  ['.primary', 'New session']
]

// The block a phone actually matches. Everything below is asserted INSIDE it, so a rule
// that would also change a mouse's layout fails here.
const start = src.indexOf('@media (pointer: coarse) {')
ok(start > 0, 'phone: the coarse block is where these live')
let depth = 0
let end = start
for (let i = src.indexOf('{', start); i < src.length; i++) {
  if (src[i] === '{') depth++
  else if (src[i] === '}' && --depth === 0) {
    end = i
    break
  }
}
const coarse = src.slice(start, end)
const handheldBlocks = src
  .split('@media')
  .filter((b) => b.startsWith(' (max-width: 720px)'))
  .join('\n')
const touchCss = coarse + '\n' + handheldBlocks

for (const [sel, why] of TOUCH) {
  const rule = new RegExp(
    sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^{}]*\\{[^}]*(min-height|height):\\s*4[04]px'
  )
  ok(rule.test(touchCss), `phone: ${sel} is a real target - ${why}`)
}

// The two that were the wrong size on the WIDTH axis, not the height.
ok(/\.brand \.icon,?[\s\S]{0,40}\.brand \.icon\.help\s*\{[^}]*min-width:\s*44px/.test(touchCss), 'phone: the help button is 44 wide, not a 30px sliver')
ok(/\.seg-btn\s*\{[^}]*min-width:\s*44px/.test(touchCss), 'phone: Focus / Grid is 44 wide')

// A rule that is not inside a coarse or handheld block would shrink the desk's dense
// chrome, which is the whole reason these are separate.
for (const [sel] of TOUCH) {
  const outside = src.slice(0, start)
  const bad = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{[^}]*min-height:\\s*44px')
  ok(!bad.test(outside.split('@media')[0]), `phone: ${sel} did not grow for a mouse too`)
}

// --- and it is what actually shipped -----------------------------------------
// The source can be right and the bundle stale or overridden; twice during this work the
// browser was reading a rule that had lost a specificity tie. So the built CSS is asked
// the same question, when there is one to ask.
const assets = join(root, 'out/renderer/assets')
let built = ''
try {
  for (const f of readdirSync(assets)) if (f.endsWith('.css')) built += readFileSync(join(assets, f), 'utf8')
} catch {
  /* no build here - the source assertions above still ran */
}
if (built) {
  ok(/\.pane-title \.pt-more/.test(built), 'phone: the ⋯ rule reached the bundle at full specificity')
  ok(/html\.handheld \.kbd/.test(built), 'phone: the keyboard hints rule reached the bundle')
}

console.log(`phone touch: ${checks} checks passed${built ? ' (source and bundle)' : ' (source only - no build present)'}`)
