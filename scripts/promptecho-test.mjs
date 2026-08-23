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
const { promptEcho } = createRequire(import.meta.url)(outfile)

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
