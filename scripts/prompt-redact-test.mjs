// The envelope: what the improver is never allowed to see, and that it comes back exactly.
//
// Precision over recall is the stated policy and it is what these cases check: a false
// positive costs one placeholder in a prompt the user reads before accepting, a false
// negative costs a key. So `DATABASE_URL=postgres://localhost:5432/dev` must survive
// intact - holding it back would cost the improver the one fact it needed - while
// anything with real entropy behind a credential-shaped name must not.
//
//   node scripts/prompt-redact-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-redact-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const out = join(work, 'redact.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/redact.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: out
})
const { envelope, restore, placeholdersMatch, heldSummary, looksSecret, shannon } =
  createRequire(import.meta.url)(out)

let failed = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` - ${detail}`}`)
  if (!ok) failed++
}

/**
 * Every secret detector: the value must be gone, and must come back byte for byte.
 *
 * Each fixture is ASSEMBLED rather than written out whole, and that is not cosmetic.
 * These are invented values, but a scanner reading this file cannot know that - GitHub's
 * push protection rejected an earlier version of this commit over the Slack line, which
 * is exactly the behaviour you want from it. Splitting the prefix from the body means no
 * line in the repository matches a credential pattern while the value the test feeds in
 * is still a complete, realistic one.
 */
const SECRETS = [
  ['anthropic', 'sk-ant-' + 'api03-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'],
  ['openai', 'sk-' + 'proj-' + 'abcdefghijklmnopqrstuvwxyz012345'],
  ['github pat', 'ghp' + '_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
  ['github fine-grained', 'github' + '_pat_' + 'A1B2C3D4E5F6G7H8I9J0_abcdefghijklmnop'],
  ['aws', 'AKIA' + 'IOSFODNN7EXAMPLE'],
  ['google', 'AIza' + 'SyD-1234567890abcdefghijklmnopqrstuv'],
  ['slack', 'xox' + 'b-123456789012-1234567890123-abcdefghijklmnopqrstuvwx'],
  ['stripe', 'sk' + '_live_' + '51AbCdEfGhIjKlMnOpQr'],
  [
    'jwt',
    'eyJhbGciOiJIUzI1NiJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.' +
      'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
  ],
  ['bearer', 'Bearer ' + 'abcdefghijklmnopqrstuvwxyz0123456789'],
  ['url basic auth', 'https://admin:' + 'hunter2hunter2' + '@internal.example.com/api']
]

for (const [name, secret] of SECRETS) {
  const text = `the deploy fails, here is the value: ${secret} - what is wrong?`
  const env = envelope(text)
  const held = env.counts.secret >= 1
  const gone = !env.text.includes(secret)
  const back = restore(env.text, env.holds) === text
  check(`${name} is held back`, held && gone, held ? 'still visible in the envelope' : 'not detected')
  check(`${name} restores byte-exact`, back)
}

{
  const key = 'API_KEY=' + 'x7Kq2mZ9pL4vB8nR3tW6yD1sF5gH0jA'
  const env = envelope(`set ${key} in the env file`)
  check('a high-entropy KEY=value is held back', env.counts.secret === 1 && !env.text.includes('x7Kq2'))
}
{
  // The false positive that would cost more than it saves.
  const text = 'DATABASE_URL=postgres://localhost:5432/dev_database is what it points at'
  const env = envelope(text)
  check(
    'a low-entropy connection string is NOT held back',
    env.counts.secret === 0,
    'holding this costs the improver the one fact it needed'
  )
}
{
  const text = 'DESCRIPTION=this is a perfectly ordinary sentence of prose here'
  check('a non-credential name is not held back', envelope(text).counts.secret === 0)
}
check('entropy separates prose from base64', shannon('aaaaaaaaaaaa') < 3.5 && shannon('x7Kq2mZ9pL4vB8nR3tW6yD1sF5gH0jA') >= 3.5)

// --- code elision ----------------------------------------------------------

{
  const code = '```ts\n' + Array.from({ length: 40 }, (_, i) => `const x${i} = ${i}`).join('\n') + '\n```'
  const text = `this function is wrong:\n\n${code}\n\nwhy?`
  const env = envelope(text)
  check('a long code block is elided', env.counts.code === 1 && !env.text.includes('const x39'))
  check('and it says what it was', env.holds.some((h) => h.label.includes('TypeScript')))
  check('a 400-line paste costs a handful of tokens', env.text.length < 100)
  check('the code restores byte-exact', restore(env.text, env.holds) === text)
}
{
  const short = '```js\nconst a = 1\nconst b = 2\n```'
  check('a short code block is left alone', envelope(`look:\n${short}`).counts.code === 0)
}

// --- paths -----------------------------------------------------------------

{
  const env = envelope('the log is at C:\\Users\\someone\\AppData\\Local\\app.log')
  check('an absolute Windows path outside the project is masked', env.counts.path === 1)
}
{
  const env = envelope('the log is at /Users/someone/Library/Logs/app.log')
  check('an absolute mac path outside the project is masked', env.counts.path === 1)
}
{
  const env = envelope('C:\\work\\myapp\\src\\index.ts is broken', { projectPath: 'C:\\work\\myapp' })
  check('a path INSIDE the project is left readable', env.counts.path === 0, 'the agent is already there')
}
{
  const env = envelope('/home/rob/project/src/a.ts', { projectPath: '/home/rob/project' })
  check('same on a mac path', env.counts.path === 0)
}

// --- the round-trip contract ------------------------------------------------

{
  const text = 'use sk-ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6' + ' to call it'
  const env = envelope(text)
  const token = env.holds[0].token
  check('an answer that kept the placeholder passes', placeholdersMatch(`please use ${token} here`, env.holds).ok)
  check(
    'an answer that DROPPED it fails',
    placeholdersMatch('please use the key here', env.holds).ok === false,
    'dropping it silently loses the user their key'
  )
  check(
    'an answer that INVENTED one fails',
    placeholdersMatch(`use ${token} and \u00abSECRET_9\u00bb`, env.holds).ok === false
  )
}

check('the summary counts rather than quotes', heldSummary({ secret: 2, code: 1, path: 0 }) === 'held back: 2 secrets, 1 code block')
check('nothing held means nothing said', heldSummary({ secret: 0, code: 0, path: 0 }) === '')

// --- the log gate ----------------------------------------------------------

check(
  'looksSecret refuses a line with a key in it',
  looksSecret('token ' + 'ghp' + '_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') === true
)
check('looksSecret passes an ordinary prompt', looksSecret('fix the login form on mobile') === false)

rmSync(work, { recursive: true, force: true })
console.log(failed ? `\n${failed} failing` : '\nall good')
process.exit(failed ? 1 : 0)
