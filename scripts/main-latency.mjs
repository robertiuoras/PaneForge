/**
 * How long the MAIN process takes to answer, measured from outside it.
 *
 * Typing lag in a pane is bounded by main: a keystroke is an IPC call into main,
 * a pty write, and the echo back out through DataPump. Nothing in this repo could
 * measure that, which is why "the perf fix landed" and "it still feels laggy" have
 * both been true and neither provable. This asks the running app a question main
 * must answer on its own event loop, many times, and reports the distribution.
 *
 * A high MEDIAN is main doing steady work. A high p95 with a low median is main
 * being BLOCKED in bursts - which is what a person feels as stutter, and what an
 * average hides completely.
 *
 * It talks to the app's own phone server through scripts/pf-ctl.mjs, so it needs
 * no debugging port and works against the installed copy people are actually using.
 *
 *   node scripts/main-latency.mjs [--n 60] [--channel sessions:list]
 */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ctl = join(here, 'pf-ctl.mjs')

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const n = Number(arg('n', 60))
// A channel main answers itself, synchronously, with no disk and no child process:
// what is being timed is the queue in front of it, not the work behind it.
const channel = arg('channel', 'sessions:list')

const once = () =>
  new Promise((resolve) => {
    const t0 = process.hrtime.bigint()
    execFile(process.execPath, [ctl, 'call', channel, '{}'], { timeout: 20_000 }, (err) => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6
      resolve(err ? null : ms)
    })
  })

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]

const run = async () => {
  const got = []
  let failed = 0
  for (let i = 0; i < n; i++) {
    const ms = await once()
    if (ms === null) failed++
    else got.push(ms)
  }
  if (!got.length) {
    console.error(`main-latency: no answer in ${n} tries - is PaneForge running?`)
    process.exit(2)
  }
  const s = [...got].sort((a, b) => a - b)
  // The floor is what a `node` process costs to start at all; it is subtracted from
  // nothing and simply reported, so a reader can tell the app's share from the harness's.
  console.log(`main-latency  n=${got.length}${failed ? ` (${failed} failed)` : ''}  channel=${channel}`)
  console.log(`  min  ${s[0].toFixed(0)} ms`)
  console.log(`  p50  ${pct(s, 50).toFixed(0)} ms`)
  console.log(`  p95  ${pct(s, 95).toFixed(0)} ms`)
  console.log(`  max  ${s[s.length - 1].toFixed(0)} ms`)
  console.log(`  spread p95/p50 ${(pct(s, 95) / pct(s, 50)).toFixed(2)}x  (a burst-blocked main is >2x)`)
}

void run()
