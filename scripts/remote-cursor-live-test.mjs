// A real Codex draft mirrored through the encrypted device link. Never submits a prompt.
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { connect, root } from './ui-lab.mjs'

const require = createRequire(import.meta.url)
const { spawn } = require('@lydell/node-pty')
const work = mkdtempSync(join(tmpdir(), 'pf-remote-cursor-'))
buildSync({entryPoints:[join(root,'src/main/remote/host.ts')],bundle:true,platform:'node',format:'esm',outfile:join(work,'host.mjs')})
const { RemoteHost } = await import(join(work,'host.mjs'))
const pause = ms => new Promise(resolve => setTimeout(resolve,ms))
const c = await connect(process.env.PF_PORT ?? '9334')
const id='cursor-test', device=`cursor-test-${Date.now()}`, code=crypto.randomUUID()
let proc, host, peer, buffer='', queue=Promise.resolve(), slow=false
const dataListeners=[], sessionListeners=[], writes=[]
const session={id,title:'Remote cursor disposable test',cwd:'/tmp/pf-editor-parity',agent:'codex',status:'idle',createdAt:Date.now(),cols:159,rows:45}
try {
 const env={...process.env,TERM:'xterm-256color'}
 for(const key of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','OPENAI_BASE_URL'])delete env[key]
 proc=spawn(join(process.env.HOME,'.local/bin/codex'),['--no-alt-screen'],{name:'xterm-256color',cwd:session.cwd,cols:session.cols,rows:session.rows,env})
 proc.onData(data=>{buffer+=data;for(const cb of dataListeners)cb(id,data)})
 const backend={list:()=>[session],buffer:()=>buffer,
  write:(_,data)=>{
   const arrows=/^(?:\x1b\[[CD])+$/.test(data)
   if(arrows)writes.push(data)
   queue=queue.then(async()=>{
    if(slow && arrows && data.length>3){proc.write(data.slice(0,-3));await pause(300);proc.write(data.slice(-3))}
    else proc.write(data)
   })
  },
  resize:(_,cols,rows)=>{if(cols===session.cols&&rows===session.rows)return;session.cols=cols;session.rows=rows;proc.resize(cols,rows);for(const cb of sessionListeners)cb([session])},
  redraw:()=>{},setBusy:()=>{},clearAttention:()=>{},kill:()=>{},restart:()=>null,rename:()=>{},switchAgent:()=>null,
  projects:async()=>[],agents:async()=>[],jobs:async()=>[],
  onData:cb=>(dataListeners.push(cb),()=>{}),onSessions:cb=>(sessionListeners.push(cb),()=>{}),onAttention:()=>()=>{}
 }
 host=new RemoteHost(backend,()=>({id:device,name:'Disposable cursor test',platform:process.platform,version:'0.0.0-test'}),()=>code)
 host.start(0)
 await once(host.server,'listening')
 peer=device
 const result=await c.evaluate(`window.api.pairRemote(${JSON.stringify({address:'127.0.0.1',port:host.server.address().port,code,name:'Disposable cursor test'})})`)
 assert.ok(result.ok,result.error)
 await c.evaluate(`window.api.watchRemote(${JSON.stringify(device)},['${id}'])`)
 await pause(1500)
 const remoteId=(await c.evaluate(`window.api.listSessions().then(a=>a.find(s=>s.title==='Remote cursor disposable test')?.id)`))
 assert.ok(remoteId,'test mirror must appear')
 const q=JSON.stringify(remoteId)
 await c.evaluate(`document.querySelector('.row[data-id="'+${q}+'"]')?.click()`)
 await pause(400)
 const inspect=()=>c.evaluate(`(()=>{const p=window.__pf[${q}],t=p.term,b=t.buffer.active,s=p.inputRows();return {cols:t.cols,span:s,cursor:[b.cursorX,b.baseY+b.cursorY],lines:s?.rows.map((r,i)=>b.getLine(s.top+i).translateToString(true).slice(r.start,r.end)),keys:p.clickKeys().map(x=>x.length)}})()`)
 // This directory was previously trusted by the disposable native-editor checks.
 const first=await inspect()
 assert.ok(first.lines?.some(x=>/Ask Codex|Try |Implement|Find and fix|Explain/.test(x)),'expected a ready Codex composer; refusing trust/auth dialogs')
 await c.evaluate(`window.__pf[${q}].term.focus()`)
 await c.send('Input.insertText',{text:'x'.repeat(first.cols+20)})
 await pause(700)
 const before=await inspect()
 assert.equal(before.lines.join(''),'x'.repeat(first.cols+20),'draft must be visible')
 const target={col:before.span.rows[0].start+4,row:before.span.top}
 const point=await c.evaluate(`(()=>{const t=window.__pf[${q}].term,r=document.querySelector('.pane[data-id="'+${q}+'"] .xterm-screen')?.getBoundingClientRect()??t.element.querySelector('.xterm-screen').getBoundingClientRect();return {x:r.x+(${target.col}+0.5)*r.width/t.cols,y:r.y+(${target.row}-t.buffer.active.viewportY+0.5)*r.height/t.rows}})()`)
 slow=true
 await c.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1})
 await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1})
 await pause(850)
 const after=await inspect()
 console.log(JSON.stringify({target,cursor:after.cursor,arrowBatches:writes.map(x=>x.length/3),appBatches:after.keys,unchangedText:after.lines.join('')===before.lines.join('')}))
 assert.deepEqual(after.cursor,[target.col,target.row],'delayed remote echo must not move caret past clicked cell')
 assert.equal(after.lines.join(''),before.lines.join(''),'click must not edit draft')
 assert.equal(writes.length,1,'one navigation batch; no speculative correction against an intermediate frame')
 console.log('Actual remote Codex cursor: delayed arrow batch lands on clicked cell without a second jump')
} finally {
 const errors=[]
 // A disconnected renderer must not prevent termination of the owned CLI/server.
 for(const cleanup of [
  ()=>peer?c.evaluate(`window.api.forgetRemote(${JSON.stringify(peer)})`):undefined,
  ()=>queue,
  ()=>proc?.kill(),
  ()=>host?.stop(),
  ()=>c.close(),
  ()=>rmSync(work,{recursive:true,force:true})
 ])try{await cleanup()}catch(error){errors.push(error)}
 if(errors.length)throw new AggregateError(errors,'Disposable remote cursor cleanup failed')
}
