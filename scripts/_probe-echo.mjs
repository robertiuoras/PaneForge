import pkg from '@xterm/headless'
const { Terminal } = pkg
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
const f = process.argv[2]
const raw = readFileSync(f, 'utf8')
const tail = raw.slice(-200000)
const t = new Terminal({ cols: 120, rows: 40, scrollback: 20000, allowProposedApi: true })
await new Promise((r) => t.write(tail, r))
const b = t.buffer.active
const cursor = b.baseY + b.cursorY
const ECHO = /^ {0,4}❯ {1,3}(\S.*)$/
let hits = 0, lines = 0
for (let i = 0; i < cursor; i++) {
  const s = b.getLine(i)?.translateToString(true) ?? ''
  if (s.trim()) lines++
  const m = ECHO.exec(s.replace(/\s+$/, ''))
  if (m) { hits++; console.log('HIT', i, JSON.stringify(m[1].slice(0, 60))) }
}
console.log(`file=${f.split('/').pop()} cursor=${cursor} nonblank=${lines} hits=${hits}`)
