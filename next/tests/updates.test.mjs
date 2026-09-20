import test from 'node:test';
import assert from 'node:assert/strict';
import {IdleUpdates,localActivity} from '../server/updates.mjs';
function fixture(){return {sessions:{sessions:[],busy:new Set(),approvals:[],claude:{running:new Map()}},terminal:{state:()=>[],creating:new Map(),codeCreating:new Map(),codeTurns:new Map()},pc:{list:()=>[],pending:new Set()},voice:{active:null,connecting:false},codex:{pending:new Map()}};}
test('local activity blocks every owned execution and uncertain state',()=>{
 assert.equal(localActivity(fixture()).idle,true);
 const cases=[x=>x.sessions.sessions.push({id:'s',number:4,inputLock:{reason:'Preparing fresh context'}}),x=>x.starting=true,x=>x.requests=1,x=>x.reconciling=true,x=>x.sessions.sessions.push({id:'s',number:1,activeTurn:'t'}),x=>x.sessions.sessions.push({id:'s',status:'uncertain'}),x=>x.sessions.busy.add('s'),x=>x.sessions.claude.running.set('s',{}),x=>x.codex.pending.set(1,{}),x=>x.sessions.approvals.push({}),x=>x.voice.active={},x=>x.voice.connecting=true,x=>x.terminal.state=()=>[{id:'t',exited:false}],x=>x.terminal.state=()=>[{id:'t',exited:true,code:{status:'uncertain'}}],x=>x.terminal.creating.set('t',{}),x=>x.terminal.codeCreating.set('t',{}),x=>x.terminal.codeTurns.set('t',{}),x=>x.pc.list=()=>[{id:'j',state:'queued'}],x=>x.pc.list=()=>[{id:'j',state:'unknown'}],x=>x.pc.pending.add('j')];
 for(const set of cases){const input=fixture();set(input);const result=localActivity(input);assert.equal(result.idle,false);assert(result.blockers.length>0);}
});
test('updates require quiet time and close admission before the final recheck',async()=>{
 let time=0,idle=true,restarts=0;const manager=new IdleUpdates({revision:'old',now:()=>time,activity:()=>({idle,blockers:[]}),readUpdate:()=>({revision:'new'}),restart:async()=>{assert.equal(manager.restarting,true);restarts++;}});
 await manager.check();time=6000;idle=false;await manager.check();assert.equal(restarts,0);
 idle=true;await manager.check();time=11000;await manager.check();assert.equal(restarts,1);await manager.check();assert.equal(restarts,1);
});
test('unknown activity or incomplete updates fail closed without repeated restarts',async()=>{
 let restarts=0;const manager=new IdleUpdates({revision:'old',activity:()=>{throw Error('Activity unavailable')},readUpdate:()=>({revision:'new'}),restart:async()=>restarts++});
 await manager.check();await manager.check();assert.equal(restarts,0);assert.match(manager.error,/unavailable/);
});
test('no update never restarts even when idle',async()=>{
 let restarts=0;const manager=new IdleUpdates({revision:'same',activity:()=>({idle:true}),readUpdate:()=>({revision:'same'}),restart:async()=>restarts++});
 await manager.check();assert.equal(manager.pending,null);assert.equal(restarts,0);
});
test('a newly discovered blocker at the locked recheck cancels restart',async()=>{
 let time=0,restarts=0;const manager=new IdleUpdates({revision:'old',now:()=>time,activity:()=>({idle:!manager.restarting}),readUpdate:()=>({revision:'new'}),restart:async()=>restarts++});
 await manager.check();time=6000;await manager.check();assert.equal(restarts,0);assert.equal(manager.restarting,false);
});
test('native CLI reconciliation and unresolved submissions prevent idle restart',()=>{
 for(const state of [{cliReconciliation:{phase:'opening-cli'}},{cliReconciliation:{phase:'reconciling'}},{requests:{r:{state:'uncertain'}}},{requests:{r:{state:'submitting'}}},{requests:{r:{state:'cancelling'}}}]){
  const input=fixture();input.sessions.sessions.push({id:'s',status:'idle',...state});assert.equal(localActivity(input).idle,false,JSON.stringify(state));
 }
});
test('completed request history does not keep a finished session busy',()=>{
 const input=fixture();input.sessions.sessions.push({id:'s',status:'idle',requests:{r:{state:'completed'}}});assert.equal(localActivity(input).idle,true);
});

test('preview does not advertise an automatic native update path',()=>{
 const manager=new IdleUpdates({revision:'preview',activity:()=>({idle:true}),restart:async()=>{}});
 assert.equal(manager.status().automatic,false);assert.match(manager.status().unavailableReason,/not configured/);
});
