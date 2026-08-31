// What a name typed into New session may become on disk.
//
// The half worth testing is the REFUSALS. This is the only path in the app where a
// sentence somebody typed reaches `mkdir`, so a name that can mean "somewhere else" -
// `../claude-memory`, `/etc`, `C:` - must produce no folder at all rather than a
// stripped-down one somewhere nobody asked for.
//
//   node scripts/project-name-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-project-name-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'projectName.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/projectName.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { folderNameFor, mayCreate, MAX_NAME } = createRequire(import.meta.url)(out)

let checks = 0
const is = (actual, expected, what) => {
  assert.equal(actual, expected, `${what}\n  got: ${JSON.stringify(actual)}`)
  checks++
}

is(folderNameFor('Car'), 'Car', 'a plain name is the folder')
is(folderNameFor('  Car  '), 'Car', 'trimmed')
is(folderNameFor('my new app'), 'my new app', 'spaces inside are fine')
is(folderNameFor('taskdriver.ai'), 'taskdriver.ai', 'a dot inside is a real project name here')

is(folderNameFor('../claude-memory'), '', 'no walking out of the projects root')
is(folderNameFor('a/b'), '', 'no separator')
is(folderNameFor('a\\b'), '', 'no windows separator')
is(folderNameFor('C:'), '', 'no drive letter')
is(folderNameFor('..'), '', 'not the parent itself')
is(folderNameFor('.'), '', 'not this folder')
is(folderNameFor('.claude'), '', 'a hidden folder would never appear in the list')
is(folderNameFor('Car'), '', 'no control characters')
is(folderNameFor('Car?'), '', 'no wildcard')
is(folderNameFor('Car.'), 'Car', 'a trailing dot is unopenable on windows')
is(folderNameFor('Car  '), 'Car', 'a trailing space likewise')
is(folderNameFor(''), '', 'nothing typed')

is(folderNameFor('x'.repeat(120)).length, MAX_NAME, 'capped')
is(mayCreate('C'), false, 'one character is not a project name')
is(mayCreate('Car'), true, 'offered')
is(mayCreate('/etc'), false, 'never offered for a path')
is(mayCreate('  '), false, 'never offered for whitespace')

console.log(`project-name: ${checks} checks passed`)
