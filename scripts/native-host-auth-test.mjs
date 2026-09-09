import { build } from 'esbuild'
import { createHmac } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { Script } from 'node:vm'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = mkdtempSync(join(tmpdir(), 'pf-native-auth-'))
let checks = 0, failures = 0
const ok = (name, pass) => { checks++; console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}`); if (!pass) failures++ }
const throws = (fn) => { try { fn(); return false } catch { return true } }
try {
  const profile = join(out, 'profile')
  const entry = join(out, 'entry.ts')
  writeFileSync(entry, `export { NativeAuth } from ${JSON.stringify(join(root, 'src/main/nativeAuth.ts').replace(/\\/g, '/'))}; export { noteNativeAccepted, owedCount, forgetQueuedPrompts } from ${JSON.stringify(join(root, 'src/main/queuedPrompts.ts').replace(/\\/g, '/'))}; export { PhoneServer } from ${JSON.stringify(join(root, 'src/main/phone.ts').replace(/\\/g, '/'))}`)
  const file = join(out, 'native-auth.mjs')
  await build({ absWorkingDir: root, entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: file, logLevel: 'warning', plugins:[{name:'isolated-profile',setup(b){b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const app={getPath:()=>${JSON.stringify(profile)}}`,loader:'js'}));}}] })
  const { NativeAuth, PhoneServer, noteNativeAccepted, owedCount, forgetQueuedPrompts } = await import(pathToFileURL(file).href)
  const queueKey = noteNativeAccepted('fixture-pane', 'exact \n  prompt\n', '/fixture')
  const persisted = JSON.parse(readFileSync(join(profile,'queued-prompts.json'),'utf8'))
  ok('native queue writes exact prompt before acknowledgement', persisted[queueKey]?.text === 'exact \n  prompt\n')
  forgetQueuedPrompts()
  ok('native queue survives an empty memory cache', owedCount('fixture-pane') === 1)
  renameSync(profile,profile+'.saved');writeFileSync(profile,'not a directory')
  ok('native queue disk failure throws without changing cached ledger', throws(()=>noteNativeAccepted('fixture-pane','not accepted')) && owedCount('fixture-pane')===1)
  rmSync(profile);renameSync(profile+'.saved',profile)
  let grants = []
  let authReceipts = []
  let version = 'v1'
  const browsers = new Set(['browser-1', 'browser-2'])
  const browserExists = (id) => browsers.has(id)
  const auth = new NativeAuth(() => grants, (next) => { grants = next }, () => version, () => 'host.test', () => authReceipts, (next) => { authReceipts = next }, browserExists)
  const verifier = 'v'.repeat(64)
  const challenge = (await import('node:crypto')).createHash('sha256').update(verifier).digest('base64url')
  const start = auth.start({ codeChallenge: challenge, state: 's'.repeat(64), deviceId: 'd'.repeat(64), deviceName: 'Robert phone' })
  ok('start returns the exact authorize path', start.authorizationUrl === `https://host.test/pf/native/v1/auth/authorize?request=${encodeURIComponent(start.request)}`)
  ok('bad PKCE is refused', throws(() => auth.start({ codeChallenge: 'bad', state: 's'.repeat(64), deviceId: 'd'.repeat(64), deviceName: 'x' })))
  ok('approval needs CSRF', throws(() => auth.approve(start.request, 'bad', 'browser-1', ['read'])))
  const csrf = auth.csrfFor(start.request)
  const approval = auth.approve(start.request, csrf, 'browser-1', ['read', 'control'])
  ok('oversized or incorrect verifier is refused without burning the bound code', throws(() => auth.exchange(approval.code, 'w'.repeat(129), 'd'.repeat(64))) && throws(() => auth.exchange(approval.code, 'w'.repeat(64), 'd'.repeat(64))))
  auth.exchange(approval.code, verifier, 'd'.repeat(64))
  ok('a successfully exchanged code cannot be replayed', throws(() => auth.exchange(approval.code, verifier, 'd'.repeat(64))))
  const second = auth.start({ codeChallenge: challenge, state: 't'.repeat(64), deviceId: 'e'.repeat(64), deviceName: 'Robert phone' })
  const secondApproval = auth.approve(second.request, auth.csrfFor(second.request), 'browser-1', ['read'])
  const token = auth.exchange(secondApproval.code, verifier, 'e'.repeat(64))
  ok('opaque bearer grants requested read scope', !!auth.bearer(token.accessToken, 'read'))
  ok('read bearer cannot control', !auth.bearer(token.accessToken, 'control'))
  ok('native bearer is not cookie shaped', !/^pf=/.test(token.accessToken))
  ok('self revocation immediately denies bearer', auth.revoke(token.accessToken) && !auth.bearer(token.accessToken, 'read'))
  const receiptStart = auth.start({ codeChallenge: challenge, state: 'r'.repeat(64), deviceId: 'g'.repeat(64), deviceName: 'Robert phone' })
  const receiptApproval = auth.approve(receiptStart.request, auth.csrfFor(receiptStart.request), 'browser-1', ['read', 'control'])
  const receiptToken = auth.exchange(receiptApproval.code, verifier, 'g'.repeat(64))
  const receiptGrant = auth.bearer(receiptToken.accessToken, 'control')
  const firstReceipt = auth.acceptPrompt(receiptGrant, 'message-12345678', 'session-1', 'never send this twice')
  const restarted = new NativeAuth(() => grants, (next) => { grants = next }, () => version, () => 'host.test', () => authReceipts, (next) => { authReceipts = next }, browserExists)
  ok('durable receipt survives a fresh auth instance', firstReceipt.state === 'pending' && restarted.acceptPrompt(receiptGrant, 'message-12345678', 'session-1', 'never send this twice').acceptedAt === firstReceipt.acceptedAt)
  ok('same receipt id with different text is refused', throws(() => restarted.acceptPrompt(receiptGrant, 'message-12345678', 'session-1', 'different text')))
  ok('receipt is marked queued only after manager acceptance', restarted.markPrompt(receiptGrant, 'message-12345678', 'queued').state === 'queued')
  const refusing = new NativeAuth(() => grants, () => {}, () => version, () => 'host.test', () => [], () => { throw new Error('disk full') }, browserExists)
  ok('receipt save failure is fail-closed before enqueue', throws(() => refusing.acceptPrompt(receiptGrant, 'message-87654321', 'session-1', 'do not enqueue')))
  auth.revoke(receiptToken.accessToken)
  const repaired = auth.start({ codeChallenge:challenge, state:'z'.repeat(64), deviceId:'g'.repeat(64), deviceName:'Phone' })
  const repairedApproval = auth.approve(repaired.request, auth.csrfFor(repaired.request), 'browser-1', ['read','control'])
  const repairedToken = auth.exchange(repairedApproval.code, verifier, 'g'.repeat(64))
  const repairedGrant = auth.bearer(repairedToken.accessToken,'control')
  ok('same device can reconcile its receipt after revoke and re-pair', auth.prompt(repairedGrant,'message-12345678')?.state === 'queued')
  const third = auth.start({ codeChallenge: challenge, state: 'u'.repeat(64), deviceId: 'f'.repeat(64), deviceName: 'Robert phone' })
  const thirdApproval = auth.approve(third.request, auth.csrfFor(third.request), 'browser-2', ['read'])
  const thirdToken = auth.exchange(thirdApproval.code, verifier, 'f'.repeat(64))
  browsers.delete('browser-2')
  ok('removing parent browser denies an otherwise valid native bearer', !auth.bearer(thirdToken.accessToken, 'read'))
  browsers.add('browser-2')
  version = 'v2'
  ok('code rotation invalidates existing grants', !auth.bearer(thirdToken.accessToken, 'read'))
  let fullGrants = Array.from({length:32},(_,i)=>({...receiptGrant,id:`${i}`.padStart(32,'a'),deviceId:`${i}`.padStart(32,'b')}))
  const fullAuth = new NativeAuth(()=>fullGrants,rows=>{fullGrants=rows},()=>receiptGrant.codeVersion,()=> 'host.test',()=>[],()=>{},browserExists)
  const capStart = fullAuth.start({codeChallenge:challenge,state:'c'.repeat(64),deviceId:'n'.repeat(64),deviceName:'Phone'})
  const capCode = fullAuth.approve(capStart.request,fullAuth.csrfFor(capStart.request),'browser-1',['read']).code
  ok('active-device capacity refuses an additional device', throws(()=>fullAuth.exchange(capCode,verifier,'n'.repeat(64))) && fullGrants.length===32)
  const rotation = fullAuth.start({codeChallenge:challenge,state:'k'.repeat(64),deviceId:fullGrants[0].deviceId,deviceName:'Phone',grantId:fullGrants[0].id})
  const rotationCode = fullAuth.approve(rotation.request,fullAuth.csrfFor(rotation.request),'browser-1',['read']).code
  ok('active-device capacity still allows existing-device rotation', !!fullAuth.exchange(rotationCode,verifier,fullGrants[0].deviceId).accessToken && fullGrants.length===32)
  let httpGrants = [], httpReceipts = [], queued = 0, failReceiptSave = false
  let devices = [{id:'browser-http',ua:'fixture',token:'a'.repeat(64)}]
  const server = new PhoneServer({
    staticDir: out, code: () => 'fixture-code', secret: () => 'fixture-secret',
    invoke: async () => { throw Error('general IPC must not be called') },
    send: () => { throw Error('general IPC must not be called') },
    channels: { invoke: [], send: [], on: [] },
    devices: () => devices, saveDevices: rows => { devices = rows },
    nativeGrants: () => httpGrants, saveNativeGrants: rows => { httpGrants = rows },
    nativePromptReceipts: () => httpReceipts,
    saveNativePromptReceipts: rows => { if (failReceiptSave) throw Error('disk full'); httpReceipts = rows },
    sessions: () => [{id:'session-http',title:'Fixture',agent:'claude',status:'idle',createdAt:Date.now()}],
    sessionBuffer: () => 'fixture raw output',
    sendNativePrompt: () => { queued++; return true }
  })
  try {
    const state = await server.start(0, '127.0.0.1')
    if (state.error || !server.server) throw Error('fixture listener failed')
    const origin = `http://127.0.0.1:${server.server.address().port}`
    const request = (path, method = 'GET', body, token) => fetch(origin + '/pf/native/v1' + path, {
      method, headers: {'x-forwarded-proto':'https','content-type':'application/json',...(token ? {authorization:`Bearer ${token}`} : {})},
      ...(body ? {body:JSON.stringify(body)} : {})
    })
    const rawNative = (path, headers, body = '') => new Promise((resolve, reject) => {
      const call = httpRequest(origin + '/pf/native/v1' + path, { method: 'POST', headers: {'x-forwarded-proto':'https', 'content-type':'application/json', ...headers} }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode))
      })
      call.setTimeout(5_000, () => call.destroy(new Error('native response timed out')))
      call.once('error', reject)
      if (body) call.write(body)
      call.end()
    })
    ok('HTTP session endpoint denies unauthenticated read', (await request('/sessions')).status === 401)
    ok('HTTP control endpoint identifies an invalid bearer as unauthorized', (await request('/sessions/session-http/prompt','POST',{clientMessageId:'bad-auth-1',text:'Denied'},'invalid')).status === 401)
    ok('HTTP native oversized Content-Length is rejected before authorization logic', await rawNative('/auth/start', {'content-length':'8193'}) === 413)
    const chunked = await fetch(origin + '/pf/native/v1/auth/start', {
      method:'POST', headers:{'x-forwarded-proto':'https','content-type':'application/json'},
      body:new ReadableStream({start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(8193))); controller.close() }}), duplex:'half'
    })
    ok('HTTP native chunked oversized body is rejected before authorization logic', chunked.status === 413)
    const startHttp = await (await request('/auth/start','POST',{codeChallenge:challenge,state:'h'.repeat(64),deviceId:'i'.repeat(64),deviceName:'Fixture'})).json()
    const requestId = new URL(startHttp.authorizationUrl).searchParams.get('request')
    const authorize = (cookie) => fetch(origin + '/pf/native/v1/auth/authorize?request=' + requestId, {
      headers: {'x-forwarded-proto':'https', ...(cookie ? {cookie:'pf='+cookie} : {})}
    }).then(response => response.text())
    const unpairedPage = await authorize()
    const legacyCookie = createHmac('sha256','fixture-secret').update('fixture-code').digest('hex')
    const legacyPage = await authorize(legacyCookie)
    const pairedPage = await authorize('a'.repeat(64))
    ok('HTTP legacy browser must obtain a revocable identity before native approval', legacyPage.includes('Requesting approval') && !legacyPage.includes('id="ok"'))
    ok('HTTP paired browser receives first-passkey enrollment and assertion paths', pairedPage.includes('navigator.credentials.create') && pairedPage.includes('navigator.credentials.get'))
    for (const [name, page] of [['unpaired',unpairedPage],['legacy',legacyPage],['paired',pairedPage]]) {
      const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(page)?.[1]
      ok('HTTP ' + name + ' browser page contains valid JavaScript', !!script && !throws(()=>new Script(script)))
    }
    // Seed the already-tested approval ceremony; exercise actual HTTP token and control routes.
    const approvedHttp = server.native.approve(requestId,server.native.csrfFor(requestId),'browser-http',['read','control'])
    const tokenHttp = await (await request('/auth/token','POST',{code:approvedHttp.code,codeVerifier:verifier,deviceId:'i'.repeat(64)})).json()
    const bearer = tokenHttp.accessToken
    ok('HTTP token permits the scoped session list', (await (await request('/sessions','GET',undefined,bearer)).json()).sessions?.[0]?.id === 'session-http')
    const body = {clientMessageId:'http-message-1',text:'One exact prompt'}
    const first = await (await request('/sessions/session-http/prompt','POST',body,bearer)).json()
    const duplicate = await (await request('/sessions/session-http/prompt','POST',body,bearer)).json()
    ok('HTTP retry returns queued receipt without a second enqueue', first.state === 'queued' && duplicate.state === 'queued' && queued === 1)
    const grantHttp = server.native.bearer(bearer,'control')
    server.native.acceptPrompt(grantHttp,'http-message-2','session-http','Possibly queued before crash')
    const pending = await (await request('/sessions/session-http/prompt','POST',{clientMessageId:'http-message-2',text:'Possibly queued before crash'},bearer)).json()
    ok('HTTP pending crash receipt stays unknown without resending', pending.state === 'unknown' && queued === 1)
    ok('HTTP duplicate id with changed text is refused', (await request('/sessions/session-http/prompt','POST',{...body,text:'Changed'},bearer)).status === 409 && queued === 1)
    failReceiptSave = true
    ok('HTTP receipt disk failure does not enqueue', (await request('/sessions/session-http/prompt','POST',{clientMessageId:'http-message-3',text:'Unsaved'},bearer)).status === 409 && queued === 1)
    failReceiptSave = false
    const status = await (await request('/prompts/http-message-1','GET',undefined,bearer)).json()
    ok('HTTP delivery reconciliation returns the same receipt', status.clientMessageId === body.clientMessageId && status.state === 'queued')
    const unicode = '界'.repeat(20_000)
    ok('HTTP native prompt limit preserves 20,000 non-ASCII characters', (await request('/sessions/session-http/prompt','POST',{clientMessageId:'unicode-message-1',text:unicode},bearer)).status === 202)
    ok('HTTP oversized native prompt produces one refusal without poisoning the server', await rawNative('/sessions/session-http/prompt', {authorization:'Bearer '+bearer,'content-length':String(128*1024+1)}) === 413 && (await request('/sessions')).status === 401)
    httpGrants = httpGrants.map(row=>({...row,unlockedUntil:Date.now()-1}))
    ok('HTTP valid but locked control grant returns 423', (await request('/sessions/session-http/prompt','POST',{clientMessageId:'locked-msg-1',text:'Locked'},bearer)).status === 423)
    const approveBrowser = async () => {
      const ask = await (await fetch(origin + '/pf/ask', {method:'POST',headers:{'user-agent':'same fixture UA'}})).json()
      server.answerAsk(true)
      const state = await fetch(origin + '/pf/ask?id=' + encodeURIComponent(ask.id), {headers:{'user-agent':'same fixture UA'}})
      return (state.headers.get('set-cookie') ?? '').match(/pf=([a-f0-9]{64})/)?.[1]
    }
    const firstCookie = await approveBrowser(), secondCookie = await approveBrowser()
    const approved = devices.filter(d => d.id !== 'browser-http')
    ok('identical-UA approvals retain both browser identities', approved.length === 2 && firstCookie !== secondCookie)
    const retainedStart = await (await request('/auth/start','POST',{codeChallenge:challenge,state:'p'.repeat(64),deviceId:'q'.repeat(64),deviceName:'Retained parent'})).json()
    const retainedRequest = new URL(retainedStart.authorizationUrl).searchParams.get('request')
    const retainedApproval = server.native.approve(retainedRequest, server.native.csrfFor(retainedRequest), approved[0].id, ['read'])
    ok('retained parent browser can grant native approval', !!retainedApproval.code)
    server.native.exchange(retainedApproval.code, verifier, 'q'.repeat(64))
    const firstRequest = {headers:{cookie:'pf='+approved[0].token}}
    const secondRequest = {headers:{cookie:'pf='+approved[1].token}}
    const boundChallenge = server.issueChallenge(firstRequest)
    ok('cross-browser passkey challenge completion is rejected', !server.takeChallenge(secondRequest, boundChallenge))
    server.freshPasskeys.set(approved[0].id, Date.now())
    ok('cookie-only second enrollment has no fresh assertion for its browser', !server.takeFreshPasskey(approved[1].id))
    server.nativeStarts = new Map(Array.from({length:1024},(_,i)=>[`ip-${i}`,{since:Date.now(),n:1}]))
    const startBody = {codeChallenge:challenge,state:'j'.repeat(64),deviceId:'l'.repeat(64),deviceName:'Fixture'}
    ok('HTTP authorization rate map refuses growth at capacity', (await request('/auth/start','POST',startBody)).status === 429 && server.nativeStarts.size === 1024)
    for (const entry of server.nativeStarts.values()) entry.since = Date.now()-60_001
    ok('HTTP authorization rate map frees expired entries', (await request('/auth/start','POST',startBody)).status === 200 && server.nativeStarts.size === 1)
  } finally { await server.stop() }
} finally { rmSync(out, { recursive: true, force: true }) }
console.log(`native host auth: ${checks - failures}/${checks} checks`)
if (failures) process.exitCode = 1
