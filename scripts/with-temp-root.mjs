// Run one npm script under a temp folder of its own.
//
// `npm run test:lanes` is a chain of ~45 suites run straight from package.json, so it never
// got test-all's one-run-one-temp-root (`TMP_ROOT` there). 20 of those suites build their
// repos at a FIXED path such as `%TEMP%\paneforge-lane-heal-test` and `rmSync` it first, so
// two chats running the chain on one machine delete each other's repos mid-test. On
// 2026-10-04 lane b's run died with EPERM at lane-heal-test.mjs:36 while another checkout's
// copy of the same suite was working inside that folder; nothing was wrong with the code.
// Same fix as test-all: TMPDIR/TEMP/TMP point at a folder this run owns, and nothing in the
// suites changes. The `pf-test-run-` prefix lets test-all's stale-root sweep reclaim one a
// killed run leaves behind.
//
//   node scripts/with-temp-root.mjs <npm script>

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = process.argv[2]
if (!script) {
  console.error('usage: node scripts/with-temp-root.mjs <npm script>')
  process.exit(2)
}
const tmp = mkdtempSync(join(tmpdir(), 'pf-test-run-'))
const run = spawnSync('npm', ['run', script], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp },
})
try {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
} catch (err) {
  console.error(`could not remove ${tmp} (${err.code ?? err.message}); test-all's stale-root sweep removes it later`)
}
if (run.error) console.error(`could not start npm: ${run.error.message}`)
process.exit(run.status ?? 1)
