// Reading a pane's prompt box back without touching it.
//
// Two halves, because the failure modes are different. The string half holds real screens
// against `shared/composerRead.ts` - a framed Claude Code box, the borderless 2.1 one, a
// Codex draft, and the cases that must REFUSE: a plain shell, a boxed answer in the
// transcript, a pane mid-repaint. A refusal is not a bug here, it is the contract: a
// caller must be able to tell "I could not see it" from "nothing is typed", because
// confusing the two reports a lost draft as an empty box.
//
// The terminal half is the one that would have caught the original complaint. A pane's
// bytes are REPAINTS: the same composer is drawn a character at a time, so the last frame
// in the stream is the only true one. This writes a draft the way a CLI does - draw the
// box, then type into it one character per write - and proves the answer is the finished
// line rather than a letter of it, and that reading it changed nothing on screen.
//
// `node scripts/composer-read-test.mjs`

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-composer-read-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const outfile = join(work, 'composer.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/composerRead.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { readComposer } = require_(outfile)

let checks = 0
const check = (what, ok, detail) => {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` — ${detail}`}`)
}
const eq = (what, got, want) =>
  check(what, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

// ---------------------------------------------------------------- the drawn screens ---
// Real rows, padding and all. A composer is drawn to the full width of the box, so the
// trailing blanks below are load-bearing: they are what `inputEnd` trims, and a fixture
// written without them proves nothing about a live pane.
const PAD = (s, w = 52) => s + ' '.repeat(Math.max(0, w - s.length))

const BOXED = [
  'I have finished the change and pushed it.',
  '',
  '╭──────────────────────────────────────────────────╮',
  '│ > tax return for last year, where did I file it  │',
  '│   and what did it come to                        │',
  '╰──────────────────────────────────────────────────╯',
  '  ? for shortcuts'
]

let got = readComposer(BOXED, 4)
eq('a framed box gives both rows back', got?.text, 'tax return for last year, where did I file it\nand what did it come to')
eq('and counts them', got?.rows, 2)
eq('and says where it starts', got?.top, 3)

// Claude Code 2.1 draws no frame at all: a rule, `❯` and U+00A0, then rows indented two.
const NB = ' '
const RULE = '─'.repeat(52)
const BARE = [
  'Done - the badge now counts both machines.',
  '',
  RULE,
  PAD(`❯${NB}tax return for last year, where did I file it`),
  PAD('  and what did it come to'),
  RULE,
  '  ? for shortcuts'
]
got = readComposer(BARE, 4)
eq('the borderless composer reads the same', got?.text, 'tax return for last year, where did I file it\nand what did it come to')

// An empty box is an ANSWER, not a refusal - the pane is there and nothing is typed.
const EMPTY = [RULE, PAD(`❯${NB}`), RULE, '  ? for shortcuts']
got = readComposer(EMPTY, 1)
check('an empty box answers a reading, not null', got !== null)
eq('with nothing in it', got?.text, '')

// A prompt that is itself indented keeps its own indent: only the composer's own is cut.
const INDENTED = [RULE, PAD(`❯${NB}run this:`), PAD('      npm run build'), RULE]
eq('extra indentation survives', readComposer(INDENTED, 1)?.text, 'run this:\n    npm run build')

// ----------------------------------------------------------------------- refusals ---
// A plain shell draws no composer, and answering one would be the dangerous direction:
// a script would report a command somebody already ran as an unsent draft.
eq('a plain shell is refused', readComposer(['robert@mac PaneForge % npm run build', ''], 0), null)
eq('a bash prompt is refused', readComposer(['$ git status', ''], 0), null)

// A boxed paragraph in an ANSWER sits between two rules too. What keeps it out is the
// prompt marker on its first row - a paragraph carries none.
const QUOTED = [RULE, PAD('  it depends on which year you filed'), RULE, '']
eq('a boxed answer is not a composer', readComposer(QUOTED, 1), null)

// The caret has to be INSIDE the box. A cursor parked on the footer is a pane that has
// moved on, and reading the rows above it anyway is how a stale draft gets reported.
eq('a caret outside the box is refused', readComposer(BARE, 6), null)
eq('a caret past the rows is refused', readComposer(BARE, 99), null)

// -------------------------------------------------------------- through a terminal ---
// The half that matters: bytes, not rows.
let Terminal
try {
  ;({ Terminal } = require_('@xterm/headless'))
} catch {
  console.log(`composer read: ${checks} checks passed - SKIPPED the terminal half, @xterm/headless is not installed`)
  process.exit(0)
}

const mainFile = join(work, 'main.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/main/composerRead.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: mainFile
})
const { composerOf } = require_(mainFile)

const ESC = '\u001b'
const cols = 60
const rows = 12
// How a CLI actually paints: the transcript, then the box, then the draft arriving one
// keystroke at a time - each keystroke REDRAWING the row it is on. Stripping escapes out
// of this stream gives one line per character typed, which is exactly why a log cannot
// answer the question.
let raw = 'I have finished the change and pushed it.\r\n\r\n'
raw += `${'─'.repeat(cols)}\r\n`
raw += `❯${NB}\r\n`
raw += `${'─'.repeat(cols)}\r\n`
const typed = 'tax return for last year'
for (let i = 1; i <= typed.length; i++) {
  // Cursor to the draft row, clear it, redraw what is there so far, park the caret.
  raw += `${ESC}[4;1H${ESC}[2K❯${NB}${typed.slice(0, i)}`
}

const out = await composerOf(raw, cols, rows)
eq('a draft typed a character at a time reads as the whole line', out?.text, typed)
eq('and as one row', out?.rows, 1)

// Reading it must not change it: the same bytes answer the same thing twice, and the
// stream handed in is untouched. A read that wrote would be worse than no read at all.
const again = await composerOf(raw, cols, rows)
eq('reading twice answers the same', again?.text, typed)
eq('and leaves the bytes alone', raw.endsWith(typed), true)

// A pane with nothing typed yet, painted the same way, is an empty box and not a refusal.
const emptyRaw =
  `${'─'.repeat(cols)}\r\n❯${NB}\r\n${'─'.repeat(cols)}\r\n${ESC}[2;3H`
const emptyOut = await composerOf(emptyRaw, cols, rows)
check('an untouched box still answers', emptyOut !== null)
eq('with nothing typed', emptyOut?.text, '')

// No bytes at all is a pane that has printed nothing - nothing to read, and saying so.
eq('an empty stream is refused', await composerOf('', cols, rows), null)

console.log(`composer read: ${checks} checks passed`)
