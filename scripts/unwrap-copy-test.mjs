// Copying a paragraph out of a pane has to paste as a paragraph, and copying anything that
// is not prose has to come back byte for byte. Both halves are here, because the second is
// the one that makes the first safe to turn on by default.
//
//   node scripts/unwrap-copy-test.mjs

import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
// Same trick as grid-layout-test: strip the annotations and run the real source, so the
// test cannot drift from what the app imports.
const src = readFileSync(join(here, '..', 'src', 'renderer', 'src', 'unwrapCopy.ts'), 'utf8')
const js = src.replace(/: (string|number|boolean)(\[\])?/g, '').replace(/<(string|number)(\[\])?>/g, '')
const dir = join(tmpdir(), 'paneforge-unwrap-test')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const mod = join(dir, 'unwrapCopy.mjs')
writeFileSync(mod, js)
const { unwrapForClipboard } = await import(`file://${mod}`)

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

console.log('unwrap copy: 13 assertions passed')
