// Turning an observed process back into a package.json script a handoff can restart.
//
// The load-bearing half is the refusals: a script the receiving repo does not have, a tool
// that could be two different scripts, and anything that looks like it holds a shell
// metacharacter. All three are silent failures if this is wrong - the far end simply never
// gets its dev server back, or worse, runs the wrong one.
//
//   node scripts/devservers-test.mjs

import { buildSync } from 'esbuild'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-devservers-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const outfile = join(work, 'devservers.bundle.cjs')
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/shared/devServers.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile
})
const { devSignalOf, tokenize, inRepo, scriptsForTool, devPlan, managerFor, devCommand } =
  createRequire(import.meta.url)(outfile)

let checks = 0
function check(what, ok, detail) {
  checks++
  assert.ok(ok, `${what}${detail === undefined ? '' : ` - got ${JSON.stringify(detail)}`}`)
}
const eq = (what, a, b) => check(what, JSON.stringify(a) === JSON.stringify(b), a)

{
  // The two real shapes measured on this desk.
  eq(
    'npm run <script> is a script signal',
    devSignalOf('npm run dev:restart'),
    { kind: 'script', script: 'dev:restart' }
  )
  eq(
    'a tool reached through node_modules is a tool signal',
    devSignalOf(
      '/opt/homebrew/Cellar/node/24.10.0/bin/node /Users/robertiuoras/Projects/taskdriver.ai-c/node_modules/next/dist/bin/next dev -p 3009'
    ),
    { kind: 'tool', tool: 'next' }
  )
}

{
  // The shorthand every manager but npm accepts.
  eq('pnpm dev shorthand', devSignalOf('pnpm dev'), { kind: 'script', script: 'dev' })
  eq('yarn dev shorthand', devSignalOf('yarn dev'), { kind: 'script', script: 'dev' })
  eq('bun dev shorthand', devSignalOf('bun dev'), { kind: 'script', script: 'dev' })
}

{
  // Not every script is a dev server, and re-running the wrong one is worse than none.
  eq('npm run build is not a dev script', devSignalOf('npm run build'), null)
  eq('npm test is not a dev script', devSignalOf('npm test'), null)
}

{
  // Anything a shell would read is refused at tokenize, and devSignalOf inherits that.
  const evil = 'npm run dev && rm -rf /'
  check('tokenize refuses shell metacharacters', tokenize(evil) === null)
  eq('devSignalOf refuses it too', devSignalOf(evil), null)
  check('a pipe is refused', tokenize('npm run dev | tee log') === null)
  check('a backtick is refused', tokenize('npm run dev `whoami`') === null)
}

{
  // Path containment, never a name prefix - a sibling repo whose name merely starts the
  // same must never be read as inside the root.
  const root1 = '/Users/x/service'
  check('a command inside the root matches', inRepo('/Users/x/service/node_modules/.bin/next dev', root1))
  check(
    'a sibling repo whose name starts the same does not match',
    !inRepo('/Users/x/service-a/node_modules/.bin/next dev', root1)
  )
  check('an empty root matches nothing', !inRepo('/Users/x/service/foo', ''))
  check(
    'case and separator differences still match (one side is Windows)',
    inRepo('C:\\Users\\X\\Service\\node_modules\\next', 'c:/users/x/service')
  )
}

{
  // Several scripts can run the same tool; `dev` is the one a person means.
  const scripts = { 'dev:https': 'next dev --https', dev: 'next dev', build: 'next build' }
  eq('dev sorts first when several match', scriptsForTool(scripts, 'next'), ['dev', 'dev:https'])
  eq('no match returns an empty list', scriptsForTool(scripts, 'vite'), [])
}

{
  // A script signal for something the receiving repo does not have is dropped, and the
  // reason is named rather than silently swallowed.
  const { servers, notes } = devPlan(['npm run dev:restart'], { dev: 'next dev' })
  eq('an unknown script produces no server', servers, [])
  check('and says why', notes.some((n) => n.includes('dev:restart')))
}

{
  // Two scripts could run the tool and neither is called `dev` - ambiguous, so it is
  // refused rather than guessed at, and named.
  const scripts = { 'dev:mock': 'next dev --mock', 'dev:https': 'next dev --https' }
  const { servers, notes } = devPlan(
    ['node /repo/node_modules/next/dist/bin/next dev -p 3000'],
    scripts
  )
  eq('an ambiguous tool produces no server', servers, [])
  check('and names both candidates', notes.some((n) => n.includes('dev:mock') && n.includes('dev:https')))
}

{
  // The same script observed twice (two processes, one dev server) collapses to one entry.
  const scripts = { dev: 'next dev' }
  const { servers } = devPlan(['npm run dev', 'npm run dev'], scripts)
  eq('duplicates collapse to one server', servers.length, 1)
  eq('and it is the right one', servers[0].script, 'dev')
}

{
  eq('pnpm-lock.yaml means pnpm', managerFor(['pnpm-lock.yaml']), 'pnpm')
  eq('yarn.lock means yarn', managerFor(['yarn.lock']), 'yarn')
  eq('bun.lockb means bun', managerFor(['bun.lockb']), 'bun')
  eq('no lockfile means npm', managerFor([]), 'npm')
  eq('an unrelated file still means npm', managerFor(['README.md']), 'npm')
}

{
  // The receiver never trusts the sender's claim that a name is safe - it checks again.
  check('a script name with a shell separator is refused', devCommand('npm', 'dev; rm -rf /') === null)
  check('a path traversal name is refused', devCommand('npm', '../evil') === null)
  eq('an ordinary script builds argv, never a string', devCommand('npm', 'dev'), ['npm', 'run', 'dev'])
  eq('a scoped script name is fine', devCommand('pnpm', 'dev:restart'), ['pnpm', 'run', 'dev:restart'])
}

console.log(`devservers: ${checks} checks passed`)
