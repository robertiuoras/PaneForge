import pty from '@lydell/node-pty'
import xt from '@xterm/headless'
import { busyReason } from '../src/shared/busy.ts'
const { Terminal } = xt
const [bin,...args]=process.argv[2].split(' ')
const term=new Terminal({cols:120,rows:40,allowProposedApi:true})
const p=pty.spawn(bin,args,{cols:120,rows:40,cwd:process.cwd(),env:process.env})
p.onData(d=>term.write(d))
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const read=i=>term.buffer.active.getLine(term.buffer.active.baseY+i)?.translateToString(true)??''
const screen=rows=>{let last=term.rows-1;while(last>0&&!read(last).trim())last--
  let o='';for(let i=Math.max(0,last-rows+1);i<=last;i++)o+=read(i)+'\n';return o}
await sleep(5000)
console.log('IDLE busy=', busyReason(screen(16)))
p.write(process.argv[3]); await sleep(700); p.write('\r')
const secs=Number(process.argv[4]??25)
let busyTicks=0, spinTicks=0
const lines=new Set()
for(let i=0;i<secs;i++){
  await sleep(1000)
  const t=screen(16), r=busyReason(t)
  const sp=t.split('\n').find(l=>/[⠀-⣿◐◓◑◒✢✳✶✻✽●]/.test(l)&&l.trim().length>3)
  if(sp){spinTicks++; lines.add(sp.trim().replace(/\d+(\.\d+)?/g,'N').replace(/[⠀-⣿]/g,'@').slice(0,110))}
  if(r)busyTicks++
  if(i%5===0)console.log(`[${i}s] busy=${r} :: ${(sp??'').trim().slice(0,100)}`)
}
console.log('busy ticks',busyTicks,'/',secs,' spinner-ish ticks',spinTicks)
for(const l of lines) console.log('  LINE',JSON.stringify(l))
p.kill(); process.exit(0)
