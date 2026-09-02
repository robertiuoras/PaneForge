// Proves the release workflow's retry wrapper (scripts/retry-transient.mjs) does the
// one thing it exists for: survive a transient GitHub 503 without hiding a real failure.
//
// This is the RED case for the incident - before the wrapper existed, a helper that
// fails twice with "HttpError: 503 Service Unavailable" and then succeeds on the third
// try reproduces exactly what the release job did 8 times in one window: a good build,
// no code problem, job red anyway. Run this file directly (undoing the fix, e.g. by
// exiting after one attempt) to see it fail.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const wrapper = join(root, 'scripts', 'retry-transient.mjs')

const dir = mkdtempSync(join(tmpdir(), 'pf-retry-'))
let failures = 0

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    failures++
  }
}

function fastEnv() {
  // Real GitHub outages need real backoff; the test needs neither.
  return { ...process.env, PF_RETRY_BASE_MS: '1', PF_RETRY_CAP_MS: '1', PF_RETRY_ATTEMPTS: '5' }
}

// Helper: fails with a transient GitHub signature until a counter file says otherwise.
const transientHelper = join(dir, 'transient.mjs')
writeFileSync(
  transientHelper,
  `
  import { readFileSync, writeFileSync, existsSync } from 'node:fs'
  const counterFile = process.argv[2]
  let n = existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8')) : 0
  n++
  writeFileSync(counterFile, String(n))
  if (n < 3) {
    console.error('HttpError: 503 Service Unavailable')
    process.exit(1)
  }
  console.log('published on attempt ' + n)
  `
)

// Case 1: two transient failures then a real success - must retry and end up green.
{
  const counter = join(dir, 'counter1.txt')
  const r = spawnSync(process.execPath, [wrapper, '--', process.execPath, transientHelper, counter], {
    encoding: 'utf8',
    env: fastEnv()
  })
  assert(r.status === 0, `expected the wrapper to eventually succeed, got exit ${r.status}\n${r.stdout}${r.stderr}`)
  assert(r.stdout.includes('published on attempt 3'), 'expected the real success output to reach the caller')
  assert((r.stderr.match(/retrying in/g) || []).length === 2, 'expected exactly 2 retries for 2 transient failures')
}

// Helper: fails with an ordinary, non-transient error every time (a real build bug).
const permanentHelper = join(dir, 'permanent.mjs')
writeFileSync(permanentHelper, `console.error('TypeError: cannot read property of undefined'); process.exit(1)`)

// Case 2: a real failure must not be retried - it should fail on the very first attempt.
{
  const r = spawnSync(process.execPath, [wrapper, '--', process.execPath, permanentHelper], {
    encoding: 'utf8',
    env: fastEnv()
  })
  assert(r.status !== 0, 'expected the wrapper to fail on a real error')
  assert(!/retrying in/.test(r.stderr), 'a non-transient error must not be retried')
}

// Case 3: a transient failure that NEVER clears must still fail, capped at PF_RETRY_ATTEMPTS.
const alwaysTransientHelper = join(dir, 'always-transient.mjs')
writeFileSync(alwaysTransientHelper, `console.error('HttpError: 503 Service Unavailable'); process.exit(1)`)
{
  const r = spawnSync(process.execPath, [wrapper, '--', process.execPath, alwaysTransientHelper], {
    encoding: 'utf8',
    env: { ...fastEnv(), PF_RETRY_ATTEMPTS: '3' }
  })
  assert(r.status !== 0, 'expected the wrapper to give up eventually')
  assert((r.stderr.match(/retrying in/g) || []).length === 2, 'expected 2 retries before the 3rd and final attempt')
}

rmSync(dir, { recursive: true, force: true })

if (failures) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('retry-transient: ok')
