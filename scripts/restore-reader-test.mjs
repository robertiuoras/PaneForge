// Run the renderer's repair against a real terminal. Automatic repairs must retain intent.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {transformSync} from 'esbuild'
const require=createRequire(import.meta.url), {Terminal}=require('@xterm/headless')
const src=readFileSync(new URL('../src/renderer/src/components/TerminalPane.tsx',import.meta.url),'utf8')
const from=src.indexOf('    const repair = (): void => {'),to=src.indexOf('\n    /**',from)
assert(from>0&&to>from)
const code=transformSync(src.slice(from,to)+'\nreturn repair',{loader:'ts'}).code
const t=new Terminal({cols:85,rows:30,allowProposedApi:true})
await new Promise(r=>t.write(Array.from({length:300},(_,i)=>`row ${i}\r\n`).join(''),r))
const pinned={current:false},fixWhy={current:'restore'},states=[]
const repair=new Function('t','f','pinned','fixWhy','list','noteFix','reshape','api','sessionId','setScrolledUp','window','dead','seedMarks','RESTORE_FIX_MS',code)(t,{},pinned,fixWhy,[],()=>{},()=>{if(pinned.current)t.scrollToBottom()},{redraw(){}},'test',v=>states.push(v),{setTimeout(){}},false,()=>{},1200)
try{
 for(const why of ['restore','wipe']){
  t.scrollToLine(100);pinned.current=false;fixWhy.current=why;repair()
  assert.equal(t.buffer.active.viewportY,100,`${why} repair preserves reader anchor`)
  assert.equal(pinned.current,false,`${why} repair preserves reader intent`)
 }
 t.scrollToBottom();pinned.current=true;fixWhy.current='restore';repair();assert.equal(t.buffer.active.viewportY,t.buffer.active.baseY)
 t.scrollToLine(100);pinned.current=false;fixWhy.current='pressed';repair();assert.equal(t.buffer.active.viewportY,t.buffer.active.baseY,'explicit Fix retains its requested latest-frame behavior')
 console.log('restore reader: automatic reader/tail and explicit repair passed')
}finally{t.dispose()}

// Exercise the actual reset handler: a full log omits a screen of trailing repaint
// blanks that the live buffer had. Keeping tail distance used to move the reader.
const resetFrom=src.indexOf('    const offReset = api.onPaneReset(')
const resetTo=src.indexOf('\n    const off = api.onData(',resetFrom)
assert(resetFrom>0&&resetTo>resetFrom)
const resetCode=transformSync(src.slice(resetFrom,resetTo),{loader:'ts'}).code
const term=new Terminal({cols:85,rows:30,allowProposedApi:true})
const lines=Array.from({length:300},(_,i)=>`conversation row ${i}\r\n`).join('')
const write=data=>new Promise(r=>term.write(data,r))
let reset
const pin={current:false},intent={current:0}
new Function('api','t','pinned','scrollIntent','setScrolledUp',`
const sessionId='test',list=[],publish=()=>{},dead=false,setBlank=()=>{},window={clearTimeout(){}},wipeTimer=0,makeKeeper=()=>x=>x,withoutReplayQueries=x=>x,seedMarks=()=>{},drainTyped=()=>{};
let sawOutput=false,wipeSnap=null,keep=x=>x,readingSnapshot=false,pendingDataWrites=0;
${resetCode}
`)({onPaneReset:fn=>{reset=fn}},term,pin,intent,()=>{})
try{
 await write(lines+'\r\n'.repeat(59));term.scrollToLine(100);pin.current=false
 reset('test',lines);await write('')
 assert.equal(term.buffer.active.viewportY,100,'history reset preserves matching reader text when repaint blanks disappear')
 pin.current=true;reset('test',lines);await write('');assert.equal(term.buffer.active.viewportY,term.buffer.active.baseY,'following reset lands at live end')
 // A user scroll during an asynchronous write takes precedence over its saved intent.
 pin.current=true;const nativeWrite=term.write.bind(term)
 term.write=(data,callback)=>nativeWrite(data,()=>{intent.current++;term.scrollToLine(60);pin.current=false;callback?.()})
 reset('test',lines);await new Promise(r=>nativeWrite('',r))
 assert.equal(term.buffer.active.viewportY,60,'a newer reader gesture wins over the pending reset')
 console.log('restore snapshot: content anchor, live end, and gesture during replay passed')
}finally{term.dispose()}
