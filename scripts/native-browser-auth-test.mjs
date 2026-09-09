/**
 * Real-browser proof for native pairing: desktop browser approval, WebAuthn, CSRF/PKCE,
 * one-time code exchange, and a second assertion.  It deliberately owns only its fixture.
 *
 * Run after the serial native-host gate: node scripts/native-browser-auth-test.mjs
 */
import { build } from 'esbuild'
import { createHash, randomBytes } from 'node:crypto'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { closeTestChrome } from './close-test-chrome.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const chromePath = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(existsSync)
if (!chromePath || !existsSync('/usr/bin/openssl')) { console.log(`native browser auth: SKIPPED - ${!chromePath ? 'system Chrome' : 'openssl'} unavailable`); process.exit(0) }

let checks = 0, failures = 0
const ok = (pass, name) => { checks++; console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}`); if (!pass) failures++ }
const wait = async (fn, label, ms = 12_000) => {
  const until = Date.now() + ms
  while (Date.now() < until) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error(`${label} did not become ready`)
}
const port = () => new Promise((resolve, reject) => { const s = createHttpServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(error => error ? reject(error) : resolve(p)) }) })
const root64 = () => randomBytes(32).toString('hex')
// Node fetch rewrites Host; this fixture must preserve the TLS proxy's external origin.
const requestJson = (origin, path, body, headers = {}) => new Promise((resolve, reject) => {
  const request = httpRequest(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } }, response => {
    let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk })
    response.on('end', () => {
      let value = null; try { value = JSON.parse(text) } catch { /* expected for refusal */ }
      resolve({ response: { status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300 }, value, text })
    }); response.on('error', reject)
  })
  request.on('error', reject); request.setTimeout(10_000, () => request.destroy(Error('fixture HTTP request timed out')))
  request.end(body === undefined ? undefined : JSON.stringify(body))
})

function cdp(ws) {
  let id = 0; const pending = new Map(); const events = []
  ws.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.id && pending.has(message.id)) { const entry = pending.get(message.id); pending.delete(message.id); message.error ? entry.reject(Error(message.error.message)) : entry.resolve(message.result) } else if (message.method) events.push(message) })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); ws.send(JSON.stringify({ id: key, method, params, ...(sessionId ? { sessionId } : {}) })); setTimeout(() => { if (pending.has(key)) { pending.delete(key); reject(Error(`${method} timed out`)) } }, 10_000) })
  return { send, events }
}

const fixture = mkdtempSync(join(tmpdir(), 'pf-native-browser-'))
let browser, ws, proxy, host
try {
  const profile = join(fixture, 'profile'), staticDir = join(fixture, 'static'), cert = join(fixture, 'cert.pem'), key = join(fixture, 'key.pem')
  writeFileSync(join(fixture, 'entry.ts'), `export { PhoneServer } from ${JSON.stringify(join(root, 'src/main/phone.ts').replace(/\\/g, '/'))}`)
  await build({ absWorkingDir: root, entryPoints: [join(fixture, 'entry.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(fixture, 'host.mjs'), logLevel: 'warning', plugins: [{ name: 'fixture-electron', setup(build) { build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' })); build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const app={getPath:()=>${JSON.stringify(profile)}}`, loader: 'js' })) } }] })
  const { PhoneServer } = await import(pathToFileURL(join(fixture, 'host.mjs')).href)
  let devices = [], keys = [], grants = [], receipts = []
  host = new PhoneServer({ staticDir, code: () => 'fixture-code', secret: () => 'fixture-secret', invoke: async () => { throw Error('unexpected IPC') }, send: () => { throw Error('unexpected IPC') }, channels: { invoke: [], send: [], on: [] }, devices: () => devices, saveDevices: next => { devices = next }, keys: () => keys, saveKeys: next => { keys = next }, canAsk: () => true, typeGate: () => true, nativeGrants: () => grants, saveNativeGrants: next => { grants = next }, nativePromptReceipts: () => receipts, saveNativePromptReceipts: next => { receipts = next }, sessions: () => [{ id: 'fixture-session', title: 'Fixture', agent: 'claude', status: 'idle', createdAt: Date.now() }], sessionBuffer: () => '' })
  const state = await host.start(0, '127.0.0.1'); if (state.error || !host.server) throw Error('host fixture did not bind')
  const httpOrigin = `http://127.0.0.1:${host.server.address().port}`
  const tlsPort = await port()
  const generated = spawnSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' })
  if (generated.status !== 0) { console.log('native browser auth: SKIPPED - openssl could not create a localhost fixture certificate'); process.exitCode = 0; throw Error('skip') }
  proxy = createHttpsServer({ key: await (await import('node:fs/promises')).readFile(key), cert: await (await import('node:fs/promises')).readFile(cert) }, (req, res) => {
    const upstream = httpRequest(httpOrigin + req.url, { method: req.method, headers: { ...req.headers, host: req.headers.host, 'x-forwarded-proto': 'https' } }, response => { res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res) })
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() }); req.pipe(upstream)
  })
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(tlsPort, '127.0.0.1', resolve) })
  const cdpPort = await port()
  browser = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--ignore-certificate-errors', 'about:blank'], { stdio: 'ignore' })
  const version = await wait(async () => { try { return await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json() } catch { return null } }, 'Chrome CDP')
  ws = new WebSocket(version.webSocketDebuggerUrl); await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
  const { send, events } = cdp(ws); const { targetId } = await send('Target.createTarget', { url: 'about:blank' }); const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Network.enable', {}, sessionId); await send('Page.enable', {}, sessionId); await send('WebAuthn.enable', {}, sessionId)
  // Observe the real server approval, but withhold its response from the page so its
  // taskdriver:// navigation can never reach an installed application on this desktop.
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/pf/native/v1/auth/approve', requestStage: 'Response' }] }, sessionId)
  const authenticatorId = (await send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } }, sessionId)).authenticatorId
  const navigate = async url => {
    const result = await send('Page.navigate', { url }, sessionId)
    if (result.errorText) throw Error('Browser navigation failed: ' + result.errorText)
  }
  const visible = () => send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true, awaitPromise: true }, sessionId).then(r => r.result.value)
  const click = () => send('Runtime.evaluate', { expression: "document.querySelector('#ok').click()", awaitPromise: true }, sessionId)
  const start = async () => {
    const verifier = root64(), state = root64(), deviceId = root64(), codeChallenge = createHash('sha256').update(verifier).digest('base64url')
    const { response, value } = await requestJson(httpOrigin, '/pf/native/v1/auth/start', { codeChallenge, state, deviceId, deviceName: 'Fixture iPhone' }, { host: `localhost:${tlsPort}`, 'x-forwarded-proto': 'https' })
    if (!response.ok || !value?.authorizationUrl) throw Error('native start failed')
    if (new URL(value.authorizationUrl).origin !== `https://localhost:${tlsPort}`) throw Error('Native start did not preserve the fixture TLS Host header')
    return { verifier, state, deviceId, authorizationUrl: value.authorizationUrl }
  }
  const approve = async (flow, needsPair) => {
    // Keep this response window per ceremony. A second approval must never pass by
    // observing the first ceremony's response, and an already-paired profile skips ask.
    const eventStart = events.length
    await navigate(flow.authorizationUrl)
    if (needsPair) {
      await wait(async () => (await visible()).includes('Approve the matching code') || null, 'pair page').catch(async error => { throw Error(error.message + ': ' + String(await visible()).slice(0, 200)) })
      await wait(() => host.state().ask, 'desktop pairing request'); host.answerAsk(true)
    }
    await wait(async () => (await visible()).includes('Approve with passkey') || null, 'paired approval page')
    await click()
    const approval = await wait(async () => {
      const response = events.slice(eventStart).find(e => e.method === 'Fetch.requestPaused' && e.params.request.url.endsWith('/pf/native/v1/auth/approve') && e.params.responseStatusCode)
      if (!response) return null
      const body = await send('Fetch.getResponseBody', { requestId: response.params.requestId }, sessionId)
      await send('Fetch.failRequest', { requestId: response.params.requestId, errorReason: 'Aborted' }, sessionId)
      if (response.params.responseStatusCode !== 200) throw Error('Browser approval was refused: HTTP ' + response.params.responseStatusCode)
      return JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body)
    }, 'actual approval response')
    return approval
  }
  const first = await start(); const firstApproval = await approve(first, true)
  ok(firstApproval.state === first.state && typeof firstApproval.code === 'string', 'first browser pairing returned a CSRF-bound authorization code')
  const token = await requestJson(httpOrigin, '/pf/native/v1/auth/token', { code: firstApproval.code, codeVerifier: first.verifier, deviceId: first.deviceId }, { host: `localhost:${tlsPort}`, 'x-forwarded-proto': 'https' })
  ok(token.response.ok && typeof token.value?.accessToken === 'string', 'actual PKCE exchange returned a native bearer')
  const sessions = await requestJson(httpOrigin, '/pf/native/v1/sessions', undefined, { authorization: `Bearer ${token.value.accessToken}`, 'x-forwarded-proto': 'https' })
  ok(sessions.response.ok && sessions.value.sessions?.[0]?.id === 'fixture-session', 'scoped bearer reads native sessions')
  const replay = await requestJson(httpOrigin, '/pf/native/v1/auth/token', { code: firstApproval.code, codeVerifier: first.verifier, deviceId: first.deviceId }, { host: `localhost:${tlsPort}`, 'x-forwarded-proto': 'https' })
  ok(!replay.response.ok, 'authorization code replay is rejected')
  const second = await start(); const secondApproval = await approve(second, false)
  const secondToken = await requestJson(httpOrigin, '/pf/native/v1/auth/token', { code: secondApproval.code, codeVerifier: second.verifier, deviceId: second.deviceId }, { host: `localhost:${tlsPort}`, 'x-forwarded-proto': 'https' })
  ok(secondToken.response.ok && keys.length === 1, 'second request asserts the existing passkey without enrolling another')
  ok(grants.length === 2 && grants[0].id !== grants[1].id && grants.every(grant => grant.deviceId && grant.browserDevice), 'separate native requests produce distinct browser-scoped grants')
  await send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }, sessionId)
} catch (error) {
  if (error.message !== 'skip') { failures++; console.log(`FAIL  browser proof setup or flow - ${error.message}`) }
} finally {
  try { if (browser) await closeTestChrome(browser, join(fixture, 'profile'), ws) } catch (error) { failures++; console.log(`FAIL  browser cleanup - ${error.message}`) }
  try { if (proxy) await new Promise(resolve => proxy.close(() => resolve())) } catch { /* owned proxy may already be closed */ }
  try { await host?.stop() } catch { /* cleanup must proceed */ }
  rmSync(fixture, { recursive: true, force: true })
}
console.log(`native browser auth: ${checks - failures}/${checks} checks`)
if (failures) process.exitCode = 1
