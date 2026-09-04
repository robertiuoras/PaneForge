// A path an agent printed becomes a link, spaces, `~` and a wrapped tail included.
import { strict as assert } from 'node:assert'
import { buildSync } from 'esbuild'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(realpathSync(tmpdir()), 'paneforge-pathlink-test')
mkdirSync(root, { recursive: true })
const load = async (entry, name) => {
  const out = join(root, `${name}.mjs`)
  buildSync({ entryPoints: [resolve(here, entry)], outfile: out, bundle: true, format: 'esm', platform: 'node' })
  return import(pathToFileURL(out).href + `?${Date.now()}`)
}
const { findPathTokens } = await load('../src/shared/pathToken.ts', 'pathToken')
const { resolveRevealTarget } = await load('../src/main/revealPath.ts', 'revealPath')

// The real line, from a chat reply pasted 2026-09-04; the CLI wrapped the file name onto
// the next row, so this row ends at `phone`.
const line =
  'Proof cut from three real clips, both treatments side by side, sent above: ~/Work/Client Files/Jacob P/_deliverables/Jacob - phone'
const tok = findPathTokens(line).find((t) => t.text.startsWith('~/'))
assert.ok(tok, 'a rooted run is a candidate')
const readings = [tok.text, ...(tok.alts ?? []).map((a) => a.text)]
assert.equal(readings[0], '~/Work/Client Files/Jacob P/_deliverables/Jacob - phone', 'longest reading first')
assert.ok(readings.includes('~/Work/Client Files/Jacob P/_deliverables/Jacob'), 'folder-with-space readings offered')

// Prose around an unrooted path still never becomes a candidate.
const prose = findPathTokens('Wrote docs/proposals/thing.pdf and moved on').map((t) => t.text)
assert.deepEqual(prose, ['docs/proposals/thing.pdf'])

// A wrapped tail reveals the deepest folder that exists. Built under a fake home so the
// test never touches the real one: resolveRevealTarget reads `~` off os.homedir(), so the
// same shape is proved with an absolute root instead.
const deliver = join(root, 'Work', 'Client Files', 'Jacob P', '_deliverables')
mkdirSync(deliver, { recursive: true })
writeFileSync(join(deliver, 'Jacob - phone clips full frame comparison.mp4'), '')
const front = `${root}/Work/Client Files/Jacob P/_deliverables/Jacob - phone`
const hit = resolveRevealTarget(root, front)
// resolve() on both: the reveal joins with '/', a Windows temp root carries '\\'.
assert.equal(resolve(hit?.abs ?? ''), resolve(deliver), 'the front of a wrapped path reveals its folder')
assert.equal(hit?.kind, 'dir')
const whole = resolveRevealTarget(root, `${front} clips full frame comparison.mp4`)
assert.equal(whole?.kind, 'file', 'the whole path is the file')
assert.equal(resolveRevealTarget(root, `${root}/nowhere/at all.ts`), null, 'nothing below root exists: no link')
assert.equal(resolveRevealTarget(root, `${root}/nowhere/planned.ts`), null, 'a spaceless missing path is not a link')
console.log('pathlink: 9 ok')
