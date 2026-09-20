import assert from 'node:assert/strict';
import test from 'node:test';
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
 }finally{rmSync(dir,{recursive:true,force:true});}
});
