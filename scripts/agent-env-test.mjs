// What environment a pane's agent is started with.
//
// The failure this exists to stop is silent and expensive: an agent handed
// `ANTHROPIC_AUTH_TOKEN=${OPENROUTER_KEY}` because the key box in Settings is empty
// authenticates with that literal string. The pane opens, the banner draws, the
// prompt is typed and submitted, and several seconds later a 401 comes back - by
// which point the pane looks exactly like a healthy one that lost its connection.
// Dropping the variable instead makes the CLI fall back to the login the machine
// already has and say so on its first line.
//
//   node scripts/agent-env-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-agent-env-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'agents.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/agents.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const {
  BUILTIN_AGENTS,
  KEY_PROVIDERS,
  OPENROUTER_BASE,
  OPENROUTER_KEY_VAR,
  buildArgs,
  findAgent,
  keyProviderFor,
  keyVar,
  needsOpenRouterKey,
  resolveEnv
} = createRequire(import.meta.url)(out)

let checks = 0
const is = (actual, expected, what) => {
  assert.equal(actual, expected, what)
  checks++
}
const ok = (cond, what) => {
  assert.ok(cond, what)
  checks++
}

const or = findAgent(BUILTIN_AGENTS, 'openrouter')
is(or.id, 'openrouter', 'the OpenRouter entry is in the catalogue')

// --- the key is filled in -----------------------------------------------------
const filled = resolveEnv(or, { openrouter: 'sk-or-test' })
is(filled.ANTHROPIC_AUTH_TOKEN, 'sk-or-test', 'the key reaches the CLI')
is(filled.ANTHROPIC_BASE_URL, OPENROUTER_BASE, 'and so does the address it authenticates against')
is(filled.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1', 'literal values pass through untouched')

// --- the key is not filled in -------------------------------------------------
for (const keys of [{}, { openrouter: '' }, { openrouter: '   ' }]) {
  const bare = resolveEnv(or, keys)
  ok(!('ANTHROPIC_AUTH_TOKEN' in bare), `no key (${JSON.stringify(keys)}) drops the variable entirely`)
  ok(
    !Object.values(bare).includes(OPENROUTER_KEY_VAR),
    'and the placeholder is never handed to a CLI as if it were a credential'
  )
}
is(resolveEnv(or, { openrouter: '  sk-or-pad  ' }).ANTHROPIC_AUTH_TOKEN, 'sk-or-pad', 'a pasted key is trimmed')

// --- an agent with no env of its own -----------------------------------------
const codex = findAgent(BUILTIN_AGENTS, 'codex')
is(Object.keys(resolveEnv(codex, { openrouter: 'sk-or-test' })).length, 0, 'an agent that asked for nothing gets nothing')
ok(!needsOpenRouterKey(codex), 'and is never reported as blocked on a key')

// --- who is actually blocked without a key ------------------------------------
ok(needsOpenRouterKey(or), 'the OpenRouter entry authenticates with the key, so it is blocked without one')
for (const id of ['opencode', 'aider', 'crush']) {
  const spec = findAgent(BUILTIN_AGENTS, id)
  is(spec.env?.OPENROUTER_API_KEY, OPENROUTER_KEY_VAR, `${id} is offered the key`)
  ok(!needsOpenRouterKey(spec), `${id} still runs on its own login without one, so it is not blocked`)
}

// --- it is still Claude Code ---------------------------------------------------
is(or.bin, 'claude', 'it is the same binary, so every Claude-shaped feature in the app still applies')
assert.deepEqual(
  buildArgs(or, { model: 'z-ai/glm-5.2' }),
  ['--dangerously-skip-permissions', '--model', 'z-ai/glm-5.2'],
  'and the model reaches it as a flag'
)
checks++
assert.deepEqual(
  buildArgs(or, { resume: true, resumeId: 'abc' }),
  ['--dangerously-skip-permissions', '--resume', 'abc'],
  'resume by id works'
)
checks++

// --- permission prompts are off on every launch form ---------------------------
// The mode is decided at launch: the CLI reads argv into isBypassPermissionsModeAvailable
// and no settings key or env var can turn it on afterwards. `args` is the fresh-session
// form and is DROPPED on a resume, so a flag placed there would quietly stop applying to
// exactly the panes that live longest.
const BYPASS = '--dangerously-skip-permissions'
for (const id of ['claude', 'openrouter']) {
  const spec = findAgent(BUILTIN_AGENTS, id)
  for (const [form, opts] of [
    ['fresh', {}],
    ['continue', { resume: true }],
    ['resume by id', { resume: true, resumeId: 'abc' }],
    ['fresh with a model', { model: 'opus' }]
  ]) {
    is(buildArgs(spec, opts)[0], BYPASS, `${id}: ${form} launches with prompts off`)
  }
}

// The whole point of the entry: a pane on it must be distinguishable from a pane on
// Anthropic's own login, on the card and in config.
const claude = findAgent(BUILTIN_AGENTS, 'claude')
ok(claude.id !== or.id && claude.color !== or.color, 'a pane says which of the two it is')
ok(!claude.env, 'and plain Claude Code is left with no environment of its own')

// --- one key per provider, and every provider reachable from Settings ------------
// The failure being pinned is an agent shipped with a placeholder no provider answers:
// there is then no field on the Settings screen that can ever fill it, so the pane
// starts with the variable dropped and falls back to a login that is not the one the
// entry's whole point was to use - silently, for ever.
for (const p of KEY_PROVIDERS) {
  is(p.placeholder, keyVar(p.id), `${p.id}: the placeholder is derived from the id, not written twice`)
  ok(p.url.startsWith('https://'), `${p.id}: has somewhere to go and make a key`)
  ok(p.label && p.note && p.hint, `${p.id}: the field can be labelled, hinted and explained`)
}
const providerIds = new Set(KEY_PROVIDERS.map((p) => p.id))
const placeholders = new Set(KEY_PROVIDERS.map((p) => p.placeholder))
for (const spec of BUILTIN_AGENTS) {
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    if (!/^\$\{[A-Z0-9_]+\}$/.test(v)) continue
    ok(placeholders.has(v), `${spec.id}: ${k}=${v} is a placeholder some provider in Settings answers`)
  }
  const blocked = keyProviderFor(spec)
  if (blocked) ok(providerIds.has(blocked), `${spec.id} is blocked on a provider that exists`)
}

// A placeholder nothing answers is DROPPED, never handed over as a credential. Only a
// custom agent can produce one, and the literal `${FOO_KEY}` reaching a CLI is the same
// 401-inside-a-healthy-pane as the empty key above, with nobody to attribute it to.
const madeUp = { id: 'x', label: 'x', bin: 'x', color: '#fff', env: { SOME_TOKEN: '${NOBODY_KEY}', KEEP: 'literal' } }
const resolved = resolveEnv(madeUp, { openrouter: 'sk-or-test', nobody: 'should-not-be-read' })
ok(!('SOME_TOKEN' in resolved), 'a placeholder no provider answers is dropped')
is(resolved.KEEP, 'literal', 'and the ordinary values beside it still pass through')

// Keys are looked up by PROVIDER, so one provider's key can never fill another's slot.
const wrongKey = resolveEnv(or, { deepseek: 'sk-deepseek' })
ok(!('ANTHROPIC_AUTH_TOKEN' in wrongKey), "another provider's key does not fill this one's variable")

console.log(`agent env: ${checks} checks OK`)
