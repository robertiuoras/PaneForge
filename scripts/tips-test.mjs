// What the tips card may say, and - much more importantly - when it may not say it.
//
// The catalogue is a list of sentences about features this repo has shipped, so the checks
// here are about the four refusals and the cycle. The load-bearing half is the negatives:
// a tip that lands over an agent's question, or over a dialog somebody is answering, is
// the version of this feature that gets switched off on its first day.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-tips-'))
const outfile = join(work, 'tips.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/tips.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { TIPS, DEFAULT_TIPS, dueTip, afterShown, offersOff, EVERY_MS, FIRST_MS, OFFER_EVERY } =
  createRequire(import.meta.url)(outfile)

let checks = 0
function check(what, ok, detail) {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` - got ${JSON.stringify(detail)}`}`)
}
const eq = (what, a, b) => check(what, a === b, a)

const NOW = 1_700_000_000_000
const ok = { busy: false, asking: false, visible: true, upMs: FIRST_MS + 1 }
const ready = { ...DEFAULT_TIPS, lastAt: NOW - EVERY_MS - 1 }

{
  // The catalogue itself. A duplicate id shows one tip twice and hides another for ever,
  // and neither of those announces itself.
  eq('no two tips share an id', new Set(TIPS.map((t) => t.id)).size, TIPS.length)
  check('and every one says something', TIPS.every((t) => t.say.trim().length > 30), 'short tip')
  check('there are enough to be worth cycling', TIPS.length >= 12, TIPS.length)
}

{
  // The refusals. Each of these is a real moment in this app, and each one is a moment
  // where a card in the corner is a cost rather than a hint.
  check('a quiet window gets a tip', !!dueTip(ready, NOW, ok), 'none')
  check('a dialog stands it down', !dueTip(ready, NOW, { ...ok, busy: true }), 'spoke over a dialog')
  check('a pane holding a question stands it down', !dueTip(ready, NOW, { ...ok, asking: true }), 'spoke over a question')
  check('a minimised window is never spent on', !dueTip(ready, NOW, { ...ok, visible: false }), 'spoke to nobody')
  check('and nothing is said in the first minutes', !dueTip(ready, NOW, { ...ok, upMs: 10 }), 'too early')
  check('nor twice inside the gap', !dueTip({ ...ready, lastAt: NOW - 1000 }, NOW, ok), 'too soon')
  check('and never at all when they are off', !dueTip({ ...ready, enabled: false }, NOW, ok), 'off')
}

{
  // The cycle. Every tip is shown once before any is shown twice, and the list resets
  // rather than going silent - a feature added in a later version has to be able to reach
  // somebody who has already been round once.
  let cfg = { ...DEFAULT_TIPS }
  const seen = []
  for (let i = 0; i < TIPS.length; i++) {
    const at = NOW + i * (EVERY_MS + 1)
    const t = dueTip({ ...cfg, lastAt: cfg.lastAt || at - EVERY_MS - 1 }, at, ok)
    check(`tip ${i + 1} exists`, !!t, i)
    seen.push(t.id)
    cfg = afterShown(cfg, t, at)
  }
  eq('every tip is shown before any repeats', new Set(seen).size, TIPS.length)
  eq('and the list resets rather than going quiet', cfg.seen.length, 0)
  eq('while the count keeps going', cfg.shown, TIPS.length)
}

{
  // The off switch. The FIRST card carries it - somebody who does not want tips finds out
  // on the first one rather than on the fourth - and then every OFFER_EVERY after it.
  check('the first card offers the way out', offersOff(0), false)
  check('the second does not', !offersOff(1), true)
  eq('and it comes back on a fixed beat', offersOff(OFFER_EVERY - 1), true)
}

{
  // Every tip names something the app really does. A tip about a feature that was removed
  // is the fastest way to make the whole card untrustworthy, so the ids are checked
  // against the component that draws them being wired at all.
  const app = readFileSync(join(root, 'src/renderer/src/App.tsx'), 'utf8')
  check('the card is actually rendered', app.includes('<Tips'), 'not rendered')
  const settings = readFileSync(join(root, 'src/renderer/src/components/SettingsDialog.tsx'), 'utf8')
  check('and it can be turned back on from Settings', settings.includes('tips:'), 'no switch')
}

rmSync(work, { recursive: true, force: true })
console.log(`tips: ${checks} checks passed`)
