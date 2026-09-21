import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ReviewStore } from '../server/review-store.mjs';

const session={id:'session_1',nativeSessionId:'native_1',title:'A <title>',provider:'codex',cwd:process.cwd(),items:[]};
test('PC failures retain attention without inventing a native identity, and completion supersedes interruption',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pf-pc-attention-'));try{
  const notices=[], store=new ReviewStore(dir,{onRecord:r=>notices.push({...r})});
  const owner={...session,projectId:'project'};
  const terminal={id:'terminal',sessionId:owner.id,projectId:'project',code:{kind:'job',provider:'codex',checkout:'C:\\work',nativeSessionId:'unrelated-later-native',requests:{request:{status:'uncertain',text:'Build it',error:'Connection lost'}}}};
  const issue=store.capturePcTurn(terminal,'request',owner);
  assert.equal(issue.kind,'blocked');assert.equal(issue.proof,'unverified');assert.equal(issue.nativeSessionId,null);assert.equal(issue.informational,false);assert.equal(issue.prompt,'Build it');assert.match(issue.report,/Do not retry automatically/);
  assert.equal(store.ack(issue.id,true).clearedAttention,false);
  const recovered=new ReviewStore(dir);assert.equal(recovered.list()[0].attention,true);
  store.capturePcTurn(terminal,'request',owner);assert.equal(notices.length,1);
  terminal.code.requests.request={...terminal.code.requests.request,status:'completed',nativeSessionId:'actual-native',finalText:'Work finished',outcome:'unverified'};
  const completed=store.capturePcTurn(terminal,'request',owner);
  assert.notEqual(completed.id,issue.id);assert.equal(completed.nativeSessionId,'actual-native');assert.equal(completed.kind,'result');
  assert.equal(store.read(issue.id).resolvedBy,completed.id);assert.equal(store.list().find(r=>r.id===issue.id).attention,false);assert.equal(store.list().find(r=>r.id===completed.id).attention,true);
  assert.equal(store.read(issue.id).report,issue.report);assert.equal(notices.length,3);
  assert.equal(notices[2].id,issue.id);assert.equal(notices[2].resolvedBy,completed.id);
  const redelivered=[], restarted=new ReviewStore(dir,{onRecord:r=>redelivered.push({...r})});
  assert.equal(restarted.capturePcTurn(terminal,'request',owner).id,completed.id);
  assert.equal(redelivered.length,1);assert.equal(redelivered[0].id,issue.id);assert.equal(redelivered[0].resolvedAt,notices[2].resolvedAt);
  assert.equal(restarted.list().length,2);assert.equal(restarted.read(completed.id).reviewedAt,undefined);
  assert.equal(restarted.list().find(r=>r.id===completed.id).attention,true);
  terminal.code.requests.failure={status:'failed',text:'Follow up',error:'Runner failed',nativeSessionId:'actual-native'};
  const failure=store.capturePcTurn(terminal,'failure',owner);assert.equal(failure.nativeSessionId,'actual-native');assert.match(failure.report,/Runner failed/);assert.equal(failure.attention,true);
  assert.throws(()=>store.capturePcTurn(terminal,'failure',{...owner,projectId:'other'}),/different conversation/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('reviews survive restart and decision or blocked acknowledgement never clears attention',()=>{const dir=mkdtempSync(join(tmpdir(),'pf-reviews-'));try{const store=new ReviewStore(dir);store.record({id:'decision_1',sessionId:session.id,kind:'decision',proof:'claimed',report:'Need approval',prompt:'Original'},session);store.record({id:'blocked_1',sessionId:session.id,kind:'blocked',proof:'measured',report:'Blocked',prompt:'Original'},session);assert.deepEqual(store.ack('decision_1',true),{ok:true,clearedAttention:false});assert.deepEqual(store.ack('blocked_1',false),{ok:true,clearedAttention:false});const reloaded=new ReviewStore(dir);assert.equal(reloaded.list().length,2);assert.equal(reloaded.list().every(r=>r.attention),true);}finally{rmSync(dir,{recursive:true,force:true});}});
test('completed turn stores exact request and its matching final outcome once',()=>{const dir=mkdtempSync(join(tmpdir(),'pf-reviews-'));try{const store=new ReviewStore(dir);const active={...session,items:[{id:'old',turnId:'oldturn',type:'agentMessage',text:'old output'},{id:'new',turnId:'turn_1',type:'agentMessage',text:'final output'}],activeReviewRequest:{requestId:'request_1',text:'original request'}};const record=store.captureCompletedTurn(active,{id:'turn_1',status:'completed'});assert.match(record.report,/final output/);assert.doesNotMatch(record.report,/old output/);assert.equal(record.prompt,'original request');assert.equal(store.captureCompletedTurn(active,{id:'turn_1',status:'completed'}),null);const html=readFileSync(record.reportPath,'utf8');assert.match(html,/A &lt;title&gt;/);}finally{rmSync(dir,{recursive:true,force:true});}});
test('only a retained completed outcome is informational',()=>{const dir=mkdtempSync(join(tmpdir(),'pf-reviews-'));try{const store=new ReviewStore(dir);const completed={...session,items:[{id:'new',turnId:'turn_2',type:'agentMessage',text:'done'}],activeReviewRequest:{requestId:'request_2',text:'original request'}};assert.equal(store.captureCompletedTurn(completed,{id:'turn_2',status:'completed'}).informational,true);const missing={...session,items:[],activeReviewRequest:{requestId:'request_3',text:'original request'}};assert.equal(store.captureCompletedTurn(missing,{id:'turn_3',status:'completed'}).informational,false);}finally{rmSync(dir,{recursive:true,force:true});}});
test('review records require a real native session identity',()=>{const dir=mkdtempSync(join(tmpdir(),'pf-reviews-'));try{assert.throws(()=>new ReviewStore(dir).record({id:'result_1',sessionId:'session_1',kind:'result',proof:'claimed',report:'output'}, {...session,nativeSessionId:null}),/native session ID/);}finally{rmSync(dir,{recursive:true,force:true});}});

test('completed capture persists request identity and observed lane',()=>{const dir=mkdtempSync(join(tmpdir(),'pf-reviews-'));try{const store=new ReviewStore(dir);
 const s={id:'session-request',nativeSessionId:'native-request',title:'Lane work',provider:'codex',cwd:'/tmp/lane',laneId:'lane-b',laneName:'Lane B',kind:'conversation',activeReviewRequest:{requestId:'request-identity',text:'Please implement it'},items:[{id:'answer',type:'agentMessage',turnId:'turn-request',text:'Completed.'}]};
 const record=store.captureCompletedTurn(s,{id:'turn-request',status:'completed'});
 assert.equal(record.requestId,'request-identity');assert.equal(record.lane,'Lane B · lane-b');assert.equal(s.activeReviewRequest,undefined);
}finally{rmSync(dir,{recursive:true,force:true});}});
