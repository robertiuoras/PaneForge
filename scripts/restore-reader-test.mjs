// Run the renderer's repair against a real terminal. Automatic repairs must retain intent.
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {transformSync} from 'esbuild'
const require=createRequire(import.meta.url), {Terminal}=require('@xterm/headless')
const alertsSource=readFileSync(new URL('../src/shared/alerts.ts',import.meta.url),'utf8')
const {withoutBinaryBells}=await import('data:text/javascript;base64,'+Buffer.from(transformSync(alertsSource,{loader:'ts',format:'esm'}).code).toString('base64'))
const src=readFileSync(new URL('../src/renderer/src/components/TerminalPane.tsx',import.meta.url),'utf8')
const from=src.indexOf('    const noteFix = ('),to=src.indexOf('\n    /**',from)
assert(from>0&&to>from)
const code=transformSync(src.slice(from,to)+'\nreturn repair',{loader:'ts'}).code
const t=new Terminal({cols:85,rows:30,allowProposedApi:true})
// Headless xterm has no renderer; the real repair still reaches its delayed reading.
t.refresh=()=>{}
await new Promise(r=>t.write(Array.from({length:300},(_,i)=>`row ${i}\r\n`).join(''),r))
const pinned={current:false},fixWhy={current:'restore'},states=[],records=[],timers=[]
const fixSource=readFileSync(new URL('../src/shared/fixSign.ts',import.meta.url),'utf8')
const {fixSignature}=await import('data:text/javascript;base64,'+Buffer.from(transformSync(fixSource,{loader:'ts',format:'esm'}).code).toString('base64'))
const lastByteAt={current:Date.now()}
const repair=new Function('t','f','pinned','fixWhy','list','reshape','api','sessionId','setScrolledUp','window','dead','seedMarks','RESTORE_FIX_MS','fixSignature','lastByteAt',`
const agent='codex',replayColsRef={current:null},replayRowsRef={current:null},mirrorRef={current:false},asleepRef={current:false},lastResizeAt={current:0},mountAt={current:Date.now()},restoreFixes={current:0};
${code}`)(t,{},pinned,fixWhy,[],()=>{if(pinned.current)t.scrollToBottom()},{redraw(){},logFix:record=>records.push(record)},'test',v=>states.push(v),{setTimeout:fn=>timers.push(fn)},false,()=>{},1200,fixSignature,lastByteAt)
try{
 for(const why of ['restore','wipe']){
  t.scrollToLine(100);pinned.current=false;fixWhy.current=why;repair()
  assert.equal(t.buffer.active.viewportY,100,`${why} repair preserves reader anchor`)
  assert.equal(pinned.current,false,`${why} repair preserves reader intent`)
 }
 t.scrollToBottom();pinned.current=true;fixWhy.current='restore';repair();assert.equal(t.buffer.active.viewportY,t.buffer.active.baseY)
 t.scrollToLine(100);pinned.current=false;fixWhy.current='pressed';repair();assert.equal(t.buffer.active.viewportY,t.buffer.active.baseY,'explicit Fix retains its requested latest-frame behavior')
 while(timers.length)timers.shift()()
 records.length=0
 t.scrollToLine(100);pinned.current=false;fixWhy.current='restore';repair()
 const before=records[0]
 assert.equal(before.buffer,'normal')
 assert.equal(before.mouseTracking,'none')
 assert.equal(before.bracketedPaste,false)
 assert.equal(before.viewportY,100,'diagnostics retain the pre-repair scroll position')
 assert(before.baseY>before.viewportY)
 // Model the CLI repaint settling after a damaged normal-buffer frame. The delayed
 // record must observe the new modes, not reuse the reading made before repair.
 await new Promise(r=>t.write('\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?2004hPRIVATE PROMPT',r))
 lastByteAt.current=Date.now()
 timers.shift()()
 const after=records.at(-1)
 assert.equal(after.step,'repair-markers')
 assert.equal(after.buffer,'alternate')
 assert.equal(after.mouseTracking,'any')
 assert.equal(after.bracketedPaste,true)
 assert.equal(after.viewportY,0)
 assert.equal(after.baseY,0)
 assert.equal(typeof after.sinceByteMs,'number','recent output distinguishes a live agent from a stopped one')
 assert.equal(JSON.stringify(records).includes('PRIVATE PROMPT'),false,'diagnostics never record terminal text')
 assert.equal(JSON.stringify(records).includes('row 100'),false,'scrollback text stays private too')
 console.log('repair diagnostics: before/after modes, scroll position, recent output, and text privacy passed')
 console.log('restore reader: automatic reader/tail and explicit repair passed')
}finally{t.dispose()}

// Exercise the actual reset handler: a full log omits a screen of trailing repaint
// blanks that the live buffer had. Keeping tail distance used to move the reader.
const resetFrom=src.indexOf('    const receiveReset = (')
const resetTo=src.indexOf('\n    const writeData =',resetFrom)
assert(resetFrom>0&&resetTo>resetFrom)
const resetCode=transformSync(src.slice(resetFrom,resetTo),{loader:'ts'}).code
const term=new Terminal({cols:85,rows:30,allowProposedApi:true})
const lines=Array.from({length:300},(_,i)=>`conversation row ${i}\r\n`).join('')
const write=data=>new Promise(r=>term.write(data,r))
let reset
const pin={current:false},intent={current:0}
new Function('api','t','pinned','scrollIntent','setScrolledUp','mirrorRef','withoutBinaryBells',`
const sessionId='test',list=[],publish=()=>{},dead=false,setBlank=()=>{},window={clearTimeout(){}},wipeTimer=0,makeKeeper=()=>x=>x,withoutReplayQueries=x=>x,seedMarks=()=>{},drainTyped=()=>{};
let replayEvents=null; const drainReplayEvents=()=>{replayEvents=null};
const dropWipeSnap=()=>{wipeSnap=null};
let initialReplay, sawOutput=false,wipeSnap=null,keep=x=>x,readingSnapshot=false,pendingDataWrites=0,awaitingInitialReplay=false;
const cleanOutput=(d)=>withoutBinaryBells(keep(d));
const writeStaged=(b,done)=>t.write(b,done); // the stage itself is proved by replay-width-test
${resetCode}
`)({onPaneReset:fn=>{reset=fn}},term,pin,intent,()=>{},{current:true},withoutBinaryBells)
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
