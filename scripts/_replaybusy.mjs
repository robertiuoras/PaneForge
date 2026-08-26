import { buildSync } from 'esbuild'
import { readFileSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = '/Users/robertiuoras/Projects/PaneForge-a'
const work = join(tmpdir(),'pf-replaybusy'); rmSync(work,{recursive:true,force:true}); mkdirSync(work,{recursive:true})
const out = join(work,'busy.cjs')
buildSync({ absWorkingDir: root, entryPoints:['src/shared/busy.ts'], bundle:true, format:'cjs', platform:'node', outfile: out })
const req = createRequire(import.meta.url)
const { readsBusy, readsElapsedMs } = req(out)
const { Terminal } = req('@xterm/headless')
const file = process.argv[2]
const cols = Number(process.argv[3]||180)
const from = Number(process.argv[4]||0)
const buf = readFileSync(file)
const data = buf.subarray(from).toString('utf8')
const t = new Terminal({ cols, rows: 50, allowProposedApi: true, scrollback: 500 })
const screen = () => {
  const b = t.buffer.active
  const rows = []
  for (let y = 0; y < t.rows; y++) rows.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '')
  return rows
}
const STEP = 4096
let busy = false
let n = 0
for (let i = 0; i < data.length; i += STEP) {
  await new Promise(r => t.write(data.slice(i, i + STEP), r))
  const rows = screen()
  const text = rows.slice(-16).join('\n')
  const now = readsBusy(text)
  if (now !== busy) {
    busy = now
    n++
    const last = rows.filter(l=>l.trim()).slice(-5)
    console.log(`\n== flip -> ${now} at byte ${from+i} elapsed=${JSON.stringify(readsElapsedMs(text,true))}`)
    for (const l of last) console.log('   ', JSON.stringify(l.slice(0,150)))
  }
}
console.log('\nflips:', n, 'final busy:', busy)
