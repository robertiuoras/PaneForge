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
import { ASK_PROMPT, composerHeld } from ${JSON.stringify(resolve('src/shared/busy.ts'))}
import { stripAnsi as strip } from ${JSON.stringify(resolve('src/shared/ansi.ts'))}
const app={getPath:()=>${JSON.stringify(work)}}
const owedCount=()=>0
import {join} from 'node:path'
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
  const blockers = [
    ['question metadata', live => { live.meta.ask = { question: 'Synthetic choice' } }],
    ...[
      ['approval dialog', 'Do you want to run this command?'],
      ['numbered choice', '\x1b[32m❯ 1. Allow once\x1b[0m'],
      ['chooser footer below long preview', 'Synthetic preview '.repeat(40) + '\n  Enter to select · ↑/↓ to navigate · Esc to cancel'],
      ['yes/no question', 'Continue? (y/n)\nWorking · esc to interrupt'],
      ['confirmation footer', 'Press Enter to confirm'],
      ['waiting on reply', 'Waiting for your reply'],
      ['connecting composer', '/rc connecting…']
    ].map(([name, frame]) => [name, live => { live.buffer.read = () => frame }])
  ]
  for (const [name, block] of blockers) {
    h=fresh(); r=request(); let live=h.sessions.get(r.paneId)
    block(live); h.answerPane(r); tick()
    assert.equal(h.answerStatus(r).state,'waiting', `${name}: wait before paste`)
    assert.equal(h.writes.length,0, `${name}: no paste into dialog`)
    delete live.meta.ask; live.buffer.read=()=>'Working · esc to interrupt'
    tick(); tick(); receipt(); tick()
    assert.equal(h.answerStatus(r).state,'confirmed', `${name}: clearing blocker permits delivery`)
    assert.deepEqual(h.writes,[`\x1b[200~${r.text}\x1b[201~`,'\r'])

    h=fresh(); r=request(); live=h.sessions.get(r.paneId)
    h.answerPane(r); tick(); block(live); tick()
    assert.equal(h.answerStatus(r).state,'uncertain', `${name}: newly appeared dialog withholds Enter`)
    assert.deepEqual(h.writes,[`\x1b[200~${r.text}\x1b[201~`], `${name}: no Enter into dialog`)
    assert.equal(live.draft.text,r.text, `${name}: pasted text preserved`)
    assert.equal(h.answerPane(r).state,'uncertain', `${name}: no replay`)
    assert.equal(h.writes.length,1)
  }
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
  console.log(`Pane answer: busy delivery, ${blockers.length} real-helper dialog guards at both boundaries, exact identity, idempotency, human draft, takeover, process replacement, restart and control-text checks passed`)
} finally {rmSync(work,{recursive:true,force:true})}
