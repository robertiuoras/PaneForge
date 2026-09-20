import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
import {join,basename} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {lstat,readdir,realpath} from 'node:fs/promises';
import {workspaceApps} from './workspace-actions.mjs';
const run=promisify(execFile);
const guard=join(homedir(),'Projects/claude-memory/claude-config/computer-use-guard.mjs');
const MAX_APPS=60;
const MAX_SCAN_ENTRIES=600;

function desktopGuardFailure(error, unchanged) {
 let busy=false;
 try {const result=JSON.parse(error.stdout);busy=result.ok===false&&typeof result.owner?.session==='string';} catch {}
 return Error(`${busy?'Another session is using the desktop. Try again after it finishes.':'Desktop coordination is unavailable. Try again once coordination is restored.'} ${unchanged}`);
}

function installedAppRoots(){return ['/Applications','/System/Applications',join(homedir(),'Applications')];}
function installedAppId(path){return `installed-${createHash('sha256').update(path).digest('hex').slice(0,32)}`;}
function appName(path){return basename(path,'.app');}

async function canonicalDirectory(path){
 const stat=await lstat(path);
 if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Not a verified directory');
 const verifiedPath=await realpath(path);
 const verifiedStat=await lstat(verifiedPath);
 if(!verifiedStat.isDirectory()||verifiedStat.isSymbolicLink())throw Error('Not a verified directory');
 return verifiedPath;
}
async function verifiedDirectory(path){const verifiedPath=await canonicalDirectory(path);if(verifiedPath!==path)throw Error('Directory changed');return path;}

// The bounded walk deliberately never follows a symlink. It returns real paths
// so an opaque id always identifies the bundle that was inspected.
async function discoverInstalledApps(roots=installedAppRoots()){
 const apps=[];let scanned=0;let truncated=false;
 const queue=[];const queued=new Set();const seenApps=new Set();
 for(const root of roots){try{const path=await canonicalDirectory(root);if(!queued.has(path)){queued.add(path);queue.push({path,depth:0});}}catch{}}
 for(let index=0;index<queue.length;index++){
  const current=queue[index];
  let entries;try{await verifiedDirectory(current.path);entries=await readdir(current.path,{withFileTypes:true});}catch{continue;}
  for(const entry of entries){
   if(entry.name.startsWith('.'))continue;
   if(++scanned>MAX_SCAN_ENTRIES){truncated=true;break;}
   const path=join(current.path,entry.name);
   if(entry.isSymbolicLink())continue;
   if(entry.isDirectory()&&entry.name.endsWith('.app')){
    let stat,verifiedPath;try{stat=await lstat(path);verifiedPath=await realpath(path);}catch{continue;}
    if(stat.isDirectory()&&!stat.isSymbolicLink()&&verifiedPath===path&&!seenApps.has(verifiedPath)){seenApps.add(verifiedPath);apps.push({appId:installedAppId(verifiedPath),name:appName(verifiedPath),path:verifiedPath});}
    continue;
   }
   if(entry.isDirectory()&&current.depth<2&&!queued.has(path)){queued.add(path);queue.push({path,depth:current.depth+1});}
  }
  if(truncated)break;
 }
 apps.sort((left,right)=>left.name.localeCompare(right.name)||left.path.localeCompare(right.path));
 return {apps,truncated};
}

export async function listInstalledApps(query='',roots=installedAppRoots()){
 const needle=String(query).slice(0,200).trim().toLocaleLowerCase();
 const discovered=await discoverInstalledApps(roots);
 const matches=needle?discovered.apps.filter(app=>app.name.toLocaleLowerCase().includes(needle)):discovered.apps;
 return {apps:matches.slice(0,MAX_APPS).map(({appId,name})=>({appId,name})),truncated:discovered.truncated||matches.length>MAX_APPS};
}

async function installedAppForId(appId,roots){
 const discovered=await discoverInstalledApps(roots);
 return discovered.apps.find(app=>app.appId===appId);
}

export async function openWorkspaceSearch(query,execute=run,isCurrent=()=>true){
 if(typeof query!=='string')throw Error('Search query must be text.');
 const clean=query.trim();
 if(!clean||clean.length>500||/[\u0000-\u001F\u007F]/.test(clean))throw Error('Search query is invalid.');
 if(process.platform!=='darwin')throw Error('Local searches can only open on the Mac');
 const url=`https://www.google.com/search?${new URLSearchParams({q:clean})}`;
 const owner=`paneforge-live-${randomUUID()}`;
 try{await execute(process.execPath,[guard,'begin',owner,'Default Browser','screen',String(process.pid),'Open Google Search for GPT Live'],{timeout:10000,maxBuffer:16000});}
 catch(error){throw desktopGuardFailure(error,'No search was opened.');}
 try{if(!isCurrent())throw Error('Workspace request ended before search');await execute('/usr/bin/open',[url],{timeout:10000,maxBuffer:4000});}
 catch{throw Error('Search could not be opened.');}
 finally{try{await execute(process.execPath,[guard,'release',owner],{timeout:10000,maxBuffer:16000});}catch{throw Error('Search was requested, but desktop ownership cleanup failed. Check shared desktop status before another action.');}}
 return {state:'search_open_requested',query:clean,url};
}

// Only fixed catalog entries and rediscovered opaque ids can reach Launch
// Services. No model-supplied command, URL, path or arguments are accepted.
// Shared desktop ownership must be granted first.
export async function openWorkspaceApp(appId,execute=run,isCurrent=()=>true,{roots=installedAppRoots()}={}){
 let app=workspaceApps.find(app=>app.appId===appId);
 let installed=false;
 if(!app&&typeof appId==='string'&&appId.startsWith('installed-')){app=await installedAppForId(appId,roots);installed=true;}
 if(!app)throw Error('Unsupported application');
 if(process.platform!=='darwin')throw Error('Local apps can only open on the Mac');
 const owner=`paneforge-live-${randomUUID()}`;
 try{await execute(process.execPath,[guard,'begin',owner,app.name,'screen',String(process.pid),`Open ${app.name} for GPT Live`],{timeout:10000,maxBuffer:16000});}
 catch(error){throw desktopGuardFailure(error,'No app was opened.');}
 try{
  if(!isCurrent())throw Error('Workspace request ended before launch');
  if(installed){const current=await installedAppForId(appId,roots);if(!current||current.path!==app.path)throw Error('Installed app changed');app=current;}
  await execute('/usr/bin/open',installed?['-a',app.path]:['-b',app.bundleId],{timeout:10000,maxBuffer:4000});
 }
 catch{throw Error(`${app.name} could not be opened. Check that it is installed.`);}
 finally{try{await execute(process.execPath,[guard,'release',owner],{timeout:10000,maxBuffer:16000});}catch{throw Error('App launch was requested, but desktop ownership cleanup failed. Check shared desktop status before another action.');}}
 return {state:'launch_requested',appId};
}


// Document editors only. No key events, clipboard, shell fields or submit action.
export async function appendWorkspaceText(app, text, execute=run, isCurrent=()=>true) {
 const bundles={TextEdit:'com.apple.TextEdit',Notes:'com.apple.Notes'};
 if(!Object.hasOwn(bundles,app))throw Error('Text entry currently supports TextEdit and Notes document fields.');
 if(typeof text!=='string'||!text.length||text.length>10000||/[\u0000-\u0008\u000B-\u001F\u007F]/.test(text))throw Error('Invalid document text.');
 const owner=`paneforge-live-${randomUUID()}`;
 try {await execute(process.execPath,[guard,'begin',owner,app,'screen',String(process.pid),'Append requested document text'],{timeout:10000,maxBuffer:16000});}
 catch(error) {throw desktopGuardFailure(error,'No text was entered.');}
 try {
  if(!isCurrent())throw Error('Workspace request ended before text entry.');
  const {stdout}=await execute('/usr/bin/osascript',[new URL('./append-text.applescript',import.meta.url).pathname,bundles[app],text],{timeout:10000,maxBuffer:2000});
  if(stdout.trim()!=='text_appended')throw Error('Text entry was not verified. Do not retry automatically.');
  return {state:'text_appended',app};
 } catch(error) {
  const detail=String(error.stderr||error.message||'').split('execution error:').at(-1).trim();
  const code=Number(detail.match(/\((-?\d+)\)\s*$/)?.[1]);
  const reasons={17001:'Open the requested app and its document first.',17002:'Focus an editable document text area first.',17003:'Secure fields are not supported.',17004:'This document does not allow accessible text entry.',17005:'The selected field is not a plain text document.',17006:'This document is too large for safe text entry.',17007:'The focused app changed. No text was entered.',17008:'Text entry could not be verified. Check the document; do not retry automatically.',17009:'The document rejected text entry. Check it before retrying.',17010:'The document changed. No text was entered.'};
  if(Object.hasOwn(reasons,code))throw Error(reasons[code]);
  if(code===-1743||code===-25211||/not allowed|not authorized/i.test(detail))throw Error('macOS Accessibility or Automation permission is required for document typing.');
  if(error.killed||code===-1712)throw Error('Document typing timed out. Check the document and any macOS permission prompt before trying again; text entry was not verified.');
  throw Error(`Document text entry was not verified${Number.isInteger(code)?` (macOS error ${code})`:''}. Check the focused document and macOS permissions; do not retry automatically.`);
 } finally {await execute(process.execPath,[guard,'release',owner],{timeout:10000,maxBuffer:16000});}
}
