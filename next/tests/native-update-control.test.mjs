import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {createServer,request} from 'node:http';
import {IdleUpdates,nativeUpdateControl,nativeUpdateStatus} from '../server/updates.mjs';
function fixture(t,{activity=()=>({idle:true}),persist=()=>{}}={}){
 const dir=mkdtempSync(join(tmpdir(),'native-update-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const updates={revision:'abc',activity,restarting:false};let stopped=0;
 const control=nativeUpdateControl({dir,updates,persist,shutdown:()=>stopped++});
 const headers={authorization:`Bearer ${readFileSync(join(dir,'.native-control-token'),'utf8')}`,'x-paneforge-revision':'abc'};
 async function call(overrides={}){const res=new EventEmitter();res.writeHead=status=>res.status=status;res.end=body=>{res.body=JSON.parse(body);res.emit('finish');res.emit('close');};await control({url:'/api/native-update/stop',method:'POST',headers,...overrides},res);return res;}
 return {dir,updates,control,headers,call,stopped:()=>stopped};
}
test('stop capability rejects browser origins, wrong tokens, methods and revisions',async t=>{
 const f=fixture(t);
 for(const override of [{method:'GET'},{headers:{}},{headers:{...f.headers,authorization:'Bearer bad'}},{headers:{...f.headers,origin:'http://127.0.0.1:4321'}},{headers:{...f.headers,'x-paneforge-revision':'other'}}])assert.ok((await f.call(override)).status>=400);
 assert.equal(f.stopped(),0);assert.equal(f.updates.restarting,false);
});
test('active work and work discovered at final recheck never stop',async t=>{
 const busy=fixture(t,{activity:()=>({idle:false})});assert.equal((await busy.call()).status,409);assert.equal(busy.stopped(),0);
 let checks=0;const race=fixture(t,{activity:()=>({idle:++checks===1})});assert.equal((await race.call()).status,409);assert.equal(race.updates.restarting,false);assert.equal(race.stopped(),0);
});
test('persistence failure restores admission without shutdown',async t=>{
 const f=fixture(t,{persist:()=>{throw Error('disk full')}});assert.equal((await f.call()).status,503);assert.equal(f.stopped(),0);assert.equal(f.updates.restarting,false);
});
test('persists after closing admission and shuts down exactly once',async t=>{
 const f=fixture(t,{persist:()=>assert.equal(f.updates.restarting,true)});
 assert.equal((await f.call()).status,200);assert.equal(f.stopped(),1);assert.equal((await f.call()).status,409);assert.equal(f.stopped(),1);
});
test('real loopback HTTP returns revision and process identity before shutdown',async t=>{
 const f=fixture(t);const server=createServer(async(req,res)=>{if(!await f.control(req,res)){res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const result=await new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port:server.address().port,path:'/api/native-update/stop',method:'POST',headers:f.headers},res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));});req.on('error',reject);req.end();});
 assert.equal(result.status,200);assert.deepEqual(result.body,{stopping:true,revision:'abc',supervisorPid:process.pid});assert.equal(f.stopped(),1);
});
test('status does not advertise an absent native update owner',async t=>{
 const f=fixture(t);const file=join(f.dir,'native-update-state.json');
 writeFileSync(file,JSON.stringify({automatic:true,ownerPid:process.pid}));assert.equal(nativeUpdateStatus(f.dir).automatic,true);
 writeFileSync(file,JSON.stringify({automatic:true,ownerPid:-1}));assert.equal(nativeUpdateStatus(f.dir).automatic,false);
 writeFileSync(file,'broken');assert.equal(nativeUpdateStatus(f.dir),null);
});

test('native delivery errors remain visible in supervisor status',()=>{
 const updates=new IdleUpdates({revision:'abc',activity:()=>({idle:true}),nativeStatus:()=>({automatic:true,error:'Signature verification failed'})});
 assert.equal(updates.status().error,'Signature verification failed');
});

test('asynchronous journal failure reopens admission without closing services',async t=>{
 let reject;const pending=new Promise((_,fail)=>{reject=fail});
 const f=fixture(t,{persist:()=>pending});const response=f.call();
 assert.equal(f.updates.restarting,true);assert.equal(f.stopped(),0);
 reject(Error('journal failed'));assert.equal((await response).status,503);
 assert.equal(f.updates.restarting,false);assert.equal(f.stopped(),0);
});
test('work discovered after journal flush prevents shutdown',async t=>{
 let checks=0;const f=fixture(t,{activity:()=>({idle:++checks<3}),persist:async()=>{}});
 assert.equal((await f.call()).status,409);assert.equal(f.updates.restarting,false);assert.equal(f.stopped(),0);
});
