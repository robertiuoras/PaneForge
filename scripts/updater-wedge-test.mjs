// The updater may never need a person to fix it.
//
// Every wedge this app has had is one shape: a promise that never settles, behind a flag
// that says "already working on it". v0.6.0 settled every download path in macUpdate.ts -
// which fixed the one promise known to hang and left the shape intact, because the
// recovery lived INSIDE the thing that can hang. electron-updater's own check and download
// are not ours to settle at all.
//
// Measured on this Mac 2026-08-07: phase `downloading` v0.4.62, badge frozen at 33%, last
// updater.log line four hours old, a complete newer bundle staged on disk and every quit
// installing nothing - because the quit swap was gated on `phase === 'ready'`. The only
// way back was replacing /Applications/PaneForge.app by hand. That is the thing this test
// exists to make impossible.
//
// Runs src/main/updater.ts headlessly against stub electron / electron-updater, with the
// budgets shrunk through their env vars so a wedge that would take 45 minutes takes 150ms.
//
//   node scripts/updater-wedge-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { buildSync } from 'esbuild'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-updater-wedge-test')
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

// The one stub that matters: `__hang(true)` makes checkForUpdates return a promise that
// never settles and never rejects. Not a slow one - one that has no ending at all, which
// is what electron-updater did on 2026-08-06 and what no amount of care inside our own
// download code can fix.
writeFileSync(
  join(work, 'updater-stub.cjs'),
  `const handlers={},calls=[]
let feed=null,hang=false
module.exports={autoUpdater:{autoDownload:false,autoInstallOnAppQuit:false,allowPrerelease:false,logger:null,
  checkForUpdates:()=>{calls.push('check');if(hang)return new Promise(()=>{});return Promise.resolve(feed?{updateInfo:{version:feed}}:null)},
  downloadUpdate:async()=>{calls.push('download')},
  quitAndInstall:()=>calls.push('install'),
  setFeedURL:()=>{},
  on:(e,cb)=>{handlers[e]=cb}},__handlers:handlers,__calls:calls,__feed:(v)=>{feed=v},__hang:(v)=>{hang=v}}
`
)

// The releases-API fallback the mac path takes on a feed error. Answers instantly so no
// test ever waits on a real network, and so a hang under test is only ever the one we set.
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
    res.emit('data',JSON.stringify({tag_name:'v0.3.6'}))
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
  absWorkingDir: root,
  entryPoints: ['src/main/updater.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: join(work, 'updater.bundle.cjs'),
  external: ['electron', 'electron-updater']
})

const preamble = `const path=require('node:path'),fs=require('node:fs'),Module=require('node:module')
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
const repo=path.join(__dirname,'repo')
fs.mkdirSync(path.join(repo,'.git'),{recursive:true})
process.env.PANEFORGE_REPO=repo
fs.writeFileSync(path.join(repo,'.git','paneforge-lanes.json'),JSON.stringify({lanes:{},ready:{},conflicts:{},release:null,lastShip:null}))
const stub=require('./updater-stub.cjs'),el=require('./electron-stub.cjs')
const fail=[]
const ok=(c,n)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)fail.push(n)}
const skip=(n,why)=>console.log('SKIP '+n+' - '+why)
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
// Every timer inside updater.ts is unref'd on purpose - a background poll may not hold
// the app open. Under test that means node runs out of ref'd handles at the first await
// and EXITS 0, mid-suite, looking exactly like a pass: this file reported OK for months
// while running one of its eleven checks. One ref'd interval, and a sentinel the outer
// half insists on seeing, is what tells a finished run from an abandoned one.
const alive=setInterval(()=>{},20)
const done=(n)=>{clearInterval(alive);console.log('DRIVE DONE '+n);process.exit(n?1:0)}
const logFile=path.join(el.__dir,'updater.log')
const logged=()=>{try{return fs.readFileSync(logFile,'utf8')}catch{return ''}}
`

// --- 1: a wedge undoes itself, and the poll outlives the turn that caused it ----------
const drive = join(work, 'drive.cjs')
writeFileSync(
  drive,
  `${preamble}
const u=require('./updater.bundle.cjs')
fs.rmSync(logFile,{force:true})
u.initUpdater(()=>{},false)
const h=stub.__handlers,calls=stub.__calls,at=()=>calls.length
;(async()=>{
  // A check that never comes back. The badge says "checking" and every later check is
  // refused as a duplicate - for ever, which is how an app stops updating in silence.
  stub.__hang(true)
  let b=at()
  void u.checkForUpdates()
  // A tick, not none: the phase is set after an await inside checkForUpdates (the
  // prerelease flag is re-asserted first), so reading it synchronously reads the phase
  // from before the call.
  await sleep(0)
  ok(u.getUpdateState().phase==='checking','a hung check leaves the badge checking')
  b=at(); await u.checkForUpdates()
  ok(at()===b,'a second check is refused while the first is genuinely in flight')

  // Nobody asks again. This is the half that was missing on 2026-09-02: busy() is only
  // consulted when something starts a check, so a 2-minute budget was enforced at the
  // POLL interval - two wedges here lasted 999s and 784s.
  await sleep(260)
  ok(u.getUpdateState().phase!=='checking','a hung check is dropped on its own clock, with nobody asking')
  ok(/wedged/.test(logged()),'the wedge is written down rather than recovered in silence')
  ok(/network unknown|online|OFFLINE/.test(logged()),'and it says what the network was doing when it started')
  stub.__hang(false)
  b=at(); await u.checkForUpdates()
  ok(at()===b+1,'and the next check runs clean')

  // The reported symptom itself: a percentage that stops moving. 33% is 30 MiB of the
  // 95.8 MB v0.4.62 zip - the exact number this Mac sat on.
  h['download-progress']({percent:33})
  ok(u.getUpdateState().phase==='downloading'&&u.getUpdateState().percent===33,'a stalled download shows 33%')
  b=at(); await u.checkForUpdates()
  ok(at()===b,'no check while a download could still be alive')
  // A download is not a promise this app awaits, so failFast cannot reach it: this is
  // the timer on its own, and the only thing that ends a stalled download at its budget
  // rather than at the next poll.
  await sleep(260)
  ok(u.getUpdateState().phase!=='downloading','a download that never finishes is dropped with nobody asking')
  b=at(); await u.checkForUpdates()
  ok(at()===b+1,'and stops blocking every later check')

  // The other half, and the one the timer cannot do: a caller AWAITING the check has to
  // get control back. The timer resets the badge, but whoever was awaiting - pollOnce,
  // whose finally re-arms the background poll - is still sitting on a promise with no
  // ending. Racing the check inside updater.ts is what settles it.
  h['update-not-available']()
  stub.__hang(true)
  const raced=await Promise.race([u.checkForUpdates().then(()=>'returned'),sleep(600).then(()=>'still hanging')])
  ok(raced==='returned','a check that never answers hands control back to whoever awaited it')
  stub.__hang(false)

  // The deeper half. arm() is called from pollOnce's finally, and finally is not reached
  // while an await hangs - so one unsettled promise used to end the background poll for
  // the life of the process. Nothing was then left to notice the wedge above at all.
  // The check now fails fast, so the ordinary path is a turn that RETURNS and re-arms
  // itself; the watchdog behind it is the second line, for a hang failFast cannot reach.
  // Settle the badge first, or the poll below never reaches the hang at all: it would be
  // refused by the still-fresh phase above, return at once and re-arm normally. That is
  // correct behaviour and the opposite of what is being tested here.
  h['update-not-available']()
  ok(u.getUpdateState().phase==='none','the badge settles between wedges')
  u.setAutoCheck(true)
  stub.__hang(true)
  b=at()
  void u.pollOnce()
  await sleep(800)
  ok(at()>b,'the poll comes back from a turn that used to never return ('+(at()-b)+' turns)')
  ok(u.getUpdateState().phase!=='checking','and it is not left holding the badge')
  u.setAutoCheck(false)
  stub.__hang(false)

  // A probe is the same flag one size down: supersede() sets it, ignores every event
  // while it is set, and unwinds it in a finally that a hung check never reaches.
  h['update-downloaded']({version:'0.9.0'})
  ok(u.getUpdateState().phase==='ready','a downloaded build waits as ready')
  stub.__hang(true)
  void u.pollOnce()
  await sleep(260)
  stub.__hang(false)
  h['update-available']({version:'0.9.9'})
  ok(u.getUpdateState().phase!=='ready','a probe that never came back stops swallowing events')

  const health=JSON.parse(fs.readFileSync(path.join(el.__dir,'update-health.json'),'utf8'))
  ok(health.wedges>=3,'every recovered wedge is counted ('+health.wedges+')')
  ok(typeof health.lastWedge==='string','and the last one is named for whoever reads it later')
  ok(/after [0-9]+s/.test(health.lastWedge),'with how long it was held, so a log review can size it')

  done(fail.length)
})()
`
)

// --- 2: quitting installs what is on disk, whatever the badge says --------------------
//
// Its own process because adoptStaged() runs once, inside initUpdater.
const stagedDrive = join(work, 'drive-staged.cjs')
writeFileSync(
  stagedDrive,
  `${preamble}
// A bundle expanded by an earlier run, exactly as macUpdate.ts leaves one.
const bundle=path.join(el.__dir,'mac-update','0.9.0','PaneForge.app','Contents')
fs.mkdirSync(path.join(bundle,'MacOS'),{recursive:true})
fs.writeFileSync(path.join(bundle,'Info.plist'),'<plist><dict><key>CFBundleShortVersionString</key><string>0.9.0</string></dict></plist>')
fs.writeFileSync(path.join(bundle,'MacOS','PaneForge'),'#!/bin/sh\\n',{mode:0o755})
const u=require('./updater.bundle.cjs')
u.initUpdater(()=>{},false)
const h=stub.__handlers
const mac=process.platform==='darwin'
if(!mac){
  ok(u.stagedInstallable()==='','off macOS there is no bundle to swap in')
  done(fail.length)
}
ok(u.getUpdateState().phase==='ready','a bundle staged by an earlier run is adopted at launch')
ok(u.stagedInstallable()==='0.9.0','and is installable on the way out')
// Now the state this Mac was actually in: a NEWER version stuck downloading over it.
h['download-progress']({percent:33})
ok(u.getUpdateState().phase==='downloading','a newer version starts downloading over it')
ok(u.stagedInstallable()==='0.9.0','quitting still installs the staged bundle - the disk wins over the badge')
done(fail.length)
`
)

const env = {
  ...process.env,
  PF_CHECK_BUDGET_MS: '150',
  PF_DOWNLOAD_BUDGET_MS: '150',
  PF_PROBE_BUDGET_MS: '150',
  PF_POLL_WATCHDOG_MS: '200'
}

let bad = 0
for (const script of [drive, stagedDrive]) {
  // Captured rather than inherited so the sentinel can be insisted on. A drive that
  // exits 0 without printing it did not pass - it stopped.
  let out = ''
  try {
    out = execFileSync(process.execPath, [script], { encoding: 'utf8', cwd: work, env })
  } catch (e) {
    out = String(e.stdout ?? '')
    bad++
  }
  process.stdout.write(out)
  if (!/DRIVE DONE/.test(out)) {
    console.log(`FAIL ${script} stopped before the end of its checks`)
    bad++
  }
}

console.log(bad ? `\nFAILED (${bad} of 2)` : '\nOK - the updater cannot wedge itself into needing a person')
process.exit(bad ? 1 : 0)
