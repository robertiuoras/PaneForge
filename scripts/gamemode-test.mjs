// Test for "PaneForge keeps pulling me out of CS2".
//
// Measured cause, not a guess: a foreground-window probe sampling every 200ms sat on
// "Counter-Strike 2" for a 20s idle baseline with zero switches, then dropped to the
// desktop 5.3s after `npm run try` launched a second copy - a launch that only ever
// calls showInactive() and minimize(). On Windows an exclusive-fullscreen game loses
// the display to any window that appears, floats above it, or flashes, whether or not
// that window takes the keyboard.
//
// So src/main/gameMode.ts holds interruptions back while a game is running, and this
// asserts the part that is worth regressing: what counts as a game, that held work
// runs exactly once when the game exits, and that turning the feature off never
// strands a queued update restart forever.
//
// Runs the real module headlessly with `tasklist` stubbed, so the process list is
// something the test decides.
//
//   node scripts/gamemode-test.mjs

import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = join(tmpdir(), 'pf-gamemode-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

// Stands in for tasklist: same CSV shape (`"name","pid",...`), a list the test sets.
writeFileSync(
  join(work, 'cp-stub.cjs'),
  `const {EventEmitter}=require('node:events')
let list=[], calls=0
module.exports={
  spawn(){
    calls++
    const p=new EventEmitter()
    p.stdout=new EventEmitter()
    p.kill=()=>{}
    setImmediate(()=>{
      p.stdout.emit('data', list.map(n=>'"'+n+'","1234","Console","1","9,000 K"').join('\\r\\n'))
      p.emit('close',0)
    })
    return p
  },
  __set(l){list=l},
  __calls(){return calls}
}
`
)

// child_process stays a runtime require, then the require target is rewritten to point
// at the stub. A Module._resolveFilename hook (what the updater test uses) cannot do it
// here: `require('node:child_process')` is resolved as a builtin before any hook runs,
// so the first version of this test silently measured the real process list - and
// passed the "cs2 is running" assertions on this machine because CS2 really was.
// esbuild's own API, not its CLI: `node node_modules/esbuild/bin/esbuild` only works on
// Windows, where that path is a JS shim. On macOS and Linux it is the native binary.
buildSync({
  absWorkingDir: root,
  entryPoints: ['src/main/gameMode.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: join(work, 'gamemode.bundle.cjs'),
  external: ['node:child_process']
})

const bundle = join(work, 'gamemode.bundle.cjs')
const src = readFileSync(bundle, 'utf8')
const patched = src.replace(/require\((["'])node:child_process\1\)/g, `require("./cp-stub.cjs")`)
if (patched === src) {
  console.error('FAIL could not point gameMode.ts at the tasklist stub - the test would')
  console.error('     have measured this machine\'s real process list instead.')
  process.exit(1)
}
writeFileSync(bundle, patched)

const drive = join(work, 'drive.cjs')
writeFileSync(
  drive,
  `const cp=require('./cp-stub.cjs')
// gameMode.ts lists processes with tasklist, so it returns an empty set unless
// process.platform is win32 - off Windows every "a game is running" assertion would
// fail for that reason alone. The list it reads is the stub above, never the real
// machine's, so pinning the platform keeps the test deterministic everywhere.
Object.defineProperty(process,'platform',{value:'win32'})
const g=require('./gamemode.bundle.cjs')
const fail=[]
const ok=(c,n)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)fail.push(n)}
const cfg=(p)=>({gameMode:{enabled:true,processes:[],manual:false,...p}})

;(async()=>{
  // --- nothing playing -----------------------------------------------------
  g.startGameWatch(cfg())
  cp.__set(['explorer.exe','chrome.exe','PaneForge.exe'])
  await g.checkNow()
  ok(g.isGameActive()===false,'idle machine is not game mode')
  let ran=0
  ok(g.whenClear('a',()=>ran++)===true,'work runs straight away when nothing is playing')
  ok(ran===1,'and it really ran')

  // --- a game starts -------------------------------------------------------
  const seen=[]
  g.onGameState((s)=>seen.push(s.active))
  cp.__set(['explorer.exe','cs2.exe'])
  await g.checkNow()
  ok(g.isGameActive()===true,'cs2.exe from the built-in list turns game mode on')
  ok(g.gameState().game==='cs2.exe','the matched process is reported')
  ok(seen[seen.length-1]===true,'listeners hear the transition')

  let held=0
  ok(g.whenClear('update-install',()=>held++)===false,'an update restart is held, not run')
  ok(held===0,'held really means not run')
  g.whenClear('update-install',()=>held++)
  g.whenClear('update-install',()=>held++)
  ok(g.deferredCount()===1,'the same restart queued three times is still one restart')

  let other=0
  g.whenClear('window-reveal',()=>other++)
  ok(g.deferredCount()===2,'a different kind of held work queues alongside it')

  // --- the game exits ------------------------------------------------------
  cp.__set(['explorer.exe'])
  await g.checkNow()
  ok(g.isGameActive()===false,'game mode ends when the process is gone')
  ok(held===1,'the held restart runs once, not three times')
  ok(other===1,'and so does the held window')
  ok(g.deferredCount()===0,'queue is empty afterwards')

  // --- a game that is running but NOT on screen ---------------------------
  // The bug this covers: cs2.exe left open in the background is the normal state of this
  // machine, and the watchlist alone read that as "do not disturb" for the whole day. So
  // the update restart the user had already clicked sat queued forever and the sidebar
  // just said "quiet". Our own window having focus settles it - a fullscreen game does
  // not hold the display while another app owns the keyboard.
  g.refreshGameWatch(cfg())
  cp.__set(['explorer.exe','cs2.exe'])
  let focused=false
  g.setFocusProbe(()=>focused)
  await g.checkNow()
  ok(g.isGameActive()===true,'game on screen while our window is not focused')
  let queued=0
  g.whenClear('update-install',()=>queued++)
  ok(queued===0,'and the restart is queued')
  focused=true
  const listings=cp.__calls()
  await g.checkNow()
  ok(g.isGameActive()===false,'the same running game does NOT hold do-not-disturb once our window has focus')
  ok(queued===1,'and the queued restart is released the moment it does')
  ok(cp.__calls()===listings,'focused costs no process listing either')
  // Manual do-not-disturb is a decision, not a guess about the screen: focus must not
  // override it, or the switch would do nothing while the app is being used.
  g.refreshGameWatch(cfg({manual:true}))
  await g.checkNow()
  ok(g.isGameActive()===true,'manual do-not-disturb still wins while focused')
  // A probe that throws is not allowed to be the reason interruptions get through.
  g.refreshGameWatch(cfg())
  g.setFocusProbe(()=>{throw new Error('window gone')})
  await g.checkNow()
  ok(g.isGameActive()===true,'a focus probe that throws falls back to holding')
  g.setFocusProbe(null)
  await g.checkNow()
  ok(g.isGameActive()===true,'and so does no probe at all')

  // --- a custom watchlist --------------------------------------------------
  g.refreshGameWatch(cfg({processes:['someindiegame.exe']}))
  cp.__set(['cs2.exe'])
  await g.checkNow()
  ok(g.isGameActive()===false,'a custom list replaces the built-in one')
  cp.__set(['someindiegame.exe'])
  await g.checkNow()
  ok(g.isGameActive()===true,'and matches what is actually in it')
  ok(g.gameState().game==='someindiegame.exe','reporting the custom process')

  // Case is what Task Manager shows, not what the user typed.
  g.refreshGameWatch(cfg({processes:['MyGame.EXE']}))
  cp.__set(['mygame.exe'])
  await g.checkNow()
  ok(g.isGameActive()===true,'watchlist matching ignores case')

  // --- manual do not disturb ----------------------------------------------
  const before=cp.__calls()
  g.refreshGameWatch(cfg({manual:true}))
  await g.checkNow()
  ok(g.isGameActive()===true,'manual do-not-disturb is on with no game running')
  ok(cp.__calls()===before,'and costs no process listing at all')

  // --- turning it off must not strand held work ---------------------------
  let stranded=0
  g.refreshGameWatch(cfg({manual:true}))
  await g.checkNow()
  g.whenClear('update-install',()=>stranded++)
  ok(stranded===0,'queued while do-not-disturb is on')
  g.refreshGameWatch({gameMode:{enabled:false,processes:[],manual:false}})
  ok(stranded===1,'turning the feature off releases what it was holding')
  ok(g.isGameActive()===false,'and game mode is off')

  // --- cancel ------------------------------------------------------------
  g.refreshGameWatch(cfg())
  cp.__set(['cs2.exe'])
  await g.checkNow()
  let cancelled=0
  g.whenClear('update-install',()=>cancelled++)
  g.cancelDeferred('update-install')
  ok(g.deferredCount()===0,'a cancelled item leaves the queue')
  cp.__set([])
  await g.checkNow()
  ok(cancelled===0,'and never runs')

  // --- a tasklist that never answers --------------------------------------
  g.stopGameWatch()
  console.log(fail.length?('\\n'+fail.length+' FAILED: '+fail.join(', ')):'\\nall green')
  process.exit(fail.length?1:0)
})()
`
)

let out = ''
let code = 0
try {
  out = execFileSync(process.execPath, [drive], { cwd: root, encoding: 'utf8' })
} catch (e) {
  out = String(e.stdout ?? '') + String(e.stderr ?? '')
  code = 1
}
process.stdout.write(out)
rmSync(work, { recursive: true, force: true })
process.exit(code)
