// Proves the ONE property that stops caffeinate leaking: a caffeinate spawned with
// `-w <parent pid>` dies when that parent is SIGKILLed, and one spawned without it
// does not. This is an OS-level claim, not a logic claim, so the test exercises the
// real binary rather than mocking it -- the leak that motivated it (19 orphans, ppid
// 1, oldest 6h, all asserting PreventUserIdleDisplaySleep on Robert's Mac 2026-08-28)
// was invisible to every unit test in this repo precisely because it lives in process
// lifetime, not in a verdict.
//
// The control case is the important half: without it, a green run would not
// distinguish "the fix works" from "caffeinate happens to die anyway".
import { spawn } from 'node:child_process'

if (process.platform !== 'darwin') {
  console.log('skip: caffeinate is macOS-only')
  process.exit(0)
}

let failures = 0
function ok(cond, msg) {
  console.log(`${cond ? 'ok  ' : 'FAIL'}   ${msg}`)
  if (!cond) failures++
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// A middle process that spawns caffeinate the way awake.ts does, prints the child's
// pid, then idles -- so we can SIGKILL it and watch what survives. The `-w` argument
// is built INSIDE this process: watching its own pid is exactly the relationship
// awake.ts has, where caffeinate watches the Electron main process that spawned it.
// (Resolving the pid out here would watch a different, already-dead process and the
// test would pass for the wrong reason.)
function harness(withWatch) {
  return `
    const { spawn } = require('node:child_process')
    const args = ${withWatch} ? ['-i', '-w', String(process.pid)] : ['-i']
    const proc = spawn('caffeinate', args, { stdio: 'ignore', detached: false })
    process.stdout.write(String(proc.pid) + '\\n')
    setInterval(() => {}, 1000)
  `
}

async function run(label, withWatch, expectOrphan) {
  const parent = spawn(process.execPath, ['-e', harness(withWatch)], {
    stdio: ['ignore', 'pipe', 'ignore']
  })
  const childPid = await new Promise((resolve) => {
    parent.stdout.once('data', (d) => resolve(Number(String(d).trim())))
  })
  await sleep(300)
  ok(alive(childPid), `${label}: caffeinate ${childPid} is running before the kill`)
  parent.kill('SIGKILL')
  await sleep(1200)
  const survived = alive(childPid)
  ok(
    survived === expectOrphan,
    `${label}: after SIGKILL of its parent, caffeinate ${survived ? 'SURVIVED' : 'exited'} (expected ${expectOrphan ? 'SURVIVED' : 'exited'})`
  )
  if (survived) {
    try {
      process.kill(childPid, 'SIGKILL')
    } catch {}
  }
}

await run('with -w (the fix)', true, false)
// Control: the old form. If this ever stops orphaning, the test above proves nothing.
await run('without -w (the old form)', false, true)

// The reaper in claude-config/lid-awake.sh deliberately leaves timed holds alone,
// so the `-u -t 5` tickle must stay self-limiting rather than gain a -w.
const timed = spawn('caffeinate', ['-u', '-t', '1'], { stdio: 'ignore' })
await sleep(2000)
ok(!alive(timed.pid), 'a -t hold still exits on its own timer')

console.log(failures === 0 ? '\nall green' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
