// Whether a pane opening in a folder Antigravity has never seen still opens on a question.
//
// The rules worth pinning are the REFUSALS: this writes into the CLI's own settings file,
// so a reading that says "write" when the file already answers means the file is rewritten
// on every launch, and a relative path in the list answers for nothing for ever.
//
//   node scripts/agy-trust-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-agy-trust-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

function load(entry, name) {
  const out = join(work, `${name}.cjs`)
  buildSync({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: out })
  return createRequire(import.meta.url)(out)
}

const { withTrusted, MAX_TRUSTED } = load('src/shared/agyTrust.ts', 'shared')
const { trustAgyWorkspace } = load('src/main/agyTrust.ts', 'main')

let checks = 0
const is = (got, want, why) => {
  assert.deepEqual(got, want, `${why}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`)
  checks++
}

// A new folder is added, and the list it was added to is kept.
is(withTrusted(['/a'], '/b'), ['/a', '/b'], 'a folder the file has not seen is added')
is(withTrusted(undefined, '/b'), ['/b'], 'a file with no list at all gets one')
is(withTrusted('nonsense', '/b'), ['/b'], 'a list that is not a list is replaced, not merged')

// ...and every reading that means "nothing to do" says so, so the file is not rewritten.
is(withTrusted(['/a', '/b'], '/b'), null, 'a folder already in the list writes nothing')
is(withTrusted(['/b/'], '/b'), null, 'a trailing separator is the same folder')
is(withTrusted(['/b'], '/b/'), null, '...from either side')
is(withTrusted([], ''), null, 'no folder is nothing to write')
is(withTrusted([], 'relative/path'), null, 'a relative path could never match a workspace')
is(withTrusted([], 'C:\\Users\\x'), ['C:\\Users\\x'], 'a Windows path is absolute')

// A parent being trusted is NOT taken as an answer: that would be a guess about how the
// CLI resolves a workspace, and guessing wrong leaves the prompt in place for ever.
is(withTrusted(['/a'], '/a/b'), ['/a', '/a/b'], 'a child of a trusted folder is still written')

// The list cannot grow for ever on a desk that makes worktrees.
const many = Array.from({ length: MAX_TRUSTED }, (_, i) => `/p${i}`)
const capped = withTrusted(many, '/new')
is(capped.length, MAX_TRUSTED, 'the list stops at its cap')
is(capped[capped.length - 1], '/new', '...keeping the newest folder')
is(capped[0], '/p1', '...and dropping the oldest')

// The disk half: other keys survive, and a missing file is a refusal rather than a
// settings file this app invented.
const file = join(work, 'settings.json')
writeFileSync(file, JSON.stringify({ toolPermission: 'always-proceed', trustedWorkspaces: ['/a'] }))
is(trustAgyWorkspace('/b', file), true, 'a new folder is written')
const after = JSON.parse(readFileSync(file, 'utf8'))
is(after.trustedWorkspaces, ['/a', '/b'], '...into the list the CLI reads')
is(after.toolPermission, 'always-proceed', '...leaving every other setting alone')
is(trustAgyWorkspace('/b', file), false, 'the same folder again writes nothing')
is(trustAgyWorkspace('/b', join(work, 'not-here.json')), false, 'no settings file means the CLI is not installed here')
writeFileSync(file, '{ broken')
is(trustAgyWorkspace('/c', file), false, 'a file that will not parse is left exactly as it was')
is(readFileSync(file, 'utf8'), '{ broken', '...byte for byte')

console.log(`agy-trust: ${checks} checks passed`)
