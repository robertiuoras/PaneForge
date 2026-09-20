import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';

const fixtureMcp=(projectId='paneforge-next',cwd=process.cwd())=>({command:process.execPath,args:[resolve('server/fixture-mcp.mjs')],env:{PANEFORGE_PROJECT_ID:projectId,PANEFORGE_PROJECT_CWD:cwd,PANEFORGE_DATA_DIR:resolve(process.env.PANEFORGE_DATA_DIR||'.local-runtime/app')}});
// The installed App Server accepts thread config overrides. Its startup MCP
// remains deliberately default-scoped for the capability preflight; every
// actual conversation supplies this immutable project environment.
export const scopedCodexConfig=(projectId,cwd=process.cwd(),{model='gpt-6-astra',effort='high'}={})=>{
  if(typeof projectId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(projectId))throw Error('MCP project scope is invalid.');
  if(typeof cwd!=='string'||!cwd||cwd.length>1000)throw Error('MCP lane scope is invalid.');
  if(typeof model!=='string'||typeof effort!=='string')throw Error('Codex route is invalid.');
  return {model,model_reasoning_effort:effort,web_search:'live',mcp_servers:{paneforge_fixture:fixtureMcp(projectId,cwd)}};
};

const REQUIRED_DISABLED_FEATURES=['shell_tool','unified_exec','apps','plugins','browser_use','computer_use'];
const namesOf=tools=>Array.isArray(tools)?tools.map(tool=>typeof tool==='string'?tool:tool?.name).filter(Boolean):Object.keys(tools||{});

// This is deliberately a startup gate, not a prompt convention. code_mode_host
// remains enabled only because the App Server hosts this read-only MCP server;
// it does not grant shell, browser, computer, or write access.
export function verifyEffectiveCapabilities(configResult,statusResult){
  const config=configResult?.config||configResult||{};
  if(config.web_search!=='live')throw Error('Live web search is unavailable.');
  const features=config.features||{};
  const enabledFeatures=REQUIRED_DISABLED_FEATURES.filter(name=>features[name]!==false);
  if(enabledFeatures.length)throw Error(`Restricted Codex features are enabled: ${enabledFeatures.join(', ')}`);
  if(features.code_mode_host!==true)throw Error('The restricted fixture host is unavailable.');

  const servers=config.mcp_servers||config.mcpServers||{};
  const enabled=Object.entries(servers).filter(([,server])=>server?.enabled!==false).map(([name])=>name);
  if(enabled.length!==1||enabled[0]!=='paneforge_fixture')throw Error(`Unexpected enabled MCP servers: ${enabled.join(', ')||'none'}`);

  const statuses=statusResult?.data||statusResult?.servers||[];
  const fixture=statuses.find(server=>(server.name||server.serverName)==='paneforge_fixture');
  if(!fixture)throw Error('PaneForge fixture MCP status is unavailable.');
  const toolNames=namesOf(fixture.tools).sort();
  const expected=['list_project_files','read_fixture','read_project_file','search_conversation_history','search_second_brain'];
  if(JSON.stringify(toolNames)!==JSON.stringify(expected))throw Error(`PaneForge read-only MCP exposed an unexpected tool set: ${toolNames.join(', ')||'none'} (runtime: ${fixture.runtimeStatus||'unknown'}; tools error: ${fixture.toolsError||'none'}).`);
  const exposedElsewhere=statuses.filter(server=>(server.name||server.serverName)!=='paneforge_fixture')
    .flatMap(server=>namesOf(server.tools));
  if(exposedElsewhere.length)throw Error(`Unexpected inherited MCP tools: ${[...new Set(exposedElsewhere)].join(', ')}`);
  return {mcpServers:['paneforge_fixture'],tools:expected};
}

// Native Codex owns its credentials and rollouts. This bridge never reads tokens.
export class Codex extends EventEmitter {
  pending = new Map(); nextId = 1; child = null;
  async start() {
    const config = {
      model_provider:'openai', forced_login_method:'chatgpt',
      'features.shell_tool':false, 'features.unified_exec':false, 'features.apps':false,
      'features.plugins':false, 'features.browser_use':false, 'features.computer_use':false,
      'features.multi_agent':false, 'features.code_mode':false, 'features.code_mode_host':true,
      'features.memories':false, web_search:'live',
      mcp_servers:{paneforge_fixture:fixtureMcp()}
    };
    const args = ['app-server','--stdio'];
    for(const [key,value] of Object.entries(config)) {
      // TOML inline table is supplied separately below.
      if(key !== 'mcp_servers') args.push('-c',`${key}=${JSON.stringify(value)}`);
    }
    args.push('-c',`mcp_servers={paneforge_fixture={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(resolve('server/fixture-mcp.mjs'))}]}}`);
    for (const name of ['node_repl','openaiDeveloperDocs','computer-use','raylight','upwork']) args.push('-c', `mcp_servers.${name}.enabled=false`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k])=>!/(API_KEY|ACCESS_TOKEN|SECRET)/i.test(k)));
    this.child=spawn(process.env.PANEFORGE_CODEX || 'codex',args,{env,stdio:['pipe','pipe','pipe']});
    createInterface({input:this.child.stdout}).on('line',line=>{
      let msg;try{msg=JSON.parse(line);}catch{return;}
      if(msg.id!==undefined&&!msg.method){const waiter=this.pending.get(msg.id);if(waiter){this.pending.delete(msg.id);clearTimeout(waiter.timer);msg.error?waiter.reject(Error(msg.error.message)):waiter.resolve(msg.result);}}
      else this.emit(msg.id!==undefined?'request':'notification',msg);
    });
    // Do not persist provider stderr: inherited tools may emit private configuration.
    this.child.stderr.resume();
    this.child.on('error',e=>this.fail(e));
    this.child.on('exit',()=>this.fail(Error('Codex executor stopped; resume is required.')));
    await this.rpc('initialize',{clientInfo:{name:'paneforge_next',version:'0.1.0'},capabilities:{experimentalApi:true}});
    this.send({method:'initialized'});
    const {account}=await this.rpc('account/read',{refreshToken:false});
    if(account?.type!=='chatgpt'){this.close();throw Error('ChatGPT subscription authentication required. Paid API fallback is disabled.');}
    const models=await this.rpc('model/list',{});
    const rateLimits=await this.rpc('account/rateLimits/read',{});
    try{
      const configResult=await this.rpc('config/read',{cwd:process.cwd()});
      const mcpStatus=await this.rpc('mcpServerStatus/list',{detail:'full'});
      const capability=verifyEffectiveCapabilities(configResult,mcpStatus);
      this.preflight={models,rateLimits};
      return {status:'ready',authType:account.type,plan:account.planType,models,rateLimits,...capability};
    }catch(error){this.close();throw error;}
  }
  async refreshPreflight(){ if(!this.child) throw Error('Provider is disconnected'); const [models,rateLimits]=await Promise.all([this.rpc('model/list',{}),this.rpc('account/rateLimits/read',{})]); this.preflight={models,rateLimits}; return this.preflight; }
  send(value){if(!this.child?.stdin.writable)throw Error('Provider is disconnected');this.child.stdin.write(JSON.stringify(value)+'\n');}
  rpc(method,params){const id=this.nextId++;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error(`${method} timed out; reconcile before retrying.`));},45000);this.pending.set(id,{resolve,reject,timer});try{this.send({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});}
  fail(error){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.emit('disconnected',error);}
  close(){this.child?.kill();}
}
