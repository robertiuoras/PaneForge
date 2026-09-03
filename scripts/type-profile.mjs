// Where the renderer's time goes while somebody types into a busy desk.
//
// "PaneForge is laggy when typing" is a step-count question and the honest way to answer
// it is a CPU profile of the real window under the real load, not a guess about which
// handler looks expensive. This drives a running test copy over CDP: it starts an endless
// printer in every pane but the first, records a V8 profile while 40 keystrokes go into
// that first pane, and prints the keystroke-to-frame latency beside the functions that
// actually held the thread.
//
//   npm run build && npm run try -- --keep --remote-debugging-port=9333
//   node scripts/type-profile.mjs [--panes 8] [--keys 40] [--port 9333]
//
// It is a measuring tool, not a test: nothing here asserts, because the number that
// matters is a comparison between two builds.
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const rootUrl = pathToFileURL(root).href.replace(/\/?$/, '/').toLowerCase()
const args = process.argv.slice(2)
const flag = (n, d) => {
  const i = args.indexOf(n)
  return i < 0 ? d : args[i + 1]
}
const port = flag('--port', process.env.PF_PORT ?? '9333')
const wantPanes = Number(flag('--panes', 8))
const keys = Number(flag('--keys', 40))

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find(
  (t) => t.type === 'page' && t.webSocketDebuggerUrl && !(t.url ?? '').includes('shelf')
)
if (!page) throw new Error(`no debuggable window on ${port}`)
if (!(page.url ?? '').toLowerCase().startsWith(rootUrl))
  throw new Error(`port ${port} is another checkout's copy: ${page.url}`)

const ws = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
let seq = 0
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
})
const send = (method, params) => {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((res, rej) => pending.set(id, { res, rej }))
}
await new Promise((r) => ws.addEventListener('open', r, { once: true }))

const evaluate = async (expression) => {
  const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (out.exceptionDetails)
    throw new Error(out.exceptionDetails.exception?.description ?? 'evaluate threw')
  return out.result.value
}

// Enough panes to be a desk. Shell panes, because the cost being measured is this app's
// own handling of output, not an agent CLI's memory.
// LIVE panes, not panes. An exited shell still has a card, a terminal and an entry in
// `window.__pf`, so counting those filled the desk with corpses and profiled an idle
// window three times in a row - each run reporting a perfectly healthy 25ms.
const live = async () =>
  await evaluate(`(async () => {
    const ss = await window.api.listSessions()
    return ss.filter(s => s.status !== 'exited' && !s.asleep && window.__pf[s.id] && window.__pf[s.id].term).map(s => s.id)
  })()`)
let ids = await live()
for (let i = ids.length; i < wantPanes; i++)
  await evaluate(
    `window.api.startSession({ cwd: ${JSON.stringify(root)}, agent: 'shell', title: 'load${'$'}{Math.random()}' })`
  )
await new Promise((r) => setTimeout(r, 800))
ids = await live()
const opened = ids.length
if (opened < 2) throw new Error(`only ${opened} live pane(s) - nothing to load the desk with`)

const CR = '\\r'
const LOAD = JSON.stringify(ids.slice(1))
const TYPED = JSON.stringify(ids[0])
// The shell pane is PowerShell on Windows (shared/agents.ts), which has no `while
// true; do`: the POSIX line sat unparsed and every profile here measured an idle
// desk while claiming 8 printers (2026-09-04). Branch on the platform THIS SCRIPT
// runs on, not the pane's, since the pane is always spawned by this same process.
const loadLoop =
  process.platform === 'win32'
    ? 'while ($true) { "' + 'a'.repeat(60) + '" }\r'
    : 'while true; do echo "' + 'a'.repeat(60) + '"; done\r'
await evaluate(`(async () => {
  const loop = ${JSON.stringify(loadLoop)}
  for (const id of ${LOAD}) await window.api.write(id, loop)
  return true
})()`)
await new Promise((r) => setTimeout(r, 2000))

await send('Profiler.enable')
await send('Profiler.setSamplingInterval', { interval: 200 })
await send('Profiler.start')

// A monotonic counter, because the obvious reading is NOT one: a pane at its scrollback
// cap stops growing, so `buffer.active.length` reported "0 lines printed" over a desk that
// was in fact streaming - a load proof that fails exactly when the load is heaviest.
await evaluate(`(() => {
  window.__pfLoad = 0
  window.__pfLoadHooked = window.__pfLoadHooked || {}
  for (const id of ${LOAD}) {
    if (window.__pfLoadHooked[id]) continue
    window.__pfLoadHooked[id] = true
    window.__pf[id].term.onWriteParsed(() => { window.__pfLoad++ })
  }
  return true
})()`)
const typed = await evaluate(`(async () => {
  const t = window.__pf[${TYPED}].term
  const s = []
  for (let i = 0; i < ${keys}; i++) {
    const t0 = performance.now()
    await new Promise(r => { const d = t.onRender(() => { d.dispose(); r() }); t.input('x') })
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    s.push(performance.now() - t0)
  }
  s.sort((a, b) => a - b)
  // Proof the load was really on while this was measured: a profile taken over panes that
  // had quietly stopped printing is the most convincing wrong answer available here.
  const lines = window.__pfLoad
  return { median: +s[Math.floor(s.length / 2)].toFixed(1), p90: +s[Math.floor(s.length * 0.9)].toFixed(1), max: +s[s.length - 1].toFixed(1), lines }
})()`)

const { profile } = await send('Profiler.stop')
// Stop the printers before anything else: a thrown error below must not leave eight
// shells spinning in a window somebody has to find and kill.
await evaluate(`(async () => {
  for (const id of ${LOAD}) await window.api.write(id, String.fromCharCode(3))
  return true
})()`)

const byId = new Map(profile.nodes.map((n) => [n.id, n]))
const self = new Map()
const total = profile.samples.length
for (const id of profile.samples) {
  const n = byId.get(id)
  if (!n) continue
  const f = n.callFrame
  const where = `${f.functionName || '(anonymous)'}  ${(f.url || '').split('/').pop()}:${f.lineNumber + 1}`
  self.set(where, (self.get(where) ?? 0) + 1)
}
const span = (profile.endTime - profile.startTime) / 1000
const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)

console.log(`panes ${opened}, keys ${keys}, profile ${span.toFixed(0)}ms, ${total} samples`)
console.log(
  `load: ${typed.lines.toLocaleString()} write batches parsed by the other panes ` +
    `during the ${span.toFixed(0)}ms measured`
)
console.log(`keystroke -> frame: median ${typed.median}ms  p90 ${typed.p90}ms  max ${typed.max}ms`)
console.log('\nself time, top 25:')
for (const [where, n] of rows)
  console.log(`  ${((n / total) * 100).toFixed(1).padStart(5)}%  ${((n / total) * span).toFixed(0).padStart(6)}ms  ${where}`)
// Self time names the DOM call; it never names who asked for it, and a layout flush is
// always attributed to the same builtin. So the callers are printed too, or every profile
// of this app ends at `getBoundingClientRect` and stops being actionable.
// Any frame can be blamed, not only the layout flush: `--blame yi` names who SCHEDULED
// React's updates, which is the reading that separates "the desk re-rendered" from
// "something asked it to, thousands of times, and React bailed out".
const blameName = flag('--blame', 'getBoundingClientRect')
const parent = new Map()
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const blame = new Map()
for (const id of profile.samples) {
  const n = byId.get(id)
  if (!n || n.callFrame.functionName !== blameName) continue
  const p = byId.get(parent.get(id))
  const f = p?.callFrame
  const where = f ? `${f.functionName || '(anonymous)'}  ${(f.url || '').split('/').pop()}:${f.lineNumber + 1}` : '(root)'
  blame.set(where, (blame.get(where) ?? 0) + 1)
}
if (blame.size) {
  console.log(`\nwho called ${blameName}:`)
  for (const [where, n] of [...blame.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10))
    console.log(`  ${((n / total) * 100).toFixed(1).padStart(5)}%  ${((n / total) * span).toFixed(0).padStart(6)}ms  ${where}`)
}
ws.close()
// The load proof is an EXIT CODE, not a line of output. Three runs in a row reported a
// healthy 25ms over a desk that had quietly stopped printing, and each one read as an
// answer.
if (!typed.lines) {
  console.error('\nNOTHING WAS PRINTED - this profile measured an idle window.')
  process.exit(1)
}
