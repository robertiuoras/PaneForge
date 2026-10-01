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
  const ownershipWrite = source.slice(source.indexOf('  write(id: string,'), source.indexOf('    // Before a byte moves:', source.indexOf('  write(id: string,')))
  const queueVerdict = source.slice(source.indexOf('    const verdict = (live: Live,'), source.indexOf('    // The busy read is of the LAST THING PAINTED', source.indexOf('    const verdict = (live: Live,')))
  const fixture = `
import { PaneAnswers } from ${JSON.stringify(resolve('src/main/paneAnswers.ts'))}
import { feedDraft, newDraft } from ${JSON.stringify(resolve('src/shared/draft.ts'))}
import { ASK_PROMPT, composerHeld } from ${JSON.stringify(resolve('src/shared/busy.ts'))}
import { stripAnsi as strip } from ${JSON.stringify(resolve('src/shared/ansi.ts'))}
import { isTerminalReply } from ${JSON.stringify(resolve('src/shared/terminalProtocol.ts'))}
import { queuedPromptDecision } from ${JSON.stringify(resolve('src/shared/autoclear.ts'))}
type WriteOrigin='app'|'desk'
const REPAINT_GRACE_MS=100
const app={getPath:()=>${JSON.stringify(work)}}
let owed=0
const owedCount=()=>owed, stillOwed=()=>owed>0, typedOwed=()=>[]
import {join} from 'node:path'
let native='11111111-1111-1111-1111-111111111111', received=false, clock=1000
const Date={now:()=>clock}
const resumeIdFor=()=>native, codexPromptReceipt=()=>received ? {transcriptAt:1001} : null
let recover=false, recovery
let pendingQuestion=true, endedQuestions=new Set()
const codexQuestionPending=(cwd,id,toolUseId)=>pendingQuestion&&!endedQuestions.has(toolUseId)
const claimCodexFromProcess=async()=>{if(recovery)await recovery;if(recover)native='11111111-1111-1111-1111-111111111111';return recover}
const tasks=[]
const setTimeout=(f)=>{tasks.push(f);return {unref(){}}}
export class Harness {
  sessions=new Map(); answering=new Set(); pendingAnswers=new Map(); codexQueued=new Map(); autoClearPending=new Set(); autoClearArmTimers=new Map(); answerLedger; writes=[]
  setOwedPrompt(id,v){this.sessions.get(id).meta.owedPrompt=v}
  write(id,text){const l=this.sessions.get(id);this.writes.push(text);l.draft=feedDraft(l.draft,text).state;if(text==='\\r')l.meta.lastKeyboard=clock}
  queueVerdict(id, composerIdle=false){const live=this.sessions.get(id),owner=this.codexQueued.get(id),mark=0,takenMark=0,deadline=0,personDeadline=0,PERSON_QUIET_MS=120;${queueVerdict}return verdict(live,composerIdle)}
  cancelCodexQueued(){throw Error('No cancellation expected')}
  ${ownershipWrite.replace('  write(', 'ownershipWrite(')}
  }
${methods}
}
export function fresh(){const h=new Harness();h.sessions.set('s1-test',{req:{},meta:{cwd:'fixture',agent:'codex',status:'working',runSince:100},proc:{pid:1},draft:newDraft(),typed:'',buffer:{read:()=> 'Working · esc to interrupt'}});native='11111111-1111-1111-1111-111111111111';received=false;recover=false;recovery=undefined;pendingQuestion=true;endedQuestions.clear();owed=0;clock=1000;tasks.length=0;return h}
export function expire(){clock+=120001}
export function age(){clock+=7*86400000}
export function endQuestion(toolUseId){if(toolUseId)endedQuestions.add(toolUseId);else pendingQuestion=false}
export function queue(h, active={}){const live=h.sessions.get('s1-test');owed=1;live.meta.owedPrompt=true;const row={live,proc:live.proc,key:'retained',prompt:'Synthetic ownership receipt',since:0,writing:false,foreign:false,...active};h.codexQueued.set('s1-test',row);return row}
export function recoverIdentity(wait){recover=true;recovery=wait}
export function tick(){const fn=tasks.shift();if(!fn)throw Error('No scheduled callback');fn()}
export function identity(v){native=v}
export function receipt(){received=true}
export { PaneAnswers }
`
  writeFileSync(join(work, 'fixture.ts'), fixture)
  buildSync({ entryPoints:[join(work,'fixture.ts')], bundle:true, platform:'node', format:'cjs', outfile:join(work,'fixture.cjs'), logLevel:'silent' })
  const {fresh,tick,identity,receipt,recoverIdentity,queue,endQuestion,expire,age,PaneAnswers}=createRequire(import.meta.url)(join(work,'fixture.cjs'))
  let seq=0
  const request=()=>({paneId:'s1-test',expectedConversationId:'11111111-1111-1111-1111-111111111111',requestId:`test-${++seq}`,toolUseId:`call-${seq}`,questionCount:1,text:'Synthetic answer\nsecond line'})
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
  assert.equal(h.answerPane(r).state,'waiting', 'identity verification happens before any bytes')
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(h.answerStatus(r).state,'rejected', 'no native evidence fails closed even when the caller supplies an ID')
  assert.equal(h.writes.length,0)
  identity(r.expectedConversationId)
  assert.equal(h.answerPane(r).state,'rejected', 'rejected request IDs are not silently replayed after identity recovers')
  h=fresh(); r=request(); identity(undefined); recoverIdentity()
  h.answerPane(r); assert.equal(h.writes.length,0)
  await new Promise(resolve=>setImmediate(resolve)); tick(); receipt(); tick()
  assert.equal(h.answerStatus(r).state,'confirmed', 'live process proof recovers an edited prompt identity')
  h=fresh(); r=request(); identity(undefined); let release
  recoverIdentity(new Promise(resolve=>{release=resolve})); h.answerPane(r)
  h.sessions.get(r.paneId).proc={pid:2}; release()
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(h.answerStatus(r).state,'rejected', 'replacement during process verification prevents delivery')
  assert.equal(h.writes.length,0)
  h=fresh(); r=request(); identity(undefined); h.sessions.get(r.paneId).meta.owedPrompt=true
  assert.equal(h.answerPane(r).state,'rejected', 'process recovery does not steal another prompt reservation')
  h=fresh(); r=request(); const queued=queue(h); identity(undefined); recoverIdentity()
  h.answerPane(r); await new Promise(resolve=>setImmediate(resolve)); tick(); receipt(); tick()
  assert.equal(h.answerStatus(r).state,'confirmed', 'a waiting queued prompt permits exact process identity recovery and answer')
  assert.equal(h.codexQueued.get(r.paneId),queued); assert.equal(queued.prompt,'Synthetic ownership receipt')
  assert.equal(queued.since,0); assert.equal(queued.foreign,false); assert.equal(h.sessions.get(r.paneId).meta.owedPrompt,true)
  assert.equal(queued.answerKeyboard,h.sessions.get(r.paneId).meta.lastKeyboard,'authenticated answer records its own turn boundary')
  age()
  assert.equal(h.queueVerdict(r.paneId),'wait','queued intent survives seven days behind an authenticated answer turn')
  h.sessions.get(r.paneId).meta.runSince=undefined; h.sessions.get(r.paneId).busyUntil=0
  assert.equal(h.queueVerdict(r.paneId,true),'type','the same retained intent can deliver after the answer turn finishes')
  h.sessions.get(r.paneId).draft={text:'human draft',certain:true};h.sessions.get(r.paneId).meta.drafting=true
  assert.equal(h.queueVerdict(r.paneId,true),'abandon','a real human draft retains its existing far ceiling and is never pasted over')
  h.sessions.get(r.paneId).draft=undefined;h.sessions.get(r.paneId).meta.drafting=false
  h.answering.add(r.paneId);h.ownershipWrite(r.paneId,'synthetic answer','app')
  assert.equal(queued.foreign,false,'actual write ownership guard preserves waiting queue during authenticated answer')
  h.ownershipWrite(r.paneId,'human typing','desk')
  assert.equal(queued.foreign,true,'actual human write still takes queue composer ownership')
  assert.equal(h.queueVerdict(r.paneId,true),'abandon','foreign editing restores the person-owned expiry even at the same keyboard timestamp')
  h=fresh(); r=request(); const untouched=queue(h)
  h.ownershipWrite(r.paneId,'\x1b[B','desk')
  assert.equal(untouched.foreign,true,'native question navigation marks an untouched queued prompt foreign')
  assert.equal(h.answerPane(r).state,'waiting','native question input leaves an unpasted queue available for the answer');tick();tick();receipt();tick()
  assert.equal(h.answerStatus(r).state,'confirmed','question input before the queued paste does not reserve the composer')
  assert.deepEqual(h.writes,[`\x1b[200~${r.text}\x1b[201~`,'\r'])
  assert.equal(h.codexQueued.get(r.paneId),untouched);assert.equal(untouched.since,0);assert.equal(untouched.foreign,true)
  h=fresh();r=request();queue(h,{foreign:true});h.sessions.get(r.paneId).draft={text:'human draft kept',certain:true}
  h.answerPane(r);tick();assert.equal(h.writes.length,0);assert.equal(h.sessions.get(r.paneId).draft.text,'human draft kept')
  expire();tick();assert.equal(h.answerStatus(r).state,'rejected','foreign waiting queue still preserves a human draft')
  for(const active of [{since:100},{since:100,foreign:true},{writing:true}]) {
    h=fresh(); r=request(); queue(h,active)
    assert.equal(h.answerPane(r).state,'rejected','active/edited queue ownership refuses answer'); assert.equal(h.writes.length,0)
  }
  for(const reserve of [l=>l.meta.handoverUntil=Date.now()+10000,l=>l.meta.autoClearAt=Date.now()+10000]) {
    h=fresh();r=request();queue(h);reserve(h.sessions.get(r.paneId))
    assert.equal(h.answerPane(r).state,'rejected','handover or automatic clear cannot be bypassed')
    h=fresh();r=request();queue(h);h.answerPane(r);tick();reserve(h.sessions.get(r.paneId));tick()
    assert.equal(h.answerStatus(r).state,'uncertain','new handover after paste withholds Enter');assert.equal(h.writes.length,1)
  }
  h=fresh(); const first=request(),second={...request(),text:'Second independent synthetic answer'};queue(h)
  h.answerPane(first);h.answerPane(second);tick();tick()
  assert.equal(h.writes.length,1,'second question waits while first owns composer');tick();receipt();tick();tick();tick();tick()
  assert.equal(h.answerStatus(first).state,'confirmed');assert.equal(h.answerStatus(second).state,'confirmed')
  assert.deepEqual(h.writes,[`\x1b[200~${first.text}\x1b[201~`,'\r',`\x1b[200~${second.text}\x1b[201~`,'\r'])
  assert.equal(h.pendingAnswers.size,0);assert.equal(h.answering.size,0);assert.equal(h.sessions.get(first.paneId).meta.owedPrompt,true)
  h=fresh(); const failedFirst=request(),pendingSecond=request(),retainedQueue=queue(h)
  h.answerPane(failedFirst);h.answerPane(pendingSecond);endQuestion(failedFirst.toolUseId);tick();tick();tick();receipt();tick()
  assert.equal(h.answerStatus(failedFirst).state,'rejected','ended first question releases its composer reservation')
  assert.equal(h.answerStatus(pendingSecond).state,'confirmed','independent still-pending second question proceeds after first fails')
  assert.deepEqual(h.writes,[`\x1b[200~${pendingSecond.text}\x1b[201~`,'\r'])
  assert.equal(h.codexQueued.get(pendingSecond.paneId),retainedQueue);assert.equal(retainedQueue.prompt,'Synthetic ownership receipt')
  assert.equal(h.sessions.get(pendingSecond.paneId).meta.owedPrompt,true);assert.equal(h.pendingAnswers.size,0);assert.equal(h.answering.size,0)
  h=fresh();r=request();const later=request();h.answerPane(r);h.answerPane(later);identity('changed');tick();tick()
  assert.equal(h.answerStatus(r).state,'rejected');assert.equal(h.answerStatus(later).state,'rejected')
  assert.equal(h.pendingAnswers.size,0);assert.equal(h.answering.size,0);assert.equal(h.writes.length,0)
  h=fresh();r=request();h.answerPane(r);endQuestion();tick()
  assert.equal(h.answerStatus(r).state,'rejected','an answered/ended question is not written');assert.equal(h.writes.length,0)
  h=fresh();r=request();h.answerPane(r);tick();endQuestion();tick()
  assert.equal(h.answerStatus(r).state,'uncertain','question answered after paste withholds Enter');assert.equal(h.writes.length,1)
  h=fresh();r=request();queue(h);h.sessions.get(r.paneId).draft={text:'human draft kept',certain:true}
  h.answerPane(r);tick();expire();tick()
  assert.equal(h.answerStatus(r).state,'rejected','occupied draft wait is bounded')
  assert.equal(h.pendingAnswers.size,0);assert.equal(h.answering.size,0);assert.equal(h.writes.length,0)
  assert.equal(h.sessions.get(r.paneId).draft.text,'human draft kept');assert.equal(h.sessions.get(r.paneId).meta.owedPrompt,true)
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
