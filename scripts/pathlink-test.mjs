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

const windowsDirectory = String.raw`C:\Users\Gamer\wrapped directory name`
assert.equal(findPathTokens(windowsDirectory)[0]?.text, windowsDirectory, 'Windows rooted directories preserve spaces without a file extension')

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
// A repo-relative path from a chat sitting in ANOTHER checkout still links (2026-09-10).
const projects = join(root, 'Projects')
const memory = join(projects, 'memory-a')
const stale = join(projects, 'memory-b')
const pane = join(projects, 'clients')
for (const dir of [memory, stale, pane]) mkdirSync(join(dir, 'shared'), { recursive: true })
writeFileSync(join(stale, 'shared', 'proof.png'), '')
writeFileSync(join(memory, 'shared', 'proof.png'), '')
// memory-a is written second, so it is the newer copy and the one the sentence means.
const away = resolveRevealTarget(pane, 'shared/proof.png', projects)
assert.equal(resolve(away?.abs ?? ''), resolve(join(memory, 'shared', 'proof.png')), 'the newest copy is the link')
assert.equal(away?.kind, 'file')
assert.equal(resolveRevealTarget(pane, 'shared/proof.png'), null, 'no projects folder handed in: no sweep')

// A bare filename is not swept for - too many checkouts hold one.
writeFileSync(join(memory, 'notes.md'), '')
assert.equal(resolveRevealTarget(pane, 'notes.md', projects), null, 'a bare filename is never swept for')
// ...and a `..` is never given to the sweep, which would let it climb out of every root
// it is tried against. Read from the pane itself it is an ordinary path and still links.
assert.ok(resolveRevealTarget(pane, '../memory-a/shared/proof.png', projects), 'a real ../ path from the pane still links')
assert.equal(resolveRevealTarget(pane, '../gone/shared/proof.png', projects), null, 'a ../ path is not swept for')

// A path relative to the pane's own CHECKOUT wins over every other folder, even a newer one.
mkdirSync(join(pane, '.git'), { recursive: true })
mkdirSync(join(pane, 'shared'), { recursive: true })
writeFileSync(join(pane, 'shared', 'proof.png'), '')
const deep = join(pane, 'src', 'x')
mkdirSync(deep, { recursive: true })
const own = resolveRevealTarget(deep, 'shared/proof.png', projects)
assert.equal(resolve(own?.abs ?? ''), resolve(join(pane, 'shared', 'proof.png')), "the pane's own repo wins")

console.log('pathlink: 15 ok')
