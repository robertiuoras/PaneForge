/**
 * The top of the phone screen is behind the status bar.
 *
 * `viewport-fit=cover` lets the page paint under iOS's clock and battery, which is what
 * makes `env(safe-area-inset-top)` mean anything - and every rule that puts something at
 * the top of a handheld screen has to add it back. On 2026-09-02 the list screen's brand
 * row (PaneForge, settings, help) sat under the status bar of a home-screen launch and
 * could not be seen or pressed; the Back pill on the pane screen was 6px from the top
 * for the same reason. This reads the source, not a browser: Chrome's device emulation
 * has no safe area, so a browser probe would pass with the inset missing.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')
const html = readFileSync(join(root, 'src/renderer/index.html'), 'utf8')

assert.match(html, /viewport-fit=cover/, 'the page paints under the status bar, so the inset is real')

/** Every declaration block whose selector is exactly `sel`, joined - a selector can be ruled twice. */
function rules(sel) {
  const out = []
  const re = new RegExp('(?:^|\\n)\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{', 'g')
  for (let m; (m = re.exec(css)); ) {
    const open = css.indexOf('{', m.index)
    out.push(css.slice(open, css.indexOf('}', open)))
  }
  assert.ok(out.length, `rule for ${sel} exists`)
  return out.join('\n')
}

assert.match(
  rules('html.handheld.handheld-list .sidebar'),
  /padding-top:[^;]*safe-area-inset-top/,
  'the list screen keeps its brand row below the status bar'
)
assert.match(rules('.handheld-back'), /top:[^;]*safe-area-inset-top/, 'the Back pill on the pane screen too')
assert.match(rules('html.handheld .panes'), /padding:[^;]*safe-area-inset-top/, 'and the pane starts below it')

console.log('phone-top: 4 checks passed')
