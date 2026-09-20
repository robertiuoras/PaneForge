import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
import {join,relative,isAbsolute,basename,extname} from 'node:path';
import {readFileSync,realpathSync,statSync} from 'node:fs';
const runFile=promisify(execFile);
const CLI=join(homedir(),'Projects/claude-memory/claude-config/vault-index/vaultindex.py');
const DB_URI=`file://${join(homedir(),'Projects/claude-memory/claude-config/vault-index/vault.db')}?mode=ro`;
const ROOTS={knowledge:join(homedir(),'Documents/Obsidian Vault'),'agent-memory':join(homedir(),'Projects/claude-memory')};
const INDEX_READ=`import json,sqlite3,sys
con=sqlite3.connect(sys.argv[1],uri=True); con.row_factory=sqlite3.Row
base="sensitivity IN ('public','internal') AND (project=? OR project IS NULL) AND (status IN ('reviewed','verified') OR status IS NULL) AND COALESCE(agent_use,'') <> 'exclude'"
columns="vault,path,abspath,title,type,project,status,sensitivity,updated,links,conflict,superseded_by,agent_use"
if sys.argv[3]=='one': rows=con.execute(f"SELECT {columns} FROM notes WHERE {base} AND vault=? AND path=?",(sys.argv[2],sys.argv[4],sys.argv[5])).fetchall()
else: rows=con.execute(f"SELECT {columns} FROM notes WHERE {base} ORDER BY vault,path LIMIT ? OFFSET ?",(sys.argv[2],int(sys.argv[4]),int(sys.argv[5]))).fetchall()
print(json.dumps([dict(row) for row in rows]))`;
export const brainScopes=[{id:'paneforge',label:'PaneForge'},{id:'assistant',label:'Personal assistant'},{id:'taskdriver',label:'Taskdriver'},{id:'toolstash',label:'Toolstash'}];

// Reuses the existing vault index and its maintenance policy. No models, network,
// embeddings, new database or scheduler. Only internal/public project-scoped notes.
export class Brain {
  previews=new Map(); busy=false;
  constructor(run=runFile,roots=ROOTS){this.run=run;this.roots=roots;}
  async search(q,scope){
    if(!brainScopes.some(s=>s.id===scope))throw Error('Choose a supported workspace scope');
    if(typeof q!=='string'||!q.trim()||q.length>300||q.includes('\0'))throw Error('Enter a search of 1–300 characters');
    if(this.busy)throw Error('Second brain is searching. Try again after the current search finishes.');
    this.busy=true;const started=performance.now();
    try{
      const {stdout}=await this.run('python3',[CLI,'context',q.trim(),'--project',scope,'--sensitivity-max','internal','--limit','4','--budget-chars','4000','--json'],{timeout:6000,maxBuffer:160000,encoding:'utf8'});
      const pkg=JSON.parse(stdout);
      if(!Array.isArray(pkg.notes)||pkg.index?.restricted!==0)throw Error('Invalid retrieval response');
      const warnings=[];
      if(pkg.index?.stale_index)warnings.push('The existing index is stale; check source dates before relying on results.');
      if((pkg.index?.unavailable_sources?.length||pkg.index?.unavailable_vaults?.length))warnings.push('Some sources were unavailable; results may come from the retained index.');
      const results=pkg.notes.slice(0,4).map(note=>{
        // Defence in depth around the installed CLI's own project/trust filters.
        if(!['public','internal'].includes(note.sensitivity)||(note.project!=null&&note.project!==scope)||!['reviewed','verified',null,undefined].includes(note.status)||note.history||note.superseded_by)throw Error('Retrieval scope validation failed');
        const path=`${note.vault}:${note.path}`;
        if(!pkg.cite?.includes(path)||!['knowledge','agent-memory'].includes(note.vault)||typeof note.path!=='string'||note.path.split('/').includes('..'))throw Error('Unverified retrieval source');
        const snippet=String(note.excerpt||note.snippet||'').slice(0,1400);
        const sourceUrl=`/api/brain/source?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(path)}`;
        const result={path,title:String(note.title||note.path),snippet,line:null,sourceUrl,trust:note.trust||'unknown',status:note.status||'unknown',stale:Boolean(note.stale),conflict:Boolean(note.conflict),updated:note.updated||null};
        // Bounded ephemeral source previews, not another memory/index store. Never
        // read an arbitrary path from a browser. Restart/eviction asks for re-search.
        this.previews.set(`${scope}:${path}`,{path,text:snippet,truncated:Boolean(note.excerpt_truncated)||String(note.excerpt||'').length>1400,sourceUrl});
        while(this.previews.size>48)this.previews.delete(this.previews.keys().next().value);
        return result;
      });
      return {results,elapsedMs:Math.round(performance.now()-started),modelTokens:0,scope,warning:warnings.join(' '),retrievedAt:pkg.retrieved_at,indexUpdatedAt:pkg.index?.built_at,contextCharacters:results.reduce((n,r)=>n+r.snippet.length,0)};
    }catch(error){if(error.message?.startsWith('Retrieval')||error.message?.startsWith('Unverified'))throw error;throw Error('Local second-brain search is unavailable or exceeded six seconds. Existing notes are unchanged.');}
    finally{this.busy=false;}
  }
  source(scope,path){
    if(!brainScopes.some(s=>s.id===scope)||typeof path!=='string'||path.length>600)throw Error('Invalid source scope');
    const preview=this.previews.get(`${scope}:${path}`);
    if(!preview)throw Error('Source preview expired. Search again to retrieve a scoped excerpt.');
    return preview;
  }
  #history(path){const lower=path.toLowerCase(),name=basename(lower);return lower.includes('/handoffs/')||name.includes('session-handoff')||['handoff.md','handoff-latest.md'].includes(name)||name.startsWith('handoff_')||/^handoff-\d{4}-\d{2}-\d{2}(?:[-_.]|$)/.test(name)||name.endsWith('.prev.md')||name.endsWith('.raw.md');}
  #visible(note,scope){return ['knowledge','agent-memory'].includes(note.vault)&&typeof note.path==='string'&&!note.path.split('/').includes('..')&&['public','internal'].includes(note.sensitivity)&&(note.project==null||note.project===scope)&&['reviewed','verified',null,undefined].includes(note.status)&&!note.superseded_by&&!this.#history(note.path)&&note.agent_use!=='exclude';}
  async #indexed(scope,limit=400){
    if(!brainScopes.some(s=>s.id===scope))throw Error('Choose a supported workspace scope');
    // History is encoded by the existing index as paths, rather than a column. Page
    // through a bounded prefix so an early handoff cluster cannot hide later notes.
    const pageSize=limit+1,maxPages=4,visible=[];
    for(let page=0;page<maxPages&&visible.length<=limit;page++){
      const {stdout}=await this.run('python3',['-c',INDEX_READ,DB_URI,scope,'list',String(pageSize),String(page*pageSize)],{timeout:3000,maxBuffer:160000,encoding:'utf8'});
      const rows=JSON.parse(stdout);if(!Array.isArray(rows))throw Error('Invalid retrieval index response');
      visible.push(...rows.filter(note=>this.#visible(note,scope)));
      if(visible.length>limit)return {rows:visible,truncated:true};
      if(rows.length<pageSize)return {rows:visible,truncated:false};
    }
    // At the scan cap we cannot truthfully assert that no further eligible notes
    // exist, so surface a bounded graph rather than incorrectly marking it complete.
    return {rows:visible,truncated:true};
  }
  async #exact(scope,path){
    if(typeof path!=='string'||path.length>600||path.includes('\\'))throw Error('Invalid source path');
    const cut=path.indexOf(':');if(cut<1||cut!==path.lastIndexOf(':'))throw Error('Invalid source path');
    const vault=path.slice(0,cut),relativePath=path.slice(cut+1);if(!ROOTS[vault]||!relativePath||relativePath.split('/').includes('..'))throw Error('Invalid source path');
    const {stdout}=await this.run('python3',['-c',INDEX_READ,DB_URI,scope,'one',vault,relativePath],{timeout:3000,maxBuffer:160000,encoding:'utf8'});
    const rows=JSON.parse(stdout);if(!Array.isArray(rows)||rows.length!==1||!this.#visible(rows[0],scope))throw Error('Source is outside the current workspace scope');return rows[0];
  }
  async graph(scope){
    const indexed=await this.#indexed(scope),rows=indexed.rows,truncated=indexed.truncated||rows.length>400,notes=rows.slice(0,400);
    const nodes=notes.map(note=>({id:`${note.vault}:${note.path}`,path:`${note.vault}:${note.path}`,title:String(note.title||note.path),type:note.type||'note',status:note.status||'unknown',trust:['reviewed','verified'].includes(note.status)?'reviewed':'unknown',stale:null}));
    const byLink=new Map(),add=(key,id)=>{key=key.toLowerCase();byLink.set(key,byLink.has(key)?null:id);};for(const node of nodes){const rel=node.path.split(':').at(-1),short=basename(rel).replace(extname(rel),'');add(short,node.id);add(rel.replace(extname(rel),''),node.id);}
    const edges=[];for(const note of notes){for(const link of String(note.links||'').split(',').filter(Boolean)){const target=byLink.get(link.trim().replace(extname(link.trim()),'').toLowerCase());if(target&&target!==`${note.vault}:${note.path}`&&edges.length<500)edges.push({source:`${note.vault}:${note.path}`,target});}}
    return {scope,nodes,edges,truncated};
  }
  async file(scope,path){
    const note=await this.#exact(scope,path);
    let root,file;try{root=realpathSync(this.roots[note.vault]);file=realpathSync(note.abspath);}catch{throw Error('Source is unavailable on this machine');}
    const rel=relative(root,file);if(!rel||rel.startsWith('..')||isAbsolute(rel)||!file.endsWith('.md'))throw Error('Source is outside the indexed vault');
    if(realpathSync(join(root,note.path))!==file)throw Error('Source does not match its indexed path');
    const size=statSync(file).size;if(size>120000)throw Error('Source exceeds the 120 KB reader limit');
    const text=readFileSync(file,'utf8');return {scope,path,title:String(note.title||note.path),text,truncated:false,sourceRef:path};
  }
}
