import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {Sessions,searchSavedConversationHistory,assignLegacyPaneForgeNextProject} from '../server/sessions.mjs';

class FakeCodex extends EventEmitter {
  sent=[]; calls=[];
  send(message){this.sent.push(message);}
  async rpc(method,params){this.calls.push({method,params});return {turn:{id:'turn-next'}};}
}
class FakeClaude {
  calls=[]; running=new Map();
  async start(){return {status:'ready',authType:'claude.ai',plan:'max',model:'claude'};}
  create(){return '11111111-1111-4111-8111-111111111111';}
  async resume(nativeSessionId){this.calls.push(['resume',nativeSessionId]);return {nativeSessionId};}
  async send(input){this.calls.push(['send',input]);input.onEvent({type:'delta',text:'Claude '});input.onEvent({type:'delta',text:'answer'});return {nativeSessionId:input.sessionId,text:'Claude answer'};}
  async stop(nativeSessionId){this.calls.push(['stop',nativeSessionId]);return true;}
}
test('assistant tool upgrade preserves old provider identity and original history through resume',async()=>{const t=fixture();try{
 const s={id:'assistant-paneforge-next',kind:'assistant',projectId:'paneforge-next',providerThreadId:'old-provider',nativeSessionId:'old-native',cwd:'/synthetic',items:[{id:'old-answer',text:'Original saved answer'}],voiceHistory:[{delta:'Original speech'}],requests:{},status:'idle'};t.sessions.sessions=[s];t.sessions.provider={status:'ready'};
 t.codex.rpc=async(method,params)=>{t.codex.calls.push({method,params});return {'thread/start':{thread:{id:'new-provider',sessionId:'new-native',cwd:'/synthetic'}},'thread/resume':{thread:{cwd:'/synthetic'}},'thread/items/list':{data:[{item:{id:'new-answer',text:'New answer'}}]},'thread/turns/list':{data:[]}}[method]};
 await t.sessions.ensureNative(s);assert.equal(s.id,'assistant-paneforge-next');assert.equal(s.providerLineage[0].threadId,'old-provider');assert.equal(s.providerLineage[0].nativeSessionId,'old-native');assert(t.codex.calls[0].params.dynamicTools.length>=9);assert.match(t.codex.calls[0].params.developerInstructions,/Workspace actions may select any connected project/);assert.match(t.codex.calls[0].params.developerInstructions,/MCP project tools remain bound/);await t.sessions.resume(s.id);assert.deepEqual(s.items.map(i=>i.id),['old-answer','new-answer']);assert.equal(s.voiceHistory[0].delta,'Original speech');assert.equal(await t.sessions.ensureNative(s),'new-provider');assert.equal(t.codex.calls.filter(c=>c.method==='thread/start').length,1);
}finally{t.close();}});
test('dynamic tools require an active assistant turn and trusted UI client context',async()=>{const t=fixture();try{
 const s=t.sessions.sessions[0];s.kind='assistant';s.actionClientId='native-window';let executed=0;t.sessions.workspaceExecutor={execute:async(tool,args,context)=>{executed++;assert.equal(context.clientId,'native-window');return {state:'navigation_requested'}}};
 const request={id:10,method:'item/tool/call',params:{threadId:'thread-a',turnId:'turn-a',tool:'open_workspace_session',arguments:{},callId:'call-a'}};await t.sessions.workspaceRequest(request);assert.equal(executed,1);assert.equal(t.codex.sent.at(-1).result.success,true);
 await t.sessions.workspaceRequest({...request,params:{...request.params,turnId:'stale'}});s.kind='conversation';await t.sessions.workspaceRequest(request);s.kind='assistant';delete s.actionClientId;await t.sessions.workspaceRequest(request);assert.equal(executed,1);assert.equal(t.codex.sent.at(-1).result.success,false);
}finally{t.close();}});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'paneforge-sessions-'));const codex=new FakeCodex(),claude=new FakeClaude();const sessions=new Sessions(codex,dir,undefined,claude);sessions.sessions=[{id:'thread-a',nativeSessionId:'native-a',items:[],activeTurn:'turn-a',status:'running',requests:{}}];return {dir,codex,claude,sessions,close(){rmSync(dir,{recursive:true,force:true});}};}

test('an idempotent retry leaves a quietly parked conversation parked',async()=>{const t=fixture();try{
 const s=t.sessions.get('thread-a');s.activeTurn=null;s.status='parked';s.parkedAt='2026-09-21T00:00:00.000Z';s.requests['accepted-once']={requestId:'accepted-once',state:'accepted',turnId:'turn-old'};
 const duplicate=await t.sessions.turn(s.id,{text:'continue',requestId:'accepted-once'});
 assert.equal(duplicate.requestId,'accepted-once');assert.equal(s.status,'parked');assert.equal(s.parkedAt,'2026-09-21T00:00:00.000Z');assert.equal(t.codex.calls.length,0);
}finally{t.close();}});

test('fixture approval is bound to the active conversation turn',()=>{const t=fixture();try{
  t.codex.emit('request',{id:42,method:'mcpServer/elicitation/request',params:{threadId:'thread-a',turnId:'turn-a',serverName:'paneforge_fixture',message:'confirm',requestedSchema:{}}});
  assert.deepEqual(t.sessions.approvals.map(({id,threadId,turnId})=>({id,threadId,turnId})),[{id:'42',threadId:'thread-a',turnId:'turn-a'}]);
  t.codex.emit('request',{id:43,method:'mcpServer/elicitation/request',params:{threadId:'thread-a',turnId:'old-turn',serverName:'paneforge_fixture'}});
  assert.equal(t.sessions.approvals.length,1);
  t.sessions.approve('42','accept');
  assert.deepEqual(t.codex.sent,[{id:42,result:{action:'accept',content:{},_meta:null}}]);
  assert.equal(t.sessions.approvals.length,0);
}finally{t.close();}});

test('requests outside the fixture or active turn never become approvals',()=>{const t=fixture();try{
  t.codex.emit('request',{id:1,method:'item/commandExecution/requestApproval',params:{threadId:'thread-a'}});
  t.codex.emit('request',{id:2,method:'mcpServer/elicitation/request',params:{threadId:'thread-a',turnId:'turn-a',serverName:'other',requestedSchema:{}}});
  t.sessions.sessions[0].activeTurn=null;t.sessions.sessions[0].status='idle';
  t.codex.emit('request',{id:3,method:'mcpServer/elicitation/request',params:{threadId:'thread-a',turnId:'turn-a',serverName:'paneforge_fixture',requestedSchema:{}}});
  assert.deepEqual(t.sessions.approvals,[]);
}finally{t.close();}});

test('completed turns invalidate approval and provider disconnect preserves turn identity',()=>{const t=fixture();try{
  t.codex.emit('request',{id:9,method:'mcpServer/elicitation/request',params:{threadId:'thread-a',turnId:'turn-a',serverName:'paneforge_fixture',requestedSchema:{}}});
  t.codex.emit('notification',{method:'turn/completed',params:{threadId:'thread-a',turn:{status:'completed'}}});
  assert.equal(t.sessions.approvals.length,0);assert.equal(t.sessions.sessions[0].activeTurn,null);
  t.sessions.sessions[0].activeTurn='turn-recover';t.sessions.sessions[0].status='running';
  t.codex.emit('disconnected',Error('executor stopped'));
  assert.equal(t.sessions.sessions[0].activeTurn,'turn-recover');assert.equal(t.sessions.sessions[0].status,'uncertain');
}finally{t.close();}});

test('stop and steer preserve native turn identity in RPC calls',async()=>{const t=fixture();try{
  await t.sessions.stop('thread-a');
  await t.sessions.turn('thread-a',{text:'continue',requestId:'request-a'},true);
  assert.deepEqual(t.codex.calls,[
    {method:'turn/interrupt',params:{threadId:'thread-a',turnId:'turn-a'}},
    {method:'turn/steer',params:{threadId:'thread-a',expectedTurnId:'turn-a',clientUserMessageId:'request-a',input:[{type:'text',text:'continue',text_elements:[]}]}}
  ]);
}finally{t.close();}});

test('resume projects installed App Server item envelopes into visible history',async()=>{const t=fixture();try{
  t.codex.rpc=async(method)=>({
    'thread/resume':{thread:{cwd:'/synthetic/checkout'}},
    'thread/items/list':{data:[{turnId:'turn-a',item:{id:'answer',type:'agentMessage',text:'FORGE-ORANGE-731'}}],nextCursor:null},
    'thread/turns/list':{data:[{id:'turn-a',status:'completed'}]}
  }[method]);
  const session=await t.sessions.resume('thread-a');
  assert.equal(session.items[0].text,'FORGE-ORANGE-731');
  assert.equal(session.items[0].type,'agentMessage');
  assert.equal(session.items[0].turnId,'turn-a');
  assert.equal(session.activeTurn,null);
}finally{t.close();}});

test('native usage preserves cached input and reasoning as subsets without double counting',()=>{const t=fixture();try{
  const tokenUsage={total:{inputTokens:1000,cachedInputTokens:800,outputTokens:200,reasoningOutputTokens:150,totalTokens:1200},last:{inputTokens:500,cachedInputTokens:400,outputTokens:100,reasoningOutputTokens:75,totalTokens:600},modelContextWindow:258400};
  t.codex.emit('notification',{method:'thread/tokenUsage/updated',params:{threadId:'thread-a',turnId:'turn-a',tokenUsage}});
  assert.deepEqual(t.sessions.get('thread-a').usage,tokenUsage);
  const restored=new Sessions(new FakeCodex(),t.dir);
  assert.deepEqual(restored.get('thread-a').usage,tokenUsage);
  assert.equal(restored.get('thread-a').usage.total.totalTokens,1200);
}finally{t.close();}});

test('renewal creates one successor, preserves scope and fences duplicate or stale input',async()=>{const t=fixture();try{
 const s=t.sessions.get('thread-a');s.activeTurn=null;s.status='idle';s.projectId='paneforge-next';s.cwd='/synthetic/lane-a';s.laneId='lane-a';s.laneName='lane-a';s.title='Finish the feature';s.items=[{id:'u1',type:'userMessage',text:'Implement milestone one'},{id:'a1',type:'agentMessage',text:'Milestone one completed'}];s.sessionGeneration=4;
 t.codex.rpc=async(method,params)=>{t.codex.calls.push({method,params});if(method==='thread/start')return {thread:{id:'thread-successor',sessionId:'native-successor',cwd:'/synthetic/lane-a'}};if(method==='turn/start')return {turn:{id:'continuation-turn'}};throw Error(`Unexpected ${method}`)};
 const pending=t.sessions.renew(s.id,{requestId:'renew-once'});assert.throws(()=>t.sessions.assertInputAllowed(s.id),/Preparing fresh context/);const result=await pending;
 assert.equal(t.codex.calls.find(c=>c.method==='turn/start').params.threadId,'thread-successor');assert.equal(result.successorThread,'thread-successor');assert.equal(result.continuationTurnId,'continuation-turn');assert.equal(result.phase,'submitted');assert.equal(result.finishedAt,undefined);assert.equal(s.providerLineage[0].threadId,'thread-a');assert.equal(s.sessionGeneration,5);assert.equal(s.inputLock,undefined);assert.match(t.codex.calls.find(c=>c.method==='turn/start').params.input[0].text,/Milestone one completed/);assert.equal(t.codex.calls.find(c=>c.method==='thread/start').params.cwd,'/synthetic/lane-a');
 const duplicate=await t.sessions.renew(s.id,{requestId:'renew-once'});assert.equal(duplicate.operationId,result.operationId);assert.equal(t.codex.calls.filter(c=>c.method==='thread/start').length,1);
 t.codex.emit('notification',{method:'turn/completed',params:{threadId:'thread-successor',turn:{id:'continuation-turn',status:'completed'}}});assert.equal(s.contextRenewal.phase,'completed');assert.ok(s.contextRenewal.finishedAt);
 s.inputLock={operationId:'current',generation:6,reason:'Submitting prompt'};assert.throws(()=>t.sessions.assertInputAllowed(s.id,'stale',5),/Submitting prompt/);assert.equal(t.sessions.assertInputAllowed(s.id,'current',6),s);
}finally{t.close();}});

test('measured occupancy is honest and restart releases a persisted lock',()=>{const t=fixture();try{
 const s=t.sessions.get('thread-a');assert.equal(t.sessions.contextOccupancy(s),null);s.usage={total:{totalTokens:800},last:{totalTokens:80},modelContextWindow:100};assert.equal(t.sessions.contextOccupancy(s),.8);s.inputLock={operationId:'crashed',generation:2,reason:'Preparing fresh context'};s.contextRenewal={operationId:'crashed',phase:'preparing'};t.sessions.changed();const restored=new Sessions(new FakeCodex(),t.dir);assert.equal(restored.get('thread-a').inputLock,undefined);assert.equal(restored.get('thread-a').contextRenewal.phase,'failed');assert.match(restored.get('thread-a').contextRenewal.failure,/restarted/);
}finally{t.close();}});

test('automatic renewal triggers once only from measured occupancy and skips unavailable usage',async()=>{const t=fixture();try{
 const s=t.sessions.get('thread-a');s.automaticContextRenewal=true;s.items=[{id:'user',type:'userMessage',text:'continue'}];s.usage={total:{totalTokens:900},last:{totalTokens:79},modelContextWindow:100};s.usageTurnId='below';let renewals=0;t.sessions.renew=async()=>{renewals++};t.codex.emit('notification',{method:'turn/completed',params:{threadId:'thread-a',turn:{status:'completed'}}});await Promise.resolve();assert.equal(renewals,0);
 s.activeTurn='turn-high';s.status='running';s.usage={total:{totalTokens:980},last:{totalTokens:80},modelContextWindow:100};s.usageTurnId='high';t.codex.emit('notification',{method:'turn/completed',params:{threadId:'thread-a',turn:{status:'completed'}}});await Promise.resolve();assert.equal(renewals,1);
 s.activeTurn='turn-unknown';s.status='running';delete s.usage;s.usageTurnId='unknown';t.codex.emit('notification',{method:'turn/completed',params:{threadId:'thread-a',turn:{status:'completed'}}});await Promise.resolve();assert.equal(renewals,1);
}finally{t.close();}});

test('startup failure and cancellation retain the brief and release only after fencing late submission',async()=>{const t=fixture();try{
 const s=t.sessions.get('thread-a');s.activeTurn=null;s.status='idle';s.projectId='paneforge-next';s.cwd='/lane-a';t.codex.rpc=async()=>{throw Error('provider unavailable')};await assert.rejects(t.sessions.renew(s.id,{requestId:'failure'}),/provider unavailable/);assert.equal(s.contextRenewal.phase,'failed');assert.equal(s.inputLock,undefined);assert.match(s.contextRenewal.brief,/Goal:/);t.sessions.cancelRenewal(s.id,s.contextRenewal.operationId);assert.equal(s.contextRenewal.phase,'cancelled');
}finally{t.close();}});

test('new and resumed threads receive the same higher-priority source trust instructions',async()=>{const t=fixture();try{
  t.codex.rpc=async(method,params)=>{t.codex.calls.push({method,params});return {
    'thread/start':{thread:{id:'new-thread',cwd:'/synthetic/checkout'}},
    'thread/resume':{thread:{cwd:'/synthetic/checkout'}},
    'thread/items/list':{data:[],nextCursor:null},
    'thread/turns/list':{data:[]}
  }[method];};
  t.sessions.provider={status:'ready'};await t.sessions.create();await t.sessions.resume('thread-a');
  const start=t.codex.calls.find(c=>c.method==='thread/start').params;
  const resume=t.codex.calls.find(c=>c.method==='thread/resume').params;
  assert.match(start.developerInstructions,/untrusted reference data/);
  assert.equal(start.developerInstructions,resume.developerInstructions);
  assert.equal(start.sandbox,'read-only');assert.equal(start.approvalPolicy,'untrusted');
  assert.equal(start.config.mcp_servers.paneforge_fixture.env.PANEFORGE_PROJECT_ID,'paneforge-next');
  assert.equal(resume.config.mcp_servers.paneforge_fixture.env.PANEFORGE_PROJECT_ID,'paneforge-next');
}finally{t.close();}});

test('a missing native rollout quietly recovers onto a fresh thread and preserves local context',async()=>{const t=fixture();try{
  t.sessions.sessions.unshift({id:'missing-rollout',title:'Saved task',projectId:'paneforge-next',cwd:'/synthetic/checkout',items:[{id:'saved',type:'agentMessage',text:'Keep this local result'}],activeTurn:null,status:'idle',requests:{}});
  t.codex.start=async()=>({status:'ready',authType:'chatgpt'});
  t.codex.rpc=async(method,params)=>{t.codex.calls.push({method,params});if(method==='thread/start')return {thread:{id:'replacement-thread',sessionId:'replacement-native',cwd:'/synthetic/checkout'}};if(params.threadId==='missing-rollout')throw Error('no rollout found for thread id missing-rollout');return {
    'thread/resume':{thread:{cwd:'/synthetic/checkout'}},
    'thread/items/list':{data:[{turnId:'turn-a',item:{id:'answer',type:'agentMessage',text:'Saved answer'}}],nextCursor:null},
    'thread/turns/list':{data:[{id:'turn-a',status:'completed'}]},
    'turn/start':{turn:{id:'recovered-turn'}}
  }[method];};
  await t.sessions.start();assert.equal(t.sessions.provider.status,'ready');
  await t.sessions.recoverMissingRollout(t.sessions.get('missing-rollout'));
  const recovered=t.sessions.get('missing-rollout');assert.equal(recovered.status,'idle');assert.equal(recovered.error,undefined);assert.equal(recovered.providerThreadId,'replacement-thread');assert.equal(recovered.providerLineage[0].threadId,'missing-rollout');assert.equal(recovered.items[0].text,'Keep this local result');
  await t.sessions.turn('missing-rollout',{text:'Continue now',requestId:'recover-request'});const submitted=t.codex.calls.find(call=>call.method==='turn/start');assert.equal(submitted.params.threadId,'replacement-thread');assert.match(submitted.params.input[0].text,/Keep this local result/);assert.match(submitted.params.input[0].text,/Latest user request:\nContinue now/);assert.equal(recovered.providerRecoveryBrief,undefined);
}finally{t.close();}});

test('conversation rename is bounded and persists without changing native identity',()=>{const t=fixture();try{
  t.sessions.sessions[0].activeTurn=null;t.sessions.sessions[0].status='idle';
  const renamed=t.sessions.rename('thread-a','  Release evidence  ');
  assert.equal(renamed.title,'Release evidence');assert.equal(renamed.nativeSessionId,'native-a');
  const restored=new Sessions(new FakeCodex(),t.dir);
  assert.equal(restored.get('thread-a').title,'Release evidence');assert.equal(restored.get('thread-a').nativeSessionId,'native-a');
  assert.throws(()=>t.sessions.rename('thread-a','   '),/cannot be empty/);
  assert.throws(()=>t.sessions.rename('thread-a','x'.repeat(161)),/160 characters/);
  assert.throws(()=>t.sessions.rename('thread-a',null),/required/);
}finally{t.close();}});

test('conversation deletion is recoverable, hides visible state, and preserves provider history',()=>{const t=fixture();try{
  const s=t.sessions.sessions[0];s.activeTurn=null;s.status='idle';s.items=[{id:'answer',type:'agentMessage',text:'Saved provider answer'}];s.voiceHistory=[{eventId:'voice-1'}];
  const deleted=t.sessions.remove('thread-a');
  assert.equal(deleted.ok,true);assert.ok(deleted.deletedAt);
  assert.deepEqual(t.sessions.visible(),[]);assert.throws(()=>t.sessions.get('thread-a'),/Unknown conversation/);
  const reloaded=new Sessions(new FakeCodex(),t.dir);assert.deepEqual(reloaded.visible(),[]);
  const restored=reloaded.restore('thread-a');
  assert.equal(restored.nativeSessionId,'native-a');assert.equal(restored.items[0].text,'Saved provider answer');assert.deepEqual(restored.voiceHistory,[{eventId:'voice-1'}]);
  assert.equal(reloaded.visible().length,1);
}finally{t.close();}});

test('conversation deletion rejects durable active work before writing a deletion marker',()=>{const t=fixture();try{
  assert.throws(()=>t.sessions.remove('thread-a'),error=>error.statusCode===409&&/active work/.test(error.message));
  assert.equal(t.sessions.sessions[0].deletedAt,undefined);
  t.sessions.sessions[0].activeTurn=null;t.sessions.sessions[0].status='idle';
  assert.throws(()=>t.sessions.remove('thread-a',{hasExternalWork:()=>true}),error=>error.statusCode===409);
  assert.equal(t.sessions.sessions[0].deletedAt,undefined);
}finally{t.close();}});

test('structured item observation timestamps survive provider updates and resume',async()=>{const t=fixture();try{
  t.sessions.sessions[0].activeTurn=null;t.sessions.sessions[0].status='idle';
  t.codex.emit('notification',{method:'item/started',params:{threadId:'thread-a',item:{id:'tool-a',type:'mcpToolCall'}}});
  const observed=t.sessions.get('thread-a').items[0]._observedAt;assert.equal(typeof observed,'number');
  t.codex.emit('notification',{method:'item/completed',params:{threadId:'thread-a',item:{id:'tool-a',type:'mcpToolCall',status:'completed'}}});
  assert.equal(t.sessions.get('thread-a').items[0]._observedAt,observed);
  t.codex.rpc=async(method)=>({'thread/resume':{thread:{cwd:'/synthetic/checkout'}},'thread/items/list':{data:[{turnId:'turn-a',item:{id:'tool-a',type:'mcpToolCall',status:'completed'}}],nextCursor:null},'thread/turns/list':{data:[]}}[method]);
  await t.sessions.resume('thread-a');assert.equal(t.sessions.get('thread-a').items[0]._observedAt,observed);
}finally{t.close();}});

test('text and image attachments become installed App Server input without paths or remote URLs',async()=>{const t=fixture();try{
  const s=t.sessions.get('thread-a');s.activeTurn=null;s.status='idle';
  const png='data:image/png;base64,iVBORw0KGgo=';
  await t.sessions.turn('thread-a',{text:'Review these',requestId:'attachment-a',attachments:[{name:'notes.md',text:'Synthetic notes'},{name:'proof.png',type:'image',url:png}]});
  const call=t.codex.calls.at(-1);assert.equal(call.method,'turn/start');
  assert.deepEqual(call.params.input,[{type:'text',text:'Review these\n\nAttached text (notes.md):\nSynthetic notes',text_elements:[]},{type:'image',url:png,detail:'auto'}]);
  s.activeTurn=null;s.status='idle';
  await assert.rejects(t.sessions.turn('thread-a',{text:'x',requestId:'attachment-b',attachments:[{name:'bad',type:'image',url:'https://example.test/a.png'}]}),/base64 PNG/);
  s.activeTurn=null;s.status='idle';
  await assert.rejects(t.sessions.turn('thread-a',{text:'x',requestId:'attachment-c',attachments:[{name:'bad.png',type:'image',url:'data:image/png;base64,/9j/'}]}),/does not match/);
  s.activeTurn=null;s.status='idle';
  await assert.rejects(t.sessions.turn('thread-a',{text:'x',requestId:'attachment-d',attachments:[{name:'large.md',text:'x'.repeat(100001)}]}),/below 100 KB/);
}finally{t.close();}});

test('router-validated project references persist and scope provider instructions',async()=>{const t=fixture();try{
  t.sessions.provider={status:'ready'};
  t.codex.rpc=async(method,params)=>{t.codex.calls.push({method,params});return {thread:{id:'project-thread',sessionId:'native-project',cwd:'/synthetic/project'}};};
  const session=await t.sessions.create({projectId:'project-a',cwd:'/synthetic/project'});
  assert.equal(session.projectId,'project-a');assert.equal(session.cwd,'/synthetic/project');
  const start=t.codex.calls.at(-1);assert.equal(start.params.cwd,'/synthetic/project');assert.equal(start.params.projectId,undefined);assert.match(start.params.developerInstructions,/project-a/);
  assert.equal(start.params.config.mcp_servers.paneforge_fixture.env.PANEFORGE_PROJECT_ID,'project-a');
  const reloaded=new Sessions(new FakeCodex(),t.dir);assert.equal(reloaded.get('project-thread').projectId,'project-a');
}finally{t.close();}});

test('Claude conversations persist a native identity, resume independently, stream Chat output, and retain cancellation',async()=>{const t=fixture();try{
  t.sessions.provider={status:'blocked',error:'Codex offline'};t.sessions.claudeProvider={status:'ready',authType:'claude.ai',plan:'max'};
  const session=await t.sessions.create({provider:'claude',projectId:'project-a',cwd:'/synthetic/project',title:'Claude review'});
  assert.equal(session.provider,'claude');assert.equal(session.id,session.nativeSessionId);assert.equal(session.status,'idle');
  await t.sessions.resume(session.id);assert.deepEqual(t.claude.calls[0],['resume',session.nativeSessionId]);
  await t.sessions.turn(session.id,{text:'Read the marker',requestId:'claude-request'});
  assert.equal(session.items.at(-1).text,'Claude answer');assert.equal(session.status,'idle');assert.equal(t.claude.calls.at(-1)[1].resume,false);
  const reloaded=new Sessions(new FakeCodex(),t.dir,undefined,new FakeClaude());assert.equal(reloaded.get(session.id).provider,'claude');assert.equal(reloaded.get(session.id).nativeSessionId,session.nativeSessionId);
  session.activeTurn='cancel-turn';session.status='running';await t.sessions.stop(session.id);assert.deepEqual(t.claude.calls.at(-1),['stop',session.nativeSessionId]);
}finally{t.close();}});


test('assistant keeps a local identity until its first real delegation, then maps provider events to it',async()=>{const t=fixture();try{
  t.sessions.provider={status:'ready'};t.codex.rpc=async(method,params)=>{t.codex.calls.push({method,params});return {
    'thread/start':{thread:{id:'assistant-provider',sessionId:'assistant-native',cwd:'/synthetic/next'}},
    'turn/start':{turn:{id:'assistant-turn'}},
    'thread/resume':{thread:{cwd:'/synthetic/next'}},
    'thread/items/list':{data:[],nextCursor:null},'thread/turns/list':{data:[]},'turn/interrupt':{}
  }[method];};
  const first=await t.sessions.assistant({projectId:'paneforge-next',cwd:'/synthetic/next'}),second=await t.sessions.assistant({projectId:'paneforge-next',cwd:'/synthetic/next'});
  assert.equal(first.created,true);assert.equal(second.created,false);assert.equal(first.session.id,'assistant-paneforge-next');assert.equal(first.session.kind,'assistant');assert.equal(first.session.title,'PaneForge assistant');assert.equal(t.codex.calls.length,0);
  await t.sessions.resume(first.session.id);assert.equal(t.codex.calls.length,0);
  await t.sessions.turn(first.session.id,{text:'Find prior work',requestId:'assistant-request',clientId:'test-window'});
  assert.deepEqual(t.codex.calls.slice(0,2).map(call=>[call.method,call.params.threadId]),[['thread/start',undefined],['turn/start','assistant-provider']]);
  assert.equal(first.session.providerThreadId,'assistant-provider');assert.equal(first.session.nativeSessionId,'assistant-native');
  t.codex.emit('request',{id:77,method:'mcpServer/elicitation/request',params:{threadId:'assistant-provider',turnId:'assistant-turn',serverName:'paneforge_fixture'}});assert.equal(t.sessions.approvals[0].threadId,'assistant-paneforge-next');
  t.codex.emit('notification',{method:'item/completed',params:{threadId:'assistant-provider',item:{id:'answer',type:'agentMessage',text:'Saved answer'}}});assert.equal(first.session.items[0].text,'Saved answer');
  t.codex.emit('notification',{method:'turn/completed',params:{threadId:'assistant-provider',turn:{status:'completed'}}});assert.equal(t.sessions.approvals.length,0);await t.sessions.resume(first.session.id);assert.equal(t.codex.calls.at(-1).params.threadId,'assistant-provider');
  first.session.activeTurn='assistant-turn';await t.sessions.stop(first.session.id);assert.equal(t.codex.calls.at(-1).params.threadId,'assistant-provider');
  first.session.deletedAt='2026-01-01';const restored=await t.sessions.assistant({projectId:'paneforge-next',cwd:'/synthetic/next'});assert.equal(restored.created,false);assert.equal(restored.session.id,'assistant-paneforge-next');assert.equal(restored.session.deletedAt,undefined);
}finally{t.close();}});

test('local history search excludes deleted assistants and other project conversations',()=>{const t=fixture();try{
  t.sessions.sessions=[
    {id:'saved-a',title:'Release notes',projectId:'project-a',items:[{text:'The orange release is ready.'}]},
    {id:'assistant',title:'PaneForge assistant',kind:'assistant',projectId:'project-a',items:[{text:'orange'}]},
    {id:'deleted',title:'Orange old',projectId:'project-a',deletedAt:'2026-01-01',items:[]},
    {id:'saved-b',title:'Orange other project',projectId:'project-b',items:[]}
  ];t.sessions.changed();
  assert.deepEqual(t.sessions.history('orange','project-a'),[{sessionId:'saved-a',title:'Release notes',sourceUrl:'/?session=saved-a',excerpt:'Release notes The orange release is ready.'}]);
  assert.deepEqual(t.sessions.historyMetadata('release'),[{id:'saved-a',title:'Release notes',projectId:'project-a',kind:'conversation',status:'idle'}]);
  assert.deepEqual(searchSavedConversationHistory(t.dir,{query:'orange',projectId:'project-a'}),[{sessionId:'saved-a',title:'Release notes',sourceUrl:'/?session=saved-a',excerpt:'Release notes The orange release is ready.'}]);
}finally{t.close();}});


test('legacy history is admitted only from the exact PaneForge Next working directory',()=>{const t=fixture();try{
  const next=process.cwd();t.sessions.sessions=[
    {id:'legacy-next',title:'Legacy release',cwd:next,items:[{text:'Orange evidence'}]},
    {id:'legacy-foreign',title:'Foreign release',cwd:next+'/other',items:[{text:'Orange evidence'}]},
    {id:'scoped-other',title:'Scoped other',projectId:'project-b',cwd:next,items:[{text:'Orange evidence'}]}
  ];
  assert.deepEqual(t.sessions.history('orange','paneforge-next'),[{sessionId:'legacy-next',title:'Legacy release',sourceUrl:'/?session=legacy-next',excerpt:'Legacy release Orange evidence'}]);
  assert.deepEqual(t.sessions.history('orange','project-a'),[]);
}finally{t.close();}});

test('only an unassigned legacy conversation in the exact PaneForge Next root receives its project identity',()=>{
 const nextPath=process.cwd();const project={id:'paneforge-next',path:nextPath};
 const legacy={cwd:nextPath};assert.equal(assignLegacyPaneForgeNextProject(legacy,project),true);assert.equal(legacy.projectId,'paneforge-next');
 const foreign={cwd:join(nextPath,'tests')};assert.equal(assignLegacyPaneForgeNextProject(foreign,project),false);assert.equal(foreign.projectId,undefined);
 const wrong={cwd:nextPath,projectId:'project-other'};assert.equal(assignLegacyPaneForgeNextProject(wrong,project),false);assert.equal(wrong.projectId,'project-other');
});


test('Claude resume keeps a live child running and marks a restarted active invocation uncertain',async()=>{const t=fixture();try{t.sessions.claudeProvider={status:'ready'};const s=await t.sessions.create({provider:'claude',projectId:'project-a',cwd:'/synthetic/project'});s.activeTurn='request-active';t.sessions.busy.add(s.id);await t.sessions.resume(s.id);assert.equal(s.status,'idle');assert.equal(s.activeTurn,'request-active');t.sessions.busy.delete(s.id);await t.sessions.resume(s.id);assert.equal(s.status,'uncertain');assert.equal(s.activeTurn,'request-active');assert.match(s.error,/unknown after restart/);}finally{t.close();}});


test('organization preserves stable numbers and persists groups and order without moving lanes',()=>{
 const t=fixture();try{
  t.sessions.sessions=[{id:'a',kind:'conversation',title:'A',projectId:'p',cwd:'/p/a'},{id:'b',kind:'conversation',title:'B',projectId:'p',cwd:'/p/b'},{id:'other',projectId:'other'}];
  t.sessions.changed();const numbers=t.sessions.sessions.map(s=>s.sessionNumber);
  t.sessions.organize('b',{title:'Review',group:'Launch'});
  t.sessions.organize('a',{beforeSessionId:'b'});
  assert.deepEqual(t.sessions.sessions.map(s=>s.id),['a','b','other']);assert.equal(t.sessions.get('a').group,'Launch');assert.equal(t.sessions.get('a').cwd,'/p/a');
  assert.deepEqual(t.sessions.sessions.map(s=>s.sessionNumber),numbers);
  assert.throws(()=>t.sessions.organize('a',{title:'Lost',beforeSessionId:'other'}),/same project/);assert.equal(t.sessions.get('a').title,'A');
  const restored=new Sessions(new FakeCodex(),t.dir,undefined,new FakeClaude());assert.equal(restored.get('b').title,'Review');assert.equal(restored.get('a').group,'Launch');
  t.sessions.organize('a',{group:''});assert.equal(t.sessions.get('a').group,'');
 }finally{t.close();}
});


test('assistant installation move renews its provider scope without losing history or moving active work',async()=>{const t=fixture();try{
 const s={id:'assistant-paneforge-next',kind:'assistant',projectId:'paneforge-next',providerThreadId:'old-provider',nativeSessionId:'old-native',workspaceToolsVersion:7,cwd:'/synthetic/old',items:[{id:'saved',text:'Keep this answer'}],voiceHistory:[{delta:'Keep this speech'}],requests:{},status:'idle'};
 t.sessions.sessions=[s];t.sessions.provider={status:'ready'};
 s.activeTurn='busy';await assert.rejects(t.sessions.assistant({projectId:s.projectId,cwd:'/synthetic/new'}),/Finish the current/);assert.equal(s.cwd,'/synthetic/old');s.activeTurn=null;
 await t.sessions.assistant({projectId:s.projectId,cwd:'/synthetic/new'});assert.equal(s.cwd,'/synthetic/new');assert.equal(s.workspaceToolsVersion,0);assert.equal(s.items[0].text,'Keep this answer');
 t.codex.rpc=async(method,params)=>{t.codex.calls.push({method,params});return {thread:{id:'new-provider',sessionId:'new-native',cwd:params.cwd}}};
 await t.sessions.ensureNative(s);assert.equal(t.codex.calls[0].params.cwd,'/synthetic/new');assert.equal(s.providerLineage[0].threadId,'old-provider');assert.equal(s.archivedItems[0].text,'Keep this answer');assert.equal(s.voiceHistory[0].delta,'Keep this speech');
}finally{t.close();}});

test('provider item envelopes retain turn identity for completed-review capture',()=>{const t=fixture();try{
  const captures=[];t.sessions.reviewStore={captureCompletedTurn(session,turn){captures.push({session,turn});}};
  t.codex.emit('notification',{method:'item/completed',params:{threadId:'thread-a',turnId:'turn-a',item:{id:'answer-a',type:'agentMessage',text:'exact final'}}});
  t.codex.emit('notification',{method:'turn/completed',params:{threadId:'thread-a',turn:{id:'turn-a',status:'completed'}}});
  assert.equal(captures.length,1);assert.equal(captures[0].session.items[0].turnId,'turn-a');assert.equal(captures[0].session.items[0].text,'exact final');
}finally{t.close();}});

test('renewal refuses an active terminal before changing the native conversation identity',async()=>{const t=fixture();try{
 const s=t.sessions.get('thread-a');s.activeTurn=null;s.status='idle';s.projectId='paneforge-next';s.cwd='/synthetic/lane';const native=s.nativeSessionId;t.sessions.hasActiveTerminal=id=>id===s.id;
 await assert.rejects(t.sessions.renew(s.id,{requestId:'renew-cli'}),/CLI/);
 assert.equal(s.nativeSessionId,native);assert.equal(t.codex.calls.length,0);
}finally{t.close();}});
