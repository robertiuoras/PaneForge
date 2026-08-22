// End-to-end test of the device link, over a real loopback socket.
//
// This is the part of PaneForge that cannot be checked by looking at it: a wrong
// pairing code has to be refused, a right one has to end up with the other machine's
// panes mirrored and keystrokes arriving back, and none of it may be readable to
// anything sniffing the connection. All three are asserted here against the actual
// host and client, not a mock of them.
//
// The remote modules are bundled with esbuild first because they are TypeScript.
// wire/host/client deliberately import nothing from Electron - only types - which is
// what makes them testable in plain Node at all.

import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname } from 'node:path'
import { createServer } from 'node:net'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = mkdtempSync(join(tmpdir(), 'pf-remote-'))
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

/** A free port, taken and released, so two runs at once cannot collide. */
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
  writeFileSync(
    entry,
    [
      `export { RemoteHost } from ${JSON.stringify(join(root, 'src/main/remote/host.ts').replace(/\\/g, '/'))}`,
      `export { RemoteClient } from ${JSON.stringify(join(root, 'src/main/remote/client.ts').replace(/\\/g, '/'))}`,
      `export { newCode } from ${JSON.stringify(join(root, 'src/main/remote/wire.ts').replace(/\\/g, '/'))}`,
      `export { makeInvite, readInvite, INVITE_MINUTES } from ${JSON.stringify(join(root, 'src/main/remote/invite.ts').replace(/\\/g, '/'))}`,
      `export { isSelfPeer, dropSelf, liveWatch } from ${JSON.stringify(join(root, 'src/main/remote/peers.ts').replace(/\\/g, '/'))}`
    ].join('\n'),
    'utf8'
  )
  const file = join(out, 'remote.mjs')
  // esbuild's own API, not its CLI: `node node_modules/esbuild/bin/esbuild` only works on
  // Windows, where that path is a JS shim. On macOS and Linux it is the native binary.
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

/** A stand-in for the session manager: two panes, one of which can be made to talk. */
function backend() {
  const listeners = { data: [], sessions: [], attention: [] }
  const sessions = [
    { id: 's1', title: 'assistant', cwd: '/w/assistant', agent: 'claude', status: 'idle', lastOutput: 0, createdAt: 0, cols: 100, rows: 28 },
    { id: 's2', title: 'jarvis', cwd: '/w/jarvis', agent: 'codex', status: 'working', lastOutput: 0, createdAt: 0, cols: 80, rows: 24 }
  ]
  const buffers = { s1: 'SECRET-SCROLLBACK-s1', s2: '' }
  const typed = []
  const started = []
  return {
    typed,
    started,
    sessions,
    emitData(id, data) {
      buffers[id] = (buffers[id] ?? '') + data
      for (const cb of listeners.data) cb(id, data)
    },
    emitSessions() {
      for (const cb of listeners.sessions) cb(sessions)
    },
    emitAttention(s) {
      for (const cb of listeners.attention) cb(s)
    },
    api: {
      list: () => sessions,
      buffer: (id) => buffers[id] ?? '',
      write: (id, data) => typed.push([id, data]),
      resize: () => {},
      redraw: () => {},
      setBusy: () => {},
      clearAttention: () => {},
      kill: () => {},
      restart: () => null,
      rename: () => {},
      switchAgent: () => null,
      startSession: (req) => {
        started.push(req)
        return { ...sessions[0], agent: req.agent ?? sessions[0].agent, model: req.model }
      },
      projects: async () => [{ name: 'assistant', path: '/w/assistant', lastUsed: 0, isGit: true }],
      agents: async () => [{ id: 'claude', label: 'Claude Code', available: true }],
      // What that machine is running outside its panes. The host reads its OWN process
      // table for this; here it is a fixture, because what this test owns is the frame
      // crossing the socket - `npm run test:backjobs` owns the reading.
      jobs: async () => [
        { pid: 4242, kind: 'agent', label: 'claude', cmd: 'claude -p sweep', port: null, where: 'vrb', elapsed: 900, headless: true }
      ],
      onData: (cb) => (listeners.data.push(cb), () => {}),
      onSessions: (cb) => (listeners.sessions.push(cb), () => {}),
      onAttention: (cb) => (listeners.attention.push(cb), () => {})
    }
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll until a condition holds, so the test never depends on a fixed sleep. */
async function until(fn, ms = 8000) {
  const stop = Date.now() + ms
  while (Date.now() < stop) {
    if (fn()) return true
    await wait(25)
  }
  return false
}

async function main() {
  const mod = await import(pathToFileURL(bundle()).href)
  const { RemoteHost, RemoteClient, newCode, makeInvite, readInvite, INVITE_MINUTES, isSelfPeer, dropSelf, liveWatch } =
    mod

  // ------------------------------------------------------------------ pairing with self
  // The bug this test exists for: a device paired with its own id mirrors every one of its
  // own panes back into its own window, so every session is listed twice and half the
  // copies refuse the actions that only work on a local pane. Measured in a real config.
  {
    ok('a device recognises its own id', isSelfPeer('e38080cc', 'e38080cc'))
    ok('another device is not it', !isSelfPeer('e8a289e1', 'e38080cc'))
    ok('an empty id is nobody', !isSelfPeer('', ''))
    const peers = [{ id: 'e38080cc' }, { id: 'e8a289e1' }]
    ok(
      'a saved self-pairing is dropped, and only it',
      dropSelf(peers, 'e38080cc').length === 1 && dropSelf(peers, 'e38080cc')[0].id === 'e8a289e1'
    )
    ok(
      'a pick only names panes that device still has',
      liveWatch({ watch: ['s1', 'gone'] }, [{ id: 's1' }, { id: 's2' }]).join() === 's1'
    )
  }

  // ------------------------------------------------------------------- invites
  // The one line that replaced three typed fields. Everything here is about the round
  // trip surviving the way a person actually moves it: selected with a stray quote, sent
  // through something that wraps lines, pasted with the prefix clipped off the front.
  {
    const now = 1_700_000_000_000
    const self = { name: 'Desk PC', addresses: ['192.168.1.20', '10.0.0.3'], port: 7311, code: 'AB12-CD34' }
    const blob = makeInvite(self, now)
    ok('an invite is one line', /^PF1-[A-Za-z0-9_-]+$/.test(blob), blob.slice(0, 24))
    const back = readInvite(blob, now)
    ok(
      'it round-trips the address, port, code and name',
      back.kind === 'invite' &&
        back.invite.code === self.code &&
        back.invite.port === self.port &&
        back.invite.name === self.name &&
        back.invite.addresses.join() === self.addresses.join(),
      JSON.stringify(back)
    )
    ok(
      'a paste that picked up quotes and newlines still reads',
      readInvite(`"${blob.slice(0, 12)}\n${blob.slice(12)}"  `, now).kind === 'invite'
    )
    ok('a selection that clipped the prefix still reads', readInvite(blob.slice(4), now).kind === 'invite')
    ok(
      'an invite older than the window is refused, by name',
      (() => {
        const r = readInvite(blob, now + INVITE_MINUTES * 60_000 + 1)
        return r.kind === 'expired' && r.name === 'Desk PC'
      })(),
      JSON.stringify(readInvite(blob, now + INVITE_MINUTES * 60_000 + 1))
    )
    // A real code's shape, from wire.ts's alphabet - lower case and unspaced, the way one
    // arrives after a trip through a chat window.
    ok('a bare pairing code is still recognised as one', readInvite(' acde-fghj ', now).kind === 'code')
    ok('one typed without its dash is the same code', readInvite('ACDEFGHJ', now).code === 'ACDE-FGHJ')
    ok('anything else is refused rather than half-read', readInvite('hello there', now).kind === 'none')
    ok('a look-alike character is not quietly accepted', readInvite('ACDE-FGH0', now).kind === 'none')
    ok(
      'the code inside is the only secret, and it is the same one',
      JSON.parse(Buffer.from(blob.slice(4).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).c ===
        self.code
    )
  }

  const code = newCode()
  const port = await freePort()
  const be = backend()
  const identity = { id: 'HOSTID', name: 'Desk PC', platform: 'win32', version: '0.0.0-test' }
  const host = new RemoteHost(be.api, () => identity, () => code)
  host.start(port)
  ok('listener comes up', await until(() => host.listening))

  // ---------------------------------------------------------------- wrong code
  const badPeer = { id: 'x', name: 'wrong', address: '127.0.0.1', port, code: newCode(), auto: false }
  const bad = new RemoteClient(badPeer, () => ({ id: 'GUEST', name: 'Laptop', platform: 'darwin', version: '0' }))
  bad.connect()
  ok(
    'a wrong pairing code is refused',
    await until(() => bad.status === 'error' && /pairing code/i.test(bad.error)),
    `status=${bad.status} error=${bad.error}`
  )
  ok('a refused client mirrors nothing', bad.list().length === 0)
  bad.disconnect()
  ok('the host keeps no guest from a failed handshake', await until(() => host.list().length === 0))

  // ---------------------------------------------------------------- right code
  const peer = { id: 'HOSTID', name: 'Desk PC', address: '127.0.0.1', port, code, auto: true }
  const client = new RemoteClient(peer, () => ({ id: 'GUEST', name: 'Laptop', platform: 'darwin', version: '0' }))
  let resets = 0
  const seen = []
  client.on('reset', () => resets++)
  client.on('data', (id, data) => seen.push([id, data]))
  client.connect()

  ok('the right code connects', await until(() => client.status === 'online'), client.error)
  ok('the host lists the guest', await until(() => host.list().length === 1))
  ok('the guest is named', host.list()[0]?.name === 'Laptop', JSON.stringify(host.list()[0]))

  // Connecting is permission to watch, not a decision to watch everything.
  ok('both panes are offered', await until(() => client.panes().length === 2))
  ok('nothing is mirrored until it is picked', client.list().length === 0, JSON.stringify(client.list()))
  ok('and nothing is attached either', await until(() => (host.list()[0]?.watching ?? 0) === 0))
  ok('so no scrollback was fetched for an unwatched pane', client.buffer('s1') === '')

  client.setWatch(['s1'])
  ok('a picked pane is mirrored', await until(() => client.list().length === 1), JSON.stringify(client.list()))
  const mirrored = client.list()
  ok('ids are namespaced by device', mirrored[0].id === '@HOSTID/s1', mirrored[0].id)
  ok('each pane says which device it is on', mirrored[0].remote?.name === 'Desk PC')
  ok('the host grid comes with it', mirrored[0].cols === 100 && mirrored[0].rows === 28)

  ok('scrollback arrives on attach', await until(() => client.buffer('s1') === 'SECRET-SCROLLBACK-s1'))
  ok('attaching is reported to the host', await until(() => host.list()[0]?.watching === 1))

  // Dropping a pick detaches over the wire rather than merely hiding it here: an
  // unwatched pane has to cost nothing, or "pick what you watch" buys nothing.
  client.setWatch([])
  ok('dropping a pick empties the mirror', await until(() => client.list().length === 0))
  ok('and detaches it at the far end', await until(() => host.list()[0]?.watching === 0))
  client.setWatch(['s1', 's2'])
  ok('picking again brings both back', await until(() => client.list().length === 2))
  // The pick is not live until the far end has registered it, and the next assertion is
  // about output arriving - wait for the attach rather than for a guess at how long it takes.
  ok('both are attached again over there', await until(() => host.list()[0]?.watching === 2))

  // Live output.
  be.emitData('s2', 'hello from the other machine')
  ok('live output streams through', await until(() => seen.some(([id, d]) => id === '@HOSTID/s2' && d.includes('hello from the other machine'))))
  ok('the mirror keeps its own copy', client.buffer('s2').includes('hello from the other machine'))

  // Keystrokes back.
  client.send({ t: 'write', id: 's1', data: 'npm test\r' })
  ok('keystrokes reach the far pty', await until(() => be.typed.some(([id, d]) => id === 's1' && d === 'npm test\r')))

  // A finished turn over there raises a hand here.
  let raised = null
  client.on('attention', (s) => (raised = s))
  be.emitAttention(be.sessions[0])
  ok('attention crosses the link', await until(() => raised?.id === '@HOSTID/s1'))
  ok('attention keeps the device name', raised?.remote?.name === 'Desk PC')

  // Request/response.
  const projects = await client.projects()
  ok('the far project list can be asked for', projects.length === 1 && projects[0].name === 'assistant')

  // What that machine is running with no pane on it. This is the whole reason the class
  // exists: a scheduled `claude -p` on the desk that does the unattended work was
  // invisible from here, because it is not a pane and nothing else crossed the link.
  const jobs = await client.jobs()
  ok('a paired machine says what it is running outside its panes', jobs.length === 1, JSON.stringify(jobs))
  ok(
    'and the job arrives whole, not reduced on the way',
    jobs[0]?.kind === 'agent' && jobs[0]?.headless === true && jobs[0]?.where === 'vrb' && jobs[0]?.elapsed === 900,
    JSON.stringify(jobs[0])
  )
  const started = await client.startSession({
    cwd: '/w/assistant',
    agent: 'codex',
    model: 'gpt-5.6-sol',
    prompt: 'audit the remote pane launcher'
  })
  ok('a remote launch preserves the selected agent and model', started.agent === 'codex' && started.model === 'gpt-5.6-sol')
  ok(
    'a remote launch sends its first task to the device that owns the pane',
    be.started[0]?.prompt === 'audit the remote pane launcher',
    JSON.stringify(be.started)
  )

  // A pane closing over there disappears here.
  be.sessions.pop()
  be.emitSessions()
  ok('a closed pane leaves the mirror', await until(() => client.list().length === 1))

  // ---------------------------------------------------------------- encryption
  // Everything above went over a real socket. If any of it were readable, a terminal
  // transcript - which is where pasted keys and printed file contents live - would be
  // in the clear on the LAN. Read the raw bytes of a fresh connection and check.
  const raw = []
  const sniffPort = await freePort()
  const sniffHost = new RemoteHost(be.api, () => identity, () => code)
  sniffHost.start(sniffPort)
  await until(() => sniffHost.listening)
  const { connect } = await import('node:net')
  const original = connect
  const sniffed = new RemoteClient(
    { id: 'HOSTID', name: 'x', address: '127.0.0.1', port: sniffPort, code, auto: false },
    () => ({ id: 'GUEST2', name: 'Laptop', platform: 'darwin', version: '0' })
  )
  // Tap the socket the client opens by watching the host's side instead: same bytes.
  sniffHost.on('changed', () => {})
  const guests = []
  sniffed.on('sessions', () => guests.push(1))
  sniffed.connect()
  await until(() => sniffed.status === 'online')
  // The host's own socket is the wire. Read what it writes for the next chunk.
  const conns = [...sniffHost.list()]
  ok('second link comes up', conns.length === 1)
  void original
  // Trigger traffic containing a known string and capture it off the host socket.
  const sock = sniffHostSocket(sniffHost)
  if (sock) {
    const chunks = []
    const write = sock.write.bind(sock)
    sock.write = (buf, ...rest) => {
      chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)))
      return write(buf, ...rest)
    }
    be.emitData('s1', 'API_KEY=sk-do-not-leak-this')
    await until(() => chunks.length > 0)
    const onWire = Buffer.concat(chunks).toString('latin1')
    raw.push(onWire)
    ok('nothing on the wire is readable', !onWire.includes('sk-do-not-leak-this'), onWire.slice(0, 80))
  } else {
    ok('nothing on the wire is readable', false, 'could not reach the socket')
  }

  sniffed.disconnect()
  sniffHost.stop()

  // ---------------------------------------------------------------- disconnect
  client.disconnect()
  ok('disconnecting empties the mirror', client.list().length === 0)
  ok('the host drops the guest', await until(() => host.list().length === 0))
  host.stop()

  // Reconnect replaces scrollback rather than appending it - the pane resets.
  ok('a reconnect resets the pane rather than doubling it', resets >= 1, `resets=${resets}`)
}

/** Reach the first guest's raw socket. Test-only: the class does not expose it. */
function sniffHostSocket(host) {
  const guests = host.guests ?? host['guests']
  if (!guests) return null
  for (const g of guests) return g.conn?.socket ?? null
  return null
}

main()
  .catch((err) => {
    failures++
    console.error(err)
  })
  .finally(() => {
    rmSync(out, { recursive: true, force: true })
    console.log(`\n${checks - failures}/${checks} checks passed`)
    process.exit(failures ? 1 : 0)
  })
