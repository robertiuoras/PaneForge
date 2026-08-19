import { readFileSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
const req = createRequire(import.meta.url)
buildSync({ absWorkingDir: process.cwd(), entryPoints: ['src/shared/choices.ts'], bundle: true, format: 'cjs', platform: 'node', outfile: '/tmp/pf-choices.cjs' })
const { readAsk } = req('/tmp/pf-choices.cjs')
const { Terminal } = req('@xterm/headless')
const file = process.argv[2]
const cols = Number(process.argv[3] || 157)
const t = new Terminal({ cols, rows: 50, allowProposedApi: true })
const buf = readFileSync(file)
await new Promise((r) => t.write(buf.subarray(Math.max(0, buf.length - 400_000)), r))
const b = t.buffer.active
const lines = []
for (let y = 0; y < b.length; y++) lines.push(b.getLine(y).translateToString(true))
const screen = lines.slice(Math.max(0, b.length - 60)).join('\n')
console.log(screen.split('\n').map((l,i)=>String(i).padStart(2)+'| '+l).join('\n'))
console.log('--- readAsk ---')
console.log(JSON.stringify(readAsk(screen), null, 1))
