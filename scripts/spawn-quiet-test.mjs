// A tidy-up that could not start, and took the app down instead.
//
// Measured here 2026-08-30 03:00:29.951Z and 03:00:30.025Z: two panes closed 74ms apart,
// each firing its own detached stray reaper, and both hit `spawn sh EAGAIN` - the process
// table was full for an instant under eight agent CLIs. Each arrived as an uncaught
// exception, because `spawn()` returns BEFORE the fork, so the try/catch written around
// it caught precisely the case its comment named.
//
// The catch shipped 2026-08-30. What was still missing is the other half: EAGAIN is not a
// verdict about the command, it is the machine being full for a moment, and the reaper
// that never ran means the strays it was for are never killed. So a transient failure is
// retried, and only a command that is actually wrong is written off.
//
//   node scripts/spawn-quiet-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const work = join(tmpdir(), 'pf-spawn-quiet-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

// A spawn that fails the way the machine fails: an `error` EVENT, after the call returned.
// Nothing here stubs `spawnQuiet` itself - a stub of the thing under test proves nothing.
writeFileSync(
  join(work, 'child-process-stub.cjs'),
  `const {EventEmitter}=require('node:events')
const calls=[]
let script=[]
function spawn(bin,args,opts){
  calls.push(bin)
  const fail=script.shift()
  const child=new EventEmitter()
  child.pid=1234
  child.unref=()=>{}
  if(fail==='throw'){const e=new Error('spawn '+bin+' EAGAIN');e.code='EAGAIN';throw e}
  if(fail){process.nextTick(()=>{const e=new Error('spawn '+bin+' '+fail);e.code=fail;child.emit('error',e)})}
  return child
}
module.exports={spawn,__calls:calls,__script:(s)=>{script=s.slice();calls.length=0}}
`
)
writeFileSync(
  join(work, 'electron-stub.cjs'),
  `module.exports={app:{getPath:()=>__dirname}}`
)

buildSync({
  absWorkingDir: ROOT,
  entryPoints: ['src/main/spawnQuiet.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: join(work, 'spawn-quiet.bundle.cjs'),
  external: ['electron', 'node:child_process']
})

writeFileSync(
  join(work, 'drive.cjs'),
  `const path=require('node:path'),Module=require('node:module')
const orig=Module._resolveFilename, load=Module._load
Module._load=function(r,...a){
  if(r==='node:child_process')return require('./child-process-stub.cjs')
  return load.call(this,r,...a)}
Module._resolveFilename=function(r,...a){
  if(r==='electron')return path.join(__dirname,'electron-stub.cjs')
  return orig.call(this,r,...a)}
const cp=require('./child-process-stub.cjs')
const {spawnQuiet}=require('./spawn-quiet.bundle.cjs')
const fail=[]
const ok=(c,n)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)fail.push(n)}
const alive=setInterval(()=>{},20)
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
;(async()=>{
  // Nothing goes wrong: one call, no retry, and the caller gets its child back.
  cp.__script([null])
  const child=spawnQuiet('sh',['-c','true'],{},'happy path')
  ok(!!child&&child.pid===1234,'a spawn that starts hands the child back')
  await sleep(400)
  ok(cp.__calls.length===1,'and is not retried ('+cp.__calls.length+' calls)')

  // The measured failure: EAGAIN once, then room again.
  cp.__script(['EAGAIN',null])
  spawnQuiet('sh',['-c','reap'],{},'reap strays')
  await sleep(400)
  ok(cp.__calls.length===2,'a full process table is tried again rather than written off ('+cp.__calls.length+')')

  // Both panes closing at once: the machine stays full for longer than one backoff.
  cp.__script(['EAGAIN','EAGAIN','EAGAIN',null])
  spawnQuiet('sh',['-c','reap'],{},'reap strays')
  await sleep(2500)
  ok(cp.__calls.length===4,'and again, backing off, until there is room ('+cp.__calls.length+')')

  // It gives up rather than retrying for ever - these are all tidy-ups.
  cp.__script(['EAGAIN','EAGAIN','EAGAIN','EAGAIN','EAGAIN','EAGAIN'])
  spawnQuiet('sh',['-c','reap'],{},'reap strays')
  await sleep(2500)
  ok(cp.__calls.length===4,'a machine that stays full stops being asked ('+cp.__calls.length+' tries)')

  // A command that is simply not there will fail the same way for ever.
  cp.__script(['ENOENT','ENOENT'])
  spawnQuiet('taskkill',[],{},'kill tree')
  await sleep(600)
  ok(cp.__calls.length===1,'a binary that is not there is not retried ('+cp.__calls.length+')')

  // The synchronous throw path takes the same decision.
  cp.__script(['throw',null])
  const none=spawnQuiet('sh',[],{},'reap strays')
  ok(none===null,'a spawn that throws outright hands back nothing')
  await sleep(400)
  ok(cp.__calls.length===2,'but is still tried again when the machine was just full ('+cp.__calls.length+')')

  clearInterval(alive)
  console.log('DRIVE DONE '+fail.length)
  process.exit(fail.length?1:0)
})()
`
)

let out = ''
let bad = 0
try {
  out = execFileSync(process.execPath, [join(work, 'drive.cjs')], { encoding: 'utf8', cwd: work })
} catch (e) {
  out = String(e.stdout ?? '')
  process.stderr.write(String(e.stderr ?? ''))
  bad++
}
process.stdout.write(out)
// A drive that exits 0 without finishing is a failure, not a pass. See the wedge suite.
if (!/DRIVE DONE/.test(out)) {
  console.log('FAIL the drive stopped before the end of its checks')
  bad++
}
console.log(bad ? '\nFAILED' : '\nOK - a tidy-up that cannot start is retried, then written down')
process.exit(bad ? 1 : 0)
