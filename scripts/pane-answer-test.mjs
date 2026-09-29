import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'

const work = mkdtempSync(join(tmpdir(), 'pf-answer-'))
try {
  const source = readFileSync('src/main/sessions.ts', 'utf8')
  const methods = source.slice(source.indexOf('  answerStatus('), source.indexOf('  draftOf('))
  const fixture = `
import { PaneAnswers } from ${JSON.stringify(resolve('src/main/paneAnswers.ts'))}
import { feedDraft, newDraft } from ${JSON.stringify(resolve('src/shared/draft.ts'))}
const app={getPath:()=>${JSON.stringify(work)}}
const owedCount=()=>0
import {join} from 'node:path'
const plainTail=(s)=>s, composerHeld=(s)=>s.includes('DIALOG')
let native='11111111-1111-1111-1111-111111111111', received=false, clock=1000
const resumeIdFor=()=>native, codexPromptReceipt=()=>received ? {transcriptAt:1001} : null
const tasks=[]
const setTimeout=(f)=>{tasks.push(f);return {unref(){}}}
export class Harness {
  sessions=new Map(); answering=new Set(); answerLedger; writes=[]
  setOwedPrompt(id,v){this.sessions.get(id).meta.owedPrompt=v}
  write(id,text){const l=this.sessions.get(id);this.writes.push(text);l.draft=feedDraft(l.draft,text).state}
${methods}
}
export function fresh(){const h=new Harness();h.sessions.set('s1-test',{meta:{agent:'codex',status:'working',runSince:100},proc:{pid:1},draft:newDraft(),typed:'',buffer:{read:()=> 'Working · esc to interrupt'}});native='11111111-1111-1111-1111-111111111111';received=false;tasks.length=0;return h}
export function tick(){const fn=tasks.shift();if(!fn)throw Error('No scheduled callback');fn()}
export function identity(v){native=v}
export function receipt(){received=true}
export { PaneAnswers }
`
  writeFileSync(join(work, 'fixture.ts'), fixture)
  buildSync({ entryPoints:[join(work,'fixture.ts')], bundle:true, platform:'node', format:'cjs', outfile:join(work,'fixture.cjs'), logLevel:'silent' })
  const {fresh,tick,identity,receipt,PaneAnswers}=createRequire(import.meta.url)(join(work,'fixture.cjs'))
  let seq=0
  const request=()=>({paneId:'s1-test',expectedConversationId:'11111111-1111-1111-1111-111111111111',requestId:`test-${++seq}`,text:'Synthetic answer\nsecond line'})
  let h=fresh(), r=request()
  assert.equal(h.sessions.get(r.paneId).meta.resumeId, undefined, 'new chats need no public resumeId')
  assert.equal(h.answerPane(r).state,'waiting'); tick(); tick()
  assert.deepEqual(h.writes,[`\x1b[200~${r.text}\x1b[201~`,'\r'])
  assert.equal(h.answerStatus(r).state,'submitted')
  receipt(); tick(); assert.equal(h.answerStatus(r).state,'confirmed')
  assert.equal(h.answerPane(r).state,'confirmed'); assert.equal(h.writes.length,2)
  assert.throws(()=>h.answerPane({...r,text:'different'}),/different text/)
  assert.throws(()=>h.answerStatus({...r,expectedConversationId:'22222222-2222-2222-2222-222222222222'}),/identity mismatch/)
  h=fresh(); r=request(); h.sessions.get(r.paneId).draft={text:'human draft',certain:true}
  h.answerPane(r); tick(); assert.equal(h.writes.length,0); assert.equal(h.sessions.get(r.paneId).draft.text,'human draft')
  identity('changed'); tick(); assert.equal(h.answerStatus(r).state,'rejected'); assert.equal(h.writes.length,0)
  h=fresh(); r=request(); h.answerPane(r); tick(); h.sessions.get(r.paneId).meta.lastKeyboard=123; tick()
  assert.equal(h.answerStatus(r).state,'uncertain'); assert.equal(h.writes.length,1)
  h=fresh(); r=request(); h.answerPane(r); tick(); h.sessions.get(r.paneId).proc={pid:2}; tick()
  assert.equal(h.answerStatus(r).state,'uncertain'); assert.equal(h.writes.length,1)
  h=fresh(); r=request(); h.answerPane(r); identity('wrong'); tick(); assert.equal(h.writes.length,0)
  h=fresh(); r=request(); identity(undefined)
  assert.equal(h.answerPane(r).state,'rejected', 'no native evidence fails closed even when the caller supplies an ID')
  assert.equal(h.writes.length,0)
  identity(r.expectedConversationId)
  assert.equal(h.answerPane(r).state,'rejected', 'rejected request IDs are not silently replayed after identity recovers')
  h=fresh(); r=request(); h.answerPane(r)
  const restored=new PaneAnswers(join(work,'pane-answers.json'))
  assert.equal(restored.accept(r).receipt.state,'uncertain'); assert.equal(restored.accept(r).fresh,false)
  assert.ok(!readFileSync(join(work,'pane-answers.json'),'utf8').includes(r.text))
  const durableFile=join(work,'durability.json'), durable=new PaneAnswers(durableFile), durableRequest=request()
  durable.accept(durableRequest); durable.update(durableRequest,{state:'submitted'})
  mkdirSync(durableFile+'.tmp')
  assert.throws(()=>durable.update(durableRequest,{state:'confirmed',confirmedAt:Date.now()}))
  assert.equal(durable.status(durableRequest).state,'submitted', 'failed persistence cannot advertise a durable confirmation')
  for(const text of ['\x1b[2J','/clear','!rm anything']) assert.throws(()=>h.answerPane({...request(),text}),/Invalid/)
  console.log('Pane answer: busy delivery, exact identity, idempotency, human draft, takeover, process replacement, restart and control-text checks passed')
} finally {rmSync(work,{recursive:true,force:true})}
