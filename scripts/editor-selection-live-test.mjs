// Draft-only interaction in an explicitly identified, disposable dev pane. Never submits.
import assert from 'node:assert/strict'
import { connect } from './ui-lab.mjs'
const id=process.env.PF_EDITOR_PANE
assert.ok(id,'PF_EDITOR_PANE must identify an owned editor parity test pane')
const q=JSON.stringify(id), c=await connect(process.env.PF_PORT??'9334')
const pause=ms=>new Promise(r=>setTimeout(r,ms))
let checks=0
try {
 const session=await c.evaluate(`window.api.listSessions().then(a=>a.find(s=>s.id===${q}))`)
 assert.ok(session && /editor parity test/i.test(session.title) && /\/tmp\/pf-editor-parity$/.test(session.cwd),'refuse to edit a user pane')
 await c.evaluate(`document.querySelector('.row[data-id="'+${q}+'"]')?.click()`)
 await pause(160)
 const inspect=()=>c.evaluate(`(()=>{const p=window.__pf[${q}],s=p.inputRows(),t=p.term;return {cols:t.cols,span:s,lines:s?.rows.map((r,i)=>t.buffer.active.getLine(s.top+i).translateToString(true).slice(r.start,r.end)),cursor:[t.buffer.active.cursorX,t.buffer.active.baseY+t.buffer.active.cursorY],batches:p.clickKeys().length}})()`)
 async function selectAll(){await c.evaluate(`(()=>{const p=window.__pf[${q}],s=p.inputRows();if(!s)throw Error('No verified composer');p.term.focus();p.term.select(s.rows[0].start,s.top,(s.rows.length-1)*p.term.cols+s.rows.at(-1).end-s.rows[0].start)})()`)}
 async function key(key,text){await c.send('Input.dispatchKeyEvent',{type:'keyDown',key,...(text?{text}:{}),windowsVirtualKeyCode:key==='Backspace'?8:90});await c.send('Input.dispatchKeyEvent',{type:'keyUp',key,windowsVirtualKeyCode:key==='Backspace'?8:90})}
 async function clear(){await selectAll();await key('Backspace');await pause(180)}
 const cols=(await inspect()).cols
 const cases=[
  {text:'alpha beta gamma',partial:true,replace:true,want:'alpha Z gamma'},
  {text:'x'.repeat(cols-3)+' '+'y'.repeat(20)},
  {text:'x'.repeat(cols-3)+' '+'y'.repeat(20),replace:true,want:'Z'},
  {text:'x'.repeat(cols+21)},
  {text:'first line\nsecond line',fromStart:true,replace:true,want:'Z'}
 ]
 for(const test of cases){
  await clear()
  await c.evaluate(`window.__pf[${q}].term.focus()`)
  await c.send('Input.insertText',{text:test.text})
  await pause(1000)
  const before=await inspect()
  assert.equal(before.lines.join('').replace(/\s/g,''),test.text.replace(/\s/g,''),'seed draft must be visible before selection')
  if(test.fromStart){await c.evaluate(`window.api.write(${q},'\\x1b[D'.repeat(${test.text.length+3}))`);await pause(500);const moved=await inspect();assert.deepEqual(moved.cursor,[moved.span.rows[0].start,moved.span.top],'caret must reach input start')}
  if(test.partial)await c.evaluate(`(()=>{const p=window.__pf[${q}],s=p.inputRows();p.term.select(s.rows[0].start+6,s.top,4)})()`)
  else await selectAll()
  const batches=(await inspect()).batches
  await key(test.replace?'Z':'Backspace',test.replace?'Z':undefined)
  await pause(1500)
  const after=await inspect(), actual=after.lines.join('')
  if(test.want)assert.equal(actual,test.want,'replacement must contain exactly the requested text')
  else assert.ok(actual==='' || /^[❯>]\s*$/.test(actual) || /^(Ask Codex to do anything|Try |Ask |Type )/.test(actual),`selected draft remains: ${actual}`)
  assert.equal(after.batches-batches,1,'selection must use one key batch, without delayed correction')
  checks++
 }
 console.log(`${session.agent} actual editor: ${checks} deletion/replacement cases passed; no prompt submitted`)
} finally {c.close()}
