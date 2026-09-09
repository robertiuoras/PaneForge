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
import { readFileSync } from 'node:fs'
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
const {
  STALE_SUPERSEDES,
  STAGED_NAG_MS,
  updateIgnored,
  stagedHours,
  stagedTooLong,
  stagedWaitingWords
} = await import(pathToFileURL(outfile).href)

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

// --- and nothing restarts by itself ------------------------------------------------
//
// The count is a reading, not a trigger. 0.8.207 sat staged from 2026-09-08T02:28 to the
// 2026-09-09T02:30 launch - 23 hours across dozens of successful checks - and that is the
// rule working: a staged build installs on Restart now or an ordinary quit and on nothing
// else. `npm run test:updatehold` pins the same thing from the other side.
const mainUpdater = readFileSync(new URL('../src/main/updater.ts', import.meta.url), 'utf8')
const mainIndex = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
ok(!/READY_HOLD_MS/.test(mainUpdater + mainIndex), 'no ready-for-N-minutes rule takes a build on its own')
ok(!/onUpdateIgnored\(/.test(mainIndex), 'and nothing in the app listens for the ignored flag to restart')
ok(
  !/restarting into v/.test(mainUpdater),
  'the log does not promise a restart nobody will make - that is how 23 hours read as handled'
)
ok(
  /installs on the next quit or Restart now/.test(mainUpdater),
  'it says which build is waiting and what would install it'
)

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
const promises=require('node:fs/promises')
let staleResolve
const staleWritten=new Promise(resolve=>{staleResolve=resolve})
Module._load=function(r,...a){
  if(r==='node:fs/promises')return {...promises,appendFile:async(...args)=>{await promises.appendFile(...args);if(String(args[1]).includes('stale'))staleResolve()}}
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
  await staleWritten
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

// --- a build that has been ready for hours, with nobody told -------------------------
//
// 0.8.207 reached `state ready` at 2026-09-08T02:28:31 and the app was still running the
// old build when it was relaunched by hand at 2026-09-09T02:30:34. Nothing installed it
// because nothing may: this app takes a staged build on Restart now or on a quit, and no
// timer is allowed to tear down a working desk. What was missing is that the screen said
// the same sentence on hour one and on hour twenty-four, and Later had hidden it for good.
{
  const NOW = 1_800_000_000_000
  const HOUR = 3_600_000
  ok(!stagedTooLong(undefined, NOW), 'a build that never became ready has waited for nothing')
  ok(!stagedTooLong(NOW - HOUR, NOW), 'an hour is an ordinary wait and is not mentioned')
  ok(stagedTooLong(NOW - STAGED_NAG_MS, NOW), `past ${STAGED_NAG_MS / HOUR}h it is worth saying`)
  ok(stagedTooLong(NOW - 24 * HOUR, NOW), 'and a full day certainly is')
  ok(stagedHours(NOW - 24 * HOUR, NOW) === 24, 'the sentence counts whole hours')
  ok(stagedHours(NOW - HOUR - 1000, NOW) === 1, '...and never says nought hours')

  const words = stagedWaitingWords('0.8.206', '0.8.207', 24)
  ok(words.includes('24 hours') && words.includes('0.8.207'), 'the card names the build and the wait')
  ok(words.includes('Restart now'), '...and what ends the wait, in the words of the button underneath it')
  ok(
    !/staged|supersede|feed|installer/i.test(words),
    'and says none of it to somebody who has never used git'
  )
  ok(
    /never on its own while you are working/.test(words),
    'it also says what the app will NOT do, because that is the promise being kept'
  )
}

// Render the actual card with controlled hook state and clock, then invoke its buttons.
// This catches a reminder whose Later button stops hiding it after the age threshold.
{
  const { build } = await import('esbuild')
  const cardFile = join(OUT, 'update-toast-dismiss.mjs')
  const fixture = { values: [], cursor: 0, now: 1_800_000_000_000, update: null }
  globalThis.__updateToastFixture = fixture
  const previousWindow = globalThis.window
  globalThis.window = { api: {} }
  try {
    await build({
      entryPoints: [join(ROOT, 'src/renderer/src/components/UpdateToast.tsx')],
      outfile: cardFile, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
      alias: { '@shared': join(ROOT, 'src/shared') },
      external: ['react/jsx-runtime'],
      plugins: [{ name: 'card-fixture', setup(b) {
        b.onResolve({ filter: /^react$/ }, () => ({ path: 'hooks', namespace: 'fixture' }))
        b.onResolve({ filter: /^\.\/Elapsed$/ }, () => ({ path: 'clock', namespace: 'fixture' }))
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'clock'
          ? 'export const useNow = () => globalThis.__updateToastFixture.now'
          : `export default {}; export const useEffect = () => {};
             export function useState(initial) {
               const f = globalThis.__updateToastFixture, i = f.cursor++;
               if (!(i in f.values)) f.values[i] = initial;
               return [i === 0 ? f.update : f.values[i], value => { f.values[i] = value }];
             }`
        }))
      } }]
    })
    const { default: Card } = await import(pathToFileURL(cardFile).href)
    const render = () => { fixture.cursor = 0; return Card() }
    const later = card => card.props.children[2].props.children[0].props.onClick()
    fixture.update = { phase: 'ready', current: '0.8.206', version: '0.8.207', readyAt: fixture.now }
    let card = render()
    ok(!!card, 'a newly ready build displays its card')
    later(card)
    ok(render() === null, 'Later hides the initial card')
    fixture.now += STAGED_NAG_MS
    card = render()
    ok(!!card, 'the dismissed card returns when its wait reaches the reminder threshold')
    later(card)
    ok(render() === null, 'Later also hides the aged reminder')
    fixture.now += STAGED_NAG_MS
    ok(render() === null, 'a dismissed aged reminder stays hidden on later clock ticks')
    fixture.update = { ...fixture.update, version: '0.8.208' }
    card = render()
    ok(!!card, 'a different build is still allowed to show its own reminder')
    card.props.children[0].props.onDismiss()
    ok(render() === null, 'the close button also dismisses an aged reminder')
  } finally {
    globalThis.window = previousWindow
    delete globalThis.__updateToastFixture
  }
}

console.log(fail.length ? `\n${fail.length} failed` : '\nall good')
process.exit(fail.length ? 1 : 0)
