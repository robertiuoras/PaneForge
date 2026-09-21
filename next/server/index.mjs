import http from 'node:http';
import {spawn} from 'node:child_process';
import {IdleUpdates,localActivity,installedUpdate,nativeUpdateControl,nativeUpdateStatus} from './updates.mjs';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {VoiceService} from './voice.mjs';
import {VoiceConfirmations} from './voice-confirmations.mjs';
import {readFileSync,existsSync,mkdirSync,realpathSync,readdirSync,statSync,watch} from 'node:fs';
import {join,resolve,extname,relative} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Codex} from './codex.mjs';
import {Sessions,assignLegacyPaneForgeNextProject} from './sessions.mjs';
import {PcExecutor} from './pc.mjs';
import {TerminalService} from './terminal.mjs';
import {Brain,brainScopes} from './brain.mjs';
import {Projects} from './projects.mjs';
import {WorkspaceActions} from './workspace-actions.mjs';
import {openWorkspaceApp,openWorkspaceSearch,appendWorkspaceText,listInstalledApps,externalOpenCommand} from './local-apps.mjs';
import {DeviceFiles} from './device-files.mjs';
import {ReviewStore} from './review-store.mjs';
import {chooseCodexRoute,dispatchConversationTurn} from './routing.mjs';
import {forgeBuildPrompt} from './prompt-forge.mjs';
import {deliverReviewNotice,reviewNoticeReceipt,acknowledgeReviewNotice,noticePaths} from './review-notifications.mjs';
import {listImportedHistory,readImportedHistoryDetail} from './imported-history.mjs';
const port=Number(process.env.PANEFORGE_PORT||4321);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid loopback port');
const origin=`http://127.0.0.1:${port}`;
const host=`127.0.0.1:${port}`;
const brain=new Brain();
const dir=resolve(process.env.PANEFORGE_DATA_DIR||'.local-runtime/app');mkdirSync(dir,{recursive:true,mode:0o700});
const taskdriverEnvironment=process.env.PANEFORGE_TASKDRIVER_ENV||resolve(process.cwd(),'../taskdriver-paneforge-next/.env.local');
let taskdriverOwnerId='';
function taskdriverConfig(){
 if(!existsSync(taskdriverEnvironment))throw Error('Taskdriver live feed is not configured on this Mac.');
 const values=Object.fromEntries(readFileSync(taskdriverEnvironment,'utf8').split(/\r?\n/).map(line=>line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)).filter(Boolean).map(match=>[match[1],match[2].trim().replace(/^(['"])(.*)\1$/,'$2')]));
 const url=values.NEXT_PUBLIC_SUPABASE_URL,key=values.SUPABASE_SERVICE_ROLE_KEY;
 if(!url||!key)throw Error('Taskdriver live feed is not configured on this Mac.');
 return {url,key};
}
async function liveTaskdriverAgents(){
 const {url,key}=taskdriverConfig();const headers={apikey:key,authorization:`Bearer ${key}`};
 if(!taskdriverOwnerId){const users=new URL('/rest/v1/users',url);users.searchParams.set('select','id');users.searchParams.set('email','eq.robertiuoras@gmail.com');users.searchParams.set('limit','1');const response=await fetch(users,{headers,signal:AbortSignal.timeout(4000)});if(!response.ok)throw Error('Taskdriver live feed could not identify its owner.');taskdriverOwnerId=(await response.json())?.[0]?.id||'';if(!taskdriverOwnerId)throw Error('Taskdriver live feed could not identify its owner.');}
 const runs=new URL('/rest/v1/app_agent_runs',url);runs.searchParams.set('select','id,agent_id,status,started_at,action_result,app_agents(name)');runs.searchParams.set('user_id',`eq.${taskdriverOwnerId}`);runs.searchParams.set('status','eq.running');runs.searchParams.set('order','started_at.desc');runs.searchParams.set('limit','25');
 const response=await fetch(runs,{headers,signal:AbortSignal.timeout(4000)});if(!response.ok)throw Error('Taskdriver live feed is temporarily unavailable.');const cutoff=Date.now()-30*60*1000;
 return (await response.json()).filter(run=>Date.parse(run.started_at)>=cutoff).map(run=>({id:run.id,agentId:run.agent_id,name:(Array.isArray(run.app_agents)?run.app_agents[0]:run.app_agents)?.name||'Taskdriver agent',startedAt:run.started_at,phase:run.action_result?.phase||null,model:run.action_result?.model||null}));
}
const workspaceDir=process.env.PANEFORGE_WORKSPACE_DIR ? resolve(process.env.PANEFORGE_WORKSPACE_DIR) : null;
const projects=new Projects({dataDir:dir,defaultPath:workspaceDir});
const clients=new Set();let timer;
const publish=()=>{clearTimeout(timer);timer=setTimeout(()=>{const data=`event: state\ndata: ${JSON.stringify(state())}\n\n`;for(const res of clients)res.write(data);},40);};
const codex=new Codex();const reviews=new ReviewStore(dir,{onRecord:record=>{deliverReviewNotice(record);}});
const sessions=new Sessions(codex,dir,publish,undefined,reviews);
const reviewReceiptDir=join(homedir(),'.claude','guarddeck','result-receipts');
function parkReviewedIfQuiet(review){if(review?.informational!==true)return false;const remaining=reviews.list().some(item=>item.sessionId===review.sessionId&&item.attention);return !remaining&&sessions.quietlyParkReviewed(review.sessionId,{hasExternalWork});}
function reconcileReviewReceipts(){ let changed=false; for(const review of reviews.list()){const reviewedAt=reviewNoticeReceipt(review);if(!reviewedAt||review.reviewedAt)continue;reviews.ack(review.id,true);parkReviewedIfQuiet(reviews.read(review.id));changed=true;}if(changed)publish(); }
if(process.platform==='darwin'){mkdirSync(reviewReceiptDir,{recursive:true,mode:0o700});watch(reviewReceiptDir,{persistent:false},()=>{try{reconcileReviewReceipts();}catch(error){console.error('Review receipt reconciliation:',error.message);}});}
let codexStarting=null;
async function ensureCodexReady({refresh=false}={}){ if(sessions.provider.status==='ready') return refresh?await codex.refreshPreflight():codex.preflight; if(!codexStarting) codexStarting=sessions.start().finally(()=>{codexStarting=null;}); await codexStarting; if(sessions.provider.status!=='ready') throw Error(sessions.provider.error||'Codex subscription provider is unavailable.'); return codex.preflight; }const pc=new PcExecutor({dataDir:dir,onChange:publish});const terminal=new TerminalService({dataDir:dir,onChange:()=>{capturePcReviews();publish();},allowedOrigin:origin,sessionLock:id=>{try{return sessions.get(id).inputLock||null}catch{return null}},onMacCliExit:async({sessionId,nativeSessionId,terminalId})=>{await ensureCodexReady();return sessions.reconcileMacCliExit(sessionId,{nativeSessionId,terminalId})}});
function capturePcReviews(){for(const item of terminal.state()){if(item.code?.kind!=='job')continue;for(const requestId of Object.keys(item.code.requests||{})){try{reviews.capturePcTurn(item,requestId,sessions.get(item.sessionId));}catch(error){console.error('PC review capture:',error.message);}}}}
void terminal.ready().then(capturePcReviews).catch(error=>console.error('PC review recovery:',error.message));

sessions.hasActiveTerminal=id=>terminal.state().some(item=>item.sessionId===id&&!item.exited);
const hasActiveCode=id=>terminal.state().some(item=>item.sessionId===id&&item.code?.kind==='job'&&['running','uncertain'].includes(item.code.status));
const executionStarting=new Set();
const turnDispatcher={sessions,terminal,projects,executionStarting,hasActiveCode,ensureCodexReady};
// Older prototype conversations lacked projectId. Only adopt the canonical
// Next checkout after realpath validation; never broaden another project.
if(sessions.sessions.map(session=>assignLegacyPaneForgeNextProject(session,projects.require('paneforge-next'))).some(Boolean))sessions.changed();
// Older sessions retain their saved project IDs. Fill lane metadata only when the
// saved cwd exactly matches a currently verified worktree for that project.
if(sessions.sessions.map(session=>{if(session.laneId||!session.projectId)return false;try{const lane=projects.laneForCwd(session.projectId,session.cwd);if(!lane)return false;session.laneId=lane.id;session.laneName=lane.name;return true;}catch{return false;}}).some(Boolean))sessions.changed();
const workspaceClients=new Map();
sessions.workspaceExecutor=new WorkspaceActions({sessions,projects,terminal,brain,deviceFiles:new DeviceFiles(),listApps:listInstalledApps,appendText:(app,text,isCurrent)=>appendWorkspaceText(app,text,undefined,isCurrent),openSearch:(query,isCurrent)=>openWorkspaceSearch(query,undefined,isCurrent),openApp:(id,isCurrent)=>openWorkspaceApp(id,undefined,isCurrent),onNavigate:async request=>{if(!workspaceClients.get(request.clientId))throw Error('The requesting window is disconnected. Reconnect and ask to open this result again.');}});
function hasExternalWork(sessionId){return voice.active?.sessionId===sessionId||pc.list().some(job=>job.sessionId===sessionId&&['queued','dispatching','running'].includes(job.state))||terminal.state().some(item=>item.sessionId===sessionId&&!item.exited);}
const voiceConfirmations=new VoiceConfirmations({sessions,hasExternalWork});
const voice=new VoiceService({dataDir:dir,keyFile:join(homedir(),'.config/paneforge-next/voice-api-key'),getSession:id=>sessions.get(id),
 onTranscript(id,event){const session=sessions.get(id);session.voiceHistory??=[];if(event.eventId&&session.voiceHistory.some(e=>e.eventId===event.eventId&&e.liveSessionId===event.liveSessionId))return;session.voiceHistory.push(event);sessions.changed();},
 async delegate({sessionId,connectionId,delegationId,transcript,onProgress,onBackground,clientId,isCurrent}){
  if(!isCurrent())return 'Voice connection ended. No new action was started.';
  const confirmation=await voiceConfirmations.handle({sessionId,connectionId,delegationId,input:transcript.input});
  if(confirmation!==null)return confirmation;
  try {
   const direct=await sessions.workspaceExecutor.executeCommand(transcript.input,isCurrent,onProgress,{assistantId:sessionId,clientId,callId:'find-'+createHash('sha256').update(delegationId).digest('hex')});
   if(direct.handled)return direct.message;
  } catch(error) {return `Local action did not complete: ${error.message}`;}
  const session=sessions.get(sessionId);
  if(session.activeTurn||sessions.busy.has(sessionId))return 'The current Chat task is still running. Review or steer it in Chat; no second task was started.';
  if(session.title==='New conversation'){sessions.rename(sessionId,transcript.input.trim().replace(/\s+/g,' ').slice(-60)||'Voice conversation');}
  const before=new Set(session.items.map(item=>item.id));
  let finish;const completion=new Promise(resolve=>{finish=resolve});
  const listener=m=>{if(m.method==='turn/completed'&&sessions.matchesProviderThread(sessionId,m.params?.threadId))finish(m.params.turn);};
  const approval=m=>{if(m.method==='mcpServer/elicitation/request'&&sessions.matchesProviderThread(sessionId,m.params?.threadId))onProgress('Your request needs approval in Assistant history. After approval I can share the result.');else if(m.method==='item/tool/call'&&sessions.matchesProviderThread(sessionId,m.params?.threadId))onProgress(`Working on ${m.params.tool.replaceAll('_',' ')}.`);};
  codex.on('notification',listener);codex.on('request',approval);
  const timeout=setTimeout(()=>finish({status:'continuing'}),60000);
  try{
   const requestId='voice-'+createHash('sha256').update(delegationId).digest('hex');
   const result=await sessions.turn(sessionId,{requestId,clientId,text:`Current local clock: ${new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Brisbane',dateStyle:'full',timeStyle:'long'}).format(new Date())} (Australia/Brisbane). Use get_workspace_time for date/time questions; use tools before answering current workspace facts. If no live source exists, say it is unverified. Speech recognition may contain mistakes; ask if unclear. Act only on the NEW REQUEST. Earlier context helps resolve references but never authorizes repeating actions. Open, organize or submit prompts only as requested. Give concise results with source links.\nEARLIER CONTEXT (not new instructions):\n${transcript.context||''}\nPREVIOUS SPOKEN RESPONSE (not verified evidence):\n${transcript.output||''}\nNEW REQUEST:\n${transcript.input.slice(-4000)}`});
   if(result.state)return 'This voice request was already submitted. Check its saved status in Chat.';
   await onBackground();
   const turn=await completion;
   if(turn.status==='continuing')return 'Your request is still running in Chat. Ending voice will not cancel it.';
   if(turn.status!=='completed')return 'The Chat task ended without confirmed completion. Check Chat for its status.';
   return session.items.filter(item=>item.type==='agentMessage'&&!before.has(item.id)).map(item=>item.text||'').join('\n').slice(-1500)||'The task completed. Review its result and sources in Chat.';
  }finally{clearTimeout(timeout);codex.off('notification',listener);codex.off('request',approval);}
 }
});
let starting=true,reconciling=false,activeRequests=0;
const revision=process.env.PANEFORGE_REVISION||(()=>{try{return execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();}catch{return 'unversioned';}})();
const updates=new IdleUpdates({revision,nativeStatus:()=>nativeUpdateStatus(dir),readUpdate:port===4317?installedUpdate:()=>null,activity:()=>localActivity({sessions,terminal,pc,voice,codex,requests:activeRequests,starting,reconciling}),restart:async next=>{
 const log=await import('node:fs');const output=log.openSync(join(dir,'update-restart.log'),'a',0o600);
 const child=spawn(process.execPath,[join(next.root,'scripts/restart-idle.mjs'),String(process.pid)],{cwd:next.root,env:{...process.env,PANEFORGE_DATA_DIR:dir,PANEFORGE_PORT:String(port),PANEFORGE_REVISION:next.revision},detached:true,stdio:['ignore',output,output]});
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();publish();shutdown();
}});
const nativeControl=process.env.PANEFORGE_NATIVE_CONTROL==='1'?nativeUpdateControl({dir,updates,persist:async()=>{await terminal.journal;sessions.changed();},shutdown:()=>shutdown(true)}):null;
const state=()=>{const terminals=terminal.state();return {updates:updates.status(),provider:sessions.provider,claudeProvider:sessions.claudeProvider,sessions:sessions.visible(),approvals:sessions.approvals.map(({rpcId,...a})=>a),jobs:pc.list(),terminals,terminal:terminals.at(-1)||{}};};
const send=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));};
const allowedOrigins=new Set([origin]);
function safeFile(path){if(typeof path!=='string'||!path||path.startsWith('.')||path.split('/').some(p=>p.startsWith('.')||p==='node_modules')||path.length>250)throw Error('File is outside this workspace preview');const full=realpathSync(resolve(path));if(!full.startsWith(realpathSync(process.cwd())+'/')||!['.md','.txt','.mjs','.tsx','.ts','.css','.json','.rs','.toml','.html'].includes(extname(full)))throw Error('File is outside this workspace preview');if(statSync(full).size>250000)throw Error('File exceeds preview size');return full;}
async function body(req){let raw='';for await(const part of req){raw+=part;if(Buffer.byteLength(raw)>7_200_000)throw Error('Request exceeds 7.2 MB');}return JSON.parse(raw||'{}');}
const server=http.createServer(async(req,res)=>{
 try{
  if(req.headers.host===`localhost:${port}`&&req.method==='GET'){res.writeHead(308,{location:origin+req.url});res.end();return;}
  if(req.headers.host!==host){send(res,403,{error:'Loopback workspace only'});return;}
  if(req.headers.origin&&!allowedOrigins.has(req.headers.origin)){send(res,403,{error:'Foreign origin denied'});return;}
  if(nativeControl&&await nativeControl(req,res))return;
  if(req.method!=='GET'&&(!allowedOrigins.has(req.headers.origin)||!req.headers['content-type']?.startsWith('application/json'))){send(res,403,{error:'Same-origin JSON request required'});return;}
  const url=new URL(req.url,origin);const path=url.pathname;
  if(req.method==='GET'&&path==='/api/health')return send(res,200,{product:'paneforge-next',revision,dataDir:dir});
  if(req.method==='GET'&&path==='/api/updates')return send(res,200,updates.status());
  if(req.method!=='GET'){if(updates.restarting)return send(res,503,{error:'Applying update while idle. Reconnect in a moment.'});activeRequests++;res.once('close',()=>{activeRequests--;});}
  if(req.method==='GET'&&path==='/api/voice/status')return send(res,200,await voice.status());
  if(req.method==='GET'&&path==='/api/projects')return send(res,200,{projects:projects.list()});
  let projectMatch;
  if(req.method==='GET'&&(projectMatch=path.match(/^\/api\/projects\/([^/]+)\/lanes$/)))return send(res,200,{lanes:projects.lanes(projectMatch[1])});
  if(req.method==='GET'&&(projectMatch=path.match(/^\/api\/projects\/([^/]+)\/files$/)))return send(res,200,await projects.children(projectMatch[1],url.searchParams.get('directory')||'',url.searchParams.get('laneId')?projects.requireLane(projectMatch[1],url.searchParams.get('laneId')).path:null));
  if(req.method==='GET'&&path==='/api/brain/graph')return send(res,200,await brain.graph(url.searchParams.get('scope')));
  if(req.method==='GET'&&path==='/api/brain/file')return send(res,200,await brain.file(url.searchParams.get('scope'),url.searchParams.get('path')));
  if(req.method==='POST'&&path==='/api/brain/obsidian'){const input=await body(req);await brain.file(input.scope,input.path);const split=input.path.indexOf(':');const vault={'knowledge':'Obsidian Vault','agent-memory':'claude-memory'}[input.path.slice(0,split)];if(!vault)throw Error('Unknown indexed vault');const uri=`obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(input.path.slice(split+1))}`;execFileSync(...externalOpenCommand(uri),{timeout:4000,stdio:'ignore'});return send(res,200,{ok:true});}
  if(req.method==='GET'&&path==='/api/brain/scopes')return send(res,200,{scopes:brainScopes});
  if(req.method==='GET'&&path==='/api/brain')return send(res,200,await brain.search(url.searchParams.get('q'),url.searchParams.get('scope')));
  if(req.method==='GET'&&path==='/api/brain/source'){const scope=url.searchParams.get('scope'),sourcePath=url.searchParams.get('path');try{return send(res,200,brain.source(scope,sourcePath));}catch{const file=await brain.file(scope,sourcePath);return send(res,200,{...file,text:file.text.slice(0,1400),truncated:file.text.length>1400});}}
  if(req.method==='GET'&&path==='/api/reviews'){reconcileReviewReceipts();return send(res,200,{reviews:reviews.list(),persistent:true});}
  if(req.method==='GET'&&path==='/api/state')return send(res,200,state());
  if(req.method==='GET'&&path==='/api/taskdriver-agents')return send(res,200,{running:await liveTaskdriverAgents()});
  if(req.method==='GET'&&path==='/api/history')return send(res,200,{sessions:sessions.historyMetadata(url.searchParams.get('q')||'')});
  if(req.method==='GET'&&path==='/api/history/imported')return send(res,200,await listImportedHistory({dataDir:dir,query:url.searchParams.get('q')||''}));
  if(req.method==='GET'&&(match=path.match(/^\/api\/history\/imported\/([^/]+)$/))){const detail=await readImportedHistoryDetail({dataDir:dir,id:match[1]});if(!detail)return send(res,404,{error:'Imported history not found'});return send(res,200,detail);}
  if(req.method==='GET'&&path==='/api/sessions/deleted')return send(res,200,{sessions:sessions.deleted()});
  if(req.method==='GET'&&path==='/api/events'){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive'});res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);clients.add(res);const clientId=url.searchParams.get('client');if(clientId&&/^[A-Za-z0-9_-]{1,160}$/.test(clientId))workspaceClients.set(clientId,(workspaceClients.get(clientId)||0)+1);req.on('close',()=>{clients.delete(res);if(clientId)workspaceClients.set(clientId,Math.max(0,(workspaceClients.get(clientId)||0)-1));});return;}
  if(req.method==='GET'&&path==='/api/evidence'){const files=[];for(const directory of ['src','server','tests','docs']){if(existsSync(directory))for(const path of readdirSync(directory,{recursive:true})) {const full=join(directory,path);if(statSync(full).isFile()){try{safeFile(full);files.push({path:full});}catch{ /* Exclude unsupported or oversized previews. */ }}}}let diff='';try{diff=execFileSync('git',['diff','--no-ext-diff','--unified=2','--','src','server','scripts','tests','src-tauri'],{encoding:'utf8',maxBuffer:100000});}catch{diff='Git diff unavailable';}return send(res,200,{files,diff,tests:existsSync('docs/evidence/verification.md')?readFileSync('docs/evidence/verification.md','utf8'):'Verification is in progress. No test pass is implied.'});}
  if(req.method==='GET'&&path==='/api/file'){const projectId=url.searchParams.get('projectId')||'paneforge-next';let cwd=null;if(url.searchParams.get('sessionId')){const session=sessions.get(url.searchParams.get('sessionId'));if(session.projectId!==projectId)throw Error('Source project does not match this conversation');cwd=session.cwd;}else if(url.searchParams.get('laneId'))cwd=projects.requireLane(projectId,url.searchParams.get('laneId')).path;return send(res,200,await projects.read(projectId,url.searchParams.get('path'),cwd));}
  if(['POST','PATCH','DELETE'].includes(req.method)){
   let data=await body(req);let match;
   if((match=path.match(/^\/api\/reviews\/([A-Za-z0-9_-]{1,120})\/(ack|open|reply)$/))&&req.method==='POST'){const [,reviewId,action]=match;
    if(action==='ack'){if(typeof data.reviewed!=='boolean')throw Error('reviewed must be boolean');const result=reviews.ack(reviewId,data.reviewed);const review=reviews.read(reviewId);if(data.reviewed&&result.clearedAttention&&review){acknowledgeReviewNotice(review);parkReviewedIfQuiet(review);}publish();return send(res,200,result);}
    if(action==='open'){if(!Number.isInteger(data.index)||data.index<-1)throw Error('Invalid report link');const target=reviews.open(reviewId,data.index);if(!target){const error=Error('Review evidence is unavailable');error.statusCode=404;throw error;}execFileSync(...externalOpenCommand(target),{timeout:4000,stdio:'ignore'});return send(res,200,{opened:true,target});}
    if(typeof data.text!=='string'||!data.text.trim()||data.text.length>32000||typeof data.requestId!=='string'||!data.requestId.trim())throw Error('Reply text and request identity are required');const review=reviews.read(reviewId);if(!review){const error=Error('Review not found');error.statusCode=404;throw error;}const session=sessions.get(review.sessionId);const dispatched=await dispatchConversationTurn(turnDispatcher,session,data,false,review);return send(res,202,{...dispatched.result,sessionId:session.id,...(dispatched.result.execution==='pc'?{}:{nativeSessionId:session.nativeSessionId})});
   }
   if((match=path.match(/^\/api\/sessions\/([^/]+)$/))){const [,id]=match;
    if(req.method==='PATCH')return send(res,200,Object.hasOwn(data,'automaticContextRenewal')?sessions.setAutomaticRenewal(id,data.automaticContextRenewal):sessions.rename(id,data.title));
    if(req.method==='DELETE')return send(res,200,sessions.remove(id,{hasExternalWork}));
   }
   if((match=path.match(/^\/api\/sessions\/([^/]+)\/restore$/))){if(req.method!=='POST')return send(res,405,{error:'Method not allowed'});return send(res,200,sessions.restore(match[1]));}
   if(req.method!=='POST')return send(res,405,{error:'Method not allowed'});
   if((match=path.match(/^\/api\/sessions\/([^/]+)\/renew$/)))return send(res,200,await sessions.renew(match[1],{requestId:data.requestId,requester:'user',pendingDraft:data.pendingDraft}));
   if((match=path.match(/^\/api\/sessions\/([^/]+)\/renew\/cancel$/)))return send(res,200,sessions.cancelRenewal(match[1],data.operationId));
   if(path==='/api/local/command')return send(res,200,await sessions.workspaceExecutor.executeCommand(data.text,undefined,undefined,data.assistantId?{assistantId:data.assistantId,clientId:data.clientId,callId:data.requestId}:undefined));
   if(path==='/api/local/action')return send(res,200,await sessions.workspaceExecutor.executeLocal(data.tool,data.args));
   if(path==='/api/workspace/ack'){if(!['assistantId','callId','clientId'].every(key=>typeof data[key]==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(data[key]))||!workspaceClients.get(data.clientId))throw Error('Invalid or disconnected presentation client');const s=sessions.get(data.assistantId);const action=s.workspaceActions?.find(a=>a.callId===data.callId&&a.clientId===data.clientId);if(!action||action.result?.state!=='navigation_requested')throw Error('Unknown presentation request');if(!action.presentationAck){action.presentationAck={at:new Date().toISOString(),state:data.error?'failed':'presented',...(data.error?{error:String(data.error).slice(0,200)}:{})};sessions.changed();}return send(res,200,action.presentationAck);}
   if(path==='/api/projects')return send(res,201,projects.register(data.path));
   if(path==='/api/assistant'){const project=projects.require('paneforge-next');const live=await ensureCodexReady();const choice=chooseCodexRoute({task:data.text||data.title||'assistant workspace action',models:live.models,rateLimits:live.rateLimits,requestedModel:data.model,requestedEffort:data.effort});if(!choice.ok)throw Error(choice.reason);const result=await sessions.assistant({cwd:project.path,projectId:project.id,model:choice.model,effort:choice.effort});return send(res,result.created?201:200,result.session);}
   if(path==='/api/sessions'){if(data.provider!=null&&!['codex','claude'].includes(data.provider))throw Error('Unknown session provider');const project=projects.require(data.projectId||'paneforge-next');if(data.laneId&&data.newLane)throw Error('Choose an existing lane or a new lane, not both.');const lane=data.newLane?projects.createLane(project.id,data.newLane):data.laneId?projects.requireLane(project.id,data.laneId):projects.lanes(project.id).find(item=>item.isCurrent)||{id:null,name:null,path:project.path};if(data.provider==='claude'){const claudeReady=await sessions.startClaude();if(claudeReady.status!=='ready')throw Error(claudeReady.error||'Claude provider is unavailable');return send(res,201,await sessions.create({cwd:lane.path,projectId:project.id,laneId:lane.id,laneName:lane.name,provider:data.provider}));}const live=await ensureCodexReady();const choice=chooseCodexRoute({task:data.text||data.title||'',models:live.models,rateLimits:live.rateLimits,requestedModel:data.model,requestedEffort:data.effort});if(!choice.ok)throw Error(choice.reason);return send(res,201,await sessions.create({cwd:lane.path,projectId:project.id,laneId:lane.id,laneName:lane.name,provider:data.provider,model:choice.model,effort:choice.effort,requestId:data.requestId}));}
   if((match=path.match(/^\/api\/sessions\/([^/]+)\/(turn|steer|stop|resume|link)$/))){const [,id,action]=match;if(action==='stop'){await sessions.stop(id);return send(res,200,{ok:true});}if(action==='resume')return send(res,200,await sessions.resume(id));if(action==='link'){if(!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(data.taskId||''))throw Error('Taskdriver UUID required');const s=sessions.get(id);s.taskdriverTaskId=data.taskId;sessions.changed();return send(res,200,s);}const session=sessions.get(id);const dispatched=await dispatchConversationTurn(turnDispatcher,session,data,action==='steer');return send(res,dispatched.status,dispatched.result);}
   if((match=path.match(/^\/api\/approvals\/([^/]+)$/))){sessions.approve(match[1],data.decision);return send(res,200,{ok:true});}
   if(path==='/api/jobs'){sessions.assertInputAllowed(data.sessionId);return send(res,202,await pc.enqueue(data));}
   if((match=path.match(/^\/api\/jobs\/([^/]+)\/retry$/)))return send(res,200,await pc.retry(match[1]));
   if(path==='/api/terminal')return send(res,409,{error:'Open saved output or use Run on PC. A conversation has one durable PC work session.'});
   if(path==='/api/terminal/turn'||path==='/api/terminal/stop'||path==='/api/terminal/launch'){
    const session=sessions.get(data.sessionId);
    if(path==='/api/terminal/stop')return send(res,200,await terminal.stopCodeTurn(session.id));
    sessions.assertInputAllowed(session.id);if(session.cliReconciliation)throw Error('The Mac CLI transcript is reconciling. Wait before launching Code.');if(executionStarting.has(session.id)||session.activeTurn||sessions.busy.has(session.id))throw Error('This conversation is running in Chat. Wait before starting or launching Code.');const nextProject=projects.require('paneforge-next');
    if(assignLegacyPaneForgeNextProject(session,nextProject))sessions.changed();
    if(data.projectId!=null&&data.projectId!==session.projectId){const error=Error('Terminal project does not match this conversation.');error.statusCode=409;throw error;}
    let lane;try{lane=session.laneId?projects.requireLane(session.projectId,session.laneId):projects.laneForCwd(session.projectId,session.cwd);}catch{lane=null;}
    if(!lane||lane.path!==session.cwd){const error=Error('This saved lane is no longer available. Reopen the project and choose its current lane.');error.statusCode=409;throw error;}
    const target={sessionId:session.id,projectId:session.projectId,laneId:lane.id,laneName:lane.name,cwd:lane.path,provider:session.provider,model:session.model,effort:session.effort};
    if(path==='/api/terminal/launch'){if(!['mac','pc'].includes(data.machine))throw Error('Choose Mac or PC');let released=false;if(data.machine==='mac'){if(session.provider!=='codex'||!session.nativeSessionId||session.activeTurn||sessions.busy.has(session.id)||sessions.sessions.some(other=>other.id!==session.id&&(other.activeTurn||sessions.busy.has(other.id))))throw Error('Mac CLI requires an idle Codex conversation and no other active Chat turn before releasing its exact native identity');Object.assign(target,{nativeSessionId:session.nativeSessionId,model:session.model,effort:session.effort});await sessions.releaseForMacCli(session.id,{nativeSessionId:session.nativeSessionId,terminalId:'opening'});released=true;}try{return send(res,200,await terminal.create({...target,machine:data.machine}));}catch(error){if(released){try{await ensureCodexReady();await sessions.reconcileMacCliExit(session.id,{nativeSessionId:session.nativeSessionId,terminalId:'launch-failed'});}catch{}}throw error;}}
    return send(res,200,await terminal.runCodeTurn({...target,requestId:data.requestId,text:data.text}));
   }
  }
  if(path.startsWith('/api/'))return send(res,404,{error:'Unknown workspace endpoint'});
  if(req.method!=='GET')return send(res,405,{error:'Method not allowed'});
  const distDir=resolve(process.env.PANEFORGE_DIST_DIR||'dist');const asset=resolve(distDir,'.'+path);const file=asset.startsWith(distDir+'/')&&existsSync(asset)&&statSync(asset).isFile()?asset:resolve(distDir,'index.html');
  if(!existsSync(file))return send(res,503,{error:'Run npm run build before starting PaneForge'});
  res.writeHead(200,{'content-type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'self'; base-uri 'self'",'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'});res.end(readFileSync(file));
 }catch(e){send(res,e.statusCode||400,{error:e.message});}
});
terminal.attach(server);
reconcileReviewReceipts();
const voiceSockets=new WebSocketServer({noServer:true,maxPayload:24576});
server.on('upgrade',(req,socket,head)=>{
 let url;try{url=new URL(req.url,origin);}catch{socket.destroy();return;}
 if(url.pathname!=='/api/voice')return;
 if(updates.restarting){socket.destroy();return;}
 if(req.headers.host!==host||!allowedOrigins.has(req.headers.origin)){socket.destroy();return;}
 voiceSockets.handleUpgrade(req,socket,head,client=>{void voice.connect(client,url.searchParams.get('session'),url.searchParams.get('client')).catch(()=>{client.close(1011,'Voice unavailable');});});
});
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'PaneForge supervisor is already listening on port 4321. Reuse it; do not create a second executor.':e.message);process.exit(1);});
server.listen(port,'127.0.0.1',()=>{starting=false;console.log(`PaneForge supervisor ${origin}`);publish();});
const backgroundRecovery=process.env.PANEFORGE_ENABLE_BACKGROUND_RECOVERY==='1';
const interval=backgroundRecovery?setInterval(async()=>{if(reconciling||updates.restarting)return;reconciling=true;try{await pc.reconcile();}catch(e){console.error('PC reconciliation:',e.message);}finally{reconciling=false;}},5000):null;
const updateInterval=backgroundRecovery?setInterval(()=>{void updates.check().then(publish);},2000):null;
function shutdown(nativeUpdate=false){
 if(updateInterval)clearInterval(updateInterval);if(interval)clearInterval(interval);
 codex.close();sessions.claude?.close();
 const persisted=Promise.all([voice.close(),terminal.close()]);
 server.close();
 if(nativeUpdate===true){
  // Never force exit through a pending terminal journal during replacement.
  void persisted.then(()=>{server.closeAllConnections();process.exit();}).catch(error=>console.error('Native update shutdown could not persist:',error.message));
 }else{void persisted.catch(error=>console.error('Shutdown:',error.message));setTimeout(()=>process.exit(),5500).unref();}
}
process.on('SIGTERM',shutdown);
