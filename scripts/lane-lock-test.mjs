// Regression test for the release lock going stale under a release that is still running.
//
// `state.release` is what stops two chats cutting two versions a minute apart, and it is
// cleared automatically after LOCK_MS (20 minutes) because a release that crashed or was
// killed must not block every later one forever. That number was chosen when GitHub Actions
// built the installers and `ship` was over in about a minute. Actions have been disabled for
// the account since 2026-07-28, so this machine now runs electron-vite and electron-builder
// itself and uploads the artifacts - minutes of work, with the lock ticking the whole time.
// A lock that expires under a live release is the worst failure this file has: the next
// chat believes the release crashed, clears the lock, and cuts a second version on top of
// the first one, which is still uploading.
//
// So the release says it is alive as it goes, and LOCK_MS keeps meaning what it says -
// nothing has happened here for twenty minutes - instead of being a guess at how long a
// build takes that has to be raised every time the app grows.
//
// This drives a real `ship` with a stubbed `gh` on PATH, so nothing here touches the
// network or GitHub. The stub records what the release lock said each time it was called;
// the proof is that the recorded times move apart while the build runs. It takes about
// half a minute, which is the two 15-second polls publishFallback does before it gives up
// on Actions.
//
//   node scripts/lane-lock-test.mjs

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(tmpdir(), 'paneforge-lane-lock-test')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

let failed = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${detail}`)
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

// ---------------------------------------------------------------- a repo that can be pushed

const origin = join(root, 'origin.git')
git(root, 'init', '-q', '--bare', '-b', 'master', origin)

const repo = join(root, 'demo')
mkdirSync(join(repo, 'scripts'), { recursive: true })
writeFileSync(
  join(repo, 'package.json'),
  JSON.stringify(
    { name: 'demo', version: '0.0.1', build: { publish: [{ provider: 'github', owner: 'demo', repo: 'demo' }] } },
    null,
    2
  ) + '\n'
)
writeFileSync(join(repo, 'app.js'), 'console.log(1)\n')
installLane(here, repo)
git(repo, 'init', '-q', '-b', 'master')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'test')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'first')
git(repo, 'tag', 'v0.0.1')
git(repo, 'remote', 'add', 'origin', origin)
git(repo, 'push', '-q', '-u', 'origin', 'master')

// ---------------------------------------------------------------- a `gh` that answers offline

const statePath = join(repo, '.git', 'paneforge-lanes.json')
const beatsPath = join(root, 'beats.txt')
const stubDir = join(root, 'bin')
mkdirSync(stubDir, { recursive: true })

// Every call writes down what the release lock said at that moment. The second call is the
// one that reports a workflow run, so publishFallback stops there instead of building.
writeFileSync(
  join(stubDir, 'gh-stub.mjs'),
  [
    "import { appendFileSync, readFileSync } from 'node:fs'",
    'let at = 0',
    'try {',
    "  at = JSON.parse(readFileSync(process.env.PF_STATE, 'utf8')).release?.at ?? 0",
    '} catch {}',
    'appendFileSync(process.env.PF_BEATS, `${at}\\n`)',
    "const calls = readFileSync(process.env.PF_BEATS, 'utf8').trim().split('\\n').length",
    "console.log(calls >= 2 ? JSON.stringify([`v${process.env.PF_VERSION}`]) : '[]')",
    ''
  ].join('\n')
)
writeFileSync(join(stubDir, 'gh.cmd'), `@echo off\r\nnode "%~dp0gh-stub.mjs" %*\r\n`)
writeFileSync(join(stubDir, 'gh'), `#!/bin/sh\nexec node "$(dirname "$0")/gh-stub.mjs" "$@"\n`)
try {
  chmodSync(join(stubDir, 'gh'), 0o755)
} catch {
  /* Windows has no execute bit */
}
writeFileSync(beatsPath, '')

const env = {
  ...process.env,
  PATH: stubDir + delimiter + process.env.PATH,
  Path: stubDir + delimiter + (process.env.Path ?? process.env.PATH),
  PF_STATE: statePath,
  PF_BEATS: beatsPath,
  PF_VERSION: '0.0.2'
}

const lane = (...args) => {
  try {
    return {
      ok: true,
      out: execFileSync(process.execPath, [join(repo, 'scripts', 'lane.mjs'), ...args], {
        cwd: repo,
        encoding: 'utf8',
        stdio: 'pipe',
        env
      }).trim()
    }
  } catch (e) {
    return { ok: false, out: (e.stdout ?? '').toString().trim(), err: (e.stderr ?? '').toString().trim() }
  }
}

// ---------------------------------------------------------------- one lane, one release

const claimed = JSON.parse(lane('claim', '--session', 'builder', '--prefer', 'a').out)
git(claimed.dir, 'config', 'user.email', 'test@example.com')
git(claimed.dir, 'config', 'user.name', 'test')
writeFileSync(join(claimed.dir, 'feature.js'), 'export const feature = 1\n')
git(claimed.dir, 'add', '-A')
git(claimed.dir, 'commit', '-qm', 'feat: something to release')

const r = lane('ready', '--session', 'builder')
ok('the release went out', /Released v0\.0\.2/.test(r.out), `${r.out}\n${r.err ?? ''}`)

const beats = readFileSync(beatsPath, 'utf8').trim().split('\n').filter(Boolean).map(Number)
ok('the build asked GitHub more than once', beats.length >= 2, JSON.stringify(beats))

const moved = beats.length >= 2 ? beats[beats.length - 1] - beats[0] : 0
ok(
  'and the release lock was refreshed while it worked',
  moved >= 10_000,
  `lock moved ${moved}ms across the build - without a heartbeat this is 0 and the lock ages out under a live release`
)

const after = JSON.parse(readFileSync(statePath, 'utf8'))
ok('the lock is released at the end, not left beating', after.release === null, JSON.stringify(after.release))

console.log(failed ? `\n${failed} release-lock check(s) failed` : '\nall release-lock checks passed')
process.exit(failed ? 1 : 0)
