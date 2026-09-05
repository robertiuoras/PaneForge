import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { connect } from './ui-lab.mjs'
const c = await connect(process.env.PF_PORT ?? '9341')
let checks = 0
const check = (value, message) => { assert.ok(value, message); checks++ }
try {
  check(await c.evaluate('window.api.ownerAccess()'), 'current GitHub identity is authorised owner')
  const button = await c.evaluate(`(()=>{const users=document.querySelector('.users-button'),swarm=document.querySelector('.swarm-users .quick-btn');if(!users||!swarm)return null;const a=users.getBoundingClientRect(),b=swarm.getBoundingClientRect();return {below:a.top>=b.bottom,width:a.width,swarmWidth:b.width}})()`)
  check(button?.below && button.width >= 24 && button.swarmWidth >= 24, 'Users is a usable button beneath Swarm')
  await c.evaluate(`document.querySelector('.users-button').click()`)
  await c.evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+35000;const read=()=>{if(document.querySelector('.users-counts'))resolve();else if(document.querySelector('.users-dialog [role=alert]'))reject(Error(document.querySelector('.users-dialog [role=alert]').textContent));else if(Date.now()>end)reject(Error('owner stats did not arrive'));else setTimeout(read,100)};read()})`)
  const state = await c.evaluate(`(()=>{const d=document.querySelector('.users-dialog'),b=d.querySelector('.users-body'),r=d.getBoundingClientRect();return {text:d.innerText,overflow:d.scrollWidth>d.clientWidth,inside:r.top>=0&&r.bottom<=innerHeight,bodyScroll:b.scrollHeight>b.clientHeight,totals:[...d.querySelectorAll('.users-counts strong')].map(e=>Number(e.textContent))}})()`)
  check(state.inside && !state.overflow, 'popup fits viewport without horizontal overflow')
  check(state.text.includes('not unique people') && state.text.includes('Your devices'), 'data sources and limits are explicit')
  check(state.totals[0] === state.totals[1] + state.totals[2], 'platform downloads sum to the displayed total')
  check(await c.evaluate(`document.activeElement?.getAttribute('aria-label')==='Close Users'`), 'dialog moves keyboard focus to close control')
  if (process.env.PF_SHOT) {
    const clip = await c.evaluate(`(()=>{const r=document.querySelector('.users-dialog').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`)
    writeFileSync(process.env.PF_SHOT, await c.screenshot({clip}))
  }
  await c.evaluate(`document.querySelector('[aria-label="Close Users"]').click()`)
  check(await c.evaluate(`!document.querySelector('.users-dialog')`), 'Close dismisses popup')
  console.log(`users popup: ${checks} checks passed; live download total ${state.totals[0]}`)
} finally { c.close() }
