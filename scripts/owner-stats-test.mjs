// Owner-only release stats must fail closed: the desktop never has a bundled account or
// treats GitHub's asset downloads as people. Run with `node scripts/owner-stats-test.mjs`.

import { buildSync } from 'esbuild'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const work = join(tmpdir(), 'pf-owner-stats-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

writeFileSync(join(work, 'child-process-stub.cjs'), `
let script=[]; const calls=[]
function execFile(bin,args,opts,done){
  calls.push({bin,args,opts})
  const next=script.shift()||{error:{code:'ENOENT'},stdout:''}
  process.nextTick(()=>done(next.error?Object.assign(new Error('failed'),next.error):null,next.stdout||''))
}
module.exports={execFile,__set:v=>{script=v.slice();calls.length=0},__calls:calls}
`)

buildSync({
  absWorkingDir: ROOT,
  entryPoints: ['src/main/ownerStats.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: join(work, 'owner-stats.bundle.cjs'),
  external: ['node:child_process']
})

writeFileSync(join(work, 'drive.cjs'), `
const Module=require('node:module')
const load=Module._load
Module._load=function(r,...a){if(r==='node:child_process')return require('./child-process-stub.cjs');return load.call(this,r,...a)}
const cp=require('./child-process-stub.cjs')
const {ownerAccess,ownerStats}=require('./owner-stats.bundle.cjs')
const fail=[];const ok=(got,name)=>{console.log((got?'PASS ':'FAIL ')+name);if(!got)fail.push(name)}
const owner=JSON.stringify({id:100823588,login:'robertiuoras'})
const stranger=JSON.stringify({id:7,login:'someone-else'})
const releases=JSON.stringify([{tag_name:'v1',published_at:'2026-09-01T00:00:00Z',assets:[
  {name:'PaneForge-Setup-1.exe',download_count:4},{name:'PaneForge-1-arm64.dmg',download_count:3},
  {name:'latest.yml',download_count:900},{name:'PaneForge-1.exe.blockmap',download_count:800}
]}])
;(async()=>{
  cp.__set([{stdout:owner}])
  ok(await ownerAccess()===true,'authenticated owner is allowed')
  ok(cp.__calls[0].bin==='gh'&&cp.__calls[0].args.join(' ')==='api user','ownership uses the GitHub CLI user endpoint')

  cp.__set([{stdout:stranger}])
  ok(await ownerAccess()===false,'a different GitHub account is refused')

  cp.__set([{error:{code:'ENOENT'}}])
  ok(await ownerAccess()===false,'a missing GitHub CLI fails closed')

  cp.__set([{stdout:owner},{stdout:releases}])
  const stats=await ownerStats()
  ok(stats.login==='robertiuoras'&&stats.releases.length===1,'owner stats rechecks identity and returns releases')
  ok(stats.releases[0].windows===4&&stats.releases[0].mac===3,'only installer exe and dmg asset downloads are counted')
  ok(cp.__calls[1].args.includes('per_page=100'),'release lookup is explicitly bounded to 100 releases')

  cp.__set([{stdout:owner},{error:{code:1}}])
  await ownerStats().then(()=>ok(false,'a failed release fetch rejects'),e=>ok(/Could not read GitHub/.test(e.message),'a failed release fetch gives no partial stats'))
  console.log('DRIVE DONE '+fail.length)
  process.exit(fail.length?1:0)
})().catch(e=>{console.error(e);process.exit(1)})
`)

let output = ''
let failed = false
try {
  output = execFileSync(process.execPath, [join(work, 'drive.cjs')], { encoding: 'utf8', cwd: work })
} catch (error) {
  output = String(error.stdout ?? '')
  failed = true
}
process.stdout.write(output)
if (!/DRIVE DONE 0/.test(output)) failed = true
console.log(failed ? '\nFAILED' : '\nOK - owner stats fail closed and count only release installer assets')
process.exit(failed ? 1 : 0)
