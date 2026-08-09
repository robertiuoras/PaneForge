// Regression coverage for `node scripts/lane.mjs promote` - the only door from the dev
// channel to a stable install.
//
// Every automatic release is now cut as a GitHub prerelease. Installs opted into the dev
// channel take it within the half hour; everyone else's updater resolves
// /releases/latest, which GitHub keeps pointed at the newest PROMOTED release - and
// nothing moves there until `promote` says a named build proved itself. That makes this
// command the one place two real incidents (v0.7.2 shipped Windows-only, v0.4.27 served a
// latest.yml naming the wrong-size installer) get checked for BEFORE a release reaches
// everybody rather than after. `promote()` in scripts/lane.mjs refuses, by name, each of
// the ways a build can look finished and not be:
//
//   no GitHub publish config at all
//   the named version (or the newest release) does not exist, is a draft, or is already
//     promoted
//   either platform's feed (latest.yml / latest-mac.yml) is missing from the release
//   a feed names an asset that is not on the release, or disagrees with its real size -
//     exactly what breaks every install's hash check silently on somebody else's machine
//   the edit did not actually take: /releases/latest is re-read afterwards and must name
//     the tag just promoted
//
// This drives the real `lane.mjs promote` against a throwaway git repo with a stubbed
// `gh` on PATH (same shape as lane-lock-test.mjs), so nothing here touches the network.
// The stub answers from a JSON scenario file rewritten before each case and logs every
// call it received, so a case can assert both on what promote PRINTED and on whether it
// ever reached `gh release edit` - a refusal that still edits the release is the failure
// this exists to catch.
//
//   node scripts/promote-test.mjs

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE = join(repoRoot, 'scripts', 'lane.mjs')

const root = join(tmpdir(), 'paneforge-promote-test')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })

let failed = 0
let total = 0
const ok = (name, cond, detail) => {
  total++
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!cond) {
    failed++
    if (detail) console.log(`      ${detail}`)
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

function buildRepo(name, extra) {
  const repo = join(root, name)
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.2', ...extra }, null, 2) + '\n')
  writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ release: 'version' }, null, 2) + '\n')
  git(repo, 'init', '-q', '-b', 'master')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  return repo
}

const repoPub = buildRepo('with-publish', { build: { publish: [{ provider: 'github', owner: 'o', repo: 'r' }] } })
const repoNoPub = buildRepo('no-publish', {})

// ---------------------------------------------------------------- a `gh` fed by scenarios

const stubDir = join(root, 'bin')
mkdirSync(stubDir, { recursive: true })

// One stub, driven entirely by the scenario JSON its env var points at, so every case
// below is just a different scenario rather than a different fake binary.
writeFileSync(
  join(stubDir, 'gh-stub.mjs'),
  [
    "import { appendFileSync, readFileSync } from 'node:fs'",
    'const args = process.argv.slice(2)',
    "appendFileSync(process.env.PF_GH_LOG, JSON.stringify(args) + '\\n')",
    'let scenario = {}',
    "try { scenario = JSON.parse(readFileSync(process.env.PF_GH_SCENARIO, 'utf8')) } catch {}",
    'const a0 = args[0]',
    "const a1 = args[1] ?? ''",
    "if (a0 === 'api' && a1.includes('/releases/latest')) {",
    "  process.stdout.write(scenario.latestAfterEdit ?? '')",
    '  process.exit(0)',
    "} else if (a0 === 'api' && a1.includes('/releases?per_page=')) {",
    '  process.stdout.write(JSON.stringify(scenario.releases ?? []))',
    '  process.exit(0)',
    "} else if (a0 === 'api' && a1.includes('/releases/tags/')) {",
    "  const tag = a1.split('/releases/tags/')[1]",
    '  const rel = (scenario.releases ?? []).find((r) => r.tag_name === tag)',
    '  if (!rel) process.exit(1)',
    '  process.stdout.write(JSON.stringify(rel))',
    '  process.exit(0)',
    "} else if (a0 === 'release' && a1 === 'view') {",
    '  process.stdout.write(JSON.stringify({ assets: scenario.assets ?? [] }))',
    '  process.exit(0)',
    "} else if (a0 === 'release' && a1 === 'download') {",
    "  const pIdx = args.indexOf('-p')",
    "  const name = pIdx >= 0 ? args[pIdx + 1] : ''",
    '  const feed = scenario.feeds ? scenario.feeds[name] : undefined',
    '  if (feed == null) process.exit(1)',
    '  process.stdout.write(feed)',
    '  process.exit(0)',
    "} else if (a0 === 'release' && a1 === 'edit') {",
    '  process.exit(0)',
    '} else {',
    '  process.exit(1)',
    '}',
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

const logPath = join(root, 'gh-log.txt')
const scenarioPath = join(root, 'scenario.json')

/** Run `promote` for real, against `repo`, with `gh` answering from `scenario`. */
function promote(repo, versionArg, scenario) {
  writeFileSync(logPath, '')
  writeFileSync(scenarioPath, JSON.stringify(scenario))
  const env = {
    ...process.env,
    PATH: stubDir + delimiter + process.env.PATH,
    Path: stubDir + delimiter + (process.env.Path ?? process.env.PATH),
    PF_GH_LOG: logPath,
    PF_GH_SCENARIO: scenarioPath
  }
  const args = ['promote', ...(versionArg ? [versionArg] : []), '--repo', repo]
  let out = ''
  try {
    out = execFileSync(process.execPath, [ENGINE, ...args], { encoding: 'utf8', stdio: 'pipe', env }).trim()
  } catch (e) {
    out = `${(e.stdout ?? '').toString()}${(e.stderr ?? '').toString()}`.trim()
  }
  const log = existsSync(logPath)
    ? readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
  const edited = log.some((a) => a[0] === 'release' && a[1] === 'edit')
  return { out, log, edited }
}

const feed = (file, size) => `files:\n  - url: ${file}\n    size: ${size}\npath: ${file}\n`

// ---------------------------------------------------------------- 1. happy path

{
  const r = promote(repoPub, '', {
    releases: [{ tag_name: 'v0.0.2', draft: false, prerelease: true }],
    assets: [
      { name: 'latest.yml', size: 500 },
      { name: 'latest-mac.yml', size: 500 },
      { name: 'app-Setup.exe', size: 111 },
      { name: 'app.zip', size: 222 }
    ],
    feeds: { 'latest.yml': feed('app-Setup.exe', 111), 'latest-mac.yml': feed('app.zip', 222) },
    latestAfterEdit: 'v0.0.2'
  })
  ok('a clean prerelease with both feeds matching promotes', /Promoted v0\.0\.2\./.test(r.out), r.out)
  ok('and it really edited the release, not just printed success', r.edited, JSON.stringify(r.log))
  ok(
    'the edit asked for stable + latest',
    r.log.some((a) => a[0] === 'release' && a[1] === 'edit' && a.includes('--prerelease=false') && a.includes('--latest')),
    JSON.stringify(r.log)
  )
}

// ---------------------------------------------------------------- 2. a missing feed

{
  const r = promote(repoPub, '', {
    releases: [{ tag_name: 'v0.0.2', draft: false, prerelease: true }],
    assets: [
      { name: 'latest.yml', size: 500 },
      { name: 'app-Setup.exe', size: 111 }
    ],
    feeds: { 'latest.yml': feed('app-Setup.exe', 111) },
    latestAfterEdit: 'v0.0.2'
  })
  ok('a release missing latest-mac.yml is refused', /Not promoted:/.test(r.out) && /latest-mac\.yml/.test(r.out), r.out)
  ok('and never touches the release', !r.edited, JSON.stringify(r.log))
}

// ---------------------------------------------------------------- 3. a feed lying about size

{
  const r = promote(repoPub, '', {
    releases: [{ tag_name: 'v0.0.2', draft: false, prerelease: true }],
    assets: [
      { name: 'latest.yml', size: 500 },
      { name: 'latest-mac.yml', size: 500 },
      { name: 'app-Setup.exe', size: 999 },
      { name: 'app.zip', size: 222 }
    ],
    // Declares 111 bytes; the asset really being served is 999 - every update's hash
    // check would fail exactly like v0.4.27 did.
    feeds: { 'latest.yml': feed('app-Setup.exe', 111) },
    latestAfterEdit: 'v0.0.2'
  })
  ok('a feed whose declared size disagrees with the real asset is refused', /Not promoted:/.test(r.out) && /hash check/.test(r.out), r.out)
  ok('and never touches the release', !r.edited, JSON.stringify(r.log))
}

// ---------------------------------------------------------------- 4. newest already promoted

{
  const r = promote(repoPub, '', {
    releases: [{ tag_name: 'v0.0.2', draft: false, prerelease: false }]
  })
  ok(
    'a newest release that is already stable is refused, not re-promoted',
    /Not promoted:/.test(r.out) && /already promoted/.test(r.out),
    r.out
  )
  ok('and never touches the release', !r.edited, JSON.stringify(r.log))
}

// ---------------------------------------------------------------- 5. a named version already promoted

{
  const r = promote(repoPub, '0.0.1', {
    releases: [{ tag_name: 'v0.0.1', draft: false, prerelease: false }]
  })
  ok('a named version that is already stable is refused the same way', /Not promoted:/.test(r.out) && /already promoted/.test(r.out), r.out)
  ok('and never touches the release', !r.edited, JSON.stringify(r.log))
}

// ---------------------------------------------------------------- 6. no publish config at all

{
  const r = promote(repoNoPub, '', {})
  ok('a repo with no GitHub publish config is refused before any gh call', /Not promoted:/.test(r.out) && /publish config/.test(r.out), r.out)
  ok('and gh is never even invoked', r.log.length === 0, JSON.stringify(r.log))
}

// ---------------------------------------------------------------- auto-promote (retry timer)
//
// Stable follows the big-company channel shape: the newest dev build promotes ITSELF once
// it has soaked PF_PROMOTE_SOAK_MS with nothing shipped on top of it. These drive the real
// `lane.mjs retry` (the command the app's minute timer calls) and assert the four moments
// that matter: a young build waits, a soaked build promotes, a soaked-but-broken build is
// refused by the same checks a hand promotion gets, and the releases lookup is throttled.

/** Run `retry` for real. Repos here carry a tag matching package.json so autoship no-ops. */
function retry(repo, scenario, envExtra = {}) {
  writeFileSync(logPath, '')
  writeFileSync(scenarioPath, JSON.stringify(scenario))
  const env = {
    ...process.env,
    PATH: stubDir + delimiter + process.env.PATH,
    Path: stubDir + delimiter + (process.env.Path ?? process.env.PATH),
    PF_GH_LOG: logPath,
    PF_GH_SCENARIO: scenarioPath,
    PF_PROMOTE_SOAK_MS: String(3 * 24 * 60 * 60 * 1000),
    PF_PROMOTE_POLL_MS: '0',
    ...envExtra
  }
  let out = ''
  try {
    out = execFileSync(process.execPath, [ENGINE, 'retry', '--repo', repo], { encoding: 'utf8', stdio: 'pipe', env }).trim()
  } catch (e) {
    out = `${(e.stdout ?? '').toString()}${(e.stderr ?? '').toString()}`.trim()
  }
  const log = existsSync(logPath)
    ? readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
  const edited = log.some((a) => a[0] === 'release' && a[1] === 'edit' && a.includes('--prerelease=false'))
  const looked = log.some((a) => a[0] === 'api' && String(a[1] ?? '').includes('per_page=5'))
  return { out, log, edited, looked }
}

const soakedAt = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString()
const goodRelease = (published_at) => ({
  releases: [{ tag_name: 'v0.0.2', draft: false, prerelease: true, published_at }],
  assets: [
    { name: 'latest.yml', size: 500 },
    { name: 'latest-mac.yml', size: 500 },
    { name: 'app-Setup.exe', size: 111 },
    { name: 'app.zip', size: 222 }
  ],
  feeds: { 'latest.yml': feed('app-Setup.exe', 111), 'latest-mac.yml': feed('app.zip', 222) },
  latestAfterEdit: 'v0.0.2'
})

const repoRetry = buildRepo('retry-repo', { build: { publish: [{ provider: 'github', owner: 'o', repo: 'r' }] } })
git(repoRetry, 'tag', 'v0.0.2')

// 7. a build still soaking waits
{
  const r = retry(repoRetry, goodRelease(new Date().toISOString()))
  ok('a dev build younger than the soak is not promoted', !r.edited, r.out)
  ok('but the channel was looked at', r.looked, JSON.stringify(r.log))
}

// 8. a soaked build promotes by itself
{
  const r = retry(repoRetry, goodRelease(soakedAt))
  ok('a dev build past the soak promotes by itself', r.edited && /Promoted v0\.0\.2 to stable/.test(r.out), r.out)
}

// 9. a soaked build that fails promote's own checks is refused, and says so
{
  const scenario = goodRelease(soakedAt)
  scenario.assets = scenario.assets.filter((a) => a.name !== 'latest-mac.yml')
  delete scenario.feeds['latest-mac.yml']
  const r = retry(repoRetry, scenario)
  ok(
    'a soaked one-legged release is refused by the same checks as a hand promotion',
    !r.edited && /Stable promotion of v0\.0\.2 waits:.*latest-mac\.yml/.test(r.out),
    r.out
  )
}

// 10. a newest release already stable: looked at, left alone, nothing said
{
  const r = retry(repoRetry, {
    releases: [{ tag_name: 'v0.0.2', draft: false, prerelease: false, published_at: soakedAt }]
  })
  ok('a newest release already stable is left alone', !r.edited && !/Promot|promotion/.test(r.out), r.out)
}

// 11. the lookup is throttled between polls
{
  const repoThrottle = buildRepo('retry-throttle', { build: { publish: [{ provider: 'github', owner: 'o', repo: 'r' }] } })
  git(repoThrottle, 'tag', 'v0.0.2')
  const poll = { PF_PROMOTE_POLL_MS: String(60 * 60 * 1000) }
  const first = retry(repoThrottle, goodRelease(new Date().toISOString()), poll)
  const second = retry(repoThrottle, goodRelease(new Date().toISOString()), poll)
  ok('the first retry looks at the channel', first.looked, JSON.stringify(first.log))
  ok('a second retry inside the poll window does not', !second.looked, JSON.stringify(second.log))
}

rmSync(root, { recursive: true, force: true })

if (failed) console.log(`\n${failed} of ${total} promote check(s) failed`)
else console.log(`\npromote-test: ${total} checks passed`)
process.exit(failed ? 1 : 0)
