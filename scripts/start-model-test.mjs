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
const { withDefaultModel, routeCodexStart, agentOf } = await import('../src/shared/startModel.ts')

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

t('an ordinary new Codex ask starts on Sol with adaptive effort', () => {
  const req = routeCodexStart({ agent: 'codex', prompt: 'Summarize the public FlutterFlow partner program from official sources in a concise research note' })
  assert.equal(req.model, 'gpt-6-sol')
  assert.deepEqual(req.effort, { mode: 'auto' })
  assert.equal(withDefaultModel(req, { codex: 'gpt-6-astra' }).model, 'gpt-6-sol')
})
t('explicit small asks use Sol and can start low', () => {
  for (const prompt of ['Quick: list the panes', 'Fix a typo.', 'Rename the label?']) {
    const req = routeCodexStart({ agent: 'codex', prompt })
    assert.equal(req.model, 'gpt-6-sol')
  }
})
t('hard problems and ambiguous short asks retain Astra', () => {
  for (const prompt of ['Debug the auth error', 'Fix the bugs', 'Bugfix?', 'Why has this failed?', 'Help with this', 'Help with FlutterFlow MCP setup']) {
    const req = routeCodexStart({ agent: 'codex', prompt })
    assert.equal(req.model, 'gpt-6-astra', prompt)
  }
})
t('explicit model, explicit effort and resume are never rerouted', () => {
  assert.equal(routeCodexStart({ agent: 'codex', model: 'gpt-6-astra', prompt: 'Quick: list' }).model, 'gpt-6-astra')
  assert.equal(routeCodexStart({ agent: 'codex', effort: { mode: 'manual', manual: 'high' }, prompt: 'Quick: list' }).model, undefined)
  const resumed = routeCodexStart({ agent: 'codex', resume: true, prompt: 'Quick: list' })
  assert.equal(resumed.model, undefined)
  assert.equal(withDefaultModel(resumed, { codex: 'gpt-6-astra' }).model, undefined)
})
t('an unprompted Codex pane begins adaptive effort without choosing a model', () => {
  const req = routeCodexStart({ agent: 'codex' })
  assert.equal(req.model, undefined)
  assert.deepEqual(req.effort, { mode: 'auto' })
})

// Every launcher that starts a NEW pane in main goes through the rule.
const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
t('sessions:start / startMany / pf open start through it', () => {
  assert.ok(/startComputeAware\(withDefaultModel\(routeCodexStart\(lane\), getConfig\(\)\.defaultModels\)\)/.test(main))
})
t("a paired desk's guest launch starts through it", () => {
  assert.ok(/startSession: async \(req\) => \{[\s\S]{0,400}?return startComputeAware\(withDefaultModel\(routeCodexStart\(await laneFor\(req\)\), getConfig\(\)\.defaultModels\)\)/.test(main))
})
t('the new-session dialog only pins a model after an explicit selection', () => {
  const dialog = readFileSync(join(root, 'src/renderer/src/components/NewSessionDialog.tsx'), 'utf8')
  assert.ok(/model: modelSelected \? model \|\| undefined : undefined/.test(dialog))
  assert.ok(/setModelSelected\(Boolean\(m\)\)/.test(dialog))
})
t('the launch effort uses the first prompt and overrides the global Codex config', () => {
  const sessions = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
  assert.ok(/function startEffort\(req: StartSessionRequest\)[\s\S]{0,220}classifyEffort\(req.prompt\)\.level/.test(sessions))
  assert.ok(/effort: req\.effort \? startEffort\(req\) : undefined/.test(sessions))
})

console.log(`start-model: ${pass} checks passed`)
