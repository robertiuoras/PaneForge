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
let feed=null
module.exports={autoUpdater:{autoDownload:false,autoInstallOnAppQuit:false,allowPrerelease:false,logger:null,
  checkForUpdates:async()=>{calls.push('check');return feed?{updateInfo:{version:feed}}:null},
  downloadUpdate:async()=>{calls.push('download')},
  quitAndInstall:()=>calls.push('install'),
  on:(e,cb)=>{handlers[e]=cb}},__handlers:handlers,__calls:calls,__feed:(v)=>{feed=v}}
`
)

// electron / electron-updater stay runtime requires so the drive script and the module
// under test share one stub instance.
// esbuild's JS shim, not `npx esbuild`: Node 24 refuses to spawn a .cmd without a shell.
execFileSync(
  process.execPath,
  [
    join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    'src/main/updater.ts',
    '--bundle',
    '--format=cjs',
    '--platform=node',
    `--outfile=${join(work, 'updater.bundle.cjs')}`,
    '--external:electron',
    '--external:electron-updater'
  ],
  { cwd: root, stdio: 'pipe' }
)

const drive = join(work, 'drive.cjs')
writeFileSync(
  drive,
  `const path=require('node:path'),fs=require('node:fs'),Module=require('node:module')
const orig=Module._resolveFilename
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
const stub=require('./updater-stub.cjs'),el=require('./electron-stub.cjs'),u=require('./updater.bundle.cjs')
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
  h['update-available']({version:'0.3.9'}); ok(u.getUpdateState().phase==='downloading','download starts on available')
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
  stub.__feed('0.3.10'); await u.pollOnce()
  ok(calls.includes('download'),'a newer release downloads over the pending one')
  ok(u.getUpdateState().version==='0.3.10','pending version replaced')
  h['update-downloaded']({version:'0.3.10'}); ok(u.getUpdateState().phase==='ready','ready on the newer build')

  // Four minutes passed between v0.3.30's tag and its latest.yml finishing upload, and a
  // check inside that window reports "up to date". The lane file says a release exists,
  // so the poll closes up to a minute instead of waiting out the idle gap.
  ship({version:'0.4.0',at:Date.now()}); ok(u.pollDelay()===60_000,'chases a release the feed has not got yet')
  ship({version:'0.4.0',at:Date.now()-31*60_000}); ok(u.pollDelay()===600_000,'gives up on a release that never arrived')
  ship({version:'0.3.10',at:Date.now()}); ok(u.pollDelay()===600_000,'no chase for a version already in hand')
  ship(null); ok(u.pollDelay()===600_000,'no lane file, ordinary poll')

  const log=fs.existsSync(logFile)?fs.readFileSync(logFile,'utf8'):''
  ok(/sha512 checksum mismatch/.test(log),'error written to updater.log')
  ok(/state downloading/.test(log),'phase transitions logged')
  console.log(fail.length?('\\n'+fail.length+' FAILED: '+fail.join(', ')):'\\nall green')
  process.exit(fail.length?1:0)
})()
`
)

let out = ''
try {
  out = execFileSync(process.execPath, [drive], { cwd: root, encoding: 'utf8' })
} catch (e) {
  out = String(e.stdout ?? '') + String(e.stderr ?? '')
}
process.stdout.write(out)
rmSync(work, { recursive: true, force: true })
if (!/all green/.test(out)) process.exit(1)
