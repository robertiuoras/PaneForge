import assert from 'node:assert/strict';
import test from 'node:test';
import {forgeBuildPrompt} from '../server/prompt-forge.mjs';
import {macInteractiveArgs,pcInteractiveCommand} from '../server/terminal.mjs';

test('Mac CLI resumes the exact native Codex identity with selected route',()=>{
 const args=macInteractiveArgs({provider:'codex',nativeSessionId:'123e4567-e89b-12d3-a456-426614174000',model:'gpt-5.6-terra',effort:'medium',checkout:'/safe/lane'});
 assert.deepEqual(args,['resume','123e4567-e89b-12d3-a456-426614174000','-m','gpt-5.6-terra','-c','model_reasoning_effort=\"medium\"','-c','model_provider=\"openai\"','-c','forced_login_method=\"chatgpt\"','-a','on-request','-s','workspace-write','-C','/safe/lane']);
 assert.throws(()=>macInteractiveArgs({provider:'codex',nativeSessionId:null,checkout:'/safe/lane'}),/exact saved/);
});

test('PC Codex command carries the saved selected route and never defaults a model',()=>{
 assert.match(pcInteractiveCommand({provider:'codex',model:'gpt-5.6-terra',effort:'medium',checkout:'/safe/lane'}),/-m gpt-5.6-terra/);
 assert.throws(()=>pcInteractiveCommand({provider:'codex',checkout:'/safe/lane'}),/confirmed model and effort/);
});

test('Mac terminal exit hands its exact native identity to transcript reconciliation',async()=>{
 const {TerminalService}=await import('../server/terminal.mjs');
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'paneforge-terminal-'));let exited;let exitHandler;let reconciled;
 const terminal=new TerminalService({dataDir:dir,spawnPty:()=>({onData(){},onExit(handler){exitHandler=handler}}),onMacCliExit:value=>{exited=value;reconciled?.();}});
 try{
  const created=await terminal.create({sessionId:'session-a',projectId:'project-a',machine:'mac',provider:'codex',nativeSessionId:'123e4567-e89b-12d3-a456-426614174000',model:'gpt-5.6-terra',effort:'medium',cwd:'/safe/lane'});
  const observed=new Promise(resolve=>{reconciled=resolve});exitHandler({exitCode:0});await observed;
  assert.deepEqual(exited,{sessionId:'session-a',nativeSessionId:'123e4567-e89b-12d3-a456-426614174000',terminalId:created.id,exitCode:0});
 }finally{try{await terminal.journal;}finally{rmSync(dir,{recursive:true,force:true});}}
});

test('failed PC preparation leaves no phantom terminal across restart and permits a new attempt',async()=>{
 const {TerminalService}=await import('../server/terminal.mjs');
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'pc-prepare-'));let attempts=0;let launches=0;let resumed;
 const args={sessionId:'session',projectId:'project',laneId:'lane',provider:'codex',requestId:'first',text:'Build the fixture'};
 const prepareTerminal=async value=>{attempts++;if(attempts===1)throw Error('SSH connection reset');return {...value,host:'pc',checkout:'C:\\work',machine:'pc'};};
 const terminal=new TerminalService({dataDir:dir,prepareTerminal});
 try{
  await assert.rejects(terminal.runCodeTurn(args),/SSH connection reset/);
  assert.equal(terminal.state().length,0);
  await terminal.close();
  resumed=new TerminalService({dataDir:dir,prepareTerminal,startCodeTurn:()=>{launches++;return {done:Promise.resolve({output:JSON.stringify({type:'thread.started',thread_id:'remote-native'})+'\n'+JSON.stringify({type:'turn.completed'})}),stop:()=>false};}});
  await resumed.ready();assert.equal(resumed.state().length,0);
  const result=await resumed.runCodeTurn(args);assert.equal(result.state,'running');assert.equal(attempts,2);assert.equal(launches,1);
 }finally{if(resumed)await resumed.close();await terminal.journal;rmSync(dir,{recursive:true,force:true});}
});

test('PC completed receipt retains the exact request and final output for durable review and reply',async()=>{
 const {TerminalService}=await import('../server/terminal.mjs');const {ReviewStore}=await import('../server/review-store.mjs');
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'pc-review-'));let prepared=0;let complete;let changed;const launches=[];
 const terminal=new TerminalService({dataDir:dir,prepareTerminal:async args=>{prepared++;return {...args,host:'pc',checkout:'C:\\work',machine:'pc'};},startCodeTurn:args=>{launches.push(args);return {done:new Promise(resolve=>{complete=resolve}),stop:()=>false};},onChange:()=>changed?.()});
 const session={id:'session',projectId:'project',nativeSessionId:'local-native',provider:'codex',cwd:'/work',title:'Work'};
 const args={sessionId:'session',projectId:'project',laneId:'lane',provider:'codex',requestId:'first',text:'Build the fixture'};
 let reloaded;
 try{
  await assert.rejects(terminal.runCodeTurn({...args,text:'Build '+ 'x'.repeat(6000)}),/Build prompt exceeds/);
  assert.equal(prepared,0);assert.equal(launches.length,0);assert.equal(terminal.state().length,0);
  const run=await terminal.runCodeTurn(args);
  assert.equal(launches[0].text,forgeBuildPrompt(args.text));
  assert.equal(terminal.state()[0].code.requests.first.text,args.text);
  const duplicate=await terminal.runCodeTurn(args);assert.equal(duplicate.id,run.id);assert.equal(launches.length,1);
  const done=new Promise(resolve=>{changed=()=>{if(!terminal.codeTurns.size)resolve();};});
  complete({output:[{type:'thread.started',thread_id:'remote-native'},{type:'item.completed',item:{type:'agent_message',text:'Earlier progress'}},{type:'item.completed',item:{type:'agent_message',text:'Fixture ready'}},{type:'turn.completed'}].map(x=>JSON.stringify(x)).join('\n')});
  await done;
  const notices=[];const store=new ReviewStore(dir,{onRecord:r=>notices.push(r)});
  const record=store.capturePcTurn(terminal.state()[0],'first',session);
  assert.equal(record.nativeSessionId,'remote-native');assert.equal(record.execution,'pc');assert.equal(record.terminalId,run.id);assert.equal(record.prompt,args.text);assert.match(record.report,/Fixture ready/);assert.doesNotMatch(record.report,/Earlier progress/);assert.equal(record.proof,'claimed');assert.equal(session.nativeSessionId,'local-native');
  await terminal.close();reloaded=new TerminalService({dataDir:dir});await reloaded.ready();
  store.capturePcTurn(reloaded.state()[0],'first',{...session,title:'Renamed'});assert.equal(notices.length,1);assert.equal(store.list().length,1);
  await assert.rejects(terminal.runCodeTurn({...args,requestId:'wrong',expectedTerminalId:run.id,expectedNativeSessionId:'wrong-native'}),/no longer matches/);
  await terminal.runCodeTurn({...args,requestId:'second',text:'Explain it',expectedTerminalId:run.id,expectedNativeSessionId:'remote-native'});
  assert.equal(launches[1].nativeSessionId,'remote-native');assert.equal(launches[1].text,forgeBuildPrompt('Explain it'));
  const again=new Promise(resolve=>{changed=()=>{if(!terminal.codeTurns.size)resolve();};});complete({output:JSON.stringify({type:'thread.started',thread_id:'remote-native'})+'\n'+JSON.stringify({type:'turn.completed'})});await again;
  const missing=store.capturePcTurn(terminal.state()[0],'second',session);assert.equal(missing.proof,'unverified');assert.equal(missing.informational,false);
 }finally{await terminal.journal;if(reloaded)await reloaded.close();rmSync(dir,{recursive:true,force:true});}
});
