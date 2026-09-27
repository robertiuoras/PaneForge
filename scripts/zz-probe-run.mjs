// scratch: run the prompt-submit suite K at once, R rounds; print timing details per copy
import { spawn } from 'node:child_process'
const plan = (process.argv[2] || '1x1').split(',').map((x) => x.split('x').map(Number))
const want = /FAIL/
for (const [K, R] of plan) for (let r = 0; r < R; r++) {
  console.log(`== ${K} at once, round ${r}`)
  const runs = Array.from({ length: K }, (_, i) => new Promise((res) => {
    const kid = spawn(process.execPath, ['scripts/zz-probe-ps.mjs'], { env: { ...process.env, PROBE_ALL: '1',  }, windowsHide: true })
    let out = ''
    kid.stdout.on('data', (b) => (out += b)); kid.stderr.on('data', (b) => (out += b))
    kid.on('close', (code) => res({ i, code, out }))
  }))
  for (const { i, code, out } of await Promise.all(runs)) {
    const lines = out.split('\n'); const pick = []
    lines.forEach((l, j) => { if (want.test(l)) pick.push(l.trim() + (lines[j + 1]?.startsWith('    ') ? '  => ' + lines[j + 1].trim() : '')) })
    console.log(`round ${r} copy ${i} exit ${code}\n  ` + pick.join('\n  '))
  }
}
