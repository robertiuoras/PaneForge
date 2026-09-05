// A device whose path disappears must be REPORTED gone, not left looking online.
//
// This is the failure Robert hit: the Mac showed the PC's panes simply stop moving
// mid-turn and read it as the PC having died, while the PC was running the whole time
// and its process uptime spanned the window. Nothing had crashed. The link had lost its
// path, and nothing on this side was watching for that.
//
// The distinction that matters, and the reason a mock would not have caught it: a
// connection that is CLOSED tells you so (FIN, then `gone`, then reconnect). A
// connection whose path vanishes - Wi-Fi swap, VPN drop, the other machine asleep, a
// NAT dropping an idle entry - tells you nothing at all. No FIN, no RST, and writes
// keep succeeding into the OS buffer for minutes. So the test below does not close
// anything: it puts a proxy in the middle and stops forwarding, which is what a lost
// path actually looks like on the wire.
//
// Run against the pre-fix client and the first case fails: status stays 'online'
// forever with a frozen mirror behind it.
//
//   node scripts/deadlink-test.mjs

import { buildSync } from 'esbuild'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Three beats to declare death, so the whole run is a few seconds rather than a minute.
process.env.PF_PING_MS = '150'
const PING_MS = 150
const DEAD_MS = PING_MS * 3

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = mkdtempSync(join(tmpdir(), 'pf-deadlink-'))
let failures = 0
let checks = 0

function ok(what, cond, detail = '') {
  checks++
  if (cond) {
    console.log(`  ok   ${what}`)
    return
  }
  failures++
  console.log(`  FAIL ${what}${detail ? ' - ' + detail : ''}`)
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(cond, ms = 5_000) {
  const stop = Date.now() + ms
  while (Date.now() < stop) {
    if (cond()) return true
    await wait(20)
  }
  return false
}

function freePort() {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

function bundle() {
  const entry = join(out, 'entry.ts')
  const from = (p) => JSON.stringify(join(root, p).replace(/\\/g, '/'))
  writeFileSync(
    entry,
    [
      `export { RemoteHost } from ${from('src/main/remote/host.ts')}`,
      `export { RemoteClient } from ${from('src/main/remote/client.ts')}`,
      `export { newCode } from ${from('src/main/remote/wire.ts')}`
    ].join('\n'),
    'utf8'
  )
  const file = join(out, 'remote.mjs')
  buildSync({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'warning',
    outfile: file
  })
  return file
}

/** The minimum session manager the host needs to answer a handshake. */
function backend() {
  const listeners = { data: [], sessions: [], attention: [] }
  const sessions = [
    {
      id: 's1',
      title: 'assistant',
      cwd: '/w/assistant',
      agent: 'claude',
      status: 'working',
      lastOutput: 0,
      createdAt: 0,
      cols: 100,
      rows: 28
    }
  ]
  return {
    list: () => sessions,
    buffer: () => 'SCROLLBACK',
    log: (_id, bytes) => {
      backend.lastLogBytes = bytes
      return 'DISK-HISTORY-OLDER-THAN-LIVE-BUFFER'
    },
    write: () => {},
    resize: () => {},
    returnSize: () => {},
    redraw: () => {},
    setBusy: () => {},
    clearAttention: () => {},
    kill: () => {},
    restart: () => null,
    rename: () => {},
    switchAgent: () => null,
    startSession: () => sessions[0],
    projects: async () => [],
    agents: async () => [],
    jobs: async () => [],
    onData: (cb) => (listeners.data.push(cb), () => {}),
    onTyped: () => () => {},
    onSessions: (cb) => (listeners.sessions.push(cb), () => {}),
    onAttention: (cb) => (listeners.attention.push(cb), () => {})
  }
}

/**
 * A TCP proxy that can stop carrying traffic without hanging up on either end.
 *
 * `blackhole()` is the whole point: both sockets stay open and writable, and every byte
 * written into them is dropped. That is a lost path, and it is precisely the case a
 * `close`/`error` handler never sees.
 */
async function proxy(toPort) {
  let dead = false
  const pairs = []
  const server = createServer((inbound) => {
    const outbound = connect({ host: '127.0.0.1', port: toPort })
    pairs.push([inbound, outbound])
    inbound.on('data', (b) => {
      if (!dead) outbound.write(b)
    })
    outbound.on('data', (b) => {
      if (!dead) inbound.write(b)
    })
    // A real lost path does not propagate closes either way; only tidy up on real ones.
    const bye = () => {
      if (dead) return
      inbound.destroy()
      outbound.destroy()
    }
    inbound.on('error', bye)
    outbound.on('error', bye)
    inbound.on('close', bye)
    outbound.on('close', bye)
  })
  const port = await freePort()
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  return {
    port,
    blackhole: () => {
      dead = true
    },
    stop: () => {
      dead = true
      for (const [a, b] of pairs) {
        a.destroy()
        b.destroy()
      }
      server.close()
    }
  }
}

const me = () => ({ id: 'GUEST', name: 'Laptop', platform: 'darwin', version: '0' })

async function main() {
  const mod = await import(pathToFileURL(bundle()).href)
  const { RemoteHost, RemoteClient, newCode } = mod

  const code = newCode()
  const hostPort = await freePort()
  const host = new RemoteHost(
    backend(),
    () => ({ id: 'HOSTID', name: 'PC', platform: 'win32', version: '0' }),
    () => code
  )
  host.start(hostPort)
  ok('listener comes up', await until(() => host.listening))

  const link = await proxy(hostPort)
  const peer = {
    id: 'HOSTID',
    name: 'PC',
    address: '127.0.0.1',
    port: link.port,
    code,
    watch: ['s1']
  }

  console.log('\n-- a link that loses its path --')
  const client = new RemoteClient(peer, me)
  client.connect()
  ok('the device comes online', await until(() => client.status === 'online'), client.error)
  ok('and its pane is mirrored', await until(() => client.list().length === 1))
  const history = await client.log('s1', 8 * 1024 * 1024)
  ok('an explicit history read reaches the owner disk log, not the live buffer', history === 'DISK-HISTORY-OLDER-THAN-LIVE-BUFFER')
  ok('the remote history request is capped below the wire frame limit', backend.lastLogBytes === 4 * 1024 * 1024, String(backend.lastLogBytes))
  const ask = client.ask
  client.ask = () => Promise.reject(new Error('PC did not answer'))
  const oldHostError = await client.log('s1').then(() => '', (err) => err.message)
  client.ask = ask
  ok('an older host fails with an explicit history message', /cannot provide remote history/i.test(oldHostError), oldHostError)

  // Nothing is closed here. Both sockets stay open; the bytes just stop arriving.
  const cut = Date.now()
  link.blackhole()

  // Before the fix this assertion is the one that fails, and it fails by timing out with
  // status still 'online' - the exact on-screen symptom, a pane that never moves again.
  const noticed = await until(() => client.status !== 'online', DEAD_MS * 6)
  ok('a silent link stops counting as online', noticed, `status stayed ${client.status}`)
  ok(
    'and says so rather than showing a frozen mirror',
    client.status === 'error' && /stopped answering/i.test(client.error),
    `${client.status}: ${client.error}`
  )
  ok('the mirrored pane is dropped, not left stale', client.list().length === 0)

  // A deadline that fires too eagerly is its own bug: one slow moment on a busy machine
  // must not tear down a working link, so nothing may be declared dead before DEAD_MS.
  //
  // Measured against a few milliseconds of slack, not against the number exactly: the
  // link's own clock starts at the last frame it SAW, and `cut` is read a moment later in
  // this script, so the two disagree by however long that took. Observed on this Mac at
  // 437ms and 447ms against a 450ms deadline in two runs out of six - a failure that says
  // nothing about the behaviour being checked and everything about which line ran first.
  // The bug this exists to catch is a deadline firing at a FRACTION of its interval.
  const SLACK_MS = 30
  const took = Date.now() - cut
  ok(
    `the call took ${took}ms, no sooner than the ${DEAD_MS}ms deadline`,
    took >= DEAD_MS - SLACK_MS
  )

  console.log('\n-- a link that is merely quiet is left alone --')
  link.stop()
  const quietPort = await freePort()
  const quietHost = new RemoteHost(
    backend(),
    () => ({ id: 'HOST2', name: 'PC', platform: 'win32', version: '0' }),
    () => code
  )
  quietHost.start(quietPort)
  await until(() => quietHost.listening)
  const quiet = new RemoteClient(
    { id: 'HOST2', name: 'PC', address: '127.0.0.1', port: quietPort, code, watch: ['s1'] },
    me
  )
  quiet.connect()
  ok('a quiet device connects', await until(() => quiet.status === 'online'), quiet.error)
  // No output, no keystrokes, nothing but the beat - for well past the deadline.
  await wait(DEAD_MS * 4)
  ok(
    'an idle but reachable device stays online',
    quiet.status === 'online',
    `${quiet.status}: ${quiet.error}`
  )
  ok('and keeps its mirror', quiet.list().length === 1)

  quiet.disconnect?.()
  quietHost.stop?.()
  host.stop?.()

  console.log(`\n${checks - failures}/${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
