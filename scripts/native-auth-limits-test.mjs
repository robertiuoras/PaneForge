import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = mkdtempSync(join(tmpdir(), 'pf-native-limits-'))
try {
  const file = join(out, 'auth.mjs')
  await build({entryPoints:[join(root,'src/main/nativeAuth.ts')],bundle:true,platform:'node',format:'esm',outfile:file,logLevel:'warning'})
  const { NativeAuth } = await import(pathToFileURL(file).href)
  let receipts=[]
  const auth=new NativeAuth(()=>[],()=>{},()=> 'v1',()=> 'host.test',()=>receipts,next=>{receipts=next},()=>true)
  const input={codeChallenge:createHash('sha256').update('v'.repeat(64)).digest('base64url'),state:'s'.repeat(32),deviceId:'d'.repeat(32),deviceName:'Phone'}
  const first=auth.start(input,'192.0.2.1')
  assert.throws(()=>auth.start({...input,deviceId:'e'.repeat(32)},'192.0.2.1'),/already pending/)
  const replacement=auth.start(input,'192.0.2.1')
  assert.equal(auth.pendingForBrowser(first.request),null)
  assert.ok(auth.pendingForBrowser(replacement.request))
  auth.approve(replacement.request,auth.csrfFor(replacement.request),'browser',['read'])
  assert.throws(()=>auth.start(input,'192.0.2.1'),/already pending/)
  assert.ok(auth.pendingForBrowser(replacement.request),'approved code survives a competing start')
  const grant={id:'grant',deviceId:'device'}
  const receipt=auth.acceptPrompt(grant,'original','session','preserved prompt')
  receipts=[receipt,...Array.from({length:4999},(_,i)=>({...receipt,clientMessageId:'id-'+i}))]
  assert.throws(()=>auth.acceptPrompt(grant,'new','session','new prompt'),/capacity/)
  assert.equal(receipts.length,5000)
  assert.equal(auth.acceptPrompt(grant,'original','session','preserved prompt'),receipt)
  assert.equal(auth.markPrompt(grant,'original','queued').state,'queued')
  assert.throws(()=>auth.acceptPrompt(grant,'original','session','changed prompt'),/conflict/)
  console.log('PASS: source/device pending isolation, approved request retention, receipt capacity, replay and state persistence')
} finally { rmSync(out,{recursive:true,force:true}) }
