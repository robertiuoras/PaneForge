// Regression test for provider-specific visitor detection in scripts/lane-hook.mjs.
//
// Claude transcripts live beneath a project slug. Codex transcripts live beneath a
// date, so treating their parent directory as a Claude slug sends every Codex chat to a
// visitor lane. Codex's first session_meta row is the durable source of its start cwd.

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installLane } from './lane-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// Canonicalise /var -> /private/var on macOS so the Claude slug exactly matches repoOf.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'paneforge-lane-visitor-test-')))

let failed = 0
const ok = (name, condition, detail = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${name}`)
  if (!condition) {
    failed++
    if (detail) console.log(`      ${detail}`)
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

function makeRepo(name) {
  const repo = join(root, name)
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name, version: '0.0.1' }) + '\n')
  writeFileSync(join(repo, '.lanes.json'), JSON.stringify({ lanes: true, release: 'merge' }) + '\n')
  writeFileSync(join(repo, 'app.js'), 'console.log(1)\n')
  installLane(here, repo)
  copyFileSync(join(here, 'lane-hook.mjs'), join(repo, 'scripts', 'lane-hook.mjs'))
  git(repo, 'init', '-q', '-b', 'master')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'first')
  git(repo, 'tag', 'v0.0.1')
  return repo
}

function runCase(name, provider, homeIsRepo, readableCodexHeader = true) {
  const repo = makeRepo(name)
  // Deliberately not a name prefixed by the current repo: Claude's historical slug rule
  // treats sibling lane names (`repo-a`) as home checkouts.
  const foreign = makeRepo(`other-${name}`)
  const home = homeIsRepo ? repo : foreign
  const session = `${provider}-${homeIsRepo ? 'home' : 'visitor'}`
  let transcript

  if (provider === 'codex') {
    transcript = join(root, 'sessions', '2026', '09', '07', `${session}.jsonl`)
    mkdirSync(dirname(transcript), { recursive: true })
    writeFileSync(
      transcript,
      readableCodexHeader
        ? JSON.stringify({ type: 'session_meta', payload: { id: session, cwd: home, timestamp: '2026-09-07T00:00:00.000Z' } }) + '\n'
        : 'not readable JSON\n'
    )
  } else {
    const slug = home.replace(/[^A-Za-z0-9-]/g, '-')
    transcript = join(root, 'projects', slug, `${session}.jsonl`)
    mkdirSync(dirname(transcript), { recursive: true })
    writeFileSync(transcript, '')
  }

  let result
  try {
    result = execFileSync(process.execPath, [join(repo, 'scripts', 'lane-hook.mjs'), '--event=prompt'], {
      cwd: repo,
      encoding: 'utf8',
      input: JSON.stringify({ session_id: session, cwd: repo, transcript_path: transcript, prompt: 'hello' }),
      stdio: 'pipe',
      env: { ...process.env, PANEFORGE_REPO: repo, LANE_REGISTRY: join(root, `${name}.registry.json`) }
    })
  } catch (error) {
    result = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  const state = JSON.parse(readFileSync(join(repo, '.git', 'paneforge-lanes.json'), 'utf8'))
  const held = Object.entries(state.lanes).find(([, hold]) => hold.session === session)
  const [lane, hold] = held ?? []
  const expectedVisitor = provider === 'codex' && !readableCodexHeader ? false : !homeIsRepo
  const label = !readableCodexHeader ? `${provider} unreadable date header` : `${provider} ${homeIsRepo ? 'home' : 'visitor'}`
  const expectedLane = expectedVisitor ? 'a' : 'main'
  ok(`${label} claims ${expectedLane}`, lane === expectedLane, result)
  ok(`${label} visitor flag`, Boolean(hold?.visitor) === expectedVisitor, JSON.stringify(hold))
}

runCase('codex-home', 'codex', true)
runCase('codex-visitor', 'codex', false)
runCase('codex-unreadable', 'codex', false, false)
runCase('claude-home', 'claude', true)
runCase('claude-visitor', 'claude', false)

rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
if (failed) process.exit(1)
console.log('all lane visitor checks passed')
