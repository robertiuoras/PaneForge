// Copying a paragraph out of a pane has to paste as a paragraph, and copying anything that
// is not prose has to come back byte for byte. Both halves are here, because the second is
// the one that makes the first safe to turn on by default.
//
//   node scripts/unwrap-copy-test.mjs

import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
// esbuild rather than a regex over the source: the file carries real generics now
// (`Map<number, number>`, `number[][]`), and the strip-the-annotations trick this used to
// do turned those into something that would not parse. The real source still runs.
const built = join(mkdtempSync(join(tmpdir(), 'pf-unwrap-')), 'unwrapCopy.mjs')
buildSync({
  entryPoints: [join(root, 'src/renderer/src/unwrapCopy.ts')],
  outfile: built,
  bundle: true,
  format: 'esm',
  platform: 'neutral'
})
const { unwrapForClipboard } = await import(pathToFileURL(built).href)

// Split on either line ending and drop the trailing empty - these files are checked in and
// git hands them back with CRLF on Windows.
const fixture = (name) =>
  readFileSync(join(root, 'scripts/fixtures', name), 'utf8')
    .split(/\r?\n/)
    .filter((l, i, all) => i < all.length - 1 || l !== '')
    .join('\n')

// A paragraph the CLI wrapped at 92 columns, which is what the reported bug looks like.
const wrapped = [
  'Here is the one-page summary you asked for. It sets out what changes for investment',
  'property from 1 July 2027, established against new build, with the two dates that decide',
  'which rules reach which property.',
  '',
  'One thing in it surprises most people, so it is worth saying up front. The negative',
  'gearing change is grandfathered by when you bought, so anything held or under contract',
  'before Budget night keeps it until you sell.',
].join('\n')
const out = unwrapForClipboard(wrapped)
assert.equal(out.split('\n\n').length, 2, 'the blank line between paragraphs must survive')
assert.equal(out.split('\n').length, 3, 'two paragraphs and the blank line, nothing else')
assert.ok(out.startsWith('Here is the one-page summary you asked for. It sets out'))
assert.ok(out.includes('investment property from 1 July 2027'), 'the wrap point must close up')
assert.ok(!out.includes('  '), 'joining must not double a space')

// A wrapped bullet list: the markers stay on their own lines, the continuation closes up.
const bullets = [
  '- Held or under contract before 7:30pm on 12 May 2026: negative gearing is safe until you',
  '  sell, and the capital gains change still reaches the gain you make after 1 July 2027.',
  '- Bought after that, established: negative gearing against salary goes on 1 July 2027, and',
  '  the capital gains change applies to it too from that same date onwards, in full.',
].join('\n')
const bulletOut = unwrapForClipboard(bullets)
assert.equal(bulletOut.split('\n').length, 4, 'an indented continuation is layout, not a wrap')
assert.equal(bulletOut, bullets, 'indented lines are left exactly as they were')

// Things that must come back untouched.
const code = [
  'export function unwrapForClipboard(text) {',
  '  if (!text || !text.includes("\\n")) return text',
  '  const lines = text.split("\\n")',
  '  return lines.join("\\n")',
  '}',
].join('\n')
assert.equal(unwrapForClipboard(code), code, 'code must never be reflowed')

const fenced = '```js\nconst a = 1\nconst b = 2\n```'
assert.equal(unwrapForClipboard(fenced), fenced, 'a fence disables the whole pass')

const table = [
  '| Bought                     | Established                        | New build          |',
  '|----------------------------|------------------------------------|--------------------|',
  '| Before 7:30pm 12 May 2026  | Losses still offset salary         | Offsets salary     |',
].join('\n')
assert.equal(unwrapForClipboard(table), table, 'table rows are their own lines')

const signature = ['Regards,', '', 'Robert', 'Property Investors Alliance', 'piateam.com.au'].join('\n')
assert.equal(unwrapForClipboard(signature), signature, 'short deliberate breaks are not wraps')

const box = ['┌────────────────────────────────────────────┐', '│ some pane chrome that is drawn, not written │', '└────────────────────────────────────────────┘'].join('\n')
assert.equal(unwrapForClipboard(box), box, 'box drawing is layout')

assert.equal(unwrapForClipboard('one line only'), 'one line only')
assert.equal(unwrapForClipboard(''), '')

// ---------------------------------------------------------------------------
// A drafted email, exactly as it arrived in Mail when Robert pasted a copy of one.
//
// Two things were wrong with it and both are in this file. The block carries the two-space
// left margin Claude Code draws around a draft, and only SOME of the wrapped rows carry it
// - so `BLOCK_START` read every one of those as its own block and nothing joined. And the
// paragraphs are three rows each, which the whole-selection "most rows are full" reading
// called not-prose because the greeting and the sign-off are one word.
const draft = fixture('reply-email-draft.txt')
const want = [
  'Hi Darren,',
  '',
  'Yes, but only on LinkedIn. It sells job title targeting; Meta stopped in 2022, so on Facebook you can only buy loose interest guesses.',
  '',
  'Physios, pharmacists and care workers are all clean on LinkedIn. Defence works but not many serving ADF are on there. The Nepalese one is not targetable as an ethnicity anywhere, so that part of his email is wrong.',
  '',
  'Good news is it costs us nothing to test. Your LinkedIn posts and graphics are already built, so it is the same offer with a different headline. Pick one and we run it for two weeks.',
  '',
  'Robert'
].join('\n')
assert.equal(unwrapForClipboard(draft), want, 'a drafted message pastes as the message')

// The control: a real indent is on EVERY row, so it is the author's and stays - and rows
// that read as code are never joined however they end.
const codeBlock = fixture('reply-code-block.txt')
assert.equal(unwrapForClipboard(codeBlock), codeBlock, 'a consistent indent is layout, not rendering')

// A signature is short deliberate breaks, and the lowercase domain under the company name
// is exactly the shape the sentence-continuation rule would join if it had no length floor.
assert.equal(
  unwrapForClipboard(['Property Investors Alliance', 'piateam.com.au'].join('\n')),
  ['Property Investors Alliance', 'piateam.com.au'].join('\n')
)

// A URL the terminal broke across two rows must come back as one link, with no space at the
// break. A space there is invisible in the paste and produces a link that 404s.
const link = [
  'Send her this link and she connects her own Gmail:',
  'https://app.taskdriver.ai/connect/report-email/Wi2CoTjd0nr8Ns5qxiLcQsjPBkazp5Hgo',
  'ERhr6uzAlU',
  'It expires in seven days.',
].join('\n')
assert.ok(
  unwrapForClipboard(link).includes(
    'https://app.taskdriver.ai/connect/report-email/Wi2CoTjd0nr8Ns5qxiLcQsjPBkazp5HgoERhr6uzAlU',
  ),
  'a wrapped URL must rejoin without a space',
)

// A line that merely ENDS with a link, followed by a new sentence, is not a wrap: the break
// is short of the wrap column, so the two rows stay apart.
const afterLink = ['See https://example.com/x', 'and then the next thing happens here.'].join('\n')
assert.ok(!unwrapForClipboard(afterLink).includes('/xand'), 'a short line must not glue')

// ...and the same wrap with ONE LONGER LINE ANYWHERE ELSE in the copy. This is the `%20`
// Robert reported on 2026-09-12: the ruler used to be the widest row in the whole
// selection, so a neighbouring sentence lifted it above the wrap column, the URL row read
// as "not full", and the break fell through to the prose join - which puts a space in the
// middle of the address, and `%20` in whatever opens it.
const withNeighbour = [
  'A much longer neighbouring line of prose that runs well past the wrap column here ok',
  'Open https://app.taskdriver.ai/connect/report-email/Wi2CoTjd0nr8Ns5qx',
  'iLcQsjPBkazp5HgoERhr6uzAlU and sign in there to approve the drafts today',
].join('\n')
const joinedNeighbour = unwrapForClipboard(withNeighbour)
assert.ok(
  joinedNeighbour.includes(
    'https://app.taskdriver.ai/connect/report-email/Wi2CoTjd0nr8Ns5qxiLcQsjPBkazp5HgoERhr6uzAlU',
  ),
  'a wrapped URL rejoins whatever else is in the selection',
)
assert.ok(!joinedNeighbour.includes('Ns5qx iLcQsj'), 'and no space lands at the break')

// A row ending in a URL that is joined by the PROSE rule closes with nothing too - a space
// is never right there, whatever decided the two rows belong together.
const proseJoin = [
  'The dashboard everybody uses now lives at https://app.taskdriver.ai/connect/report',
  'email/Wi2CoTjd0nr8Ns5qxiLcQsjPBkazp5HgoERhr6uzAlU which is where the drafts wait',
].join('\n')
assert.ok(
  unwrapForClipboard(proseJoin).includes('/connect/reportemail/Wi2CoTjd0nr8Ns5qx'),
  'a prose join over a URL tail uses no space either',
)

// A link long enough to take THREE rows. The middle row carries no `https://`, so the test
// for "this row ends inside an address" said no about the row deepest inside it, and the
// prose join put a space there - the `%20` still arriving from Codex and antigravity panes,
// whose frames are narrower and so break a link into more pieces (Robert, 2026-09-17).
const threeRow = [
  'The signed report link for this run is https://app.taskdriver.ai/connect/report-email',
  '/Wi2CoTjd0nr8Ns5qxiLcQsjPBkazp5HgoERhr6uzAlUq9vTbNmKx4JfGh2DpWcYs7ZeRtLu6AoIn3Bv',
  'Ey8QkXdCfHjMgPzNrTwUaSbVl0 and it stops working after seven days have gone by ok',
].join('\n')
const threeOut = unwrapForClipboard(threeRow)
assert.ok(
  threeOut.includes(
    'https://app.taskdriver.ai/connect/report-email/Wi2CoTjd0nr8Ns5qxiLcQsjPBkazp5HgoERhr6uzAlUq9vTbNmKx4JfGh2DpWcYs7ZeRtLu6AoIn3BvEy8QkXdCfHjMgPzNrTwUaSbVl0',
  ),
  'a URL wrapped over three rows rejoins with no space anywhere in it',
)
assert.ok(!/Bv Ey8Qk/.test(threeOut), 'and no space lands at the second break')

// ...and a link the CLI printed inside brackets. The scheme is hard against the bracket, so
// the "a URL starts here" test - which wanted whitespace or the line start in front of it -
// read the row as ordinary prose and broke the address the same way.
const bracketed = [
  'Open the report (https://app.taskdriver.ai/connect/report-email/Wi2CoTjd0nr8Ns5qxiL',
  'cQsjPBkazp5HgoERhr6uzAlU) before the end of the week please, it expires after that',
].join('\n')
assert.ok(
  unwrapForClipboard(bracketed).includes('Ns5qxiLcQsjPBkazp5Hgo'),
  'a bracketed URL rejoins without a space too',
)

// The reading has to STOP at the end of the address: a row glued on that carries a space of
// its own ends the link, so the row after it is ordinary prose and keeps its space.
const endsThenProse = [
  'Grab it from https://app.taskdriver.ai/connect/report-email/Wi2CoTjd0nr8Ns5qxiLcQsj',
  'PBkazp5HgoERhr6uzAlU today because the sign-in window closes at the end of the week',
  'and nobody can reopen it for her once that has happened, so it is worth doing now.',
].join('\n')
const tail = unwrapForClipboard(endsThenProse)
assert.ok(tail.includes('week and nobody'), 'prose after the address keeps its space')

console.log('unwrap copy: 25 assertions passed')
