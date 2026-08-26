import { buildSync } from 'esbuild'
import { readFileSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = '/Users/robertiuoras/Projects/PaneForge-a'
const work = join(tmpdir(), 'pf-frame'); rmSync(work,{recursive:true,force:true}); mkdirSync(work,{recursive:true})
const out = join(work,'busy.cjs')
buildSync({ absWorkingDir: root, entryPoints:['src/shared/busy.ts'], bundle:true, format:'cjs', platform:'node', outfile: out })
const { readsBusy, readsElapsedMs } = createRequire(import.meta.url)(out)
const { Terminal } = createRequire(import.meta.url)('@xterm/headless')
const file = process.argv[2]
const cols = Number(process.argv[3]||180)
const buf = readFileSync(file)
const tail = buf.subarray(Math.max(0, buf.length - 400_000)).toString('utf8')
const t = new Terminal({ cols, rows: 50, allowProposedApi: true, scrollback: 2000 })
await new Promise(r => t.write(tail, r))
const b = t.buffer.active
const rows = []
for (let y = 0; y < t.rows; y++) rows.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '')
const text = rows.join('\n')
const last = rows.filter(l=>l.trim()).slice(-12)
console.log('--- last 12 non-blank rows ---')
for (const l of last) console.log(JSON.stringify(l))
console.log('readsBusy(full screen) =', readsBusy(text))
console.log('elapsed =', JSON.stringify(readsElapsedMs(text, true)))
