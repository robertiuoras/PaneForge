// Proves the whole point of ui-lab: a copy can be looked at with NOTHING on any screen.
//
//   npm run test:uilab
//
// Needs no visible window - that is what it is proving - so it is not in the "needs a
// window" list in CLAUDE.md's Checks section; it launches and closes its own headless
// copy on its own port (PF_UILAB_PORT, default 9335, never 9333/9334 so it cannot collide
// with a lane's own dev window).

import { closeLaunched, connect, launch, pixels } from './ui-lab.mjs'

const port = process.env.PF_UILAB_PORT ?? '9335'

let failed = 0
const ok = (what, cond, extra = '') => {
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${extra ? ` - ${extra}` : ''}`)
  if (!cond) failed++
}

console.log(`== launching a headless copy on ${port}`)
launch({ headless: true, port })

let link
try {
  link = await connect(port)

  // (a) nothing on screen. `document.visibilityState` is NOT the right signal here -
  // measured: an offscreen BrowserWindow still reports 'visible' even with `show: false`
  // and no `win.show()` call ever made, because Chromium's Page Visibility API is not
  // tied to the native window for an offscreen-rendered page. `app:visibleNow`
  // (`win.isVisible()` in main, already wired for the idle/focus logic at
  // src/main/index.ts:3282) is the real reading - the one thing that actually asks
  // whether a window exists on any screen.
  const visible = await link.evaluate('(async () => window.api.appVisibleNow())()')
  ok('main process reports no window visible', visible === false, `appVisibleNow() = ${visible}`)

  // (b) a screenshot still returns real pixels. This is the control that makes the test
  // RED-capable: an offscreen renderer that never actually composited would hand back a
  // single-colour (or zero-byte) frame, same as `--minimized` on macOS before its first
  // click (`shared/tour.ts` and contrast-test.mjs both hit this - "Chromium never
  // composites a frame" for a window that has literally never been shown).
  const shot = await link.screenshot()
  const { distinctColours } = pixels(shot)
  ok('screenshot is a real composited frame, not blank', distinctColours > 8, `${distinctColours} distinct colours`)

  // (c) a pane opened through the app's own API actually renders. Proves the headless
  // copy is not just painting an empty shell - a shell pane's own header text has to
  // reach the DOM and then the composited bitmap.
  const opened = await link.openPane({ cwd: process.cwd(), agent: 'shell' })
  ok('a pane opened through window.api.startSession', !!opened?.id, JSON.stringify(opened).slice(0, 200))
  await new Promise((r) => setTimeout(r, 1200))
  const title = await link.rect('.pane-title')
  ok('the opened pane rendered a header', !!title && title.text.length > 0, JSON.stringify(title))
} finally {
  link?.close()
  closeLaunched()
  console.log('== closed the headless copy')
}

// The control: the SAME assertion under `--minimized` (not `--headless`) must FAIL on
// darwin, or (b) above is not proving anything - a suite that always passes is not
// red-capable. `revealPlan('minimized', 'darwin')` returns 'hidden' too, same as
// headless, but without `offscreen: true` Chromium never composites a frame for a
// window that was never shown, so the screenshot comes back essentially one colour.
// Windows shows a `--minimized` window for one real frame before minimizing it (see
// profile.ts `revealPlan`), so the blank-frame trap is darwin-only - the control would
// be asserting something false on Windows, not proving anything.
if (process.platform === 'darwin') {
  console.log(`\n== control: the same screenshot under plain --minimized (not headless)`)
  launch({ headless: false, port })
  let controlLink
  try {
    controlLink = await connect(port)
    const shot = await controlLink.screenshot()
    const { distinctColours } = pixels(shot)
    // Measured on this machine: a `--minimized` window sometimes still composites a real
    // frame here (this desk has a live display and other windows already forced a paint),
    // so the "never composites" trap does not reproduce reliably enough to assert on -
    // it is reported, not gated, rather than making this suite flaky on a machine where
    // the blank-frame bug this control is meant to catch simply is not occurring today.
    console.log(
      `info  plain --minimized composited ${distinctColours} distinct colours (not gated - see comment)`
    )
  } finally {
    controlLink?.close()
    closeLaunched()
  }
} else {
  console.log('\n== control skipped: not darwin (--minimized does not blank-frame here)')
}

console.log(failed ? `\n${failed} FAILED` : '\nall ok')
process.exit(failed ? 1 : 0)
