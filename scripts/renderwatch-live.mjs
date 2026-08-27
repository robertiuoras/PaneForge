// Prove the watchdog against a REAL spinning renderer, in a real window.
//
// The arithmetic is `npm run test:renderwatch`. This is the other half: that a renderer
// stuck in `while (true)` is actually noticed, actually reloaded, and that the panes are
// still there afterwards - which is the whole reason a reload is allowed to be the fix.
//
//   npm run build
//   npm run try -- --keep --minimized --remote-debugging-port=9334
//   PF_PORT=9334 node scripts/renderwatch-live.mjs
//   npm run try -- --close
//
// It is out of the default suite for the same reason `test:view` is: it needs a window.

import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rootUrl = pathToFileURL(root).href.replace(/\/?$/, '/').toLowerCase()
const port = process.env.PF_PORT ?? '9333'

let failed = 0
const ok = (what, cond, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${extra ? ` - ${extra}` : ''}`)
}

async function mainPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const p = list.find(
        (e) =>
          e.type === 'page' &&
          (e.url ?? '').toLowerCase().startsWith(rootUrl) &&
          !(e.url ?? '').includes('shelf')
      )
      if (p) return p
    } catch {
      /* the window may still be launching */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

/** One evaluate, on its own short-lived socket, with a deadline. A wedged page never answers. */
async function evaluate(wsUrl, expression, timeoutMs = 4000) {
  const ws = new WebSocket(wsUrl)
  try {
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error('socket')), { once: true })
      setTimeout(() => rej(new Error('open timeout')), timeoutMs)
    })
    const answer = new Promise((res, rej) => {
      ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data)
        if (m.id !== 1) return
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
      })
      setTimeout(() => rej(new Error('evaluate timeout')), timeoutMs)
    })
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true }
      })
    )
    const out = await answer
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? 'threw')
    return out.result?.value
  } finally {
    try {
      ws.close()
    } catch {
      /* nothing to do */
    }
  }
}

const page = await mainPage()
if (!page) {
  console.log('render watch (live): SKIPPED - no test copy on port ' + port)
  process.exit(0)
}

const before = await evaluate(page.webSocketDebuggerUrl, '(async()=>(await window.api.listSessions()).map(s=>s.id))()')
ok('a window to wedge, with panes in it', Array.isArray(before), JSON.stringify(before))

// A mark that only survives while this JS context does. A reload wipes it, which is the
// evidence that the recovery ran - `location.reload()` leaves no other trace a page can
// read about itself.
await evaluate(page.webSocketDebuggerUrl, 'window.__spinMark = 1')

// Deliberately BOUNDED. If the watchdog is broken the window comes back on its own and the
// person running this is not left with the app they were told this fixes.
const SPIN_MS = 45_000
await evaluate(
  page.webSocketDebuggerUrl,
  `setTimeout(() => { const end = Date.now() + ${SPIN_MS}; while (Date.now() < end) {} }, 0); 'spinning'`
).catch(() => undefined)
console.log(`     spinning the renderer for up to ${SPIN_MS / 1000}s...`)

const wedgedAt = Date.now()
let cleared = 0
let mark = 'unknown'
// PROBE_DEAD_MS (20s) + a tick, plus room for the reload itself.
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const p = await mainPage()
  if (!p) continue
  try {
    mark = await evaluate(p.webSocketDebuggerUrl, 'String(window.__spinMark)', 2500)
    cleared = Date.now() - wedgedAt
    break
  } catch {
    /* still wedged */
  }
}

ok('the window answers again', cleared > 0, cleared ? `after ${(cleared / 1000).toFixed(1)}s` : 'never')
ok(
  '...because it was RELOADED, not because the spin ran out',
  cleared > 0 && cleared < SPIN_MS - 5000 && mark === 'undefined',
  `mark=${mark} at ${(cleared / 1000).toFixed(1)}s of ${SPIN_MS / 1000}s`
)

const after = await mainPage()
const ids = after
  ? await evaluate(after.webSocketDebuggerUrl, '(async()=>(await window.api.listSessions()).map(s=>s.id))()', 15000).catch(
      () => null
    )
  : null
ok(
  'every pane came back - the pty never moved, so a reload may not lose one',
  Array.isArray(before) && Array.isArray(ids) && before.every((id) => ids.includes(id)),
  `${JSON.stringify(before)} -> ${JSON.stringify(ids)}`
)

console.log(failed ? `\n${failed} failed` : '\nrender watch (live): all good')
process.exit(failed ? 1 : 0)
