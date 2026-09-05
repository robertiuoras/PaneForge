// Mount the real SessionInfo component; fake only IPC, never write to a user pane.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { connect, root } from './ui-lab.mjs'
const bundle = await build({ absWorkingDir: root, tsconfig: 'tsconfig.web.json',
  stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
    import Info from './src/renderer/src/components/SessionInfo';
    const host=document.createElement('div');host.id='pf-context-fixture';document.body.append(host);const view=createRoot(host);
    window.__pfInfo={mount(extra={}){flushSync(()=>view.render(<Info session={{id:'fixture',title:'Context test',agent:'codex',cwd:'/tmp/context-test',status:'idle',engaged:true,lastOutput:Date.now(),startedAt:Date.now(),...extra}} paneNumber={1} agents={[]} onRename={()=>{}} onClose={()=>{}} />))},close(){view.unmount();host.remove()}};
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"', 'window.api': 'window.__pfInfoApi' }, loader: { '.css': 'empty' }, logLevel: 'silent' })
const c = await connect(process.env.PF_PORT ?? '9334')
try {
  await c.evaluate(`window.__pfInfoCalls=[];window.__pfInfoApi={contextUsage:async()=>({used:600,window:1000,percent:60,model:'test-model',at:Date.now(),advisory:'prepare'}),continuationStatus:async()=>null,prepareContinuation:async()=>{window.__pfInfoCalls.push('prepare');return{ok:true,reason:'Preparation queued'}},continueFresh:async()=>{window.__pfInfoCalls.push('start');return{ok:true,id:'fresh',reason:'Delivery pending; source open'}}}`)
  await c.evaluate(bundle.outputFiles[0].text)
  await c.evaluate('window.__pfInfo.mount()')
  await new Promise(r => setTimeout(r, 100))
  const text = await c.evaluate('document.querySelector("#pf-context-fixture").textContent')
  assert.match(text, /60% used/); assert.match(text, /600 \/ 1,000 tokens/); assert.match(text, /test-model/)
  assert.match(text, /source asleep for recovery/)
  await c.evaluate(`document.querySelectorAll('#pf-context-fixture button').forEach(b=>{if(b.textContent==='Prepare handoff')b.click()})`)
  assert.deepEqual(await c.evaluate('window.__pfInfoCalls'), ['prepare'])
  await c.evaluate('window.__pfInfo.mount({drafting:true})')
  assert.equal(await c.evaluate(`Array.from(document.querySelectorAll('#pf-context-fixture button')).find(b=>b.textContent==='Open fresh chat').disabled`), true)
  await c.evaluate('window.__pfInfo.mount({runSince:Date.now()})')
  assert.equal(await c.evaluate(`Array.from(document.querySelectorAll('#pf-context-fixture button')).find(b=>b.textContent==='Prepare handoff').disabled`), true)
  console.log('context UI: real component measured telemetry, explicit action and busy/draft guards passed')
} finally { await c.evaluate('window.__pfInfo?.close();delete window.__pfInfo;delete window.__pfInfoApi;delete window.__pfInfoCalls');c.close() }
