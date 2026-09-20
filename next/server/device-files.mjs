import {promises as fs, constants} from 'node:fs';
import {homedir} from 'node:os';
import {basename, extname, isAbsolute, join, relative, resolve, sep} from 'node:path';

const ROOTS=[['desktop','Desktop'],['documents','Documents'],['downloads','Downloads']];
const MAX_DEPTH=6,MAX_ENTRIES=5000,MAX_RESULTS=30,MAX_PREVIEW=64*1024;
const blockedDirectories=new Set(['applications','application','library','node_modules','.git','dist','build','out','target','coverage','package','packages']);
const textExtensions=new Set(['.txt','.md','.mdx','.csv','.tsv','.json','.jsonl','.yaml','.yml','.xml','.html','.htm','.css','.js','.mjs','.cjs','.ts','.tsx','.jsx','.py','.rb','.go','.rs','.java','.sh','.zsh','.log','.rtf']);
const documentExtensions=new Set(['.pdf','.doc','.docx','.odt','.pages','.xls','.xlsx','.ods','.numbers','.ppt','.pptx','.odp','.key']);
const imageExtensions=new Set(['.png','.jpg','.jpeg','.gif','.webp','.heic','.tif','.tiff','.bmp','.svg']);
const audioExtensions=new Set(['.mp3','.m4a','.aac','.wav','.aiff','.flac','.ogg']);
const videoExtensions=new Set(['.mp4','.mov','.m4v','.webm','.avi','.mkv']);
const secretPart=/(?:^|[._-])(secret|credential|password|passwd|token|api[_-]?key|private)(?:$|[._-])|^\.env(?:\.|$)|^id_(?:rsa|ed25519|ecdsa)|\.(?:pem|key|p12|pfx)$/i;

function errorMessage(error){
 if(error?.code==='ENOENT')return 'missing';
 if(error?.code==='EACCES'||error?.code==='EPERM')return 'permission denied';
 return error?.code||'unavailable';
}
function isBlockedPart(name){return name.startsWith('.')||secretPart.test(name)||blockedDirectories.has(name.toLowerCase());}
function fileKind(path){
 const extension=extname(path).toLowerCase();
 if(textExtensions.has(extension))return 'text';
 if(documentExtensions.has(extension))return 'document';
 if(imageExtensions.has(extension))return 'image';
 if(audioExtensions.has(extension))return 'audio';
 if(videoExtensions.has(extension))return 'video';
 return null;
}
function inside(root,path){const rel=relative(root,path);return rel!==''&&rel!=='..'&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel);}

export class DeviceFiles {
 constructor({home=homedir()}={}){this.home=resolve(home);}
 rootPath(rootId){const entry=ROOTS.find(([id])=>id===rootId);if(!entry)throw Error('Unsupported file root');return join(this.home,entry[1]);}
 async roots(){return Promise.all(ROOTS.map(async([id,name])=>({id,name,available:await this.validRoot(join(this.home,name))})));}
 async validRoot(root){try{await this.validatePath(root,this.home);const stat=await fs.lstat(root);if(!stat.isDirectory())return false;await fs.access(root,constants.R_OK);return true;}catch{return false;}}
 async validatePath(path,limit){
  const absolute=resolve(path),base=resolve(limit);
  if(absolute!==base&&!absolute.startsWith(`${base}${sep}`))throw Error('Path is outside the selected root');
  if(await fs.realpath(this.home)!==this.home)throw Error('Symbolic links are not allowed');
  const baseStat=await fs.lstat(base);if(baseStat.isSymbolicLink())throw Error('Symbolic links are not allowed');
  const pieces=relative(base,absolute).split(sep).filter(Boolean);
  let current=base;
  for(const piece of pieces){if(isBlockedPart(piece))throw Error('Path is not allowed');current=join(current,piece);const stat=await fs.lstat(current);if(stat.isSymbolicLink())throw Error('Symbolic links are not allowed');}
 }
 async requireRoot(rootId){const root=this.rootPath(rootId);try{await this.validatePath(root,this.home);const stat=await fs.lstat(root);if(!stat.isDirectory())throw Error('not directory');await fs.access(root,constants.R_OK);return root;}catch(error){throw Error(`Selected root is unavailable: ${errorMessage(error)}`);}}
 async search({rootId,query}={}){
  if(typeof query!=='string'||!query.trim())throw Error('A nonblank search query is required');
  if(query.length>200)throw Error('Search query must be 200 characters or fewer');
  const root=await this.requireRoot(rootId),needle=query.trim().toLowerCase(),results=[],warnings=[];
  let scanned=0,truncated=false,exhausted=false;
  const warn=message=>{if(warnings.length<20)warnings.push(message);else if(warnings.length===20)warnings.push('Additional read warnings omitted');};
  const visit=async(dir,depth)=>{
   if(exhausted)return;
   let directory;try{directory=await fs.opendir(dir);}catch(error){warn(`Cannot read ${relative(root,dir)||'.'}: ${errorMessage(error)}`);return;}
   try{for await(const entry of directory){
    if(exhausted)break; scanned++;if(scanned>MAX_ENTRIES){truncated=true;exhausted=true;break;}
    const path=join(dir,entry.name);if(isBlockedPart(entry.name))continue;
    let stat;try{stat=await fs.lstat(path);}catch(error){warn(`Cannot inspect ${relative(root,path)}: ${errorMessage(error)}`);continue;}
    if(stat.isSymbolicLink())continue;
    if(stat.isDirectory()){if(depth<MAX_DEPTH)await visit(path,depth+1);else truncated=true;continue;}
    if(!stat.isFile()||(stat.mode&0o111)!==0)continue;
    const kind=fileKind(path);if(!kind||!entry.name.toLowerCase().includes(needle))continue;
    results.push({rootId,path:relative(root,path),name:entry.name,bytes:stat.size,modifiedAt:stat.mtime.toISOString(),kind,previewable:kind==='text'});
    if(results.length>=MAX_RESULTS){truncated=true;exhausted=true;}
   }}catch(error){warn(`Cannot read ${relative(root,dir)||'.'}: ${errorMessage(error)}`);}
  };
  await visit(root,0);
  const response={results,truncated,scanned};if(warnings.length)response.warnings=warnings;return response;
 }
 async preview({rootId,path}={}){
  if(typeof path!=='string'||!path||path.length>4096)throw Error('A file path is required');
  if(path.split(/[\\/]/).includes('..'))throw Error('Path is outside the selected root');
  const root=await this.requireRoot(rootId),absolute=resolve(root,path);
  if(!inside(root,absolute))throw Error('Path is outside the selected root');
  await this.validatePath(absolute,root);
  if(isBlockedPart(basename(absolute))||fileKind(absolute)!=='text')throw Error('This file cannot be previewed');
  let handle;try{handle=await fs.open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){throw Error(`Cannot open file: ${errorMessage(error)}`);}
  try{
   const stat=await handle.stat();if(!stat.isFile()||(stat.mode&0o111)!==0)throw Error('This path is not a previewable file');
   const buffer=Buffer.alloc(MAX_PREVIEW+1),{bytesRead}=await handle.read(buffer,0,buffer.length,0),slice=buffer.subarray(0,bytesRead);
   if(slice.includes(0))throw Error('Binary files cannot be previewed');
   const truncated=bytesRead>MAX_PREVIEW||stat.size>MAX_PREVIEW,decoder=new TextDecoder('utf-8',{fatal:true});let text;
   try{text=decoder.decode(slice.subarray(0,Math.min(bytesRead,MAX_PREVIEW)),{stream:truncated});if(!truncated)text+=decoder.decode();}catch{throw Error('Binary files cannot be previewed');}
   return {path:relative(root,absolute),text,truncated};
  }finally{await handle.close();}
 }
}
