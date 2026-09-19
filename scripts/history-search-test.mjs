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
const { namesSession, rankBy, scoreSession, wordScore, within, typoBudget } = createRequire(
  import.meta.url
)(out)

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

// ── the name on the card beats the same word buried in a folder path ───────────────────
ok(
  rankBy(rows, 'pizzasrus', none).map((r) => r.id)[0] === 'a',
  'the session CALLED it leads the one that only lives under it'
)

// ── a half-remembered word still finds it ──────────────────────────────────────────────
ok(typoBudget(3) === 0, 'three letters get no typo budget')
ok(typoBudget(5) === 1, 'a middling word may be one letter wrong')
ok(typoBudget(9) === 2, 'a long word may be two')
ok(within('pizasrus', 'pizzasrus', 1), 'one missing letter is the same word')
ok(!within('pizasrus', 'pizzasrus', 0), 'with no budget it is not')
ok(!within('cat', 'chat', 0), 'a short word is never fuzzy')
ok(namesSession(rows[0], 'pizasrus'), 'a typed name with a letter missing still finds it')
ok(namesSession(rows[1], 'toolstsah'), 'two letters swapped still finds it')
ok(!namesSession(rows[1], 'invoice'), 'close enough is not anything goes')

// ── a prefix is somebody who stopped typing ────────────────────────────────────────────
ok(namesSession(rows[0], 'pizza'), 'a prefix finds it')
ok(wordScore('pizza', 'pizzasrus') > wordScore('izzasr', 'pizzasrus'), 'a prefix beats the middle')
ok(wordScore('pizzasrus', 'pizzasrus') > wordScore('pizza', 'pizzasrus'), 'the whole word beats a prefix')
ok(wordScore('pizasrus', 'pizzasrus') > 0, 'a typo still scores')
ok(wordScore('pizza', 'pizzasrus') > wordScore('pizasrus', 'pizzasrus'), 'a prefix beats a typo')

// ── every word typed has to find something ─────────────────────────────────────────────
const asked = {
  id: 'd',
  title: 'PaneForge',
  cwd: '/Users/r/Projects/PaneForge',
  gist: 'fix the tunnel',
  chapters: ['fix the tunnel', 'research the repo for a diff viewer'],
  askLines: ['fix the tunnel', 'research the repo for a diff viewer', 'ship it']
}
ok(namesSession(asked, 'research repo'), 'both words found: a match')
ok(namesSession(asked, 'reserch repo'), 'both words found, one misspelt: still a match')
ok(!namesSession(asked, 'research pizzasrus'), 'a word that finds nothing drops the row')
ok(namesSession(asked, 'diff viewer'), 'found by an ask it never put in a chapter')
ok(namesSession({ ...asked, chapters: [], askLines: ['deploy the staging box'] }, 'staging'), 'asks are searched, not only the first one')

// A phrase that appears whole outranks the same words scattered about.
const scattered = { id: 'e', title: 'x', gist: 'research something', chapters: ['the repo'] }
ok(
  scoreSession(asked, 'research the repo') > scoreSession(scattered, 'research the repo'),
  'the whole phrase outranks the same words apart'
)

// Best first, not list order.
const ranked = rankBy([scattered, asked], 'research the repo', none).map((r) => r.id)
ok(ranked[0] === 'd', 'closest match comes back first')

console.log(`history-search: ${checks} checks passed`)
