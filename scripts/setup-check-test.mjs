// The Welcome screen's "Get set up" checklist over realistic fact sets. Pins that the
// card disappears the moment nothing is missing, that Windows gets its own Git row
// (ahead of Claude, since Claude Code's own install advice wants Git in place first
// so the CLI gets a Bash tool from the start), and that an API key counts as signed in
// exactly like an oauthAccount would.
//
//   node scripts/setup-check-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-setup-check-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'setupCheck.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/setupCheck.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { setupRows } = createRequire(import.meta.url)(out)

// Codex present and signed in: the cases below are about the Claude/Git rows.
const CODEX_OK = { codexInstalled: true, codexSignedIn: true }

let checks = 0
const is = (actual, expected, what) => {
  assert.deepEqual(actual, expected, what)
  checks++
}
const ok = (cond, what) => {
  assert.ok(cond, what)
  checks++
}

// Nothing installed, on a Mac: no Git row (not Windows), Claude then sign-in.
is(
  setupRows({ platform: 'darwin', claudeInstalled: false, gitInstalled: false, signedIn: false, ...CODEX_OK }).map((r) => r.id),
  ['claude', 'signin'],
  'mac, nothing installed'
)

// Claude installed but not signed in: only the sign-in row.
is(
  setupRows({ platform: 'darwin', claudeInstalled: true, gitInstalled: false, signedIn: false, ...CODEX_OK }).map((r) => r.id),
  ['signin'],
  'claude installed, not signed in'
)

// Everything present: no rows at all, so the card is gone.
is(
  setupRows({ platform: 'darwin', claudeInstalled: true, gitInstalled: true, signedIn: true, ...CODEX_OK }),
  [],
  'all good -> no rows'
)

// An ANTHROPIC_API_KEY counts as signed in exactly like an oauthAccount would - the
// fact-gatherer folds both into one boolean before this function ever runs.
is(
  setupRows({ platform: 'linux', claudeInstalled: true, gitInstalled: true, signedIn: true, ...CODEX_OK }),
  [],
  'api key counts as signed in'
)

// Windows, nothing installed: Git comes BEFORE Claude.
is(
  setupRows({ platform: 'win32', claudeInstalled: false, gitInstalled: false, signedIn: false, ...CODEX_OK }).map((r) => r.id),
  ['git', 'claude', 'signin'],
  'windows, nothing installed - git first'
)

// Windows with git already there: no git row, same order otherwise.
is(
  setupRows({ platform: 'win32', claudeInstalled: false, gitInstalled: true, signedIn: false, ...CODEX_OK }).map((r) => r.id),
  ['claude', 'signin'],
  'windows without git installed does not show git row when git IS installed'
)

// Windows missing only git (Claude installed and signed in already).
is(
  setupRows({ platform: 'win32', claudeInstalled: true, gitInstalled: false, signedIn: true, ...CODEX_OK }).map((r) => r.id),
  ['git'],
  'windows, git missing only'
)

// Mac never shows the Windows-only git row even when git itself is missing.
ok(
  !setupRows({ platform: 'darwin', claudeInstalled: true, gitInstalled: false, signedIn: true, ...CODEX_OK }).some((r) => r.id === 'git'),
  'git row is windows-only'
)

// Codex rows exist, but only as `optional` - the Welcome checklist drops them so a
// Claude-only person is never nagged; the first-run card reads them.
const noCodex = setupRows({ platform: 'darwin', claudeInstalled: true, gitInstalled: true, signedIn: true, codexInstalled: false, codexSignedIn: false })
is(noCodex.map((r) => [r.id, r.optional]), [['codex', true]], 'codex missing -> one optional install row')
is(
  setupRows({ platform: 'darwin', claudeInstalled: true, gitInstalled: true, signedIn: true, codexInstalled: true, codexSignedIn: false }).map((r) => [r.id, r.optional]),
  [['codex-signin', true]],
  'codex installed, not signed in -> optional sign-in row'
)
// Not installed means no sign-in row too: a sign-in for a program that is not there cannot be done.
ok(!noCodex.some((r) => r.id === 'codex-signin'), 'no codex sign-in row while codex is missing')
ok(
  setupRows({ platform: 'win32', claudeInstalled: false, gitInstalled: false, signedIn: false, codexInstalled: false, codexSignedIn: false })
    .filter((r) => !r.optional)
    .map((r) => r.id)
    .join() === 'git,claude,signin',
  'dropping optional rows gives back exactly the old checklist'
)

console.log(`setup-check-test: ${checks} checks passed`)
