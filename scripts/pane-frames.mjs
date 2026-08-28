/**
 * What a desk of printing panes actually costs to DRAW.
 *
 * "PaneForge feels laggy" had no number behind it, and main was measured idle
 * (`npm run main-latency`: p50 0.4ms, thread 73% idle in mach_msg2_trap), so the cost is
 * in the renderer and the GPU. This opens N shell panes in a RUNNING dev copy, sets each
 * one printing at an agent-like rate, and counts xterm's own `onRender` per pane - the
 * unit that becomes a WebGL frame and then a composite.
 *
 * It reports which panes hold a WebGL context, because that is the finding it exists for:
 * past the context budget a pane silently falls back to xterm's DOM renderer and stays
 * there, and a desk in grid view always has some panes on the slow path.
 *
 * Needs a copy running with a debugging port, and it opens panes in THAT copy - never the
 * one you are reading this in:
 *
 *   npm run build && npm run try -- --keep --remote-debugging-port=9334
 *   node scripts/pane-frames.mjs
 *   npm run try -- --close
 *
 * Measured on this machine 2026-08-28, 10 panes in grid at ~50 lines/s each:
 * 8 panes at 9.6-9.8 renders/s (77.6 total), 8 of 10 holding WebGL, and the dev copy's
 * renderer at 20.4% of a core, GPU helper 18.2%, main 8.4%.
 */
const l = await (await fetch('http://127.0.0.1:9334/json/list')).json()
const page = l.find((p) => p.type === 'page' && !p.url.startsWith('devtools'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const send = (m, p) => new Promise((res, rej) => { const my = ++id
  const t = setTimeout(() => rej(new Error('renderer did not answer in 10s')), 10000)
  const on = (e) => { const x = JSON.parse(e.data); if (x.id === my) { clearTimeout(t); ws.removeEventListener('message', on); res(x.result) } }
  ws.addEventListener('message', on); ws.send(JSON.stringify({ id: my, method: m, params: p })) })
await new Promise((r) => ws.addEventListener('open', r))
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }))?.result?.value

const N = 8
await ev(`(async()=>{ for(let i=0;i<${N};i++) await window.api.startSession({cwd:'/Users/robertiuoras/Projects/PaneForge-b',agent:'shell'}); return 1 })()`)
await new Promise((r) => setTimeout(r, 3000))
// A steady, survivable print rate: ~50 lines a second per pane, the shape of an agent
// streaming an answer rather than a `cat` of a huge file.
const cmd = 'while true; do for i in 1 2 3 4 5 6 7 8 9 10; do echo "a line of an agent answer $i"; done; sleep 0.2; done\r'
console.log('printers:', await ev(`(async()=>{ const ids=Object.keys(window.__pf||{}); for(const id of ids) await window.api.write(id, ${JSON.stringify(cmd)}); return ids.length })()`))
await new Promise((r) => setTimeout(r, 3000))
console.log('armed:', await ev(`(()=>{window.__frames={};for(const [id,p] of Object.entries(window.__pf||{})){if(!p.term||p.__f)continue;window.__frames[id]=0;p.term.onRender(()=>window.__frames[id]++);p.__f=1}return Object.keys(window.__frames).length})()`))
const t0 = Date.now()
await new Promise((r) => setTimeout(r, 10000))
const secs = (Date.now() - t0) / 1000
const out = JSON.parse(await ev(`JSON.stringify({f:window.__frames,gl:Object.fromEntries(Object.entries(window.__pf).map(([k,v])=>[k,!!v.hasWebgl?.()]))})`))
let vis = 0, hid = 0
for (const [k, v] of Object.entries(out.f)) {
  const r = v / secs
  console.log(`  ${k} ${r.toFixed(1)} renders/s  webgl=${out.gl[k]}`)
  if (out.gl[k]) vis += r; else hid += r
}
console.log(`VISIBLE(webgl) ${vis.toFixed(1)} r/s   HIDDEN(dom) ${hid.toFixed(1)} r/s`)
ws.close(); process.exit(0)
