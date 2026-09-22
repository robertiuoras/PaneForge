import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrateNextProfile} from '../scripts/migrate-next-profile.mjs';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'next-migrate-')),source=join(root,'source'),target=join(root,'target');
 mkdirSync(source);writeFileSync(join(source,'sessions.json'),JSON.stringify([{id:'saved',nativeSessionId:'native-original',items:[{text:'Original output'}]}]));
 t.after(()=>rmSync(root,{recursive:true,force:true}));return {root,source,target};
}
test('dry run writes nothing; apply verifies complete private profile and leaves original intact',t=>{
 const {source,target}=fixture(t);mkdirSync(join(source,'reviews'));mkdirSync(join(source,'empty'));
 const bytes=Buffer.from([0,255,1,2,0]);writeFileSync(join(source,'reviews','output.bin'),bytes);writeFileSync(join(source,'voice-config.json'),'synthetic private configuration');
 const original=readFileSync(join(source,'sessions.json'));
 const plan=migrateNextProfile({source,target});assert.equal(plan.applied,false);assert.equal(plan.files,3);assert.equal(plan.sessions,1);assert.equal(existsSync(target),false);
 const applied=migrateNextProfile({source,target,apply:true});assert.deepEqual(applied,{...plan,applied:true});
 assert.deepEqual(readFileSync(join(target,'sessions.json')),original);assert.deepEqual(readFileSync(join(source,'sessions.json')),original);assert.deepEqual(readFileSync(join(target,'reviews','output.bin')),bytes);assert.ok(statSync(join(target,'empty')).isDirectory());
 if(process.platform!=='win32'){assert.equal(statSync(target).mode&0o777,0o700);assert.equal(statSync(join(target,'voice-config.json')).mode&0o777,0o600);}
 assert.throws(()=>migrateNextProfile({source,target,apply:true}),/already exists/);
});
test('malformed profiles and nested destinations cannot create a replacement',t=>{
 const {source,target}=fixture(t);assert.throws(()=>migrateNextProfile({source,target:join(source,'nested'),apply:true}),/separate/);
 writeFileSync(join(source,'sessions.json'),'{}');assert.throws(()=>migrateNextProfile({source,target,apply:true}),/session list/);assert.equal(existsSync(target),false);
});
test('linked profile entries are rejected without following them',{skip:process.platform==='win32'},t=>{
 const {root,source,target}=fixture(t);writeFileSync(join(root,'outside'),'private');symlinkSync(join(root,'outside'),join(source,'linked'));
 assert.throws(()=>migrateNextProfile({source,target,apply:true}),/Unsupported profile entry/);assert.equal(existsSync(target),false);
});
test('dangling destination links are preserved and rejected',{skip:process.platform==='win32'},t=>{
 const {root,source,target}=fixture(t);symlinkSync(join(root,'missing'),target);
 assert.throws(()=>migrateNextProfile({source,target,apply:true}),/already exists/);
});
test('ambiguous native session keys are refused before any destination is created',t=>{
 const {source,target}=fixture(t);
 for(const sessions of [[{id:''}],[{id:' '}],[{id:'same'},{id:'same'}]]){
  writeFileSync(join(source,'sessions.json'),JSON.stringify(sessions));
  assert.throws(()=>migrateNextProfile({source,target,apply:true}),/unique nonempty IDs/);assert.equal(existsSync(target),false);
 }
});
