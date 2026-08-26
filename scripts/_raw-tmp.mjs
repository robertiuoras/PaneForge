import pty from '@lydell/node-pty'
const [bin,...args]=process.argv[2].split(' ')
const p=pty.spawn(bin,args,{cols:120,rows:40,cwd:process.cwd(),env:process.env})
let out=''
p.onData(d=>{out+=d})
p.onExit(e=>{console.log('EXIT',JSON.stringify(e))})
setTimeout(()=>{p.write(process.argv[3]??'say hi');setTimeout(()=>p.write('\r'),600)},4000)
setTimeout(()=>{console.log(JSON.stringify(out.slice(-3000)));p.kill();process.exit(0)},Number(process.argv[4]??20)*1000)
