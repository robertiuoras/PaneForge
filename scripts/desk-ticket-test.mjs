// Robert's iPhone signs in to a desk with a ticket taskdriver.ai issued - no Tailscale on the
// phone, no code - and nothing else does. Desk ticket contract v2 (3 Oct 2026): the desk never
// checks a ticket itself; it redeems it at taskdriver.ai, which spends it once and names the
// owner. Holding the ingest token (every agent on both desks can read it) mints nothing.
//
// The client `src/main/deskTicket.ts`, the door `src/main/phone.ts`
// (`/pf/native/v1/auth/taskdriver`), the owner + audience `src/main/tailnetIdentity.ts`
// (`selfLogin`, `selfDns`). No network: taskdriver.ai is a fake on loopback that keeps tickets
// the way the contract's `desk_tickets` table does, and requests arrive the way Funnel sends them.

import { buildSync } from 'esbuild'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
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
    `export * from '${root}/src/main/deskTicket.ts'`,
    `export { parseSelfDns, parseSelfLogin, parseSelfUser } from '${root}/src/shared/tailnetIdentity.ts'`,
    `export { TailnetIdentity } from '${root}/src/main/tailnetIdentity.ts'`,
    `export { PhoneServer, LOCAL_ONLY } from '${root}/src/main/phone.ts'`
  ].join('\n')
)
const bundle = join(work, 'bundle.mjs')
buildSync({ entryPoints: [entry], outfile: bundle, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
const T = await import(pathToFileURL(bundle).href)

const TOKEN = 'test-ingest-token'
const OWNER = 'robertiuoras@gmail.com'
const PC = 'desktop-cmsucm1.tail6c8b58.ts.net'
const MAC = 'roberts-macbook-pro.tail6c8b58.ts.net'

// ---- a fake taskdriver.ai: issue + redeem, single use, the contract's checks ------------------

const issued = new Map() // sha256(ticket) -> { deviceId, aud, email, exp, used }
const redeems = [] // every request the desk made: headers + body
let mode = 'real' // 'real' | 'hang' | 'slow' | 'garbage' | 'big' | 'big-chunked' | 'other-email'
const fake = createServer((req, res) => {
  let text = ''
  req.setEncoding('utf8')
  req.on('data', (c) => (text += c))
  req.on('end', () => {
    let body = null
    try { body = JSON.parse(text) } catch { /* recorded as null */ }
    redeems.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body, raw: text })
    if (mode === 'hang') return // never answers; the desk's timeout must end it
    const send = (code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(typeof value === 'string' ? value : JSON.stringify(value)) }
    if (mode === 'garbage') return send(200, '<html>not json</html>')
    if (mode === 'big') return send(200, { email: OWNER, pad: 'x'.repeat(10_000) })
    if (mode === 'big-chunked') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write(`{"email":"${OWNER}","pad":"`)
      for (let i = 0; i < 10; i++) res.write('x'.repeat(1000))
      return res.end('"}')
    }
    if (mode === 'slow') return setTimeout(() => send(403, { error: 'ticket refused' }), 1500)
    if (req.url !== '/api/app/desk-ticket/redeem' || req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' })
    const row = body && typeof body.ticket === 'string' ? issued.get(createHash('sha256').update(body.ticket).digest('hex')) : null
    if (!row || row.used || row.exp <= Date.now() || row.deviceId !== body.deviceId || row.aud !== body.aud) return send(403, { error: 'ticket refused' })
    row.used = true
    send(200, { email: mode === 'other-email' ? 'someone@example.com' : row.email })
  })
})
await new Promise((r) => fake.listen(0, '127.0.0.1', r))
const fakePort = fake.address().port
process.env.PF_TASKDRIVER_REDEEM_URL = `http://127.0.0.1:${fakePort}/api/app/desk-ticket/redeem`
const issue = ({ deviceId, aud = PC, email = OWNER, life = 120_000 } = {}) => {
  const ticket = randomBytes(32).toString('base64url')
  issued.set(createHash('sha256').update(ticket).digest('hex'), { deviceId, aud, email, exp: Date.now() + life, used: false })
  return ticket
}

// ---- 1. the desk's owner and name: Tailscale's own answers -----------------------------------

const ME = '7132691346616570'
// Measured on the Mac 2026-10-03: `User[Self.UserID]` carries ID, LoginName, DisplayName,
// ProfilePicURL; `Self.DNSName` is the full name with a trailing dot.
const statusJson = (dns = `${PC}.`, state = 'Running') => `{"BackendState":"${state}","Self":{"UserID":${ME},"OS":"windows","DNSName":"${dns}"},"User":{"${ME}":{"ID":${ME},"LoginName":"${OWNER}","DisplayName":"Robert","ProfilePicURL":""},"1929821953316901":{"ID":1929821953316901,"LoginName":"other@example.com"}}}`
{
  ok(T.parseSelfLogin(statusJson()) === OWNER, 'status gives this desk\'s own login', T.parseSelfLogin(statusJson()))
  ok(T.parseSelfUser(statusJson()) === ME, 'and still its user id')
  ok(T.parseSelfDns(statusJson()) === PC, 'and its own DNS name, trailing dot removed', T.parseSelfDns(statusJson()))
  ok(T.parseSelfDns(statusJson('Roberts-MacBook-Pro.tail6c8b58.ts.net.')) === MAC, 'the DNS name is lowercased')
  ok(T.parseSelfDns(statusJson(`${PC}.`, 'Stopped')) === '' && T.parseSelfLogin(statusJson(`${PC}.`, 'Stopped')) === '', 'a stopped tailscaled has no name and no owner')
  ok(T.parseSelfDns('') === '' && T.parseSelfDns(statusJson('')) === '' && T.parseSelfDns(statusJson('bad name.')) === '', 'unreadable status has no name')
  const calls = []
  const id = new T.TailnetIdentity({ binary: 'tailscale', run: async (_b, args) => { calls.push(args); return { out: statusJson(), err: '', code: 0 } } })
  const [login, user, dns] = await Promise.all([id.selfLogin(), id.selfUser(), id.selfDns()])
  ok(login === OWNER && user === ME && dns === PC && calls.length === 1, 'login, user id and name come from one cached status call', String(calls.length))
  const none = new T.TailnetIdentity({ binary: '' })
  ok((await none.selfLogin()) === '' && (await none.selfDns()) === '', 'no tailscale on the machine: no owner, no name')
}

// ---- 2. the redeem client and the owner compare ----------------------------------------------

{
  ok(T.REDEEM_URL === 'https://app.taskdriver.ai/api/app/desk-ticket/redeem' && T.REDEEM_TIMEOUT_MS === 8000, 'contract address and 8 s timeout')
  ok(T.deskTicketShape(randomBytes(32).toString('base64url')) && !T.deskTicketShape('v1.abc.def') && !T.deskTicketShape('') && !T.deskTicketShape(42), 'a ticket is 43 base64url characters')
  const dev = 'TDdevice-0123456789abcdef'
  const t = issue({ deviceId: dev })
  redeems.length = 0
  const good = await T.redeemDeskTicket({ ticket: t, deviceId: dev, aud: PC, token: TOKEN })
  ok(good.email === OWNER, '200 with an email redeems', JSON.stringify(good))
  const sent = redeems[0]
  ok(sent?.method === 'POST' && sent.auth === `Bearer ${TOKEN}` && sent.type === 'application/json', 'sent as postPush sends: POST, Bearer ingest token, JSON', JSON.stringify(sent && { m: sent.method, t: sent.type }))
  ok(sent && JSON.stringify(sent.body) === JSON.stringify({ ticket: t, deviceId: dev, aud: PC }), 'body is exactly {ticket, deviceId, aud}', sent?.raw)
  const again = await T.redeemDeskTicket({ ticket: t, deviceId: dev, aud: PC, token: TOKEN })
  ok('refused' in again && /HTTP 403/.test(again.refused), 'a spent ticket is 403 refused', JSON.stringify(again))
  const wrongToken = await T.redeemDeskTicket({ ticket: issue({ deviceId: dev }), deviceId: dev, aud: PC, token: 'not-the-token' })
  ok('refused' in wrongToken, 'a wrong ingest token is refused', JSON.stringify(wrongToken))
  mode = 'garbage'
  const garbage = await T.redeemDeskTicket({ ticket: issue({ deviceId: dev }), deviceId: dev, aud: PC, token: TOKEN })
  ok('refused' in garbage && /not JSON/.test(garbage.refused), 'a 200 that is not JSON is refused', JSON.stringify(garbage))
  mode = 'hang'
  const started = Date.now()
  const late = await T.redeemDeskTicket({ ticket: issue({ deviceId: dev }), deviceId: dev, aud: PC, token: TOKEN }, 300)
  ok('refused' in late && /did not answer/.test(late.refused) && Date.now() - started < 3000, 'a server that never answers is refused at the timeout', `${JSON.stringify(late)} ${Date.now() - started} ms`)
  mode = 'big'
  const big = await T.redeemDeskTicket({ ticket: issue({ deviceId: dev }), deviceId: dev, aud: PC, token: TOKEN })
  ok('refused' in big && /far more/.test(big.refused), 'a 200 far bigger than an email is refused unread', JSON.stringify(big))
  mode = 'big-chunked'
  const chunked = await T.redeemDeskTicket({ ticket: issue({ deviceId: dev }), deviceId: dev, aud: PC, token: TOKEN })
  ok('refused' in chunked && /far more/.test(chunked.refused), 'so is one sent in chunks with no length', JSON.stringify(chunked))
  mode = 'real'
  const url = process.env.PF_TASKDRIVER_REDEEM_URL
  for (const [value, kept] of [
    ['https://evil.example/api/app/desk-ticket/redeem', false],
    ['http://10.0.0.5/api/app/desk-ticket/redeem', false],
    ['http://127.0.0.1.evil.example/x', false],
    ['http://127.0.0.1@evil.example/x', false],
    ['', false],
    ['http://localhost:4000/api/app/desk-ticket/redeem', true],
    [url, true]
  ]) {
    process.env.PF_TASKDRIVER_REDEEM_URL = value
    ok(T.redeemUrl() === (kept ? value : T.REDEEM_URL), `override ${value || '(empty)'} is ${kept ? 'used (loopback test server)' : 'ignored'}`, T.redeemUrl())
  }
  process.env.PF_TASKDRIVER_REDEEM_URL = 'http://127.0.0.1:9/api/app/desk-ticket/redeem'
  const down = await T.redeemDeskTicket({ ticket: issue({ deviceId: dev }), deviceId: dev, aud: PC, token: TOKEN })
  ok('refused' in down && /could not be reached/.test(down.refused), 'a server that is down is refused', JSON.stringify(down))
  process.env.PF_TASKDRIVER_REDEEM_URL = url

  ok(T.sameOwner('robertiuoras@gmail.com', OWNER) && T.sameOwner('RobertIuoras@Gmail.COM', OWNER), 'owner compare: ASCII case-insensitive')
  ok(!T.sameOwner('someone@example.com', OWNER), 'another account is not the owner')
  ok(!T.sameOwner('', '') && !T.sameOwner(OWNER, '') && !T.sameOwner('', OWNER), 'empty never matches')
  ok(!T.sameOwner('robertiuoras@gmail.com ', OWNER) && !T.sameOwner('robertiuoras@gmail.coK', 'robertiuoras@gmail.cok'), 'strict: no trimming, no Unicode folding (Kelvin sign is not k)')
}

// ---- 3. the door ------------------------------------------------------------------------------

const staticDir = join(work, 'renderer')
mkdirSync(staticDir, { recursive: true })
writeFileSync(join(staticDir, 'index.html'), '<html>THE-REAL-UI</html>')
let devices = []
let grants = []
let receipts = []
let token = TOKEN
let owner = OWNER
let selfName = PC
let tailscaleAsked = 0
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
  // The phone is NOT on the tailnet: whois never knows it. Only the desk's own answers matter.
  tailnet: {
    whois: async () => null,
    selfUser: async () => { tailscaleAsked++; return ME },
    selfLogin: async () => { tailscaleAsked++; return owner },
    selfDns: async () => { tailscaleAsked++; return selfName }
  },
  ingestToken: () => token,
  trustLog: (line) => logs.push(line)
}
const server = new T.PhoneServer(phoneDeps)
await server.start(0, '127.0.0.1')
const port = server.server.address().port

/** One request; a door that never answers is a FAILED check after 10 s, not a hung run (Windows takes ~2 s to refuse a closed loopback port). */
function callOn(p, method, path, { headers = {}, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: p, method, path, headers: { host: PC, ...headers, ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (text += c))
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch { /* plain */ }
        resolve({ status: res.statusCode, text, json })
      })
    })
    req.setTimeout(10_000, () => { req.destroy(); resolve({ status: 'no answer in 10 s', text: '', json: null }) })
    req.on('error', reject)
    req.end(raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body))
  })
}
const call = (...a) => callOn(port, ...a)
// What Tailscale Funnel hands the phone server: one public address, https, the Funnel mark.
let nextIp = 10
const funnel = (ip = `203.0.113.${nextIp++}`) => ({ 'x-forwarded-for': ip, 'x-forwarded-proto': 'https', 'x-forwarded-host': PC, 'tailscale-funnel-request': '?1' })
const app = { deviceId: 'TDdevice-0123456789abcdef', deviceName: 'Robert iPhone' }
const signIn = (ticket, { headers = funnel(), body = {} } = {}) => call('POST', '/pf/native/v1/auth/taskdriver', { headers, body: { ticket, ...app, ...body } })
const appTicket = (over = {}) => issue({ deviceId: app.deviceId, ...over })
const ROW = 'td-' + createHash('sha256').update(app.deviceId).digest('hex').slice(0, 24)

try {
  redeems.length = 0
  const ticket = appTicket()
  const r = await signIn(ticket)
  ok(r.status === 200, 'a good ticket gets a grant', `${r.status} ${r.text}`)
  ok(r.json && Object.keys(r.json).sort().join() === 'accessToken,deviceId,expiresAt,grantId,hostName,unlockedUntil' && Object.values(r.json).every((x) => typeof x === 'string'), 'it answers the NativeTokenResponse shape', r.text)
  ok(r.json?.hostName === PC && r.json?.deviceId === app.deviceId, 'hostName is this desk', r.json?.hostName)
  ok(redeems.length === 1 && redeems[0].auth === `Bearer ${TOKEN}` && JSON.stringify(redeems[0].body) === JSON.stringify({ ticket, deviceId: app.deviceId, aud: PC }), 'the desk redeemed it once with its own name as aud', redeems.map((x) => x.raw).join(' | '))
  ok(Date.parse(r.json?.unlockedUntil) > Date.now() + 14 * 60_000 && Date.parse(r.json?.expiresAt) > Date.now() + 29 * 86_400_000, 'read+control for 30 days with the 15-minute control window')
  ok(devices.length === 1 && devices[0].id === ROW && devices[0].kind === 'iPhone' && devices[0].ua === 'Taskdriver app (Robert iPhone)', 'one Devices row for the app install', JSON.stringify(devices.map(({ token: _t, ...d }) => d)))
  ok(grants.length === 1 && grants[0].browserDevice === ROW && grants[0].scopes.join() === 'read,control', 'grant bound to that row with read+control')
  ok(logs.length === 1 && /ALLOWED taskdriver sign-in ip=203\.0\.113\.\d+ device=Robert iPhone - /.test(logs[0]), 'one trust line for the decision', logs.join(' | '))
  const auth = { authorization: `Bearer ${r.json?.accessToken}` }
  const list = await call('GET', '/pf/native/v1/sessions', { headers: { ...funnel(), ...auth } })
  ok(list.status === 200 && list.json?.sessions?.[0]?.id === 's1', 'its bearer reads the desk\'s sessions', `${list.status} ${list.text.slice(0, 80)}`)
  const control = await call('POST', '/pf/native/v1/sessions/s1/keep-open', { headers: { ...funnel(), ...auth }, body: { keepOpen: true } })
  ok(control.status === 200, 'and controls inside its 15-minute window', `${control.status} ${control.text}`)

  // Refusals: 403, nothing written, one log line each, never the ticket or the token.
  const before = JSON.stringify({ devices, grants })
  const refusal = async (what, t, opts = {}, pattern = /REFUSED taskdriver sign-in/) => {
    const n = logs.length
    const res = await signIn(t, opts)
    ok(res.status === 403, `${what}: refused 403`, `${res.status} ${res.text}`)
    ok(logs.length === n + 1 && pattern.test(logs.at(-1)), `${what}: one REFUSED line`, logs.slice(n).join(' | '))
  }
  await refusal('replay (Taskdriver spends a ticket once)', ticket)
  await refusal('a ticket Taskdriver never issued', randomBytes(32).toString('base64url'))
  await refusal('expired at Taskdriver', appTicket({ life: -1 }))
  await refusal('issued for another device', appTicket({ deviceId: 'TDdevice-someone-elses-0000' }))
  // Funnel and serve pass Host through: a PC ticket sent to the Mac carries Host = the PC's name.
  selfName = MAC
  redeems.length = 0
  await refusal('a PC ticket at the Mac, Host saying PC', appTicket({ aud: PC }), { headers: { ...funnel(), host: PC } })
  ok(redeems.at(-1)?.body?.aud === MAC, 'aud is the desk\'s own Tailscale name, never the Host header', JSON.stringify(redeems.at(-1)?.body))
  selfName = PC
  mode = 'other-email'
  await refusal('Taskdriver names another account', appTicket(), {}, /another account/)
  mode = 'garbage'
  await refusal('Taskdriver answers garbage', appTicket())
  mode = 'real'
  const url = process.env.PF_TASKDRIVER_REDEEM_URL
  process.env.PF_TASKDRIVER_REDEEM_URL = 'http://127.0.0.1:9/api/app/desk-ticket/redeem'
  await refusal('Taskdriver is down', appTicket(), {}, /could not be reached/)
  process.env.PF_TASKDRIVER_REDEEM_URL = url
  redeems.length = 0
  token = null
  await refusal('no ingest token on the desk', appTicket(), {}, /no Taskdriver token/)
  token = TOKEN
  owner = ''
  await refusal('no Tailscale login for the desk', appTicket(), {}, /owner/)
  owner = OWNER
  selfName = ''
  await refusal('no Tailscale name for the desk', appTicket(), {}, /name/)
  selfName = PC
  ok(redeems.length === 0, 'with no token, owner or name Taskdriver is never asked', String(redeems.length))
  ok(JSON.stringify({ devices, grants }) === before, 'refusals wrote no device row and no grant')
  const allLogs = logs.join('\n')
  ok(!allLogs.includes(ticket) && !allLogs.includes(TOKEN) && !allLogs.includes(r.json?.accessToken), 'no ticket and no token in the log')

  // Bad requests: 400 before anything is asked, and always ANSWERED.
  const plain = await signIn(appTicket(), { headers: { 'x-forwarded-for': '203.0.113.200' } })
  ok(plain.status === 400, 'plain http is 400', String(plain.status))
  ok((await signIn(appTicket(), { body: { deviceId: 'short' } })).status === 400, 'an invalid device id is 400')
  ok((await signIn('v1.not.a-ticket')).status === 400, 'a ticket of the wrong shape is 400')
  ok((await call('POST', '/pf/native/v1/auth/taskdriver', { headers: funnel(), body: app })).status === 400, 'no ticket is 400')
  for (const path of ['/pf/native/v1/auth/taskdriver', '/pf/native/v1/auth/tailnet']) {
    for (const raw of ['null', '{"__pf_undefined":true}', '[1,2]', '"text"']) {
      const res = await call('POST', path, { headers: funnel(), raw })
      ok(res.status === 400, `${path.split('/').pop()}: body ${raw} is answered 400, never left hanging`, String(res.status))
    }
  }
  ok(redeems.length === 0, 'and Taskdriver was never asked for any of them')

  // The contract's control flow: a lapsed window answers 423 off the tailnet, a fresh ticket
  // signs in again (same row, same grant id, old token replaced) and the call goes through.
  grants = grants.map((g) => ({ ...g, unlockedUntil: Date.now() - 1 }))
  const lapsed = await call('POST', '/pf/native/v1/sessions/s1/keep-open', { headers: { ...funnel(), ...auth }, body: { keepOpen: true } })
  ok(lapsed.status === 423, 'a lapsed control window is 423 locked', `${lapsed.status} ${lapsed.text}`)
  const again = await signIn(appTicket())
  ok(again.status === 200 && again.json?.grantId === r.json?.grantId && devices.length === 1 && grants.length === 1, 'a fresh ticket signs in again on the same row and grant', `${again.status} ${again.text}`)
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
  for (let i = 0; i < 11; i++) last = (await signIn(randomBytes(32).toString('base64url'), { headers: funnel('198.51.100.7') })).status
  ok(last === 429, 'the eleventh try in a minute is 429', String(last))

  // Many addresses at once: at most 4 redeems wait on taskdriver.ai and 30 go out a minute in
  // all, so a crowd cannot pile up token-carrying calls or spend the token's limit at Taskdriver.
  const capped = new T.PhoneServer(phoneDeps)
  await capped.start(0, '127.0.0.1')
  try {
    const cport = capped.server.address().port
    const capIn = (i, t = randomBytes(32).toString('base64url')) => callOn(cport, 'POST', '/pf/native/v1/auth/taskdriver', { headers: funnel(`192.0.2.${i}`), body: { ticket: t, ...app } })
    mode = 'slow'
    redeems.length = 0
    const n = logs.length
    const crowd = await Promise.all([1, 2, 3, 4, 5].map((i) => capIn(i)))
    const codes = crowd.map((x) => x.status).sort().join()
    ok(codes === '403,403,403,403,429' && redeems.length === 4, 'five at once: four redeemed, the fifth 429', `${codes} redeems=${redeems.length}`)
    ok(logs.slice(n).some((l) => /REFUSED .* too many sign-ins at once/.test(l)), 'the crowd refusal is logged', logs.slice(n).join(' | '))
    mode = 'real'
    let sent = 4, code = 0
    for (let i = 6; i < 60 && code !== 429; i++) { code = (await capIn(i)).status; if (code !== 429) sent++ }
    ok(code === 429 && sent === 30 && redeems.length === 30, 'the 31st redeem in a minute from fresh addresses is 429', `code=${code} sent=${sent} redeems=${redeems.length}`)
  } finally {
    mode = 'real'
    await capped.stop()
  }

  // Phone access switched off: the loopback-only listener refuses before anyone is asked.
  const locked = new T.PhoneServer(phoneDeps)
  await locked.start(0, T.LOCAL_ONLY)
  try {
    const lport = locked.server.address().port
    const n = logs.length, devBefore = devices.length, grantBefore = grants.length, asked = tailscaleAsked
    redeems.length = 0
    const off = await callOn(lport, 'POST', '/pf/native/v1/auth/taskdriver', { headers: funnel(), body: { ticket: appTicket(), ...app } })
    ok(off.status === 403, 'phone access off: refused 403', `${off.status} ${off.text}`)
    ok(logs.length === n + 1 && /switched off/.test(logs.at(-1)), 'phone access off: refusal logged', logs.at(-1))
    ok(devices.length === devBefore && grants.length === grantBefore && tailscaleAsked === asked && redeems.length === 0, 'phone access off: nothing written, neither Tailscale nor Taskdriver asked')
  } finally {
    await locked.stop()
  }
} finally {
  await server.stop()
  fake.closeAllConnections()
  await new Promise((r) => fake.close(r))
  rmSync(work, { recursive: true, force: true })
}

console.log(`desk ticket: ${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
