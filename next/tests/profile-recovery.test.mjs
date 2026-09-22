import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {migrateNextProfile} from '../scripts/migrate-next-profile.mjs';

test('saved profiles reopen without the prototype project and retain terminal project guards',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'next-profile-'))),project=join(root,'work'),dataDir=join(root,'state'),source=join(root,'standalone');
 mkdirSync(project);mkdirSync(source);execFileSync('git',['init','--quiet',project]);
 const projectId=createHash('sha256').update(project).digest('hex').slice(0,16);
 writeFileSync(join(source,'projects.json'),JSON.stringify({projects:[{path:project}]}));
 writeFileSync(join(source,'sessions.json'),JSON.stringify([{id:'saved',projectId,cwd:project,nativeSessionId:'native-saved',provider:'codex',items:[],title:'Saved work'},{id:'legacy',cwd:project,nativeSessionId:'native-legacy',provider:'codex',items:[],title:'Unassigned legacy work'}]));
 assert.equal(migrateNextProfile({source,target:dataDir,apply:true}).applied,true);
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const child=spawn(process.execPath,['server/index.mjs'],{cwd:process.cwd(),env:{...process.env,PANEFORGE_PORT:String(port),PANEFORGE_PROJECTS_ROOT:root,PANEFORGE_WORKSPACE_DIR:'',PANEFORGE_DATA_DIR:dataDir,PANEFORGE_NOTIFICATIONS:'0',PANEFORGE_ENABLE_BACKGROUND_RECOVERY:'0'},stdio:['ignore','pipe','pipe']});
 const exited=once(child,'exit');let output='';child.stdout.on('data',chunk=>{output+=chunk});child.stderr.on('data',chunk=>{output+=chunk});const deadline=setTimeout(()=>child.kill('SIGTERM'),15000);
 try{
  await new Promise((done,fail)=>{child.stdout.on('data',()=>{if(output.includes('PaneForge supervisor'))done();});child.once('exit',()=>fail(Error(output)));});
  const origin=`http://127.0.0.1:${port}`;
  const response=await fetch(`${origin}/api/state`);assert.equal(response.status,200);const state=await response.json();assert.equal(state.sessions.find(s=>s.id==='saved').nativeSessionId,'native-saved');assert.equal(state.sessions.find(s=>s.id==='legacy').projectId,undefined);
  const missing=await fetch(`${origin}/api/history/imported/missing`);assert.equal(missing.status,404);
  const controller=new AbortController();
  try{const events=await fetch(`${origin}/api/events`,{signal:controller.signal});assert.equal(events.status,200);assert.match(events.headers.get('content-type'),/text\/event-stream/);const reader=events.body.getReader();const first=await reader.read();assert.match(new TextDecoder().decode(first.value),/event: state/);}finally{controller.abort();}
  const denied=await fetch(`${origin}/api/terminal/launch`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({sessionId:'saved',projectId:'wrong',machine:'pc'})});assert.equal(denied.status,409);assert.match((await denied.json()).error,/Terminal project does not match/);
 }finally{child.kill('SIGTERM');await exited;clearTimeout(deadline);rmSync(root,{recursive:true,force:true});}
});
