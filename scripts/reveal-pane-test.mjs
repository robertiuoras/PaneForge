// The pane's folder button opens the pane's OWN working folder, always - see
// shared/revealPane.ts. Robert, 2026-09-03: a lane pane with 141 untracked media files
// had its folder button open the trunk checkout instead, which has none of them.
//
//   node scripts/reveal-pane-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const OUT = join(ROOT, 'node_modules', '.pf-test')
mkdirSync(OUT, { recursive: true })
const outfile = join(OUT, 'reveal-pane.mjs')
buildSync({
  entryPoints: [join(ROOT, 'src/shared/revealPane.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node'
})
const { revealTargetFor, folderLabel } = await import(pathToFileURL(outfile).href)

const fail = []
const ok = (c, n) => {
  console.log((c ? 'PASS ' : 'FAIL ') + n)
  if (!c) fail.push(n)
}

// A pane in a lane copy - the case Robert hit: its own folder, not the trunk it climbs to.
ok(
  revealTargetFor({ cwd: '/Users/robert/Projects/clients-a', root: '/Users/robert/Projects/clients' }) ===
    '/Users/robert/Projects/clients-a',
  'a lane copy pane opens the copy, not the project it climbs to'
)

// A pane already in the main checkout - the copy IS the project, so nothing changes.
ok(
  revealTargetFor({ cwd: '/Users/robert/Projects/clients', root: '/Users/robert/Projects/clients' }) ===
    '/Users/robert/Projects/clients',
  'a main checkout pane opens the main checkout'
)

// A pane whose cwd is a subfolder of a lane copy - the subfolder is what it opens, never
// its parent lane and never the project two levels up.
ok(
  revealTargetFor({
    cwd: '/Users/robert/Projects/clients-a/clients/sonia',
    root: '/Users/robert/Projects/clients'
  }) === '/Users/robert/Projects/clients-a/clients/sonia',
  'a pane in a subfolder opens that subfolder'
)

// A session record with no cwd at all falls back to the project, so the button still
// opens something rather than nothing.
ok(
  revealTargetFor({ cwd: undefined, root: '/Users/robert/Projects/clients' }) ===
    '/Users/robert/Projects/clients',
  'a pane with no cwd on record falls back to the project'
)
ok(
  revealTargetFor({ cwd: '   ', root: '/Users/robert/Projects/clients' }) === '/Users/robert/Projects/clients',
  'a blank cwd counts as missing too'
)

// The tooltip names the folder that will actually open, before the click.
ok(folderLabel('/Users/robert/Projects/clients-a') === 'clients-a', 'the tooltip names the lane copy folder')
ok(
  folderLabel('/Users/robert/Projects/clients-a/clients/sonia') === 'sonia',
  'and the deepest folder when cwd is a subfolder'
)
ok(folderLabel('C:\\Users\\Gamer\\Projects\\clients-a') === 'clients-a', 'and reads a Windows path the same way')

// Proving the test can go red: flip the expectation once, see it fail, then restore it.
// revealTargetFor({ cwd: '/a', root: '/b' }) === '/b' would fail here - '/a' is right.
ok(revealTargetFor({ cwd: '/a', root: '/b' }) !== '/b', 'sanity: cwd beats root when both are present')

if (fail.length) {
  console.log(`\n${fail.length} failed`)
  process.exit(1)
}
console.log('\nall passed')
