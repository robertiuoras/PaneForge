// Execute the shipped IPC handler, because an autoclear request ends in keystrokes.
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync, buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
const from = source.indexOf("ipcMain.handle('autoclear:ask'")
const to = source.indexOf("\nipcMain.handle('autoclear:cancel'", from)
assert.ok(from >= 0 && to > from, 'autoclear ask handler is present as a bounded IPC block')
const handlerSource = transformSync(source.slice(from, to), { loader: 'ts', format: 'cjs', target: 'node20' }).code
const NOW = 1_000_000_000
const shared = buildSync({entryPoints:[join(root,'src/shared/autoclear.ts')],bundle:true,platform:'node',format:'esm',write:false}).outputFiles[0].text
const {hasFreshPaneHandoff} = await import('data:text/javascript;base64,'+Buffer.from(shared).toString('base64'))

function invoke(agent, handoff) {
  let handler
  let arms = 0
  const pane = { id: 'pane1', agent, cwd: '/project' }
  const ipcMain = { handle(name, fn) { assert.equal(name, 'autoclear:ask'); handler = fn } }
  const manager = {
    list: () => [pane],
    armAutoClear(id, plan) { arms++; return { ok: true, id, plan } }
  }
  new Function('ipcMain', 'readAutoClearAsk', 'remote', 'manager', 'clearCommandFor', 'backJobOf', 'handoffFor', 'resumeBrief', 'hasFreshPaneHandoff', 'Date', handlerSource)(
    ipcMain,
    (raw) => raw,
    { owns: () => false },
    manager,
    (id) => id === 'codex' ? '/new' : id === 'antigravity' ? '/clear' : id === 'claude' ? '/clear' : null,
    () => null,
    () => handoff,
    (_ask, path) => `resume ${path ?? 'none'}`,
    (id, hand) => hasFreshPaneHandoff(id, hand, NOW),
    { now: () => NOW }
  )
  const result = handler({}, { paneId: 'pane1', prompt: 'continue', steps: ['untrusted step'], seconds: 30, noResume: false })
  return { result, arms }
}

const owned = (overrides = {}) => ({
  path: '/home/.claude/projects/-project/memory/session-handoff.pane-pane1.md',
  mtimeMs: NOW - 1_000,
  open: 1,
  steps: ['finish the verified task'],
  ...overrides
})

for (const [label, handoff] of [
  ['missing', owned({ path: null, mtimeMs: 0, open: 0, steps: [] })],
  ['stale', owned({ mtimeMs: NOW - 20 * 60_000 - 1 })],
  ['foreign', owned({ path: '/home/.claude/projects/-project/memory/session-handoff.md' })],
  ['empty', owned({ open: 0, steps: [] })]
]) {
  const out = invoke('codex', handoff)
  assert.equal(out.result.ok, false, `${label} Codex handoff is refused`)
  assert.equal(out.arms, 0, `${label} Codex handoff never reaches armAutoClear`)
}

for (const agent of ['codex', 'antigravity']) {
  const out = invoke(agent, owned())
  assert.equal(out.result.ok, true, `fresh pane-owned ${agent} handoff is accepted`)
  assert.equal(out.arms, 1, `fresh pane-owned ${agent} handoff arms exactly once`)
}

const claude = invoke('claude', owned({ path: null, mtimeMs: 0, open: 0, steps: [] }))
assert.equal(claude.result.ok, true, 'the established Claude Stop-hook path keeps its existing contract')
assert.equal(claude.arms, 1, 'Claude still reaches the manager for its lifecycle checks')
console.log('autoclear ask: non-Claude handoff guard behaved')
