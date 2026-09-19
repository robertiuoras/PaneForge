// Guards the fix in 4f7be26 (fix(release): retry the asset upload instead of failing a
// build that already succeeded).
//
// Production, 2026-08-15T23:32:07Z, `Release: build (macos-14, --mac)`:
//   Upload update feed and versioned artifacts
//   HTTP 504: We couldn't respond to your request in time. Sorry about that. Please try
//   resubmitting your request and contact us if the problem persists.
//   (https://api.github.com/repos/robertiuoras/PaneForge/releases/assets/516195268)
//
// GitHub's asset-upload endpoint is transiently flaky; a single `gh release upload` call
// with no retry turns one 504 into a failed build for a version that had already compiled
// (this exact run). `.github/workflows/release.yml` wraps both upload steps in a
// three-try, backing-off loop for exactly that reason. This test reads the SHIPPING
// workflow text and fails if either upload step regresses back to a bare, unretried call.
// The upload fragments are also executed below with shell stubs for GitHub and sleep. Confirmed to fail against the pre-4f7be26 file (a bare `gh release upload ... &&`
// with no loop around it).
//
//   node scripts/release-upload-retry-test.mjs

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const yml = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')

let failed = 0
const ok = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`)
  }
}

// Split into `run:` blocks so each upload step is checked against its own text, not the
// whole file - a retry loop present ANYWHERE in the file must not hide a bare call in the
// step that actually needs it.
const steps = yml.split(/^\s*- name: /m).slice(1)
const findStep = (title) => steps.find((s) => s.startsWith(title))

for (const title of ['Upload update feed and versioned artifacts', 'Upload fixed-name copies']) {
  const step = findStep(title)
  ok(`step "${title}" exists`, !!step)
  if (!step) continue

  ok(`"${title}" retries the upload (a loop, not a single call)`, /for try in .*; do[\s\S]*?gh release upload/.test(step))

  ok(`"${title}" backs off between attempts`, /sleep \$?\(?\(?try/.test(step))

  ok(`"${title}" uploads idempotently (--clobber)`, /gh release upload[^\n]*--clobber/.test(step))

  // The bug this guards: a step whose only `gh release upload` call sits OUTSIDE any
  // retry loop. Match every upload call and confirm none of them precede the first
  // `for try` in the step (i.e. none are unguarded).
  const firstLoop = step.search(/for try in/)
  const uploads = [...step.matchAll(/gh release upload/g)].map((m) => m.index)
  ok(
    `"${title}" has no upload call outside the retry loop`,
    uploads.length > 0 && firstLoop !== -1 && uploads.every((i) => i > firstLoop)
  )
}

// Execute the shipping shell, substituting only its external effects. This catches a
// loop that exists syntactically but stops retrying or reports exhausted attempts as success.
for (const title of ['Upload update feed and versioned artifacts', 'Upload fixed-name copies']) {
  const step = findStep(title)
  if (!step) continue
  const run = step.split('run: |\n')[1]
    ?.split('\n').map((line) => line.replace(/^          /, '')).join('\n')
  const start = run?.indexOf(title.includes('versioned') ? 'upload() {' : 'for try in 1 2 3; do') ?? -1
  ok(`"${title}" has an executable upload fragment`, start >= 0)
  if (start < 0) continue
  // Stop at the next workflow comment outside the run block.
  const fragment = run.slice(start).split(/\n\s{0,6}# One job|\n      # electron-builder/)[0]
  for (const [failures, attempts, succeeds] of [[0, 1, true], [1, 2, true], [3, 3, false]]) {
    const script = `set -euo pipefail
version=test
files=(artifact.zip)
calls=0
gh() {
  calls=$((calls + 1))
  printf 'CALL %s\\n' "$*"
  [ "$calls" -gt "${failures}" ]
}
sleep() { printf 'WAIT %s\\n' "$1"; }
${fragment}
`
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 5000 })
    const calls = result.stdout?.split('\n').filter((line) => line.startsWith('CALL ')) || []
    ok(`"${title}" ${failures} failures: ${attempts} attempts and ${succeeds ? 'success' : 'failure'}`,
      !result.error && (result.status === 0) === succeeds && calls.length === attempts,
      result.stderr || String(result.error || result.status))
    ok(`"${title}" each attempt stays idempotent`, calls.every((line) => line.includes('--clobber')))
    if (failures === 1) ok(`"${title}" waits before retry`, result.stdout.includes('WAIT 20'))
  }
}

console.log(failed ? `\n${failed} failed` : '\nall good')
process.exit(failed ? 1 : 0)
