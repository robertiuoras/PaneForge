#!/usr/bin/env node
// Retries a command on a TRANSIENT GitHub API failure, never on anything else.
//
// The release workflow's "Build and publish" step (electron-builder --publish always)
// and the two `gh release` steps that follow it all talk to api.github.com with no
// retry of their own. GitHub's API returns 503 on genuine transient outages often
// enough that this job failed 8 times in one window with nothing wrong in the build -
// `.github/workflows/release.yml:65`. Wrapping the command here, rather than patching
// electron-builder or teaching every `gh` call its own loop, is the one change that
// covers both call sites without touching the tool that actually talks to GitHub.
//
// Usage: node scripts/retry-transient.mjs -- <command> [args...]
//
// Retries only when the failing run's combined stdout+stderr matches a transient
// signature (503/502/500/429, or a dropped connection) - anything else (a real build
// error, a bad signing cert, a typecheck failure) fails on the first attempt, exactly
// as it does today.

import { spawnSync } from 'node:child_process'

const sep = process.argv.indexOf('--')
if (sep === -1 || sep === process.argv.length - 1) {
  console.error('usage: retry-transient.mjs -- <command> [args...]')
  process.exit(2)
}
const cmd = process.argv[sep + 1]
const args = process.argv.slice(sep + 2)

const MAX_ATTEMPTS = Number(process.env.PF_RETRY_ATTEMPTS || 5)
const BASE_MS = Number(process.env.PF_RETRY_BASE_MS || 2000)
const CAP_MS = Number(process.env.PF_RETRY_CAP_MS || 30000)

const TRANSIENT = /\b(50[023])\b|\b429\b|service unavailable|econnreset|etimedout|socket hang up/i

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const r = spawnSync(cmd, args, { stdio: ['inherit', 'pipe', 'pipe'] })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  process.stdout.write(r.stdout ?? '')
  process.stderr.write(r.stderr ?? '')

  if (r.status === 0) process.exit(0)

  const transient = TRANSIENT.test(out)
  if (!transient || attempt === MAX_ATTEMPTS) {
    process.exit(r.status ?? 1)
  }

  const delay = Math.min(BASE_MS * 2 ** (attempt - 1), CAP_MS)
  console.error(`retry-transient: attempt ${attempt}/${MAX_ATTEMPTS} hit a transient error, retrying in ${delay}ms`)
  sleep(delay)
}
