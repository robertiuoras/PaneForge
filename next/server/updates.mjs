import {readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';

// Read the supervisor's own live registries, not browser tabs or process titles.
export function localActivity({sessions,terminal,pc,voice,codex,requests=0,starting=false,reconciling=false}){
 const blockers=[];
 const add=(kind,id,label)=>blockers.push({kind,id,label});
 if(starting)add('startup','startup','Restoring local provider state');
 if(requests)add('request','requests',`${requests} local request(s) in progress`);
 if(reconciling||pc.pending?.size)add('job','dispatch','Checking or dispatching PC work');
 for(const s of sessions.sessions)if(s.activeTurn||['running','uncertain'].includes(s.status))add('conversation',s.id,`Conversation ${s.number?`#${s.number}`:s.title||s.id}: ${s.status||'running'}`);
 for(const s of sessions.sessions)if(s.inputLock)add('renewal',s.id,`Conversation ${s.number?`#${s.number}`:s.title||s.id}: ${s.inputLock.reason||'context renewal in progress'}`);
 if(sessions.busy.size||sessions.claude?.running?.size||codex.pending.size)add('provider','provider','Provider request or CLI turn in progress');
 if(sessions.approvals.length)add('approval','approvals','Waiting for approval');
 if(voice.active||voice.connecting)add('voice','voice','GPT Live is connected or connecting');
 for(const t of terminal.state())if(!t.exited||['running','uncertain'].includes(t.code?.status))add('terminal',t.id,`${t.code?.machine==='mac'?'Mac':'PC'} terminal ${t.code?.status||'open'}`);
 if(terminal.creating.size||terminal.codeCreating.size||terminal.codeTurns.size)add('terminal','launch','Terminal launch or Code turn is finalizing');
 for(const job of pc.list())if(!['completed','failed','cancelled'].includes(job.state))add('job',job.id,`PC job: ${job.state||'unknown'}`);
 return {checkedAt:new Date().toISOString(),idle:blockers.length===0,blockers};
}

export function installedUpdate(file='/Applications/PaneForge Next.app/Contents/Resources/update-ready.json'){
 let value;try{value=JSON.parse(readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
 if(!/^[a-f0-9]{40}$/.test(value.revision||'')||typeof value.root!=='string'||!value.root.startsWith('/')||!existsSync(join(value.root,'scripts/restart-idle.mjs'))||!existsSync(join(value.root,'dist/index.html')))throw Error('Installed update is incomplete');
 return {...value,root:resolve(value.root)};
}

export class IdleUpdates{
 constructor({revision,activity,readUpdate=installedUpdate,restart,now=Date.now}){Object.assign(this,{revision,activity,readUpdate,restart,now});this.idleSince=null;this.restarting=false;this.pending=null;this.error=null;}
 status(){let activity;try{activity=this.activity();}catch(error){activity={idle:false,checkedAt:new Date().toISOString(),blockers:[{kind:'unknown',id:'unknown',label:`Activity unavailable: ${error.message}`}]};}return {supervisorPid:process.pid,revision:this.revision,pendingRevision:this.pending?.revision||null,restarting:this.restarting,error:this.error,automatic:true,activity};}
 async check(){
  if(this.restarting||this.error)return;
  try{
   const next=this.readUpdate();if(!next||next.revision===this.revision){this.pending=null;this.idleSince=null;return;}
   this.pending=next;
   if(!this.activity().idle){this.idleSince=null;return;}
   if(this.idleSince===null){this.idleSince=this.now();return;}
   if(this.now()-this.idleSince<5000)return;
   // This flag closes request/voice admission synchronously before shutdown.
   this.restarting=true;
   if(!this.activity().idle){this.restarting=false;this.idleSince=null;return;}
   await this.restart(next);
  }catch(error){this.error=error.message;this.restarting=false;}
 }
}
