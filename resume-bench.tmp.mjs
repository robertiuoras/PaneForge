import pty from '@lydell/node-pty'
import { readFileSync } from 'node:fs'
const ids = readFileSync('/private/tmp/pf-resume-bench/ids.txt', 'utf8').trim().split('\n')
const N = Number(process.env.N ?? 1)
const t0 = Date.now()
const done = []
const state = []
let live = N
for (let i = 0; i < N; i++) {
  const start = Date.now()
  const p = pty.spawn('/bin/zsh', ['-lc', `claude --resume ${ids[i]}`], { name: 'xterm-256color', cols: 120, rows: 40, cwd: '/Users/robertiuoras/Projects/PaneForge-a', env: process.env })
  let out = '', first = 0, ready = 0, bytes = 0
  state[i] = () => ({ i, first, ready, bytes, tail: out.slice(-400) })
  p.onData((d) => {
    if (!first) first = Date.now() - start
    bytes += d.length
    out += d.length > 4000 ? d.slice(-4000) : d
    if (out.length > 20000) out = out.slice(-20000)
    if (!ready && /Try "|╰─+╯|>\s*$/.test(out)) {
      ready = Date.now() - start
      done.push({ i, first, ready, bytes })
      try { p.kill() } catch {}
      if (--live === 0) finish()
    }
  })
  p.onExit(() => { if (!ready) { done.push({ i, first, ready: -1, bytes, tail: out.slice(-300) }); if (--live === 0) finish() } })
}
function finish() {
  done.sort((a, b) => a.i - b.i)
  for (const d of done) console.log(`#${d.i} first ${d.first}ms composer ${d.ready}ms bytes ${d.bytes}${d.tail ? ' TAIL:' + JSON.stringify(d.tail) : ''}`)
  const r = done.map((d) => d.ready).filter((x) => x > 0).sort((a, b) => a - b)
  if (r.length) console.log(`N=${N} median ${r[Math.floor(r.length / 2)]}ms max ${r[r.length - 1]}ms wall ${Date.now() - t0}ms`)
  process.exit(0)
}
setTimeout(() => { console.log('timeout'); for (const f of state) if (f) console.log(JSON.stringify(f())); process.exit(0) }, 45000)
