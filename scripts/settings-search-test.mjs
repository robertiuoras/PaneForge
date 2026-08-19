// Settings search: the index is generated from the dialog's own source, so the whole
// value of this test is the DRIFT check - a setting added without regenerating must turn
// this red rather than being quietly unfindable.
//
// The rest is the searching itself, and the weight is in the negatives: a query that
// matches nothing must say so, a second word must NARROW, and a word that only appears in
// a setting's explaining sentence must rank below one on the name itself.

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSettings, render } from './settings-index.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GENERATED = resolve(root, 'src/shared/settingsIndex.ts')

let failed = 0
function ok(name, cond, detail) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failed++
    console.log(`  FAIL ${name}${detail ? ' - ' + detail : ''}`)
  }
}

// --- the checked-in index agrees with the source -----------------------------------
const settings = readSettings()
const fresh = render(settings)
const onDisk = readFileSync(GENERATED, 'utf8')
ok(
  'the checked-in index matches the dialog source',
  fresh === onDisk,
  'run `npm run gen:settings` - a setting was added or reworded without regenerating'
)

ok('there are settings at all', settings.length > 50, `${settings.length} found`)

// A NUL byte makes a source file binary: git prints "Binary files ... differ" instead of a
// diff and grep skips it, so the next session cannot review or search the generator at all.
for (const f of ['settings-index.mjs', 'gen-settings-index.mjs', 'settings-search-test.mjs']) {
  const raw = readFileSync(resolve(root, 'scripts', f))
  ok(`scripts/${f} is text, not binary`, !raw.includes(0))
}

// Every tab the rail draws has at least one setting on it, or the search can send
// somebody to a page with nothing marked on it.
const TABS = ['general', 'appearance', 'sounds', 'agents', 'stash', 'voice', 'prompts', 'discord', 'system']
for (const tab of TABS) {
  ok(`tab ${tab} has settings indexed`, settings.some((s) => s.tab === tab))
}

// --- the search itself ---------------------------------------------------------------
// Loaded from the generated module by evaluating its function body: the file is TypeScript
// and this test may not need a compiler to run.
const src = readFileSync(GENERATED, 'utf8')
const body = src
  .replace(/export interface SettingEntry \{[\s\S]*?\n\}\n/, '')
  .replace(/export const SETTINGS: SettingEntry\[\]/, 'const SETTINGS')
  .replace(/export function findSettings\(query: string\): SettingEntry\[\]/, 'function findSettings(query)')
  .replace(/const scored: \{ entry: SettingEntry; score: number \}\[\] = \[\]/, 'const scored = []')
const findSettings = new Function(`${body}\nreturn findSettings`)()

const labels = (q) => findSettings(q).map((s) => s.label)

ok('an empty query hits nothing', findSettings('').length === 0)
ok('whitespace is not a query', findSettings('   ').length === 0)

const closeHit = findSettings('close a pane')
ok('"close a pane" finds the idle-close switch', closeHit.length > 0)
ok(
  '...and it is the FIRST hit, because every word is on its label',
  closeHit[0]?.label.toLowerCase().startsWith('close a pane'),
  closeHit[0]?.label
)
ok('...on the tab it is really drawn on', closeHit[0]?.tab === 'general', closeHit[0]?.tab)

// A hint is as often an expression as a literal, and reading only the literals dropped
// nine of them - so this asks for words that exist ONLY inside a template string or a
// keyLabel() call. 'telegram' would have passed against a broken parser: it is in a label.
ok('a word only in a literal hint finds the setting', labels('bot token').length > 0)
ok(
  'a word only in a TEMPLATE hint finds the setting',
  labels('190 mb').length > 0,
  'the ~190 MB an idle agent costs is only in hints built from a template'
)
ok(
  'a word only in a keyLabel() hint finds the setting',
  findSettings('shift+l').length > 0,
  'hint={keyLabel("... Ctrl+Shift+L ...")}'
)
ok(
  'most settings carry more than their own name',
  settings.filter((s) => s.find !== s.label).length > 30,
  `${settings.filter((s) => s.find !== s.label).length} have a hint`
)
ok('a nonsense query finds nothing', findSettings('zzzq nothing here').length === 0)

const wide = findSettings('pane')
const narrow = findSettings('pane telegram')
ok('a second word narrows rather than widens', narrow.length < wide.length && narrow.length > 0)

ok('search is case-insensitive', labels('CLOSE A PANE')[0] === closeHit[0]?.label)

// A reading in brackets is not part of a setting's name: the label is "Terminal font size"
// so that "font" finds it, and so the DOM's "Terminal font size (14px)" still prefix-matches.
const font = findSettings('font')
ok('"font" finds the font size setting', font.some((s) => /font size/i.test(s.label)), labels('font').join('|'))
ok(
  '...and its indexed label carries no live reading',
  font.every((s) => !/\d/.test(s.label)),
  font.map((s) => s.label).join('|')
)

// Ranking: a query on a label beats one that only matched the sentence underneath.
const hits = findSettings('desktop')
ok('a label hit outranks a hint-only hit', !hits.length || /desktop/i.test(hits[0].label), hits[0]?.label)

// Every entry is findable by its own name - the whole promise of the feature.
let unfindable = []
for (const s of settings) {
  const own = findSettings(s.label)
  if (!own.some((h) => h.label === s.label && h.tab === s.tab)) unfindable.push(`${s.tab}/${s.label}`)
}
ok('every setting is found by typing its own name', unfindable.length === 0, unfindable.slice(0, 5).join(' | '))

console.log(failed ? `\n${failed} failed` : '\nall ok')
process.exit(failed ? 1 : 0)
