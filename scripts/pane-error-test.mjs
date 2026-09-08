// A pane that stopped, on the way to a phone.
//
// The decision is `shared/paneError.ts` and every rule in it is a refusal, so this suite is
// mostly refusals too. The three that matter:
//
//   1. the split with `recover.ts` holds in BOTH directions - a cut-off turn the app is
//      about to continue is never reported, and a cut-off turn stopped by a usage limit
//      (which recover refuses) always is. One regex serves both files, so a change to
//      either shows up here.
//   2. an agent's REPLY that says "rate limit" is prose, not a failure. This is the false
//      positive that would buzz a phone about a pane that is working fine.
//   3. a person quoting an error - in the composer, or echoed back after they submitted it
//      - is a question ABOUT an error, and paging about it is the app answering itself.
//
//   node scripts/pane-error-test.mjs

import { buildSync } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pf-paneerror-'))

buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/paneError.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: join(work, 'paneError.cjs')
})
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/recover.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: join(work, 'recover.cjs')
})
const req = createRequire(join(work, 'x.cjs'))
const P = req('./paneError.cjs')
const R = req('./recover.cjs')

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail !== undefined) console.log(`      ${detail}`)
  }
}

// ---- what is reported -------------------------------------------------------------

const cases = [
  ['a usage limit', 'API Error: Claude usage limit reached. Your limit will reset at 5pm.'],
  ['a credit balance', 'API Error: Your credit balance is too low to access the Anthropic API.'],
  ['a 429', 'API Error: 429 rate_limit_error - too many requests'],
  ['an auth failure', 'API Error: 401 authentication_error - invalid x-api-key'],
  ['a logged-out CLI', 'Error: Not logged in. Please run /login'],
  ['an overload', 'API Error: 529 overloaded_error - the model is overloaded']
]
for (const [what, line] of cases) {
  ok(`reports ${what}`, P.stoppedLine(`thinking...\n${line}\n`) === line)
}

ok(
  'quotes the line verbatim, never a summary of it',
  P.stoppedLine('API Error: Claude usage limit reached. Your limit will reset at 5pm.') ===
    'API Error: Claude usage limit reached. Your limit will reset at 5pm.'
)

ok(
  'reads the NEWEST stopping line, not the first one in the buffer',
  P.stoppedLine(
    'API Error: 429 rate_limit_error - too many requests\nback to work\nAPI Error: 401 authentication_error - invalid x-api-key\n'
  ) === 'API Error: 401 authentication_error - invalid x-api-key'
)

// ---- the split with recover.ts ----------------------------------------------------

const CUT = 'API Error: Connection closed mid-response. The response above may be incomplete.'
ok(
  'a cut-off turn recover will continue is NOT reported',
  P.stoppedLine(`writing the answer\n${CUT}\n`) === null,
  P.stoppedLine(`writing the answer\n${CUT}\n`)
)
ok('...and recover does take it', R.truncatedLine(`writing the answer\n${CUT}\n`) === CUT)

const CUT_LIMIT =
  'API Error: 429 rate_limit_error. The response above may be incomplete.'
ok('a cut-off turn stopped by a limit IS reported', P.stoppedLine(CUT_LIMIT) === CUT_LIMIT)
ok('...and recover refuses that same line', R.truncatedLine(CUT_LIMIT) === null)

ok(
  'a cut-off turn ends the read, so an older error is not blamed for it',
  P.stoppedLine(
    `API Error: 401 authentication_error - invalid x-api-key\nsigned in again\nfine\n${CUT}\n`
  ) === null
)

// ---- refusals ---------------------------------------------------------------------

ok(
  'an answer that TALKS about a rate limit is prose, not a failure',
  P.stoppedLine('I would add a retry here so a rate limit does not lose the batch.\n') === null
)
ok(
  'a stopping word with no report shape is not reported',
  P.stoppedLine('the billing page is at /account/usage limit settings\n') === null
)

const boxed = [
  '╭──────────────────────────────────────────╮',
  '│ > why did I get API Error: 429 rate_limit_error today  │',
  '╰──────────────────────────────────────────╯'
].join('\n')
ok('a half-typed question about an error is not a failure', P.stoppedLine(boxed) === null)

for (const marker of ['>', '❯', '›', '»']) {
  ok(
    `a submitted line echoed back after "${marker}" is somebody talking`,
    P.stoppedLine(`${marker} what does API Error: 429 rate_limit_error mean\n`) === null
  )
}

ok('empty output reports nothing', P.stoppedLine('') === null)
ok('ordinary output reports nothing', P.stoppedLine('Done. 218 checks passed.\n') === null)

ok(
  'only the tail is read, so an error scrolled far off screen is left alone',
  P.stoppedLine(
    'API Error: 401 authentication_error - invalid x-api-key\n' + 'x'.repeat(P.TAIL_CHARS + 200)
  ) === null
)

// ---- the message ------------------------------------------------------------------

const msg = P.errorMessage('taskdriver', 'API Error: Claude usage limit reached.')
ok('the message names the pane first', msg.startsWith('taskdriver stopped:'), msg)
ok('the message carries the error itself', msg.includes('API Error: Claude usage limit reached.'))
ok('the message says nothing is retrying it', msg.includes('Nothing is retrying this one.'))
ok(
  'a device is named when one is given',
  P.errorMessage('taskdriver', 'API Error: 429', 'the PC').startsWith(
    'taskdriver on the PC stopped:'
  )
)

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
