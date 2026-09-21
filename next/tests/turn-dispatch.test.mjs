import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchConversationTurn} from '../server/routing.mjs';

function fixture(){
 const calls=[];
 const session={id:'conversation',provider:'codex',nativeSessionId:'native-chat',projectId:'project',laneId:'lane',cwd:'/work',model:'gpt-5.6-terra',effort:'medium'};
 const supervisor={
  sessions:{assertInputAllowed(){},providerFor:s=>s.provider,busy:new Set(),async turn(id,data,steer){calls.push({kind:'chat',id,data,steer});return {accepted:true};}},
  terminal:{state:()=>[],async runCodeTurn(data){calls.push({kind:'pc',data});return {id:'job'};}},
  projects:{requireLane:()=>({id:'lane',name:'lane b',path:'/work'})},
  executionStarting:new Set(),hasActiveCode:()=>false,
  async ensureCodexReady(){return {models:{data:[{id:'gpt-5.6-terra',supportedReasoningEfforts:['medium']}]},rateLimits:{ordinaryUsageAllowed:true,rateLimits:{spendControlReached:false}}};}
 };
 return {session,supervisor,calls};
}
test('a Review-style build reply uses PC Code with the saved lane and original request',async()=>{
 const {supervisor,session,calls}=fixture();
 const result=await dispatchConversationTurn(supervisor,session,{text:'Could you fix the report link?',requestId:'reply-1'});
 assert.equal(result.status,202);assert.equal(result.result.execution,'pc');
 assert.equal(calls.length,1);assert.equal(calls[0].kind,'pc');
 assert.equal(calls[0].data.text,'Could you fix the report link?');
 assert.equal(calls[0].data.laneId,'lane');assert.equal(calls[0].data.requestId,'reply-1');
 assert.equal(supervisor.executionStarting.size,0);
});
test('ordinary replies remain Chat and retain original text',async()=>{
 const {supervisor,session,calls}=fixture();
 await dispatchConversationTurn(supervisor,session,{text:'Explain the result',requestId:'reply-2'});
 assert.equal(calls[0].kind,'chat');assert.equal(calls[0].data.originalText,'Explain the result');
});
test('PC work has a useful saved title before a result or failure can create its Review',async()=>{
 const {supervisor,session}=fixture();session.title='New conversation';
 supervisor.sessions.rename=(id,title)=>{assert.equal(id,session.id);session.title=title;};
 supervisor.terminal.runCodeTurn=async()=>{assert.equal(session.title,'Build the review card');throw Error('PC unavailable');};
 await assert.rejects(dispatchConversationTurn(supervisor,session,{text:'Build  the\nreview card',requestId:'title'}),/PC unavailable/);
 session.title='My chosen title';supervisor.terminal.runCodeTurn=async()=>({id:'job'});
 await dispatchConversationTurn(supervisor,session,{text:'Fix the card',requestId:'followup'});
 assert.equal(session.title,'My chosen title');
});
test('both reply modes refuse active PC, Mac CLI, reconciliation and input locks',async()=>{
 for(const text of ['Explain the result','Fix the result'])for(const fence of ['pc','mac','reconcile','lock','starting']){
  const {supervisor,session,calls}=fixture();
  if(fence==='pc')supervisor.hasActiveCode=()=>true;
  if(fence==='mac')supervisor.terminal.state=()=>[{sessionId:session.id,exited:false,code:{machine:'mac'}}];
  if(fence==='reconcile')session.cliReconciliation={};
  if(fence==='lock')supervisor.sessions.assertInputAllowed=()=>{throw Error('locked');};
  if(fence==='starting')supervisor.executionStarting.add(session.id);
  await assert.rejects(dispatchConversationTurn(supervisor,session,{text,requestId:'reply'}));
  assert.equal(calls.length,0,`${fence}: ${text}`);
 }
});
test('a pending quota check reserves Code startup against a second reply and releases on failure',async()=>{
 const {supervisor,session,calls}=fixture();let reject;
 supervisor.ensureCodexReady=()=>new Promise((_,fail)=>{reject=fail;});
 const first=dispatchConversationTurn(supervisor,session,{text:'Build the card',requestId:'first'});
 await assert.rejects(dispatchConversationTurn(supervisor,session,{text:'Explain it',requestId:'second'}),/starting PC Code/);
 reject(Error('quota unavailable'));await assert.rejects(first,/quota unavailable/);
 assert.equal(supervisor.executionStarting.size,0);assert.equal(calls.length,0);
});
test('Chat rechecks execution ownership after asynchronous provider startup',async()=>{
 const {supervisor,session,calls}=fixture();const live=await supervisor.ensureCodexReady();let release;
 supervisor.ensureCodexReady=()=>new Promise(resolve=>{release=resolve;});
 const pending=dispatchConversationTurn(supervisor,session,{text:'Explain it',requestId:'reply'});
 supervisor.executionStarting.add(session.id);release(live);
 await assert.rejects(pending,/starting PC Code/);assert.equal(calls.length,0);
});
test('PC Review follow-up resumes the remote executor even for an explanation',async()=>{
 const {supervisor,session,calls}=fixture();
 const review={execution:'pc',terminalId:'pc-job',sessionId:session.id,nativeSessionId:'native-pc'};
 supervisor.terminal.state=()=>[{id:'pc-job',sessionId:session.id,projectId:session.projectId,exited:true,code:{kind:'job',nativeSessionId:'native-pc'}}];
 await dispatchConversationTurn(supervisor,session,{text:'Explain the result',requestId:'remote-reply'},false,review);
 assert.equal(calls[0].kind,'pc');assert.equal(calls[0].data.expectedNativeSessionId,'native-pc');assert.equal(calls[0].data.expectedTerminalId,'pc-job');
 assert.equal(session.nativeSessionId,'native-chat');
 supervisor.terminal.state=()=>[];
 await assert.rejects(dispatchConversationTurn(supervisor,session,{text:'Explain the result',requestId:'missing'},false,review),/retained native/);
 assert.equal(calls.length,1);
});
test('review binding is rechecked after provider preflight',async()=>{
 const {supervisor,session,calls}=fixture();
 const review={sessionId:session.id,nativeSessionId:session.nativeSessionId};
 const live=await supervisor.ensureCodexReady();supervisor.ensureCodexReady=async()=>{session.nativeSessionId='replaced';return live;};
 await assert.rejects(dispatchConversationTurn(supervisor,session,{text:'Explain it',requestId:'stale'},false,review),/bound to an active/);
 assert.equal(calls.length,0);
});
