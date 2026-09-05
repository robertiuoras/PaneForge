import { strict as assert } from 'node:assert'
import { connect } from './ui-lab.mjs'
const c = await connect(process.env.PF_PORT ?? '9334')
try {
  const measured = await c.evaluate(`(()=>{
    const host=document.createElement('div');host.className='row-title';host.style='position:fixed;top:160px;left:20px;width:290px';
    host.innerHTML='<button class="chip handoff-queued">moves when done <span class="handoff-elapsed">7s</span></button>';
    document.body.append(host);
    try {
      const button=host.firstElementChild,clock=button.querySelector('span');
      const rows=['7s','10s','1m 00s','2h 30m'].map(text=>{
        clock.textContent=text;const b=button.getBoundingClientRect(),e=clock.getBoundingClientRect();
        return {width:b.width,height:b.height,clockX:e.x,clockWidth:e.width};
      });
      const s=getComputedStyle(clock),p=getComputedStyle(clock,'::after'),b=getComputedStyle(button);
      return {rows,background:s.backgroundImage,shadow:s.boxShadow,pseudo:p.content,animation:s.animationName,buttonShadow:b.boxShadow};
    } finally {host.remove()}
  })()`)
  for(const row of measured.rows) assert.deepEqual(row,measured.rows[0],'timer text must not move or resize the control')
  assert.equal(measured.background,'none')
  assert.equal(measured.shadow,'none')
  assert.equal(measured.pseudo,'none')
  assert.equal(measured.animation,'none')
  assert.equal(measured.buttonShadow,'none')
  console.log(`handoff-chip: 9 checks passed; stable width ${measured.rows[0].width}px across seconds, minutes and hours`)
} finally {c.close()}
