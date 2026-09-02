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

console.log('unwrap copy: 16 assertions passed')
