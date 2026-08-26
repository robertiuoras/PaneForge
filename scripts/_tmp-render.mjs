import { readFileSync } from 'node:fs'
import pkg from '@xterm/headless'
const { Terminal } = pkg
const raw = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const t = new Terminal({ cols: 120, rows: 40, allowProposedApi: true })
await new Promise((r) => t.write(raw.slice(-400_000), r))
const b = t.buffer.active
const rows = []
for (let y = 0; y < b.length; y++) rows.push(b.getLine(y)?.translateToString(true) ?? '')
const screen = rows.slice(-40).join('\n')
console.log(JSON.stringify(screen.split('\n').filter((l) => l.trim()).slice(-12), null, 1))
