// Counts what Settings puts on screen, per tab: rows, words of hint text, the longest
// single hint, and controls. The settings rework (docs/rework/settings.md) asks for this
// table before and after, so it is a script rather than a one-off: the same numbers, read
// the same way, twice.
//
// It reads the DRAWN dialog, not the source: a sentence that only shows behind a `?`, a
// row this machine does not draw, a paragraph built from an expression - the source
// cannot tell those apart from text on screen, and on screen is what the count is about.
//
//   npm run try -- --headless --remote-debugging-port=9444
//   node scripts/settings-count.mjs
//   npm run try -- --close

import { connect } from './ui-lab.mjs'

const MEASURE = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await wait(250)
  const open = document.querySelector('button[aria-label="Settings"]')
  if (!open) return { err: 'no Settings button' }
  open.click()
  await wait(700)
  // Drawn means it has a box: a row behind a closed fold or a closed \`?\` has none.
  const drawn = (el) => el.getClientRects().length > 0
  const words = (el) => (el.textContent ?? '').trim().split(/\\s+/).filter(Boolean).length
  const out = []
  const tabs = [...document.querySelectorAll('.settings-nav .nav-item')]
  for (const t of tabs) {
    t.click()
    await wait(450)
    const body = document.querySelector('.settings .tab-body')
    const all = (sel) => [...body.querySelectorAll(sel)].filter(drawn)
    const rows = all('.sw-row, .cb, label:not(.sw-row):not(.cb)')
    // A hint inside a hint is one hint.
    const hints = all('.hint, .sw-hint').filter((h) => !h.parentElement.closest('.hint, .sw-hint'))
    const controls = all('button, select, textarea, input:not([type=checkbox]), .sw-row, .cb')
    out.push({
      tab: t.querySelector('.nav-label')?.textContent ?? t.textContent,
      rows: rows.length,
      hintWords: hints.reduce((n, h) => n + words(h), 0),
      longest: hints.reduce((n, h) => Math.max(n, words(h)), 0),
      controls: controls.length
    })
  }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  return { out }
})()`

const link = await connect()
const r = await link.evaluate(MEASURE)
link.close()
if (r?.err) {
  console.error(r.err)
  process.exit(1)
}
// A window still loading has no Settings rail yet: an empty table is that, not "nothing".
if (!r?.out?.length) {
  console.error('no Settings tabs found - is the window still loading? Try again in a moment.')
  process.exit(1)
}

const pad = (s, n) => String(s).padStart(n)
console.log('tab'.padEnd(12), pad('rows', 5), pad('hint words', 11), pad('longest', 8), pad('controls', 9))
const sum = { rows: 0, hintWords: 0, longest: 0, controls: 0 }
for (const t of r.out) {
  for (const k of Object.keys(sum)) sum[k] = k === 'longest' ? Math.max(sum[k], t[k]) : sum[k] + t[k]
  console.log(t.tab.padEnd(12), pad(t.rows, 5), pad(t.hintWords, 11), pad(t.longest, 8), pad(t.controls, 9))
}
console.log(`TOTAL (${r.out.length} tabs)`.padEnd(12), pad(sum.rows, 5), pad(sum.hintWords, 11), pad(sum.longest, 8), pad(sum.controls, 9))
