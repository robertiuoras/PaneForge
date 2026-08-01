// The routing suggestion in a real window.
//
//   npm run build
//   npm run try -- --keep --show --remote-debugging-port=9334
//   PF_PORT=9334 npm run test:routeview
//
// project-route-test.mjs pins the scorer, which is a pure function and easy to be sure
// about. What it cannot answer is the half that actually decides which folder a session
// opens in: the message box debounces, the reply comes back over IPC into a closure built
// a keystroke earlier, and the tick it makes has to be swapped when the message changes
// and dropped the moment the user disagrees. Every one of those is a real-DOM question.
//
// It runs against the REAL projects root, because that is the thing being claimed: typing
// Robert's actual message into his actual app ticks Toolstash. Nothing is started - the
// dialog is opened, typed into, read, and closed with Escape.

import { setTimeout as sleep } from 'node:timers/promises'

const port = process.env.PF_PORT ?? '9334'
const root = new URL('..', import.meta.url).href.replace(/\/?$/, '/').toLowerCase()

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && !(t.url ?? '').includes('shelf')
      )
      // Every lane's copy is told to use a port, so the first one up owns it. Measuring
      // another checkout's build and calling it verified is the failure this prevents.
      if (page && !(page.url ?? '').toLowerCase().startsWith(root))
        throw new Error(`port ${port} belongs to another checkout: ${page.url}`)
      if (page) return page
    } catch (e) {
      if (e instanceof Error && e.message.startsWith(`port ${port} belongs`)) throw e
    }
    await sleep(500)
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

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
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

// ---------------------------------------------------------------- open the dialog

const OPEN = `(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true, metaKey: navigator.platform.startsWith('Mac'), bubbles: true }))
  return true
})()`

/**
 * React listens for `input`, not for an assignment, so the value has to go in through the
 * prototype setter with the event dispatched after it. Typing key by key would be closer
 * to real life and is not worth it here: the debounce is what matters and it is the same
 * either way.
 */
const type = (text) => `(() => {
  const box = document.querySelector('.dialog input.search.prompt')
  if (!box) return 'no prompt box'
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  set.call(box, ${JSON.stringify(text)})
  box.dispatchEvent(new Event('input', { bubbles: true }))
  return 'typed'
})()`

const READ = `(() => {
  const dialog = document.querySelector('.dialog')
  if (!dialog) return { open: false }
  const box = dialog.querySelector('input.search.prompt')
  return {
    open: true,
    routed: box ? box.dataset.routed : null,
    manual: box ? box.dataset.manual : null,
    line: (dialog.querySelector('.route-on') || {}).textContent || '',
    why: (dialog.querySelector('.route-why') || {}).textContent || '',
    alts: [...dialog.querySelectorAll('.route-alt')].map((b) => b.textContent),
    ticked: [...dialog.querySelectorAll('.proj.on .proj-name')].map((n) => n.textContent)
  }
})()`

await evaluate(OPEN)
await sleep(400)
const opened = await evaluate(READ)
ok('Ctrl+T opens the new session dialog', opened.open === true, JSON.stringify(opened))

// ---------------------------------------------------------------- the real message

// The one that started this: written in a session that was open in `assistant`, about a
// page of Toolstash. Both projects exist in the real root, so a scorer that counted names
// instead of weighing them would tick PaneForge here.
await evaluate(type('Add visit tracking to toolstash.xyz/paneforge'))
await sleep(700)
const routed = await evaluate(READ)
ok('the message ticks the project it names', routed.ticked.includes('Toolstash'), JSON.stringify(routed))
ok('and says so, in a sentence about what is about to happen', /^Opening in Toolstash$/.test(routed.line.trim()), routed.line)
ok('with the reason it decided that', /toolstash\.xyz/.test(routed.why), routed.why)
ok('nothing else is ticked', routed.ticked.length === 1, JSON.stringify(routed.ticked))

// ---------------------------------------------------------------- changing your mind

// Rewriting the message must move the tick, not add one. The debounced reply lands in a
// closure built before the previous match was recorded, which is exactly how two projects
// end up ticked from one message.
await evaluate(type('fix the paneforge lane healer stashing my uncommitted work'))
await sleep(700)
const moved = await evaluate(READ)
ok('a rewritten message moves the tick rather than adding one', moved.ticked.length === 1 && moved.ticked.includes('PaneForge'), JSON.stringify(moved))

// A message that names nothing has to leave the dialog exactly as it found it.
await evaluate(type('make the button a bit bigger please'))
await sleep(700)
const quiet = await evaluate(READ)
ok('a message naming no project ticks nothing', quiet.ticked.length === 0, JSON.stringify(quiet))
ok('and shows no routing line', quiet.line.trim() === '', quiet.line)

// ---------------------------------------------------------------- saying no

await evaluate(type('deploy toolstash.xyz tonight'))
await sleep(700)
const back = await evaluate(READ)
ok('routing returns when the message names a project again', back.ticked.includes('Toolstash'), JSON.stringify(back.ticked))

const dismissed = await evaluate(`(async () => {
  document.querySelector('.dialog .route-x').click()
  await new Promise((r) => setTimeout(r, 200))
  return [...document.querySelectorAll('.dialog .proj.on .proj-name')].map((n) => n.textContent)
})()`)
ok('the x unticks it', dismissed.length === 0, JSON.stringify(dismissed))

// And it stays dismissed: having said no once, typing more must not tick it again.
await evaluate(type('deploy toolstash.xyz tonight and check the admin traffic tab'))
await sleep(700)
const stillOff = await evaluate(READ)
ok('and it does not come back on the next keystroke', stillOff.ticked.length === 0, JSON.stringify(stillOff.ticked))

// ---------------------------------------------------------------- leave nothing behind

await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) || true`)
await sleep(300)
const closed = await evaluate(`(() => !document.querySelector('.dialog'))()`)
ok('the dialog closes without starting anything', closed === true)

ws.close()
if (failed) {
  console.log(`\n${failed} failing check(s)`)
  process.exit(1)
}
console.log('\nall checks passed')
