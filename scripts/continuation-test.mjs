import assert from 'node:assert/strict'
import { buildSync, transformSync } from 'esbuild'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
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

  // Exercise the shipped IPC handler itself, not a copied path expression. The custom
  // directory deliberately has no `.claude` basename: it catches a handler and verifier
  // that agree only on the usual default path.
  const handoffOut = join(work, 'handoff-reader.cjs')
  buildSync({absWorkingDir:process.cwd(),entryPoints:['src/main/handoffSteps.ts'],bundle:true,platform:'node',format:'cjs',outfile:handoffOut,logLevel:'silent'})
  const {verifiedPaneHandoff, clearHandoffCache} = createRequire(import.meta.url)(handoffOut)
  const index = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
  const begin = index.indexOf("ipcMain.handle('sessions:prepareContinuation'")
  const end = index.indexOf("ipcMain.handle('sessions:continueFresh'", begin)
  assert.ok(begin >= 0 && end > begin, 'prepare continuation handler is present')
  const handlerCode = transformSync(
    `const preparingContinuations = new Map();\n${index.slice(begin, end)}`,
    { loader: 'ts', format: 'cjs', target: 'node20' }
  ).code
  const prepare = () => {
    const handlers = new Map(), prompts = []
    const pane = {...source, id: 'prepare-pane'}
    const ipcMain = {handle: (name, fn) => handlers.set(name, fn)}
    new Function('ipcMain', 'manager', 'resumeIdFor', 'verifiedPaneHandoff', 'handoffCandidates', 'join', 'homedir', 'backJobOf', 'process', handlerCode)(
      ipcMain,
      {list: () => [pane], sendPrompt: (key, text) => prompts.push({key, text})},
      (key) => key === pane.id ? 'prepare-resume' : null,
      verifiedPaneHandoff,
      createRequire(import.meta.url)(join(work, 'shared-handoff.cjs')).handoffCandidates,
      join, homedir, () => null, process
    )
    const result = handlers.get('sessions:prepareContinuation')(null, pane.id)
    return {pane, prompts, result}
  }
  const sharedOut = join(work, 'shared-handoff.cjs')
  buildSync({absWorkingDir:process.cwd(),entryPoints:['src/shared/handoffSteps.ts'],bundle:true,platform:'node',format:'cjs',outfile:sharedOut,logLevel:'silent'})
  const {handoffCandidates} = createRequire(import.meta.url)(sharedOut)
  const pathInPrompt = (text) => /^Prepare a concise handoff for this exact current task in (.+)\. Keep this conversation/m.exec(text)?.[1]
  process.env.PF_CLAUDE_HOME = join(work, 'custom-claude-state')
  let prepared = prepare()
  const customPath = pathInPrompt(prepared.prompts[0]?.text)
  eq(prepared.result.ok, true, 'actual prepare handler accepts a safe pane')
  eq(prepared.prompts[0]?.key, prepared.pane.id, 'actual prepare handler prompts the selected pane')
  eq(customPath, handoffCandidates(prepared.pane.cwd, prepared.pane.id, process.env.PF_CLAUDE_HOME, () => false)[0], 'custom Claude state path is generated by the actual handler')
  mkdirSync(join(customPath, '..'), {recursive:true})
  const customMeta = {paneId:prepared.pane.id,agent:prepared.pane.agent,resumeId:'prepare-resume',cwd:prepared.pane.cwd,createdAt:now}
  writeFileSync(customPath, `<!-- paneforge-handoff ${JSON.stringify(customMeta)} -->\n` +
    ['Objective','Constraints','Completed','Next steps','Verification','Running jobs'].map(h=>`# ${h}\nx\n`).join(''))
  clearHandoffCache()
  eq(verifiedPaneHandoff(prepared.pane.cwd, prepared.pane.id, prepared.pane.agent, 'prepare-resume', now)?.path, customPath, 'verifier reads the exact custom-state file prepare requested')
  delete process.env.PF_CLAUDE_HOME
  prepared = prepare()
  eq(pathInPrompt(prepared.prompts[0]?.text), handoffCandidates(prepared.pane.cwd, prepared.pane.id, join(homedir(), '.claude'), () => false)[0], 'actual prepare handler falls back to the default Claude home')
  console.log(`continuation: ${checks} checks passed`)
} finally {
  for (const [key,value] of Object.entries(before)) value===undefined?delete process.env[key]:process.env[key]=value
  rmSync(work,{recursive:true,force:true})
}
