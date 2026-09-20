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
