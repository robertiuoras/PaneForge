/**
 * What reaches the clipboard when somebody copies a reply - checked against rows that
 * really came out of an agent, not against rows written to make the rules look right.
 *
 * The fixtures in `scripts/fixtures/` are terminal BUFFER rows, replayed out of real
 * session logs under `claude-orchestrator/history/` with a headless xterm (the same way
 * `renderer/src/termRender.ts` does it for the phone's text sheet). That matters: a
 * hand-typed fixture cannot contain the thing this file exists to remove - the composer
 * the CLI repaints under every answer, the rules fencing it, the status footer and the
 * spinner - because nobody types those by hand the way a terminal paints them.
 *
 * The failure being pinned is a copy that hands somebody an answer with a terminal wrapped
 * round it, and the opposite failure: a rule so eager it eats a line of the answer.
 */
import { strict as assert } from 'node:assert'
import { buildSync } from 'esbuild'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(mkdtempSync(join(tmpdir(), 'pf-replytext-')), 'replyText.mjs')
buildSync({
  entryPoints: [join(root, 'src/shared/replyText.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'neutral'
})
const { cleanReply, draftBlock, previewOf } = await import(pathToFileURL(out).href)

let n = 0
const ok = (what, cond) => {
  n++
  assert.ok(cond, what)
}
const eq = (what, a, b) => {
  n++
  assert.equal(a, b, `${what}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`)
}

// Split on either line ending and drop the trailing empty: these files are checked in, and
// on Windows git hands them back with CRLF, which would put a stray \r on the end of every
// fixture row and make every match below a different question.
const fixture = (name) =>
  readFileSync(join(root, 'scripts/fixtures', name), 'utf8')
    .split(/\r?\n/)
    .filter((l, i, all) => i < all.length - 1 || l !== '')

// ---------------------------------------------------------------------------
// The tail of a live pane: the last line of an answer, then everything the CLI
// draws under it. Every row below the prose is furniture and none of it is a reply.
const tail = fixture('reply-claude-tail.txt')
ok('the fixture really is a terminal tail', tail.length === 6)
const tailOut = cleanReply(tail)
ok(
  'the answer survives',
  tailOut.includes('install Gemini CLI, point it at') && tailOut.startsWith('  If it is just you')
)
ok('the rules fencing the composer are gone', !tailOut.includes('────'))
ok('the empty composer row is gone', !/^\s*❯\s*$/m.test(tailOut))
ok('the permission footer is gone', !tailOut.includes('bypass permissions on'))
// The custom status line is NOT dropped. It is not a shape this file knows, and the rule
// is that an unrecognised row is kept - a reader can delete a line, they cannot get one back.
ok('an unrecognised row is kept rather than guessed at', tailOut.includes('[CAVEMAN]'))
eq('nothing but the answer and the status line is left', tailOut.split('\n').length, 2)

// ---------------------------------------------------------------------------
// A whole answer, with the agent's own tool markers in it.
const body = fixture('reply-claude-body.txt')
const bodyOut = cleanReply(body)
ok('the fixture carries the markers', body.some((r) => /^\s*⏺/.test(r)) && body.some((r) => /⎿/.test(r)))
ok('no ⏺ marker reaches the clipboard', !bodyOut.includes('⏺'))
ok('no ⎿ marker reaches the clipboard', !bodyOut.includes('⎿'))
ok(
  'the content behind the marker does',
  bodyOut.includes('15,054 em dashes across claude-memory') &&
    bodyOut.includes('Shell cwd was reset to')
)
ok('the spinner line is gone', !/Worked for 42s/.test(bodyOut) && !/Brewed for/.test(bodyOut))
// `※ recap:` is not one of the shapes this file knows about, so it stays.
ok('an unknown glyph row is kept', bodyOut.includes('※ recap:'))
ok('no run of three blank rows survives', !/\n\n\n\n/.test(bodyOut))
ok('a paragraph break does survive', /\n\n/.test(bodyOut))
ok('nothing leaves with trailing whitespace', !/[ \t]\n/.test(bodyOut) && !/[ \t]$/.test(bodyOut))
const bodyRows = bodyOut.split('\n')
ok('it does not start or end blank', bodyRows[0].trim() !== '' && bodyRows[bodyRows.length - 1].trim() !== '')
// The point of all of it: most of the answer is still there.
ok('the answer is not gutted', bodyOut.split('\n').length > 30)

// ---------------------------------------------------------------------------
// A pane caught mid-turn: the braille spinner is on screen.
const working = fixture('reply-working-tail.txt')
ok('the fixture caught a spinner', working.some((r) => /[⠀-⣿]/.test(r)))
const workOut = cleanReply(working)
ok('the spinner row is gone', !/[⠀-⣿]/.test(workOut))
ok('the rows around it are not', workOut.includes('Examining Function Fields'))

// ---------------------------------------------------------------------------
// A boxed composer, which is the other shape a CLI draws.
const boxed = [
  'Robert',
  '',
  '╭─────────────────────────────────────╮',
  '│ ❯ what did you change                │',
  '╰─────────────────────────────────────╯',
  '  ? for shortcuts'
]
const boxOut = cleanReply(boxed)
eq('a boxed composer leaves only the answer', boxOut, 'Robert')

// A quoted command is NOT a composer: the row has words on it.
ok('a quoted shell line survives', cleanReply(['> npm run build']) === '> npm run build')
// A long paragraph opening on a spinner glyph is prose, not a spinner.
const prose = '✻ ' + 'a'.repeat(120)
eq('a long row starting on a spinner glyph is kept', cleanReply([prose]), prose)

// ---------------------------------------------------------------------------
eq('a preview is one short line', previewOf(bodyOut).length <= 48, true)
ok('a preview has no newline', !previewOf(bodyOut).includes('\n'))
eq('nothing readable previews as nothing', previewOf('\n  \n'), '')


// ---------------------------------------------------------------------------
// The footer rule is ANCHORED. `rowsOf` hands in unwrapped logical lines, so a sentence of
// an answer that quotes one of those phrases used to be dropped whole - the one drop this
// file says it must never make.
const quoting = [
  'The pane draws its own footer, so the row saying esc to interrupt is the CLI talking,',
  'and the same goes for the ? for shortcuts hint underneath it.'
]
const quoteOut = cleanReply(quoting)
ok('a sentence quoting the footer survives', quoteOut.includes('the row saying esc to interrupt is'))
ok('and so does the second one', quoteOut.includes('? for shortcuts hint underneath'))
eq('nothing was dropped', quoteOut.split('\n').length, 2)
// Short prose is the case the length cap alone cannot save: this row is well under the
// cap, and only the anchor keeps it.
const shortQuote = 'Press esc to interrupt it.'
eq('a short sentence quoting the footer survives', cleanReply([shortQuote]), shortQuote)
// The footer itself still goes.
eq('a real footer row is still dropped', cleanReply(['  esc to interrupt']), '')
eq('and one with its own furniture on it', cleanReply(['  ? for shortcuts · ctrl+t for todos']), '')

// ---------------------------------------------------------------------------
// The drafted message inside a reply - the part that gets pasted into Mail.
const withDraft = [
  '⏺ Here is the draft:',
  '',
  '  Hi Darren,',
  '',
  '  Yes, but only on LinkedIn.',
  '',
  'Want me to send it?'
]
eq(
  'the drafted message is the block alone',
  draftBlock(withDraft),
  'Hi Darren,\n\nYes, but only on LinkedIn.'
)
ok('the sentence before it is gone', !draftBlock(withDraft).includes('Here is the draft'))
ok('and the question after it', !draftBlock(withDraft).includes('Want me to send'))
eq('a reply with no drafted block offers nothing', draftBlock(['Just a plain answer.']), '')
// A revised draft: the LAST block is the one being asked for.
eq(
  'the newest draft wins',
  draftBlock(['  first go', '  at it', 'Revised:', '  second go', '  at it']),
  'second go\nat it'
)

console.log(`replytext: ${n} checks passed`)
