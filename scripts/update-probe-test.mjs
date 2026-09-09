// A check loop that keeps timing out, counted rather than reported one line at a time.
//
// updater.log, 2026-09-08: 'the update probe did not answer within 120s (online)' at
// 10:17:18 and again at 11:11:17, with ERR_TIMED_OUT at 10:35:38 and 11:12:10 between
// them - 66 minutes with no successful look at the feed, retried every ten minutes, and
// nothing anywhere saying the loop was stuck.
//
//   node scripts/update-probe-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const OUT = join(ROOT, 'node_modules', '.pf-test')
mkdirSync(OUT, { recursive: true })
const outfile = join(OUT, 'update-probe.mjs')
buildSync({
  entryPoints: [join(ROOT, 'src/shared/updateProbe.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node'
})
const { STUCK_AFTER, TIMEOUT_WINDOW_MS, freshRun, noteAnswer, noteTimeout, probeStuck, stuckWords } =
  await import(pathToFileURL(outfile).href)

let failed = 0
const ok = (what, cond, extra = '') => {
  if (!cond) failed++
  console.log(`${cond ? 'ok   ' : 'FAIL '} ${what}${extra ? ` - ${extra}` : ''}`)
}

const T = 1_000_000_000
const MIN = 60_000

ok('a fresh run is not stuck', !probeStuck(freshRun()))

// One timeout is weather: hotel wifi, a laptop coming off a train.
let r = noteTimeout(freshRun(), T)
ok('one timeout says nothing', r.timeouts === 1 && !probeStuck(r))

// The pair that actually happened, 54 minutes apart.
r = noteTimeout(r, T + 54 * MIN)
ok(`${STUCK_AFTER} in a row is the loop being stuck`, probeStuck(r), `${r.timeouts} timeouts`)
const said = stuckWords(r, T + 54 * MIN)
ok('and the line carries the count', said.includes(String(r.timeouts)))
ok('...and how long it has been going', /\d+ min/.test(said))
ok('...and what it means for the update, not just that a request failed', /feed|staged/.test(said))
for (const jargon of ['ERR_TIMED_OUT', 'promise', 'electron-updater', 'supersede']) {
  ok(`and does not say "${jargon}"`, !said.includes(jargon))
}

// The feed answering is the thing that ends a run, whatever it answered.
ok('an answer clears the run', !probeStuck(noteAnswer()))
r = noteAnswer()
r = noteTimeout(r, T + 60 * MIN)
ok('...so the next timeout after a good check is the first one again', r.timeouts === 1 && !probeStuck(r))

// Two bad minutes a working day apart are not one fault.
let far = noteTimeout(freshRun(), T)
far = noteTimeout(far, T + TIMEOUT_WINDOW_MS + 1)
ok('a timeout outside the window starts a new run', far.timeouts === 1 && !probeStuck(far), `window ${TIMEOUT_WINDOW_MS}ms`)

// The wiring: the count has to be fed from the probe's own failure path, and reaching the
// health file is what makes it survive the restart that hides the problem.
const updater = readFileSync(new URL('../src/main/updater.ts', import.meta.url), 'utf8')
ok('the probe failure path counts the timeout', /did not answer within\/\.test\(message\)/.test(updater))
ok('...and a stuck run reaches the log at its own severity', /log\('probe STUCK'/.test(updater))
ok('...and update-health.json, which is what logHealth reads at launch', /probeStuck\(probeRun\)[\s\S]{0,220}noteWedge\(/.test(updater))
ok('a probe that answers clears the run', /probeRun = noteAnswer\(\)/.test(updater))

console.log(failed ? `\n${failed} failed` : '\nupdate probe: all good')
process.exit(failed ? 1 : 0)
