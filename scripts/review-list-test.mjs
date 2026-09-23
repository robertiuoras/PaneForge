// The Review dialog is a list of finished sessions, not a stack of stats and a daily
// digest, and this is the part of it that can be proven without a window: which rows are
// worth showing, which of those still need a person, and the few words drawn on each row.
//
//   node scripts/review-list-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-review-list-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'reviewList.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/reviewList.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const require = createRequire(import.meta.url)
const { visibleReviews, filterReviews, firstLine, statusWord, ago } = require(out)

let checks = 0
const ok = (cond, what) => {
  assert.ok(cond, what)
  checks++
}
const is = (actual, expected, what) => {
  assert.deepEqual(actual, expected, what)
  checks++
}

const base = {
  id: '1', sessionId: 's1', nativeSessionId: 'n1', prompt: 'do the thing',
  report: 'did the thing', provider: 'claude', cwd: '/x', title: 'x', reportPath: '/x/r',
  createdAt: new Date().toISOString(), proof: 'measured'
}

// -------------------------------------------------------------- visibleReviews
{
  const rows = [
    { ...base, id: 'shell', provider: 'shell', kind: 'result', attention: false },
    { ...base, id: 'emptyclosed', kind: 'closed', prompt: '', attention: false },
    { ...base, id: 'slash', kind: 'closed', prompt: '/clear', attention: false },
    { ...base, id: 'ordinary', kind: 'result', attention: false }
  ]
  const visible = visibleReviews(rows).map((r) => r.id)
  is(visible, ['ordinary'], 'shell rows, empty-prompt closed rows and bare slash prompts are hidden; an ordinary result row is shown')
  console.log('review-list: hidden rows ok')
}

// -------------------------------------------------------------- filterReviews
{
  const rows = [
    { ...base, id: 'attn', kind: 'result', attention: true },
    { ...base, id: 'blocked', kind: 'blocked', attention: false },
    { ...base, id: 'decision', kind: 'decision', attention: false },
    { ...base, id: 'done', kind: 'result', attention: false },
    { ...base, id: 'closed', kind: 'closed', attention: false, prompt: 'a real prompt' }
  ]
  is(filterReviews(rows, 'needs').map((r) => r.id).sort(), ['attn', 'blocked', 'decision'], 'needs = attention, blocked or decision rows only')
  is(filterReviews(rows, 'done').map((r) => r.id).sort(), ['closed', 'done'], 'done = everything else')
  is(filterReviews(rows, 'all').map((r) => r.id).sort(), ['attn', 'blocked', 'closed', 'decision', 'done'], 'all = every row untouched')
  console.log('review-list: filters ok')
}

// -------------------------------------------------------------- statusWord
{
  is(statusWord({ kind: 'result', attention: true }), 'Needs you', 'a result still needing a person reads Needs you')
  is(statusWord({ kind: 'blocked', attention: false }), 'Blocked', 'a blocked row reads Blocked')
  is(statusWord({ kind: 'result', attention: false }), 'Done', 'a reviewed result reads Done')
  is(statusWord({ kind: 'closed', attention: false }), 'Closed', 'a closed pane reads Closed')
  console.log('review-list: statusWord ok')
}

// -------------------------------------------------------------- firstLine
{
  is(firstLine('  \n\nHello world\nmore'), 'Hello world', 'leading blank lines are skipped, only the first real line is kept')
  is(firstLine(''), '', 'an empty string has no first line')
  console.log('review-list: firstLine ok')
}

// -------------------------------------------------------------- ago
{
  const NOW = new Date(2026, 8, 15, 12, 0, 0).getTime()
  is(ago(NOW - 10_000, NOW), 'just now', 'under a minute reads just now')
  is(ago(NOW - 5 * 60_000, NOW), '5 min ago', 'minutes read as minutes')
  is(ago(NOW - 3 * 3_600_000, NOW), '3 h ago', 'hours the same calendar day read as hours')
  const yesterday = new Date(2026, 8, 14, 9, 0, 0).getTime()
  is(ago(yesterday, NOW), 'yesterday', 'the calendar day before today reads yesterday, not a large hour count')
  const older = new Date(2026, 8, 12, 9, 0, 0).getTime()
  ok(ago(older, NOW) !== 'yesterday' && !/ago$/.test(ago(older, NOW)), 'older than yesterday falls back to a plain date, e.g. Sep 12')
  console.log('review-list: ago ok')
}

// -------------------------------------------------------------- source assertions
{
  const dialog = readFileSync(join(root, 'src/renderer/src/components/ReviewDialog.tsx'), 'utf8')
  ok(dialog.includes('onReopen('), 'reopening a row calls the prop, not an inline start()')
  ok(dialog.includes('aria-expanded'), 'a row says whether it is expanded')
  ok(dialog.includes('ArrowDown'), 'arrow keys move focus between rows')
  ok(!dialog.includes('dailyReview'), 'the daily digest is gone')
  ok(!dialog.includes('review-metrics'), 'the old metrics strip is gone')
  ok(!dialog.includes('KIND_WORDS'), 'the automatic-actions section is gone')
  console.log('review-list: source assertions ok')
}

rmSync(work, { recursive: true, force: true })
console.log(`review-list: ${checks} checks passed`)
