// Runtime layout and interaction checks in this checkout's explicitly started dev app.
// Component fixtures exercise bounded API results, without changing production data.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { connect } from './ui-lab.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const c = await connect(process.env.PF_PORT ?? '9347')
const originalSideWidth = await c.evaluate(`document.documentElement.style.getPropertyValue('--side-w')`)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const click = selector => c.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}); el?.focus(); el?.click()})()`)
let checks = 0
let ownedPane, ownedFolder
const check = (condition, message) => { assert.ok(condition, message); checks++ }
const fixture = await build({
  stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
import Users from './src/renderer/src/components/UsersDialog';
import Activity from './src/renderer/src/components/ActivityFlyout';
let root, host;
globalThis.__popupFixture = (kind) => {
  root?.unmount(); host?.remove();
  if (!kind) return;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const close = () => globalThis.__popupFixture(null);
  globalThis.__popupTestApi = { ownerStats: async () => ({ login:'fixture', fetchedAt:Date.now(), releases:Array.from({length:100},(_,i)=>({version:'test-'+i,publishedAt:'2026-09-01',windows:i,mac:i})) }) };
  root.render(kind === 'users' ? React.createElement(Users,{remote:null,onClose:close}) : React.createElement(Activity,{anchor:{left:210,bottom:410},onClose:close,items:Array.from({length:60},(_,i)=>({id:String(i),at:Date.now()-i*60000,kind:i%2?'named':'refused',what:'Test session '+i,why:i%2?'Automatic name':'A command needed approval'}))}));
};`, resolveDir: process.cwd(), loader: 'tsx' },
  bundle: true, jsx: 'automatic', write: false, format: 'iife', platform: 'browser', alias: { '@shared': `${process.cwd()}/src/shared` }, define: { 'window.api': 'globalThis.__popupTestApi', 'process.env.NODE_ENV': '"production"' }
})
try {
  for (let attempt=0; attempt<30 && !await c.evaluate(`!!document.querySelector('.users-button svg')`); attempt++) await pause(100)
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })
  await c.evaluate(`document.querySelectorAll('.overlay button').forEach(b=>{if(b.textContent.trim()==='Close')b.click()})`)
  if (!(await c.panes()).length) {
    ownedFolder = mkdtempSync(join(tmpdir(), 'pf-popup-check-'))
    ownedPane = await c.openPane({cwd:ownedFolder,agent:'shell'})
    await pause(500)
  }
  for (const width of [220, 300]) {
    await c.evaluate(`document.documentElement.style.setProperty('--side-w','${width}px')`)
    const sizes = await c.evaluate(`Array.from(document.querySelectorAll('.quick .quick-btn'),e=>{const r=e.getBoundingClientRect();return {w:r.width,h:r.height,y:r.y,label:e.getAttribute('aria-label')}})`)
    check(sizes.length >= 4, 'quick actions exist')
    check(sizes.every(s => Math.abs(s.w-sizes[0].w)<1 && s.h===sizes[0].h && s.y===sizes[0].y), `equal pills at sidebar width ${width}`)
    check(sizes.every(s => s.label), 'every icon has an accessible name')
  }
  check(await c.evaluate(`!document.querySelector('.keep-open-toggle .badge')`), 'keep-open has no unexplained count')
  check(await c.evaluate(`!!document.querySelector('.users-button svg') && !document.querySelector('.users-button').textContent.trim()`), 'Users is an icon')
  await click('[aria-label="Tools"]'); await pause(100)
  check(await c.evaluate(`document.querySelector('#tools-title')?.textContent==='Tools'`), 'Tools opens')
  await c.evaluate(`Array.from(document.querySelectorAll('.tool-action')).find(b=>b.textContent.includes('Needs attention')).click()`)
  await pause(80)
  check(await c.evaluate(`document.querySelector('#tools-title')?.textContent==='Needs attention'`), 'attention view opens')
  await click('[aria-label="Close tools"]'); await pause(80)
  check(await c.evaluate(`document.activeElement?.getAttribute('aria-label')==='Tools' || document.activeElement?.classList.contains('xterm-helper-textarea')`), 'Tools restores usable focus')
  await click('[aria-label="Tools"]'); await pause(150)
  await c.evaluate(`(()=>{const b=[...document.querySelectorAll('.tool-action')].find(b=>b.textContent.includes('Project board'));b.focus();b.click()})()`)
  await pause(300)
  check(await c.evaluate(`!!document.querySelector('[aria-label="Close board"]')`), 'Tools opens project board')
  await c.evaluate(`document.querySelector('.pf-board-dialog textarea.memory').focus()`)
  await c.send('Input.insertText', {text:'Disposable unsaved keyboard check'}); await pause(100)
  await click('[aria-label="Close board"]'); await pause(100)
  check(await c.evaluate(`document.querySelector('[role="alertdialog"]')?.contains(document.activeElement)`), 'discard confirmation owns keyboard focus')
  await c.send('Input.dispatchKeyEvent', {type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,modifiers:8})
  check(await c.evaluate(`document.activeElement?.textContent==='Discard and close'`), 'discard confirmation traps reverse Tab')
  await c.send('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27}); await pause(100)
  check(await c.evaluate(`!document.querySelector('[role="alertdialog"]') && !!document.querySelector('.pf-board-dialog')`), 'Escape keeps unsaved board edits open')
  await click('[aria-label="Close board"]'); await pause(100)
  await click('[role="alertdialog"] .primary'); await pause(100)
  check(await c.evaluate(`!document.querySelector('.pf-board-dialog')`), 'discard closes without saving')
  for (const [label, closeLabel] of [['History','Close history'],['Devices','Close devices'],['Issues','Close Issues']]) {
    await click(`[aria-label="${label}"]`); await pause(150)
    check(await c.evaluate(`!!document.querySelector('[aria-label="${closeLabel}"]')`), `${label} exposes a header close button`)
    await click(`[aria-label="${closeLabel}"]`)
  }
  await c.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 500, deviceScaleFactor: 1, mobile: false })
  await c.evaluate(fixture.outputFiles[0].text)
  await c.evaluate(`globalThis.__popupFixture('users')`); await pause(150)
  const before = await c.evaluate(`(()=>{const b=document.querySelector('.users-body'),r=b.getBoundingClientRect();return {rows:b.querySelectorAll('tbody tr').length,scroll:b.scrollHeight,h:b.clientHeight,x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  check(before.rows===100, 'all 100 fetched release rows are rendered')
  check(before.scroll>before.h, 'Users body has a real scroll range')
  await c.send('Input.dispatchMouseEvent', { type:'mouseWheel', x:before.x, y:before.y, deltaX:0, deltaY:20000 })
  await pause(300)
  const users = await c.evaluate(`(()=>{const d=document.querySelector('.users-dialog'),b=d.querySelector('.users-body');return {top:b.scrollTop,max:b.scrollHeight-b.clientHeight,header:d.querySelector('.dialog-head').getBoundingClientRect().top,bottom:b.lastElementChild.getBoundingClientRect().bottom}})()`)
  check(users.top>=users.max-2, 'wheel reaches Users final row')
  check(users.header>=0 && users.bottom<=500, 'Users header and final content remain reachable')
  await c.evaluate(`globalThis.__popupFixture('activity')`); await pause(100)
  const activity = await c.evaluate(`(()=>{const b=document.querySelector('.act-fly'),r=b.getBoundingClientRect();return {bottom:r.bottom,right:r.right,top:r.top}})()`)
  check(activity.bottom<=492 && activity.right<=892 && activity.top>=8, 'activity stays in short viewport')
  await click('.act-filters button'); await pause(100)
  check(await c.evaluate(`document.querySelectorAll('.act-row').length===30 && [...document.querySelectorAll('.act-kind')].every(e=>e.textContent==='Refused')`), 'Interruptions filters activity')
  await c.evaluate(`document.querySelector('[aria-label="Search activity"]').focus()`)
  await c.send('Input.insertText', {text:'Test session 2'}); await pause(100)
  check(await c.evaluate(`document.querySelectorAll('.act-row').length===6`), 'activity search combines with category filter')
  console.log(JSON.stringify({checks,users,activity},null,2))
} finally {
  await c.evaluate(`globalThis.__popupFixture?.(null); delete globalThis.__popupFixture; delete globalThis.__popupTestApi; document.documentElement.style.setProperty('--side-w',${JSON.stringify(originalSideWidth)})`).catch(()=>{})
  await c.send('Emulation.clearDeviceMetricsOverride').catch(()=>{})
  if (ownedPane) await c.evaluate(`window.api.killSession(${JSON.stringify(ownedPane.id)})`)
  if (ownedFolder) rmSync(ownedFolder,{recursive:true,force:true})
  c.close()
}
