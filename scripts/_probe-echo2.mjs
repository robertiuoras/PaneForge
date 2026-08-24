import pkg from '@xterm/headless'
const { Terminal } = pkg
import { readFileSync } from 'node:fs'
const raw = readFileSync(process.argv[2], 'utf8').slice(-200000)
const t = new Terminal({ cols: 120, rows: 40, scrollback: 20000, allowProposedApi: true })
await new Promise((r) => t.write(raw, r))
const b = t.buffer.active
const cursor = b.baseY + b.cursorY
for (const at of process.argv.slice(3).map(Number)) {
  console.log(`---- around ${at} (cursor ${cursor})`)
  for (let i = Math.max(0, at - 5); i < Math.min(cursor, at + 8); i++)
    console.log(String(i).padStart(4), JSON.stringify((b.getLine(i)?.translateToString(true) ?? '').slice(0, 96)))
}
