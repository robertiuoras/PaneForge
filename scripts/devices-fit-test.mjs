// Can the Devices panel be READ, and can its Close button be reached?
//
// Two faults, both measured in a real window at 1500x912 before this existed:
//
//  1. 1057px of content in an 812px box, with NOTHING paired. So it scrolled on an empty
//     desk and every section below the fold was found by dragging - and it can only get
//     worse, because a paired machine adds a row per pane it has. Two columns halve the
//     tallest thing on screen instead of summing it.
//
//  2. The dialog had no growing child, so the WHOLE dialog scrolled and the footer was
//     pinned over it with `position: sticky` - with a background but no cover strip above
//     it, so a section scrolling past ended up under the Close button's top edge. That is
//     the report: the close button overlapping the panel.
//
// Both are geometry over the shipped stylesheet and the real component, so it is measured
// in the app rather than in a fixture: a hand-written copy of this markup would drift from
// RemoteDialog.tsx the first time somebody adds a row.
//
//   npm run build && npm run try -- --keep --minimized --remote-debugging-port=9334
//   PF_PORT=9334 node scripts/devices-fit-test.mjs
// It skips out loud when there is no window, like the other window tests.

const PORT = process.env.PF_PORT || '9333'

let page
for (let i = 0; i < 20; i++) {
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    .then((r) => r.json())
    .catch(() => [])
  page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !(t.url ?? '').includes('shelf'))
  if (page) break
  await new Promise((r) => setTimeout(r, 500))
}
if (!page) {
  console.log(`SKIP: no debuggable window on port ${PORT}.`)
  console.log('  npm run build && npm run try -- --keep --minimized --remote-debugging-port=9334')
  console.log('  PF_PORT=9334 node scripts/devices-fit-test.mjs')
  process.exit(0)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
const pending = new Map()
let seq = 0
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
})
const evalIn = async (expression) => {
  const r = await new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, { res, rej })
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result.value
}

let bad = 0
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ' - ' + detail : ''}`)
  if (!ok) bad++
}

const m = await evalIn(`(async () => {
  // The page target answers CDP before React has drawn the rail, so the control is waited
  // for rather than asked for once - a missing button here is a boot that had not finished.
  const find = () => [...document.querySelectorAll('button')].find((b) =>
    /device/i.test((b.title || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + b.textContent))
  let open = null
  for (let i = 0; i < 40 && !(open = find()); i++) await new Promise((r) => setTimeout(r, 250))
  if (!open) return { err: 'no control opens Devices' }
  open.click()
  await new Promise((r) => setTimeout(r, 1200))
  const d = document.querySelector('.dialog.devices')
  if (!d) return { err: 'Devices did not open' }
  const cols = d.querySelector('.dev-cols')
  if (!cols) return { err: 'the panel has no .dev-cols growing child' }
  const close = [...d.querySelectorAll(':scope > .dialog-row:last-child button')].pop()
  const last = cols.querySelector('.dev-col:last-child > *:last-child')
  const r = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) } }
  return {
    win: { w: innerWidth, h: innerHeight },
    dialogH: Math.round(d.getBoundingClientRect().height),
    maxH: Math.round(parseFloat(getComputedStyle(d).maxHeight)),
    dialogScrolls: d.scrollHeight > d.clientHeight + 1,
    colsScroll: cols.scrollHeight > cols.clientHeight + 1,
    colH: [...d.querySelectorAll('.dev-col')].map((c) => Math.round(c.getBoundingClientRect().height)),
    cols: r(cols), close: r(close), last: r(last),
    twoUp: getComputedStyle(cols).gridTemplateColumns.split(' ').length === 2
  }
})()`)

if (m.err) {
  console.log(`FAIL  ${m.err}`)
  ws.close()
  process.exit(1)
}

check(m.twoUp || m.win.w <= 1000, 'it is two columns on a window wide enough for them', JSON.stringify(m.colH))
// The whole point of the columns. Summed, this panel was 1057px against an 812px box on
// an empty desk; the taller column is what it costs now.
check(
  m.dialogH < m.maxH - 20 || m.win.h < 700,
  'and the panel is shorter than the window will allow, rather than pinned at its ceiling',
  `${m.dialogH} of ${m.maxH}`
)
check(!m.dialogScrolls, 'the dialog shell itself never scrolls - the head and the footer stay put')
check(!m.colsScroll || m.win.h < 700, 'and on an ordinary window there is nothing to scroll at all')
// The overlap. `last` is the bottom of the real content; `close` is the button. A cover
// strip above a sticky footer is what stops one reaching the other, and it is invisible
// in a diff - the rule that was missing was `padding-top` on a row that already had
// `padding-bottom`.
check(
  m.last.bottom <= m.close.top,
  'nothing reaches the Close button - content ends above it',
  `content ends ${m.last.bottom}, button starts ${m.close.top}`
)
check(m.close.top >= m.cols.top, 'and the button is below the scroll area, not floating inside it')

ws.close()
console.log(bad ? `\n${bad} failed` : '\nall good')
process.exit(bad ? 1 : 0)
