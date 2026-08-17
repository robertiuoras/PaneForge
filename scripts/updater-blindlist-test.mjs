// The dev channel stands down when the releases LIST is up and lying.
//
// Measured on the desk PC 2026-08-17, and the reason this file exists:
// `GET /repos/robertiuoras/PaneForge/releases` answered 200 with an EMPTY array while
// its own Link header advertised eight further pages, and /releases/latest answered
// correctly the whole time. electron-updater's dev-channel path is
// `candidates.find(prerelease) || candidates[0]` over that array, so it returned
// undefined and the next line read `.assets` off it. Every poll threw
// `Cannot read properties of undefined (reading 'assets')`, once a minute, for 28 hours,
// on an install eleven versions behind - and nothing reported it, because an app that
// cannot see a newer version looks exactly like one that is up to date.
//
// The load-bearing half of this file is the two NEGATIVE cases. Standing the dev channel
// down is a real demotion - a dev install silently taking stable builds - so it must
// happen on exactly one fact: a 200 whose body is an empty array. A 500, a timeout, an
// unreadable body and a list with releases in it are all "cannot tell", and cannot-tell
// must leave the channel alone.
//
//   node scripts/updater-blindlist-test.mjs

import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-blindlist-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

writeFileSync(
  join(work, 'electron-stub.cjs'),
  `const fs=require('node:fs'),p=require('node:path')
const dir=__dirname
fs.writeFileSync(p.join(dir,'app-update.yml'),'provider: github\\n')
process.resourcesPath=dir
module.exports={app:{isPackaged:true,getVersion:()=>'0.3.6',getPath:()=>dir}}
`
)

// The real crash, reproduced: with allowPrerelease on, the stub answers the way
// electron-updater does when the list came back empty. With it off it resolves the way
// /releases/latest does, which kept working throughout the real incident.
writeFileSync(
  join(work, 'updater-stub.cjs'),
  `const handlers={},calls=[]
const au={autoDownload:false,autoInstallOnAppQuit:false,allowPrerelease:false,logger:null,
  checkForUpdates:async()=>{
    calls.push(au.allowPrerelease?'check:dev':'check:stable')
    if(au.allowPrerelease) throw new TypeError("Cannot read properties of undefined (reading 'assets')")
    // Null plus the event, not a version: a found update would leave the module
    // downloading and every later case would return early on its own busy guard, and a
    // silent null would leave the phase stuck on 'checking' for the same reason. This is
    // what electron-updater really does when the install is current.
    handlers['update-not-available']?.({version:'0.3.6'})
    return null},
  downloadUpdate:async()=>{calls.push('download')},
  quitAndInstall:()=>calls.push('install'),
  setFeedURL:()=>{},
  on:(e,cb)=>{handlers[e]=cb}}
module.exports={autoUpdater:au,__calls:calls,__au:au}
`
)

// URL-aware, unlike the one in updater-test.mjs: the whole point here is that two
// endpoints on the same host disagree about whether any releases exist.
writeFileSync(
  join(work, 'https-stub.cjs'),
  `const {EventEmitter}=require('node:events')
let listStatus=200,listBody='[]',hits=0
module.exports={
  __list:(status,body)=>{listStatus=status;listBody=body},
  __hits:()=>hits,
  __reset:()=>{hits=0},
  get:(url,_options,cb)=>{
    const req=new EventEmitter()
    req.destroy=(e)=>req.emit('error',e)
    const isList=String(url).includes('/releases?')
    if(isList)hits++
    process.nextTick(()=>{
      const res=new EventEmitter()
      res.statusCode=isList?listStatus:200
      res.setEncoding=()=>{}
      res.resume=()=>{}
      cb(res)
      if(res.statusCode===200){
        res.emit('data',isList?listBody:JSON.stringify({tag_name:'v0.3.9'}))
      }
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
module.exports={...real,execFile:(_cmd,args,_options,cb)=>process.nextTick(()=>cb(new Error('no gh in this test'),''))}
`
)

buildSync({
  absWorkingDir: root,
  entryPoints: ['src/main/updater.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'warning',
  outfile: join(work, 'updater.bundle.cjs'),
  external: ['electron', 'electron-updater']
})

const drive = join(work, 'drive.cjs')
writeFileSync(
  drive,
  `const path=require('node:path'),Module=require('node:module')
const orig=Module._resolveFilename, load=Module._load
Module._load=function(r,...a){
  if(r==='node:https')return require('./https-stub.cjs')
  if(r==='node:child_process')return require('./child-process-stub.cjs')
  return load.call(this,r,...a)}
Module._resolveFilename=function(r,...a){
  if(r==='electron')return path.join(__dirname,'electron-stub.cjs')
  if(r==='electron-updater')return path.join(__dirname,'updater-stub.cjs')
  return orig.call(this,r,...a)}
const https=require('./https-stub.cjs'), stub=require('./updater-stub.cjs'), u=require('./updater.bundle.cjs')

// One case per process, and not for tidiness: the module carries a phase state machine
// whose events are wired by an init this test does not call, so a check left in
// 'checking' makes the NEXT check return early on the busy guard. Four processes is the
// honest way to ask four independent questions of one module.
const run=async()=>{
  const dev=process.env.CASE_DEV==='1'
  u.setDevChannel(dev)
  https.__list(Number(process.env.CASE_STATUS),process.env.CASE_BODY)
  https.__reset()
  const s=await u.checkForUpdates()
  console.log(JSON.stringify({
    allowPrerelease:stub.__au.allowPrerelease,
    calls:stub.__calls,
    phase:s.phase,
    error:s.error??'',
    listHits:https.__hits()
  }))
}
run().catch((e)=>{console.error(e);process.exit(1)})
`
)

let failed = 0
let total = 0
const ok = (name, cond, detail) => {
  total++
  console.log(`${cond ? '  ok   ' : '  FAIL '}${name}`)
  if (!cond) {
    failed++
    if (detail !== undefined) console.log(`        ${detail}`)
  }
}

/** One check, in its own process, with the releases list answering as told. */
function check({ dev, status, body }) {
  const out = execFileSync(process.execPath, [drive], {
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      PF_BLIND_CACHE_MS: '0',
      CASE_DEV: dev ? '1' : '0',
      CASE_STATUS: String(status),
      CASE_BODY: body
    }
  })
  return JSON.parse(out.trim().split('\n').pop())
}

const LIST_WITH_RELEASES = '[{"tag_name":"v0.3.9","draft":false,"prerelease":true}]'

console.log('\n-- the list is up and lying --')
{
  const r = check({ dev: true, status: 200, body: '[]' })
  ok('an empty releases list stands the dev channel down', r.allowPrerelease === false, JSON.stringify(r))
  ok('so the check runs, instead of throwing every minute', r.calls.includes('check:stable'), JSON.stringify(r.calls))
  ok('and the poll does not end in the error card', r.phase !== 'error', `${r.phase} ${r.error}`)
  ok('the list was actually consulted', r.listHits > 0)
}

console.log('\n-- a list with releases in it is left alone --')
{
  const r = check({ dev: true, status: 200, body: LIST_WITH_RELEASES })
  ok('a working list keeps the dev channel', r.allowPrerelease === true, JSON.stringify(r))
  ok('and the dev path is what ran', r.calls.includes('check:dev'), JSON.stringify(r.calls))
}

console.log('\n-- cannot-tell must not change channel --')
{
  const r = check({ dev: true, status: 500, body: '' })
  ok('a failing releases API leaves the dev channel on', r.allowPrerelease === true, JSON.stringify(r))
}
{
  const r = check({ dev: true, status: 200, body: 'not json at all' })
  ok('an unreadable list leaves the dev channel on', r.allowPrerelease === true, JSON.stringify(r))
}

console.log('\n-- and a stable install never asks at all --')
{
  const r = check({ dev: false, status: 200, body: '[]' })
  ok('a stable install makes no extra request', r.listHits === 0, `hits=${r.listHits}`)
  ok('and is still on the stable path', r.allowPrerelease === false, JSON.stringify(r))
}

console.log(`\n${total - failed}/${total} checks passed`)
process.exit(failed ? 1 : 0)
