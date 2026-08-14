// A way in from anywhere, and the two ways it lies.
//
// No network, no cloudflared, no Cloudflare account: `src/main/tunnel.ts` takes its binary
// and its reachability probe as deps on purpose, so a stub program that prints what the
// real one prints is enough to drive every path. The shapes below are copied from a real
// run measured 2026-08-08 (see the header of tunnel.ts) - the box-drawn URL line, the
// `Registered tunnel connection` line, and the fact that ALL of it comes out of stderr
// while stdout stays empty.
//
// The two load-bearing cases:
//
//   * the URL appearing is NOT the tunnel being up. The real thing prints a hostname about
//     four seconds before it resolves anywhere, so a stub that prints one and then never
//     serves must leave the phase `off` with a reason, never `up`.
//   * a program that prints a hostname and then HANGS must not hold `starting` for ever.
//     That is the shape that makes somebody reinstall the app.

// Before the bundle is imported: the module reads these at load time.
process.env.PF_TUNNEL_URL_MS = '2000'
process.env.PF_TUNNEL_PROBE_MS = '1500'
process.env.PF_TUNNEL_START_MS = '8000'
process.env.PF_TUNNEL_RESOLVE_MS = '600'

import { buildSync } from 'esbuild'
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Same trap as phone-test: a bare absolute path in `import()` is read as a URL with the
// scheme "c:" on Windows, so this whole suite crashed before its first check.
import { pathToFileURL } from 'node:url'

let failures = 0
let checks = 0
function ok(cond, what, detail = '') {
  checks++
  if (cond) return
  failures++
  console.error(`  FAIL ${what}${detail ? ` - ${detail}` : ''}`)
}

const work = mkdtempSync(join(tmpdir(), 'pf-tunnel-'))
const bundle = join(work, 'tunnel.mjs')
buildSync({
  entryPoints: ['src/main/tunnel.ts'],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const { Tunnel, assetFor, downloadUrl, untarOne, sweepOrphans } = await import(pathToFileURL(bundle).href)

/** A stub cloudflared. `mode` decides which of the real program's endings it acts out. */
function stub(mode) {
  const file = join(work, `cf-${mode}.mjs`)
  writeFileSync(
    file,
    `#!/usr/bin/env node
const say = (s) => process.stderr.write(s + '\\n')
const host = 'four-word-host-${mode}.trycloudflare.com'
say('2026-08-08T03:53:36Z INF Requesting new quick Tunnel on trycloudflare.com...')
setTimeout(() => {
  if ('${mode}' === 'silent') return
  say('2026-08-08T03:53:40Z INF +------------------------------------------+')
  say('2026-08-08T03:53:40Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |')
  say('2026-08-08T03:53:40Z INF |  https://' + host + '  |')
  say('2026-08-08T03:53:40Z INF +------------------------------------------+')
  if ('${mode}' === 'nourl') return
  setTimeout(() => {
    say('2026-08-08T03:53:40Z INF Registered tunnel connection connIndex=0 protocol=quic')
    if ('${mode}' === 'die') process.exit(3)
  }, 30)
}, 30)
setInterval(() => {}, 1000)
`,
    { mode: 0o755 }
  )
  chmodSync(file, 0o755)
  return file
}

// The stubs are shebang scripts and `Tunnel` spawns its binary directly, which Windows
// cannot do: the spawn fails EFTYPE before the first check. A .cmd wrapper is not the way
// out either - node refuses to spawn one without a shell. So this suite says so and stops,
// rather than reporting a failure that is about the harness and not about the tunnel.
// It runs for real on the Mac, which is the platform the tunnel ships on first.
if (process.platform === 'win32') {
  console.log('tunnel: skipped on Windows - the stub cloudflared is a POSIX shebang script (spawn EFTYPE)')
  process.exit(0)
}

const nodeShim = (file) => {
  // The class spawns the binary directly, so the stub has to BE executable. On a machine
  // whose /usr/bin/env is fine this shebang is enough; the mode bit above is the rest.
  return file
}

// ---- 1. the happy path: a URL, a registration, and a probe that says it serves --------

{
  const seen = []
  const t = new Tunnel({
    dir: join(work, 'bin'),
    // The stable provider is tried first in the app; these cases are about the OTHER one,
    // so it is switched off by name. Without this every check here would pass or fail on
    // whether the machine running the suite happens to be on a funnel-capable tailnet.
    funnel: { binary: '' },
    binary: nodeShim(stub('ok')),
    probe: async () => true,
    onChange: (s) => seen.push(s.phase)
  })
  ok(t.state().phase === 'off', 'it starts off')
  const s = await t.start(7411)
  ok(s.phase === 'up', 'a tunnel that registers and answers is up', JSON.stringify(s))
  ok(
    s.url === 'https://four-word-host-ok.trycloudflare.com',
    'and the address is the one it printed',
    s.url
  )
  ok(seen.includes('starting'), 'the panel was told it was starting', seen.join('>'))
  ok(t.running, 'and it reports itself running')
  await t.stop()
  ok(t.state().phase === 'off' && t.state().url === '', 'stop() puts the address away')
}

// ---- 2. the URL is not the claim ------------------------------------------------------
//
// The measured trap: the real program prints a hostname ~4s before DNS has it. A stub that
// prints one and then never serves is exactly that moment, held still.

{
  let asked = 0
  const t = new Tunnel({
    dir: join(work, 'bin'),
    // The stable provider is tried first in the app; these cases are about the OTHER one,
    // so it is switched off by name. Without this every check here would pass or fail on
    // whether the machine running the suite happens to be on a funnel-capable tailnet.
    funnel: { binary: '' },
    binary: nodeShim(stub('ok')),
    probe: async () => {
      asked++
      return false
    },
    onChange: () => {}
  })
  const started = Date.now()
  const s = await Promise.race([
    t.start(7411),
    new Promise((r) => setTimeout(() => r({ phase: 'timeout', url: '' }), 12_000))
  ])
  await t.stop()
  ok(asked > 0, 'the address was actually probed, not assumed', String(asked))
  ok(
    s.phase !== 'up',
    'an address that never answers is never reported as up',
    `${s.phase} after ${Date.now() - started}ms`
  )
}

// ---- 2b. the resolver is not asked before public DNS has the record -------------------
//
// The cached-NXDOMAIN trap, as a sequence: the first lookup of a name that does not exist
// yet poisons the system resolver, so the probe may not run until the DoH gate says the
// record is there - and a gate that never answers must fall through after its budget, not
// hold the start hostage.

{
  const order = []
  let there = false
  setTimeout(() => {
    there = true
  }, 300)
  const t = new Tunnel({
    dir: join(work, 'bin'),
    // The stable provider is tried first in the app; these cases are about the OTHER one,
    // so it is switched off by name. Without this every check here would pass or fail on
    // whether the machine running the suite happens to be on a funnel-capable tailnet.
    funnel: { binary: '' },
    binary: nodeShim(stub('ok')),
    resolve: async () => {
      order.push(there ? 'resolved' : 'asked-early')
      return there
    },
    probe: async () => {
      order.push('probed')
      return true
    },
    onChange: () => {}
  })
  const s = await t.start(7412)
  await t.stop()
  ok(s.phase === 'up', 'the gated start still comes up', s.phase)
  const firstProbe = order.indexOf('probed')
  const resolved = order.indexOf('resolved')
  ok(
    resolved !== -1 && firstProbe > resolved,
    'the hostname is not probed until DNS carries it',
    order.join(',')
  )

  // And a DoH endpoint that never answers yes gives up at its budget and probes anyway.
  const stuck = new Tunnel({
    dir: join(work, 'bin'),
    // The stable provider is tried first in the app; these cases are about the OTHER one,
    // so it is switched off by name. Without this every check here would pass or fail on
    // whether the machine running the suite happens to be on a funnel-capable tailnet.
    funnel: { binary: '' },
    binary: nodeShim(stub('ok')),
    resolve: async () => false,
    probe: async () => true,
    onChange: () => {}
  })
  const began = Date.now()
  const s2 = await stuck.start(7413)
  await stuck.stop()
  ok(
    s2.phase === 'up',
    'a silent DoH endpoint delays the probe, never defeats it',
    `${s2.phase} after ${Date.now() - began}ms`
  )
}

// ---- 3. a program that prints nothing, and one that prints a URL then dies -------------

{
  const quiet = new Tunnel({
    dir: join(work, 'bin'),
    // The stable provider is tried first in the app; these cases are about the OTHER one,
    // so it is switched off by name. Without this every check here would pass or fail on
    // whether the machine running the suite happens to be on a funnel-capable tailnet.
    funnel: { binary: '' },
    binary: nodeShim(stub('silent')),
    probe: async () => true
  })
  const s = await quiet.start(7411)
  await quiet.stop()
  ok(s.phase === 'off', 'a cloudflared that says nothing ends off, not starting', s.phase)
  ok(!!s.error, 'and it says why', s.error)

  const died = new Tunnel({
    dir: join(work, 'bin'),
    // The stable provider is tried first in the app; these cases are about the OTHER one,
    // so it is switched off by name. Without this every check here would pass or fail on
    // whether the machine running the suite happens to be on a funnel-capable tailnet.
    funnel: { binary: '' },
    binary: nodeShim(stub('die')),
    probe: async () => true
  })
  const d = await died.start(7411)
  await died.stop()
  // It printed a URL and registered before exiting, so the probe decides - and the stub
  // probe says yes. What must not happen is a hang or a throw.
  ok(['up', 'off'].includes(d.phase), 'a cloudflared that exits settles either way', d.phase)
}

// ---- 4. a binary that does not exist is an error, not a hang ---------------------------

{
  const t = new Tunnel({
    dir: join(work, 'bin'),
    // The stable provider is tried first in the app; these cases are about the OTHER one,
    // so it is switched off by name. Without this every check here would pass or fail on
    // whether the machine running the suite happens to be on a funnel-capable tailnet.
    funnel: { binary: '' },
    binary: join(work, 'no-such-program'),
    probe: async () => true
  })
  const s = await t.start(7411)
  await t.stop()
  ok(s.phase === 'off', 'a missing program ends off', s.phase)
  ok(!!s.error, 'and names the failure rather than going quiet', s.error)
}

// ---- 5. which file this machine needs --------------------------------------------------
//
// A wrong asset name is a 404 that reads to a user as "no internet". These are the names
// the release really publishes, checked by hand against the listing on 2026-08-08.

{
  const want = [
    ['darwin', 'arm64', 'cloudflared-darwin-arm64.tgz', true],
    ['darwin', 'x64', 'cloudflared-darwin-amd64.tgz', true],
    ['win32', 'x64', 'cloudflared-windows-amd64.exe', false],
    ['win32', 'ia32', 'cloudflared-windows-386.exe', false],
    ['linux', 'x64', 'cloudflared-linux-amd64', false],
    ['linux', 'arm64', 'cloudflared-linux-arm64', false]
  ]
  for (const [platform, arch, name, tar] of want) {
    const a = assetFor(platform, arch)
    ok(a?.name === name, `${platform}/${arch} wants ${name}`, a?.name)
    ok(a?.tar === tar, `and ${tar ? 'is' : 'is not'} a tarball`)
  }
  ok(assetFor('aix', 'ppc') === null, 'an unsupported platform is null, not a bad guess')
  ok(
    downloadUrl('cloudflared-linux-amd64') ===
      'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
    'and the url is the release download path'
  )
}

// ---- 6. one file out of a tarball, with no dependency ----------------------------------

{
  const { gzipSync } = await import('node:zlib')
  // A real 512-byte tar header for one file, so this exercises the octal size field and
  // the padding rather than a shape invented to match the parser.
  const payload = Buffer.from('#!/bin/sh\necho i-am-cloudflared\n')
  const head = Buffer.alloc(512)
  head.write('cloudflared', 0)
  head.write(payload.length.toString(8).padStart(11, '0') + '\0', 124)
  head.write('0', 156)
  const body = Buffer.alloc(Math.ceil(payload.length / 512) * 512)
  payload.copy(body)
  const tar = Buffer.concat([head, body, Buffer.alloc(1024)])
  const out = untarOne(gzipSync(tar))
  ok(!!out, 'a file comes back out of the tarball')
  ok(out?.toString() === payload.toString(), 'byte for byte', JSON.stringify(out?.toString()))
  ok(untarOne(gzipSync(tar), 'not-in-here') === null, 'and a name that is not in it is null')
}

// ---- 7. the download writes through a temp name ----------------------------------------
//
// A half-written binary that a later launch decides is "already downloaded" is a switch
// that never works again, and no error is ever printed. Nothing partial may carry the
// real name.

{
  const dir = join(work, 'bin')
  mkdirSync(dir, { recursive: true })
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync('src/main/tunnel.ts', 'utf8')
  )
  ok(/\.part`/.test(src), 'the download writes to a .part name first')
  ok(/renameSync\(temp, to\)/.test(src), 'and renames it into place')
  ok(
    src.indexOf('writeFileSync(temp') < src.indexOf('renameSync(temp, to)'),
    'in that order'
  )
  ok(!existsSync(join(dir, 'cloudflared')), 'and nothing was downloaded by this test')
}

// A cloudflared this app lost is a public address still reaching this desk, so exactly one
// process may carry a given port. Proven against REAL processes with the real command line,
// because all the sweep can ever see is a string in a process table.

if (process.platform === 'win32') {
  console.log('  SKIP orphan sweep: the Windows half matches cloudflared.exe by name')
} else {
  const { spawn } = await import('node:child_process')
  const port = 7466
  // Not cloudflared, but wearing its arguments: that is the whole of what is matched.
  const ghost = (p) =>
    spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 60000)', 'cloudflared', 'tunnel', '--url', `http://127.0.0.1:${p}`],
      { stdio: 'ignore' }
    )
  const lost = ghost(port)
  const ours = ghost(port)
  const elsewhere = ghost(7467)
  const alive = (child) => {
    try {
      process.kill(child.pid, 0)
      return true
    } catch {
      return false
    }
  }
  await new Promise((r) => setTimeout(r, 400))
  await sweepOrphans(port, [ours.pid])
  await new Promise((r) => setTimeout(r, 400))
  ok(!alive(lost), 'a cloudflared left on this port is killed before a new one starts')
  ok(alive(ours), 'our own child is never swept')
  ok(alive(elsewhere), 'and a second profile on its own port is not in scope')
  for (const c of [lost, ours, elsewhere]) c.kill()
}

rmSync(work, { recursive: true, force: true })
console.log(`tunnel: ${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
