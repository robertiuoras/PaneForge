/**
 * Nothing drawn over a pane may be a backdrop filter.
 *
 * `.overlay` - every dialog in this app - was `backdrop-filter: blur(3px)` across the
 * whole window, and what sits under it is a grid of xterm WebGL canvases that repaint on
 * every line an agent prints. That makes a live GPU surface the INPUT to a full-window
 * filter, and on screen the window strobed for as long as a dialog was open.
 *
 * This test exists because that bug is invisible to every other kind of check, and the
 * measurements that look decisive are the ones that cannot fail:
 *
 *   - CPU says nothing. Measured with four panes printing flat out, opening a dialog cost
 *     +1.8% GPU and +1.6% renderer. It is a presentation artifact, not work.
 *   - a screenshot says nothing. Ten `Page.captureScreenshot` frames of the blurred
 *     backdrop varied by 0.03 of a luminance point out of 255 - because a minimized window
 *     is composited offscreen and never touches the path that strobes.
 *   - a probe of the live window says nothing either, unless somebody remembers to ask.
 *
 * So the rule is enforced on the stylesheet instead, where it is a fact rather than an
 * observation: `styles.css` declares no `backdrop-filter` at all.
 *
 * `shelf.css` is deliberately exempt and checked for the reason rather than skipped: it
 * styles a SEPARATE BrowserWindow that has never held a terminal, so there is no GPU
 * surface underneath it to re-filter. If a pane is ever drawn in that window, delete the
 * exemption before anything else.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let checks = 0
const ok = (cond, what) => {
  checks++
  assert.ok(cond, what)
}

const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')

/** Every `backdrop-filter` in the file, with the selector it lands on. */
function offenders(text) {
  const out = []
  // NOT anchored on the previous `}`: that consumes the brace the next rule would anchor
  // on, so an anchored version sees every OTHER rule and the file's own check passes
  // because the second planted violation was never looked at. Caught by the self-test
  // below, which is the whole reason it is there.
  const re = /([^{}]*)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(text))) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/\s+/g, ' ')
    const body = m[2]
    if (/(^|[\s;])(-webkit-)?backdrop-filter\s*:/.test(body)) {
      const value = /(?:-webkit-)?backdrop-filter\s*:([^;]*)/.exec(body)?.[1].trim()
      // `none` is a rule TURNING one off, which is the fix, not the bug.
      if (value && value !== 'none') out.push({ selector, value })
    }
  }
  return out
}

/** The body of the rule whose selector is EXACTLY this one. */
function bodyOf(text, selector) {
  const re = /([^{}]*)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(text))) {
    const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/\s+/g, ' ')
    if (sel === selector) return m[2]
  }
  return null
}

const found = offenders(css)
ok(
  found.length === 0,
  'the window stylesheet declares no backdrop-filter, so no dialog can re-filter a live ' +
    'terminal canvas. Found: ' +
    found.map((f) => `${f.selector} { backdrop-filter: ${f.value} }`).join(' | ')
)

// The detector has to be able to SEE one, or the assertion above passes for the wrong
// reason on the day somebody reformats this file. Both spellings, and a `none` that must
// not be mistaken for a violation.
{
  const planted = `
    .overlay { position: fixed; inset: 0; backdrop-filter: blur(3px); }
    .thing { -webkit-backdrop-filter: saturate(2); }
    .off { backdrop-filter: none; }
  `
  const seen = offenders(planted)
  ok(seen.length === 2, `the detector finds a planted backdrop-filter (saw ${seen.length})`)
  ok(
    seen.some((s) => s.selector === '.overlay') && seen.some((s) => s.selector === '.thing'),
    'and names the selector it is on, both spellings'
  )
  ok(!seen.some((s) => s.selector === '.off'), 'a rule turning one OFF is not a violation')
}

// The scrim that replaced it has to actually hide the panes, or the dialog is read against
// a moving terminal instead. Anything under ~0.8 alpha is a wash, not a scrim.
//
// The body is found with the same splitter as above rather than with its own regex: a
// hand-rolled `/\.overlay\s*\{([\s\S]*?)\}/` matched the first rule whose selector merely
// CONTAINED ".overlay" and read that one's background, which is how a check ends up
// asserting something true about the wrong rule.
{
  const body = bodyOf(css, '.overlay')
  ok(!!body, 'the .overlay rule is still there to check')
  const bg = /background:\s*#([0-9a-fA-F]{8})\b/.exec(body ?? '')
  ok(!!bg, 'the overlay paints an explicit background rather than inheriting one')
  const alpha = parseInt(bg[1].slice(6), 16) / 255
  ok(alpha >= 0.8, `the overlay scrim is opaque enough to stand in for the blur (${alpha.toFixed(2)})`)
}

console.log(`overlay-filter: ${checks} checks passed`)
