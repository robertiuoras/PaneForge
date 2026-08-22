// What reaches the model menu when OpenRouter's own catalogue is read.
//
// The weight is in the DROPS. A model with no tool calling answers the first turn in a
// Claude Code pane and then cannot read a file - a pane that looks perfectly healthy and
// can do nothing, which is the failure this repo refuses everywhere else. And a payload
// that came back empty, truncated or as somebody's error page must leave the app exactly
// as it was: the hand-written list, plus "Other...". Both are controls here.
//
// The Ox Alpha row is real, copied from openrouter.ai/api/v1/models on 2026-08-22.
//
//   node scripts/or-catalogue-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-orcat-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const outfile = join(work, 'orcat.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/orCatalogue.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const cat = createRequire(import.meta.url)(outfile)
const { orChoices, mergeOrModels, parseCatalogue, usableInPane, isFree, isStealth, hintFor, labelFor, contextWords } = cat

let n = 0
const ok = (what, cond) => {
  n++
  assert.ok(cond, what)
}
const eq = (what, a, b) => {
  n++
  assert.deepEqual(a, b, `${what}\n  got:  ${JSON.stringify(a)}\n  want: ${JSON.stringify(b)}`)
}

const TOOLS = ['tools', 'tool_choice', 'max_tokens', 'temperature']

// The real row, verbatim in the fields this file reads.
const OX = {
  id: 'stealth/ox-alpha',
  name: 'Ox Alpha',
  created: 1787256295,
  context_length: 1048576,
  pricing: { prompt: '0', completion: '0' },
  supported_parameters: ['reasoning', 'max_tokens', 'temperature', 'tools', 'tool_choice']
}
const GLM = {
  id: 'z-ai/glm-5.2',
  name: 'Z.ai: GLM 5.2',
  created: 1780000000,
  context_length: 1000000,
  pricing: { prompt: '0.00000119', completion: '0.000004' },
  supported_parameters: TOOLS
}
const CHATTY = {
  id: 'someone/talker',
  name: 'Talker',
  created: 1787000000,
  context_length: 128000,
  pricing: { prompt: '0', completion: '0' },
  supported_parameters: ['max_tokens', 'temperature']
}
const SILENT = { id: 'someone/unknown', name: 'Unknown', created: 1787000000, pricing: { prompt: '0', completion: '0' } }
const payload = { data: [OX, GLM, CHATTY, SILENT] }

// --- the model this was built for -----------------------------------------
const all = orChoices(payload)
const ox = all.find((m) => m.value === 'stealth/ox-alpha')
ok('Ox Alpha reaches the menu', !!ox)
eq('...under its own name', ox.label, 'Ox Alpha')
eq('...in the free group', ox.group, 'Free on OpenRouter')
ok('...says it is free', ox.hint.includes('free'))
ok('...says how much it holds', ox.hint.includes('1M context'))
ok(
  '...and says who keeps the prompts, in the menu where the choice is made',
  ox.hint.includes('anonymous provider keeps your prompts')
)
ok('a stealth id is recognised', isStealth(OX) && !isStealth(GLM))

// --- the drops, which are the point ---------------------------------------
ok('a model with no tool calling is refused', !usableInPane(CHATTY))
ok('...and does not reach the menu', !all.some((m) => m.value === 'someone/talker'))
ok('a row that does not say is refused too, never guessed at', !usableInPane(SILENT))
ok('...control: the same row WITH tools is kept', usableInPane({ ...SILENT, supported_parameters: TOOLS }))

// --- a bad answer leaves the app as it was --------------------------------
eq('an empty payload is an empty menu', orChoices({ data: [] }), [])
eq('...as is null', orChoices(null), [])
eq('...as is an error page', orChoices('<html>502</html>'), [])
eq('...as is the wrong shape', orChoices({ models: [OX] }), [])
eq('a bare array is still read', parseCatalogue([OX]).length, 1)
eq('rows with no id are not rows', parseCatalogue({ data: [{ name: 'x' }, OX] }).length, 1)

// --- free is complete, paid is a shortcut ---------------------------------
const many = { data: [...Array(40)].map((_, i) => ({ ...GLM, id: `paid/m${i}`, created: 1780000000 + i })) }
eq('paid models are capped', orChoices(many, { paidLimit: 25 }).length, 25)
const freeMany = { data: [...Array(40)].map((_, i) => ({ ...OX, id: `free/m${i}`, created: 1780000000 + i })) }
eq('free ones never are - the whole answer is small and is why anybody opens this', orChoices(freeMany).length, 40)
eq('newest first', orChoices(many, { paidLimit: 3 }).map((m) => m.value), ['paid/m39', 'paid/m38', 'paid/m37'])

// --- how each CLI addresses it --------------------------------------------
eq(
  'a CLI reaching OpenRouter through its own provider gets the prefix',
  orChoices(payload, { prefix: 'openrouter/' }).find((m) => m.label === 'Ox Alpha').value,
  'openrouter/stealth/ox-alpha'
)
ok(
  'an id already hand-written is not offered twice',
  !orChoices(payload, { have: ['stealth/ox-alpha'] }).some((m) => m.value === 'stealth/ox-alpha')
)

// --- words ----------------------------------------------------------------
eq('a vendor prefix is already in the id', labelFor(GLM), 'GLM 5.2')
eq('"(free)" is already in the price', labelFor({ id: 'a/b', name: 'X: Thing (free)' }), 'Thing')
eq('price per million input tokens', hintFor(GLM), '$1.19/M · 1M context')
eq('a cheap one keeps its precision', hintFor({ ...GLM, pricing: { prompt: '0.00000006', completion: '1' } }).split(' ')[0], '$0.06/M')
eq('context in the unit a person reads', contextWords(128000), '128k context')
eq('...and a million is 1M', contextWords(1048576), '1M context')
eq('no context, no words', contextWords(undefined), '')
ok('free is decided by BOTH halves', isFree(OX) && !isFree({ ...OX, pricing: { prompt: '0', completion: '1' } }))

// --- the merge is additive, never a replacement ----------------------------
const curated = [{ value: 'z-ai/glm-5.2', label: 'GLM 5.2', hint: 'the one this entry was added for' }]
const merged = mergeOrModels(curated, orChoices(payload, { have: ['z-ai/glm-5.2'] }))
eq('the hand-written row opens the menu', merged[0].value, 'z-ai/glm-5.2')
eq('...keeps the label somebody chose', merged[0].hint, 'the one this entry was added for')
eq('...under a heading of its own', merged[0].group, 'Suggested')
ok('...and the live list follows it', merged.some((m) => m.value === 'stealth/ox-alpha'))
eq('nothing is listed twice', merged.length, new Set(merged.map((m) => m.value)).size)
eq('an unreachable catalogue costs nothing', mergeOrModels(curated, []).length, 1)

// --- the laws that are not arithmetic --------------------------------------
const mainSrc = readFileSync(join(root, 'src/main/agents.ts'), 'utf8')
ok(
  'listAgents never waits on the network - a dialog open must not depend on it',
  /void refreshOrModels/.test(mainSrc) && !/await refreshOrModels/.test(mainSrc)
)
const modSrc = readFileSync(join(root, 'src/main/orModels.ts'), 'utf8')
ok('an empty answer is a failed answer, and is never written over a good list', /if \(!models\.length\) return/.test(modSrc))

rmSync(work, { recursive: true, force: true })
console.log(`or-catalogue: ${n} checks passed`)
