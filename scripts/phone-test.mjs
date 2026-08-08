// What the phone client may cost: nothing gets in without the code, every call lands in
// the app's own handler, and the two shapes plain JSON breaks survive the wire.
//
// No window, no Electron, no phone. `src/main/phone.ts` is a plain HTTP server over
// injected deps on purpose - that is what makes this a 2-second test instead of a
// device-in-the-loop one - so this drives a real server on a real port with fake deps and
// reads real bytes back.
//
// The load-bearing half is not the transport, it is the PARITY: `shared/surface.ts` is
// one list feeding two transports, and a method whose channel no handler answers is a
// button that does nothing on a phone and works on the desk. That is checked against the
// real `src/main/*.ts` text at the bottom.

import { buildSync } from 'esbuild'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readdirSync, readFileSync } from 'node:fs'

let failures = 0
let checks = 0
function ok(cond, what, detail = '') {
  checks++
  if (cond) return
  failures++
  console.error(`  FAIL ${what}${detail ? ` - ${detail}` : ''}`)
}

const work = mkdtempSync(join(tmpdir(), 'pf-phone-'))
const bundle = join(work, 'phone.mjs')
buildSync({
  entryPoints: ['src/main/phone.ts'],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const { PhoneServer, newPhoneCode, phoneUrls } = await import(bundle)

// The renderer the server hands out, standing in for out/renderer.
const staticDir = join(work, 'renderer')
mkdirSync(staticDir, { recursive: true })
writeFileSync(join(staticDir, 'index.html'), '<html>THE-REAL-UI</html>')
mkdirSync(join(staticDir, 'assets'), { recursive: true })
writeFileSync(join(staticDir, 'assets', 'app.js'), 'export const x = 1')

let code = 'ABC234'
const invoked = []
const sent = []
const server = new PhoneServer({
  staticDir,
  code: () => code,
  secret: () => 'device-secret',
  channels: {
    invoke: ['sessions:list', 'sounds:data', 'voice:transcribe', 'boom'],
    send: ['pty:write'],
    on: ['pty:data', 'sessions:changed']
  },
  invoke: async (channel, args) => {
    invoked.push([channel, args])
    if (channel === 'boom') throw new Error('handler said no')
    if (channel === 'sounds:data') return new Uint8Array([0, 127, 255, 3])
    if (channel === 'voice:transcribe') return `bytes:${args[0]?.length}`
    return [{ id: 'a' }]
  },
  send: (channel, args) => sent.push([channel, args])
})

const port = 7390 + (process.pid % 90)
const state = await server.start(port, '127.0.0.1')
ok(state.on, 'server is up', state.error)
ok(state.port === port, 'state names the port it bound')
const base = `http://127.0.0.1:${port}`

async function get(path, cookie) {
  return await fetch(base + path, { headers: cookie ? { cookie } : {}, redirect: 'manual' })
}
async function post(path, body, cookie) {
  return await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}

// ---- 1. nothing without the code ------------------------------------------------

{
  const res = await get('/')
  const text = await res.text()
  ok(res.status === 200, 'unpaired root answers')
  ok(!text.includes('THE-REAL-UI'), 'unpaired root is NOT the app', text.slice(0, 40))
  ok(text.includes('/pf/pair'), 'unpaired root is the pairing page')

  const asset = await get('/assets/app.js')
  ok(!(await asset.text()).includes('export const x'), 'not one asset leaks before pairing')

  const events = await get('/pf/events')
  ok(events.status === 401, 'the event stream refuses an unpaired browser', String(events.status))
  const call = await post('/pf/call', { id: 1, channel: 'sessions:list', args: [] })
  ok(call.status === 401, 'a call refuses an unpaired browser', String(call.status))
  ok(invoked.length === 0, 'and reached no handler')
}

// ---- 2. the code, and the lockout behind it -------------------------------------

let cookie = ''
{
  const wrong = await post('/pf/pair', { code: 'ZZZZZZ' })
  ok(wrong.status === 403, 'a wrong code is refused')
  ok(!wrong.headers.get('set-cookie'), 'and hands out no cookie')

  const short = await post('/pf/pair', { code: 'ABC23' })
  ok(short.status === 403, 'a prefix of the code is not the code')

  const right = await post('/pf/pair', { code: 'abc 234' })
  ok(right.status === 200, 'the code, lower case and spaced, is the code')
  const setCookie = right.headers.get('set-cookie') ?? ''
  ok(/^pf=[a-f0-9]{64};/.test(setCookie), 'cookie is a 32-byte digest', setCookie.slice(0, 20))
  ok(setCookie.includes('HttpOnly'), 'cookie is HttpOnly')
  ok(setCookie.includes('SameSite=Strict'), 'cookie is SameSite=Strict')
  cookie = setCookie.split(';')[0]

  // Five wrong ones from this address and it stops answering for a minute.
  let last = 0
  for (let i = 0; i < 6; i++) last = (await post('/pf/pair', { code: 'QQQQQQ' })).status
  ok(last === 429, 'five wrong codes buys a lockout', String(last))
  const during = await post('/pf/pair', { code: 'ABC234' })
  ok(during.status === 429, 'and the RIGHT code waits too - guessing is what is being stopped')
}

// ---- 3. paired: the real UI, and the real handlers ------------------------------

{
  const res = await get('/', cookie)
  ok((await res.text()).includes('THE-REAL-UI'), 'a paired browser gets the app')
  ok(res.headers.get('cache-control') === 'no-store', 'index.html is never cached')

  const asset = await get('/assets/app.js', cookie)
  ok((await asset.text()).includes('export const x'), 'and its assets')
  ok(asset.headers.get('content-type')?.startsWith('text/javascript'), 'with a usable type')

  const deep = await get('/does/not/exist', cookie)
  ok((await deep.text()).includes('THE-REAL-UI'), 'an unknown path falls back to the app')
}

// ---- 4. calls land in the app's own handler ------------------------------------

{
  const res = await post('/pf/call', { id: 7, channel: 'sessions:list', args: [] }, cookie)
  const body = await res.json()
  ok(body.id === 7, 'a call keeps its id')
  ok(JSON.stringify(body.value) === JSON.stringify([{ id: 'a' }]), 'and returns what main returned')
  ok(invoked.at(-1)[0] === 'sessions:list', 'through the real channel')

  const bad = await post('/pf/call', { id: 8, channel: 'nope:nope', args: [] }, cookie)
  const badBody = await bad.json()
  ok(/unknown channel/.test(badBody.error ?? ''), 'a channel off the surface is refused by name')

  const thrown = await post('/pf/call', { id: 9, channel: 'boom', args: [] }, cookie)
  const thrownBody = await thrown.json()
  ok(thrownBody.error === 'handler said no', 'a handler that threw arrives as its sentence')
}

// ---- 5. sends stay in order, and only listed ones happen -----------------------

{
  await post(
    '/pf/send',
    {
      calls: [
        { channel: 'pty:write', args: ['p1', 'a'] },
        { channel: 'pty:write', args: ['p1', 'b'] },
        { channel: 'shell:external', args: ['http://evil'] },
        { channel: 'pty:write', args: ['p1', 'c'] }
      ]
    },
    cookie
  )
  const typed = sent.filter((s) => s[0] === 'pty:write').map((s) => s[1][1])
  ok(typed.join('') === 'abc', 'a batch of keystrokes arrives in order', typed.join(''))
  ok(!sent.some((s) => s[0] === 'shell:external'), 'a channel off the surface is dropped')
}

// ---- 6. bytes, both ways -------------------------------------------------------

{
  const res = await post('/pf/call', { id: 10, channel: 'sounds:data', args: [] }, cookie)
  const raw = await res.text()
  ok(raw.includes('__pf_b64'), 'a Uint8Array answer travels as base64, not as {"0":..}', raw)
  const tag = JSON.parse(raw).value.__pf_b64
  ok(
    Buffer.from(tag, 'base64').toString('hex') === '007fff03',
    'and the bytes are the bytes',
    Buffer.from(tag, 'base64').toString('hex')
  )

  const wav = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
  const up = await post(
    '/pf/call',
    JSON.stringify({
      id: 11,
      channel: 'voice:transcribe',
      args: [{ __pf_b64: wav.toString('base64') }]
    }),
    cookie
  )
  ok((await up.json()).value === 'bytes:8', 'and a posted wav reaches the handler as bytes')
}

// ---- 7. events reach a browser, and nothing else does --------------------------

{
  const res = await fetch(base + '/pf/events', {
    headers: {
      cookie,
      'user-agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'
    }
  })
  ok(res.headers.get('content-type')?.startsWith('text/event-stream'), 'the stream is SSE')
  const reader = res.body.getReader()
  const seen = []
  const pump = (async () => {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && seen.length < 2) {
      const { value, done } = await reader.read()
      if (done) break
      for (const line of Buffer.from(value).toString('utf8').split('\n')) {
        if (line.startsWith('data: ')) seen.push(JSON.parse(line.slice(6)))
      }
    }
  })()
  await new Promise((r) => setTimeout(r, 150))
  ok(server.state().clients === 1, 'the desk knows one browser is watching')

  // ---- who is watching, not just how many ------------------------------------
  // The panel draws a row per live stream, so the row has to carry enough to tell one
  // device from another WITHOUT inventing an identity the cookie cannot supply.
  {
    const [peer, ...rest] = server.state().peers
    ok(!!peer && !rest.length, 'one live stream is one peer row')
    ok(peer.id, 'a peer row has an id to key on', JSON.stringify(peer))
    ok(peer.kind === 'iPhone', 'the device kind comes off the user-agent', peer.kind)
    // The listener is on 127.0.0.1 for this test, and that must not read as a stranger.
    ok(peer.origin === 'this machine', 'and it says where it came from', peer.origin)
    ok(
      !peer.address.startsWith('::ffff:'),
      'the address is normalised out of IPv4-mapped IPv6',
      peer.address
    )
    ok(
      typeof peer.since === 'number' && Date.now() - peer.since < 60_000,
      'and when the stream opened'
    )
    ok(
      !('res' in peer) && !('alive' in peer),
      'the response object does not leak into the state',
      Object.keys(peer).join(',')
    )
  }
  server.broadcast('pty:data', ['p1', 'hello from the pty'])
  server.broadcast('config:changed', [{ secret: true }])
  await pump
  const channels = seen.map((f) => f.channel)
  ok(channels.includes('phone:hello'), 'the stream opens by saying hello', channels.join(','))
  const data = seen.find((f) => f.channel === 'pty:data')
  ok(!!data && data.args[1] === 'hello from the pty', 'pty output arrives on it')
  ok(!channels.includes('config:changed'), 'a channel that is not a subscription is not pushed')
  await reader.cancel().catch(() => {})
}

// ---- 8. a rotated code signs every phone out -----------------------------------

{
  code = newPhoneCode()
  ok(/^[2-9BCDFGHJKMNPQRSTVWXZ]{6}$/.test(code), 'a fresh code is 6 unmistakable characters', code)
  const res = await get('/', cookie)
  ok(!(await res.text()).includes('THE-REAL-UI'), 'the old cookie no longer opens the app')
  code = 'ABC234'
  ok((await (await get('/', cookie)).text()).includes('THE-REAL-UI'), 'and the same code lets it back')
}

// ---- 9. a path may not leave the renderer folder -------------------------------

{
  writeFileSync(join(work, 'secret.txt'), 'PRIVATE')
  for (const path of [
    '/../secret.txt',
    '/..%2fsecret.txt',
    '/assets/../../secret.txt',
    '/%2e%2e/secret.txt'
  ]) {
    const text = await (await get(path, cookie)).text()
    ok(!text.includes('PRIVATE'), `no escape through ${path}`, text.slice(0, 30))
  }
}

// ---- 10. addresses, and a clean stop ------------------------------------------

{
  const urls = phoneUrls(port)
  ok(
    urls.every((u) => u.endsWith(`:${port}`)),
    'every address carries the port'
  )
  ok(
    !urls.some((u) => u.includes('127.0.0.1')),
    'loopback is not an address to type into a phone'
  )

  await server.stop()
  ok(!server.running, 'stop() means stopped')
  ok(server.state().clients === 0, 'and no client is still counted')
  ok(server.state().peers.length === 0, 'and nobody is still listed as watching')
  let refused = false
  await fetch(base + '/').catch(() => {
    refused = true
  })
  ok(refused, 'the port is closed, not just quiet')
}

// ---- 11. parity: one list, and a handler behind every line of it ---------------

{
  const surface = readFileSync('src/shared/surface.ts', 'utf8')
  const entries = [...surface.matchAll(/^ {2}(\w+): \['(\w+)'(?:, '([^']+)')?/gm)].map((m) => ({
    method: m[1],
    mode: m[2],
    channel: m[3]
  }))
  ok(entries.length > 130, 'the surface table is the whole api', String(entries.length))

  const registered = new Set()
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (p.endsWith('.ts')) {
        // The channel is sometimes on the line after `ipcMain.handle(` - hence the \s*.
        for (const m of readFileSync(p, 'utf8').matchAll(/ipcMain\.(handle|on)\(\s*'([^']+)'/g)) {
          registered.add(m[2])
        }
      }
    }
  }
  walk('src/main')

  const orphans = entries
    .filter((e) => e.mode !== 'local' && e.mode !== 'on' && !registered.has(e.channel))
    .map((e) => `${e.method} -> ${e.channel}`)
  ok(orphans.length === 0, 'every method the phone offers has a handler in main', orphans.join(', '))

  // The preload must not name channels of its own any more: two lists is the bug this
  // table exists to remove, and a stray ipcRenderer.invoke('...') there is that bug back.
  const preload = readFileSync('src/preload/index.ts', 'utf8')
  const strays = [...preload.matchAll(/ipcRenderer\.\w+\('([^']+)'/g)].map((m) => m[1])
  ok(strays.length === 0, 'the preload names no channel of its own', strays.join(', '))

  // And the events the app really sends must be subscribable, or the phone goes quiet on
  // exactly the thing the desk was told about.
  const mainSrc = readFileSync('src/main/index.ts', 'utf8')
  const pushed = new Set([...mainSrc.matchAll(/^ *send\('([^']+)'/gm)].map((m) => m[1]))
  const subs = new Set(entries.filter((e) => e.mode === 'on').map((e) => e.channel))
  const unheard = [...pushed].filter((c) => !subs.has(c) && c !== 'phone:hello')
  ok(unheard.length === 0, 'every event main pushes is one the surface can hear', unheard.join(', '))
}

// ---- 12. what an address reaches, and what a browser is -------------------------
//
// `shared/net.ts` is one definition read from two sides: the server stamps each live
// stream with the origin it CAME from, and the panel labels each address it offers with
// the origin a browser WOULD come from. A second copy would let the panel promise
// "works anywhere" for an address the server then marks "this network", so the two
// answers are checked here against the same function.

{
  const netBundle = join(work, 'net.mjs')
  buildSync({
    entryPoints: ['src/shared/net.ts'],
    outfile: netBundle,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  const { originOf, deviceKind, reachWords, hostOf } = await import(netBundle)

  for (const [addr, want] of [
    ['127.0.0.1', 'this machine'],
    ['::1', 'this machine'],
    ['192.168.1.7', 'this network'],
    ['10.0.0.4', 'this network'],
    ['172.16.4.1', 'this network'],
    ['172.20.0.9', 'this network'],
    ['169.254.7.1', 'this network'],
    ['fe80::1', 'this network'],
    ['100.89.94.66', 'tailnet'],
    ['100.127.0.1', 'tailnet'],
    // 100.5.x is ordinary public space, NOT carrier-grade NAT: the /10 boundary is the
    // whole reason this is a range test and not a `startsWith('100.')`.
    ['100.5.0.1', 'internet'],
    ['172.32.0.1', 'internet'],
    ['8.8.8.8', 'internet'],
    ['2606:4700::1', 'internet']
  ]) {
    ok(originOf(addr) === want, `${addr} is ${want}`, originOf(addr))
  }

  ok(hostOf('http://100.89.94.66:7312') === '100.89.94.66', 'the host comes out of a url')
  ok(reachWords('http://100.89.94.66:7312') === 'works anywhere', 'a tailnet address says so')
  ok(
    reachWords('http://192.168.1.7:7312') === 'this network only',
    'and a LAN address does not promise more than it can do'
  )

  for (const [ua, want] of [
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)', 'iPhone'],
    ['Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X)', 'iPad'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari', 'Android phone'],
    ['Mozilla/5.0 (Linux; Android 14; Tab S9) Safari', 'Android tablet'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Mac'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Windows'],
    ['Mozilla/5.0 (X11; Linux x86_64)', 'Linux'],
    ['', 'Browser'],
    ['something nobody has shipped yet', 'Browser']
  ]) {
    ok(deviceKind(ua) === want, `"${ua.slice(0, 34)}" is a ${want}`, deviceKind(ua))
  }

  // Android names Linux too, and Windows names it in some embedded builds: the order of
  // the tests in deviceKind is load-bearing, not incidental.
  ok(
    deviceKind('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile') === 'Android phone',
    'an Android is not reported as Linux'
  )
}

rmSync(work, { recursive: true, force: true })
console.log(`phone: ${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
