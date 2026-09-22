#!/usr/bin/env node
// Run only after stopping the supervisor that owns the source profile.
// This copies local private state, never publishes it or changes a launcher.
import {createHash} from 'node:crypto';
import {closeSync,copyFileSync,chmodSync,existsSync,lstatSync,mkdirSync,mkdtempSync,openSync,readFileSync,readdirSync,readSync,realpathSync,renameSync,rmSync} from 'node:fs';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

function digest(path){
 const hash=createHash('sha256'),fd=openSync(path,'r'),chunk=Buffer.alloc(1024*1024);
 try{for(let count;(count=readSync(fd,chunk))>0;)hash.update(chunk.subarray(0,count));}finally{closeSync(fd);}
 return hash.digest('hex');
}
function targetExists(path){try{lstatSync(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
function inventory(root){
 const result=[];
 function visit(dir){
  for(const name of readdirSync(dir).sort()){
   const path=join(dir,name),stat=lstatSync(path),entry=relative(root,path);
   if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile()))throw Error(`Unsupported profile entry: ${entry}`);
   if(stat.isDirectory()){result.push({path:entry,directory:true});visit(path);}
   else result.push({path:entry,bytes:stat.size,sha256:digest(path)});
  }
 }
 visit(root);return result;
}
export function migrateNextProfile({source,target,apply=false}={}){
 if(!source||!target)throw Error('Source and target profile directories are required');
 if(lstatSync(resolve(source)).isSymbolicLink())throw Error('Source profile must not be a symlink');
 source=realpathSync(source);target=resolve(target);
 // Resolve the parent to reject aliases that put the target inside the source.
 const parent=realpathSync(dirname(target));target=join(parent,target.slice(dirname(target).length+1));
 if(target===source||target.startsWith(source+sep)||source.startsWith(target+sep))throw Error('Source and target must be separate profiles');
 if(targetExists(target))throw Error('Target already exists; refusing to overwrite a profile');
 const entries=inventory(source);
 const sessions=JSON.parse(readFileSync(join(source,'sessions.json'),'utf8'));
 if(!Array.isArray(sessions)||sessions.some(s=>!s||typeof s.id!=='string'))throw Error('Source sessions.json is not a Next session list');
 const report={applied:false,files:entries.filter(e=>!e.directory).length,sessions:sessions.length,bytes:entries.reduce((n,e)=>n+(e.bytes||0),0)};
 if(!apply)return report;
 const stage=mkdtempSync(join(parent,'.next-profile-'));chmodSync(stage,0o700);
 try{
  for(const entry of entries){
   const destination=join(stage,entry.path);
   if(entry.directory)mkdirSync(destination,{mode:0o700});
   else{copyFileSync(join(source,entry.path),destination);chmodSync(destination,0o600);}
  }
  if(JSON.stringify(inventory(stage))!==JSON.stringify(entries))throw Error('Copied profile verification failed');
  if(JSON.stringify(inventory(source))!==JSON.stringify(entries))throw Error('Source changed during migration; stop its supervisor before retrying');
  if(targetExists(target))throw Error('Target appeared during migration; refusing to overwrite it');
  renameSync(stage,target);
  return {...report,applied:true};
 }finally{if(existsSync(stage))rmSync(stage,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i++){
   if(args[i]==='--apply')options.apply=true;
   else if(['--source','--target'].includes(args[i])&&args[i+1])options[args[i].slice(2)]=args[++i];
   else throw Error('Usage: migrate-next-profile.mjs --source STOPPED_NEXT_PROFILE --target NEW_PROFILE [--apply]');
  }
  console.log(JSON.stringify(migrateNextProfile(options)));
 }catch(error){console.error(error.message);process.exitCode=1;}
}
