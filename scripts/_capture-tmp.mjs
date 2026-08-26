import pty from 'node-pty'
import xt from '@xterm/headless'
import { busyReason } from '../src/shared/busy.ts'
const { Terminal } = xt
const [bin, ...args] = process.argv[2].split(' ')
const prompt = process.argv[3] ?? 'count slowly from 1 to 20, one line each'
const secs = Number(process.argv[4] ?? 40)
const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
const p = pty.spawn(bin, args, { cols: 120, rows: 40, cwd: process.cwd(), env: process.env })
p.onData((d) => term.write(d))
const read = (i) => term.buffer.active.getLine(term.buffer.active.baseY + i)?.translateToString(true) ?? ''
const screen = (rows) => { let last = term.rows - 1; while (last > 0 && !read(last).trim()) last--
  let out=''; for (let i=Math.max(0,last-rows+1);i<=last;i++) out += read(i)+'\n'; return out }
const sleep = (ms) => new Promise(r=>setTimeout(r,ms))
await sleep(5000)
p.write(prompt); await sleep(800); p.write('\r')
const seen = new Set()
for (let i=0;i<secs;i++){
  await sleep(1000)
  const t = screen(16)
  const tail = t.split('\n').filter(Boolean).slice(-4).join(' | ')
  const key = tail.replace(/[⠀-⣿◐◓◑◒✢✳✶✻✽]/g,'@').replace(/\d+/g,'N')
  if (seen.has(key)) continue
  seen.add(key)
  console.log(`[${i}s] busy=${busyReason(t)} :: ${tail.slice(0,220)}`)
}
p.kill()
process.exit(0)
