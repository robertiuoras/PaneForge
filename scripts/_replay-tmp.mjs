import pkg from '@xterm/headless'
const { Terminal } = pkg
import fs from 'node:fs'
import { busyReason } from '../src/shared/busy.ts'
const buf = fs.readFileSync(process.argv[2])
const ROWS = Number(process.argv[3] ?? 40)
const term = new Terminal({ cols: 120, rows: ROWS, allowProposedApi: true })
const w = (d) => new Promise((r) => term.write(d, r))
const read = (i) => term.buffer.active.getLine(term.buffer.active.baseY + i)?.translateToString(true) ?? ''
const screenText = (rows) => {
  let last = term.rows - 1
  while (last > 0 && !read(last).trim()) last--
  let out = ''
  for (let i = Math.max(0, last - rows + 1); i <= last; i++) out += read(i) + '\n'
  return out
}
const CH = 1024
let spin = 0, spinBusy = 0
const misses = new Map()
for (let i = 0; i < buf.length; i += CH) {
  await w(buf.subarray(i, i + CH))
  const t = screenText(16)
  const isSpin = /[⣯⣟⡿⢿⣻⣽⣾⣷⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+\w+\.\.\./.test(t)
  if (!isSpin) continue
  spin++
  const r = busyReason(t)
  if (r) { spinBusy++; continue }
  const line = t.split('\n').find(l => /[⣯⣟⡿⢿⣻⣽⣾⣷]\s+\w+\.\.\./.test(l)) ?? ''
  const key = line.trim().replace(/[⣯⣟⡿⢿⣻⣽⣾⣷]/,'@')
  misses.set(key, (misses.get(key)??0)+1)
}
console.log('spinner frames', spin, 'read busy', spinBusy, 'MISSED', spin-spinBusy)
for (const [k,v] of [...misses].sort((a,b)=>b[1]-a[1]).slice(0,12)) console.log(v, JSON.stringify(k))
