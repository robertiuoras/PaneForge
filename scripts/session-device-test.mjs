// Real React picker, real dev-profile preferences, no agent or terminal launches.
import { build } from 'esbuild'
import { strict as assert } from 'node:assert'
import { connect, root } from './ui-lab.mjs'

const bundle = await build({
  absWorkingDir: root,
  tsconfig: 'tsconfig.web.json',
  stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import Picker from './src/renderer/src/components/NewSessionDialog';
    const host=document.createElement('div');host.id='pf-device-fixture';document.body.append(host);
    let view=createRoot(host), launch=[], outcome='remote';
    window.__pfDeviceFixture={
      async open(peers=true, scope='') {
        flushSync(()=>view.render(null));
        const config=await window.__pfDeviceApi.getConfig();
        const agents=await window.__pfDeviceApi.listAgents();
        const projects=scope==='empty' ? [] : scope ? (await window.__pfDeviceApi.listSessionFolders()).filter(p=>p.scope===scope)
          : [{name:'Device preference test',path:'/tmp/pf-device-choice'}];
        flushSync(()=>view.render(<Picker defaultWhere={config.defaultSessionWhere ?? 'local'}
          projects={projects}
          defaultAgent='shell' defaultModels={{}} agents={agents}
          peers={peers?[{id:'test-peer',name:'Test PC'}]:[]}
          onStart={async r=>{launch=r;return outcome}} onCancel={()=>{}} onDefaultsChange={()=>{}}
          onProjectsChanged={()=>{}} onSaveWorkspace={()=>{}} />));
      },
      launch:()=>launch, outcome:value=>{outcome=value},
      close:()=>{flushSync(()=>view.unmount());host.remove();}
    };
  ` },
  bundle: true, write: false, format: 'iife', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"', 'window.api': 'window.__pfDeviceApi' },
  loader: { '.css': 'empty' }, logLevel: 'silent'
})
const c=await connect(process.env.PF_PORT ?? '9334')
let original, checks=0
const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++}
try {
  original=await c.evaluate('window.api.getConfig().then(c=>c.defaultSessionWhere ?? "local")')
  await c.evaluate('window.__pfDeviceApi=window.api; window.api.setConfig({defaultSessionWhere:"local"})')
  await c.evaluate(bundle.outputFiles[0].text)
  await c.evaluate('window.__pfDeviceFixture.open()')
  const picks=()=>c.evaluate('[...document.querySelectorAll("#pf-device-fixture .where-picks button")].map(b=>({text:b.textContent.trim(),selected:b.getAttribute("aria-pressed")}))')
  eq((await picks()).map(p=>p.text),['This device','Test PC','Automatic'],'device order')
  eq((await picks())[0].selected,'true','local default selected')
  const go=(name='Device preference test')=>c.evaluate(`[...document.querySelectorAll('#pf-device-fixture .proj')].find(p=>p.querySelector('.proj-name')?.textContent===${JSON.stringify(name)}).click()`)
  // An untouched "This device" still STARTS here - the app never picks the PC at start
  // while this laptop is selected - but carries no pin, so a mid-session move stays open.
  await go()
  eq(await c.evaluate('window.__pfDeviceFixture.launch().map(r=>[r.where ?? null, r.stayHere ?? null])'),[['local',null]],'untouched local default starts here without pinning')
  eq(await c.evaluate('window.api.getConfig().then(c=>c.defaultSessionWhere)'),'local','untouched launch saves nothing')
  await c.evaluate('window.__pfDeviceFixture.open()')
  await c.evaluate('document.querySelectorAll("#pf-device-fixture .where-picks button")[1].click()')
  eq(await c.evaluate('window.api.getConfig().then(c=>c.defaultSessionWhere)'),'local','selection alone does not change preference')
  const saved=async(value)=>{for(let i=0;i<30;i++){if(await c.evaluate('window.api.getConfig().then(c=>c.defaultSessionWhere)')===value)return;await new Promise(r=>setTimeout(r,40))}throw Error('preference did not save')}
  await go()
  await saved('remote')
  await c.evaluate('window.__pfDeviceFixture.open()')
  eq((await picks())[1].selected,'true','successful remote launch selection survives remount')
  await c.evaluate('window.__pfDeviceFixture.open(false)')
  eq((await picks()).length,1,'offline peer has one available destination')
  eq((await picks())[0].selected,'true','offline remote selects local for current launch')
  eq(await c.evaluate('window.api.getConfig().then(c=>c.defaultSessionWhere)'),'remote','offline display preserves saved preference')
  // Only an explicit destination choice is saved; an offline fallback is temporary.
  await c.evaluate('document.querySelector("#pf-device-fixture .where-picks button").click()')
  await c.evaluate('window.__pfDeviceFixture.outcome("local")')
  await go()
  await saved('local')
  eq(await c.evaluate('window.__pfDeviceFixture.launch().map(r=>r.where)'),['local'],'offline launch explicitly stays local')
  await c.evaluate('window.__pfDeviceFixture.open()')
  eq((await picks())[0].selected,'true','successful local launch survives remount')
  await c.evaluate('document.querySelectorAll("#pf-device-fixture .where-picks button")[1].click(); window.__pfDeviceFixture.outcome(null)')
  await go()
  eq(await c.evaluate('window.api.getConfig().then(c=>c.defaultSessionWhere)'),'local','failed launch does not replace last successful choice')
  for (const scope of ['projects', 'computer']) {
    await c.evaluate(`window.api.setConfig({defaultSessionWhere:'remote'}); window.__pfDeviceFixture.outcome('local')`)
    await c.evaluate(`window.__pfDeviceFixture.open(true,${JSON.stringify(scope)})`)
    eq(await c.evaluate('document.querySelectorAll("#pf-device-fixture .proj").length'),2,`${scope} shortcuts appear in the real picker`)
    await c.evaluate('document.querySelectorAll("#pf-device-fixture .where-picks button")[1].click()')
    await go(scope === 'projects' ? 'All projects' : 'This computer')
    const request=await c.evaluate('window.__pfDeviceFixture.launch()[0]')
    const folder=await c.evaluate(`window.api.listSessionFolders().then(rows=>rows.find(p=>p.scope===${JSON.stringify(scope)}))`)
    eq(request.cwd,folder.path,`${scope} launch uses the actual starting folder`)
    eq(request.title,folder.name,`${scope} launch keeps its descriptive title`)
    eq([request.where,request.stayHere],['local',true],`${scope} cannot be offloaded to another computer`)
    eq(await c.evaluate('window.api.getConfig().then(c=>c.defaultSessionWhere)'),'remote',`${scope} does not overwrite the ordinary-project destination preference`)
  }
  await c.evaluate('window.__pfDeviceFixture.open(true,"empty")')
  eq(await c.evaluate('Boolean(document.querySelector("#pf-device-fixture .first-run button"))'),true,'shortcuts preserve Choose projects folder recovery when no projects exist')
  console.log(`session-device: ${checks} checks passed`)
} finally {
  await c.evaluate(`window.__pfDeviceFixture?.close(); delete window.__pfDeviceFixture; delete window.__pfDeviceApi; window.api.setConfig({defaultSessionWhere:${JSON.stringify(original ?? 'local')}})`)
  c.close()
}
