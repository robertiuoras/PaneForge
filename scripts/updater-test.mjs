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
module.exports={autoUpdater:{autoDownload:false,autoInstallOnAppQuit:false,allowPrerelease:false,logger:null,
  checkForUpdates:async()=>{calls.push('check');return null},
  quitAndInstall:()=>calls.push('install'),
  on:(e,cb)=>{handlers[e]=cb}},__handlers:handlers,__calls:calls}
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
