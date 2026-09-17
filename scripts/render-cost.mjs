// What the renderer SPENDS while panes print, measured rather than guessed.
//
// The installed app's renderer sat at 60-70% CPU for two days with the desk idle
// (2026-09-18, pid 1828, 773 MB). A `sample` of that process says only which THREAD is
// hot, never which function, so this drives a dev copy into the same shape - N shell
// panes printing - and takes a real CPU profile through the debugger.
//
//   npm run build
//   npm run try -- --headless --remote-debugging-port=9445
//   node scripts/render-cost.mjs --panes 4 --seconds 10 --port 9445
//   npm run try -- --close
//
// Prints self-time per function, heaviest first, and the frame/paint counters the app
// already keeps (`window.__pfDeskRenders`, `window.__pfRenders`).

import { connect, SkipError } from './ui-lab.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const PANES = Number(arg('panes', 4))
const SECONDS = Number(arg('seconds', 10))
const PORT = arg('port', process.env.PF_PORT ?? '9444')
const QUIET = process.argv.includes('--quiet')
// Slow enough to be a terminal rather than a fire hose, fast enough that the output path
// is genuinely the thing being measured.
const PRINT = "while true; do date '+%T.%N  a line of ordinary terminal output'; sleep 0.05; done"

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const link = await connect(PORT)

  const before = await link.evaluate(`(() => ({
    panes: Object.keys(window.__pf ?? {}).length,
    desk: window.__pfDeskRenders?.n ?? 0,
  }))()`)

  // Open the panes through the renderer's own start call, so they are ordinary shell
  // panes on the dev desk - not a fixture that skips the code under measurement.
  const opened = await link.evaluate(
    `(async () => {
      const made = []
      for (let i = 0; i < ${PANES}; i++) {
        const s = await window.api.startSession({ cwd: ${JSON.stringify(process.cwd())}, agent: 'shell' })
        made.push(s?.id ?? s)
        await new Promise((r) => setTimeout(r, 400))
      }
      return made
    })()`
  )
  const ids = (opened ?? []).filter(Boolean)
  if (!ids.length) throw new SkipError('the dev copy opened no panes - is this build current?')

  // Let each pane finish starting before it is asked to print.
  await wait(3000)
  for (const id of QUIET ? [] : ids) {
    await link.evaluate(
      `window.api.write(${JSON.stringify(id)}, ${JSON.stringify(PRINT + '\r')})`
    )
    await wait(200)
  }
  await wait(2000)

  await link.send('Profiler.enable')
  await link.send('Profiler.setSamplingInterval', { interval: 200 })
  const mark = await link.evaluate(`(() => ({ desk: window.__pfDeskRenders?.n ?? 0 }))()`)
  await link.send('Profiler.start')
  await wait(SECONDS * 1000)
  const { profile } = await link.send('Profiler.stop')
  const after = await link.evaluate(`(() => ({ desk: window.__pfDeskRenders?.n ?? 0 }))()`)

  // Self time per node: the profile is a flat node list plus a sample stream, so the
  // sample count IS the self time once multiplied by the gap between samples.
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const self = new Map()
  const deltas = profile.timeDeltas ?? []
  profile.samples.forEach((id, i) => {
    self.set(id, (self.get(id) ?? 0) + (deltas[i] ?? 0))
  })
  const total = [...self.values()].reduce((a, b) => a + b, 0) || 1

  const rows = [...self.entries()]
    .map(([id, us]) => {
      const n = byId.get(id)
      const f = n?.callFrame ?? {}
      const where = f.url ? `${f.url.split('/').pop()}:${(f.lineNumber ?? 0) + 1}` : ''
      return { name: f.functionName || '(anonymous)', where, us }
    })
    .sort((a, b) => b.us - a.us)

  const wall = SECONDS * 1_000_000
  console.log(`\nrenderer cost: ${PANES} shell panes ${QUIET ? 'sitting idle' : 'printing'}, ${SECONDS}s`)
  console.log(`panes before: ${before.panes}   busy in JS: ${((total / wall) * 100).toFixed(1)}% of one core`)
  console.log(`desk renders during the profile: ${after.desk - mark.desk}\n`)
  for (const r of rows.slice(0, 22)) {
    if (r.us < total * 0.004) break
    console.log(
      `${((r.us / total) * 100).toFixed(1).padStart(5)}%  ${(r.us / 1000).toFixed(0).padStart(6)}ms  ${r.name}  ${r.where}`
    )
  }

  for (const id of ids) await link.evaluate(`window.api.killSession(${JSON.stringify(id)})`)
  link.ws.close()
}

main().catch((e) => {
  if (e instanceof SkipError) {
    console.log(`skipped: ${e.message}`)
    process.exit(0)
  }
  console.error(e)
  process.exit(1)
})
