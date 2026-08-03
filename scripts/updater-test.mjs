// Regression test for the update badge reading "check failed" while the app was
// updating perfectly well.
//
// Cause: with autoDownload on, every check that finds a new version starts a download.
// A second check fired while the first 80 MB was still in flight started a SECOND
// download into the same temp file, the pair killed each other, and the resulting
// error replaced the download state. Clicking "Check now" again only re-armed it.
//
// The real updater cannot be exercised without a signed installed build, so this runs
// src/main/updater.ts headlessly against stub electron / electron-updater modules and
// asserts the guard: no second check while one is running, none while a build waits.
//
//   node scripts/updater-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-updater-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

writeFileSync(
  join(work, 'electron-stub.cjs'),
  `const fs=require('node:fs'),p=require('node:path')
const dir=__dirname
fs.writeFileSync(p.join(dir,'app-update.yml'),'provider: github\\n')
process.resourcesPath=dir
module.exports={app:{isPackaged:true,getVersion:()=>'0.3.6',getPath:()=>dir},__dir:dir}
`
)

writeFileSync(
  join(work, 'updater-stub.cjs'),
  `const handlers={},calls=[]
let feed=null,tokenFeed=null
module.exports={autoUpdater:{autoDownload:false,autoInstallOnAppQuit:false,allowPrerelease:false,logger:null,
  checkForUpdates:async()=>{calls.push('check');if(feed instanceof Error){handlers.error?.(feed);throw feed}return feed?{updateInfo:{version:feed}}:null},
  downloadUpdate:async()=>{calls.push('download')},
  quitAndInstall:()=>calls.push('install'),
  setFeedURL:()=>{feed=tokenFeed},
  on:(e,cb)=>{handlers[e]=cb}},__handlers:handlers,__calls:calls,__feed:(v)=>{feed=v},__tokenFeed:(v)=>{tokenFeed=v}}
`
)

writeFileSync(
  join(work, 'https-stub.cjs'),
  `const {EventEmitter}=require('node:events')
let latest='0.3.6',status=200
module.exports={
  __latest:(v)=>{latest=v},
  __status:(v)=>{status=v},
  get:(_url,_options,cb)=>{
    const req=new EventEmitter()
    req.destroy=(e)=>req.emit('error',e)
    process.nextTick(()=>{
      const res=new EventEmitter()
      res.statusCode=status
      res.setEncoding=()=>{}
      res.resume=()=>{}
      cb(res)
      res.emit('data',JSON.stringify({tag_name:'v'+latest}))
      res.emit('end')
    })
    return req
  }
}
`
)

writeFileSync(
  join(work, 'child-process-stub.cjs'),
  `const real=require('node:child_process')
let latest='0.3.12'
module.exports={...real,__latest:(v)=>{latest=v},execFile:(_cmd,args,_options,cb)=>process.nextTick(()=>cb(null,args[1]==='token'?'test-token':'v'+latest))}
`
)

// electron / electron-updater stay runtime requires so the drive script and the module
// under test share one stub instance.
// esbuild's own API, not its CLI: `node node_modules/esbuild/bin/esbuild` only works on
// Windows, where that path is a JS shim. On macOS and Linux it is the native binary, so
// handing it to node died with "SyntaxError: Invalid or unexpected token" and this test
// could never have run on a Mac.
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/main/updater.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: join(work, 'updater.bundle.cjs'),
  external: ['electron', 'electron-updater']
})

const drive = join(work, 'drive.cjs')
writeFileSync(
  drive,
  `const path=require('node:path'),fs=require('node:fs'),Module=require('node:module')
const orig=Module._resolveFilename
const load=Module._load
Module._load=function(r,...a){
  if(r==='node:https')return require('./https-stub.cjs')
  if(r==='node:child_process')return require('./child-process-stub.cjs')
  return load.call(this,r,...a)}
Module._resolveFilename=function(r,...a){
  if(r==='electron')return path.join(__dirname,'electron-stub.cjs')
  if(r==='electron-updater')return path.join(__dirname,'updater-stub.cjs')
  return orig.call(this,r,...a)}
// The lane state file the updater reads to know a release exists before GitHub serves
// it. Pointed at a throwaway dir so the test never reads this machine's real lanes.
const repo=path.join(__dirname,'repo')
fs.mkdirSync(path.join(repo,'.git'),{recursive:true})
process.env.PANEFORGE_REPO=repo
const ship=(v)=>fs.writeFileSync(path.join(repo,'.git','paneforge-lanes.json'),JSON.stringify({lanes:{},ready:{},conflicts:{},release:null,lastShip:v}))
ship(null)
const stub=require('./updater-stub.cjs'),https=require('./https-stub.cjs'),child=require('./child-process-stub.cjs'),el=require('./electron-stub.cjs'),u=require('./updater.bundle.cjs')
const fail=[]
const ok=(c,n)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)fail.push(n)}
const logFile=path.join(el.__dir,'updater.log')
fs.rmSync(logFile,{force:true})
u.initUpdater(()=>{},false)
const h=stub.__handlers,calls=stub.__calls,at=()=>calls.length
ok(Object.keys(h).length>=5,'wired all updater events')
;(async()=>{
  let b=at(); await u.checkForUpdates(); ok(at()===b+1,'idle check runs')
  h['checking-for-update'](); b=at(); await u.checkForUpdates(); ok(at()===b,'no second check while checking')
  // macOS cannot install one of these updates (unsigned, so Squirrel.Mac refuses it), so
  // there the same event ends at "there is a new version, here is the page" instead.
  const mac=process.platform==='darwin'
  h['update-available']({version:'0.3.9'})
  ok(u.getUpdateState().phase===(mac?'available':'downloading'),mac?'a Mac is offered the release page':'download starts on available')
  h['download-progress']({percent:42}); b=at(); await u.checkForUpdates()
  ok(at()===b,'no second check while downloading')
  ok(u.getUpdateState().percent===42,'progress kept, not reset')
  h['error'](new Error('sha512 checksum mismatch'))
  ok(u.getUpdateState().phase==='error','error surfaces')
  ok(u.getUpdateState().error==='sha512 checksum mismatch','error text kept')
  b=at(); await u.checkForUpdates(); ok(at()===b+1,'retry allowed after error')
  h['update-downloaded']({version:'0.3.9'}); ok(u.getUpdateState().phase==='ready','ready after download')
  b=at(); await u.checkForUpdates(); ok(at()===b,'no check while a build waits to install')

  // A build downloaded and waiting used to stop the poll for good, so a release that
  // went out in the meantime was only found after restarting into the stale one: one
  // version per restart. The background poll keeps looking, quietly.
  stub.__feed('0.3.9'); b=at(); await u.pollOnce()
  ok(at()===b+1,'the poll still looks while a build waits')
  ok(u.getUpdateState().phase==='ready','the probe does not disturb the ready badge')
  ok(!calls.includes('download'),'the same version is not downloaded twice')
  // A Mac never lets electron-updater download (Squirrel cannot install an unsigned
  // build): src/main/macUpdate.ts fetches the zip and swaps the bundle instead, and this
  // headless run is not a bundle at all, so the newer version ends at the release page.
  stub.__feed('0.3.10'); await u.pollOnce()
  ok(mac?!calls.includes('download'):calls.includes('download'),
     mac?'a Mac supersedes through its own path, not electron-updater':'a newer release downloads over the pending one')
  ok(u.getUpdateState().version==='0.3.10','pending version replaced')
  if(mac) ok(u.getUpdateState().phase==='available','a Mac that cannot swap itself still gets the page')
  h['update-downloaded']({version:'0.3.10'}); ok(u.getUpdateState().phase==='ready','ready on the newer build')

  // A release tag can appear before latest-mac.yml finishes uploading (or without that
  // optional feed at all). A silent ready-state probe still uses the Releases API so it
  // does not strand the older staged build behind a permanent feed error.
  let held='0.3.10'
  if(mac){
    // The public releases API can share the feed's 404 when GitHub hides the account.
    // The validated gh token path must wake the ready-state poll after authenticating.
    https.__status(404)
    stub.__tokenFeed('0.3.12')
    stub.__feed(new Error('Cannot find latest-mac.yml in the latest release artifacts (404)'))
    await u.pollOnce(); await new Promise((r)=>setTimeout(r,10))
    ok(u.getUpdateState().version==='0.3.12','a hidden-account token retry supersedes the staged Mac build')
    h['update-downloaded']({version:'0.3.12'}); held='0.3.12'

    child.__latest('0.3.13')
    stub.__feed(new Error('Cannot find latest-mac.yml in the latest release artifacts (404)'))
    await u.pollOnce()
    ok(u.getUpdateState().version==='0.3.13','an authenticated Mac falls back to gh when its feed and public API are missing')
    h['update-downloaded']({version:'0.3.13'}); held='0.3.13'

    https.__status(200); https.__latest('0.3.14')
    stub.__feed(new Error('Cannot find latest-mac.yml in the latest release artifacts (404)'))
    await u.pollOnce()
    ok(u.getUpdateState().version==='0.3.14','a Mac supersedes from the releases API when its feed is missing')
    stub.__feed('0.3.14')
    h['update-downloaded']({version:'0.3.14'}); held='0.3.14'
  }

  // Four minutes passed between v0.3.30's tag and its latest.yml finishing upload, and a
  // check inside that window reports "up to date". The lane file says a release exists,
  // so the poll closes up to a minute instead of waiting out the idle gap.
  ship({version:'0.4.0',at:Date.now()}); ok(u.pollDelay()===60_000,'chases a release the feed has not got yet')
  ship({version:'0.4.0',at:Date.now()-31*60_000}); ok(u.pollDelay()===600_000,'gives up on a release that never arrived')
  ship({version:held,at:Date.now()}); ok(u.pollDelay()===600_000,'no chase for a version already in hand')
  ship(null); ok(u.pollDelay()===600_000,'no lane file, ordinary poll')

  const log=fs.existsSync(logFile)?fs.readFileSync(logFile,'utf8'):''
  ok(/sha512 checksum mismatch/.test(log),'error written to updater.log')
  ok(/state downloading/.test(log),'phase transitions logged')
  console.log(fail.length?('\\n'+fail.length+' FAILED: '+fail.join(', ')):'\\nall green')
  process.exit(fail.length?1:0)
})()
`
)

// The failed-install retry ("Restart now" ran the installer and the relaunch was the
// same version, wearing the same toast - 2026-08-01). Each case is its own process
// because the decision is made once, at initUpdater, from the marker the last run left.
const retryDrive = join(work, 'drive-retry.cjs')
writeFileSync(
  retryDrive,
  `const path=require('node:path'),fs=require('node:fs'),Module=require('node:module')
const orig=Module._resolveFilename
Module._resolveFilename=function(r,...a){
  if(r==='electron')return path.join(__dirname,'electron-stub.cjs')
  if(r==='electron-updater')return path.join(__dirname,'updater-stub.cjs')
  return orig.call(this,r,...a)}
const repo=path.join(__dirname,'repo')
fs.mkdirSync(path.join(repo,'.git'),{recursive:true})
process.env.PANEFORGE_REPO=repo
const stub=require('./updater-stub.cjs'),el=require('./electron-stub.cjs')
const marker=path.join(el.__dir,'install-attempt.json')
fs.rmSync(marker,{force:true})
if(process.env.MARKER)fs.writeFileSync(marker,process.env.MARKER)
const u=require('./updater.bundle.cjs')
const fail=[]
const ok=(c,n)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)fail.push(n)}
u.initUpdater(()=>{},false)
const h=stub.__handlers
switch(process.env.CASE){
  case 'none':
    ok(u.consumeInstallRetry('0.3.9')===false,'no marker, no retry')
    break
  case 'retry':
    ok(u.consumeInstallRetry('0.3.8')===false,'a different version does not consume the retry')
    ok(u.consumeInstallRetry('0.3.9')===true,'an install that did not apply retries its version')
    ok(u.consumeInstallRetry('0.3.9')===false,'the retry fires once')
    ok(fs.existsSync(marker),'the attempt count survives for the retry to increment')
    h['update-downloaded']({version:'0.3.9'})
    try{u.installUpdate()}catch{}
    {const a=JSON.parse(fs.readFileSync(marker,'utf8'))
     ok(a.version==='0.3.9'&&a.tries===2,'the retry is recorded as attempt 2')}
    break
  case 'give-up':
    ok(u.consumeInstallRetry('0.3.9')===false,'two failed attempts stop the loop')
    ok(!fs.existsSync(marker),'the exhausted marker is cleared')
    break
  case 'applied':
    ok(u.consumeInstallRetry('0.3.6')===false,'an applied install retries nothing')
    ok(!fs.existsSync(marker),'the marker is cleared once the version is running')
    break
  case 'fresh':
    h['update-downloaded']({version:'0.3.9'})
    try{u.installUpdate()}catch{}
    {const a=JSON.parse(fs.readFileSync(marker,'utf8'))
     ok(a.version==='0.3.9'&&a.tries===1,'installUpdate records attempt 1')}
    break
}
console.log(fail.length?'case FAILED: '+fail.join(', '):'case green')
process.exit(fail.length?1:0)
`
)

const retryCases = [
  ['none', ''],
  ['fresh', ''],
  ['retry', '{"version":"0.3.9","tries":1}'],
  ['give-up', '{"version":"0.3.9","tries":2}'],
  ['applied', '{"version":"0.3.6","tries":1}']
]

let out = ''
try {
  out = execFileSync(process.execPath, [drive], { cwd: root, encoding: 'utf8' })
} catch (e) {
  out = String(e.stdout ?? '') + String(e.stderr ?? '')
}
let retryGreen = 0
for (const [CASE, MARKER] of retryCases) {
  let r = ''
  try {
    r = execFileSync(process.execPath, [retryDrive], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, CASE, MARKER }
    })
  } catch (e) {
    r = String(e.stdout ?? '') + String(e.stderr ?? '')
  }
  out += r
  if (/case green/.test(r)) retryGreen++
}
process.stdout.write(out)
rmSync(work, { recursive: true, force: true })
if (!/all green/.test(out) || retryGreen !== retryCases.length) process.exit(1)
