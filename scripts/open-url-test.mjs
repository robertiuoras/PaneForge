// A link that would not open, and said so to nobody.
//
// paneforge-errors.log: `unhandledRejection: Error: Failed to open URL` at 2026-08-11
// 03:08:02, 03:57:13, 06:10:51 and 2026-08-19 10:33:42. Four occurrences, no retry line,
// no success line, and - the part that made them undiagnosable - no URL. Four occurrences
// of nothing.
//
//   node scripts/open-url-test.mjs

import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const OUT = join(ROOT, 'node_modules', '.pf-test')
mkdirSync(OUT, { recursive: true })

const fail = []
const ok = (c, n) => {
  console.log((c ? 'PASS ' : 'FAIL ') + n)
  if (!c) fail.push(n)
}

// --- the words ---------------------------------------------------------------
const wordsFile = join(OUT, 'open-url.mjs')
buildSync({
  entryPoints: [join(ROOT, 'src/shared/openUrl.ts')],
  outfile: wordsFile,
  bundle: true,
  format: 'esm',
  platform: 'node'
})
const { linkFailedWords, pathFailedWords, shortUrl } = await import(pathToFileURL(wordsFile).href)

const url = 'https://github.com/robertiuoras/PaneForge/releases/tag/v0.8.188'
const said = linkFailedWords(url)
ok(said.includes(url), 'the toast names the link, which is the whole thing the log was missing')
ok(said.includes('clipboard'), 'and names the recovery: it is one paste away')
for (const word in { unhandledRejection: 1, 'openExternal': 1, 'shell': 1, 'ENOENT': 1 }) {
  ok(!said.includes(word), `and does not say "${word}" to somebody who has never coded`)
}

// A data: URL or a signed link is longer than any toast. The END identifies a link, so
// the middle is what goes.
const long = `https://example.com/${'a'.repeat(400)}/end.html`
ok(shortUrl(long).length < 100, `a very long link is cut to fit (${shortUrl(long).length})`)
ok(shortUrl(long).endsWith('end.html'), 'and keeps its end, which is the part that identifies it')
ok(shortUrl(url) === url, 'an ordinary link is left alone')
ok(pathFailedWords('/Users/x/Projects', 'no such folder').includes('no such folder'), 'a folder failure carries the reason the OS gave')

// --- the wiring --------------------------------------------------------------
//
// openPath is the one that cannot be caught by a try/catch OR by a .catch: it RESOLVES
// with an error string and resolves with '' when it worked. Failure and success were the
// same value shape, which is the thing that renders as success.
const work = join(tmpdir(), 'pf-open-url-test')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

writeFileSync(
  join(work, 'electron-stub.cjs'),
  `let extFail=null,pathAnswer=''
const copied=[]
module.exports={
  app:{getPath:()=>__dirname},
  clipboard:{writeText:(t)=>copied.push(t)},
  shell:{
    openExternal:(u)=>extFail?Promise.reject(new Error(extFail)):Promise.resolve(),
    openPath:()=>Promise.resolve(pathAnswer)
  },
  __copied:copied,
  __extFail:(m)=>{extFail=m},
  __pathAnswer:(m)=>{pathAnswer=m}
}`
)

buildSync({
  absWorkingDir: ROOT,
  entryPoints: ['src/main/openUrl.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: join(work, 'open-url.bundle.cjs'),
  external: ['electron']
})

writeFileSync(
  join(work, 'drive.cjs'),
  `const path=require('node:path'),fs=require('node:fs'),Module=require('node:module')
const orig=Module._resolveFilename
Module._resolveFilename=function(r,...a){
  if(r==='electron')return path.join(__dirname,'electron-stub.cjs')
  return orig.call(this,r,...a)}
const el=require('./electron-stub.cjs')
const m=require('./open-url.bundle.cjs')
const fail=[]
const ok=(c,n)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)fail.push(n)}
const alive=setInterval(()=>{},20)
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
const told=[]
m.onOpenProblem((msg)=>told.push(msg))
const logFile=path.join(__dirname,'paneforge-errors.log')
const logged=()=>{try{return fs.readFileSync(logFile,'utf8')}catch{return ''}}
const URL='https://github.com/robertiuoras/PaneForge/releases/tag/v0.8.188'
;(async()=>{
  // Nothing to say when it works.
  m.openLink(URL,'a link in a pane')
  await sleep(50)
  ok(told.length===0,'a link that opens says nothing')

  el.__extFail('Failed to open URL')
  m.openLink(URL,'a link in a pane')
  await sleep(50)
  ok(told.length===1,'a link that will not open reaches the screen')
  ok(told[0].includes(URL),'and the person is told which link')
  ok(el.__copied[0]===URL,'and the link is put on the clipboard, so there is something to do about it')
  ok(logged().includes(URL),'the log line carries the URL - four of these were undiagnosable without it')
  ok(logged().includes('a link in a pane'),'and which press it came from')

  // The silent half: openPath answers with a string, and '' is the success.
  el.__pathAnswer('')
  m.openLocal('/Users/x/Projects','reveal')
  await sleep(50)
  ok(told.length===1,'a folder that opens says nothing')
  el.__pathAnswer('Failed to open path')
  m.openLocal('/Users/x/Projects','reveal')
  await sleep(50)
  ok(told.length===2,'a folder that does not open is not silent any more')
  ok(logged().includes('/Users/x/Projects'),'and the log names the folder')

  clearInterval(alive)
  console.log('DRIVE DONE '+fail.length)
  process.exit(fail.length?1:0)
})()
`
)

let out = ''
try {
  out = execFileSync(process.execPath, [join(work, 'drive.cjs')], { encoding: 'utf8', cwd: work })
} catch (e) {
  out = String(e.stdout ?? '')
  process.stderr.write(String(e.stderr ?? ''))
  fail.push('the wiring')
}
process.stdout.write(out)
if (!/DRIVE DONE/.test(out)) {
  console.log('FAIL the drive stopped before the end of its checks')
  fail.push('drive')
}

console.log(fail.length ? `\n${fail.length} failed` : '\nOK - a link that will not open names itself')
process.exit(fail.length ? 1 : 0)
