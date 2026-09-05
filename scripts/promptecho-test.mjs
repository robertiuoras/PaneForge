// npm run test:promptecho
//
// Reading a submitted prompt back out of a pane's own output, so a reopened pane gets its
// rail tags back. The positive cases are real lines captured off a live Claude Code pane on
// Windows 2026-08-18; the negatives are the half that decides whether the rail stays
// readable, because a false tag buries the real ones.

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-promptecho-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const outfile = join(work, 'promptecho.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/promptEcho.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { promptEcho, seedPrompts, completedSlash } = createRequire(import.meta.url)(outfile)

// Captured verbatim, trailing padding included - the terminal pads every row to the pane's
// width, and a reader written against a trimmed line passes here and finds nothing live.
assert.equal(
  promptEcho('❯ what is 2+2                                                              '),
  'what is 2+2'
)
assert.equal(
  promptEcho('❯ print the numbers 1 to 120 one per line, no commentary                   '),
  'print the numbers 1 to 120 one per line, no commentary'
)

// The live composer draws the same marker INSIDE its box. Tagging that would put a tag on
// the row somebody is typing into, which moves every time they type.
assert.equal(promptEcho('│ ❯ still typing this one'), '', 'a framed composer line is not a sent prompt')
assert.equal(promptEcho('  │ ❯ still typing'), '', 'indented frame too')

// `>` is a quote, a diff, a shell prompt and a markdown blockquote in an ANSWER. None of
// them are prompts, and there are far more of them than there are prompts.
assert.equal(promptEcho('> quoted text from the answer'), '', 'a plain > is never a prompt')
assert.equal(promptEcho('>> nested quote'), '')
assert.equal(promptEcho('PS C:\\Users\\Gamer> npm test'), '', 'a shell prompt is not a prompt echo')

// Nothing worth a tag.
assert.equal(promptEcho('❯ y'), '', 'a single character is a menu key')
assert.equal(promptEcho('❯'), '')
assert.equal(promptEcho('❯    '), '')
assert.equal(promptEcho(''), '')
assert.equal(promptEcho('the answer mentioned ❯ in the middle'), '', 'the marker must start the line')

// Codex replays a submitted ask with › (not Claude's ❯). The marker is agent-specific,
// so tool output quoting a chevron in another pane cannot grow a rail tag.
assert.equal(promptEcho('› fix the historical session tags                                 ', 'codex'), 'fix the historical session tags')
assert.equal(promptEcho('› fix the historical session tags', 'claude'), '', 'a Codex echo is not read from a Claude pane')
assert.equal(promptEcho('❯ fix the historical session tags', 'codex'), '', 'a Claude echo is not read from a Codex pane')
assert.equal(promptEcho('› Ask Codex to do anything', 'codex'), '', 'the empty Codex composer placeholder is not a prompt')
assert.equal(promptEcho('› y', 'codex'), '', 'a Codex menu key is not a prompt')

// ---------------------------------------------------------------------------------------
// The WIRING, as a source assertion.
//
// Everything above is the reader. What the reader is worth depends entirely on something
// calling it, and a mirrored pane called nobody: its screen arrives from the other device
// as one `buffer` frame, which reaches the renderer as a pane reset - not as the disk
// replay `seedMarks` was written for - so the rail was empty on every mirrored pane while
// this file, the suite and the typecheck all stayed green. That is exactly the shape
// `test:desk`'s last block exists for, so it is pinned the same way.
const pane = readFileSync(join(root, 'src/renderer/src/components/TerminalPane.tsx'), 'utf8')
const reset = pane.slice(pane.indexOf('api.onPaneReset('))
const body = reset.slice(0, reset.indexOf('\n    const off = api.onData('))
assert.ok(body.length > 100 && body.length < 2000, 'could not isolate the pane-reset handler')
assert.ok(
  body.includes('seedMarks()'),
  'the pane-reset handler must seed the rail: it is the only place a MIRRORED pane ever gets its prompts'
)
assert.ok(
  /list\.splice\(0\)/.test(body) && body.includes('marker.dispose()'),
  'it must drop the old tags first - they point into the buffer reset threw away, and seedMarks refuses on a non-empty rail'
)
assert.ok(
  body.indexOf('marker.dispose()') < body.indexOf('seedMarks()'),
  'the drop has to come before the seed, or the seed refuses'
)

console.log('promptecho: ok')


// A whole replayed SCREEN, not one row at a time - these rows are copied out of this
// desk's own `history/s18-*.log` rendered through a real xterm (2026-08-24). Read one row
// at a time they yield FOUR tags for one ask, three of them wrong, which is the rail being
// wrong rather than empty. Robert: "when i open history and the previous session i cant
// see the tags next to scroll bar ... refine that better so its more accurate to the
// prompt in the right place".
{
  const RULE = '\u2500'.repeat(60)
  const screen = [
    'ok    onestash       0.1s',
    // The start of an echo painted over a finished test run - no blank row above it, and
    // what follows the marker is that run's own output.
    '\u276f aok    stash         21.3s',
    '     ... +12 lines (ctrl+o to expand)' + RULE,
    '  (gtimeout 6m 40s)' + RULE,
    '',
    // A torn repaint: a half-typed earlier keystroke, with the block's rule on the row
    // below it.
    '\u276f also when i epen historymasd the previous session i cant see the tags next to scroll bar which',
    ' refine that better so its more ' + RULE,
    '',
    // The ask itself, drawn once...
    '\u276f also when i open history and the previous session i cant see the tags next to scroll bar which',
    ' refine that better so its more        ',
    '  accurate to the prompt in the right place',
    '',
    'some answer',
    '',
    // ...and again, lower down, which is the copy still in the right place.
    '\u276f also when i open history and the previous session i cant see the tags next to scroll bar which',
    ' refine that better so its more        ',
    ''
  ]
  const seeded = seedPrompts(screen)
  assert.equal(seeded.length, 1, 'one ask on the screen is one tag')
  assert.equal(seeded[0].line, 14, 'and it is the LAST copy of it, not the first')
  assert.ok(seeded[0].text.startsWith('also when i open history'), seeded[0].text)

  // CONTROL: row by row - what shipped - the same screen is four tags.
  const naive = screen.filter((r) => promptEcho(r)).length
  assert.equal(naive, 4, 'CONTROL: reading each row on its own tags four times')
}

// A scrubbed shape from the full Mac history rendered at 155 columns: the submitted
// Codex prompt begins with › and its body wraps over terminal rows. The tag is one prompt
// at the first row, not a tag for the current empty composer or for quoted chevrons.
{
  const screen = [
    'tool output quoted › no tag here',
    '',
    { text: '› can you see session five and keep this whole request ', wrapped: false, background: 235 },
    { text: 'together including the wrapped continuation', wrapped: true },
    '',
    'assistant reply',
    '',
    '› Ask Codex to do anything'
  ]
  const seeded = seedPrompts(screen, 'codex')
  assert.deepEqual(seeded, [{ line: 2, text: 'can you see session five and keep this whole request together including the wrapped continuation' }], 'a Codex replay seeds its wrapped submitted prompt once')
}

// The same scrubbed shape through a real xterm buffer. Codex paints the submitted line
// with background colour 235 and a long prompt wraps into buffer rows; the seed still
// gets one label at the first row. This is intentionally synthetic, never a saved prompt.
try {
  const { Terminal } = createRequire(import.meta.url)('@xterm/headless')
  const t = new Terminal({ cols: 42, rows: 10, scrollback: 100, allowProposedApi: true })
  const write = (text) => new Promise((resolve) => t.write(text, resolve))
  const ask = 'can you keep the complete wrapped Codex prompt on one accurate rail tag'
  await write(`\r\n\x1b[48;5;235m› ${ask}\x1b[0m\r\nassistant reply\r\n› Ask Codex to do anything`)
  const b = t.buffer.active
  const rows = []
  for (let i = 0; i < b.length - 1; i++) {
    const line = b.getLine(i)
    rows.push({ text: line?.translateToString(true) ?? '', wrapped: Boolean(line?.isWrapped), background: line?.getCell(0)?.getBgColor() })
  }
  const seeded = seedPrompts(rows, 'codex')
  assert.equal(seeded.length, 1, 'the xterm fixture produces one Codex tag')
  assert.equal(seeded[0].text, ask, 'the xterm fixture joins wrapped rows into the submitted ask')
  t.dispose()

  // The exact false-positive shape: an unfinished draft has the same › and colour as a
  // completed prompt, but its wrapped first row sits before the cursor. `active` is what
  // seedMarks derives from the composer containing that cursor.
  const draft = new Terminal({ cols: 42, rows: 10, scrollback: 100, allowProposedApi: true })
  const draftText = 'this is an unfinished multiline Codex draft which must never become a rail tag'
  await new Promise((resolve) => draft.write(`\r\n\x1b[48;5;235m› ${draftText}\x1b[0m`, resolve))
  const db = draft.buffer.active
  const draftRows = []
  let draftStart = -1
  for (let i = 0; i < db.length; i++) {
    const line = db.getLine(i)
    const text = line?.translateToString(true) ?? ''
    if (text.startsWith('› ')) draftStart = i
    draftRows.push({ text, wrapped: Boolean(line?.isWrapped), background: line?.getCell(0)?.getBgColor(), active: draftStart >= 0 && i >= draftStart })
  }
  assert.deepEqual(seedPrompts(draftRows, 'codex'), [], 'an active wrapped Codex composer is never seeded')
  draft.dispose()

  const quote = new Terminal({ cols: 42, rows: 8, scrollback: 100, allowProposedApi: true })
  await new Promise((resolve) => quote.write('\r\n› a tool quoted this chevron without Codex prompt colour', resolve))
  const qb = quote.buffer.active
  const quotedRows = []
  for (let i = 0; i < qb.length; i++) {
    const line = qb.getLine(i)
    quotedRows.push({ text: line?.translateToString(true) ?? '', wrapped: Boolean(line?.isWrapped), background: line?.getCell(0)?.getBgColor() })
  }
  assert.deepEqual(seedPrompts(quotedRows, 'codex'), [], 'an uncoloured tool chevron is never seeded')
  quote.dispose()
  console.log('promptecho xterm: 4 ok')
} catch {
  console.log('promptecho xterm: SKIPPED - @xterm/headless is not installed')
}


// ---- completedSlash: a slash tag reads what the CLI ran, off its own echo ----------
// Measured 2026-09-02 in this desk's history logs: 34 rows of `❯ /model`, none of `❯ /mode`.
{
  const rows = ['', '  ❯ /model', '', '  ⎿  Exited /model command']
  assert.equal(completedSlash('/mode', rows), '/model', 'the echoed command completes the typed token')
  assert.equal(completedSlash('/model', rows), '/model', 'an exact echo settles the tag')
  assert.equal(completedSlash('/mode', ['', 'still painting']), null, 'no echo yet: keep waiting')
  assert.equal(completedSlash('/mode', ['', '  ❯ /clear']), null, 'another command\'s echo is not this tag')
  assert.equal(completedSlash('/mode', ['', '  ❯ /model opus']), '/model opus', 'arguments come with it')
  assert.equal(completedSlash('hello', ['', '  ❯ /model']), null, 'a prose prompt never adopts a slash echo')
  assert.equal(completedSlash('/', ['', '  ❯ /model']), null, 'a lone slash is a menu key, not a token')
  assert.equal(completedSlash('/mode', ['  │ ❯ /model']), null, 'the live composer box is not an echo')
  assert.equal(completedSlash('/mode', ['', '› /model'], 'codex'), '/model', 'a Codex slash echo settles a Codex tag')
  assert.equal(completedSlash('/mode', ['', '› /model']), null, 'a Codex slash echo does not affect Claude')
  console.log('completedSlash: 10 ok')
}
