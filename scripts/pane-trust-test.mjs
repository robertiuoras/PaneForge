// What a pane on somebody else's provider starts with in its environment.
//
// The load-bearing half is the NEGATIVES: a guard that also strips a first-party pane,
// or that takes a pane's OWN provider key, is a desk that stops working - and it would
// pass a "the Anthropic key is gone" check just as happily as the right one does.
//
//   node scripts/pane-trust-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-pane-trust-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const build = (entry, name) => {
  const out = join(work, name)
  buildSync({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: out })
  return createRequire(import.meta.url)(out)
}
const { PROVIDER_ENV, isThirdParty, foreignKeyVars, scrubForeignKeys } = build('src/shared/paneTrust.ts', 'trust.cjs')
const { BUILTIN_AGENTS, findAgent, keyProviderFor, KEY_PROVIDERS } = build('src/shared/agents.ts', 'agents.cjs')

let checks = 0
const ok = (cond, what) => {
  assert.ok(cond, what)
  checks++
}
const is = (a, b, what) => {
  assert.equal(a, b, what)
  checks++
}

const claude = findAgent(BUILTIN_AGENTS, 'claude')
const or = findAgent(BUILTIN_AGENTS, 'openrouter')
const zai = findAgent(BUILTIN_AGENTS, 'zai')

// The environment a real desk hands a pane, with every credential this guard knows about.
const desk = () => ({
  PATH: '/usr/bin',
  ANTHROPIC_API_KEY: 'sk-ant-live',
  OPENAI_API_KEY: 'sk-openai-live',
  OPENROUTER_API_KEY: 'sk-or-live',
  ZAI_API_KEY: 'zai-live',
  GEMINI_API_KEY: 'AIza-live',
  GITHUB_TOKEN: 'ghp_live',
  AWS_SECRET_ACCESS_KEY: 'aws-live',
  SSH_AUTH_SOCK: '/tmp/agent.sock'
})

// --- the pane this exists for -------------------------------------------------------
ok(isThirdParty(or), 'an OpenRouter pane posts what it reads to a third party')
const scrubbed = scrubForeignKeys(desk(), or)
ok(!('ANTHROPIC_API_KEY' in scrubbed), 'the Anthropic key does not reach an OpenRouter pane')
ok(!('OPENAI_API_KEY' in scrubbed), "another vendor's inference key goes too")
ok(!('GEMINI_API_KEY' in scrubbed), 'and a provider PaneForge does hold a key for')
is(scrubbed.OPENROUTER_API_KEY, 'sk-or-live', "a pane KEEPS its own provider's variable")

// --- the negatives, which are the feature -------------------------------------------
is(keyProviderFor(claude), '', 'plain Claude Code has no third-party provider')
ok(!isThirdParty(claude), '...so it is not a third-party pane')
is(foreignKeyVars(claude).length, 0, 'a first-party pane drops nothing')
is(scrubForeignKeys(desk(), claude).ANTHROPIC_API_KEY, 'sk-ant-live', 'and keeps the key it authenticates with')

for (const [name, spec] of [['openrouter', or], ['zai', zai]]) {
  const e = scrubForeignKeys(desk(), spec)
  is(e.GITHUB_TOKEN, 'ghp_live', `${name}: the token the pane is FOR is untouched`)
  is(e.AWS_SECRET_ACCESS_KEY, 'aws-live', `${name}: this is not a sandbox and does not pretend to be`)
  is(e.SSH_AUTH_SOCK, '/tmp/agent.sock', `${name}: nor does it break git`)
  is(e.PATH, '/usr/bin', `${name}: ordinary variables survive`)
}
is(scrubForeignKeys(desk(), zai).ZAI_API_KEY, 'zai-live', "a Z.ai pane keeps Z.ai's own variable")
ok(!('ZAI_API_KEY' in scrubForeignKeys(desk(), or)), "...and an OpenRouter pane does not")

// The input is never mutated: the caller spreads this beside resolveEnv.
const src = desk()
scrubForeignKeys(src, or)
is(src.ANTHROPIC_API_KEY, 'sk-ant-live', 'the caller’s own env object is not edited in place')

// A provider added to the catalogue with no variable name here is scrubbed as an
// unknown one, which is safe - but it can never keep its OWN key, so it is named.
for (const p of KEY_PROVIDERS) {
  ok(Array.isArray(PROVIDER_ENV[p.id]), `${p.id} has an env variable name of its own (add one to PROVIDER_ENV)`)
}

// The wiring: a guard nothing calls is the shape that ships dead.
const spawnSrc = readFileSync(join(root, 'src/main/sessions.ts'), 'utf8')
ok(/scrubForeignKeys\(agentEnv\(\), spec\)/.test(spawnSrc), 'the pty spawn actually runs the scrub')
ok(
  spawnSrc.indexOf('scrubForeignKeys(agentEnv(), spec)') < spawnSrc.indexOf('...resolveEnv(spec, agentKeys())'),
  "...before resolveEnv, so the pane's own key is put back after"
)

rmSync(work, { recursive: true, force: true })
console.log(`pane-trust: ${checks} checks passed`)
