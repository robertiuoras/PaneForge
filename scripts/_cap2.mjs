import pty from '@lydell/node-pty'
import xt from '@xterm/headless'
const { Terminal } = xt
const [bin,...args]=process.argv[2].split(' ')
const term=new Terminal({cols:120,rows:40,allowProposedApi:true})
const p=pty.spawn(bin,args,{cols:120,rows:40,cwd:process.cwd(),env:process.env})
p.onData(d=>term.write(d))
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const read=i=>term.buffer.active.getLine(term.buffer.active.baseY+i)?.translateToString(true)??''
await sleep(4500); p.write(process.argv[3]??'say hi'); await sleep(600); p.write('\r')
await sleep(Number(process.argv[4]??8)*1000)
console.log('buffer type', term.buffer.active.type)
for(let i=0;i<40;i++){const l=read(i); if(l.trim()) console.log(String(i).padStart(2),JSON.stringify(l.replace(/\s+$/,'')))}
p.kill(); process.exit(0)
