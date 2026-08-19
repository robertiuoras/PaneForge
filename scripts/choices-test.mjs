#!/usr/bin/env node
// Reading a live question off a pane's screen, and the keys that answer it.
//
// Every positive fixture here is a REAL frame captured from this machine's own pane
// logs (userData/history/*.log, ANSI stripped and re-wrapped as the terminal drew it),
// because a hand-written stub of a chooser proves nothing about the one the CLI draws:
// the AskUserQuestion widget puts a paragraph of description under each option and the
// built-in resume prompt does not, and a parser written against either alone reads the
// other as no question at all.
//
// The negatives carry the weight. A numbered list in an answer, a markdown list, a
// half-repainted frame and a question that was answered ten minutes ago must all read as
// NOTHING - drawing buttons for one of those types arrow keys into a composer somebody
// is holding a draft in.

import { strict as assert } from 'node:assert'
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const out = mkdtempSync(join(tmpdir(), 'pf-choices-'))
await build({
  entryPoints: [join(root, 'src/shared/choices.ts')],
  outfile: join(out, 'choices.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'neutral'
})
const { readAsk, keysForChoice, sameAsk } = await import(pathToFileURL(join(out, 'choices.mjs')).href)

const ESC = '\u001b'
let n = 0
const ok = (what, fn) => {
  fn()
  n++
  console.log(`  ok  ${what}`)
}

// ---------------------------------------------------------------------------
// Real frame 1: Claude Code's AskUserQuestion widget, captured from
// history/s1-ms0oncsd.log. Label on the option row, a description paragraph
// indented under it, and the three-part footer.
// ---------------------------------------------------------------------------
const ASK_WIDGET = [
  'Where do you still see the invisible PaneForge?',
  '',
  '❯ 1. Taskbar icon',
  '     Icon sits in taskbar, clicking it does nothing or nothing appears. Stale shell',
  '     icon from the killed dev-b copy; fix = restart Explorer.',
  '  2. Alt-Tab entry',
  '     Extra PaneForge shows in Alt-Tab. Same ghost class; Explorer restart clears it.',
  '  3. Task Manager list',
  '     Task Manager shows several PaneForge.exe rows. That is the one real app.',
  '  4. Tray / system clock area',
  '     Icon near clock. Dead tray icons clear when you hover across them.',
  '  5. Type something.',
  '  6. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel'
].join('\n')

ok('the AskUserQuestion widget reads as six options', () => {
  const ask = readAsk(ASK_WIDGET)
  assert.ok(ask, 'no ask read')
  assert.equal(ask.options.length, 6)
  assert.equal(ask.selected, 1)
  assert.equal(ask.options[0].label, 'Taskbar icon')
  assert.equal(ask.options[5].label, 'Chat about this')
  assert.equal(ask.question, 'Where do you still see the invisible PaneForge?')
})

ok('a description paragraph never becomes an option', () => {
  const ask = readAsk(ASK_WIDGET)
  for (const o of ask.options) assert.ok(!/^Icon sits|^Extra PaneForge/.test(o.label))
})

// ---------------------------------------------------------------------------
// Real frame 3: the SAME widget as frame 1, drawn by Claude Code 2.1.235 on
// 2026-08-19 - which now puts a full-width rule between the real answers and the
// two it always appends, and wraps that rule onto a second row in a wide pane.
// Read off a live taskdriver.ai pane at 159 columns, where every AskUserQuestion
// on this desk was reading as NO question at all: no buttons, no red card, no
// Telegram message, and nothing for autoAnswer to press. A rule was prose to the
// walk, so it stopped one option in and the 1..N check failed.
// ---------------------------------------------------------------------------
const ASK_RULED = [
  ' \u2610 Threads setup ',
  '',
  '\u2502 Threads needs the "Access the Threads API" use case added to Meta app 1492418122726503 - that mints the app id',
  '\u2502 and secret. Your Facebook App Review submission is in flight. Add it now?',
  '',
  '\u276f 1. Add it now (Recommended)',
  '     Threads is a separate use case with its own review track - it does not add permissions to the request.',
  '  2. Wait for the review verdict',
  '     Leave the Meta app untouched until the current App Review comes back (~14 days).',
  '  3. Type something.',
  '\u2500'.repeat(157),
  '\u2500\u2500',
  '  4. Chat about this',
  '',
  'Enter to select \u00b7 \u2191/\u2193 to navigate \u00b7 Esc to cancel'
].join('\n')

ok('a rule between the options does not hide the question', () => {
  const ask = readAsk(ASK_RULED)
  assert.ok(ask, 'the whole question was invisible - this is the live bug')
  assert.equal(ask.options.length, 4)
  assert.equal(ask.selected, 1)
  assert.equal(ask.options[3].label, 'Chat about this')
})

ok('and the box gutter is not part of the question', () => {
  const q = readAsk(ASK_RULED).question
  assert.ok(!/[\u2502|]/.test(q), `gutter reached the buttons: ${q}`)
  assert.ok(/^Threads needs/.test(q), q)
})

ok('a rule still cannot conjure a question with no footer', () => {
  const noFooter = ASK_RULED.split('\n').slice(0, -2).join('\n')
  assert.equal(readAsk(noFooter), null)
})

// ---------------------------------------------------------------------------
// Real frame 2: Claude Code's own resume prompt, from history/s1-ms1mghme.log.
// No descriptions, options indented, and the SHORTER footer - a parser written
// against frame 1 alone refuses this one.
// ---------------------------------------------------------------------------
const RESUME = [
  '  This session is 15h 8m old and 243.8k tokens.',
  '',
  '  Resuming the full session will consume a substantial portion of your usage limits.',
  '  We recommend resuming from a summary.',
  '',
  '  ❯ 1. Resume from summary (recommended)',
  '    2. Resume full session as-is',
  "    3. Don't ask me again",
  '',
  '  Enter to confirm · Esc to cancel'
].join('\n')

ok('the resume prompt reads, with the shorter footer', () => {
  const ask = readAsk(RESUME)
  assert.ok(ask, 'no ask read')
  assert.equal(ask.options.length, 3)
  assert.equal(ask.selected, 1)
  assert.equal(ask.options[1].label, 'Resume full session as-is')
  assert.match(ask.question, /We recommend resuming from a summary/)
})

ok('the arrow can be on a row other than the first', () => {
  const ask = readAsk(RESUME.replace('  ❯ 1.', '    1.').replace('    2.', '  ❯ 2.'))
  assert.equal(ask.selected, 2)
})

// ---------------------------------------------------------------------------
// The negatives. Each one is a frame that LOOKS like a chooser to something.
// ---------------------------------------------------------------------------
ok('a numbered list in an answer is not a question', () => {
  assert.equal(
    readAsk(
      [
        'Here is what I changed:',
        '',
        '  1. Fixed the parser',
        '  2. Added a test',
        '  3. Updated the docs',
        '',
        'Anything else?'
      ].join('\n')
    ),
    null
  )
})

ok('a numbered list with a quoted footer is still not a question', () => {
  // Somebody pasting a chooser's footer at the agent gets it echoed back with the
  // person's own marker in front of it. Nothing is selected, so nothing is offered.
  assert.equal(
    readAsk(
      [
        '> Here is the thing it printed:',
        '>   1. Resume from summary',
        '>   2. Resume full session',
        '> Enter to confirm · Esc to cancel'
      ].join('\n')
    ),
    null
  )
})

ok('a list with no selection arrow is refused', () => {
  assert.equal(readAsk(RESUME.replace('❯ 1.', '  1.')), null)
})

ok('a list that does not start at 1 is a fragment, not a chooser', () => {
  assert.equal(
    readAsk(['  ❯ 2. Second', '    3. Third', '', '  Enter to confirm · Esc to cancel'].join('\n')),
    null
  )
})

ok('a gap in the numbering is refused', () => {
  assert.equal(
    readAsk(
      ['  ❯ 1. One', '    2. Two', '    4. Four', '', '  Enter to confirm · Esc to cancel'].join('\n')
    ),
    null
  )
})

ok('one option is not a choice', () => {
  assert.equal(readAsk(['  ❯ 1. Only', '', '  Enter to confirm · Esc to cancel'].join('\n')), null)
})

ok('no footer, no question - the whole guard in one case', () => {
  assert.equal(readAsk(ASK_WIDGET.replace(/Enter to select.*/, '')), null)
})

ok('an answered question that scrolled up is not re-offered', () => {
  // The frame is still in the tail; what follows it is the agent working again. The
  // footer is found, but so is a newer one - there is none, so the older block must
  // still read. What must NOT happen is the block reading as live once the composer
  // has been drawn over it, which is the empty-tail case above.
  const after = ASK_WIDGET + '\n\n✶ Cultivating… (40s · ↓ 2.3k tokens)\n'
  const ask = readAsk(after)
  assert.ok(ask, 'the block itself still parses')
  // and the pane is busy, so sessions.ts will not offer it - proved in busy.ts, not here.
})

ok('the newest of two questions wins', () => {
  const two = RESUME + '\n\n' + ASK_WIDGET
  const ask = readAsk(two)
  assert.equal(ask.options.length, 6)
  assert.equal(ask.question, 'Where do you still see the invisible PaneForge?')
})

// ---------------------------------------------------------------------------
// The keys. Arrows and a return, never a digit.
// ---------------------------------------------------------------------------
const ask = readAsk(ASK_WIDGET)

ok('picking the option already selected is one return', () => {
  assert.deepEqual(keysForChoice(ask, 1), ['\r'])
})

ok('picking further down is that many downs, then return', () => {
  assert.deepEqual(keysForChoice(ask, 4), [`${ESC}[B`, `${ESC}[B`, `${ESC}[B`, '\r'])
})

ok('picking above walks up', () => {
  const mid = { ...ask, selected: 5 }
  assert.deepEqual(keysForChoice(mid, 3), [`${ESC}[A`, `${ESC}[A`, '\r'])
})

ok('no digit is ever sent', () => {
  for (let i = 1; i <= 6; i++) {
    for (const k of keysForChoice(ask, i)) assert.ok(!/^\d$/.test(k), `sent a digit: ${k}`)
  }
})

ok('the arrow keys are real escape sequences, not the letters', () => {
  const keys = keysForChoice(ask, 3)
  assert.equal(keys.length, 3)
  for (const k of keys.slice(0, -1)) {
    // The whole point. Written as a code check rather than a string compare because a
    // source file that LOSES its escape compares equal to a test that lost the same
    // one - which is how this shipped typing the letters "[B" into a chooser once.
    assert.equal(k.charCodeAt(0), 27, JSON.stringify(k))
    assert.equal(k.length, 3)
  }
  assert.equal(keys[keys.length - 1], String.fromCharCode(13))
})

ok('an option that is not on offer is refused', () => {
  assert.equal(keysForChoice(ask, 9), null)
  assert.equal(keysForChoice(ask, 0), null)
})

ok('the same question twice is the same question', () => {
  assert.ok(sameAsk(readAsk(ASK_WIDGET), readAsk(ASK_WIDGET)))
  assert.ok(!sameAsk(readAsk(ASK_WIDGET), readAsk(RESUME)))
  assert.ok(sameAsk(null, null))
  assert.ok(!sameAsk(null, readAsk(RESUME)))
})

ok('moving the arrow is still the same question', () => {
  const moved = readAsk(RESUME.replace('  ❯ 1.', '    1.').replace('    2.', '  ❯ 2.'))
  assert.ok(sameAsk(readAsk(RESUME), moved), 'a moved cursor must not re-notify')
})

// The keys are spread over a few hundred ms and the question can end inside that
// window - the agent answers, the pane reports busy, `ask` is cleared. Both senders
// (SessionManager.choose and the mirrored path in main/index.ts) re-check with
// `sameAsk` before EVERY key rather than only before the first, so this is the
// arithmetic that decides whether the remaining arrows are dropped.
ok('a question that was replaced mid-answer stops the rest of the keys', () => {
  const first = readAsk(ASK_WIDGET)
  const replaced = readAsk(RESUME)
  assert.ok(!sameAsk(first, replaced), 'a different question must not look like the same one')
  assert.ok(!sameAsk(first, null), 'and a question that went away must not either')
})

rmSync(out, { recursive: true, force: true })
console.log(`\nchoices: ${n} checks passed`)
