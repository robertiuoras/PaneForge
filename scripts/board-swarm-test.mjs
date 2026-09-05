// Renderer-level behaviour proof for Board and Swarm. It mounts the actual bundled
// components into a disposable DOM host in the already-running dev-a renderer and stubs
// only their IPC boundary. It never starts an agent or writes a project board.
//
// Requires the owner-launched dev copy: PF_PORT=9334 node scripts/board-swarm-test.mjs

import { buildSync } from 'esbuild'
import { connect, SkipError } from './ui-lab.mjs'

const PORT = process.env.PF_PORT || '9334'
const ROOT = new URL('..', import.meta.url).pathname
const component = (global) => {
  const source = buildSync({
    entryPoints: [ROOT + 'scripts/board-swarm-fixture.tsx'],
    bundle: true,
    format: 'iife',
    globalName: global,
    platform: 'browser',
    tsconfig: ROOT + 'tsconfig.web.json',
    write: false,
    loader: { '.css': 'text' }
  }).outputFiles.find((file) => file.path.endsWith('.css') === false).text
  // CDP evaluates each expression in a separate lexical scope. Preserve the bundle
  // export between the injection expression and the later mount expression.
  return source
    .replaceAll('window.api', 'window.__pfBoardTestApi')
    .replace(`var ${global} =`, `globalThis.${global} =`)
}

let link
try {
  link = await connect(PORT)
} catch (error) {
  if (error instanceof SkipError) {
    console.log(`SKIP: ${error.message}`)
    process.exit(0)
  }
  throw error
}
let bad = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`)
  if (!ok) bad++
}
const evaluate = (expression) => link.evaluate(expression)
const inject = async (source) => {
  const encoded = Buffer.from(source, 'utf8').toString('base64')
  await evaluate(`eval(atob(${JSON.stringify(encoded)}))`)
}
const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
const rect = async (selector) =>
  evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`
  )
const click = async (selector) => {
  const point = await rect(selector)
  if (!point) throw new Error(`missing fixture control: ${selector}`)
  await link.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  })
  await link.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1
  })
}
const type = async (selector, text) => {
  await click(selector)
  await link.send('Input.insertText', { text })
}

try {
  await evaluate(`(() => {
    window.__pfBoardTestOriginalApi = window.api
    window.__pfBoardTestApi = {}
    window.api = window.__pfBoardTestApi
    window.__pfBoardTest = { tasks: [{ id: 't1', title: 'Original', status: 'todo', createdAt: 1, updatedAt: 1 }], memory: 'Saved memory', taskMode: 'fail', memoryMode: 'fail', starts: 0 }
    const old = document.getElementById('__pf-board-swarm-test')
    old?.remove()
    const host = document.createElement('div'); host.id = '__pf-board-swarm-test'; document.body.append(host)
  })()`)
  await inject(component('__pfBoardSwarmFixture'))
  await evaluate(`(() => {
    const state = window.__pfBoardTest
    const board = () => ({ path: state.cwd || '/one', tasks: state.tasks, memory: state.memory, memoryPath: '/one/.paneforge/MEMORY.md' })
    window.__pfBoardTestApi.board = async (cwd) => { const delay = cwd === '/old' ? 50 : 0; await new Promise((r) => setTimeout(r, delay)); state.cwd = cwd; return board() }
    window.__pfBoardTestApi.saveTasks = async (_cwd, tasks) => { if (state.taskMode === 'ok') state.tasks = tasks; return board() }
    window.__pfBoardTestApi.saveMemory = async (_cwd, memory) => { if (state.memoryDelay) await new Promise((r) => setTimeout(r, state.memoryDelay)); if (state.memoryMode === 'ok') state.memory = memory; return board() }
    const renderBoard = (cwd = '/one') => __pfBoardSwarmFixture.mountBoard(document.getElementById('__pf-board-swarm-test'), { cwd, onClose() {} })
    window.__pfBoardTest = { ...state, renderBoard, board, state }
    renderBoard()
  })()`)
  await wait(150)
  await type('#__pf-board-swarm-test input[aria-label="New task"]', 'Keep this draft')
  await wait()
  await click('#__pf-board-swarm-test .pf-board-add button')
  await wait()
  const failedTask = await evaluate(
    `(() => ({ titles: [...document.querySelectorAll('#__pf-board-swarm-test .pf-task-title')].map((x) => x.textContent), draft: document.querySelector('#__pf-board-swarm-test input[aria-label="New task"]').value }))()`
  )
  await type('#__pf-board-swarm-test textarea.memory', 'Unsaved memory')
  await wait()
  await click('#__pf-board-swarm-test .dialog-row button:last-child')
  await wait()
  const failedMemory = await evaluate(
    `(() => { const save = document.querySelector('#__pf-board-swarm-test .dialog-row button:last-child'); return { value: document.querySelector('#__pf-board-swarm-test textarea.memory').value, saveDisabled: save.disabled } })()`
  )
  await evaluate(`window.__pfBoardTest.state.taskMode = 'ok'; window.__pfBoardTest.state.memoryMode = 'ok'`)
  await click('#__pf-board-swarm-test .pf-feedback button')
  await wait()
  await click('#__pf-board-swarm-test .pf-board-add button')
  await wait()
  const retried = await evaluate(
    `(() => ({ titles: [...document.querySelectorAll('#__pf-board-swarm-test .pf-task-title')].map((x) => x.textContent), memory: document.querySelector('#__pf-board-swarm-test textarea.memory').value }))()`
  )
  await evaluate(`window.__pfBoardTest.renderBoard('/old'); window.__pfBoardTest.renderBoard('/new')`)
  await wait(70)
  const boardResult = {
    failedTask,
    failedMemory,
    retried,
    cwd: await evaluate(`document.querySelector('#__pf-board-swarm-test .dialog-head .hint').textContent`)
  }
  check(
    boardResult.failedTask.titles.join() === 'Original',
    'failed task save leaves the original task list',
    JSON.stringify(boardResult.failedTask)
  )
  check(boardResult.failedTask.draft === 'Keep this draft', 'failed task save keeps the draft')
  check(
    boardResult.failedMemory.value.endsWith('Unsaved memory') && !boardResult.failedMemory.saveDisabled,
    'failed memory save stays dirty and editable'
  )
  check(
    boardResult.retried.titles.includes('Keep this draft') &&
      boardResult.retried.memory.endsWith('Unsaved memory'),
    'successful retry writes task and memory',
    JSON.stringify(boardResult.retried)
  )
  check(boardResult.cwd === '/new', 'stale board response cannot replace the newer cwd', boardResult.cwd)

  await evaluate(`window.__pfBoardTest.renderBoard('/one')`)
  await wait(80)
  await type('#__pf-board-swarm-test textarea.memory', 'Do not lose me')
  await wait()
  await click('#__pf-board-swarm-test > .overlay > .dialog > .dialog-row button.ghost')
  await wait()
  const closeBlocked = await evaluate(
    `([...document.querySelectorAll('#__pf-board-swarm-test .dialog .dialog-head strong')].some((el) => el.textContent?.includes('Discard unsaved')))`
  )
  await click('#__pf-board-swarm-test > .overlay > .dialog > .dialog-row button.ghost')
  await link.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await link.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })
  await wait()
  const escapeBlocked = await evaluate(
    `([...document.querySelectorAll('#__pf-board-swarm-test .dialog .dialog-head strong')].some((el) => el.textContent?.includes('Discard unsaved')))`
  )
  check(
    closeBlocked && escapeBlocked,
    'Close and Escape require an explicit discard for dirty memory',
    JSON.stringify({ closeBlocked, escapeBlocked })
  )

  await evaluate(`window.__pfBoardTest.renderBoard('/one'); window.__pfBoardTest.state.memoryDelay = 80`)
  await wait(80)
  await type('#__pf-board-swarm-test textarea.memory', 'Old')
  await click('#__pf-board-swarm-test .dialog-row button:last-child')
  await type('#__pf-board-swarm-test textarea.memory', 'New')
  await wait(120)
  const pending = await evaluate(
    `(() => { const text = document.querySelector('#__pf-board-swarm-test textarea.memory').value; const save = document.querySelector('#__pf-board-swarm-test .dialog-row button:last-child'); return { text, disabled: save.disabled, status: document.querySelector('#__pf-board-swarm-test .dialog-row .hint').textContent } })()`
  )
  check(
    pending.text.endsWith('OldNew') && !pending.disabled && pending.status === 'Unsaved changes',
    'a completed old save cannot clean newer memory edits',
    JSON.stringify(pending)
  )
  await evaluate(`window.__pfBoardTest.state.memoryDelay = 80`)
  await click('#__pf-board-swarm-test .dialog-row button:last-child')
  await evaluate(`window.__pfBoardTest.renderBoard('/new')`)
  await wait(120)
  const cwdSave = await evaluate(
    `document.querySelector('#__pf-board-swarm-test .dialog-row .hint').textContent`
  )
  check(cwdSave !== 'Saving…', 'a cwd switch cannot leave the Board saving forever', cwdSave)

  const blocked = await evaluate(`(async () => {
    const state = window.__pfBoardTest.state
    window.__pfBoardTestApi.startSwarm = async () => { state.starts++; await new Promise((r) => setTimeout(r, 80)); throw new Error('test launch failure') }
    __pfBoardSwarmFixture.mountSwarm(document.getElementById('__pf-board-swarm-test'), { projects: [{ name: 'Repo', path: '/repo' }], agents: [{ id: 'claude', label: 'Claude', available: false }], roles: [{ id: 'bad', name: '', agent: 'claude', brief: '', enabled: true }], defaultModels: {}, initial: { mission: 'test' }, onSaveRoles() {}, onClose() {}, onLaunched() {} })
    await new Promise((r) => setTimeout(r, 0)); const q = (selector) => document.querySelector('#__pf-board-swarm-test ' + selector)
    return q('button.primary').disabled && q('.pf-swarm-status').textContent
  })()`)
  await evaluate(
    `__pfBoardSwarmFixture.mountSwarm(document.getElementById('__pf-board-swarm-test'), { projects: [{ name: 'Repo', path: '/repo' }], agents: [{ id: 'claude', label: 'Claude', available: true }], roles: [{ id: 'ok', name: 'Builder', agent: 'claude', brief: 'Own the UI', enabled: true }], defaultModels: {}, initial: { mission: 'test' }, onSaveRoles() {}, onClose() {}, onLaunched() {} })`
  )
  await wait()
  await click('#__pf-board-swarm-test button.primary')
  await click('#__pf-board-swarm-test button.primary')
  await wait(100)
  const swarmResult = {
    blocked,
    ...(await evaluate(
      `(() => ({ starts: window.__pfBoardTest.state.starts, error: document.querySelector('#__pf-board-swarm-test .pf-feedback')?.textContent || '' }))()`
    ))
  }
  check(
    Boolean(swarmResult.blocked) && /No available|needs/.test(swarmResult.blocked),
    'invalid or unavailable swarm is blocked',
    swarmResult.blocked
  )
  check(swarmResult.starts === 1, 'duplicate swarm launch is blocked', String(swarmResult.starts))
  check(/test launch failure/.test(swarmResult.error), 'swarm launch failure is shown', swarmResult.error)
} finally {
  await evaluate(
    `document.getElementById('__pf-board-swarm-test')?.remove(); window.api = window.__pfBoardTestOriginalApi; delete window.__pfBoardTestOriginalApi; delete window.__pfBoardTestApi; delete window.__pfBoardTest;`
  ).catch(() => {})
  link.ws.close()
}
if (bad) process.exitCode = 1
