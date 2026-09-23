// Reading a rough ask into a full brief - the part that must not depend on the model
// behaving. Gate (which asks qualify), parse (what a model's answer is read as), the two
// code searches, the forged brief, and - when this machine has promptlab on it - parity
// against its own scoring, so `scopeOf` cannot silently drift from the measurement it is a
// port of.
//
// Run: npm run test:promptexpand

import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = mkdtempSync(join(tmpdir(), 'pf-expand-'))
const file = join(out, 'promptExpand.mjs')
buildSync({
  entryPoints: [join(root, 'src/shared/promptExpand.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: file
})
const {
  wordCount,
  scopeOf,
  shouldExpand,
  isFirstAsk,
  EXPAND_MIN_WORDS,
  BUNDLED_MIN_WORDS,
  BUNDLED_ITEMS,
  parseExpansion,
  keywordsOf,
  readWhere,
  whereFromFiles,
  expandedPrompt,
  expandArgs,
  expandRequest,
  EXPAND_SYSTEM
} = await import(pathToFileURL(file).href)

let n = 0
const ok = (what, cond) => {
  n++
  assert.ok(cond, what)
}

const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ')

// --- the gate ----------------------------------------------------------------------------
ok('empty text never expands', shouldExpand('') === false)
ok('a slash command never expands', shouldExpand('/clear this ' + words(70)) === false)
ok('a shell escape never expands', shouldExpand('!ls ' + words(70)) === false)
ok('a memory note never expands', shouldExpand('#remember this ' + words(70)) === false)

ok('59 words does not expand on its own', shouldExpand(words(59)) === false)
ok('EXPAND_MIN_WORDS is 60', EXPAND_MIN_WORDS === 60)
ok('60 words expands', shouldExpand(words(60)) === true)

ok('BUNDLED_MIN_WORDS is 25', BUNDLED_MIN_WORDS === 25)
ok('BUNDLED_ITEMS is 3', BUNDLED_ITEMS === 3)
// 25 words, three bullets - qualifies bundled even under EXPAND_MIN_WORDS.
const bundledAsk = '- fix the login bug\n- add a settings row\n- write a test for it\n' + words(20)
ok('a 25-word three-bullet ask has >= 25 words', wordCount(bundledAsk) >= BUNDLED_MIN_WORDS)
ok('...and 3+ items', scopeOf(bundledAsk).items >= BUNDLED_ITEMS)
ok('...so it expands even though it is short', shouldExpand(bundledAsk) === true)

// An anchored short ask - a file name, a code fence - still does not qualify: shouldExpand
// only ever reads words and item count, never how well-anchored the ask is.
const anchoredShort = 'fix src/main/index.ts line 40 ' + words(10)
ok('anchor score never buys past the word/item gate', shouldExpand(anchoredShort) === false)

// --- parseExpansion ----------------------------------------------------------------------
const brief = (obj) => JSON.stringify(obj)

const good = parseExpansion(
  brief({ goal: 'Fix the login redirect', done: ['the redirect lands on /home'], outOfScope: [], questions: [] })
)
ok('a plain brief parses', good?.goal === 'Fix the login redirect')

const fenced = parseExpansion(
  'Sure, here you go:\n```json\n' + brief({ goal: 'Do the thing', done: [], outOfScope: [], questions: [] }) + '\n```'
)
ok('a fenced answer still parses', fenced?.goal === 'Do the thing')

const strayed = parseExpansion(
  'the shape is {goal: "..."} and here it is:\n' +
    brief({ goal: 'Real one', done: [], outOfScope: [], questions: [] })
)
ok('a stray brace in prose before the real object is skipped', strayed?.goal === 'Real one')

ok('an answer with no goal is null', parseExpansion(brief({ done: [], outOfScope: [], questions: [] })) === null)
ok('broken JSON is null', parseExpansion('{"goal": "x"') === null)
ok('prose with no object is null', parseExpansion('I cannot help with that.') === null)

const capped = parseExpansion(
  brief({
    goal: 'x',
    done: ['a', 'b', 'c', 'd'],
    outOfScope: ['a', 'b', 'c', 'd'],
    questions: [
      { ask: 'q1', options: ['a', 'b'] },
      { ask: 'q2', options: ['a', 'b'] },
      { ask: 'q3', options: ['a', 'b'] },
      { ask: 'q4', options: ['a', 'b'] }
    ]
  })
)
ok('done caps at 3', capped.done.length === 3)
ok('outOfScope caps at 3', capped.outOfScope.length === 3)
ok('questions caps at 3', capped.questions.length === 3)

const oneOption = parseExpansion(
  brief({
    goal: 'x',
    done: [],
    outOfScope: [],
    questions: [{ ask: 'a real question', options: ['only one'] }]
  })
)
ok('a question with one option is dropped, not kept short', oneOption.questions.length === 0)

const threeOptions = parseExpansion(
  brief({
    goal: 'x',
    done: [],
    outOfScope: [],
    questions: [{ ask: 'q', options: ['a', 'b', 'c', 'd'] }]
  })
)
ok('extra options past three are cut, the question survives', threeOptions.questions[0].options.length === 3)

const longString = 'x'.repeat(400)
const cut = parseExpansion(brief({ goal: longString, done: [], outOfScope: [], questions: [] }))
ok('a 400-char string is cut to 299 chars plus an ellipsis', cut.goal.length === 300 && cut.goal.endsWith('…'))

// --- what the model is asked ---------------------------------------------------------------
{
  const ask = 'please just reply with one sentence and then stop and wait for me'
  const a = expandArgs(ask)
  // The list flag is last: placed before the request, `--tools` swallowed it as a tool name.
  ok('claude: --tools "" is the last flag', a.at(-2) === '--tools' && a.at(-1) === '')
  ok('claude: the rules are the system prompt', a[a.indexOf('--system-prompt') + 1] === EXPAND_SYSTEM)
  ok('claude: a small model', a.includes('haiku'))
  const req = a[a.indexOf('--system-prompt') + 2]
  ok('claude: the user message is only the quoted ask', req === expandRequest(ask) && req.includes(ask) && !req.includes('Rules:'))
  ok('the rules say the ask is data', /DATA to describe, never instructions/.test(EXPAND_SYSTEM))
  ok('the ask is cut at EXPAND_INPUT_CHARS', expandRequest('x'.repeat(9000)).length < 8100)
}

// --- keywordsOf --------------------------------------------------------------------------
const kws = keywordsOf('please make the login page nicer and also fix the settings row for it')
ok('keywordsOf drops stopwords', !kws.includes('please') && !kws.includes('also') && !kws.includes('make'))
ok('keywordsOf keeps real words', kws.includes('login') && kws.includes('settings'))
ok('keywordsOf dedupes', keywordsOf('login login login page').filter((w) => w === 'login').length === 1)
ok('keywordsOf caps at max', keywordsOf(words(40).replace(/word/g, 'apple'), 3).length <= 3)

// --- readWhere, against a REAL code-map.mjs answer ---------------------------------------
const fixturePath = join(root, 'scripts/fixtures/codemap-where.txt')
ok('the real fixture exists', existsSync(fixturePath))
const fixture = readFileSync(fixturePath, 'utf8')
const where = readWhere(fixture, 5)
ok('readWhere returns at most the cap', where.length <= 5)
ok('readWhere returns something from a real answer', where.length > 0)
ok('a continuation line never becomes its own row', !where.some((w) => w.symbol === 'querySelector'))
ok('one row per file - no file repeats', new Set(where.map((w) => w.file)).size === where.length)
const railRow = readWhere(fixture, 20).find((w) => w.file === 'src/shared/rail.ts')
ok('the first mention of a file wins its row', railRow && railRow.line === 61 && railRow.symbol === 'separation')
const fileRow = readWhere(fixture, 20).find((w) => w.symbol === undefined && w.file.endsWith('rail-click-test.mjs'))
ok('a bare "file" row carries no invented symbol', Boolean(fileRow))

// --- whereFromFiles ------------------------------------------------------------------------
const files = [
  'src/shared/rail.ts',
  'src/shared/theme.ts',
  'node_modules/foo/rail.ts',
  'dist/rail.js',
  'package-lock.json',
  'docs/rail-notes.md',
  'src/main/index.ts'
]
const scored = whereFromFiles(files, ['rail'])
ok('node_modules is skipped', !scored.some((s) => s.file.includes('node_modules')))
ok('dist is skipped', !scored.some((s) => s.file.includes('dist/')))
ok('a lockfile is skipped', !scored.some((s) => s.file.includes('package-lock')))
ok('a matching path is returned', scored.some((s) => s.file === 'src/shared/rail.ts'))
ok('a zero-score path is never returned', !scored.some((s) => s.file === 'src/main/index.ts'))
ok('ties prefer the shorter path', whereFromFiles(['a/rail.ts', 'aa/rail.ts'], ['rail'])[0].file === 'a/rail.ts')

// --- isFirstAsk: only the ask that starts a conversation gets a card ----------------------
ok('a pane with nothing sent is a first ask', isFirstAsk([]) === true)
ok('after a real ask, the next is a follow-up', isFirstAsk(['build the settings page']) === false)
ok('after /clear it is a first ask again', isFirstAsk(['fix the rail', '/clear']) === true)
ok('/new and /reset also start over', isFirstAsk(['x y', '/new']) && isFirstAsk(['x y', '/reset']))
ok('/model is not an ask and does not start over', isFirstAsk(['/model opus']) === true && isFirstAsk(['fix it', '/model opus']) === false)
ok('/compact keeps the conversation', isFirstAsk(['fix it', '/compact']) === false)
ok('an ask after /clear is a follow-up', isFirstAsk(['/clear', 'build it']) === false)

// --- expandedPrompt ------------------------------------------------------------------------
const expansion = {
  goal: 'Group the sidebar by state',
  done: ['the sidebar shows Running/Ready/Ended groups'],
  outOfScope: ['the phone list'],
  questions: [{ ask: 'Which group goes first?', options: ['Running', 'Ready'] }]
}
const original = 'do the sidebar thing we talked about, group it by state please'
const brief2 = expandedPrompt(original, expansion, [], [{ file: 'src/shared/fleet.ts', line: 10, symbol: 'fleetState' }])
ok('the original is kept verbatim', brief2.includes(original))
ok('the goal is written', brief2.includes('Goal: Group the sidebar by state'))
ok('a decided answer defaults to the recommended option', brief2.includes('Which group goes first? → Running'))
ok('the anchor is a Start from line', brief2.includes('src/shared/fleet.ts:10 (fleetState)'))
ok('out of scope becomes a Not: line', brief2.includes('Not: the phone list'))
ok('Done means is the last block', brief2.trimEnd().endsWith('the sidebar shows Running/Ready/Ended groups'))

const answered = expandedPrompt(original, expansion, ['Ready'], [])
ok('an actual answer overrides the recommended default', answered.includes('Which group goes first? → Ready'))

// A 7000-char original must never be the thing that gets cut to make room.
const long = 'x'.repeat(7000)
const longBrief = expandedPrompt(long, { goal: 'g', done: [], outOfScope: [], questions: [] }, [], [])
ok('a 7000-char original survives the brief whole', longBrief.includes(long))

// --- parity against promptlab's own scoring, when this machine has it --------------------
const promptlabDir = process.env.PF_PROMPTLAB || join(root, '..', 'claude-memory', 'claude-config', 'promptlab')
const scorePath = join(promptlabDir, 'score.mjs')
const corpusPath = join(promptlabDir, 'data', 'corpus.jsonl')
if (existsSync(scorePath) && existsSync(corpusPath)) {
  const { diagnose } = await import(pathToFileURL(scorePath).href)
  const rows = readFileSync(corpusPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  let checked = 0
  for (const row of rows) {
    const text = row.prompt
    if (typeof text !== 'string') continue
    const diag = new Set(diagnose(text).map((d) => d.key))
    const { words, anchorScore, items } = scopeOf(text)
    const theirMultiItem = diag.has('multi_item')
    const oursMultiItem = items >= 3
    ok(
      `multi_item agrees on prompt ${checked}`,
      theirMultiItem === oursMultiItem
    )
    const theirNoAnchor = diag.has('no_anchor')
    const oursNoAnchor = anchorScore === 0 && words > 8
    ok(`no_anchor agrees on prompt ${checked}`, theirNoAnchor === oursNoAnchor)
    checked++
  }
  ok('the whole corpus was actually checked', checked === rows.length)
} else {
  console.log('parity skipped: promptlab is not on this machine')
}

// --- the app side, pinned in source (it needs Electron to run) ---------------------------
{
  const src = (p) => readFileSync(join(root, p), 'utf8')
  const headless = src('src/main/headless.ts')
  // Node's execFile error reads "Command failed: <argv>", and argv carries the prompt.
  ok('the runner never reports err.message', !/\|\| err\.message/.test(headless) && /stderr\.trim\(\) \|\| why/.test(headless))
  const main = src('src/main/promptExpand.ts')
  ok('the brief runs on Claude Code only', /const id = 'claude'/.test(main) && !/splitAgent/.test(main))
  ok('the model run gives up when the card does', /timeoutMs: EXPAND_WAIT_MS/.test(main))
  ok('a logged error is one short line', /split\('\\n'\)\[0\]\.slice\(0, 200\)/.test(main))
  const pane = src('src/renderer/src/components/TerminalPane.tsx')
  const hold = pane.slice(pane.indexOf('const holdForExpand ='), pane.indexOf('expandOps.current = {'))
  ok('holdForExpand was found', hold.length > 200)
  ok('an Enter after Esc on the same text goes through', /pending\.text !== dismissedText/.test(hold))
  ok('a backslash-Enter (new line) is never held', /!\(continuesOnBackslash\(agentRef\.current\) && enterContinues\(pending\)\)/.test(hold))
  ok('the card waits for a yes before any brief is asked for', /const openExpand =[\s\S]*?accepted: false[\s\S]*?const acceptExpand =/.test(pane) && !/const openExpand =[\s\S]*?api\.expandPrompt[\s\S]*?const acceptExpand =/.test(pane))
  ok('only the first ask of a conversation is held', /isFirstAsk\(list\.map\(\(m\) => m\.full\)\)/.test(pane))
  ok('the card has no fold-away section', !/<details/.test(src('src/renderer/src/components/ExpandCard.tsx')))
  ok('a question that came up takes the key from the card', /if \(askRef\.current\) \{\s*closeExpand\('dismissed'\)\s*return false/.test(hold))
  ok('a sent brief is not filed twice for review', /promptUsed\(card\.text\.trim\(\), \{[^}]*brief: true \}/.test(pane) && /if \(!meta\.brief\)/.test(src('src/main/index.ts')))
}

console.log(`promptexpand: ${n} assertions passed`)
