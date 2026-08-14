/**
 * The provider whose address never changes, and the reason it leads.
 *
 * What is worth pinning here is not that a command was spawned - it is the DECISIONS:
 * which machine can be funnelled at all, which refusals mean "use the other provider"
 * rather than "tell the user something broke", and that a start reports the hostname
 * tailscaled really published rather than the one we hoped for. Everything runs against a
 * stub, so this needs no tailnet and no network.
 *
 * Run: npm run test:funnel
 */

import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'pf-funnel-'))

function load(entry, name) {
  const file = join(out, name)
  buildSync({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: file,
    external: ['electron']
  })
  return import(pathToFileURL(file).href)
}

const shared = await load('src/shared/funnel.ts', 'shared.mjs')
const main = await load('src/main/funnel.ts', 'main.mjs')

let failed = 0
const ok = (name, fn) => {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n      ${err.message}`)
  }
}
const okAsync = async (name, fn) => {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n      ${err.message}`)
  }
}

const status = (over = {}) =>
  JSON.stringify({
    BackendState: 'Running',
    Self: { DNSName: 'roberts-macbook-pro.tail6c8b58.ts.net.', Online: true },
    CertDomains: ['roberts-macbook-pro.tail6c8b58.ts.net'],
    ...over
  })

console.log('funnelHost')
ok('a running node with a cert is funnellable', () => {
  assert.equal(shared.funnelHost(status()), 'roberts-macbook-pro.tail6c8b58.ts.net')
})
ok('the trailing dot of a DNS name is not part of the address', () => {
  assert.ok(!shared.funnelHost(status()).endsWith('.'))
})
ok('a stopped tailscaled is not funnellable', () => {
  assert.equal(shared.funnelHost(status({ BackendState: 'Stopped' })), '')
})
ok('no HTTPS certificates means no funnel - it would answer with a TLS error', () => {
  assert.equal(shared.funnelHost(status({ CertDomains: [] })), '')
})
ok('a cert list that does not cover THIS node is not this node being funnellable', () => {
  assert.equal(shared.funnelHost(status({ CertDomains: ['other.tail6c8b58.ts.net'] })), '')
})
ok('rubbish in is no host out, never a throw', () => {
  assert.equal(shared.funnelHost('not json'), '')
  assert.equal(shared.funnelHost(JSON.stringify({ Self: { DNSName: 'box.local' } })), '')
})

console.log('funnelDenied')
ok('a tailnet without the funnel attribute is a fallback, not an error', () => {
  assert.equal(
    shared.funnelDenied(
      'Funnel is not enabled on your tailnet. To enable, add the funnel node attribute'
    ),
    true
  )
})
ok('a real failure is not silently swallowed as "unavailable"', () => {
  assert.equal(shared.funnelDenied('failed to connect to local tailscaled'), false)
})

console.log('servingHost')
ok('the hostname is read out of what funnel status prints', () => {
  const text = `# Funnel on:\n#     - https://roberts-macbook-pro.tail6c8b58.ts.net\n\nhttps://roberts-macbook-pro.tail6c8b58.ts.net (Funnel on)\n|-- / proxy http://127.0.0.1:7312`
  assert.equal(shared.servingHost(text), 'roberts-macbook-pro.tail6c8b58.ts.net')
})
ok('nothing serving is an empty answer', () => {
  assert.equal(shared.servingHost('No serve config'), '')
})

console.log('funnelArgs')
ok('--bg, because this app has no terminal to hold the foreground form open', () => {
  assert.deepEqual(shared.funnelArgs(7312), ['funnel', '--bg', '--https=443', '7312'])
})
ok('off names the same port the on did, or it takes nothing down', () => {
  assert.deepEqual(shared.funnelOffArgs(), ['funnel', '--https=443', 'off'])
})

console.log('Funnel')
const stub = (script) => {
  const calls = []
  const run = async (_bin, args) => {
    calls.push(args.join(' '))
    for (const [match, answer] of script) if (args.join(' ').includes(match)) return answer
    return { out: '', err: '', code: 0 }
  }
  return { calls, deps: { binary: '/stub/tailscale', run } }
}

await okAsync('a machine that can be funnelled comes back with its permanent address', async () => {
  const s = stub([
    ['status --json', { out: status(), err: '', code: 0 }],
    [
      'funnel status',
      { out: 'https://roberts-macbook-pro.tail6c8b58.ts.net (Funnel on)', err: '', code: 0 }
    ]
  ])
  const f = new main.Funnel(s.deps)
  const r = await f.start(7312)
  assert.equal(r.url, 'https://roberts-macbook-pro.tail6c8b58.ts.net')
  assert.equal(r.denied, false)
})

await okAsync('no Tailscale on this machine is a fallback, and costs no spawn', async () => {
  const s = stub([])
  const f = new main.Funnel({ binary: '', run: s.deps.run })
  const r = await f.start(7312)
  assert.equal(r.url, '')
  assert.equal(r.denied, true)
  assert.equal(s.calls.length, 0, 'nothing should have been run')
})

await okAsync('a tailnet that refuses says so as "unavailable", not as an error', async () => {
  const s = stub([
    ['status --json', { out: status(), err: '', code: 0 }],
    [
      'funnel --bg',
      { out: '', err: 'Funnel is not enabled on your tailnet; add the funnel node attribute', code: 1 }
    ]
  ])
  const f = new main.Funnel(s.deps)
  const r = await f.start(7312)
  assert.equal(r.url, '')
  assert.equal(r.denied, true, 'a policy refusal must fall through to cloudflared')
})

await okAsync('a genuine failure is reported rather than hidden', async () => {
  const s = stub([
    ['status --json', { out: status(), err: '', code: 0 }],
    ['funnel --bg', { out: '', err: 'failed to connect to local tailscaled', code: 1 }]
  ])
  const r = await new main.Funnel(s.deps).start(7312)
  assert.equal(r.denied, false)
  assert.match(r.error, /tailscaled/)
})

await okAsync('what tailscaled really published beats what we asked for', async () => {
  // The node's own name and the served name can differ (a tailnet rename mid-flight is the
  // ordinary case). Believing the request rather than the status would put an address in
  // the panel that nothing on earth reaches.
  const s = stub([
    ['status --json', { out: status(), err: '', code: 0 }],
    ['funnel status', { out: 'https://renamed.tail6c8b58.ts.net (Funnel on)', err: '', code: 0 }]
  ])
  const r = await new main.Funnel(s.deps).start(7312)
  assert.equal(r.url, 'https://renamed.tail6c8b58.ts.net')
})

await okAsync('stopping says so to tailscaled - nothing else ever will', async () => {
  // `funnel --bg` is a setting tailscaled keeps, not a child process, so no exit and no
  // crash takes it down. If this call is ever dropped, a public address survives the app.
  const s = stub([])
  await new main.Funnel(s.deps).stop()
  assert.ok(
    s.calls.some((c) => c === 'funnel --https=443 off'),
    `expected an off call, got ${JSON.stringify(s.calls)}`
  )
})

writeFileSync(join(out, 'done'), '')
console.log(failed ? `\n${failed} failed` : '\nall good')
process.exit(failed ? 1 : 0)
