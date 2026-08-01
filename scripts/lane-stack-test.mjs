// Lanes for the repos and the agents that are not the author's own.
//
// The first version of this feature was quietly Node-and-Claude shaped: it cloned
// `node_modules` and nothing else, it guessed a dev port from JS config files and
// fell back to 3000 for everything else, it never checked that port was free, and
// exactly one of the thirteen agents PaneForge runs had its per-folder trust
// carried into the lane. Every one of those is a lane that opens broken for a user
// whose stack is Python, PHP or Ruby, or whose agent is Codex.
//
// The checks below are those failures. The nastiest is the venv one: every file in
// a cloned dependency tree is a hardlink, so rewriting a path *through* one edits
// the original folder's copy too - the same damage the old junction approach did,
// arriving by a different door.
//
//   node scripts/lane-stack-test.mjs

import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const wanted = join(tmpdir(), 'paneforge-lane-stack-test')
rmSync(wanted, { recursive: true, force: true })
mkdirSync(wanted, { recursive: true })
// realpath, because macOS hands out /var/folders/... while git answers with the
// /private/var it resolves to, and every assertion here compares path strings.
const root = realpathSync(wanted)

// Nothing in this file may touch the machine's real agent config.
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')
process.env.CODEX_HOME = join(root, 'codex')
process.env.USERPROFILE = root
process.env.HOME = root

const bundle = join(root, 'lanes.mjs')
await build({
  entryPoints: [join(here, '..', 'src', 'main', 'lanes.ts')],
  outfile: bundle,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const { resolveLane } = await import(`file:///${bundle.replace(/\\/g, '/')}`)

let failed = 0
const ok = (name, cond) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) failed++
}
const waitUntil = async (fn, ms = 60000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      if (fn()) return true
    } catch {
      /* not there yet */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
const commit = (dir) => {
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'test')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
}

// ---------------------------------------------------------------- Python + PHP

const py = join(root, 'api')
mkdirSync(py, { recursive: true })
writeFileSync(join(py, 'pyproject.toml'), '[project]\nname = "api"\ndependencies = ["fastapi"]\n')
writeFileSync(join(py, '.gitignore'), '.venv/\nvendor/\n')
writeFileSync(join(py, 'main.py'), 'app = 1\n')
commit(py)

// A virtualenv states its own absolute path in three places; all of them are the
// original folder's until the lane repoints them.
const venv = join(py, '.venv')
mkdirSync(join(venv, 'bin'), { recursive: true })
mkdirSync(join(venv, 'Scripts'), { recursive: true })
writeFileSync(join(venv, 'pyvenv.cfg'), `home = /usr/bin\nprompt = api\nexecutable = ${resolve(venv)}/bin/python\n`)
writeFileSync(join(venv, 'bin', 'activate'), `VIRTUAL_ENV="${resolve(venv)}"\nexport VIRTUAL_ENV\n`)
writeFileSync(join(venv, 'bin', 'pytest'), `#!${resolve(venv)}/bin/python\nprint(1)\n`)
// A Windows console script is an exe with the path in a binary trailer: there is
// no safe text edit for it, and it must be left exactly as it was found.
writeFileSync(join(venv, 'Scripts', 'pytest.exe'), Buffer.from([0x4d, 0x5a, 0x00, 0x01, 0x02, 0x00]))
mkdirSync(join(py, 'vendor', 'composer'), { recursive: true })
writeFileSync(join(py, 'vendor', 'autoload.php'), '<?php\n')

const pyLane = await resolveLane(py, [py])
const laneA = join(root, 'api-a')
ok('a python repo gets a lane like any other', pyLane.cwd === laneA && pyLane.lane === 'a')
ok('the port comes from the stack, not the 3000 fallback', pyLane.port >= 8001 && pyLane.port < 8041)

ok(
  'a virtualenv is cloned into the lane',
  await waitUntil(() => read(join(laneA, '.venv', 'pyvenv.cfg')).includes('prompt'))
)
ok(
  'the cloned venv points at the lane, not the folder it came from',
  await waitUntil(() => read(join(laneA, '.venv', 'pyvenv.cfg')).includes(resolve(laneA)))
)
ok('...and no longer at the original', !read(join(laneA, '.venv', 'pyvenv.cfg')).includes(resolve(py, '.venv')))
ok('the activate script is repointed too', read(join(laneA, '.venv', 'bin', 'activate')).includes(resolve(laneA)))
ok('so is a console script shebang', read(join(laneA, '.venv', 'bin', 'pytest')).includes(resolve(laneA)))

// The hardlink trap: the rewrite must delete the file first, or it writes through
// the link and the original session's environment is edited out from under it.
ok('the ORIGINAL venv is left untouched by the rewrite', read(join(venv, 'pyvenv.cfg')).includes(resolve(venv)))
ok('...and the original activate script too', read(join(venv, 'bin', 'activate')).includes(resolve(venv)))
ok('...and the original console script too', read(join(venv, 'bin', 'pytest')).includes(resolve(venv)))
ok(
  'a binary console script is copied, not corrupted by a text rewrite',
  await waitUntil(() => readFileSync(join(laneA, '.venv', 'Scripts', 'pytest.exe'))[0] === 0x4d)
)

ok(
  'a composer vendor folder is cloned as well',
  await waitUntil(() => existsSync(join(laneA, 'vendor', 'autoload.php')))
)

// ------------------------------------------------------------------ free ports

const busy = join(root, 'busy')
mkdirSync(busy, { recursive: true })
writeFileSync(join(busy, '.env'), 'PORT=41234\n')
writeFileSync(join(busy, '.gitignore'), 'nothing\n')
writeFileSync(join(busy, 'app.py'), 'x = 1\n')
commit(busy)

const held = createServer()
await new Promise((done) => held.listen(41235, '0.0.0.0', done))
const busyLane = await resolveLane(busy, [busy])
ok('the port a lane is handed is one nothing is listening on', busyLane.port !== 41235)
ok('...and it is the next one up, not a wild jump', busyLane.port === 41236)
await new Promise((done) => held.close(done))

// -------------------------------------------------------------- docker compose

const dock = join(root, 'dock')
mkdirSync(dock, { recursive: true })
writeFileSync(join(dock, 'docker-compose.yml'), 'services:\n  web:\n    ports:\n      - "8085:80"\n')
writeFileSync(join(dock, 'app.go'), 'package main\n')
writeFileSync(join(dock, 'go.mod'), 'module x\n')
commit(dock)
const dockLane = await resolveLane(dock, [dock])
ok('a compose file gives the HOST port, not the container port', dockLane.port >= 8086 && dockLane.port < 8126)
ok('a lane gets its own compose project, so two lanes do not share containers', dockLane.env.COMPOSE_PROJECT_NAME === 'dock-a')

// compose refuses a project name that does not start with a letter or a digit.
const odd = join(root, '.My_Odd Repo')
mkdirSync(odd, { recursive: true })
writeFileSync(join(odd, 'x.txt'), '1\n')
commit(odd)
const oddLane = await resolveLane(odd, [odd])
ok(
  'an awkward folder name still makes a legal compose project name',
  /^[a-z0-9][a-z0-9_-]*$/.test(oddLane.env.COMPOSE_PROJECT_NAME)
)

// --------------------------------------------------------------- Codex, not Claude

const codexCfg = join(root, 'codex', 'config.toml')
mkdirSync(dirname(codexCfg), { recursive: true })
writeFileSync(
  codexCfg,
  `model = "gpt-5"\n\n[projects.'${resolve(py).toLowerCase()}']\ntrust_level = "trusted"\n\n[history]\npersistence = "save-all"\n`
)

const laneB = join(root, 'api-b')
await resolveLane(py, [py, laneA])
const after = read(codexCfg)
ok('a lane inherits the original folder’s Codex trust', after.includes(`[projects.'${resolve(laneB).toLowerCase()}']`))
ok('...with the trust level it actually had', /\[projects\.'[^']*api-b'\]\s*\r?\ntrust_level = "trusted"/.test(after))
ok('...without swallowing the sections after it', after.includes('[history]') && after.includes('persistence'))
ok('...and without granting the lane anything extra', after.split('trust_level').length === 3)

// A repo the user never trusted must not become trusted by opening a lane in it.
const untrusted = join(root, 'stranger')
mkdirSync(untrusted, { recursive: true })
writeFileSync(join(untrusted, 'x.txt'), '1\n')
commit(untrusted)
await resolveLane(untrusted, [untrusted])
ok('a repo with no Codex trust stays untrusted in its lane', !read(codexCfg).includes('stranger-a'))

// Running it twice must not append the same section again.
rmSync(laneB, { recursive: true, force: true })
git(py, 'worktree', 'prune')
await resolveLane(py, [py, laneA])
ok('re-seeding a lane does not duplicate the section', read(codexCfg).split('api-b').length === 2)

console.log(failed ? `\n${failed} failed` : '\nall good')
process.exit(failed ? 1 : 0)
