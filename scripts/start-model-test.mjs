// A pane opened with no model starts on the configured default (`config.defaultModels`),
// whichever launcher opened it. `pf open --agent claude` started seven panes on Fable
// while Settings said Opus (2026-09-23): only the New Session dialog filled the default.
//
// The rule is `src/shared/startModel.ts`, tested directly. That every launcher in main
// passes through it is pinned as a SOURCE assertion, like `panemodel-test.mjs` does for
// main-side files a bare `node` run cannot import.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { withDefaultModel, agentOf } = await import('../src/shared/startModel.ts')

let pass = 0
const t = (name, fn) => {
  fn()
  pass++
}

// The shape Settings saves, from a real config.json.
const defaults = { claude: 'claude-opus-5-5', codex: 'gpt-5.1-codex', antigravity: '' }

t('a claude pane with no model gets the configured one', () => {
  assert.equal(withDefaultModel({ cwd: '/r', agent: 'claude' }, defaults).model, 'claude-opus-5-5')
})
t('no agent at all means claude, the same as SessionManager.start', () => {
  assert.equal(withDefaultModel({ cwd: '/r' }, defaults).model, 'claude-opus-5-5')
  assert.equal(agentOf(undefined), 'claude')
})
t('a blank model counts as no model', () => {
  assert.equal(withDefaultModel({ agent: 'claude', model: '  ' }, defaults).model, 'claude-opus-5-5')
})
t('a named model always wins', () => {
  assert.equal(withDefaultModel({ agent: 'claude', model: 'claude-fable-5-1' }, defaults).model, 'claude-fable-5-1')
})
t('each agent gets its own default', () => {
  assert.equal(withDefaultModel({ agent: 'codex' }, defaults).model, 'gpt-5.1-codex')
})
t('an agent object crossing IPC is read by its id', () => {
  assert.equal(withDefaultModel({ agent: { id: 'codex' } }, defaults).model, 'gpt-5.1-codex')
})
t('a shell has no model', () => {
  assert.equal(withDefaultModel({ agent: 'shell' }, { shell: 'x' }).model, undefined)
})
t('no saved default leaves the CLI its own', () => {
  assert.equal(withDefaultModel({ agent: 'antigravity' }, defaults).model, undefined)
  assert.equal(withDefaultModel({ agent: 'claude' }, {}).model, undefined)
  assert.equal(withDefaultModel({ agent: 'claude' }, undefined).model, undefined)
})
t('the request is not mutated', () => {
  const req = { agent: 'claude' }
  withDefaultModel(req, defaults)
  assert.equal(req.model, undefined)
})

// Every launcher that starts a NEW pane in main goes through the rule.
const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
t('sessions:start / startMany / pf open start through it', () => {
  assert.match(main, /(?:manager\.start|startComputeAware)\(withDefaultModel\(lane, getConfig\(\)\.defaultModels\)\)/)
})
t("a paired desk's guest launch starts through it", () => {
  assert.match(main, /startSession: async \(req\) => \{[\s\S]{0,400}?return (?:manager\.start|startComputeAware)\(withDefaultModel\(await laneFor\(req\), getConfig\(\)\.defaultModels\)\)/)
})
t('PaneForge --open starts through it', () => {
  assert.match(main, /async function openRequest[\s\S]{0,400}withDefaultModel\(/)
})

console.log(`start-model: ${pass} checks passed`)
