// One command that walks a dev release from "master looks good" to a pushed tag: refuse
// on a dirty tree or a master behind origin, typecheck, run the real PC suite (never a
// local fake), and only then bump/tag/push. It never runs itself - `npm run release:dev`
// stops after printing what it found unless Robert has already said to release, which is
// why `--yes-robert-asked` is required rather than assumed (`docs/claude-md-full-2026-09-19.md`
// "Releasing happens when Robert asks, and not before").
//
// The PC suite is a GuardDeck compute job: `node scripts/test-remote.mjs` can come back
// three ways - exit 0 with a pass line (done), exit 75 printing `{"id": "..."}` (queued,
// poll `rbuild.mjs --status <id>` until it stops being 75), or a genuine failure. GuardDeck
// sometimes reports a job `status: "failed: Root process exited while descendants
// remained"` even though every test passed and the exit code was 0 - the job runner's own
// process-tree bookkeeping, not the suite. So the verdict here is ONLY exit code 0 AND a
// `<N> tests passed` line with no `FAIL` line anywhere in the captured output; the status
// string is never consulted.
//
//   node scripts/release-dev.mjs --yes-robert-asked
//   node scripts/release-dev-test.mjs   - pure-logic checks, no network, in test-all.mjs

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const RBUILD = join(process.env.HOME ?? '', 'Projects', 'claude-memory', 'claude-config', 'rbuild.mjs')
const PC_HOST = 'Gamer@100.78.1.77'
const POLL_MS = 20_000
const MAX_POLLS = 90 // 30 minutes

// ---------------------------------------------------------------- pure, tested elsewhere

/** `git status --porcelain` output -> true when anything is uncommitted. */
export function treeIsDirty(porcelain) {
  return porcelain.trim().length > 0
}

/** `git rev-list --count HEAD..origin/master` output -> true when local master trails origin. */
export function masterIsBehind(revListCount) {
  const n = Number(revListCount.trim())
  return Number.isFinite(n) && n > 0
}

/** The first `{"id": ...}` JSON object in rbuild's stdout, or null. */
export function extractJobId(output) {
  const matches = output.match(/\{[^{}]*"id"\s*:\s*"[^"]+"[^{}]*\}/g)
  if (!matches) return null
  try {
    return JSON.parse(matches[matches.length - 1]).id ?? null
  } catch {
    return null
  }
}

/**
 * The verdict this whole script exists to get right: exit code 0 AND an explicit
 * `<N> tests passed` line AND no `FAIL` line anywhere - never the job runner's own
 * "status" string, which is known to say `failed` on a run that fully passed
 * (rbuild's "Root process exited while descendants remained").
 */
export function suitePassed(exitCode, output) {
  if (exitCode !== 0) return false
  if (/^FAIL/m.test(output)) return false
  return /\b\d+ tests passed\b/.test(output)
}

// ------------------------------------------------------------------------------ refusals

function refuse(reason) {
  console.error(`release:dev refused: ${reason}`)
  process.exit(1)
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts })
}

async function main() {
  if (!process.argv.includes('--yes-robert-asked')) {
    refuse('needs --yes-robert-asked - a release happens on Robert\'s explicit word, never inferred')
  }
  if (!process.env.CLAUDE_SESSION_ID) {
    refuse('CLAUDE_SESSION_ID is unset - the PC job cannot be attributed to this session')
  }

  const status = run('git', ['status', '--porcelain'])
  if (status.status !== 0) refuse(`git status failed: ${status.stderr}`)
  if (treeIsDirty(status.stdout)) refuse('working tree is dirty - commit or stash first')

  const fetch = run('git', ['fetch', '-q', 'origin'])
  if (fetch.status !== 0) refuse(`git fetch origin failed: ${fetch.stderr}`)
  const behind = run('git', ['rev-list', '--count', 'HEAD..origin/master'])
  if (behind.status !== 0) refuse(`git rev-list failed: ${behind.stderr}`)
  if (masterIsBehind(behind.stdout)) refuse('master is behind origin - merge origin/master first')

  console.log('release:dev - typecheck')
  const typecheck = spawnSync('npm', ['run', 'typecheck'], { cwd: root, stdio: 'inherit' })
  if ((typecheck.status ?? 1) !== 0) refuse('typecheck failed')

  console.log('release:dev - PC suite (scripts/test-remote.mjs)')
  const suite = await runSuite()
  if (!suite.ok) refuse(`PC suite did not pass: ${suite.reason}`)
  console.log('release:dev - PC suite passed')

  console.log('release:dev - npm version patch')
  const version = execFileSync('npm', ['version', 'patch', '-m', 'chore(release): %s'], { cwd: root, encoding: 'utf8' }).trim()
  const tag = version.trim()

  console.log('release:dev - git push')
  const push = run('git', ['push'])
  if (push.status !== 0) refuse(`git push failed after the version bump landed locally: ${push.stderr}. Fix the remote and push ${tag} by hand.`)

  console.log(`release:dev - git push origin ${tag}`)
  const pushTag = run('git', ['push', 'origin', tag])
  if (pushTag.status !== 0) refuse(`git push origin ${tag} failed: ${pushTag.stderr}`)

  console.log('release:dev - gh run list')
  spawnSync('gh', ['run', 'list', '--repo', 'robertiuoras/PaneForge', '--limit', '1'], { cwd: root, stdio: 'inherit' })
}

/** Runs `scripts/test-remote.mjs`, following a queued GuardDeck job to completion. */
async function runSuite() {
  const first = spawnChild([join(root, 'scripts', 'test-remote.mjs')])
  let { exitCode, output } = await first
  if (exitCode !== 75) return verdictFrom(exitCode, output)

  const id = extractJobId(output)
  if (!id) return { ok: false, reason: 'queued (exit 75) but no job id in output' }
  console.log(`release:dev - PC suite queued as ${id}, polling every ${POLL_MS / 1000}s`)

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    const poll = await spawnChild([RBUILD, '--status', id])
    if (poll.exitCode === 75) continue
    // The job runner's status line is untrusted (see file header); read the log itself.
    const log = readRemoteLog(id)
    return verdictFrom(poll.exitCode, `${output}\n${poll.output}\n${log}`)
  }
  return { ok: false, reason: `job ${id} still queued after ${(MAX_POLLS * POLL_MS) / 60_000} minutes` }
}

function verdictFrom(exitCode, output) {
  if (suitePassed(exitCode, output)) return { ok: true }
  return { ok: false, reason: `exit ${exitCode}, ${/FAIL/.test(output) ? 'FAIL line present' : 'no pass line found'}` }
}

function readRemoteLog(id) {
  const path = `C:\\Users\\Gamer\\.claude\\guarddeck\\compute\\${id}\\output.log`
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', PC_HOST, `powershell -NoProfile -Command \"Get-Content ${path} -Tail 40\"`], { encoding: 'utf8', timeout: 20_000 })
  return r.stdout ?? ''
}

function spawnChild(args) {
  return new Promise((resolve) => {
    const kid = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    kid.stdout.on('data', (b) => (output += b))
    kid.stderr.on('data', (b) => (output += b))
    kid.on('close', (exitCode) => resolve({ exitCode: exitCode ?? 1, output }))
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
