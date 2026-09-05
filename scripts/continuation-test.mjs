import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const work = mkdtempSync(join(tmpdir(), 'pf-cont-'))
const before = {HOME:process.env.HOME, PF_CLAUDE_HOME:process.env.PF_CLAUDE_HOME}
let checks = 0
const eq = (a,b,label) => { assert.deepEqual(a,b,label); checks++ }
try {
  const cwd = join(work,'repo'), id = 'p', now = Date.now()
  process.env.HOME = work
  process.env.PF_CLAUDE_HOME = join(work,'.claude')
  const dir = join(process.env.PF_CLAUDE_HOME,'projects',cwd.replace(/[^A-Za-z0-9]/g,'-'),'memory')
  mkdirSync(dir,{recursive:true})
  const handoff = join(dir,'session-handoff.pane-p.md')
  const metadata = {paneId:id,agent:'codex',resumeId:'r',cwd,createdAt:now}
  const doc = `<!-- paneforge-handoff ${JSON.stringify(metadata)} -->\n` +
    ['Objective','Constraints','Completed','Next steps','Verification','Running jobs'].map(h=>`# ${h}\nx\n`).join('')
  writeFileSync(handoff,doc)
  const out = join(work,'continuation.cjs')
  buildSync({absWorkingDir:process.cwd(),entryPoints:['src/main/continuation.ts'],bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'silent'})
  const {startContinuation} = createRequire(import.meta.url)(out)
  const source = {id,cwd,agent:'codex',model:'test-model',role:'reviewer',lane:'a',title:'Task',status:'idle',engaged:true,lastKeyboard:0}
  const spec = {scrollbackId:id,resumeId:'r',cwd,laneEnv:{LANE:'a'}}
  function fixture({sleep=true,throwStart=false}={}) {
    const calls = []
    let request
    return {
      calls, get request(){return request},
      session:key=>key===id?source:undefined, snapshot:()=>[spec],
      sleep:()=>{calls.push('sleep');return sleep?{...source,asleep:now}:null},
      wake:()=>{calls.push('wake');return source},
      start:req=>{calls.push('start');request=req;if(throwStart)throw Error('spawn failed');return {id:'new'}}
    }
  }
  let deps = fixture()
  eq(startContinuation(deps,id,now).id,'new','valid continuation starts')
  eq(deps.calls,['sleep','start'],'source saved before new writer')
  eq(deps.request,{cwd,title:source.title,agent:source.agent,model:source.model,role:source.role,lane:source.lane,laneEnv:spec.laneEnv,prompt:doc},'preserve selected provider and worktree; fresh request contains no resume id')
  deps = fixture({sleep:false})
  eq(startContinuation(deps,id,now).ok,false,'sleep refusal blocks continuation')
  eq(deps.calls,['sleep'],'no new writer after refusal')
  deps = fixture({throwStart:true})
  eq(startContinuation(deps,id,now).ok,false,'spawn failure reported')
  eq(deps.calls,['sleep','start','wake'],'source wake attempted after failed spawn')
  eq(existsSync(handoff),true,'recovery handoff retained')
  for (const change of [{status:'working'},{drafting:true},{runSince:now},{ask:{}},{backJob:{}},{lastKeyboard:now+1}]) {
    deps = fixture()
    eq(startContinuation({...deps,session:()=>({...source,...change})},id,now).ok,false,'unsafe source refused')
    eq(deps.calls,[],'unsafe source never slept or replaced')
  }
  eq(startContinuation(fixture(),'missing',now).ok,false,'missing source refused')
  eq(startContinuation({...fixture(),snapshot:()=>[{...spec,resumeId:'other'}]},id,now).ok,false,'wrong conversation handoff refused')
  eq(startContinuation(fixture(),id,now+21*60_000).ok,false,'stale handoff refused')
  eq(source.id,id,'source record retained')
  console.log(`continuation: ${checks} checks passed`)
} finally {
  for (const [key,value] of Object.entries(before)) value===undefined?delete process.env[key]:process.env[key]=value
  rmSync(work,{recursive:true,force:true})
}
