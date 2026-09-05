// A colour that names a token this app does not have is transparent, and says nothing.
//
// `var(--panel)` does not error, does not warn, and does not fall back: it resolves to
// nothing. `.pane-booting.over` carried `background: var(--panel)` - the card a restored
// pane draws over its own live output, whose comment says in as many words that it must
// have a background or it reads as one more row of the output it is sitting on. Measured
// in a headless copy on 2026-09-05: `backgroundColor: rgba(0, 0, 0, 0)`. The palette has
// `--surface`, `--surface-2` and `--surface-3`; it has never had `--panel`.
//
// So every token the stylesheet READS is checked against the two places a token can come
// from: `paletteFor` in shared/theme.ts, and a `--x:` declaration in the stylesheet
// itself. Anything else is a colour nobody will ever see.
//
//   node scripts/tokens-test.mjs

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')
const theme = readFileSync(join(root, 'src/shared/theme.ts'), 'utf8')

const known = new Set()
for (const m of theme.matchAll(/'(--[a-z0-9-]+)'\s*:/gi)) known.add(m[1])
// Written onto :root by hand rather than by the palette - the terminal's own two, and the
// stash's, are set where they are used.
for (const m of theme.matchAll(/setProperty\(\s*'(--[a-z0-9-]+)'/gi)) known.add(m[1])
// ...and anything the stylesheet declares for itself (`--pane-reserve`, `--fast`, ...).
for (const m of css.matchAll(/(^|[;{\s])(--[a-z0-9-]+)\s*:/gi)) known.add(m[2])
// ...and anything the renderer sets INLINE on an element, which is where a per-row colour
// like `--agent` comes from: it is not in the palette because it is not one colour.
for (const file of ['App.tsx', 'components/TerminalPane.tsx']) {
  const src = readFileSync(join(root, 'src/renderer/src', file), 'utf8')
  for (const m of src.matchAll(/'(--[a-z0-9-]+)'\s*[:\]]/gi)) known.add(m[1])
}
assert.ok(known.size > 30, `only ${known.size} tokens found - the reader is broken, not the css`)

const read = new Set()
for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) read.add(m[1])
assert.ok(read.size > 30, `only ${read.size} tokens read - the reader is broken, not the css`)

// A `var(--x, fallback)` is deliberate and answers itself, so only the bare ones matter.
const bare = new Set()
for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/gi)) bare.add(m[1])

const missing = [...bare].filter((t) => !known.has(t)).sort()
assert.equal(
  missing.length,
  0,
  `these resolve to nothing: ${missing.join(', ')} — the palette is paletteFor() in src/shared/theme.ts`
)

// The control: the trap itself, so a reader that has quietly stopped matching anything
// cannot pass this file by finding nothing wrong.
assert.ok(!known.has('--panel'), 'the palette still has no --panel')
assert.ok(known.has('--surface-2'), 'and it does have --surface-2')

console.log(`tokens: ${bare.size} read, ${known.size} declared, none missing`)
