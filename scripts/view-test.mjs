// What the grid and the find bar do in a real window.
//
//   npm run build
//   npm run try -- --keep --show --remote-debugging-port=9333
//   npm run test:view
//
// The layout arithmetic is pinned without a window by grid-layout-test.mjs. What that
// cannot answer is whether the panes end up where the arithmetic says: the cells are CSS
// grid lines, the dividers are absolutely positioned over the gaps, and a zoom is drawn by
// a different code path from the grid it came out of. Those are answerable only by asking
// the real window for real rectangles, which is what this does.
//
// The find bar needs a real window for a harder reason. With the WebGL renderer there is
// no text in the DOM and the highlights are decorations drawn over a canvas, so a probe
// counting elements cannot tell a search that found nothing from one that found five. The
// only honest source is the addon's own result count, which is what the bar prints.
//
// Nothing here writes to a pty. The text being searched is written into the terminal
// itself (`__paneTerms`), so no command runs, nothing is installed and no folder is
// touched beyond a temp directory the panes are opened in.
//
// Run it against a SHOWN window (--show, not --minimized). Everything here is measured
// from rectangles and from a count the addon works out from its highlight decorations,
// and both of those depend on the window being laid out and drawn; a minimized run has
// produced a pane full of matches counted as none. The bar itself is honest when that
// happens - it says "found" rather than "no matches" - but this test would then be
// measuring the fallback instead of the search.
//
// One trap this test is shaped around: a pane that is RESIZED after text is written into
// it loses that text, because the shell redraws the screen it thinks it owns. That is not
// a search bug and it cost an hour to see - so the zoom checks come first and every search
// writes its own text after the last resize.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const port = process.env.PF_PORT ?? '9333'
const root = new URL('..', import.meta.url).href.replace(/\/?$/, '/').toLowerCase()

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && !(t.url ?? '').includes('shelf')
      )
      // Same trap probe.mjs guards: every lane's test copy is told to use this port, so the
      // first one up owns it, and a "verified" fix can be measured against another
      // checkout's build entirely.
      if (page && !(page.url ?? '').toLowerCase().startsWith(root))
        throw new Error(`port ${port} belongs to another checkout: ${page.url}`)
      if (page) return page
    } catch (e) {
      if (e instanceof Error && e.message.startsWith(`port ${port} belongs`)) throw e
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`no debuggable window on port ${port}. Start one with:
  npm run build && npm run try -- --keep --show --remote-debugging-port=${port}`)
}

const page = await findPage()
const ws = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
let seq = 0
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
})
const send = (method, params) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((res, rej) => pending.set(id, { res, rej }))
}
await new Promise((res) => ws.addEventListener('open', res, { once: true }))

/** Evaluate in the renderer and return the value. Promises are awaited over there. */
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails))
  return r.result.value
}

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail !== undefined) console.log(`      ${detail}`)
  }
}

// ---------------------------------------------------------------- a desk to measure

// Four panes in four throwaway folders. Four different folders on purpose: two panes in
// one repo would be given worktree lanes, which is a different feature entirely and would
// make this test build git checkouts to search in.
const drawn = await evaluate('(() => !document.hidden)()')
ok('the window is on screen, so matches can be highlighted', drawn, 'start the copy with --show')

const dirs = [0, 1, 2, 3].map(() => mkdtempSync(join(tmpdir(), 'pf-view-')).replace(/\\/g, '/'))
const opened = await evaluate(`(async () => {
  const dirs = ${JSON.stringify(dirs)}
  for (const s of [...document.querySelectorAll('.pane[data-id]')].map((p) => p.dataset.id))
    await window.api.killSession(s)
  await new Promise((r) => setTimeout(r, 400))
  for (const cwd of dirs) await window.api.startSession({ cwd, agent: 'shell' })
  await new Promise((r) => setTimeout(r, 2500))
  await window.api.setConfig({ grid: true, gridLayout: 'tiled' })
  await new Promise((r) => setTimeout(r, 600))
  return document.querySelectorAll('.pane[data-id]').length
})()`)
ok('four panes to arrange', opened === 4, opened)

const rects = `(() => [...document.querySelectorAll('.pane:not(.hidden)')].map((p) => {
  const b = p.getBoundingClientRect()
  return { id: p.dataset.id, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
}))()`

const layout = async (kind) => {
  await evaluate(
    `(async () => { await window.api.setConfig({ gridLayout: '${kind}' }); await new Promise((r) => setTimeout(r, 600)) })()`
  )
  return evaluate(rects)
}

// ---------------------------------------------------------------- the five layouts

const near = (a, b, slop = 2) => Math.abs(a - b) <= slop

const tiled = await layout('tiled')
ok('tiled: two rows of two', new Set(tiled.map((r) => r.x)).size === 2 && new Set(tiled.map((r) => r.y)).size === 2)
ok('tiled: every pane the same size', tiled.every((r) => near(r.w, tiled[0].w) && near(r.h, tiled[0].h)))

const columns = await layout('columns')
ok('columns: all four side by side', new Set(columns.map((r) => r.x)).size === 4)
ok('columns: all on one row', new Set(columns.map((r) => r.y)).size === 1)
ok('columns: each one full height', columns.every((r) => near(r.h, tiled[0].h * 2, 20)), columns.map((r) => r.h).join(','))

const rows = await layout('rows')
ok('rows: all four stacked', new Set(rows.map((r) => r.y)).size === 4)
ok('rows: all in one column', new Set(rows.map((r) => r.x)).size === 1)

const mainLeft = await layout('main-left')
ok('big left: the first pane runs the full height', near(mainLeft[0].h, rows[0].h * 4, 30), mainLeft[0].h)
ok('big left: and is wider than the ones beside it', mainLeft[0].w > mainLeft[1].w)
ok('big left: the other three are stacked in one column', new Set(mainLeft.slice(1).map((r) => r.x)).size === 1)
ok(
  'big left: the stack starts where the main pane ends',
  mainLeft[1].x > mainLeft[0].x + mainLeft[0].w - 2,
  `${mainLeft[0].x + mainLeft[0].w} vs ${mainLeft[1].x}`
)

const mainTop = await layout('main-top')
ok('big top: the first pane runs the full width', near(mainTop[0].w, columns[0].w * 4, 40), mainTop[0].w)
ok('big top: and is taller than the row under it', mainTop[0].h > mainTop[1].h)
ok('big top: the other three are side by side on one row', new Set(mainTop.slice(1).map((r) => r.y)).size === 1)

// A divider drawn across the main pane would be a grab strip that resizes nothing it is
// touching - and it sits above the panes, so it takes the clicks too.
const dividers = await evaluate(`(() => [...document.querySelectorAll('.grid-divider')].map((d) => {
  const b = d.getBoundingClientRect()
  return { kind: d.className.includes('col') ? 'col' : 'row', x: Math.round(b.x), y: Math.round(b.y), h: Math.round(b.height) }
}))()`)
ok(
  'big top: no column divider crosses the pane that spans the width',
  dividers.filter((d) => d.kind === 'col').every((d) => d.y >= mainTop[0].y + mainTop[0].h - 12),
  JSON.stringify(dividers)
)

// ---------------------------------------------------------------- zoom

const zoom = await evaluate(`(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  await window.api.setConfig({ gridLayout: 'tiled' })
  await wait(500)
  const pane = document.querySelector('.pane[data-id]')
  const id = pane.dataset.id
  pane.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  await wait(300)
  const shot = () => {
    const on = [...document.querySelectorAll('.pane:not(.hidden)')]
    const b = on[0]?.getBoundingClientRect()
    return {
      panes: on.length,
      id: on[0]?.dataset.id,
      w: Math.round(b?.width ?? 0),
      h: Math.round(b?.height ?? 0),
      grid: !!document.querySelector('.panes.grid')
    }
  }
  const mac = navigator.userAgent.includes('Mac')
  const key = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: !mac, metaKey: mac, shiftKey: true, bubbles: true, cancelable: true }))
  const before = shot()
  key()
  await wait(700)
  const during = shot()
  key()
  await wait(700)
  return { id, before, during, after: shot() }
})()`)
ok('zoom: four panes before', zoom.before.panes === 4)
ok('zoom: one pane while zoomed', zoom.during.panes === 1, JSON.stringify(zoom.during))
ok('zoom: and it is the focused one', zoom.during.id === zoom.id)
ok('zoom: it fills the window', zoom.during.w > zoom.before.w * 1.9 && zoom.during.h > zoom.before.h * 1.9)
ok('zoom: the grid is left alone underneath', zoom.after.panes === 4 && zoom.after.grid)
ok(
  'zoom: and every pane goes back to the size it was',
  near(zoom.after.w, zoom.before.w) && near(zoom.after.h, zoom.before.h),
  `${zoom.before.w}x${zoom.before.h} -> ${zoom.after.w}x${zoom.after.h}`
)

// ---------------------------------------------------------------- the find bar
//
// Written after the last resize of the run, deliberately: a shell repaints the screen it
// owns when the pane changes shape, and takes text written straight into the terminal
// with it.

const find = await evaluate(`(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const panes = [...document.querySelectorAll('.pane[data-id]')]
  const id = panes[0].dataset.id
  panes[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  await wait(300)
  // One word in this pane, a different one in the next, so "found it" cannot mean "found
  // it in somebody else's scrollback".
  window.__paneTerms.get(id).write('\\r\\nwombat one\\r\\nhay\\r\\nwombat two\\r\\nhay\\r\\nwombat three\\r\\n')
  window.__paneTerms.get(panes[1].dataset.id).write('\\r\\nplatypus\\r\\n')
  await wait(900)

  const out = { id }
  const mac = navigator.userAgent.includes('Mac')
  const key = (k, o) => window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, ctrlKey: !mac, metaKey: mac, bubbles: true, cancelable: true }, o)))
  out.barBefore = !!document.querySelector('.find-bar')
  key('f')
  await wait(400)
  const input = document.querySelector('.find-input')
  out.barAfter = !!input
  out.inPane = document.querySelector('.find-bar')?.closest('.pane')?.dataset.id
  out.focused = document.activeElement === input

  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  const count = () => document.querySelector('.find-count')?.textContent
  const type = async (s) => {
    setter.call(input, s)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(450)
    return count()
  }
  const press = async (k, shift) => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: !!shift, bubbles: true, cancelable: true }))
    await wait(400)
    return count()
  }

  out.typed = await type('wombat')
  out.next = await press('Enter')
  out.back = await press('Enter', true)
  out.missing = await type('nothinglikethis')
  out.otherPane = await type('platypus')
  out.selection = window.__paneTerms.get(id).getSelection()
  await press('Escape')
  out.closed = !document.querySelector('.find-bar')
  out.keyboardBack = !!document.activeElement.closest('.xterm')
  return out
})()`)

ok('find: nothing on screen until it is asked for', find.barBefore === false)
ok('find: Ctrl F opens it', find.barAfter === true)
ok('find: in the pane that had the keyboard', find.inPane === find.id, `${find.inPane} vs ${find.id}`)
ok('find: with the caret in the box', find.focused === true)
ok('find: typing counts the matches in this pane', find.typed === '1/3', find.typed)
ok('find: Enter steps to the next one', find.next === '2/3', find.next)
ok('find: Shift Enter steps back', find.back === '1/3', find.back)
ok('find: a term that is not there says so', find.missing === 'no matches', find.missing)
ok("find: and a term that is only in another pane is not this pane's", find.otherPane === 'no matches', find.otherPane)
ok('find: Escape closes it', find.closed === true)
ok('find: and hands the keyboard back to the terminal', find.keyboardBack === true)

// ---------------------------------------------------------------- leave no desk behind

await evaluate(`(async () => {
  for (const id of [...document.querySelectorAll('.pane[data-id]')].map((p) => p.dataset.id))
    await window.api.killSession(id)
  await window.api.setConfig({ gridLayout: 'tiled' })
})()`)

console.log(failed ? `\n${failed} failed` : '\nall passed')
ws.close()
process.exit(failed ? 1 : 0)
