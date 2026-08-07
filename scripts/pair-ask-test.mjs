// Pairing without a code: what the six digits are actually for.
//
// Typing the pairing code proved you had been at the other screen. Pressing Approve proves
// nothing on its own - the card can be raised by anything on the network, under any name it
// likes - so the digits are what replaced the proof, and every check here is about them.
//
// The load-bearing one is the machine in the middle. An attacker who relays the exchange
// agrees one secret with each end, so the number it can show the joiner is necessarily not
// the number the host computes; a person comparing two screens sees that, and a person
// reading only a device name does not. That test is the reason this file exists - the rest
// of the flow could be checked by using it.
//
// Real loopback sockets, the real `RemoteHost`, no Electron: `wire.ts` and `host.ts` import
// nothing from it.

import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = mkdtempSync(join(tmpdir(), 'pf-pairask-'))
let checks = 0
let failures = 0
const ok = (what, cond, detail = '') => {
  checks++
  if (cond) {
    console.log(`  ok   ${what}`)
    return
  }
  failures++
  console.log(`  FAIL ${what}${detail ? ' - ' + detail : ''}`)
}

const p = (f) => JSON.stringify(join(root, f).replace(/\\/g, '/'))
function bundle() {
  const entry = join(out, 'entry.ts')
  writeFileSync(
    entry,
    [
      `export { RemoteHost } from ${p('src/main/remote/host.ts')}`,
      `export { Conn, deriveKey, newCode, ephemeralKeys, sharedSecret, sasDigits, sealCode, openCode } from ${p('src/main/remote/wire.ts')}`
    ].join('\n'),
    'utf8'
  )
  const file = join(out, 'pair.mjs')
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

function freePort() {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 8000) {
  const stop = Date.now() + ms
  while (Date.now() < stop) {
    if (fn()) return true
    await wait(25)
  }
  return false
}

/** The session manager the host answers for. Nothing here is exercised; it must exist. */
function backend() {
  return {
    list: () => [],
    buffer: () => '',
    write: () => {},
    resize: () => {},
    redraw: () => {},
    setBusy: () => {},
    clearAttention: () => {},
    kill: () => {},
    restart: () => null,
    rename: () => {},
    switchAgent: () => null,
    startSession: () => ({ id: 's1' }),
    projects: async () => [],
    agents: async () => [],
    onData: () => () => {},
    onSessions: () => () => {},
    onAttention: () => () => {}
  }
}

async function main() {
  const mod = await import(pathToFileURL(bundle()).href)
  const { RemoteHost, Conn, newCode, ephemeralKeys, sharedSecret, sasDigits, sealCode, openCode } =
    mod

  const identity = (name) => ({ id: name.toLowerCase(), name, platform: 'test', version: '0.0.0' })

  /** Bring up a real host whose Approve answer is whatever `decide` returns. */
  async function desk(code, decide) {
    const port = await freePort()
    const seen = []
    const host = new RemoteHost(backend(), () => identity('Desk'), () => code)
    host.onAsk = async (peer, sas, address) => {
      seen.push({ peer, sas, address })
      return await decide(peer, sas)
    }
    host.start(port)
    await until(() => host.listening)
    return { host, port, seen }
  }

  /** The joining device, as `Remote.requestCode` drives it. */
  function join(port, name = 'Laptop') {
    const shown = []
    const conn = new Conn(connect({ host: '127.0.0.1', port }), identity(name))
    const done = conn
      .askPair((sas, peer) => shown.push({ sas, peer }))
      .then((code) => ({ code }))
      .catch((err) => ({ error: err.message }))
      .finally(() => conn.close())
    return { shown, done }
  }

  // ------------------------------------------------------------------ the digits agree
  {
    const code = newCode()
    const { host, port, seen } = await desk(code, async () => true)
    const asking = join(port)
    const got = await asking.done
    ok('the joiner is handed the pairing code', got.code === code, JSON.stringify(got))
    ok('the host saw the request', seen.length === 1, String(seen.length))
    ok(
      'both screens computed the SAME six digits',
      asking.shown[0]?.sas === seen[0]?.sas,
      `${asking.shown[0]?.sas} vs ${seen[0]?.sas}`
    )
    ok('and they are six digits', /^\d{6}$/.test(seen[0]?.sas ?? ''), seen[0]?.sas)
    ok('the digits arrived before the answer did', asking.shown.length === 1)
    ok('the host names the device that asked', seen[0]?.peer?.name === 'Laptop', seen[0]?.peer?.name)
    // Nothing about this exchange is a session: the socket was never armed.
    ok('a pairing request leaves no guest connected', host.list().length === 0, String(host.list().length))
    host.stop()
  }

  // --------------------------------------------------------------- the machine in the middle
  //
  // The whole security claim. `mitm` is a device the joiner reaches instead of the desk: it
  // answers as a host AND asks the real desk in the joiner's name. It can do that - nothing
  // stops it - and the point is that the number it must show the joiner cannot be the number
  // the desk shows its own operator.
  {
    const code = newCode()
    const desk1 = await desk(code, async () => true)
    const mitmPort = await freePort()
    let shownToJoiner = ''
    let seenByMitmFromDesk = ''

    const relay = createServer((socket) => {
      // Face the joiner as if this were the desk. Its own code, its own keys.
      const face = new Conn(socket, identity('Desk'))
      void face
        .accept(
          Buffer.alloc(32),
          async (_peer, sas) => {
            shownToJoiner = sas
            return true
          },
          'FAKE-CODE'
        )
        .catch(() => {})
      // And ask the real desk, at the same time.
      const onward = new Conn(connect({ host: '127.0.0.1', port: desk1.port }), identity('Laptop'))
      void onward
        .askPair((sas) => {
          seenByMitmFromDesk = sas
        })
        .catch(() => {})
        .finally(() => onward.close())
    })
    await new Promise((r) => relay.listen(mitmPort, '127.0.0.1', r))

    const victim = join(mitmPort)
    await victim.done
    await until(() => desk1.seen.length > 0 && shownToJoiner)

    const atJoiner = victim.shown[0]?.sas ?? ''
    const atDesk = desk1.seen[0]?.sas ?? ''
    ok('the relay did reach the real desk', desk1.seen.length === 1, String(desk1.seen.length))
    ok('the joiner saw a number', /^\d{6}$/.test(atJoiner), atJoiner)
    ok('the desk saw a number', /^\d{6}$/.test(atDesk), atDesk)
    ok(
      'and they DO NOT match - a person comparing them sees the machine in the middle',
      atJoiner !== atDesk,
      `${atJoiner} vs ${atDesk}`
    )
    ok(
      'the relay could not make its own number agree either',
      seenByMitmFromDesk !== shownToJoiner || !seenByMitmFromDesk,
      `${seenByMitmFromDesk} vs ${shownToJoiner}`
    )
    relay.close()
    desk1.host.stop()
  }

  // --------------------------------------------------------------------------- refusal
  {
    const { host, port } = await desk(newCode(), async () => false)
    const got = await join(port).done
    ok('Deny is reported in words, not as a hang', /refused/i.test(got.error ?? ''), JSON.stringify(got))
    ok('and hands over no code', !got.code)
    host.stop()
  }

  // ------------------------------------------------------ a desk that does not take requests
  //
  // `onAsk` unset is the shape a build or a setting with nowhere to show a card takes. It
  // must say so: a silent drop is indistinguishable from a network that ate the packet, and
  // sends the person looking at their router.
  {
    const port = await freePort()
    const host = new RemoteHost(backend(), () => identity('Desk'), () => newCode())
    host.start(port)
    await until(() => host.listening)
    const got = await join(port).done
    ok(
      'a desk with no way to ask refuses by name',
      /not taking pairing requests/i.test(got.error ?? ''),
      JSON.stringify(got)
    )
    host.stop()
  }

  // ---------------------------------------------------------------- an answer that never comes
  //
  // The card is a person, so the wait is minutes. What must not happen is the joiner sitting
  // there for ever when the far end is never answered.
  {
    const port = await freePort()
    const host = new RemoteHost(backend(), () => identity('Desk'), () => newCode())
    host.onAsk = () => new Promise(() => {}) // nobody ever presses anything
    host.start(port)
    await until(() => host.listening)
    const asking = join(port)
    ok('the digits still appear while it waits', await until(() => asking.shown.length === 1, 4000))
    const settled = await Promise.race([asking.done, wait(1500).then(() => 'still waiting')])
    ok('and it is still waiting, not failed', settled === 'still waiting', JSON.stringify(settled))
    host.stop()
    // Closing the desk drops the socket, which is what has to end the wait rather than a
    // promise nobody ever settles.
    const after = await Promise.race([asking.done, wait(4000).then(() => 'hung')])
    ok('a desk that goes away ends the wait', after !== 'hung', JSON.stringify(after))
  }

  // ---------------------------------------------------------------------- the sealed code
  {
    const a = ephemeralKeys()
    const b = ephemeralKeys()
    const c = ephemeralKeys()
    const ab = sharedSecret(a.key, b.pub)
    const ba = sharedSecret(b.key, a.pub)
    ok('two ends derive the same secret', Buffer.compare(ab, ba) === 0)
    ok(
      'the digits bind BOTH public keys, not just the secret',
      sasDigits(ab, a.pub, b.pub) !== sasDigits(ab, b.pub, a.pub)
    )
    const sealed = sealCode(ab, 'ABCD-EFGH')
    ok('the code round-trips under the shared secret', openCode(ba, sealed) === 'ABCD-EFGH')
    let threw = ''
    try {
      openCode(sharedSecret(c.key, a.pub), sealed)
    } catch (err) {
      threw = err.message
    }
    ok('and fails closed under any other secret', !!threw, threw)
    let tampered = ''
    try {
      const bad = Buffer.from(sealed, 'hex')
      bad[20] ^= 0xff
      openCode(ab, bad.toString('hex'))
    } catch (err) {
      tampered = err.message
    }
    ok('a flipped byte does not open', !!tampered, tampered)
  }
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
