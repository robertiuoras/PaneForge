// The install button has to be the whole answer on a machine that has never had a
// developer toolchain on it. That is the case this pins.
//
// A fresh Windows box has no Node, and nine of the twelve built-in agents install with
// `npm i -g`. What that produced was `npm : The term 'npm' is not recognized`, a dead
// console, and an app that could install none of its own agents - the failure a person
// who is not a developer cannot act on, and the one nobody testing on a dev machine
// ever sees.
//
// Two halves are checked here:
//   1. the catalogue itself - every install line's prerequisite is classified, and
//      every scripted install has a scripted removal (or is deliberately exempt);
//   2. the real thing - `ensurePrereq` is run against a REAL shell with a PATH that
//      genuinely lacks npm, and must both notice and refuse rather than proceed.
//
// Run: node scripts/install-prereq-test.mjs   (part of `npm test`)

import { buildSync } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
// The bundle keeps `@lydell/node-pty` external (it is native, and none of the paths
// under test touch it), so it has to sit somewhere that package still resolves from -
// i.e. inside this checkout, not in the system temp dir.
const OUT = join(ROOT, 'node_modules', '.pf-test')

let failures = 0
function ok(cond, what) {
  if (cond) {
    console.log(`  ok   ${what}`)
  } else {
    failures++
    console.log(`  FAIL ${what}`)
  }
}

/** Bundle a TS module to ESM so this runs under plain node, no ts-node, no Electron. */
function load(entry, outName) {
  mkdirSync(OUT, { recursive: true })
  const outfile = join(OUT, outName)
  buildSync({
    entryPoints: [join(ROOT, entry)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    // node-pty is a native module and is not needed for the paths under test.
    external: ['@lydell/node-pty', 'electron']
  })
  return { url: pathToFileURL(outfile).href }
}

const { BUILTIN_AGENTS, installCommand, uninstallCommand, prereqFor, prereqInstall } = await import(
  load('src/shared/agents.ts', 'agents.mjs').url
)

console.log('catalogue')

// Every agent that offers an install on a platform must classify its prerequisite, so
// nothing can be added later that silently reintroduces the bare-npm failure.
for (const platform of ['win32', 'darwin', 'linux']) {
  for (const spec of BUILTIN_AGENTS) {
    const cmd = installCommand(spec, platform)
    if (!cmd) continue
    const need = prereqFor(cmd)
    if (/^(npm|npx)\b/.test(cmd.trim())) {
      ok(need?.need === 'node', `${spec.id} on ${platform}: npm line is marked as needing node`)
    }
    if (/^python\b|^pip3?\b/.test(cmd.trim())) {
      ok(need?.need === 'python', `${spec.id} on ${platform}: pip line is marked as needing python`)
    }
    // A prerequisite we cannot bootstrap is allowed, but only on linux, where guessing
    // the package manager would be worse than saying so.
    if (need && platform !== 'linux') {
      ok(
        prereqInstall(need.need, platform) !== '',
        `${spec.id} on ${platform}: ${need.need} has a bootstrap command`
      )
    }
  }
}

// A CLI you can install with one click and cannot remove with one is a trap. The two
// exemptions are deliberate: `shell` is the OS's own, and cursor ships no uninstaller.
const NO_REMOVAL = new Set(['shell', 'cursor'])
for (const spec of BUILTIN_AGENTS) {
  for (const platform of ['win32', 'darwin']) {
    if (!installCommand(spec, platform) || NO_REMOVAL.has(spec.id)) continue
    ok(
      uninstallCommand(spec, platform) !== '',
      `${spec.id} on ${platform}: installable means removable`
    )
  }
}

// The removal must name the same package the install did, or the button removes
// something else entirely.
for (const spec of BUILTIN_AGENTS) {
  const inst = installCommand(spec, 'win32')
  const un = uninstallCommand(spec, 'win32')
  if (!inst || !un) continue
  const pkg = inst.match(/(@[\w.-]+\/[\w.-]+|--id\s+([\w.]+))/)
  if (!pkg) continue
  const name = pkg[2] ?? pkg[1]
  ok(un.includes(name), `${spec.id}: uninstall names the same package (${name})`)
}

ok(prereqFor('winget install --id Ollama.Ollama -e') === null, 'a winget line needs no toolchain')
ok(prereqFor('brew install ollama') === null, 'a brew line needs no toolchain')
ok(
  prereqFor('python -m pip install aider-install && aider-install')?.need === 'python',
  'aider is classified as python'
)

console.log('\nreal shell, PATH with no npm')

// The measured failure, reproduced: a real pty, a real PowerShell/bash, and a PATH that
// genuinely has no npm on it. ensurePrereq must NOT hand back true, and must not leave
// the caller to run a command that cannot work.
const { ensurePrereq } = await import(load('src/main/install.ts', 'install.mjs').url)

const realPath = process.env.PATH
const realHome = process.env.HOME
const realNoUserPaths = process.env.PANEFORGE_NO_USER_PATHS
// Keep the system dirs so a shell can still be found; drop everything that could hold
// npm (nodejs, nvm, fnm, volta, the npm global prefix).
process.env.PATH = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin:/bin:/usr/sbin:/sbin'
// `which()` also checks normal user install locations for GUI launches. Point HOME at
// a folder with none of those locations so this still exercises the genuine no-Node
// branch rather than accidentally finding this developer machine's nvm install.
process.env.HOME = join(OUT, 'empty-home')
process.env.PANEFORGE_NO_USER_PATHS = '1'

let said = ''
// Force the "cannot bootstrap" branch by claiming a platform with no scripted
// bootstrap, so the test never actually installs Node onto the machine running it.
const proceeded = await ensurePrereq('npm i -g @openai/codex', (c) => (said += c), 'linux')
process.env.PATH = realPath
process.env.HOME = realHome
if (realNoUserPaths === undefined) delete process.env.PANEFORGE_NO_USER_PATHS
else process.env.PANEFORGE_NO_USER_PATHS = realNoUserPaths

ok(proceeded === false, 'a missing npm stops the install instead of running it')
ok(/Node\.js/.test(said), 'the message names Node.js rather than printing a shell error')
ok(/nodejs\.org/.test(said), 'the message says where to get it')
ok(!/not recognized|command not found/i.test(said), 'the raw shell error is not what the user reads')

// The opposite case: a prerequisite that IS present must not add a step.
let quiet = ''
const passed = await ensurePrereq('winget install --id Ollama.Ollama -e', (c) => (quiet += c))
ok(passed === true, 'a command with no toolchain prerequisite runs straight through')
ok(quiet === '', 'and says nothing on the way')

rmSync(OUT, { recursive: true, force: true })

console.log(failures ? `\n${failures} failed` : '\nall good')
process.exit(failures ? 1 : 0)
