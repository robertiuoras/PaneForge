// The macOS update that used to be a manual download from GitHub.
//
// The app is unsigned, so Squirrel.Mac refuses to install its own releases and every Mac
// version arrived as "0.3.x is out" plus a link. `src/main/macUpdate.ts` does it without
// Squirrel: expand the release zip, then move the folder into place from a detached shell
// script once the app's process is gone.
//
// Moving the running app aside is the one thing here that can leave a Mac with no
// PaneForge at all, so this drives the real code against real folders: a real zip made
// with ditto, a real fake bundle in /Applications' place, the real swap script, and a fake
// `open` on PATH to prove the relaunch was asked for - and asked for with -g, because a
// relaunch that takes the screen is the thing this app must never do.
//
//   node scripts/mac-update-test.mjs

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

if (process.platform !== 'darwin') {
  console.log('SKIP mac-update-test: ditto/open/xattr are macOS only')
  process.exit(0)
}

const work = mkdtempSync(join(tmpdir(), 'pf-mac-update-test-'))

// Stub electron: userData is a throwaway dir, and the app claims to be the packaged 1.0.0.
writeFileSync(
  join(work, 'electron-stub.cjs'),
  `const p=require('node:path')
module.exports={app:{isPackaged:true,getVersion:()=>'1.0.0',getPath:()=>p.join(__dirname,'userData')}}
`
)
writeFileSync(
  join(work, 'electron-clear-stub.cjs'),
  `const p=require('node:path')
module.exports={app:{isPackaged:true,getVersion:()=>'1.0.0',getPath:()=>p.join(__dirname,'clear-userData')}}
`
)

buildSync({
  absWorkingDir: root,
  entryPoints: ['src/main/macUpdate.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: join(work, 'macUpdate.bundle.cjs'),
  external: ['electron']
})

// Electron patches `fs` so an app.asar file can be read like a directory. Recursive
// deletion must still remove a staged Electron bundle when a newer release supersedes
// it. Run this case inside Electron itself: plain Node does not expose that filesystem
// behaviour and let the live ENOTDIR regression pass unnoticed.
const clearRelease = join(work, 'clear-release')
const clearBundle = join(clearRelease, 'PaneForge.app')
mkdirSync(join(clearBundle, 'Contents', 'Resources'), { recursive: true })
writeFileSync(
  join(clearBundle, 'Contents', 'Info.plist'),
  '<plist><dict><key>CFBundleShortVersionString</key><string>2.0.0</string></dict></plist>'
)
const asarSource = join(work, 'asar-source')
mkdirSync(asarSource)
writeFileSync(join(asarSource, 'package.json'), '{}')
execFileSync(process.execPath, [join(root, 'node_modules', '@electron', 'asar', 'bin', 'asar.js'), 'pack', asarSource,
  join(clearBundle, 'Contents', 'Resources', 'app.asar')])
const clearZip = join(work, 'clear-release.zip')
execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', clearBundle, clearZip])
const replacementRelease = join(work, 'replacement-release')
const replacementBundle = join(replacementRelease, 'PaneForge.app')
mkdirSync(replacementRelease)
execFileSync('/usr/bin/ditto', [clearBundle, replacementBundle])
writeFileSync(
  join(replacementBundle, 'Contents', 'Info.plist'),
  '<plist><dict><key>CFBundleShortVersionString</key><string>3.0.0</string></dict></plist>'
)
const replacementZip = join(work, 'replacement-release.zip')
execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', replacementBundle, replacementZip])
const clearDrive = join(work, 'clear-drive.cjs')
writeFileSync(
  clearDrive,
  `const path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto'),Module=require('node:module')
const {EventEmitter}=require('node:events'),{Readable}=require('node:stream')
const orig=Module._resolveFilename
const load=Module._load
let badChecksum=false
const zips={'2.0.0':${JSON.stringify(clearZip)},'3.0.0':${JSON.stringify(replacementZip)}}
const https={
  __bad:(v)=>{badChecksum=v},
  get:(url,_options,cb)=>{
    const req=new EventEmitter();req.destroy=(e)=>req.emit('error',e)
    const version=String(url).split('/download/v')[1]?.split('/')[0]||''
    const zip=zips[version],zipBody=zip?fs.readFileSync(zip):Buffer.alloc(0)
    const body=url.endsWith('latest-mac.yml')
      ?Buffer.from('files:\\n  - url: PaneForge-'+version+'-'+process.arch+'.zip\\n    sha512: '+(badChecksum?'wrong':crypto.createHash('sha512').update(zipBody).digest('base64'))+'\\n')
      :zipBody
    process.nextTick(()=>{const res=Readable.from([body]);res.statusCode=200;res.headers={'content-length':String(body.length)};cb(res)})
    return req
  }
}
Module._load=function(r,...a){if(r==='node:https')return https;return load.call(this,r,...a)}
Module._resolveFilename=function(r,...a){
  if(r==='electron')return path.join(__dirname,'electron-clear-stub.cjs')
  return orig.call(this,r,...a)}
const m=require('./macUpdate.bundle.cjs')
m.setMacUpdateLog(()=>{})
;(async()=>{
  await m.stageMacUpdate('2.0.0',()=>{})
  const old=path.join(__dirname,'clear-userData','mac-update','2.0.0')
  https.__bad(true)
  let failed=false
  try{await m.stageMacUpdate('3.0.0',()=>{})}catch{failed=true}
  const kept=failed&&m.staged()==='2.0.0'&&fs.existsSync(old)
  console.log((kept?'PASS ':'FAIL ')+'a failed supersede preserves the validated older bundle')
  https.__bad(false)
  await m.stageMacUpdate('3.0.0',()=>{})
  const replaced=m.staged()==='3.0.0'&&!fs.existsSync(old)&&fs.existsSync(path.join(__dirname,'clear-userData','mac-update','3.0.0'))
  console.log((replaced?'PASS ':'FAIL ')+'a validated newer app.asar bundle replaces the older stage inside Electron')
  process.exit(kept&&replaced?0:1)
})().catch((e)=>{console.log('FAIL Electron staged replacement: '+(e.message||e));process.exit(1)})
`
)

const drive = join(work, 'drive.cjs')
writeFileSync(
  drive,
  `const path=require('node:path'),fs=require('node:fs'),cp=require('node:child_process'),Module=require('node:module')
const orig=Module._resolveFilename
Module._resolveFilename=function(r,...a){
  if(r==='electron')return path.join(__dirname,'electron-stub.cjs')
  return orig.call(this,r,...a)}

const dir=__dirname
const fail=[]
const ok=(c,n)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)fail.push(n)}

// A bundle is a folder, so a believable one is a folder: Info.plist with the version the
// staging check reads, and an executable three levels below the .app like a real one.
const makeBundle=(at,version)=>{
  fs.mkdirSync(path.join(at,'Contents','MacOS'),{recursive:true})
  fs.writeFileSync(path.join(at,'Contents','Info.plist'),
    '<plist><dict><key>CFBundleShortVersionString</key><string>'+version+'</string></dict></plist>')
  fs.writeFileSync(path.join(at,'Contents','MacOS','PaneForge'),'#!/bin/sh\\necho '+version+'\\n',{mode:0o755})
  // A framework symlink, because ditto keeps these and unzip flattens them into copies -
  // which is a bundle that looks fine in Finder and cannot launch.
  const fw=path.join(at,'Contents','Frameworks','Electron Framework.framework','Versions')
  fs.mkdirSync(path.join(fw,'A'),{recursive:true})
  fs.symlinkSync('A',path.join(fw,'Current'))
  return at
}

// The "release": PaneForge.app 2.0.0, zipped the way electron-builder does it.
const src=path.join(dir,'release')
fs.mkdirSync(src,{recursive:true})
makeBundle(path.join(src,'PaneForge.app'),'2.0.0')
const zip=path.join(dir,'PaneForge-2.0.0-arm64.zip')
cp.execFileSync('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',path.join(src,'PaneForge.app'),zip])

// The installed app: /Applications stands in as a writable temp folder, and process.execPath
// points inside it exactly as it does in the real app.
const apps=path.join(dir,'Applications')
fs.mkdirSync(apps,{recursive:true})
const installed=path.join(apps,'PaneForge.app')
makeBundle(installed,'1.0.0')
Object.defineProperty(process,'execPath',{value:path.join(installed,'Contents','MacOS','PaneForge')})

// A fake \`open\` ahead of the real one on PATH, so the relaunch is recorded instead of
// actually starting an app on this desk.
const bin=path.join(dir,'bin')
fs.mkdirSync(bin,{recursive:true})
const opened=path.join(dir,'opened.txt')
fs.writeFileSync(path.join(bin,'open'),'#!/bin/sh\\necho "$@" >> '+JSON.stringify(opened)+'\\n',{mode:0o755})
process.env.PATH=bin+':'+process.env.PATH

const m=require('./macUpdate.bundle.cjs')
m.setMacUpdateLog(()=>{})

ok(m.bundlePath()===installed,'finds the running bundle from execPath')
ok(m.assetFor('2.0.0')==='PaneForge-2.0.0-'+process.arch+'.zip','asks for this arch\\'s zip')
ok(m.canSwap()===(process.arch==='arm64'),'writable arm64 install can swap itself')

;(async()=>{
  // A zip for another release must never be staged: that is how you install 0.3.44 over
  // 0.3.51 and call it an update.
  let threw=''
  try{ await m.stageFromZip(zip,'2.0.1') }catch(e){ threw=String(e.message||e) }
  ok(/contains 2\\.0\\.0/.test(threw),'refuses a zip whose bundle is another version')

  // A truncated download expands to nothing at all. Checked before the good one, because
  // staging clears the folder first: a failed attempt discards whatever was waiting there.
  const bad=path.join(dir,'bad.zip')
  fs.writeFileSync(bad,fs.readFileSync(zip).subarray(0,400))
  threw=''
  try{ await m.stageFromZip(bad,'2.0.0') }catch(e){ threw=String(e.message||e) }
  ok(threw!=='','refuses a truncated zip')

  const stagedApp=await m.stageFromZip(zip,'2.0.0')
  ok(fs.existsSync(path.join(stagedApp,'Contents','MacOS','PaneForge')),'expands the bundle')
  ok(fs.lstatSync(path.join(stagedApp,'Contents','Frameworks','Electron Framework.framework','Versions','Current')).isSymbolicLink(),
     'framework symlinks survive the expand (ditto, not unzip)')

  // Nothing is staged as far as the module is concerned until stageMacUpdate says so, so
  // adoptStaged is what a restarted app uses to find the folder from last time.
  ok(m.adoptStaged()==='2.0.0','adopts a bundle staged by an earlier run')
  ok(m.staged()==='2.0.0','reports the staged version')

  // The swap. This process is alive, so the script must wait rather than move anything.
  ok(m.swapAndRelaunch()===true,'swap starts')
  await new Promise((r)=>setTimeout(r,1200))
  ok(read(path.join(installed,'Contents','Info.plist')).includes('1.0.0'),
     'the running bundle is NOT replaced while its process is alive')

  // Now let it happen: rerun the script it wrote, with a pid that is already gone.
  const script=path.join(dir,'userData','mac-update','swap.sh')
  const body=read(script).replace(new RegExp('kill -0 '+process.pid,'g'),'kill -0 999999')
  fs.writeFileSync(script,body,{mode:0o755})
  cp.execFileSync('/bin/sh',[script],{env:process.env})

  ok(read(path.join(installed,'Contents','Info.plist')).includes('2.0.0'),'the new version is in place')
  ok(!fs.existsSync(installed+'.pf-old'),'the old bundle is cleaned up')
  ok(fs.existsSync(path.join(installed,'Contents','Frameworks','Electron Framework.framework','Versions','Current')),
     'the swapped-in bundle is whole')
  const args=read(opened)
  ok(/-g/.test(args),'relaunch is backgrounded (-g) - an update never takes the screen')
  ok(args.includes(installed),'relaunches the app that was just replaced')

  // The failure that must leave a working app: a swap whose staged bundle is gone.
  fs.rmSync(path.join(dir,'userData','mac-update','2.0.0'),{recursive:true,force:true})
  const again=read(script)
  fs.writeFileSync(script,again,{mode:0o755})
  try{ cp.execFileSync('/bin/sh',[script],{env:process.env}) }catch{}
  ok(fs.existsSync(path.join(installed,'Contents','MacOS','PaneForge')),'a failed swap leaves the app installed')

  // Quitting the app installs a staged update too, and that one must NOT reopen it: the
  // user closed PaneForge on purpose. Same swap, no \`open\`.
  await m.stageFromZip(zip,'2.0.0')
  m.adoptStaged()
  ok(m.swapAndRelaunch(false)===true,'the quit path swaps as well')
  ok(!/\\bopen -g\\b/.test(read(script)),'a swap on quit does not reopen the app')

  console.log(fail.length?('\\n'+fail.length+' FAILED: '+fail.join(', ')):'\\nall green')
  process.exit(fail.length?1:0)
})()

function read(f){ try{ return fs.readFileSync(f,'utf8') }catch{ return '' } }
`
)

// `--live <version>` proves the other half against the real release: the download URL, the
// published sha512, and that the zip GitHub serves expands to the version it claims. Left
// out of `npm run test:macupdate` because it pulls ~120 MB.
const live = process.argv.indexOf('--live')
if (live !== -1) {
  const version = process.argv[live + 1] || ''
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    console.log('usage: node scripts/mac-update-test.mjs --live <version>')
    process.exit(1)
  }
  writeFileSync(
    join(work, 'live.cjs'),
    `const path=require('node:path'),Module=require('node:module')
const orig=Module._resolveFilename
Module._resolveFilename=function(r,...a){
  if(r==='electron')return path.join(__dirname,'electron-stub.cjs')
  return orig.call(this,r,...a)}
const m=require('./macUpdate.bundle.cjs')
m.setMacUpdateLog((...p)=>console.log('   ',...p))
let last=-1
m.stageMacUpdate(${JSON.stringify(version)},(p)=>{if(p%20===0&&p!==last){last=p;console.log('    '+p+'%')}})
  .then(()=>{console.log('PASS real release '+${JSON.stringify(version)}+' downloaded, checksummed and expanded');console.log('\\nall green')})
  .catch((e)=>{console.log('FAIL '+(e.message||e));process.exit(1)})
`
  )
  let liveOut = ''
  try {
    liveOut = execFileSync(process.execPath, [join(work, 'live.cjs')], { cwd: root, encoding: 'utf8' })
  } catch (e) {
    liveOut = String(e.stdout ?? '') + String(e.stderr ?? '')
  }
  process.stdout.write(liveOut)
  rmSync(work, { recursive: true, force: true })
  process.exit(/all green/.test(liveOut) ? 0 : 1)
}

let out = ''
try {
  const electronBin = createRequire(import.meta.url)('electron')
  out += execFileSync(electronBin, [clearDrive], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
} catch (e) {
  out += String(e.stdout ?? '') + String(e.stderr ?? '')
}
try {
  out += execFileSync(process.execPath, [drive], { cwd: root, encoding: 'utf8' })
} catch (e) {
  out += String(e.stdout ?? '') + String(e.stderr ?? '')
}
process.stdout.write(out)
rmSync(work, { recursive: true, force: true })
if (!/all green/.test(out) ||
    !/PASS a failed supersede preserves the validated older bundle/.test(out) ||
    !/PASS a validated newer app\.asar bundle replaces the older stage inside Electron/.test(out)) process.exit(1)
