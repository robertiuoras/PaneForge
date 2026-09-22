// The Claude picker grows the ids the installed CLI knows, and only the NEWER ones.
// Pure judgements plus one real read of this machine's CLI when it exists. `npm run test:claudemodels`.

import { strict as assert } from 'node:assert'
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const here = dirname(fileURLToPath(import.meta.url))
const load = async (file) => {
  const js = ts.transpileModule(readFileSync(resolve(here, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
}
const { claudeIdsIn, mergeClaudeModels, parseClaudeId } = await load('../src/shared/claudeCatalogue.ts')

// Bytes shaped like the real binary: dated snapshots, a prefix of a longer id, noise.
const bytes = 'x"claude-opus-5-5"\0claude-opus-4-1-20250805 claude-haiku-3-55 claude-fable-5 claude-fable-5-1,claude-sonnet-6 claude-opus-4-0'
const ids = claudeIdsIn(bytes).sort()
assert.deepEqual(ids, ['claude-fable-5', 'claude-fable-5-1', 'claude-opus-4-0', 'claude-opus-5-5', 'claude-sonnet-6'])
assert.equal(parseClaudeId('claude-opus-4-1-20250805'), null)

const curated = [
  { value: 'claude-opus-5', label: 'Opus 5' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1' },
  { value: 'opus', label: 'opus (alias)' }
]
const merged = mergeClaudeModels(curated, ids)
// Newer ones on top, labelled; retired generations and the bare fable prefix stay out.
assert.deepEqual(merged.slice(0, 2).map((m) => m.value), ['claude-opus-5-5', 'claude-sonnet-6'])
assert.equal(merged[0].label, 'Opus 5.5')
assert.equal(merged.length, curated.length + 2)
assert.ok(!merged.some((m) => m.value === 'claude-opus-4-0' || m.value === 'claude-fable-5'))
// Nothing new = the hand list, same array.
assert.equal(mergeClaudeModels(curated, ['claude-opus-5']), curated)
// A curated id is never duplicated.
assert.equal(mergeClaudeModels([...curated, { value: 'claude-opus-5-5', label: 'Opus 5.5' }], ids).filter((m) => m.value === 'claude-opus-5-5').length, 1)

// The real CLI on this machine, when there is one: its bytes must name the ids it launches.
const bin = join(homedir(), '.local', 'bin', 'claude')
if (existsSync(bin)) {
  const text = readFileSync(realpathSync(bin), 'latin1')
  const real = claudeIdsIn(text)
  assert.ok(real.includes('claude-opus-5'), 'installed CLI names claude-opus-5')
  console.log(`claude-models: real CLI names ${real.length} ids: ${real.sort().join(' ')}`)
} else console.log('claude-models: no installed CLI here, real read skipped')
console.log('claude-models: ok')
