// A staged build nobody ever installs.
//
// The failure this pins is not a crash: it is three downloads in two hours, two of them
// thrown away unused, the app still running the build from the day before, and every
// surface reading as healthy because "ready" is what a working update path looks like.
// Measured on this Mac 2026-09-02 in updater.log - 01:34:47 staged 0.8.186 ready,
// 03:04:39 superseded by 0.8.187, 03:24:45 superseded by 0.8.188, no install attempt
// after any of them, last attempt of any version 12:40:06 the day before.
//
//   node scripts/update-stale-test.mjs

import { buildSync } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const OUT = join(ROOT, 'node_modules', '.pf-test')
mkdirSync(OUT, { recursive: true })
const outfile = join(OUT, 'update-stale.mjs')
buildSync({
  entryPoints: [join(ROOT, 'src/shared/updateStale.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node'
})
const { STALE_SUPERSEDES, READY_HOLD_MS, ignoredHint, updateIgnored } =
  await import(pathToFileURL(outfile).href)

const fail = []
const ok = (c, n) => {
  console.log((c ? 'PASS ' : 'FAIL ') + n)
  if (!c) fail.push(n)
}

ok(!updateIgnored(0), 'a build that has thrown nothing away waits to be asked')
// One is the ordinary case: a release goes out while the card is on screen. Reacting to
// that would make every busy afternoon a restart nobody asked for.
ok(!updateIgnored(1), 'one build lost to a newer one is ordinary, not being ignored')
ok(updateIgnored(2), 'two builds thrown away unused is the app not being noticed')
ok(updateIgnored(9), 'and it stays true past the threshold')
ok(STALE_SUPERSEDES === 2, 'the threshold is two, named rather than written into the rule')

// The count is reset by an install ATTEMPT, so a user who presses Restart never reaches
// this - which is why the rule may take a restart without asking again.
ok(updateIgnored(0) === false, 'and an attempt puts it back to waiting')

const hint = ignoredHint('0.8.185')
ok(hint.includes('0.8.185'), 'the card names the version the user is stuck on')
ok(hint.includes('restart into this one by itself'), 'and says the app will do it without being asked')
ok(hint.includes('no pane has been used for 10 minutes'), 'and when: once nothing has been used for 10 minutes')
// Every word on screen is read by somebody who has never used git.
for (const word of ['superseded', 'staged', 'stale', 'feed', 'install attempt']) {
  ok(!hint.toLowerCase().includes(word), `the card does not say "${word}"`)
}

// --- a build that has sat ready --------------------------------------------------
//
// The first version of this rule only fired on a window nobody had focused for half an
// hour. That distinction was dropped 2026-09-03 (Robert: "if we release we should
// probably auto update both pc and mac right?"): `autoInstall`'s own deskBusy hold
// already protects a pane in use, so every desk takes a ready build the same way now.
ok(READY_HOLD_MS === 5 * 60_000, 'a build is taken once it has sat ready five minutes')

// --- and the same rule, driven through the real updater ----------------------
//
// The arithmetic above proves the threshold; this proves the wiring, which is the half
// that was actually missing. Runs src/main/updater.ts headlessly against stub electron /
// electron-updater, the same way updater-wedge-test.mjs does.

import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const work = join(tmpdir(), 'pf-update-stale-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

writeFileSync(
  join(work, 'electron-stub.cjs'),
  `const fs=require('node:fs'),p=require('node:path')
const dir=__dirname
fs.writeFileSync(p.join(dir,'app-update.yml'),'provider: github\\n')
process.resourcesPath=dir
module.exports={app:{isPackaged:true,getVersion:()=>'0.8.185',getPath:()=>dir},__dir:dir}
`
)
writeFileSync(
  join(work, 'updater-stub.cjs'),
  `const handlers={},calls=[]
let feed=null
module.exports={autoUpdater:{autoDownload:false,autoInstallOnAppQuit:false,allowPrerelease:false,logger:null,
  checkForUpdates:()=>{calls.push('check');return Promise.resolve(feed?{updateInfo:{version:feed}}:null)},
  downloadUpdate:async()=>{calls.push('download')},
  quitAndInstall:()=>calls.push('install'),
  setFeedURL:()=>{},
  on:(e,cb)=>{handlers[e]=cb}},__handlers:handlers,__calls:calls,__feed:(v)=>{feed=v}}
`
)
writeFileSync(
  join(work, 'https-stub.cjs'),
  `const {EventEmitter}=require('node:events')
module.exports={get:(_url,_options,cb)=>{
  const req=new EventEmitter()
  req.destroy=(e)=>req.emit('error',e)
  process.nextTick(()=>{
    const res=new EventEmitter()
    res.statusCode=200
    res.setEncoding=()=>{}
    res.resume=()=>{}
    cb(res)
    res.emit('data',JSON.stringify({tag_name:'v0.8.185'}))
    res.emit('end')
  })
  return req
}}
`
)
writeFileSync(
  join(work, 'child-process-stub.cjs'),
  `const real=require('node:child_process')
module.exports={...real,execFile:(_cmd,args,_options,cb)=>process.nextTick(()=>cb(new Error('no gh in the test')))}
`
)

buildSync({
  absWorkingDir: ROOT,
  entryPoints: ['src/main/updater.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: join(work, 'updater.bundle.cjs'),
  external: ['electron', 'electron-updater']
})

writeFileSync(
  join(work, 'drive.cjs'),
  `const path=require('node:path'),fs=require('node:fs'),Module=require('node:module')
const orig=Module._resolveFilename, load=Module._load
Module._load=function(r,...a){
  if(r==='node:https')return require('./https-stub.cjs')
  if(r==='node:child_process')return require('./child-process-stub.cjs')
  return load.call(this,r,...a)}
Module._resolveFilename=function(r,...a){
  if(r==='electron')return path.join(__dirname,'electron-stub.cjs')
  if(r==='electron-updater')return path.join(__dirname,'updater-stub.cjs')
  return orig.call(this,r,...a)}
const repo=path.join(__dirname,'repo')
fs.mkdirSync(path.join(repo,'.git'),{recursive:true})
process.env.PANEFORGE_REPO=repo
fs.writeFileSync(path.join(repo,'.git','paneforge-lanes.json'),JSON.stringify({lanes:{},ready:{},conflicts:{},release:null,lastShip:null}))
const stub=require('./updater-stub.cjs'),el=require('./electron-stub.cjs')
const fail=[]
const ok=(c,n)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)fail.push(n)}
const u=require('./updater.bundle.cjs')
let told=0
u.onUpdateIgnored(()=>{told++})
u.initUpdater(()=>{},false)
const h=stub.__handlers
const health=()=>JSON.parse(fs.readFileSync(path.join(el.__dir,'update-health.json'),'utf8'))
;(async()=>{
  // 01:34:47 - the first build is downloaded and waits.
  h['update-downloaded']({version:'0.8.186'})
  ok(u.getUpdateState().phase==='ready','the first build waits as ready')
  ok(u.getUpdateState().ignored!==true,'and one build waiting is not being ignored')
  ok(told===0,'nothing is restarted over one ignored card')

  // 03:04:39 - superseded, never installed.
  stub.__feed('0.8.187')
  await u.pollOnce()
  ok(u.supersededCount()===1,'a build thrown away unused is counted ('+u.supersededCount()+')')
  h['update-downloaded']({version:'0.8.187'})
  ok(u.getUpdateState().ignored!==true,'one throw-away is still the ordinary case')
  ok(told===0,'and still nothing is restarted')

  // 03:24:45 - superseded again, still never installed. This is the line the app
  // silently crossed on 2026-09-02 and did nothing about for two more hours.
  stub.__feed('0.8.188')
  await u.pollOnce()
  ok(u.supersededCount()===2,'the second throw-away is counted too')
  h['update-downloaded']({version:'0.8.188'})
  ok(u.getUpdateState().ignored===true,'the second one says the app has stopped being noticed')
  ok(told===1,'and the restart-when-idle path is told, exactly once')
  ok(/stale/.test(fs.readFileSync(path.join(el.__dir,'updater.log'),'utf8')),'and it is written down for whoever reads the log a week later')
  ok(health().superseded===2,'the count survives a restart, because the app it is about keeps running')

  // A build that stops being ready stops carrying the flag with it.
  h['update-not-available']()
  ok(u.getUpdateState().ignored!==true,'the flag does not outlive the build it was about')

  process.exit(fail.length?1:0)
})()
`
)

try {
  const out = execFileSync(process.execPath, [join(work, 'drive.cjs')], { cwd: work, encoding: 'utf8' })
  process.stdout.write(out)
} catch (e) {
  process.stdout.write(String(e.stdout ?? ''))
  process.stderr.write(String(e.stderr ?? ''))
  fail.push('the wired rule')
}

console.log(fail.length ? `\n${fail.length} failed` : '\nall good')
process.exit(fail.length ? 1 : 0)
