import {readFileSync,existsSync,writeFileSync,chmodSync} from 'node:fs';
import {randomBytes,timingSafeEqual} from 'node:crypto';
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
 for(const s of sessions.sessions){
  if(s.cliReconciliation)add('reconciliation',s.id,'Reconciling native CLI work with Chat');
  for(const [id,request] of Object.entries(s.requests||{}))if(['submitting','uncertain','cancelling'].includes(request?.state))add('request',`${s.id}:${id}`,`Conversation request is ${request.state}`);
 }
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
 constructor({revision,activity,readUpdate=installedUpdate,restart,now=Date.now,nativeStatus=()=>null}){Object.assign(this,{revision,activity,readUpdate,restart,now,nativeStatus});this.idleSince=null;this.restarting=false;this.pending=null;this.error=null;}
 status(){let activity;try{activity=this.activity();}catch(error){activity={idle:false,checkedAt:new Date().toISOString(),blockers:[{kind:'unknown',id:'unknown',label:`Activity unavailable: ${error.message}`}]};}const native=this.nativeStatus();return {supervisorPid:process.pid,revision:this.revision,pendingRevision:this.pending?.revision||null,restarting:this.restarting,error:native?.error||this.error,automatic:native?.automatic===true,unavailableReason:native?.automatic?null:'Native update delivery is not configured',native,activity};}
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

// A private capability authenticates the native updater within the trusted OS user.
// Other processes with full access to that user profile are in the same trust boundary. This
// capability stays in the private app-data directory and never enters state/SSE.
export function nativeUpdateControl({dir,updates,persist,shutdown}){
 const token=randomBytes(32).toString('hex');
 writeFileSync(join(dir,'.native-control-token'),token,{mode:0o600});
 chmodSync(join(dir,'.native-control-token'),0o600);
 return async (req,res)=>{
  if(req.url!=='/api/native-update/stop')return false;
  const supplied=Buffer.from(req.headers.authorization||'');const expected=Buffer.from(`Bearer ${token}`);
  const reply=(status,body)=>{const json=JSON.stringify(body);res.writeHead(status,{'content-type':'application/json','content-length':Buffer.byteLength(json),'cache-control':'no-store'});res.end(json);};
  if(req.method!=='POST'||req.headers.origin!==undefined||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){reply(403,{error:'Native update owner required'});return true;}
  if(req.headers['x-paneforge-revision']!==updates.revision){reply(409,{error:'Supervisor revision changed'});return true;}
  try{
   if(updates.restarting){reply(409,{error:'Supervisor is already stopping'});return true;}
   let activity=updates.activity();
   if(!activity.idle){reply(409,{error:'Work is still active',activity});return true;}
   updates.restarting=true;
   // No await between closing admission, rechecking registries and persistence.
   activity=updates.activity();
   if(!activity.idle){updates.restarting=false;reply(409,{error:'Work became active',activity});return true;}
   await persist();
   activity=updates.activity();
   if(!activity.idle){updates.restarting=false;reply(409,{error:'Work became active during persistence',activity});return true;}
   let stopped=false;const stop=()=>{if(!stopped){stopped=true;shutdown();}};
   res.once('finish',stop);res.once('close',stop);
   reply(200,{stopping:true,revision:updates.revision,supervisorPid:process.pid});
  }catch(error){updates.restarting=false;reply(503,{error:`Supervisor could not stop safely: ${error.message}`});}
  return true;
 };
}

export function nativeUpdateStatus(dir){
 try{
  const state=JSON.parse(readFileSync(join(dir,'native-update-state.json'),'utf8'));
  if(!Number.isSafeInteger(state.ownerPid)||state.ownerPid<=1)return {...state,automatic:false};
  try{process.kill(state.ownerPid,0);}catch{return {...state,automatic:false,phase:'owner-offline'};}
  return state;
 }
 catch{return null;}
}
