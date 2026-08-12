// Does New session remember the runner and model picked there?
//
// This drives the real React picker in a separate PaneForge test copy. It starts no
// agent and no terminal: choose Codex, close, reopen, then read both the saved config
// and the labels on screen.
//
//   npm run build
//   npm run try -- --keep --show --remote-debugging-port=9334
//   PF_PORT=9334 node scripts/session-choice-test.mjs

import { setTimeout as sleep } from 'node:timers/promises'

const port = process.env.PF_PORT ?? '9334'
const root = new URL('..', import.meta.url).href.replace(/\/?$/, '/').toLowerCase()

async function page() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const found = list.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && !(t.url ?? '').includes('shelf')
      )
      if (found && !(found.url ?? '').toLowerCase().startsWith(root))
        throw new Error(`port ${port} belongs to another checkout: ${found.url}`)
      if (found) return found
    } catch (e) {
      if (e instanceof Error && e.message.startsWith(`port ${port} belongs`)) throw e
    }
    await sleep(250)
  }
  throw new Error(`no debuggable PaneForge window on port ${port}`)
}

const target = await page()
const ws = new WebSocket(target.webSocketDebuggerUrl)
const pending = new Map()
let seq = 0
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
})
const send = (method, params) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))

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
    console.log(`      ${detail}`)
  }
}

const OPEN = `(() => {
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('New session'))
  if (!button) return false
  button.click()
  return true
})()`

await evaluate(`(async () => {
  document.querySelector('.overlay')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  await window.api.setConfig({ defaultAgent: 'claude', defaultModels: {} })
  return true
})()`)
await sleep(150)
ok('the New session button opens the picker', await evaluate(OPEN), 'button or dialog missing')
await sleep(150)

const picked = await evaluate(`(async () => {
  const agentTrigger = document.querySelector('.dialog .agent-pick .select')
  if (!agentTrigger) return { error: 'agent picker missing' }
  agentTrigger.click()
  await new Promise((r) => setTimeout(r, 80))
  const codex = [...document.querySelectorAll('.select-menu .opt')]
    .find((o) => o.querySelector('.opt-label')?.textContent === 'Codex')
  if (!codex) return { error: 'Codex option missing' }
  codex.click()
  await new Promise((r) => setTimeout(r, 80))

  const modelTrigger = [...document.querySelectorAll('.dialog .agent-pick .select')][1]
  if (!modelTrigger) return { error: 'Codex model picker missing' }
  modelTrigger.click()
  await new Promise((r) => setTimeout(r, 80))
  const terra = [...document.querySelectorAll('.select-menu .opt')]
    .find((o) => o.querySelector('.opt-label')?.textContent === 'gpt-5.6-terra')
  if (!terra) return { error: 'Codex model option missing' }
  terra.click()
  await new Promise((r) => setTimeout(r, 150))

  const config = await window.api.getConfig()
  return { defaultAgent: config.defaultAgent, defaultModel: config.defaultModels.codex }
})()`)
ok('choosing Codex saves it as the next-session runner', picked.defaultAgent === 'codex', JSON.stringify(picked))
ok('choosing a Codex model saves it for the next session', picked.defaultModel === 'gpt-5.6-terra', JSON.stringify(picked))

await evaluate(`document.querySelector('.overlay')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
await sleep(150)
await evaluate(OPEN)
await sleep(150)
const labels = await evaluate(
  `[...document.querySelectorAll('.dialog .agent-pick .select-label')].map((n) => n.textContent)`
)
ok(
  'reopening New session restores Codex and its model',
  labels[0] === 'Codex' && labels[1] === 'gpt-5.6-terra',
  JSON.stringify(labels)
)

await evaluate(`document.querySelector('.overlay')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
ws.close()
if (failed) process.exit(1)
console.log('\nall checks passed')
