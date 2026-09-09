// A staged build applied at the one moment nothing can be lost, and the five times it
// must not be.
//
//   node scripts/launch-install-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const OUT = join(ROOT, 'node_modules', '.pf-test')
mkdirSync(OUT, { recursive: true })
const outfile = join(OUT, 'launch-install.mjs')
buildSync({
  entryPoints: [join(ROOT, 'src/shared/launchInstall.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node'
})
const { MAX_TRIES, applyAtLaunch } = await import(pathToFileURL(outfile).href)

let failed = 0
const ok = (what, cond, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${extra ? ` - ${extra}` : ''}`)
}

// The night it was written for: 0.8.207 staged 2026-09-08T02:28:31Z, relaunch at
// 2026-09-09T02:30:34Z came up as v0.8.206 anyway.
const fresh = { staged: '0.8.207', newer: true, windows: 0, tries: 0, canSwap: true }
ok('a staged build on a fresh process is applied', applyAtLaunch(fresh) === 'go')

ok('nothing staged is nothing to do', applyAtLaunch({ ...fresh, staged: '' }) === 'nothing is staged')
ok(
  'a staged build older than the one running is not installed over it',
  applyAtLaunch({ ...fresh, newer: false }) === 'the staged build is not newer'
)
// The whole safety of this: it happens before anything exists. A window means a pane may
// be restoring or an agent may be mid-turn, and the quit path has always covered that.
ok(
  'a window already on screen sends it back to the quit path',
  applyAtLaunch({ ...fresh, windows: 1 }) === 'a window is already open'
)
ok(
  'an install that has already failed twice is not tried a third time',
  applyAtLaunch({ ...fresh, tries: MAX_TRIES }) === 'it has already failed twice'
)
ok('one earlier failure is still worth a go', applyAtLaunch({ ...fresh, tries: 1 }) === 'go')
ok(
  'a copy that cannot be replaced is left alone',
  applyAtLaunch({ ...fresh, canSwap: false }) === 'this copy cannot be replaced'
)
// Every refusal must be a sentence somebody can read in updater.log.
for (const s of [
  { ...fresh, staged: '' },
  { ...fresh, newer: false },
  { ...fresh, windows: 2 },
  { ...fresh, tries: 9 },
  { ...fresh, canSwap: false }
]) {
  const v = applyAtLaunch(s)
  ok(`"${v}" reads as a reason, not a code`, / /.test(v) && v !== 'go')
}

// The wiring, in the one place a staged bundle is adopted.
const updater = readFileSync(new URL('../src/main/updater.ts', import.meta.url), 'utf8')
ok('the launch path asks before it acts', /applyAtLaunch\(/.test(updater))
ok('...counts the attempt first, so a swap that does not take is bounded', /recordInstallAttempt\([\s\S]{0,120}swapAndRelaunch\(true\)/.test(updater))
ok('...and every answer, including a refusal, reaches updater.log', /log\('launch install'/.test(updater))
ok('the window count is read from electron, not assumed', /getAllWindows\(\)\.length/.test(updater))

console.log(failed ? `\n${failed} failed` : '\nlaunch install: all good')
process.exit(failed ? 1 : 0)
