// The other machine's screen, proven in a real window: a headless copy looks at ITSELF
// through the real capture window and a real WebRTC connection (loopback mode), with a
// moving test card standing in for the desktop.
//
//   PF_SCREEN_LOOPBACK=1 PF_SCREEN_FAKE=1 npm run try -- --keep --headless --remote-debugging-port=9444
//   PF_PORT=9444 node scripts/screen-stream-window-test.mjs
//
//   PF_SCREEN_LOOPBACK=1 PF_SCREEN_FAKE=locked npm run try -- --keep --headless --remote-debugging-port=9444
//   PF_PORT=9444 node scripts/screen-stream-window-test.mjs --locked
//
// What it reads: the quick button opens a pane (not a Moonlight window), the pane shares
// the window with a terminal pane, a picture arrives, the quality line fills, the zoom
// buttons / pinch / Cmd-Ctrl 0 move the zoom, a click on the terminal pane takes the focus
// back, and closing the view stops the capture. `--locked`: the card says the screen is
// locked and offers `Wake the desktop`.

import { connect } from './ui-lab.mjs'

const port = process.env.PF_PORT ?? '9444'
const locked = process.argv.includes('--locked')
const link = await connect(port)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let checks = 0
let failed = 0
const ok = (cond, what, detail) => {
  checks++
  if (cond) console.log(`  ok   ${what}`)
  else {
    failed++
    console.log(`  FAIL ${what}${detail === undefined ? '' : ` - ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }
}
const ev = (js) => link.evaluate(js)
const until = async (js, ms = 15000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await ev(js)
    if (v) return v
    if (Date.now() > end) return v
    await sleep(250)
  }
}

// A terminal pane first, so the view has something to sit beside.
await ev(`window.api.startSession({ cwd: ${JSON.stringify(process.cwd())}, agent: 'shell' })`)
await until(`document.querySelectorAll('.pane:not(.hidden)').length >= 1`)

const btn = await until(`!!document.querySelector('button[aria-label="See the other machine\\'s screen"]')`)
ok(btn, 'the quick button is drawn')
await ev(`document.querySelector('button[aria-label="See the other machine\\'s screen"]').click()`)
const id = await until(`Object.keys(window.__pfScreen || {})[0] || ''`)
ok(Boolean(id), 'pressing it opens a screen pane in the app', id)

if (locked) {
  // `Connecting to …` first, then the source's answer: wait for the answer.
  const card = await until(`(t => /locked/.test(t) && t)(document.querySelector('.screen-card-title')?.textContent || '')`)
  ok(/screen is locked/.test(card), 'a locked screen says so instead of drawing black', card)
  const wake = await ev(`[...document.querySelectorAll('.screen-card-actions button')].map((b) => b.textContent)`)
  ok(wake.includes('Wake the desktop'), 'and offers Wake the desktop', wake)
  ok((await ev(`window.__pfScreen[${JSON.stringify(id)}].failure`)) === 'locked', 'state machine reads locked')
} else {
  const phase = await until(`window.__pfScreen[${JSON.stringify(id)}].phase === 'connected' && 'connected'`, 20000)
  ok(phase === 'connected', 'a picture arrives', await ev(`JSON.stringify(window.__pfScreen[${JSON.stringify(id)}])`))
  const pic = await ev(`window.__pfScreen[${JSON.stringify(id)}].pic`)
  ok(pic?.w === 1280 && pic?.h === 720, 'at the source\'s own size', pic)

  // Beside the terminal, not over it.
  const layout = await ev(`(() => {
    const shown = [...document.querySelectorAll('.pane:not(.hidden)')]
    const mine = document.querySelector('.pane[data-id=${JSON.stringify(id)}]')
    return { shown: shown.length, w: mine?.getBoundingClientRect().width, win: innerWidth }
  })()`)
  ok(layout.shown >= 2 && layout.w < layout.win * 0.8, 'the view sits beside the terminal pane, not over the window', layout)

  await sleep(2500)
  const line = await ev(`document.querySelector('.pane[data-id=${JSON.stringify(id)}] .screen-quality')?.textContent || ''`)
  ok(/^\d+ fps · \d+ kbps/.test(line), 'the footer shows fps and kbps', line)
  const fps = Number(line.split(' ')[0])
  ok(fps >= 10, 'frames keep coming', line)

  const z = (k) => ev(`window.__pfScreen[${JSON.stringify(id)}].${k}`)
  ok((await z('fit')) === true, 'starts at Fit')
  const fitZ = await z('zoom')
  await ev(`document.querySelector('.pane[data-id=${JSON.stringify(id)}] button[aria-label="Zoom in"]').click()`)
  await sleep(150)
  const inZ = await z('zoom')
  ok((await z('fit')) === false && inZ > fitZ, 'the + button zooms in from Fit', { fitZ, inZ })
  const pct = await ev(`document.querySelector('.pane[data-id=${JSON.stringify(id)}] .screen-pct').textContent`)
  ok(pct === `${Math.round(inZ * 100)}%`, 'the button reads the zoom', pct)

  // Pinch = a wheel with ctrlKey, over the picture.
  await ev(`(() => {
    const box = document.querySelector('.pane[data-id=${JSON.stringify(id)}] .screen-box')
    const r = box.getBoundingClientRect()
    box.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, ctrlKey: true, clientX: r.left + 40, clientY: r.top + 40, bubbles: true, cancelable: true }))
  })()`)
  await sleep(150)
  const pinchZ = await z('zoom')
  ok(pinchZ > inZ, 'a pinch zooms in', { inZ, pinchZ })
  const scrolled = await ev(`(() => { const b = document.querySelector('.pane[data-id=${JSON.stringify(id)}] .screen-box'); return { w: b.scrollWidth, cw: b.clientWidth } })()`)
  ok(scrolled.w > scrolled.cw, 'a zoomed picture scrolls rather than being cut off', scrolled)

  // Cmd/Ctrl 0 = Fit, through the app's own key handler.
  await ev(`(() => {
    const mac = navigator.platform.includes('Mac')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '0', metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }))
  })()`)
  await sleep(150)
  ok((await z('fit')) === true, 'Cmd/Ctrl 0 goes back to Fit')
  const font0 = await ev(`window.api.getConfig().then((c) => c.fontSize)`)
  await ev(`(() => {
    const mac = navigator.platform.includes('Mac')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '=', metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }))
  })()`)
  await sleep(200)
  const font1 = await ev(`window.api.getConfig().then((c) => c.fontSize)`)
  ok((await z('fit')) === false && font1 === font0, 'Cmd/Ctrl + zooms the picture and leaves the terminal font alone', { font0, font1 })

  // One click takes the focus back to the terminal pane; the view stays on screen.
  await ev(`(() => {
    const other = [...document.querySelectorAll('.pane:not(.hidden)')].find((p) => p.dataset.id !== ${JSON.stringify(id)})
    other.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
  })()`)
  await sleep(200)
  const after = await ev(`({ focused: document.querySelector('.pane.focused')?.dataset.id, visible: !document.querySelector('.pane[data-id=${JSON.stringify(id)}]').classList.contains('hidden') })`)
  ok(after.focused && after.focused !== id && after.visible, 'a click on the terminal takes the focus back and the view stays', after)
}

// Close the view: the pane goes, and so does the capture (the hidden window closes).
await ev(`document.querySelector('.pane[data-id=${JSON.stringify(id)}] .pt-close').click()`)
const gone = await until(`!document.querySelector('.pane[data-id=${JSON.stringify(id)}]')`)
ok(gone, 'the close button ends the view')
if (!locked) {
  await sleep(500)
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  ok(!targets.some((t) => t.url === 'about:blank'), 'and the capture window with it', targets.map((t) => t.url))
}

console.log(failed ? `screen-stream window: ${failed}/${checks} FAILED` : `screen-stream window: ok (${checks} checks)`)
process.exit(failed ? 1 : 0)
