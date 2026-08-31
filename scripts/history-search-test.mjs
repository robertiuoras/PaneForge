// Which past sessions a History query finds.
//
//   node scripts/history-search-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-history-search-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const out = join(work, 'historySearch.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/historySearch.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { namesSession, rankBy } = createRequire(import.meta.url)(out)

let checks = 0
const ok = (cond, what) => {
  assert.ok(cond, what)
  checks++
}

const rows = [
  { id: 'a', title: 'Pizzasrus', cwd: '/Users/r/Projects/clients', gist: 'chase the invoice' },
  { id: 'b', title: 'toolstash', cwd: '/Users/r/Projects/toolstash', gist: 'repo triage' },
  { id: 'c', title: 'clients', cwd: '/Users/r/Projects/clients/pizzasrus', gist: 'menu photos' }
]

// The reason this file exists: a session is found by the name on its card, with nothing
// in its transcript. This returned NOTHING before.
ok(namesSession(rows[0], 'pizzasrus'), 'found by title')
ok(namesSession(rows[2], 'pizzasrus'), 'found by folder')
ok(namesSession(rows[1], 'triage'), 'found by what was asked')
ok(!namesSession(rows[1], 'pizzasrus'), 'a session it does not name is not a match')
ok(!namesSession(rows[0], 'p'), 'one character is not a search')

const none = () => 0
ok(rankBy(rows, 'pizzasrus', none).map((r) => r.id).join('') === 'ac', 'only the ones it names')
ok(rankBy(rows, 'p', none).length === 3, 'too short to filter: the whole list')
ok(rankBy(rows, '', none).length === 3, 'nothing typed: the whole list')

// A transcript match still counts, and a NAME match outranks it however many lines the
// other one printed.
const loud = (id) => (id === 'b' ? 40 : 0)
ok(rankBy(rows, 'pizzasrus', loud).map((r) => r.id).join('') === 'acb', 'name beats 40 printed lines')
ok(rankBy(rows, 'zzz', loud).map((r) => r.id).join('') === 'b', 'transcript-only match is still found')

console.log(`history-search: ${checks} checks passed`)
