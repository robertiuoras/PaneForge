// Robert's iPhone signs in to a desk with a ticket taskdriver.ai signed - no Tailscale on the
// phone, no code - and nothing else does.
//
// The rule is `src/shared/deskTicket.ts`, the door `src/main/phone.ts`
// (`/pf/native/v1/auth/taskdriver`), the owner `src/main/tailnetIdentity.ts` `selfLogin()`.
// No network, no window: the ticket is the contract's test vector (desk-ticket contract v1,
// 3 Oct 2026) and requests arrive on loopback the way Tailscale Funnel delivers them.

import { buildSync } from 'esbuild'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let failures = 0
let checks = 0
function ok(cond, what, detail = '') {
  checks++
  if (cond) return
  failures++
  console.error(`  FAIL ${what}${detail ? ` - ${detail}` : ''}`)
}

const work = mkdtempSync(join(tmpdir(), 'pf-deskticket-'))
const entry = join(work, 'entry.ts')
const root = process.cwd().replace(/\\/g, '/')
writeFileSync(
  entry,
  [
    `export * from '${root}/src/shared/deskTicket.ts'`,
    `export { parseSelfLogin, parseSelfUser } from '${root}/src/shared/tailnetIdentity.ts'`,
    `export { TailnetIdentity } from '${root}/src/main/tailnetIdentity.ts'`,
    `export { PhoneServer, LOCAL_ONLY } from '${root}/src/main/phone.ts'`
  ].join('\n')
)
const bundle = join(work, 'bundle.mjs')
buildSync({ entryPoints: [entry], outfile: bundle, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
const T = await import(pathToFileURL(bundle).href)

// ---- the contract's test vector -------------------------------------------------------------

const TOKEN = 'test-ingest-token'
const OWNER = 'robertiuoras@gmail.com'
const DESK = 'desktop-cmsucm1.tail6c8b58.ts.net'
const VECTOR_JSON = `{"email":"robertiuoras@gmail.com","deviceId":"dev-123","aud":"desktop-cmsucm1.tail6c8b58.ts.net","iat":1790000000,"exp":1790000120,"jti":"AAAAAAAAAAAAAAAAAAAAAA"}`
const VECTOR = 'v1.eyJlbWFpbCI6InJvYmVydGl1b3Jhc0BnbWFpbC5jb20iLCJkZXZpY2VJZCI6ImRldi0xMjMiLCJhdWQiOiJkZXNrdG9wLWNtc3VjbTEudGFpbDZjOGI1OC50cy5uZXQiLCJpYXQiOjE3OTAwMDAwMDAsImV4cCI6MTc5MDAwMDEyMCwianRpIjoiQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSJ9.1pBg1C0aBNpx9tHFpsOaS0OSJnFaWb0v_bK57y37Nkg'

const mint = (over = {}, token = TOKEN) => {
  const iat = over.iat ?? Math.floor(Date.now() / 1000)
  const c = { email: OWNER, deviceId: 'dev-123', aud: DESK, iat, exp: iat + 120, jti: randomBytes(16).toString('base64url'), ...over }
  return T.mintDeskTicket(JSON.stringify({ email: c.email, deviceId: c.deviceId, aud: c.aud, iat: c.iat, exp: c.exp, jti: c.jti }), token)
}

// ---- 1. the pure rule -----------------------------------------------------------------------

{
  ok(T.mintDeskTicket(VECTOR_JSON, TOKEN) === VECTOR, 'minting the vector payload reproduces the contract ticket byte for byte')
  ok(T.deskTicketKey(TOKEN).length === 32, 'the derived key is 32 raw bytes')
  const at = 1_790_000_060_000
  const base = { ticket: VECTOR, deviceId: 'dev-123', host: DESK, now: at, ingestToken: TOKEN, owner: OWNER }
  const v = (over = {}) => T.verifyDeskTicket({ ...base, seen: new Map(), ...over })
  const good = v()
  ok(good.ok && good.email === OWNER && good.jti === 'AAAAAAAAAAAAAAAAAAAAAA' && good.exp === 1790000120, 'the contract vector verifies', JSON.stringify(good))
  ok(v({ owner: 'RobertIuoras@Gmail.com' }).ok, 'the owner compare is case-insensitive')
  const flip = VECTOR.slice(0, -1) + (VECTOR.endsWith('g') ? 'h' : 'g')
  ok(!v({ ticket: flip }).ok && /signature/.test(v({ ticket: flip }).reason), 'a changed signature is refused', v({ ticket: flip }).reason)
  const [, p, s] = VECTOR.split('.')
  const forged = `v1.${Buffer.from(VECTOR_JSON.replace('dev-123', 'dev-999')).toString('base64url')}.${s}`
  ok(!v({ ticket: forged, deviceId: 'dev-999' }).ok, 'a changed payload under the old signature is refused')
  ok(!v({ ingestToken: 'another-token' }).ok, 'a ticket signed with another desk\'s token is refused')
  ok(!v({ ticket: `v2.${p}.${s}` }).ok && !v({ ticket: '' }).ok && !v({ ticket: 42 }).ok, 'not a v1 ticket is refused')
  ok(/expired/.test(v({ now: 1_790_000_120_000 }).reason ?? ''), 'a ticket at its exp is expired', v({ now: 1_790_000_120_000 }).reason)
  const life = (secs) => T.verifyDeskTicket({ ...base, ticket: mint({ iat: 1790000000, exp: 1790000000 + secs }), seen: new Map() })
  ok(life(300).ok, 'a ticket living exactly 300 s is accepted', life(300).reason)
  ok(!life(301).ok && /longer/.test(life(301).reason), 'a ticket living 301 s is refused', life(301).reason)
  const future = T.verifyDeskTicket({ ...base, ticket: mint({ iat: 1790000200, exp: 1790000300 }), seen: new Map() })
  ok(!future.ok && /future/.test(future.reason), 'a ticket issued minutes ahead of the desk clock is refused', future.reason)
  ok(/another desk/.test(v({ host: 'roberts-macbook-pro.tail6c8b58.ts.net' }).reason ?? ''), 'a ticket for the other desk is refused')
  ok(!v({ host: '' }).ok, 'no Host header is refused')
  ok(/another device/.test(v({ deviceId: 'dev-124' }).reason ?? ''), 'a ticket for another device is refused')
  ok(/another account/.test(v({ owner: 'someone@example.com' }).reason ?? ''), 'a ticket for another account is refused')
  ok(!v({ owner: '' }).ok && !v({ ingestToken: '' }).ok, 'no owner or no token refuses everything')
  const seen = new Map()
  ok(v({ seen }).ok && seen.get('AAAAAAAAAAAAAAAAAAAAAA') === 1_790_000_120_000, 'a good ticket is remembered until its exp')
  const replay = v({ seen })
  ok(!replay.ok && /already used/.test(replay.reason), 'the same ticket twice is refused', replay.reason)
  const later = new Map([['old-jti-0000000000000', 1_790_000_000_000]])
  v({ seen: later })
  ok(!later.has('old-jti-0000000000000') && later.size === 1, 'expired jtis are pruned')
  const full = new Map(Array.from({ length: 1024 }, (_, i) => [`jti-${String(i).padStart(18, '0')}`, at + 60_000]))
  ok(!v({ seen: full }).ok && full.size === 1024, 'the replay memory is bounded: full refuses, never forgets')
  ok(T.deskHost('Desktop-CMSUCM1.tail6c8b58.ts.net:443') === DESK && T.deskHost(undefined) === '' && T.deskHost('[::1]:8443') === '[::1]', 'Host is lowercased with its port stripped')
  const reasons = [flip, forged].map((t) => v({ ticket: t }).reason).join(' ')
  ok(!reasons.includes(s) && !reasons.includes(p.slice(0, 20)), 'a refusal reason never carries the ticket')
}

// ---- 2. the desk's owner: Tailscale's login for its own user --------------------------------

const ME = '7132691346616570'
// Measured on the Mac 2026-10-03: `User[Self.UserID]` carries ID, LoginName, DisplayName, ProfilePicURL.
const statusJson = `{"BackendState":"Running","Self":{"UserID":${ME},"OS":"macOS"},"User":{"${ME}":{"ID":${ME},"LoginName":"${OWNER}","DisplayName":"Robert","ProfilePicURL":""},"1929821953316901":{"ID":1929821953316901,"LoginName":"other@example.com"}}}`
{
  ok(T.parseSelfLogin(statusJson) === OWNER, 'status gives this desk\'s own login', T.parseSelfLogin(statusJson))
  ok(T.parseSelfUser(statusJson) === ME, 'and still its user id')
  ok(T.parseSelfLogin('{"BackendState":"Stopped","Self":{"UserID":1},"User":{"1":{"LoginName":"x@y"}}}') === '', 'a stopped tailscaled has no login')
  ok(T.parseSelfLogin('') === '' && T.parseSelfLogin('{"BackendState":"Running","Self":{"UserID":5}}') === '', 'unreadable status has no login')
  const calls = []
  const id = new T.TailnetIdentity({ binary: 'tailscale', run: async (_b, args) => { calls.push(args); return { out: statusJson, err: '', code: 0 } } })
  const [login, user] = await Promise.all([id.selfLogin(), id.selfUser()])
  ok(login === OWNER && user === ME && calls.length === 1, 'login and user id come from one cached status call', String(calls.length))
  ok((await new T.TailnetIdentity({ binary: '' }).selfLogin()) === '', 'no tailscale on the machine: no owner')
}

// ---- 3. the door ----------------------------------------------------------------------------

const staticDir = join(work, 'renderer')
mkdirSync(staticDir, { recursive: true })
writeFileSync(join(staticDir, 'index.html'), '<html>THE-REAL-UI</html>')
let devices = []
let grants = []
let receipts = []
let token = TOKEN
let owner = OWNER
let selfLoginCalls = 0
const logs = []
const phoneDeps = {
  staticDir,
  code: () => 'CODE-ONE-LONG-ENOUGH',
  secret: () => 'device-secret',
  invoke: async () => 'value',
  send: () => {},
  channels: { invoke: ['sessions:list'], send: [], on: [] },
  devices: () => devices,
  saveDevices: (l) => { devices = l },
  canAsk: () => false,
  keys: () => [],
  saveKeys: () => {},
  typeGate: () => true,
  nativeGrants: () => grants,
  saveNativeGrants: (l) => { grants = l },
  nativePromptReceipts: () => receipts,
  saveNativePromptReceipts: (l) => { receipts = l },
  sessions: () => [{ id: 's1', title: 'One', agent: 'claude', status: 'idle', createdAt: Date.now() }],
  setKeepOpen: () => true,
  isKeepOpen: () => false,
  // The phone is NOT on the tailnet: whois never knows it. Only the desk's own login matters.
  tailnet: { whois: async () => null, selfUser: async () => ME, selfLogin: async () => { selfLoginCalls++; return owner } },
  ingestToken: () => token,
  trustLog: (line) => logs.push(line)
}
const server = new T.PhoneServer(phoneDeps)
await server.start(0, '127.0.0.1')
const port = server.server.address().port

function callOn(p, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: p, method, path, headers: { host: DESK, ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (text += c))
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch { /* plain */ }
        resolve({ status: res.statusCode, text, json })
      })
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
const call = (...a) => callOn(port, ...a)
// What Tailscale Funnel hands the phone server: one public address, https, the Funnel mark.
let nextIp = 10
const funnel = (ip = `203.0.113.${nextIp++}`) => ({ 'x-forwarded-for': ip, 'x-forwarded-proto': 'https', 'x-forwarded-host': DESK, 'tailscale-funnel-request': '?1' })
const app = { deviceId: 'TDdevice-0123456789abcdef', deviceName: 'Robert iPhone' }
const signIn = (ticket, { headers = funnel(), body = {} } = {}) => call('POST', '/pf/native/v1/auth/taskdriver', { headers, body: { ticket, ...app, ...body } })
const appTicket = (over = {}, key = TOKEN) => mint({ deviceId: app.deviceId, ...over }, key)
const ROW = 'td-' + (await import('node:crypto')).createHash('sha256').update(app.deviceId).digest('hex').slice(0, 24)

try {
  const ticket = appTicket()
  const r = await signIn(ticket)
  ok(r.status === 200, 'a good ticket gets a grant', `${r.status} ${r.text}`)
  ok(r.json && Object.keys(r.json).sort().join() === 'accessToken,deviceId,expiresAt,grantId,hostName,unlockedUntil' && Object.values(r.json).every((x) => typeof x === 'string'), 'it answers the NativeTokenResponse shape', r.text)
  ok(r.json?.hostName === DESK && r.json?.deviceId === app.deviceId, 'hostName is the desk the phone reached', r.json?.hostName)
  ok(Date.parse(r.json?.unlockedUntil) > Date.now() + 14 * 60_000 && Date.parse(r.json?.expiresAt) > Date.now() + 29 * 86_400_000, 'read+control for 30 days with the 15-minute control window')
  ok(devices.length === 1 && devices[0].id === ROW && devices[0].kind === 'iPhone' && devices[0].ua === 'Taskdriver app (Robert iPhone)', 'one Devices row for the app install', JSON.stringify(devices.map(({ token: _t, ...d }) => d)))
  ok(grants.length === 1 && grants[0].browserDevice === ROW && grants[0].scopes.join() === 'read,control', 'grant bound to that row with read+control')
  ok(logs.length === 1 && /ALLOWED taskdriver sign-in ip=203\.0\.113\.\d+ device=Robert iPhone - /.test(logs[0]), 'one trust line for the decision', logs.join(' | '))
  const auth = { authorization: `Bearer ${r.json?.accessToken}` }
  const list = await call('GET', '/pf/native/v1/sessions', { headers: { ...funnel(), ...auth } })
  ok(list.status === 200 && list.json?.sessions?.[0]?.id === 's1', 'its bearer reads the desk\'s sessions', `${list.status} ${list.text.slice(0, 80)}`)
  const control = await call('POST', '/pf/native/v1/sessions/s1/keep-open', { headers: { ...funnel(), ...auth }, body: { keepOpen: true } })
  ok(control.status === 200, 'and controls inside its 15-minute window', `${control.status} ${control.text}`)

  // Refusals: 403, nothing written, one log line each, never the ticket.
  const before = JSON.stringify({ devices, grants })
  const refusals = [
    ['bad signature', ticket.slice(0, -2) + (ticket.endsWith('AA') ? 'BB' : 'AA'), {}],
    ['expired', appTicket({ iat: Math.floor(Date.now() / 1000) - 200, exp: Math.floor(Date.now() / 1000) - 80 }), {}],
    ['long-lived', appTicket({ exp: Math.floor(Date.now() / 1000) + 3600 }), {}],
    ['wrong aud', appTicket({ aud: 'roberts-macbook-pro.tail6c8b58.ts.net' }), {}],
    ['wrong host header', appTicket(), { headers: { ...funnel(), host: 'evil.example.com' } }],
    ['wrong device', appTicket({ deviceId: 'TDdevice-someone-elses-0000' }), {}],
    ['replay', ticket, {}],
    ['wrong owner', appTicket({ email: 'someone@example.com' }), {}],
    ['other token', appTicket({}, 'another-desk-token'), {}]
  ]
  for (const [what, t, opts] of refusals) {
    const n = logs.length
    const res = await signIn(t, opts)
    ok(res.status === 403, `${what}: refused 403`, `${res.status} ${res.text}`)
    ok(logs.length === n + 1 && /REFUSED taskdriver sign-in/.test(logs.at(-1)), `${what}: one REFUSED line`, logs.slice(n).join(' | '))
  }
  token = null
  const noToken = await signIn(appTicket())
  ok(noToken.status === 403 && /no Taskdriver token/.test(logs.at(-1)), 'no ingest token on the desk: refused 403', `${noToken.status} ${logs.at(-1)}`)
  token = TOKEN
  owner = ''
  const noOwner = await signIn(appTicket())
  ok(noOwner.status === 403 && /owner/.test(logs.at(-1)), 'no Tailscale login for the desk: refused 403', `${noOwner.status} ${logs.at(-1)}`)
  owner = OWNER
  ok(JSON.stringify({ devices, grants }) === before, 'refusals wrote no device row and no grant')
  const allLogs = logs.join('\n')
  ok(!allLogs.includes(ticket.split('.')[1].slice(0, 24)) && !allLogs.includes(ticket.split('.')[2]) && !allLogs.includes(r.json?.accessToken), 'no ticket and no token in the log')

  const plain = await signIn(appTicket(), { headers: { 'x-forwarded-for': '203.0.113.200' } })
  ok(plain.status === 400, 'plain http is 400 before anything is asked', String(plain.status))
  const badDevice = await signIn(appTicket(), { body: { deviceId: 'short' } })
  ok(badDevice.status === 400, 'an invalid device id is 400', String(badDevice.status))
  const noTicket = await call('POST', '/pf/native/v1/auth/taskdriver', { headers: funnel(), body: app })
  ok(noTicket.status === 400, 'no ticket is 400', String(noTicket.status))

  // The contract's control flow: a lapsed window answers 423 off the tailnet, a fresh ticket
  // signs in again (same row, same grant id, old token replaced) and the call goes through.
  grants = grants.map((g) => ({ ...g, unlockedUntil: Date.now() - 1 }))
  const lapsed = await call('POST', '/pf/native/v1/sessions/s1/keep-open', { headers: { ...funnel(), ...auth }, body: { keepOpen: true } })
  ok(lapsed.status === 423, 'a lapsed control window is 423 locked', `${lapsed.status} ${lapsed.text}`)
  const again = await signIn(appTicket())
  ok(again.status === 200 && again.json?.grantId === r.json?.grantId && devices.length === 1 && grants.length === 1, 'a fresh ticket signs in again on the same row and grant')
  const stale = await call('GET', '/pf/native/v1/sessions', { headers: { ...funnel(), ...auth } })
  ok(stale.status === 401, 'the previous token is replaced', String(stale.status))
  const retried = await call('POST', '/pf/native/v1/sessions/s1/keep-open', { headers: { ...funnel(), authorization: `Bearer ${again.json?.accessToken}` }, body: { keepOpen: true } })
  ok(retried.status === 200, 'and the retried control call goes through', `${retried.status} ${retried.text}`)

  // Sign out on the row ends the grant.
  server.forgetDevice(ROW)
  const out = await call('GET', '/pf/native/v1/sessions', { headers: { ...funnel(), authorization: `Bearer ${again.json?.accessToken}` } })
  ok(out.status === 401 && grants.length === 0, 'Sign out on the row revokes its grant', String(out.status))

  // Rate limit, like the tailnet door: ten a minute per address.
  let last = 0
  for (let i = 0; i < 11; i++) last = (await signIn(appTicket({ email: 'someone@example.com' }), { headers: funnel('198.51.100.7') })).status
  ok(last === 429, 'the eleventh try in a minute is 429', String(last))

  // Phone access switched off: the loopback-only listener refuses before Tailscale is asked.
  const locked = new T.PhoneServer(phoneDeps)
  await locked.start(0, T.LOCAL_ONLY)
  try {
    const lport = locked.server.address().port
    const n = logs.length, devBefore = devices.length, grantBefore = grants.length, asked = selfLoginCalls
    const off = await callOn(lport, 'POST', '/pf/native/v1/auth/taskdriver', { headers: funnel(), body: { ticket: appTicket(), ...app } })
    ok(off.status === 403, 'phone access off: refused 403', `${off.status} ${off.text}`)
    ok(logs.length === n + 1 && /switched off/.test(logs.at(-1)), 'phone access off: refusal logged', logs.at(-1))
    ok(devices.length === devBefore && grants.length === grantBefore && selfLoginCalls === asked, 'phone access off: nothing written, Tailscale never asked')
  } finally {
    await locked.stop()
  }
} finally {
  await server.stop()
  rmSync(work, { recursive: true, force: true })
}

console.log(`desk ticket: ${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
