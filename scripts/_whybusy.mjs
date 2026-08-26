import { buildSync } from 'esbuild'
import { readFileSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const root = '/Users/robertiuoras/Projects/PaneForge-a'
const work = join(tmpdir(),'pf-whybusy'); rmSync(work,{recursive:true,force:true}); mkdirSync(work,{recursive:true})
// Expose the private rules for the probe by re-exporting them from a shim.
const shim = join(work,'shim.ts')
import { writeFileSync } from 'node:fs'
writeFileSync(shim, `export * from '${root}/src/shared/busy'\n`)
const out = join(work,'busy.cjs')
buildSync({ absWorkingDir: root, entryPoints:[shim], bundle:true, format:'cjs', platform:'node', outfile: out })
const req = createRequire(import.meta.url)
const { readsBusy, readsElapsedMs, ASK_PROMPT } = req(out)
const { Terminal } = req('@xterm/headless')
const SAYS_INTERRUPT = /esc to interrupt|esc to cancel|ctrl\+c to (stop|interrupt|cancel)|press esc to stop|esc interrupt|working…|thinking…/i
const SPINNING = /^[^\S\n]*[✢✳✶✻✽✷✺◐◓◑◒⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+\S[^\n]*…/m
const LONE_GERUND = /^[^\S\n]*[A-Z][a-z]+…[^\S\n]*$/m
const file = process.argv[2], cols = Number(process.argv[3]||180), from = Number(process.argv[4]||0)
const data = readFileSync(file).subarray(from).toString('utf8')
const t = new Terminal({ cols, rows: 50, allowProposedApi: true, scrollback: 500 })
const screen = () => { const b=t.buffer.active; const r=[]; for(let y=0;y<t.rows;y++) r.push(b.getLine(b.viewportY+y)?.translateToString(true)??''); return r }
let busy=false
for (let i=0;i<data.length;i+=4096){
  await new Promise(r=>t.write(data.slice(i,i+4096), r))
  const rows=screen(); const text=rows.slice(-16).join('\n')
  const now=readsBusy(text)
  if(now===busy) continue
  busy=now
  if(!now) continue
  const why={interrupt:SAYS_INTERRUPT.test(text),spin:SPINNING.test(text),gerund:LONE_GERUND.test(text),counter:readsElapsedMs(text,true)}
  if(why.spin||why.interrupt) continue
  console.log(`\n== SUSPECT true at ${from+i}`, JSON.stringify(why))
  console.log(text.split('\n').map(l=>'  |'+l.slice(0,140)).join('\n'))
}
