// Robert's phone on Tailscale gets in with no code, and nothing else does.
//
// The rule is `src/shared/tailnetIdentity.ts`, the CLI half `src/main/tailnetIdentity.ts`,
// the doors `src/main/phone.ts` (`/pf/native/v1/auth/tailnet`, `/pf/ask`, control unlock)
// and `src/main/nativeAuth.ts` (direct grant, sliding renewal). No tailnet, no window: the
// whois answers are the SHAPE measured on the PC on 2026-10-02 (`tailscale whois --json`),
// and requests arrive on loopback with the headers `tailscale serve` was measured setting.

import { buildSync } from 'esbuild'
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

const work = mkdtempSync(join(tmpdir(), 'pf-tailnet-'))
const entry = join(work, 'entry.ts')
const root = process.cwd().replace(/\\/g, '/')
writeFileSync(
  entry,
  [
    `export * from '${root}/src/shared/tailnetIdentity.ts'`,
    `export { TailnetIdentity } from '${root}/src/main/tailnetIdentity.ts'`,
    `export { NativeAuth } from '${root}/src/main/nativeAuth.ts'`,
    `export { PhoneServer, LOCAL_ONLY } from '${root}/src/main/phone.ts'`
  ].join('\n')
)
const bundle = join(work, 'bundle.mjs')
buildSync({ entryPoints: [entry], outfile: bundle, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
const T = await import(pathToFileURL(bundle).href)

// ---- the measured shapes ------------------------------------------------------------------

const ME = '7132691346616570'
const OTHER = '1929821953316901'
const whoisJson = ({ user = ME, os = 'iOS', name = 'iphone182', stable = 'nLCbo8TUJ511CNTRL', login = 'robertiuoras@gmail.com', tags } = {}) =>
  `{"Node":{"ID":3471953536616604,"StableID":"${stable}","Name":"${name}.tail6c8b58.ts.net.","User":${user},` +
  (tags ? `"Tags":${JSON.stringify(tags)},` : '') +
  `"Hostinfo":{"OS":"${os}","Hostname":"localhost"},"ComputedName":"${name}"},` +
  `"UserProfile":{"ID":${user},"LoginName":"${login}","DisplayName":"Robert"},"CapMap":{}}`
const statusJson = `{"BackendState":"Running","Self":{"UserID":${ME},"OS":"windows","DNSName":"desktop-cmsucm1.tail6c8b58.ts.net."}}`
const PHONE_IP = '100.77.241.30'
const MAC_IP = '100.89.94.66'
const served = (ip = PHONE_IP, extra = {}) => ({
  'x-forwarded-for': ip,
  'x-forwarded-proto': 'https',
  'x-forwarded-host': 'desktop-cmsucm1.tail6c8b58.ts.net',
  'tailscale-user-login': 'robertiuoras@gmail.com',
  'tailscale-user-name': 'Robert',
  ...extra
})

// ---- 1. the pure rule ---------------------------------------------------------------------

{
  const phone = T.parseWhois(whoisJson())
  ok(phone && phone.userId === ME && phone.os === 'iOS' && phone.name === 'iphone182' && phone.stableId === 'nLCbo8TUJ511CNTRL', 'whois parses the measured shape', JSON.stringify(phone))
  ok(T.parseWhois('peer not found') === null, 'whois failure text is no node')
  ok(T.parseWhois('') === null, 'empty whois is no node')
  ok(T.parseSelfUser(statusJson) === ME, 'status gives this desk\'s user id')
  ok(T.parseSelfUser('{"BackendState":"Stopped","Self":{"UserID":1}}') === '', 'a stopped tailscaled has no user')
  // Two ids that are the same double are different people.
  const a = T.parseWhois(whoisJson({ user: '9007199254740993' }))
  ok(a && a.userId === '9007199254740993', 'user ids are compared as text, not as rounded numbers', a?.userId)
  ok(!T.judgeTailnet({ ip: PHONE_IP, login: 'robertiuoras@gmail.com' }, a, '9007199254740992').trusted, 'ids equal only as doubles are refused')

  const judge = (headers, node, self = ME, socket = '127.0.0.1') => T.judgeTailnet(T.tailnetSource({ socket, headers }), node, self)
  const yes = judge(served(), phone)
  ok(yes.trusted, 'same-user iOS node through serve is trusted', yes.reason)
  const mac = judge(served(MAC_IP), T.parseWhois(whoisJson({ os: 'macOS', name: 'roberts-macbook-pro' })))
  ok(!mac.trusted && /macOS/.test(mac.reason), 'same-user macOS node is refused, naming macOS', mac.reason)
  const other = judge(served('100.100.1.2', { 'tailscale-user-login': 'someone@example.com' }), T.parseWhois(whoisJson({ user: OTHER, login: 'someone@example.com' })))
  ok(!other.trusted && /another person/.test(other.reason), 'other-user iOS node is refused', other.reason)
  const tagged = judge(served(), T.parseWhois(whoisJson({ user: OTHER, tags: ['tag:server'] })))
  ok(!tagged.trusted && /tagged/.test(tagged.reason), 'a tagged node is refused', tagged.reason)
  const funnel = judge({ ...served(), 'tailscale-funnel-request': '?1' }, phone)
  ok(!funnel.trusted && /Funnel/.test(funnel.reason), 'a Funnel request is refused', funnel.reason)
  const cf = judge({ ...served(), 'cf-connecting-ip': PHONE_IP }, phone)
  ok(!cf.trusted && /cloudflared/.test(cf.reason), 'a cloudflared (or cf-forged) request is refused', cf.reason)
  const lan = judge(served(), phone, ME, '192.168.1.40')
  ok(!lan.trusted && /serve/.test(lan.reason), 'forged serve headers from a non-loopback socket are refused', lan.reason)
  const tailnetDirect = judge(served(), phone, ME, PHONE_IP)
  ok(!tailnetDirect.trusted, 'a tailnet peer hitting the port directly is refused')
  ok(!judge(served(`1.2.3.4, ${PHONE_IP}`), phone).trusted, 'more than one forwarded hop is refused')
  ok(!judge(served('8.8.8.8'), phone).trusted, 'a non-tailnet forwarded address is refused')
  const nologin = served(); delete nologin['tailscale-user-login']
  ok(!judge(nologin, phone).trusted, 'no Tailscale-User-Login (not a tailnet request) is refused')
  ok(!judge(served(PHONE_IP, { 'tailscale-user-login': 'evil@example.com' }), phone).trusted, 'serve and whois naming different users is refused')
  const none = judge(served(), null)
  ok(!none.trusted && /does not know/.test(none.reason), 'whois failure or timeout is refused', none.reason)
  ok(!judge(served(), phone, '').trusted, 'unknown desk user is refused')
  ok(judge(served('fd7a:115c:a1e0::1234'), phone).trusted, 'a tailnet IPv6 address is a tailnet address')
  const line = T.trustLine(mac, 'app sign-in')
  ok(/REFUSED app sign-in ip=100\.89\.94\.66 node=roberts-macbook-pro \(macOS\)/.test(line), 'log line names node, OS and reason', line)
}

// ---- 2. the CLI half: cached, bounded, deduplicated ---------------------------------------

{
  const calls = []
  let clock = 1_000_000
  const answers = { [PHONE_IP]: { out: whoisJson(), code: 0 }, '100.1.1.1': { out: '', err: 'peer not found', code: 1 } }
  const id = new T.TailnetIdentity({
    binary: 'tailscale',
    now: () => clock,
    run: async (_b, args, timeout) => {
      calls.push({ args, timeout })
      await new Promise((r) => setTimeout(r, 20))
      if (args[0] === 'status') return { out: statusJson, err: '', code: 0 }
      if (args[2] === '100.2.2.2') return { out: '', err: '', code: 1 } // the timeout's shape: killed, non-zero
      return { err: '', ...(answers[args[2]] ?? { out: '', code: 1 }) }
    }
  })
  const [n1, n2] = await Promise.all([id.whois(PHONE_IP), id.whois(PHONE_IP)])
  ok(n1?.os === 'iOS' && n2 === n1, 'two concurrent lookups get one answer')
  ok(calls.filter((c) => c.args[2] === PHONE_IP).length === 1, 'two concurrent lookups make one call', String(calls.length))
  ok(calls.every((c) => c.timeout > 0 && c.timeout <= 5000), 'every call carries a short timeout')
  await id.whois(PHONE_IP)
  ok(calls.filter((c) => c.args[2] === PHONE_IP).length === 1, 'an answer is cached')
  clock += 4 * 60_000
  await id.whois(PHONE_IP)
  ok(calls.filter((c) => c.args[2] === PHONE_IP).length === 2, 'and re-asked after a few minutes')
  ok((await id.whois('100.1.1.1')) === null, 'peer not found is null')
  ok((await id.whois('100.2.2.2')) === null, 'a timed-out call is null')
  clock += 20_000
  await id.whois('100.1.1.1')
  ok(calls.filter((c) => c.args[2] === '100.1.1.1').length === 2, 'a failure is retried within seconds, not minutes')
  ok((await id.selfUser()) === ME && (await id.selfUser()) === ME, 'self user read')
  ok(calls.filter((c) => c.args[0] === 'status').length === 1, 'self user cached')
  const absent = new T.TailnetIdentity({ binary: '' })
  ok((await absent.whois(PHONE_IP)) === null && (await absent.selfUser()) === '', 'no tailscale on the machine trusts nothing')
}

// ---- 3. sliding renewal --------------------------------------------------------------------

{
  const DAY = 86_400_000
  let grants = []
  let code = 'v1'
  let saves = 0
  const auth = new T.NativeAuth(() => grants, (l) => { grants = l; saves++ }, () => code, () => 'localhost', () => [], () => {}, (d) => d === 'row')
  const issued = auth.grantDirect({ deviceId: 'a'.repeat(22), deviceName: 'iPhone' }, 'row', 'desk.ts.net')
  const g0 = grants[0]
  ok(issued.hostName === 'desk.ts.net' && issued.grantId === g0.id && Date.parse(issued.expiresAt) === g0.expiresAt, 'direct grant answers the /auth/token shape')
  ok(Object.keys(issued).sort().join() === 'accessToken,deviceId,expiresAt,grantId,hostName,unlockedUntil', 'exactly the contract fields', Object.keys(issued).join())
  saves = 0
  auth.bearer(issued.accessToken, 'read')
  ok(saves === 0 && grants[0].expiresAt === g0.expiresAt, 'a fresh grant is not rewritten on every use')
  grants = [{ ...grants[0], expiresAt: Date.now() + 10 * DAY }]
  const used = auth.bearer(issued.accessToken, 'read')
  ok(used && used.expiresAt > Date.now() + 29 * DAY && grants[0].expiresAt === used.expiresAt, 'a grant used past half its life slides a full term on, persisted')
  grants = [{ ...grants[0], expiresAt: Date.now() - 1 }]
  ok(auth.bearer(issued.accessToken, 'read') === null, 'an unused grant still expires')
  const again = auth.grantDirect({ deviceId: 'a'.repeat(22), deviceName: 'iPhone' }, 'row', 'desk.ts.net')
  ok(auth.bearer(again.accessToken, 'read'), 'a fresh direct grant works')
  code = 'v2'
  ok(auth.bearer(again.accessToken, 'read') === null, 'code rotation still revokes')
  code = 'v1'
  ok(grants.length === 0, 'and the rotated-out grant is swept')
  const locked = auth.grantDirect({ deviceId: 'b'.repeat(22), deviceName: 'iPhone' }, 'row', 'x')
  grants = grants.map((g) => ({ ...g, unlockedUntil: Date.now() - 1 }))
  const opened = auth.unlock(auth.bearer(locked.accessToken, 'control'))
  ok(opened.unlockedUntil > Date.now() && grants[0].unlockedUntil === opened.unlockedUntil, 'unlock moves and persists the control window')
  let threw = false
  try { auth.grantDirect({ deviceId: 'short', deviceName: 'iPhone' }, 'row', 'x') } catch { threw = true }
  ok(threw, 'direct grant validates the device id like start')
  threw = false
  try { auth.grantDirect({ deviceId: 'c'.repeat(22), deviceName: 'iPhone' }, 'gone', 'x') } catch { threw = true }
  ok(threw, 'direct grant refuses a device row that does not exist')
}

// ---- 4. the doors -------------------------------------------------------------------------

const staticDir = join(work, 'renderer')
mkdirSync(staticDir, { recursive: true })
writeFileSync(join(staticDir, 'index.html'), '<html>THE-REAL-UI</html>')
let code = 'CODE-ONE-LONG-ENOUGH'
let devices = []
let grants = []
let receipts = []
let asking = false
const logs = []
const nodes = {
  [PHONE_IP]: T.parseWhois(whoisJson()),
  [MAC_IP]: T.parseWhois(whoisJson({ os: 'macOS', name: 'roberts-macbook-pro', stable: 'n5PJtFLT7U11CNTRL' }))
}
let whoisCalls = 0
const phoneDeps = {
  staticDir,
  code: () => code,
  secret: () => 'device-secret',
  invoke: async () => 'value',
  send: () => {},
  channels: { invoke: ['pane:answer', 'sessions:list'], send: [], on: [] },
  devices: () => devices,
  saveDevices: (l) => { devices = l },
  canAsk: () => asking,
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
  tailnet: { whois: async (ip) => { whoisCalls++; return nodes[ip] ?? null }, selfUser: async () => ME },
  trustLog: (line) => logs.push(line)
}
const server = new T.PhoneServer(phoneDeps)
await server.start(0, '127.0.0.1')
const port = server.server.address().port

function call(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { host: 'desktop-cmsucm1.tail6c8b58.ts.net', ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (text += c))
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch { /* plain */ }
        resolve({ status: res.statusCode, text, json, headers: res.headers })
      })
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
const app = { deviceId: 'TDdevice-0123456789abcdef', deviceName: 'Robert iPhone' }
const grantFor = (headers = served()) => call('POST', '/pf/native/v1/auth/tailnet', { headers, body: app })

try {
  const r = await grantFor()
  ok(r.status === 200, 'trusted phone gets a grant', `${r.status} ${r.text}`)
  ok(r.json && ['accessToken', 'expiresAt', 'unlockedUntil', 'deviceId', 'grantId', 'hostName'].every((k) => typeof r.json[k] === 'string'), 'grant answers the contract shape', r.text)
  ok(r.json?.hostName === 'desktop-cmsucm1.tail6c8b58.ts.net', 'hostName is the desk the phone reached', r.json?.hostName)
  ok(devices.length === 1 && devices[0].origin === 'tailnet' && devices[0].id === 'ts-nLCbo8TUJ511CNTRL' && devices[0].kind === 'iPhone', 'one Devices row for the node, from Tailscale', JSON.stringify(devices.map(({ token, ...d }) => d)))
  ok(grants.length === 1 && grants[0].browserDevice === devices[0].id && grants[0].scopes.join() === 'read,control', 'grant bound to that row with read+control')
  ok(logs.some((l) => /ALLOWED app sign-in ip=100\.77\.241\.30 node=iphone182 \(iOS\)/.test(l)), 'trust decision logged', logs.at(-1))
  ok(!logs.some((l) => l.includes(r.json?.accessToken) || l.includes(devices[0].token)), 'no token in the log')
  const auth = { authorization: `Bearer ${r.json?.accessToken}` }
  const list = await call('GET', '/pf/native/v1/sessions', { headers: { ...served(), ...auth } })
  ok(list.status === 200, 'its bearer reads the desk', String(list.status))
  const overFunnel = await call('GET', '/pf/native/v1/sessions', { headers: { 'x-forwarded-for': '115.186.231.114', 'x-forwarded-proto': 'https', 'tailscale-funnel-request': '?1', ...auth } })
  ok(overFunnel.status === 200, 'and keeps reading over Funnel - the grant is the credential there', String(overFunnel.status))

  const again = await grantFor()
  ok(again.status === 200 && devices.length === 1 && grants.length === 1 && again.json?.grantId === r.json?.grantId, 'signing in again reuses the row and the grant id')
  const stale = await call('GET', '/pf/native/v1/sessions', { headers: { ...served(), ...auth } })
  ok(stale.status === 401, 'the previous token is replaced', String(stale.status))
  const fresh = { authorization: `Bearer ${again.json?.accessToken}` }

  // Control: a lapsed control window is reopened by Tailscale, never over Funnel.
  grants = grants.map((g) => ({ ...g, unlockedUntil: Date.now() - 1 }))
  const funnelControl = await call('POST', '/pf/native/v1/sessions/s1/keep-open', { headers: { 'x-forwarded-for': '115.186.231.114', 'x-forwarded-proto': 'https', 'tailscale-funnel-request': '?1', ...fresh }, body: { keepOpen: true } })
  ok(funnelControl.status === 423, 'over Funnel a locked grant stays locked (passkey rule unchanged)', String(funnelControl.status))
  const tsControl = await call('POST', '/pf/native/v1/sessions/s1/keep-open', { headers: { ...served(), ...fresh }, body: { keepOpen: true } })
  ok(tsControl.status === 200, 'on Tailscale the phone controls with no passkey', `${tsControl.status} ${tsControl.text}`)
  ok(grants[0].unlockedUntil > Date.now(), 'and its control window is reopened')

  // Refusals write nothing.
  const before = JSON.stringify({ devices, grants })
  const macReq = await grantFor(served(MAC_IP))
  ok(macReq.status === 403 && macReq.text === 'not your phone on Tailscale', 'same-user Mac is refused 403', `${macReq.status} ${macReq.text}`)
  ok(logs.some((l) => /REFUSED app sign-in ip=100\.89\.94\.66 node=roberts-macbook-pro \(macOS\) - not a phone \(macOS\)/.test(l)), 'refusal logged naming macOS', logs.at(-1))
  const funnelReq = await grantFor({ 'x-forwarded-for': PHONE_IP, 'x-forwarded-proto': 'https', 'tailscale-funnel-request': '?1', 'tailscale-user-login': 'robertiuoras@gmail.com' })
  ok(funnelReq.status === 403, 'a Funnel request is refused 403')
  const cfReq = await grantFor({ ...served(), 'cf-connecting-ip': PHONE_IP })
  ok(cfReq.status === 403, 'a cloudflared-shaped request is refused 403')
  const unknown = await grantFor(served('100.99.99.99'))
  ok(unknown.status === 403, 'an address whois does not know is refused 403')
  ok(JSON.stringify({ devices, grants }) === before, 'refusals wrote no device row and no grant')
  const plain = await call('POST', '/pf/native/v1/auth/tailnet', { headers: { 'x-forwarded-for': PHONE_IP, 'tailscale-user-login': 'robertiuoras@gmail.com' }, body: app })
  ok(plain.status === 400, 'plain http is refused before anything is asked', String(plain.status))
  const bad = await call('POST', '/pf/native/v1/auth/tailnet', { headers: served(), body: { deviceId: 'x', deviceName: 'iPhone' } })
  ok(bad.status === 400, 'an invalid device id is 400, like start', String(bad.status))

  // Sign out on the row ends the grant; New code ends every grant.
  server.forgetDevice(devices[0].id)
  const out = await call('GET', '/pf/native/v1/sessions', { headers: { ...served(), ...fresh } })
  ok(out.status === 401 && grants.length === 0, 'Sign out revokes the row\'s grants', String(out.status))
  const back = await grantFor()
  ok(back.status === 200, 'the phone comes back by Tailscale identity after a sign-out')
  code = 'CODE-TWO-LONG-ENOUGH'
  const rotated = await call('GET', '/pf/native/v1/sessions', { headers: { ...served(), authorization: `Bearer ${back.json?.accessToken}` } })
  ok(rotated.status === 401, 'New code revokes it', String(rotated.status))

  // The browser surface: no card, no code, even with asking switched off.
  asking = false
  const ask = await call('POST', '/pf/ask', { headers: { ...served(), 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) Safari/604.1' } })
  ok(ask.status === 200 && ask.json?.trusted === true && server.state().ask === null, 'trusted phone at /pf/ask needs no desk card', `${ask.status} ${ask.text}`)
  const poll = await call('GET', `/pf/ask?id=${encodeURIComponent(ask.json?.id ?? '')}`, { headers: served() })
  const cookie = String(poll.headers['set-cookie'] ?? '').split(';')[0]
  ok(poll.json?.state === 'yes' && /^pf=[a-f0-9]{64}$/.test(cookie), 'its poll answers yes with a cookie', poll.text)
  ok(devices.length === 1 && devices[0].kind === 'iPhone' && /iPhone/.test(devices[0].ua), 'same row, now carrying the browser it signed in from')
  const page = await call('GET', '/', { headers: { ...served(), cookie } })
  ok(page.text.includes('THE-REAL-UI'), 'that cookie opens the desk')
  const twice = await call('GET', `/pf/ask?id=${encodeURIComponent(ask.json?.id ?? '')}`, { headers: served() })
  ok(twice.json?.state === 'gone', 'a trusted ask is answered once')
  const macAsk = await call('POST', '/pf/ask', { headers: served(MAC_IP) })
  ok(macAsk.status === 403, 'the Mac\'s browser with asking off is refused, as before', String(macAsk.status))
  asking = true
  const lanAsk = await call('POST', '/pf/ask', { headers: { 'x-forwarded-for': '192.168.1.40' } })
  ok(lanAsk.status === 200 && !lanAsk.json?.trusted && server.state().ask, 'anyone else still raises the desk card')
  server.answerAsk(false)

  // Browser control: the passkey gate is open for the trusted phone and shut over Funnel.
  const st = await call('GET', '/pf/key/state', { headers: { ...served(), cookie } })
  ok(st.json?.armed === true && st.json?.unlocked === true, 'trusted phone\'s browser is unlocked with no passkey', st.text.slice(0, 120))
  const gated = await call('POST', '/pf/call', { headers: { ...served(), cookie }, body: { id: 7, channel: 'pane:answer', args: [] } })
  ok(gated.json?.value === 'value', 'and reaches a gated channel', gated.text)
  const viaFunnel = { 'x-forwarded-for': '115.186.231.114', 'x-forwarded-proto': 'https', 'tailscale-funnel-request': '?1', cookie }
  const st2 = await call('GET', '/pf/key/state', { headers: viaFunnel })
  ok(st2.json?.unlocked === false, 'over Funnel the same browser still needs its passkey', st2.text.slice(0, 120))
  const gated2 = await call('POST', '/pf/call', { headers: viaFunnel, body: { id: 8, channel: 'pane:answer', args: [] } })
  ok(gated2.json?.locked === true, 'and a gated channel over Funnel is locked', gated2.text)

  // Rate limit, like start: ten a minute per address.
  let last = 0
  for (let i = 0; i < 11; i++) last = (await grantFor(served(MAC_IP, { 'x-forwarded-for': '100.64.0.9' }))).status
  ok(last === 429, 'the eleventh try in a minute is 429', String(last))
  // Phone access switched off: the loopback-only listener never trusts a tailnet request,
  // even when a leftover `tailscale serve` forwards one to it.
  const locked = new T.PhoneServer(phoneDeps)
  await locked.start(0, T.LOCAL_ONLY)
  try {
    const lport = locked.server.address().port
    const lcall = (method, path, headers, body) => new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: lport, method, path, headers: { host: 'desktop-cmsucm1.tail6c8b58.ts.net', ...headers, ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (text += c))
        res.on('end', () => { let json = null; try { json = JSON.parse(text) } catch { /* plain */ } resolve({ status: res.statusCode, text, json }) })
      })
      req.on('error', reject)
      req.end(body ? JSON.stringify(body) : undefined)
    })
    const devBefore = devices.length, grantBefore = grants.length, logBefore = logs.length, whoisBefore = whoisCalls
    const lg = await lcall('POST', '/pf/native/v1/auth/tailnet', served(), app)
    ok(lg.status === 403, 'phone access off: tailnet sign-in refused', `${lg.status} ${lg.text}`)
    const la = await lcall('POST', '/pf/ask', { ...served(), 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) Safari/604.1' })
    ok(!la.json?.trusted, 'phone access off: /pf/ask not trusted', `${la.status} ${la.text}`)
    ok(logs.slice(logBefore).some((l) => l.includes('phone access is switched off')), 'phone access off: refusal logged', logs.at(-1))
    ok(devices.length === devBefore && grants.length === grantBefore, 'phone access off: no device or grant written')
    ok(whoisCalls === whoisBefore, 'phone access off: Tailscale never asked')
  } finally {
    await locked.stop()
  }
} finally {
  await server.stop()
  rmSync(work, { recursive: true, force: true })
}

console.log(`tailnet trust: ${checks - failures}/${checks} checks passed`)
if (failures) process.exit(1)
