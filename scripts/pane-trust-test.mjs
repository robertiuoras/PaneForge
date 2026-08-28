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
const { PROVIDER_ENV, isThirdParty, foreignKeyVars, scrubForeignKeys, allowsCwd, withinRoot, expandRoot } =
  build('src/shared/paneTrust.ts', 'trust.cjs')
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
const zai = findAgent(BUILTIN_AGENTS, 'glm')
const aider = findAgent(BUILTIN_AGENTS, 'aider')

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

// --- which folders a third-party pane may be opened in --------------------------------
const HOME = '/Users/r'
const conf = { restrictThirdParty: true, allowedRoots: ['/Users/r/Projects/PaneForge', '~/Projects/toolstash'] }

ok(allowsCwd(or, '/Users/r/Projects/PaneForge', conf, HOME).ok, 'an allowed root itself is allowed')
ok(allowsCwd(or, '/Users/r/Projects/PaneForge/src/main', conf, HOME).ok, '...and everything under it')
ok(allowsCwd(or, '/Users/r/Projects/toolstash/lib', conf, HOME).ok, 'a ~ root is expanded against the real home')

// The boundary, which a startsWith would get wrong in the direction that leaks.
const sibling = allowsCwd(or, '/Users/r/Projects/PaneForge-secrets', conf, HOME)
ok(!sibling.ok, 'a SIBLING whose name starts with an allowed root is refused')
ok(/PaneForge-secrets/.test(sibling.reason), '...and the refusal names the folder')
ok(!withinRoot('/a/b', '/a/bc'), 'withinRoot needs a path boundary, not a prefix')
ok(withinRoot('/a/b/', '/a/b/c'), 'a trailing slash on the root changes nothing')

const denied = allowsCwd(or, '/Users/r/Projects/assistant', conf, HOME)
ok(!denied.ok, 'a folder that is on no list is refused')
ok(/Settings/.test(denied.reason), '...and the refusal names where the list is')

const empty = allowsCwd(or, '/Users/r/Projects/PaneForge', { restrictThirdParty: true, allowedRoots: [] }, HOME)
ok(!empty.ok, 'an empty list confines the pane to nowhere')
ok(/no folder is on the allowed list/.test(empty.reason), '...and says THAT, not that this folder is wrong')

// The negatives again: this may not touch a desk that did not ask for it.
ok(allowsCwd(or, '/anywhere', undefined, HOME).ok, 'no config at all means no confinement')
ok(allowsCwd(or, '/anywhere', { restrictThirdParty: false, allowedRoots: [] }, HOME).ok, 'switched off means off')
ok(allowsCwd(claude, '/Users/r/Projects/assistant', conf, HOME).ok, 'a FIRST-PARTY pane is never confined')
ok(!allowsCwd(zai, '/Users/r/Projects/assistant', conf, HOME).ok, 'every third-party runner is confined, not just OpenRouter')
// keyProviderFor is blind to these four - they name a provider in a variable of their
// own rather than in the Anthropic pair - and a guard that believed it called them
// first-party. That is a repo posted to OpenRouter with nothing refusing it.
ok(isThirdParty(aider), 'a runner that names OPENROUTER_API_KEY is third-party too')
ok(!allowsCwd(aider, '/Users/r/Projects/assistant', conf, HOME).ok, '...and is confined')
ok(!('ANTHROPIC_API_KEY' in scrubForeignKeys(desk(), aider)), '...and does not inherit the Anthropic key')
is(expandRoot('~', HOME), HOME, 'a bare ~ is the home folder')
is(expandRoot('/abs', HOME), '/abs', 'an absolute root is left alone')

// The wiring, again: a decision nothing calls is the shape that ships dead.
ok(/allowsCwd\(specFor\(agent\), req\.cwd/.test(spawnSrc), 'sessions.start() asks before the pty exists')
ok(
  // The spawn is now conditional - a pane can be born asleep, with no process at all
  // (`shared/restoreTurn.ts`) - so this looks for the CALL, not the property it sits in.
  spawnSrc.indexOf('allowsCwd(specFor(agent), req.cwd') < spawnSrc.indexOf('this.spawn(req, agent, START_COLS'),
  '...and refuses BEFORE the spawn, which cannot be taken back'
)

rmSync(work, { recursive: true, force: true })
console.log(`pane-trust: ${checks} checks passed`)
