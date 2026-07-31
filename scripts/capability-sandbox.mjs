// Moving a capability from Discovered to Tested, with evidence nobody authored.
//
//   node scripts/capability-sandbox.mjs --id motion --package motion --install
//   node scripts/capability-sandbox.mjs --id motion --dry-run
//
// ## Why this is allowed to install and nothing else is
//
// The rule everywhere else in this pipeline is that nothing gets installed without
// Robert's approval. This is the approved place, and the approval is the `--install` flag:
// without it the script does everything except fetch, so the default invocation cannot
// pull a package off the network. Three properties make that safe enough to be the
// exception rather than a hole:
//
//   1. The fixture is a fresh temp directory with a private package.json. It is never a
//      real project, never the app's own repo, and it is deleted at the end. A candidate
//      that installs a postinstall script gets a throwaway directory to run it in.
//   2. Nothing installed is ever executed. The build is `esbuild --bundle`, which reads
//      and links modules; it does not run them. "Test it by running it" is how a
//      supply-chain payload gets its shell.
//   3. What comes back is numbers - exit codes, byte counts, milliseconds - and they are
//      recorded verbatim. The thing being tested has no way to author its own result.
//
// ## What a pass is NOT evidence of
//
// This measures installability, resolvability, bundle cost and build time. It cannot see a
// rendered pixel, a focus ring or a screen reader, so the note it writes says so out loud.
// A pass moves the record to Tested. Only a person moves it to Verified, and
// `capability-lifecycle.mjs` makes them name the evidence when they do.

import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capabilityDir, find, reindex, safe, shared, today, update, vaultPath } from './capability-store.mjs'

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const value = (n, d = '') => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}

const id = value('--id')
const dryRun = flag('--dry-run')
const doInstall = flag('--install')
const fixtureName = value('--fixture', 'esbuild-resolve')

function out(o) {
  process.stdout.write(JSON.stringify(o) + '\n')
  process.exit(o.ok === false ? 1 : 0)
}

if (!id) out({ ok: false, why: 'need --id <capability-id>' })

const entry = find(id)
if (!entry) out({ ok: false, why: `no record with id ${id} in ${capabilityDir()}` })
const record = entry.record
const pkg = value('--package', record.id)

/**
 * What an npm package name may look like before it reaches a command line.
 *
 * The name originates in a capability record, and a capability record originates on a web
 * page. Everything else passed to the installer is a literal in this file; this is the one
 * value an attacker could aim at, so it is refused rather than escaped.
 */
const PACKAGE_OK = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
if (!PACKAGE_OK.test(pkg)) {
  out({ ok: false, why: `refusing to install "${pkg}" - not a plain npm package name` })
}

const { capability } = shared()

if (dryRun) {
  out({
    ok: true,
    dryRun: true,
    id,
    package: pkg,
    stageNow: capability.stage(record),
    wouldInstall: doInstall,
    fixture: fixtureName,
    note: 'nothing was fetched, built or written'
  })
}

// ---------------------------------------------------------------------------
// the fixture
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'pf-sandbox-'))
let result = { pass: false, bundleBytes: -1, ms: -1, deps: -1, note: '' }
const steps = []

function run(label, bin, args, opts = {}) {
  const started = Date.now()
  try {
    execFileSync(bin, args, {
      // Windows cannot spawn a `.cmd` without a shell since Node's fix for
      // CVE-2024-27980 - `npm.cmd` fails with a bare `spawnSync EINVAL` that names
      // nothing. The package name is validated against PACKAGE_OK before it gets here,
      // which is what makes a shell acceptable: it is the only argument that is not a
      // literal in this file.
      shell: process.platform === 'win32',
      cwd: dir,
      timeout: opts.timeout ?? 180_000,
      windowsHide: true,
      stdio: 'pipe',
      // No credentials reach the sandbox. A candidate's install script must not be able to
      // read a token out of the environment that happened to be lying around.
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        HOME: dir,
        USERPROFILE: dir,
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_update_notifier: 'false'
      }
    })
    steps.push({ step: label, exit: 0, ms: Date.now() - started })
    return true
  } catch (e) {
    steps.push({
      step: label,
      exit: typeof e.status === 'number' ? e.status : -1,
      ms: Date.now() - started,
      stderr: String(e.stderr ?? e.message ?? '').slice(0, 400)
    })
    return false
  }
}

function dirBytes(p) {
  try {
    return statSync(p).size
  } catch {
    return -1
  }
}

try {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'pf-sandbox', private: true, version: '0.0.0', type: 'module' }, null, 2)
  )
  writeFileSync(join(dir, 'entry.js'), `import * as candidate from ${JSON.stringify(pkg)}\nexport default candidate\n`)

  const started = Date.now()
  let ok = true

  if (doInstall) {
    ok = run('install', process.platform === 'win32' ? 'npm.cmd' : 'npm', [
      'install',
      pkg,
      '--no-audit',
      '--no-fund',
      '--ignore-scripts'
    ])
  } else {
    steps.push({ step: 'install', exit: null, ms: 0, stderr: 'skipped - pass --install to fetch' })
    ok = false
  }

  if (ok) {
    // Resolve and link, never execute. Bundling reads the package's own entry points and
    // its exports map, which is what actually catches "ships ESM only", "requires a
    // bundler plugin" and "peer dependency missing".
    //
    // This repository's own esbuild, not `npx esbuild`: the sandbox runs with HOME pointed
    // at the throwaway directory, so npx would find an empty cache and download a copy of
    // esbuild on every single test - a network fetch and several seconds, measured as if
    // it were the candidate's build time.
    const started = Date.now()
    try {
      buildSync({
        absWorkingDir: dir,
        entryPoints: ['entry.js'],
        bundle: true,
        minify: true,
        format: 'esm',
        platform: 'browser',
        outfile: 'out.js',
        logLevel: 'silent'
      })
      steps.push({ step: 'bundle', exit: 0, ms: Date.now() - started })
      result.bundleBytes = dirBytes(join(dir, 'out.js'))
    } catch (e) {
      steps.push({
        step: 'bundle',
        exit: 1,
        ms: Date.now() - started,
        stderr: String(e.message ?? e).slice(0, 400)
      })
      ok = false
    }
  }

  result.ms = Date.now() - started
  try {
    result.deps = readdirSync(join(dir, 'node_modules')).filter((d) => !d.startsWith('.')).length
  } catch {
    result.deps = -1
  }
  result.pass = ok
  result.note = ok
    ? `installed and bundled; ${result.deps} packages in node_modules`
    : `failed at ${steps[steps.length - 1]?.step ?? 'setup'}`
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// recording it
// ---------------------------------------------------------------------------

const test = {
  at: today(),
  fixture: fixtureName,
  pass: result.pass,
  bundleBytes: result.bundleBytes,
  ms: result.ms,
  note: result.note.slice(0, 160)
}

const next = update(id, (c) => ({ ...c, tests: [...(c.tests ?? []), test].slice(-10) }))

const notePath = join(vaultPath(), '70 Agent Memory', 'evaluations', `${today()}-${id}.md`)
mkdirSync(join(vaultPath(), '70 Agent Memory', 'evaluations'), { recursive: true })
writeFileSync(
  notePath,
  `---
type: evaluation
area: capabilities
status: verified
sensitivity: internal
updated: ${today()}
---

# Sandbox test — ${safe(record.name)} — ${today()}

\`capability: ${id}\` · package \`${safe(pkg)}\` · fixture \`${fixtureName}\` · result \`${result.pass ? 'pass' : 'fail'}\`

Every number below is an exit code, a byte count or a timer. Nothing here was
authored by the thing being tested.

## What ran

| Step | Exit | ms |
|---|---|---|
${steps.map((s) => `| ${s.step} | ${s.exit === null ? 'skipped' : s.exit} | ${s.ms} |`).join('\n')}

Installed with \`--ignore-scripts\`, in a throwaway directory, with no
credentials in the environment. Nothing installed was executed: the build links
modules, it does not run them.

## Measured

| Bundle (minified) | Install + build | Packages in node_modules |
|---|---|---|
| ${result.bundleBytes < 0 ? 'not measured' : result.bundleBytes + ' bytes'} | ${result.ms} ms | ${result.deps < 0 ? 'not measured' : result.deps} |

${steps.filter((s) => s.stderr).map((s) => `### ${s.step}\n\n\`\`\`\n${safe(s.stderr)}\n\`\`\``).join('\n\n')}

## What this is NOT evidence of

This fixture has no browser. Rendered output, responsive behaviour, keyboard
navigation, reduced motion, screen-reader behaviour and runtime performance were
**not** tested and must not be read into a pass.

## Verdict

${result.pass
    ? 'Installs, resolves and bundles. The record moves to **Tested**. A human moves it to Verified, and must name the evidence when they do.'
    : 'Did not get through install and bundle. The record stays where it was; the failure is recorded so it is not retried blindly.'}
`,
  'utf8'
)

const indexed = reindex()

out({
  ok: true,
  id,
  package: pkg,
  pass: result.pass,
  bundleBytes: result.bundleBytes,
  ms: result.ms,
  deps: result.deps,
  steps,
  stageBefore: capability.stage(record),
  stageAfter: next ? capability.stage(next) : null,
  note: notePath,
  indexed
})
