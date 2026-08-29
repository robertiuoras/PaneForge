/**
 * Real macOS glass, and the four things about it that are refusals.
 *
 * There is no window here, so this is arithmetic and source assertions - the same shape
 * as `overlay-filter-test.mjs`, and for the same reason: the expensive failures are
 * invisible to a screenshot. A transparent window whose glass did not attach draws the
 * sidebar over the desktop; a pane region that went clear with the body puts a wallpaper
 * behind the rows an agent is printing. Neither is a crash and neither shows up in a
 * typecheck.
 *
 * The live half was measured in a real window on 2026-08-29 and is written down rather
 * than re-run: `.glass` on <html>, body `rgba(0, 0, 0, 0)`, `.panes` `rgb(13, 9, 7)`,
 * sidebar `linear-gradient(rgba(255,255,255,0.04), rgba(0,0,0,0) 220px)`, and a pane with
 * two WebGL canvases sitting on an opaque `rgb(20, 15, 11)`.
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
const glass = readFileSync(join(root, 'src/main/glass.ts'), 'utf8')
const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// 1. The terminal side must keep painting. `body` gives up its background so the native
//    view shows, and the ONE rule that stops a wallpaper appearing behind an agent's
//    output is `.panes` taking it back. Deleting it looks fine on an empty desk.
ok(/html\.glass\s+body\s*\{[^}]*background:\s*transparent/.test(css), 'glass: body goes clear')
ok(/html\.glass\s+\.panes\s*\{[^}]*background:\s*var\(--bg\)/.test(css), 'glass: the pane region paints')

// 2. Every glass rule is scoped, so a machine that cannot draw glass is byte-for-byte the
//    app it was. A bare `body { background: transparent }` would empty every other
//    platform's window.
for (const line of css.split('\n')) {
  if (!line.includes('html.glass')) continue
  ok(line.trimStart().startsWith('html.glass'), `glass: rule is scoped - ${line.trim().slice(0, 60)}`)
}

// 3. Still no backdrop-filter. `overlay-filter-test.mjs` owns this rule; it is repeated
//    here because THIS is the change that would tempt somebody to add one.
//    The comments here NAME it, so the check has to be on declarations - a match against
//    the raw file passes only until somebody explains the rule.
const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '')
ok(!/backdrop-filter\s*:/.test(declarations), 'glass: no backdrop-filter was added')

// 4. Nothing about a visual flourish may stop the app opening. Every exported path in
//    glass.ts is inside a try, and the native module is required lazily rather than
//    imported at the top, or a Mac that cannot load it fails at startup.
ok(!/^import .*electron-liquid-glass/m.test(glass), 'glass: the addon is not a top-level import')
ok((glass.match(/catch/g) || []).length >= 4, 'glass: every path that can throw is caught')
ok(/return false/.test(glass), 'glass: the failure answer is false, not a throw')

// 5. `transparent` and the opaque `backgroundColor` are one decision. A window created
//    transparent with `#101014` still under it shows no glass at all, and the pair being
//    written apart is exactly how that happens.
ok(/backgroundColor:\s*glass \?/.test(main), 'glass: the background colour follows the glass flag')
ok(/glass \? \{ transparent: true/.test(main), 'glass: transparent only where glass is')
ok(
  main.indexOf('const glass = glassSupported()') < main.indexOf('backgroundColor: glass ?'),
  'glass: supported is asked before the window is built'
)

// 6. The native binary has to survive packaging. Inside the asar it cannot be dlopen'd,
//    and the failure is a silent fall back to no glass on every installed copy while the
//    dev checkout looks perfect.
ok(
  (pkg.build.asarUnpack || []).some((p) => p.includes('electron-liquid-glass')),
  'glass: the native module is unpacked from the asar'
)
ok(!!pkg.dependencies['electron-liquid-glass'], 'glass: the addon is a runtime dependency')

console.log(`glass: ${checks} checks passed`)
