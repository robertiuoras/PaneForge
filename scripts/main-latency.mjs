/**
 * How long the MAIN process takes to answer, measured from outside it.
 *
 * Typing lag in a pane is bounded by main: a keystroke is an IPC call into main,
 * a pty write, and the echo back out through DataPump. Nothing in this repo could
 * measure that, which is why "the sampler fix landed" and "it still feels laggy"
 * have both been true and neither provable.
 *
 * It pairs ONCE with the app's own phone server and then reuses that connection,
 * because the first version of this script spawned a `node` per sample and was
 * measuring node's own startup under machine load - a floor of 135ms with a tail
 * of its own, on a desk sitting at load 8.6. What is timed here is one HTTP
 * request main answers on its event loop: the floor is sub-millisecond and every
 * millisecond above it belongs to the app or to the CPU it is competing for.
 *
 * A high MEDIAN is main doing steady work. A high p95 over a low median is main
 * being BLOCKED in bursts - which is what a person feels as stutter, and what an
 * average hides completely. `--trace` prints when each slow sample landed, so a
 * stall with a period (a timer) can be told from one without (contention or
 * output).
 *
 *   node scripts/main-latency.mjs [--n 300] [--trace] [--channel sessions:list]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const has = (name) => process.argv.includes(`--${name}`)

const configDir =
  process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'claude-orchestrator')
    : join(process.env.APPDATA ?? homedir(), 'claude-orchestrator')

let phone = {}
try {
  phone = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')).phone ?? {}
} catch {
  console.error('main-latency: no config.json - has PaneForge ever run on this machine?')
  process.exit(2)
}
const base = `http://127.0.0.1:${phone.port ?? 7312}`

const n = Number(arg('n', 300))
// A channel main answers itself, with no disk and no child process: what is being
// timed is the queue in front of main, not the work behind it.
const channel = arg('channel', 'sessions:list')

const pair = async () => {
  const res = await fetch(`${base}/pf/pair`, {
    method: 'POST',
    body: JSON.stringify({ code: phone.code ?? '' })
  }).catch(() => null)
  if (!res || !res.ok) {
    console.error(`main-latency: PaneForge not answering on ${base} - is it running?`)
    process.exit(2)
  }
  return (res.headers.get('set-cookie') ?? '').split(';')[0]
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]

const run = async () => {
  const cookie = await pair()
  const rows = []
  const start = Date.now()
  for (let i = 0; i < n; i++) {
    const at = Date.now()
    const t0 = process.hrtime.bigint()
    const ok = await fetch(`${base}/pf/call`, {
      method: 'POST',
      headers: { cookie },
      body: JSON.stringify({ id: 1, channel, args: [] })
    })
      .then((r) => r.json())
      .then(() => true)
      .catch(() => false)
    if (ok) rows.push({ at: at - start, ms: Number(process.hrtime.bigint() - t0) / 1e6 })
  }
  if (!rows.length) {
    console.error('main-latency: nothing answered')
    process.exit(2)
  }
  const s = rows.map((r) => r.ms).sort((a, b) => a - b)
  console.log(`main-latency  n=${rows.length}  channel=${channel}`)
  console.log(`  min  ${s[0].toFixed(1)} ms`)
  console.log(`  p50  ${pct(s, 50).toFixed(1)} ms`)
  console.log(`  p95  ${pct(s, 95).toFixed(1)} ms`)
  console.log(`  max  ${s[s.length - 1].toFixed(1)} ms`)
  console.log(`  spread p95/p50 ${(pct(s, 95) / pct(s, 50)).toFixed(1)}x  (blocked in bursts is >5x)`)
  if (has('trace')) {
    const floor = s[0]
    const slow = rows.filter((r) => r.ms > floor + 50)
    console.log(`  slow (>${(floor + 50).toFixed(0)}ms): ${slow.length}`)
    let prev = 0
    for (const r of slow) {
      const t = r.at / 1000
      console.log(`    t=${t.toFixed(1)}s ${r.ms.toFixed(0)}ms gap=${prev ? (t - prev).toFixed(1) : '-'}s`)
      prev = t
    }
  }
}

void run()
