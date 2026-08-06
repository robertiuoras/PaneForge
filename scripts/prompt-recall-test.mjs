// "You have asked this before" - the fingerprint and the archive around it.
//
//   node scripts/prompt-recall-test.mjs
//
// Two things are being pinned here, and only one of them is ordinary.
//
// The ordinary half is the archive: record an ask, ask again later, get told. The cases
// that matter are the ones where it must say NOTHING - filler, a retry two minutes later,
// an unrelated prompt in the same repo - because a feature that interrupts wrongly is one
// people switch off, after which it protects nobody.
//
// The other half is parity. `src/shared/promptKey.ts` is a fourth copy of an algorithm that
// already lives in Robert's `claude-memory` hook, the TaskDriver archive server and the
// Discord bot, and those three share one prompt archive. If any copy drifts, the archive
// silently splits into archives that never see each other's entries - no error, no symptom,
// just a "have we done this?" that quietly stops finding things. So this recomputes the
// canonical file's answers and asserts ours agree, and when that file is not on the machine
// it SKIPS OUT LOUD rather than passing quietly, because a silent skip is exactly how the
// two would drift apart unobserved.

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tsc = (await import('typescript')).default

let n = 0
const ok = (what, cond) => {
  n++
  assert.ok(cond, what)
}
const eq = (what, a, b) => {
  n++
  assert.deepEqual(a, b, `${what}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`)
}

function transpile(rel) {
  const src = readFileSync(join(root, rel), 'utf8')
  return tsc.transpileModule(src, {
    compilerOptions: { target: tsc.ScriptTarget.ES2022, module: tsc.ModuleKind.CommonJS }
  }).outputText
}

/** Load a TS module with a `require` we control, so `electron` can be a stub. */
function load(rel, requires) {
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', transpile(rel))(
    (id) => {
      if (requires[id]) return requires[id]
      // node: builtins are real - the archive genuinely reads and writes files here.
      return require$(id)
    },
    mod,
    mod.exports
  )
  return mod.exports
}

const { createRequire } = await import('node:module')
const require$ = createRequire(import.meta.url)

const promptKey = load('src/shared/promptKey.ts', {})

// ─── 1. the fingerprint itself ──────────────────────────────────────────────────────────

const { promptTokens, promptMatch, MIN_PROMPT_TOKENS, NEAR_MATCH, STRONG_MATCH } = promptKey

// The pair the whole design exists for: same ask, different sentence.
const a = promptTokens('fix the githublinks pagination bug')
const b = promptTokens('the githublinks pagination is broken, fix it')
ok('a reworded ask still matches', promptMatch(a, b) >= NEAR_MATCH)

// Stemming is what makes that work, so it is pinned rather than left to luck.
eq(
  'paginate/pagination/paginated collapse to one token',
  [
    promptTokens('paginate widgets')[0],
    promptTokens('pagination widgets')[0],
    promptTokens('paginated widgets')[0]
  ],
  ['pagin', 'pagin', 'pagin']
)

// Two unrelated jobs in the same repo share vocabulary and must NOT match. This is the
// failure that would make the feature cry wolf on every prompt.
ok(
  'unrelated work in the same repo does not match',
  promptMatch(
    promptTokens('add a dark mode toggle to the settings dialog'),
    promptTokens('the release workflow is uploading the wrong installer')
  ) === 0
)

// Filler is below the floor, so it can never be recorded or matched.
ok('"yes do it" is filler', promptTokens('yes do it').length < MIN_PROMPT_TOKENS)
ok('"continue please" is filler', promptTokens('continue please').length < MIN_PROMPT_TOKENS)

// A three-word ask must not match an essay that happens to contain those words.
ok(
  'a short ask does not match a long one that contains it',
  promptMatch(
    promptTokens('fix the pagination'),
    promptTokens(
      'while you are in there, the pagination on the links page is off by one, the header ' +
        'sorting drops the secondary key, the empty state renders twice on a cold load, and ' +
        'the footer count disagrees with the table on the last page of every project'
    )
  ) === 0
)

ok('the thresholds are ordered', NEAR_MATCH < STRONG_MATCH && STRONG_MATCH <= 1)

// ─── 2. parity with the canonical copy ──────────────────────────────────────────────────
//
// See the header. This is the assertion that stops four copies of one algorithm becoming
// four different algorithms.

const canonical = join(homedir(), 'Projects/claude-memory/claude-config/prompt-key.mjs')
if (!existsSync(canonical)) {
  console.log(
    `SKIPPED parity: no canonical prompt-key.mjs at ${canonical}.\n` +
      '  This machine cannot check that src/shared/promptKey.ts still agrees with the\n' +
      '  shared prompt archive. That is fine on a machine that has no such archive, and\n' +
      '  it is NOT fine on one that does - the two drift apart in silence.'
  )
} else {
  const ref = await import(`file://${canonical}`)
  const corpus = [
    'fix the githublinks pagination bug',
    'the githublinks pagination is broken, fix it',
    'add a dark mode toggle to the settings dialog',
    'why is the release workflow uploading the wrong installer',
    'set up stacked pull requests for the repo',
    'the stash keeps stealing focus when I drag it on the mac',
    'write a test for the prompt archive',
    'deploy the bot and check the logs',
    'REVIEW this diff: `const x = 1` and https://example.com/a/b?c=d',
    'C:\\Users\\Gamer\\Desktop\\Projects\\PaneForge please look at src/main/index.ts'
  ]
  for (const text of corpus) {
    eq(`tokens agree with the canonical copy for "${text.slice(0, 40)}"`, promptTokens(text), ref.promptTokens(text))
  }
  for (const x of corpus) {
    for (const y of corpus) {
      eq(
        `match score agrees with the canonical copy ("${x.slice(0, 24)}" vs "${y.slice(0, 24)}")`,
        Math.round(promptMatch(promptTokens(x), promptTokens(y)) * 1e9),
        Math.round(ref.promptMatch(ref.promptTokens(x), ref.promptTokens(y)) * 1e9)
      )
    }
  }
  console.log('parity with the canonical prompt-key.mjs: checked')
}

// ─── 3. the archive ─────────────────────────────────────────────────────────────────────

const work = join(tmpdir(), 'pf-prompt-recall-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const archive = load('src/main/promptArchive.ts', {
  electron: { app: { getPath: () => work } },
  // The same module object the assertions above ran against, so the two halves of this file
  // cannot be testing two different copies of the fingerprint.
  '../shared/promptKey': promptKey
})
const { priorPrompt, recordPrompt, resetPromptArchive } = archive

const HOUR = 60 * 60 * 1000
const later = () => Date.now() + 7 * HOUR

const ASK = 'fix the githublinks pagination bug in the links page'
const REWORD = 'the githublinks pagination on the links page is broken, please fix it'

ok('an empty archive answers nothing', priorPrompt(ASK, { now: later() }) === null)

recordPrompt(ASK, { project: 'githublinks', agent: 'claude' })

// The case the feature exists for.
const hit = priorPrompt(REWORD, { now: later() })
ok('a reworded repeat is found', hit !== null)
ok('the score clears the near threshold', hit.score >= NEAR_MATCH)
eq('it says which project it was asked in', hit.project, 'githublinks')
eq('it says which agent it was typed at', hit.agent, 'claude')
eq('it carries no outcome yet', hit.outcome, null)

// The case that decides whether anyone keeps the feature on. A repeat inside the quiet
// window is the same piece of work - a retry, a follow-up, a second go at something that
// just failed - and warning there is pure noise.
ok('the same ask minutes later is silent', priorPrompt(REWORD, { now: Date.now() }) === null)
ok(
  'the boundary belongs to the quiet window',
  priorPrompt(REWORD, { now: Date.now() + 6 * HOUR - 1000 }) === null
)

// Unrelated work in the same folder must stay silent.
ok(
  'an unrelated ask is not a repeat',
  priorPrompt('add a dark mode toggle to the settings dialog', { now: later() }) === null
)

// Filler is never recorded, so it can never be reported.
recordPrompt('yes do it', { project: 'githublinks' })
recordPrompt('continue', { project: 'githublinks' })
ok('filler is not archived', priorPrompt('yes do it', { now: later() }) === null)

// Asking the same thing again counts, rather than making a second row.
recordPrompt(ASK, { project: 'githublinks', agent: 'claude' })
resetPromptArchive()
const twice = priorPrompt(REWORD, { now: later() })
ok('the archive survives a reload from disk', twice !== null)
eq('a repeat increments the use count instead of adding a row', twice.uses, 2)

// ─── 4. an archive written by something else ────────────────────────────────────────────
//
// The point of this half: work done before the app was installed, or typed into a bare
// terminal, still answers. Read-only - we never write into a file another tool owns.

const foreign = join(work, 'foreign.jsonl')
writeFileSync(
  foreign,
  JSON.stringify({
    h: 'deadbeef',
    t: promptTokens('sort out the stacked pull request workflow for the repo'),
    x: 'sort out the stacked pull request workflow for the repo',
    o: 'PaneForge',
    a: 'codex',
    n: 3,
    f: new Date(Date.now() - 40 * 24 * HOUR).toISOString(),
    l: new Date(Date.now() - 40 * 24 * HOUR).toISOString(),
    out: 'PaneForge 1198da4 feat: stacked PRs'
  }) + '\n'
)

resetPromptArchive()
const ext = priorPrompt('set up the stacked pull request workflow for this repo', {
  extraArchives: [foreign],
  now: later()
})
ok('an ask answered in another tool is still found', ext !== null)
eq('it reports the agent it was typed at', ext.agent, 'codex')
eq('it hands back what the earlier ask produced', ext.outcome, 'PaneForge 1198da4 feat: stacked PRs')
eq('it carries the use count across', ext.uses, 3)

// A named archive that does not exist is normal, not an error: the path is kept in a config
// that syncs between two machines and only one of them has the file.
resetPromptArchive()
ok(
  'a missing external archive is ignored',
  priorPrompt(REWORD, { extraArchives: [join(work, 'nope.jsonl')], now: later() }) !== null
)

// A torn line from a kill mid-append must not take the rest of the archive with it.
writeFileSync(join(work, 'torn.jsonl'), '{"h":"x","t":["a"\n')
resetPromptArchive()
ok(
  'a torn external line does not break the lookup',
  priorPrompt(REWORD, { extraArchives: [join(work, 'torn.jsonl')], now: later() }) !== null
)

rmSync(work, { recursive: true, force: true })
console.log(`prompt recall: ${n} assertions passed`)
