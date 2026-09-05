// Exercise the actual sidebar and persisted dev-profile config with two owned shells.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { connect } from './ui-lab.mjs'
const c = await connect(process.env.PF_PORT ?? '9334')
let original, ids = [], checks = 0
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++ }
const settle = () => new Promise(resolve => setTimeout(resolve, 150))
try {
  await c.evaluate('location.reload()')
  await new Promise(resolve => setTimeout(resolve, 700))
  original = await c.evaluate('window.api.getConfig().then(c=>c.pinnedPanes ?? [])')
  for (let n = 1; n <= 2; n++) ids.push(await c.evaluate(`window.api.startSession({agent:'shell',cwd:'/tmp',title:'Keep-open test ${n}'}).then(s=>s.id)`))
  await settle()
  eq(await c.evaluate(`document.querySelectorAll('input.keep-open-check').length`), 0, 'selection boxes are hidden until Keep open is pressed')
  await c.evaluate(`document.querySelector('.keep-open-toggle').click()`)
  await settle()
  eq(await c.evaluate(`document.querySelector('.device-filter select').value`), 'all', 'selection starts with all devices visible')
  const row = id => `.row[data-id="${id}"] input.keep-open-check`
  eq(await c.evaluate(`document.querySelector(${JSON.stringify(row(ids[0]))})?.checked`), false, 'new shell is unpinned')
  const activeBefore = await c.evaluate('document.querySelector(".row.active")?.dataset.id')
  await c.evaluate(`document.querySelector(${JSON.stringify(row(ids[0]))}).click()`)
  await settle()
  eq(await c.evaluate(`window.api.getConfig().then(c=>c.pinnedPanes.includes(${JSON.stringify(ids[0])}))`), true, 'row checkbox persists on owner')
  eq(await c.evaluate('document.querySelector(".row.active")?.dataset.id'), activeBefore, 'checkbox does not switch active pane')
  const all = 'input[aria-label="Keep all sessions on this device open"]'
  eq(await c.evaluate(`document.querySelector(${JSON.stringify(all)}).indeterminate`), true, 'mixed selection is indeterminate')
  await c.evaluate(`document.querySelector(${JSON.stringify(all)}).click()`)
  await settle()
  eq(await c.evaluate(`window.api.getConfig().then(c=>${JSON.stringify(ids)}.every(id=>c.pinnedPanes.includes(id)))`), true, 'top checkbox saves both sessions')
  eq(await c.evaluate(`document.querySelector(${JSON.stringify(all)}).checked`), true, 'all selected after save')
  if (process.env.PF_SHOT) {
    const clip = await c.evaluate(`(()=>{const r=document.querySelector('.sidebar').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:Math.min(r.height,400),scale:1}})()`)
    writeFileSync(process.env.PF_SHOT, await c.screenshot({clip}))
  }
  eq(await c.evaluate(`document.querySelectorAll('.pane-title input.keep-open-check').length`), 0, 'checkboxes belong in sidebar')
  await c.evaluate(`document.querySelector('.keep-open-toggle').click()`)
  await settle()
  eq(await c.evaluate(`document.querySelectorAll('input.keep-open-check').length`), 0, 'Done hides every selection box')
  eq(await c.evaluate(`window.api.getConfig().then(c=>${JSON.stringify(ids)}.every(id=>c.pinnedPanes.includes(id)))`), true, 'hiding selection keeps protections saved')
  await c.evaluate('location.reload()')
  await new Promise(resolve => setTimeout(resolve, 700))
  eq(await c.evaluate(`document.querySelectorAll('input.keep-open-check').length`), 0, 'reload leaves selection closed')
  await c.evaluate(`document.querySelector('.keep-open-toggle').click()`)
  await settle()
  eq(await c.evaluate(`document.querySelector(${JSON.stringify(row(ids[0]))})?.checked`), true, 'saved selection survives renderer reload')
  // The dev tour can open a shell during reload. First select that newly present row.
  await c.evaluate(`(()=>{const all=document.querySelector(${JSON.stringify(all)});if(!all.checked)all.click()})()`)
  await settle()
  await c.evaluate(`document.querySelector(${JSON.stringify(all)}).click()`)
  await settle()
  eq(await c.evaluate(`window.api.getConfig().then(c=>${JSON.stringify(ids)}.some(id=>c.pinnedPanes.includes(id)))`), false, 'top checkbox clears selection')
  const size = await c.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(row(ids[0]))}).getBoundingClientRect();return {width:r.width,height:r.height}})()`)
  eq(size, {width:16,height:16}, 'checkbox has stable visible dimensions')
  console.log(`keep-open sidebar: ${checks} checks passed`)
} finally {
  for (const id of ids) await c.evaluate(`window.api.killSession(${JSON.stringify(id)})`)
  if (original) await c.evaluate(`window.api.setConfig({pinnedPanes:${JSON.stringify(original)}})`)
  await c.evaluate(`document.querySelector('.keep-open-toggle[aria-pressed="true"]')?.click()`)
  c.close()
}
