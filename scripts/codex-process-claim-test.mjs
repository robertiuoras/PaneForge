// The original popup failed after an in-place prompt edit: the keystroke shadow was
// not the native prompt. Process handles may prove identity, but cwd/time may not.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const work=mkdtempSync(join(tmpdir(),'pf-codex-process-'))
const oldHome=process.env.CODEX_HOME
try {
  const home=join(work,'codex'), cwd=join(work,'repo')
  mkdirSync(join(home,'sessions'),{recursive:true}); mkdirSync(cwd)
  process.env.CODEX_HOME=home
  const SID='11111111-1111-1111-1111-111111111111'
  const OTHER='22222222-2222-2222-2222-222222222222'
  const SUB='33333333-3333-3333-3333-333333333333'
  const rollout=(id,extra={})=>{
    const file=join(home,'sessions',`rollout-${id}.jsonl`)
    writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id,session_id:id,cwd,timestamp:new Date().toISOString(),source:'cli',thread_source:'user',...extra}})+'\n'+
      JSON.stringify({timestamp:new Date().toISOString(),type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Please build this feature carefully'}]}})+'\n')
    return file
  }
  const main=rollout(SID), other=rollout(OTHER), sub=rollout(SUB,{source:{subagent:{thread_spawn:{}}},thread_source:'subagent'})
  const root='100 1 Wed Sep 30 16:08:20 2026 /usr/bin/node node /opt/homebrew/bin/codex'
  const native='101 100 Wed Sep 30 16:08:21 2026 /opt/vendor/codex /opt/vendor/codex'
  const child='102 101 Wed Sep 30 16:08:22 2026 /opt/vendor/codex /opt/vendor/codex exec synthetic'
  const baseTable=[root,native,child].join('\n')
  const open=(files=[main,sub],folder=cwd)=>`fcwd\nn${folder}\n`+files.map((f,i)=>`f${60+i}\nn${f}\n`).join('')
  const fixture=join(work,'io.cjs')
  writeFileSync(fixture,`exports.execFile=(cmd,args,options,done)=>{
    const p=global.__codexProbe; p.calls.push([cmd,args]);
    const values=cmd==='ps'?p.tables:p.handles;
    const text=values.length>1?values.shift():values[0];
    queueMicrotask(()=>{if(p.beforeRead)p.beforeRead(cmd);done(p.error?Error('unavailable'):null,text||'')})
  }`)
  const outfile=join(work,'transcripts.cjs')
  await build({entryPoints:[resolve('src/main/transcripts.ts')],bundle:true,platform:'node',format:'cjs',outfile,
    define:{'process.platform':'"darwin"'},plugins:[{name:'process-fixture',setup(build){build.onResolve({filter:/^node:child_process$/},()=>({path:fixture}))}}],logLevel:'silent'})
  const t=createRequire(import.meta.url)(outfile)
  let n=0
  const fresh=(patch={})=>{
    const pane=`fixture-${++n}`
    global.__codexProbe={tables:[baseTable],handles:[open()],calls:[],...patch}
    t.noteSession(pane,cwd,'codex')
    t.noteSubmittedPrompt(pane,'Please build this carefully feature')
    assert.equal(t.resumeIdFor(pane),undefined,'edited shadow alone cannot claim a same-cwd rollout')
    return pane
  }
  let pane=fresh()
  assert.equal(await t.claimCodexFromProcess(pane,100),true)
  assert.equal(t.resumeIdFor(pane),SID,'exact native ID, not the open subagent')
  assert.ok(t.codexPromptReceipt(pane,'Please build this feature carefully',Date.now()-10000),'exact prompt receipt follows the process claim')
  assert.equal(t.codexPromptReceipt(pane,'Please build this carefully feature',Date.now()-10000),null,'shadow is never accepted as the answer receipt')
  t.forgetSession(pane)
  pane=fresh({tables:[baseTable.replace('/opt/vendor/codex /opt/vendor/codex','/opt/vendor/co /opt/vendor/codex')]})
  assert.equal(await t.claimCodexFromProcess(pane,100),true,'macOS truncated comm agrees with full native executable')
  t.forgetSession(pane)
  const refusals=[
    ['no root process',{tables:[native]}],
    ['unrelated same-cwd CLI',{tables:[[root,native.replace('101 100','101 999')].join('\n')]}],
    ['two interactive descendants',{tables:[[root,native,native.replace('101 100','103 100')].join('\n')]}],
    ['headless child is not a pane',{tables:[[root,child.replace('102 101','102 100')].join('\n')]}],
    ['Node argv masquerading as Codex',{tables:[[root,native.replace('/opt/vendor/codex /opt/vendor/codex','node /opt/vendor/codex')].join('\n')]}],
    ['two main rollout handles',{handles:[open([main,other,sub])]}],
    ['subagents alone',{handles:[open([sub])]}],
    ['closed rollout despite same-cwd files',{handles:[open([])]}],
    ['wrong process cwd',{handles:[open([main],join(work,'other'))]}],
    ['PID reuse during validation',{tables:[baseTable,baseTable.replace('16:08:21','16:09:21')]}],
    ['parent changes during validation',{tables:[baseTable,baseTable.replace('101 100','101 999')]}],
    ['rollout closes during validation',{handles:[open(),open([])]}],
    ['new main thread makes final proof ambiguous',{handles:[open(),open([main,other])]}],
    ['IO unavailable',{error:true}]
  ]
  for(const [name,patch] of refusals){
    // Restore process ownership; the successful fixture was forgotten above.
    pane=fresh(patch)
    assert.equal(await t.claimCodexFromProcess(pane,100),false,name)
    assert.equal(t.resumeIdFor(pane),undefined,name+' cannot bind a stored file')
    t.forgetSession(pane)
  }
  for(const extra of [{cwd:join(work,'wrong')},{session_id:OTHER},{thread_source:'subagent'},{source:'exec'}]){
    rollout(SID,extra);pane=fresh()
    assert.equal(await t.claimCodexFromProcess(pane,100),false,'metadata rejects '+JSON.stringify(extra));t.forgetSession(pane)
  }
  rollout(SID)
  pane=fresh({beforeRead:(cmd)=>{if(cmd==='lsof')t.noteSession(pane,cwd,'codex')}})
  assert.equal(await t.claimCodexFromProcess(pane,100),false,'session replacement invalidates asynchronous proof');t.forgetSession(pane)
  pane=fresh();t.noteSession('peer',cwd,'codex',SID)
  assert.equal(await t.claimCodexFromProcess(pane,100),false,'another pane owns exact rollout');t.forgetSession('peer');t.forgetSession(pane)
  let handlesRead=0
  pane=fresh({beforeRead:(cmd)=>{if(cmd==='lsof' && ++handlesRead===2)queueMicrotask(()=>queueMicrotask(()=>t.noteSession('peer',cwd,'codex',SID)))}})
  assert.equal(await t.claimCodexFromProcess(pane,100),false,'peer claim between final handle read and commit cannot be stolen');t.forgetSession('peer');t.forgetSession(pane)
  console.log(`Codex process claim: exact native identity and prompt receipt; ${refusals.length+7} ancestry, metadata, ambiguity, stale-handle and replacement refusals passed`)
} finally {
  if(oldHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldHome
  delete global.__codexProbe;rmSync(work,{recursive:true,force:true})
}
