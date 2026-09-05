// Real renderer navigation: create harmless shell output, click an earlier prompt,
// and prove that it remains visible while later output arrives. Uses only dev-a.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { connect } from './ui-lab.mjs'
const c = await connect(process.env.PF_PORT ?? '9341')
let id, checks = 0
const check = (value, message) => { assert.ok(value, message); checks++ }
const waitFor = expression => c.evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+15000;const read=()=>{try{if(${expression})return resolve(true)}catch{}if(Date.now()>end)return reject(Error('Renderer condition timed out'));setTimeout(read,50)};read()})`)
try {
  check((await c.evaluate('window.api.profile()')).includes('dev'), 'isolated dev profile')
  // The dev-only tour loads asynchronously and can open its own example pane.
  // Wait for it before dismissing so it cannot switch panes during the pointer test.
  if (await c.evaluate('window.api.tour()')) {
    await waitFor(`document.querySelector('[data-testid="tour-dismiss"], [data-testid="tour-done"], [data-testid="tour-pill"]')`)
    await c.evaluate(`document.querySelector('[data-testid="tour-dismiss"], [data-testid="tour-done"]')?.click()`)
  }
  const session = await c.openPane({ cwd: process.cwd(), agent: 'shell' })
  id = typeof session === 'string' ? session : session.id
  const ref = `window.__pf[${JSON.stringify(id)}]`
  await waitFor(`${ref}?.term?.element?.isConnected`)
  await c.evaluate(`document.querySelector('.row[data-id="' + ${JSON.stringify(id)} + '"]')?.click()`)
  await waitFor(`${ref}.term.element.getBoundingClientRect().width > 0`)
  const ready = `${ref}.term.buffer.active.getLine(${ref}.term.buffer.active.baseY + ${ref}.term.buffer.active.cursorY)?.translateToString(true).trimEnd().endsWith('$')`
  await waitFor(ready)
  // Let the new pane's initial fit/pty resize settle before generating three turns.
  await c.evaluate('new Promise(resolve=>setTimeout(resolve,1000))')
  await waitFor(`!${ref}.restorePending()`)
  for (let n = 1; n <= 3; n++) {
    const command = `printf 'prompt-index-${n}\\n'; for i in {1..90}; do echo row-${n}-$i; done\r`
    await c.evaluate(`${ref}.term.input(${JSON.stringify(command)})`)
    await waitFor(`window.__pf.marks(${JSON.stringify(id)}).length >= ${n} && (${ready}) && Array.from({length:6},(_,i)=>${ref}.term.buffer.active.getLine(${ref}.term.buffer.active.length-6+i)?.translateToString(true)).includes('row-${n}-90')`)
  }
  // The active pane class varies with grid mode; scope via the terminal we created.
  await c.evaluate(`void (window.__promptIndex = ${ref}.term.element.closest('.xterm-wrap').querySelector('.prompt-index'))`)
  check(await c.evaluate(`window.__promptIndex.querySelectorAll('button').length >= 3`), 'every submitted prompt has a list entry')
  await c.evaluate('window.__promptIndex.querySelector("summary").click()')
  await waitFor('window.__promptIndex.open')
  await c.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))')
  const box = await c.evaluate(`(()=>{const r=window.__promptIndex.querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}})()`)
  check(box.w >= 150 && box.h >= 28, 'prompt text has a readable click target: ' + JSON.stringify(box))
  for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', {type,x:box.x,y:box.y,button:'left',clickCount:1})
  await waitFor(`!window.__promptIndex.open`)
  const state = await c.evaluate(`(()=>{const b=${ref}.term.buffer.active;return {view:b.viewportY,base:b.baseY,text:Array.from({length:${ref}.term.rows},(_,i)=>b.getLine(b.viewportY+i)?.translateToString(true)).join('\\n')}})()`)
  const focus = await c.evaluate(`({matches:document.activeElement === window.__promptIndex.querySelector('summary'),active:document.activeElement?.outerHTML?.slice(0,200),connected:window.__promptIndex.isConnected})`)
  check(focus.matches, 'closing the list restores visible keyboard focus: ' + JSON.stringify(focus))
  check(state.view < state.base && state.text.includes('prompt-index-1'), 'click lands on the first prompt in visible scrollback')
  await c.evaluate(`new Promise(resolve=>${ref}.term.write('later output\\r\\n',resolve))`)
  check(await c.evaluate(`${ref}.term.buffer.active.viewportY === ${state.view}`), 'new output preserves the chosen reading position')
  if (process.env.PF_SHOT) {
    await c.evaluate('window.__promptIndex.querySelector("summary").click()')
    await c.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))')
    writeFileSync(process.env.PF_SHOT, await c.screenshot())
  }
  console.log(`prompt index: ${checks} checks passed`)
} finally {
  if (id) await c.evaluate(`window.api.killSession(${JSON.stringify(id)})`)
  await c.evaluate('delete window.__promptIndex')
  c.close()
}
