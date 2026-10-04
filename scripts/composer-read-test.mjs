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
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
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

// ...except where Claude Code itself parks it. Past ~200k of context it draws a right-aligned
// `new task? /clear to save 204.2k tokens` row under its footer and leaves the caret on the
// empty row under THAT (2.1.286, pane s42 on 1 Oct: five rows below the closing rule). The
// box was unreadable for 77 minutes, so an unsent-draft flag that only an empty-box read
// could clear held a finished pane open until Robert came back.
const HINT = PAD('new task? /clear to save 204.2k tokens'.padStart(50))
const PARKED = [...BARE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)', HINT, '']
got = readComposer(PARKED, PARKED.length - 1)
eq('a caret parked under the footer reads the box above it', got?.text, 'tax return for last year, where did I file it\nand what did it come to')
eq('and says where the box starts', got?.top, 3)
eq('an empty box above a parked caret is an empty box', readComposer([RULE, PAD(`❯${NB}`), RULE, '  ? for shortcuts', HINT, ''], 5)?.text, '')
// Only footer rows (indented, or blank) may sit between the box and the caret, and the
// caret's own row must be empty: a shell prompt under a dead CLI's last screen, or reply
// text, is something else on screen now.
eq('a shell prompt under an old footer is refused', readComposer([...BARE, 'robert@mac PaneForge % '], 7), null)
eq('reply text under the box is refused', readComposer([...BARE, 'and then it printed this', ''], 8), null)
eq('a caret far below the box is refused', readComposer([...BARE, ...Array(9).fill('  .'), ''], 16), null)

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

// The real bytes: s42's last 48 KB before 11:56pm Thu (1 Oct), one frame boundary to the
// end, letters outside escape sequences replaced with x so no words of that session are
// kept - widths, rules, caret moves and frames are the CLI's own. 134x53, caret at col 2
// under the hint row. The composer is empty; this read null for the whole idle window.
const parked = readFileSync(join(root, 'scripts/fixtures/claude-hint-parked-caret.bin'), 'utf8')
const parkedOut = await composerOf(parked, 134, 53, 'claude')
check('s42 parked caret: the box is found', parkedOut !== null)
eq('s42 parked caret: and it is empty', parkedOut?.text, '')

// The real bytes of s54-musnckna (PC, Claude Code 2.1.288, 119x42, 2026-10-03 17:09Z): the
// start-up frames up to the moment the app gave up on its prompt, cut before anything typed.
// Claude paints its empty-box hint dim - first with cursor-forward between the words, then
// repainted with plain (not dim) spaces - and the caret parked before it. 0.8.233 read
// `Try "write a test for <filepath>"` as typed text, so the app's own unsent-draft flag
// never cleared. Both paints are an empty box; the same words typed by a person are not.
const startup = readFileSync(join(root, 'scripts/fixtures/claude-startup-placeholder.bin'), 'utf8')
const firstPaint = startup.slice(0, startup.indexOf(`${ESC}[8;42;118t`))
const readStartup = raw => composerOf(raw, 119, 42, 'claude')
check('s54 first paint (cursor-forward gaps) is a sane cut', firstPaint.length > 500 && firstPaint.includes(`${ESC}[2mTry${ESC}[1C`))
eq('s54 first paint: Claude\'s dim hint is an empty box', (await readStartup(firstPaint))?.text, '')
eq('s54 last paint (plain spaces between dim words): an empty box', (await readStartup(startup))?.text, '')
const typedOver = (words, caretCol) => `${startup}${ESC}[7;1H❯${NB}${words}${ESC}[K${ESC}[7;${caretCol}H`
eq('the same words typed by a person are a draft',
  (await readStartup(typedOver('Try "write a test for <filepath>"', 36)))?.text, 'Try "write a test for <filepath>"')
eq('a draft that starts with "Try" is a draft', (await readStartup(typedOver('Try again', 12)))?.text, 'Try again')
eq('a draft typed with Home pressed is still a draft', (await readStartup(typedOver('Try again', 3)))?.text, 'Try again')
eq('half-dim text is a draft',
  (await readStartup(`${startup}${ESC}[7;1H❯${NB}Try${ESC}[2m "write a test for <filepath>"${ESC}[22m${ESC}[K${ESC}[7;3H`))?.text,
  'Try "write a test for <filepath>"')

// No bytes at all is a pane that has printed nothing - nothing to read, and saying so.
eq('an empty stream is refused', await composerOf('', cols, rows), null)

// Native Codex 0.159: alternate screen, bold marker, dim hint, caret before the hint.
// The literal alone must never erase a genuine draft, including one with Home pressed.
const hint = 'Ask Codex to do anything'
const codexPaint = (text, style, caret = 2) =>
  `${ESC}[?1049h${ESC}[2J${ESC}[56;1H${ESC}[48;2;213;231;208m${ESC}[1m›${ESC}[22m ${style}${text}${ESC}[0m${ESC}[58;1H  GPT-6.1-Sol · 50% left${ESC}[56;${caret + 1}H`
const readCodex = raw => composerOf(raw, 73, 59, 'codex')
eq('native dim Codex hint with caret before it is an empty composer',
  (await readCodex(codexPaint(hint, `${ESC}[2m`)))?.text, '')
eq('the same words typed normally remain a draft even with the caret at the start',
  (await readCodex(codexPaint(hint, '')))?.text, hint)
eq('dim same-string text with a caret after it is preserved conservatively',
  (await readCodex(codexPaint(hint, `${ESC}[2m`, hint.length + 2)))?.text, hint)
eq('partially dim same-string text is not treated as a placeholder',
  (await readCodex(codexPaint(`A${ESC}[22m${hint.slice(1)}`, `${ESC}[2m`)))?.text, hint)
eq('other dim text at the start remains a draft',
  (await readCodex(codexPaint('Ask Codex to do anything else', `${ESC}[2m`)))?.text, 'Ask Codex to do anything else')
const repaintedHint = codexPaint(hint, `${ESC}[2m`) + codexPaint(hint, '')
eq('regular draft repaint replaces the earlier identical dim hint', (await readCodex(repaintedHint))?.text, hint)

// Exercise the renderer's actual reader: Codex now keeps its native composer in
// the alternate screen. A blanket alternate-screen refusal hid unsent drafts.
const promptFile = join(work, 'prompt.bundle.cjs')
buildSync({ absWorkingDir: root, entryPoints: ['src/shared/promptBox.ts'], bundle: true, format: 'cjs', platform: 'node', outfile: promptFile })
const { composerText } = require_(promptFile)
const paneSource = readFileSync(join(root, 'src/renderer/src/components/TerminalPane.tsx'), 'utf8')
const start = paneSource.indexOf('paneComposer.set(sessionId, () => {')
const end = paneSource.indexOf('\n    paneRepair.set', start)
assert.ok(start > 0 && end > start, 'renderer composer reader is present')
const register = new Function('t', 'agent', 'composerText', 'paneComposer', 'sessionId', paneSource.slice(start, end))
const terminal = new Terminal({ cols, rows, allowProposedApi: true })
await new Promise(resolve => terminal.write(`${ESC}[?1049h${ESC}[5;1H› keep this unsent draft${ESC}[7;1H  gpt-6.1-sol · 50% left${ESC}[5;25H`, resolve))
const readers = new Map()
register(terminal, 'codex', composerText, readers, 'native')
eq('native alternate-screen Codex draft is readable', readers.get('native')(), 'keep this unsent draft')
eq('reading preserves the native screen', terminal.buffer.active.type, 'alternate')
register(terminal, 'claude', composerText, readers, 'other')
eq('other alternate-screen applications are still refused', readers.get('other')(), null)
terminal.dispose()

// sessions:draft prefers this live renderer reader over main's replay reader. Exercise
// the same native hint fixtures through its actual registration, not a second parser.
const liveCodex = new Terminal({ cols: 73, rows: 59, allowProposedApi: true })
register(liveCodex, 'codex', composerText, readers, 'hint')
const liveRead = async raw => {
  await new Promise(resolve => liveCodex.write(raw, resolve))
  return readers.get('hint')()
}
eq('live screen reads the native dim hint as an empty composer',
  await liveRead(codexPaint(hint, `${ESC}[2m`)), '')
eq('live screen preserves identical normally typed words with Home pressed',
  await liveRead(codexPaint(hint, '')), hint)
eq('live screen preserves dim same-string text with the caret after it',
  await liveRead(codexPaint(hint, `${ESC}[2m`, hint.length + 2)), hint)
eq('live screen preserves partially dim same-string text',
  await liveRead(codexPaint(`A${ESC}[22m${hint.slice(1)}`, `${ESC}[2m`)), hint)
eq('live screen preserves other dim text with the caret at the start',
  await liveRead(codexPaint('Ask Codex to do anything else', `${ESC}[2m`)), 'Ask Codex to do anything else')
eq('live screen reads a regular repaint of the former hint as a real draft',
  await liveRead(repaintedHint), hint)
liveCodex.dispose()

// The live reader `pf composer` asks first, on the same real s54 bytes.
const liveClaude = new Terminal({ cols: 119, rows: 42, allowProposedApi: true })
register(liveClaude, 'claude', composerText, readers, 'claude-hint')
const liveClaudeRead = async raw => {
  await new Promise(resolve => liveClaude.write(`${ESC}[2J${ESC}[H${raw}`, resolve))
  return readers.get('claude-hint')()
}
eq('live screen: s54 first paint is an empty box', await liveClaudeRead(firstPaint), '')
eq('live screen: s54 last paint is an empty box', await liveClaudeRead(startup), '')
eq('live screen: the same words typed by a person are a draft',
  await liveClaudeRead(typedOver('Try "write a test for <filepath>"', 36)), 'Try "write a test for <filepath>"')
eq('live screen: a draft typed with Home pressed is a draft', await liveClaudeRead(typedOver('Try again', 3)), 'Try again')
liveClaude.dispose()

console.log(`composer read: ${checks} checks passed`)
