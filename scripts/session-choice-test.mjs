// Does New session remember the runner and model picked there?
//
// This drives the real React picker in a separate PaneForge test copy. It starts no
// agent and no terminal: choose an installed runner with a model, close, reopen, then
// read both the saved config and the labels on screen. The original preferences are
// restored before the probe exits, including when an assertion fails.
//
//   npm run build
//   npm run try -- --keep --show --clipboard-test --remote-debugging-port=9334
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

let originalConfig
try {
  originalConfig = await evaluate(`window.api.getConfig()`)
  await evaluate(`(async () => {
    document.querySelector('.overlay')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    const available = (await window.api.listAgents()).find((a) => a.available)
    if (!available) throw new Error('no installed runner is available to back the probe fixture')
    await window.api.setConfig({
      defaultAgent: 'claude',
      defaultModels: {},
      customAgents: [
        ...${JSON.stringify(originalConfig?.customAgents ?? [])},
        {
          id: 'session-choice-probe',
          label: 'Session choice probe',
          // Use the resolvable command name, not its absolute path: availability is
          // defined as the command resolving to a different, concrete path.
          bin: available.bin,
          modelFlag: '--model',
          models: ['probe-model'],
          color: '#10a37f',
          custom: true
        }
      ]
    })
    return true
  })()`)
  await sleep(300)
  ok('the New session button opens the picker', await evaluate(OPEN), 'button or dialog missing')
  await sleep(150)

  const picked = await evaluate(`(async () => {
    const agents = await window.api.listAgents()
    const chosen = agents.find((a) => a.id === 'session-choice-probe' && a.available)
    if (!chosen) return { error: 'controlled model-capable runner fixture missing' }
    const firstModel = chosen.models[0]
    const modelValue = typeof firstModel === 'string' ? firstModel : firstModel.value
    const modelLabel = typeof firstModel === 'string' ? firstModel : firstModel.label

    const agentTrigger = document.querySelector('.dialog .agent-pick .select')
    if (!agentTrigger) return { error: 'agent picker missing' }
    agentTrigger.click()
    await new Promise((r) => setTimeout(r, 80))
    const agentOption = [...document.querySelectorAll('.select-menu .opt')]
      .find((o) => o.querySelector('.opt-label')?.textContent === chosen.label)
    if (!agentOption) return { error: chosen.label + ' option missing' }
    agentOption.click()
    await new Promise((r) => setTimeout(r, 80))

    const modelTrigger = [...document.querySelectorAll('.dialog .agent-pick .select')][1]
    if (!modelTrigger) return { error: chosen.label + ' model picker missing' }
    modelTrigger.click()
    await new Promise((r) => setTimeout(r, 80))
    const modelOption = [...document.querySelectorAll('.select-menu .opt')]
      .find((o) => o.querySelector('.opt-label')?.textContent === modelLabel)
    if (!modelOption) return { error: modelLabel + ' option missing' }
    modelOption.click()
    await new Promise((r) => setTimeout(r, 150))

    const config = await window.api.getConfig()
    return {
      agentId: chosen.id,
      agentLabel: chosen.label,
      modelValue,
      modelLabel,
      defaultAgent: config.defaultAgent,
      defaultModel: config.defaultModels[chosen.id]
    }
  })()`)
  ok(
    'choosing a runner saves it for the next session',
    picked.agentId && picked.defaultAgent === picked.agentId,
    JSON.stringify(picked)
  )
  ok(
    'choosing its model saves it for the next session',
    picked.modelValue && picked.defaultModel === picked.modelValue,
    JSON.stringify(picked)
  )

  await evaluate(`document.querySelector('.overlay')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await sleep(150)
  await evaluate(OPEN)
  await sleep(150)
  const labels = await evaluate(
    `[...document.querySelectorAll('.dialog .agent-pick .select-label')].map((n) => n.textContent)`
  )
  ok(
    'reopening New session restores the runner and its model',
    labels[0] === picked.agentLabel && labels[1] === picked.modelLabel,
    JSON.stringify({ labels, picked })
  )

  const solCard = await evaluate(`(async () => {
    const agents = await window.api.listAgents()
    const codex = agents.find((a) => a.id === 'codex' && a.available)
    const config = await window.api.getConfig()
    if (!codex || !config.root) return { error: 'Codex runner or project root missing' }
    const started = await window.api.startSession({
      cwd: config.root,
      agent: 'codex',
      model: 'gpt-5.6-sol',
      title: 'Sol label probe'
    })
    await new Promise((r) => setTimeout(r, 120))
    const row = document.querySelector('[data-id="' + started.id + '"]')
    const labels = [...(row?.querySelectorAll('.chip') ?? [])].map((n) => n.textContent?.trim())
    await window.api.killSession(started.id)
    return { labels }
  })()`)
  ok(
    'a Sol pane card uses the friendly Codex model label',
    solCard.labels?.includes('GPT-5.6 Sol'),
    JSON.stringify(solCard)
  )

  const copiedOutput = await evaluate(`(async () => {
    if (!(await window.api.clipboardFixtureActive())) return { error: 'private clipboard fixture is not active' }
    const agents = await window.api.listAgents()
    const shell = agents.find((a) => a.id === 'shell' && a.available)
    const config = await window.api.getConfig()
    if (!shell || !config.root) return { error: 'shell runner or project root missing' }
    // Long enough to wrap in the real xterm buffer. The output itself never appears in
    // the typed command, so this also proves we copied output rather than command echo.
    const output = 'copy-output-' + Date.now() + '-' + 'x'.repeat(400)
    const encoded = btoa(output)
    const started = await window.api.startSession({ cwd: config.root, agent: 'shell', title: 'Copy output probe' })
    try {
      // Keep the expected output out of the typed command: matching the echo alone
      // would not prove the Copy button captured terminal output.
      window.api.write(started.id, 'node -e "process.stdout.write(Buffer.from(\\'' + encoded + '\\', \\'base64\\').toString())"\\r')
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100))
        if ((await window.api.getBuffer(started.id)).includes(output)) break
      }
      const button = document.querySelector('button[aria-label="Copy Copy output probe output"]')
      if (!button) return { error: 'copy-output button missing' }
      button.click()
      await new Promise((r) => setTimeout(r, 100))
      return { output, copied: await window.api.readClipboard() }
    } finally {
      await window.api.killSession(started.id)
    }
  })()`)
  ok(
    'the visible Copy button puts complete terminal output on the clipboard',
    !copiedOutput.error && copiedOutput.copied.includes(copiedOutput.output),
    JSON.stringify(copiedOutput)
  )
} finally {
  if (originalConfig) {
    await evaluate(`window.api.setConfig(${JSON.stringify({
      defaultAgent: originalConfig.defaultAgent,
      defaultModels: originalConfig.defaultModels,
      customAgents: originalConfig.customAgents
    })})`)
  }
  await evaluate(`document.querySelector('.overlay')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  ws.close()
}
if (failed) process.exitCode = 1
else console.log('\nall checks passed')
