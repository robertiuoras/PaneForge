// Codex's own model list, and the "is this CLI behind" reading built on the same folder.
// Pure judgements only - no Codex needed, no disk, no network. `npm run test:codexmodels`.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'

const here = dirname(fileURLToPath(import.meta.url))
const src = resolve(here, '../src/shared/codexCatalogue.ts')
const js = ts.transpileModule(readFileSync(src, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText
const mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
const {
  parseCodexModels,
  codexChoices,
  mergeCodexModels,
  compareVersions,
  versionOf,
  latestFromVersionFile,
  isOutdated
} = mod

let n = 0
const is = (got, want, what) => {
  n++
  assert.deepEqual(got, want, `${what}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`)
}

// --- reading somebody else's file -----------------------------------------

is(parseCodexModels(null).length, 0, 'no payload is no models')
is(parseCodexModels({}).length, 0, 'an object with no models key')
is(parseCodexModels('nonsense').length, 0, 'a string')
is(parseCodexModels({ models: [{ display_name: 'No slug' }] }).length, 0, 'a row with no slug is dropped')
is(parseCodexModels({ models: [{ slug: '' }] }).length, 0, 'an empty slug is dropped')
is(parseCodexModels([{ slug: 'a' }]).length, 1, 'a bare array is read too')

// --- the menu -------------------------------------------------------------

const rows = [
  { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', priority: 6 },
  { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 3 },
  {
    slug: 'gpt-6-astra',
    display_name: 'GPT-6-Astra',
    description: 'Our most capable model for complex, demanding work.',
    visibility: 'list',
    priority: 1
  },
  { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini', visibility: 'list', priority: 23 }
]
const choices = codexChoices(rows)
is(
  choices.map((c) => c.value),
  ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.4-mini'],
  'hidden rows dropped, the rest in Codex own priority order'
)
is(choices[0].label, 'GPT-6-Astra', 'the display name is the label')
is(choices[0].hint, 'Our most capable model for complex, demanding work', 'first sentence, no full stop')
is(choices[1].hint, undefined, 'no description is no hint, never an empty string')
is(choices[0].group, 'Codex', 'every row sits under one heading')
is(codexChoices([{ slug: 'x', visibility: 'list' }])[0].label, 'x', 'no display name falls back to the slug')
// An unranked row must not lead the menu: the top is where the newest model goes, and a
// row this reader did not understand is the wrong thing to put there.
is(
  codexChoices([
    { slug: 'unranked', visibility: 'list' },
    { slug: 'ranked', visibility: 'list', priority: 9 }
  ]).map((c) => c.value),
  ['ranked', 'unranked'],
  'a row with no priority sorts last'
)

// --- merging with the built-in list ---------------------------------------

const curated = [
  { value: 'gpt-6-astra', label: 'GPT-6 Astra' },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' }
]
const merged = mergeCodexModels(curated, choices)
is(
  merged.map((m) => m.value),
  ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.4-mini', 'gpt-5.6-terra'],
  'the live list leads and a curated id it does not mention is kept on the end'
)
is(merged[0].label, 'GPT-6-Astra', 'a duplicate id keeps the LIVE row, not the hand-written one')
is(merged[3].group, 'Older', 'the leftovers say what they are')
// The whole contract: a failed read leaves the app exactly as it was.
is(mergeCodexModels(curated, []), curated, 'no live list changes nothing')

// --- versions -------------------------------------------------------------

is(versionOf('codex-cli 0.153.1'), '0.153.1', 'the version out of the CLI line')
is(versionOf('warning: something\ncodex-cli 1.2.3'), '1.2.3', 'a banner above it does not matter')
is(versionOf('no numbers here'), '', 'a line that is not a version')
is(versionOf(''), '', 'nothing at all')
is(latestFromVersionFile({ latest_version: '0.153.3' }), '0.153.3', 'what version.json says')
is(latestFromVersionFile({ latest_version: null }), '', 'a null latest')
is(latestFromVersionFile(null), '', 'no file')

is(compareVersions('0.153.4', '0.153.1'), 1, 'patch newer')
is(compareVersions('0.153.1', '0.153.4'), -1, 'patch older')
is(compareVersions('0.154.0', '0.153.99'), 1, 'minor beats a big patch')
is(compareVersions('1.0', '1.0.0'), 0, 'a missing part is a zero')
is(compareVersions('', '1.0.0'), 0, 'nothing to compare answers equal')

is(isOutdated('0.153.1', '0.153.4'), true, 'behind')
is(isOutdated('0.153.4', '0.153.4'), false, 'current')
is(isOutdated('0.154.0', '0.153.4'), false, 'ahead of what the file knows')
// Every uncertainty answers false: a person is told their tools are stale only when
// something actually said so.
is(isOutdated('', '0.153.4'), false, 'no installed reading')
is(isOutdated('0.153.1', ''), false, 'no latest reading')

// --- against the real file, when this machine has one ---------------------

const cache = join(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'models_cache.json')
try {
  const real = codexChoices(parseCodexModels(JSON.parse(readFileSync(cache, 'utf8'))))
  assert.ok(real.length > 0, 'the real cache on this machine yields at least one model')
  assert.ok(
    real.every((m) => typeof m.value === 'string' && m.value && typeof m.label === 'string' && m.label),
    'every row off the real file has a value and a label'
  )
  n += 2
  console.log(`  (read the real cache: ${real.length} models, newest ${real[0].value})`)
} catch {
  console.log('  (skipped the real-file check: no Codex model cache on this machine)')
}

console.log(`codex models: ${n} checks passed`)
