// The second lock, proved twice: once as pure crypto against `src/main/passkey.ts` with a
// synthetic WebAuthn authenticator built out of node:crypto, and once as a real HTTP gate
// on a real PhoneServer, the same way `phone-test.mjs` drives one.
//
// No WebAuthn library - the repo has three dependencies and resists a fourth, and passkey.ts
// itself only needs a CBOR reader small enough to read in one sitting. This file writes the
// other half: a CBOR *writer* and an authenticator that signs what a browser's
// `navigator.credentials` would have handed back, so the crypto is real end to end.

import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign as signWith
} from 'node:crypto'
import { buildSync } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// A Windows bundle path is `C:/...`, which is not a legal ESM specifier - `import()`
// throws ERR_UNSUPPORTED_ESM_URL_SCHEME before a single check runs. Every other suite
// here already wraps it; this one shipped without and had therefore never once run on
// this platform.
import { pathToFileURL } from 'node:url'

let failures = 0
let checks = 0
function ok(cond, what, detail = '') {
  checks++
  if (cond) return
  failures++
  console.error(`  FAIL ${what}${detail ? ` - ${detail}` : ''}`)
}
function throwsWith(fn, pattern, what) {
  checks++
  try {
    fn()
    failures++
    console.error(`  FAIL ${what} - did not throw`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!pattern.test(msg)) {
      failures++
      console.error(`  FAIL ${what} - "${msg}" did not match ${pattern}`)
    }
  }
}

const work = mkdtempSync(join(tmpdir(), 'pf-passkey-'))
const passkeyBundle = join(work, 'passkey.mjs')
buildSync({
  entryPoints: ['src/main/passkey.ts'],
  outfile: passkeyBundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const {
  ES256,
  RS256,
  UNLOCK_MS,
  b64url,
  checkUnlock,
  mintUnlock,
  verifyAssertion,
  verifyRegistration
} = await import(pathToFileURL(passkeyBundle).href)

// ==================================================================================
// A tiny CBOR *writer* - the mirror image of the reader in passkey.ts. Same coverage:
// maps, byte strings, text strings, unsigned/negative ints. Nothing else exists in a
// COSE key or an attestation object.
// ==================================================================================

function head(major, len) {
  if (len < 24) return Buffer.from([(major << 5) | len])
  if (len < 256) return Buffer.from([(major << 5) | 24, len])
  if (len < 65536) {
    const b = Buffer.alloc(3)
    b[0] = (major << 5) | 25
    b.writeUInt16BE(len, 1)
    return b
  }
  const b = Buffer.alloc(5)
  b[0] = (major << 5) | 26
  b.writeUInt32BE(len, 1)
  return b
}

function cborEncode(v) {
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v])
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8')
    return Buffer.concat([head(3, b.length), b])
  }
  if (typeof v === 'number') {
    return v >= 0 ? head(0, v) : head(1, -1 - v)
  }
  if (v instanceof Map) {
    const parts = [head(5, v.size)]
    for (const [k, val] of v) {
      parts.push(cborEncode(k))
      parts.push(cborEncode(val))
    }
    return Buffer.concat(parts)
  }
  throw new Error(`cannot encode ${typeof v}`)
}

// ==================================================================================
// A synthetic authenticator: generates a real keypair, builds real authenticator data,
// and signs it the way WebAuthn's client actually does - over authData || sha256(clientDataJSON).
// ==================================================================================

function authData({ rpId, flags, counter, credId, cose }) {
  const rpIdHash = createHash('sha256').update(rpId).digest()
  const flagsByte = Buffer.from([flags])
  const counterBuf = Buffer.alloc(4)
  counterBuf.writeUInt32BE(counter >>> 0, 0)
  let attested = Buffer.alloc(0)
  if (flags & 0x40) {
    const aaguid = Buffer.alloc(16)
    const idLen = Buffer.alloc(2)
    idLen.writeUInt16BE(credId.length, 0)
    attested = Buffer.concat([aaguid, idLen, credId, cborEncode(cose)])
  }
  return Buffer.concat([rpIdHash, flagsByte, counterBuf, attested])
}

function coseFor(alg, publicKey) {
  const jwk = publicKey.export({ format: 'jwk' })
  if (alg === ES256) {
    return new Map([
      [1, 2], // kty: EC2
      [3, ES256],
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x, 'base64url')],
      [-3, Buffer.from(jwk.y, 'base64url')]
    ])
  }
  return new Map([
    [1, 3], // kty: RSA
    [3, RS256],
    [-1, Buffer.from(jwk.n, 'base64url')],
    [-2, Buffer.from(jwk.e, 'base64url')]
  ])
}

function clientData(type, challenge, origin) {
  return Buffer.from(JSON.stringify({ type, challenge, origin }), 'utf8')
}

/** Builds a browser's enrolment body. `flags` defaults to UP|UV|AT (0x45). */
function makeRegistration({ rpId, origin, challenge, credId, alg, keyPair, flags = 0x45, counter = 0, label }) {
  const authRaw = authData({ rpId, flags, counter, credId, cose: coseFor(alg, keyPair.publicKey) })
  const att = new Map([
    ['fmt', 'none'],
    ['attStmt', new Map()],
    ['authData', authRaw]
  ])
  return {
    clientDataJSON: b64url(clientData('webauthn.create', challenge, origin)),
    attestationObject: b64url(cborEncode(att)),
    label
  }
}

/** Builds a browser's assertion body: a real signature over the real bytes. */
function makeAssertion({ rpId, origin, challenge, credId, alg, keyPair, flags = 0x05, counter = 0 }) {
  const authRaw = authData({ rpId, flags, counter, credId, cose: null })
  const cdj = clientData('webauthn.get', challenge, origin)
  const signed = Buffer.concat([authRaw, createHash('sha256').update(cdj).digest()])
  const signature =
    alg === ES256
      ? signWith('sha256', signed, { key: keyPair.privateKey, dsaEncoding: 'der' })
      : signWith('sha256', signed, keyPair.privateKey)
  return {
    id: b64url(credId),
    clientDataJSON: b64url(cdj),
    authenticatorData: b64url(authRaw),
    signature: b64url(signature)
  }
}

const WANT = { challenge: 'chal-1', rpId: 'desk.example.com', origin: 'https://desk.example.com' }
const ecKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const credId = randomBytes(16)

console.log('passkey: crypto unit tests')

// ---- A1/A2: round trip -----------------------------------------------------------

let stored
{
  const body = makeRegistration({ ...WANT, credId, alg: ES256, keyPair: ecKeys, label: 'iPhone' })
  stored = verifyRegistration(body, WANT)
  ok(stored.id === b64url(credId), 'the stored key keeps the credential id')
  ok(stored.alg === ES256, 'and the algorithm it enrolled with')
  ok(stored.count === 0, 'and its starting counter')
  const jwk = JSON.parse(stored.jwk)
  ok(jwk.kty === 'EC' && jwk.crv === 'P-256', 'the jwk is a usable EC key', JSON.stringify(jwk))

  const assertion = makeAssertion({ ...WANT, credId, alg: ES256, keyPair: ecKeys, counter: 1 })
  const moved = verifyAssertion(assertion, WANT, [stored])
  ok(moved.id === stored.id, 'verifyAssertion accepts a correctly signed assertion')
  ok(moved.count === 1, 'and returns the key with its counter moved on')
}

// ---- A3: each refusal has its own reason ------------------------------------------

{
  const good = () => makeAssertion({ ...WANT, credId, alg: ES256, keyPair: ecKeys, counter: 2 })

  throwsWith(
    () => verifyAssertion({ ...good(), clientDataJSON: b64url(clientData('webauthn.get', 'wrong-chal', WANT.origin)) }, WANT, [stored]),
    /wrong challenge/,
    'wrong challenge is refused'
  )

  throwsWith(
    () => verifyAssertion({ ...good(), clientDataJSON: b64url(clientData('webauthn.get', WANT.challenge, 'https://evil.example.com')) }, WANT, [stored]),
    /wrong origin/,
    'wrong origin is refused'
  )

  // The classic phishing shape: a suffix match would let `desk.example.com.attacker.com`
  // through, because it literally ends with the real origin.
  throwsWith(
    () =>
      verifyAssertion(
        { ...good(), clientDataJSON: b64url(clientData('webauthn.get', WANT.challenge, 'https://desk.example.com.attacker.com')) },
        WANT,
        [stored]
      ),
    /wrong origin/,
    'the suffix-attack origin is refused, not accepted as a prefix match'
  )

  // Built for a different rpId entirely, so its rpIdHash cannot match `desk.example.com`.
  const otherRp = makeAssertion({ rpId: 'attacker.com', origin: WANT.origin, challenge: WANT.challenge, credId, alg: ES256, keyPair: ecKeys, counter: 2 })
  throwsWith(() => verifyAssertion(otherRp, WANT, [stored]), /another site/, 'wrong rpIdHash is refused')

  const noUv = makeAssertion({ ...WANT, credId, alg: ES256, keyPair: ecKeys, counter: 2, flags: 0x01 })
  throwsWith(() => verifyAssertion(noUv, WANT, [stored]), /did not verify the user/, 'UV flag clear is refused')

  const badSig = good()
  badSig.signature = b64url(Buffer.from(unb64url(badSig.signature)).map((b, i) => (i === 0 ? b ^ 0xff : b)))
  throwsWith(() => verifyAssertion(badSig, WANT, [stored]), /did not verify/, 'a signature that does not verify is refused')

  const unknown = good()
  unknown.id = b64url(randomBytes(16))
  throwsWith(() => verifyAssertion(unknown, WANT, [stored]), /unknown credential/, 'an unknown credential id is refused')
}
function unb64url(s) {
  return Buffer.from(s, 'base64url')
}

// ---- A4: counter regression, and the Apple 0->0 exemption -------------------------

{
  const at5 = { ...stored, count: 5 }
  const equal = makeAssertion({ ...WANT, credId, alg: ES256, keyPair: ecKeys, counter: 5 })
  throwsWith(() => verifyAssertion(equal, WANT, [at5]), /cloned/, 'counter equal to stored is refused')

  const behind = makeAssertion({ ...WANT, credId, alg: ES256, keyPair: ecKeys, counter: 4 })
  throwsWith(() => verifyAssertion(behind, WANT, [at5]), /cloned/, 'counter behind stored is refused')

  const ahead = makeAssertion({ ...WANT, credId, alg: ES256, keyPair: ecKeys, counter: 6 })
  const movedAhead = verifyAssertion(ahead, WANT, [at5])
  ok(movedAhead.count === 6, 'counter ahead of stored is accepted')

  const at0 = { ...stored, count: 0 }
  const stillZero = makeAssertion({ ...WANT, credId, alg: ES256, keyPair: ecKeys, counter: 0 })
  const movedZero = verifyAssertion(stillZero, WANT, [at0])
  ok(movedZero.count === 0, 'a stalled 0 counter (the Apple case) is accepted, not treated as regression')
}

// ---- A5: checkUnlock ---------------------------------------------------------------

{
  const secret = 'gate-secret'
  const now = Date.now()
  const cookie = mintUnlock(secret, stored.id, now)
  ok(checkUnlock(secret, cookie, [stored], now), 'a freshly minted cookie passes')
  ok(!checkUnlock(secret, cookie, [stored], now + UNLOCK_MS + 1), 'an expired cookie fails')

  const [credPart, untilPart, macPart] = cookie.split('.')
  const tampered = `${credPart}.${untilPart}.${macPart.slice(0, -1)}${macPart.at(-1) === 'a' ? 'b' : 'a'}`
  ok(!checkUnlock(secret, tampered, [stored], now), 'a tampered mac fails')

  ok(!checkUnlock(secret, cookie, [], now), 'a cookie whose credId is no longer enrolled fails')
}

// ---- A6: RS256, if it comes together cleanly ---------------------------------------

{
  const rsaKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const rsaCredId = randomBytes(16)
  const body = makeRegistration({ ...WANT, credId: rsaCredId, alg: RS256, keyPair: rsaKeys, label: 'Windows Hello' })
  const rsaStored = verifyRegistration(body, WANT)
  ok(rsaStored.alg === RS256, 'an RS256 enrolment is stored with its algorithm')
  const assertion = makeAssertion({ ...WANT, credId: rsaCredId, alg: RS256, keyPair: rsaKeys, counter: 1 })
  const moved = verifyAssertion(assertion, WANT, [rsaStored])
  ok(moved.id === rsaStored.id, 'RS256: verifyAssertion accepts a correctly signed assertion')
}

console.log(`  ${checks} checks so far, ${failures} failed`)

// ==================================================================================
// B. The gate, over real HTTP against a real PhoneServer - the same harness shape as
// phone-test.mjs: esbuild the module, boot it on a real port, fetch it for real.
// ==================================================================================

console.log('passkey: gate integration tests')

const phoneBundle = join(work, 'phone.mjs')
buildSync({
  entryPoints: ['src/main/phone.ts'],
  outfile: phoneBundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent'
})
const { PhoneServer } = await import(pathToFileURL(phoneBundle).href)

let keys = []
const invoked = []
const sent = []
const code = 'ABC234'
const server = new PhoneServer({
  staticDir: join(work, 'no-renderer-needed'),
  code: () => code,
  secret: () => 'device-secret',
  channels: {
    invoke: ['sessions:list', 'sessions:start', 'pty:choose'],
    send: ['pty:write', 'pty:resize'],
    on: []
  },
  invoke: async (channel, args) => {
    invoked.push([channel, args])
    return { ok: true }
  },
  send: (channel, args) => sent.push([channel, args]),
  keys: () => keys,
  saveKeys: (list) => (keys = list),
  typeGate: () => true
})

const port = 7480 + (process.pid % 90)
const state = await server.start(port, '127.0.0.1')
ok(state.on, 'gate test server is up', state.error)
const base = `http://127.0.0.1:${port}`

async function post(path, body, headers) {
  return await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}
async function get(path, headers) {
  return await fetch(base + path, { headers: headers ?? {} })
}

// Pair first: everything below requires an authed browser.
const paired = await post('/pf/pair', { code })
const pf = (paired.headers.get('set-cookie') ?? '').split(';')[0]
ok(/^pf=/.test(pf), 'the gate tests are authed before anything else', pf)

// A non-loopback address, over the tunnel: the shape `armed()` requires alongside TLS.
const TUNNEL = { 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' }
const cookie = (extra) => [pf, extra].filter(Boolean).join('; ')

// ---- 7. the load-bearing one: no TLS, no arming ------------------------------------

{
  const noTls = await post('/pf/send', { calls: [{ channel: 'pty:write', args: ['p1', 'x'] }] }, { cookie: cookie() })
  ok(
    noTls.status === 200,
    'THE LOAD-BEARING CASE: with typeGate on but no x-forwarded-proto: https, the gate must NOT arm - pty:write goes through (200)',
    `got ${noTls.status}, expected 200 - if this is 423 the gate is arming over plain http, which locks out every LAN phone`
  )

  const withTls = await post('/pf/send', { calls: [{ channel: 'pty:write', args: ['p1', 'y'] }] }, { cookie: cookie(), ...TUNNEL })
  ok(
    withTls.status === 423,
    'THE LOAD-BEARING CASE, other half: TLS + a non-loopback address arms the gate - the same call is now refused (423)',
    `got ${withTls.status}, expected 423 - if this is 200 the gate never armed at all`
  )

  // The case above varies BOTH headers at once, so it passes whether the TLS rule is
  // enforced or not - deleting `if (!isTls(req)) return false` from `armed()` left the whole
  // suite green, which is precisely the silent inversion this test exists to catch. This one
  // holds the address fixed at a non-loopback client and varies ONLY the protocol, so the
  // TLS rule is the single thing that can decide it.
  const remoteNoTls = await post(
    '/pf/send',
    { calls: [{ channel: 'pty:write', args: ['p1', 'z'] }] },
    { cookie: cookie(), 'x-forwarded-for': '203.0.113.9' }
  )
  ok(
    remoteNoTls.status === 200,
    'ONLY the protocol differs: a non-loopback client over plain http is NOT gated',
    `got ${remoteNoTls.status}, expected 200 - the gate is arming without TLS, so a LAN phone (which has no way to satisfy WebAuthn) can never type again`
  )
}

// ---- 8. a 423'd batch runs NONE of its calls ---------------------------------------

{
  const before = sent.length
  const mixed = await post(
    '/pf/send',
    { calls: [{ channel: 'pty:write', args: ['p1', 'z'] }, { channel: 'pty:resize', args: ['p1', 80, 24] }] },
    { cookie: cookie(), ...TUNNEL }
  )
  ok(mixed.status === 423, 'a mixed batch with a gated call locked is refused as a whole')
  ok(sent.length === before, 'and neither call in it ran - not even the ungated one', JSON.stringify(sent.slice(before)))
}

// ---- 9. non-gated channels still work while locked ---------------------------------

{
  const before = sent.length
  const resizeOnly = await post(
    '/pf/send',
    { calls: [{ channel: 'pty:resize', args: ['p1', 80, 24] }] },
    { cookie: cookie(), ...TUNNEL }
  )
  ok(resizeOnly.status === 200, 'a batch with only non-gated channels is not blocked while locked', String(resizeOnly.status))
  ok(sent.length === before + 1, 'and it really ran', JSON.stringify(sent.slice(before)))
}

// ---- 10. a gated invoke while locked answers 200 with locked:true ------------------

{
  const before = invoked.length
  const call = await post(
    '/pf/call',
    { id: 42, channel: 'sessions:start', args: [] },
    { cookie: cookie(), ...TUNNEL }
  )
  ok(call.status === 200, 'a gated invoke while locked is a 200, not a 423', String(call.status))
  const body = await call.json()
  ok(body.locked === true, 'and the envelope says locked:true', JSON.stringify(body))
  ok(invoked.length === before, 'and the real handler was never invoked')
}

// ---- 10b. answering a QUESTION is typing, and is gated ------------------------------
//
// `pty:choose` sends arrows and a return into a pane, but it arrives as an `invoke`
// rather than through `pty:write` - so it slipped past the gate list entirely and a
// stolen cookie could press "1. Yes, run it" on any permission prompt on screen. The
// check is by behaviour rather than by reading the set, because the set is what was
// wrong: what matters is that the CALL does not reach the handler while locked.
{
  const before = invoked.length
  const call = await post(
    '/pf/call',
    { id: 43, channel: 'pty:choose', args: ['s1-whatever', 1] },
    { cookie: cookie(), ...TUNNEL }
  )
  ok(call.status === 200, 'answering a question while locked is a 200 envelope', String(call.status))
  const body = await call.json()
  ok(body.locked === true, 'and it is LOCKED - a question is typing, whatever channel it rides', JSON.stringify(body))
  ok(invoked.length === before, 'and no keystroke reached the pane')
}

// ---- 11. enrolment, and a challenge that is good exactly once ----------------------

let unlockCookie = ''
let enrolCredId
{
  const stateRes = await get('/pf/key/state', { cookie: cookie(), ...TUNNEL })
  const s = await stateRes.json()
  ok(s.armed === true, 'key/state reports the gate armed under the tunnel headers', JSON.stringify(s))
  ok(typeof s.challenge === 'string' && s.challenge.length > 0, 'and hands out a challenge')

  enrolCredId = randomBytes(16)
  const body = {
    ...makeRegistration({
      rpId: s.rpId,
      origin: s.origin,
      challenge: s.challenge,
      credId: enrolCredId,
      alg: ES256,
      keyPair: ecKeys,
      label: 'integration test'
    }),
    // The route reads the challenge back off the body itself, alongside the
    // WebAuthn payload it is bound into.
    challenge: s.challenge
  }

  const first = await post('/pf/key/enrol', body, { cookie: cookie(), ...TUNNEL })
  ok(first.status === 200, 'a correctly signed enrolment is accepted', String(first.status))
  const setCookie = first.headers.get('set-cookie') ?? ''
  ok(/^pfu=/.test(setCookie), 'and the response mints the unlock cookie', setCookie.slice(0, 20))
  unlockCookie = setCookie.split(';')[0]
  ok(keys.length === 1 && keys[0].id === b64url(enrolCredId), 'the key is really enrolled', JSON.stringify(keys))

  const replay = await post('/pf/key/enrol', body, { cookie: cookie(), ...TUNNEL })
  ok(replay.status === 400, 'replaying the exact same enrolment body a second time is refused', String(replay.status))
  ok(/stale challenge/.test(await replay.text()), 'and refused by name: a stale challenge')
}

// ---- unlock replay, the other half of "single use" ---------------------------------

{
  const stateRes = await get('/pf/key/state', { cookie: cookie(), ...TUNNEL })
  const s = await stateRes.json()
  const assertion = {
    ...makeAssertion({ rpId: s.rpId, origin: s.origin, challenge: s.challenge, credId: enrolCredId, alg: ES256, keyPair: ecKeys, counter: 3 }),
    challenge: s.challenge
  }

  const first = await post('/pf/key/unlock', assertion, { cookie: cookie(), ...TUNNEL })
  ok(first.status === 200, 'a correctly signed unlock is accepted')

  const replay = await post('/pf/key/unlock', assertion, { cookie: cookie(), ...TUNNEL })
  ok(replay.status === 403, 'replaying the same unlock body a second time is refused', String(replay.status))
  ok(/stale challenge/.test(await replay.text()), 'and refused by name: a stale challenge')
}

// ---- 12. the unlock cookie opens the gate, and forgetting the key closes it --------

{
  const unlocked = await post(
    '/pf/send',
    { calls: [{ channel: 'pty:write', args: ['p1', 'w'] }] },
    { cookie: cookie(unlockCookie), ...TUNNEL }
  )
  ok(unlocked.status === 200, 'a gated send with the unlock cookie goes through', String(unlocked.status))

  keys = [] // "forget the key"
  const afterForget = await post(
    '/pf/send',
    { calls: [{ channel: 'pty:write', args: ['p1', 'w'] }] },
    { cookie: cookie(unlockCookie), ...TUNNEL }
  )
  ok(
    afterForget.status === 423,
    'the SAME unlock cookie stops working the instant the key it was minted for is forgotten',
    String(afterForget.status)
  )
}

// ---- 13. loopback with no forwarded headers is never gated, even under a TLS claim -

{
  keys = [] // still empty; this must not matter - the point is the gate never arms here
  const fromLoopback = await post(
    '/pf/send',
    { calls: [{ channel: 'pty:write', args: ['p1', 'q'] }] },
    { cookie: cookie(), 'x-forwarded-proto': 'https' } // TLS claimed, but no x-forwarded-for
  )
  ok(
    fromLoopback.status === 200,
    'a request from loopback with no forwarded-for is never gated, even claiming TLS - pf-ctl must keep working',
    String(fromLoopback.status)
  )
}

await server.stop()
ok(!server.running, 'the gate test server stopped cleanly')

// ---- 12. every channel is CLASSIFIED, not ungated by omission -----------------------
//
// GATED_INVOKE is a denylist: a channel that nobody thought about is reachable over HTTP
// with a cookie and no passkey. That is how `admin:enable` - which registers the scheduled
// task that relaunches this app ELEVATED with no UAC prompt - sat outside the gate, and how
// `pty:choose` did before it. Nothing in the types or the tests said a word either time.
//
// So the rule is now written down: every channel in surface.ts's invoke list is gated,
// desk-only, or on the reviewed-safe list below. Adding a channel without deciding which
// fails this test. The safe list is deliberately explicit and deliberately long - reading
// it is the review. Anything that writes to disk, installs, elevates, opens a program or
// types into a pane does NOT belong on it.
{
  const surfaceSrc = readFileSync('src/shared/surface.ts', 'utf8')
  const phoneSrc = readFileSync('src/main/phone.ts', 'utf8')
  // Not `'\]` at the end: an invoke entry may carry literal arguments the bridge adds
  // itself (`listAgents: ['invoke', 'agents:list', true]`), and requiring the bracket
  // skipped exactly those - so the one channel with a fixed argument was never classified
  // by the test that exists to make sure every channel is.
  const channels = [...surfaceSrc.matchAll(/\['invoke', '([^']+)'/g)].map((m) => m[1])
  const sends = [...surfaceSrc.matchAll(/\['send', '([^']+)'/g)].map((m) => m[1])
  const setLiteral = (name) => {
    const m = new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(phoneSrc)
    // Comments stripped BEFORE the quotes are read. One apostrophe in a comment - "the
    // lock's own perimeter" - pairs with the next real quote and silently swallows every
    // channel after it, which read here as "these are not gated" while the code gated them.
    const body = m ? m[1].replace(/\/\/[^\n]*/g, '') : ''
    return new Set([...body.matchAll(/'([^']+)'/g)].map((x) => x[1]))
  }
  const gated = setLiteral('GATED_INVOKE')
  const deskOnly = setLiteral('DESK_ONLY')
  ok(channels.length > 50, 'the surface channel list was actually parsed', String(channels.length))
  ok(gated.has('admin:enable') && gated.has('admin:disable'), 'elevation is behind the passkey')
  ok(gated.has('pty:choose'), 'answering a question is still behind the passkey')

  // The three classes the gate now recognises, spelled out so a reader can check them:
  //  - runs a process here (agents:install, shell:editor, sessions:start, ...)
  //  - changes who may reach here (config:set, the phone:* switches, every remote:* pairing)
  //  - is irreversible or reads what was never on the phone's screen (history:delete,
  //    clipboard:read - the DESK's clipboard, where a password manager's paste lives)
  ok(gated.has('agents:install') && gated.has('update:install'), 'installers are gated')
  ok(gated.has('config:set'), 'the config that decides what start runs is gated')
  ok(gated.has('phone:tunnel') && gated.has('remote:pair'), 'the ways in are gated')
  ok(gated.has('clipboard:read') && gated.has('history:delete'), 'exfil and deletion are gated')
  ok(gated.has('prompt:split'), 'reading a long ask starts an agent here, so it is gated')

  // Reviewed 2026-08-16: reads, watches, and the state a phone needs to draw a screen.
  // `board:tasks`/`board:memory` write, but only to the board's own notes - they cannot
  // start anything and cannot delete a transcript. `voice:transcribe` spawns whisper on an
  // uploaded blob: a process, but one that burns this desk's CPU and returns text, with
  // nothing on the far side to steal. Everything else here is a read.
  // `autoclear:ask` ends in `/clear` and a prompt being TYPED into a pane, so it is gated
  // with everything else that types: it reaches the app through the phone server, where
  // `pane-clear.mjs` pairs exactly as a browser does. A 423 there is the gate working -
  // the hook logs the refusal and asks again on the next Stop rather than clearing.
  //
  // `autoclear:cancel` only ever stands a countdown DOWN. Gating it would be a lock that
  // can stop somebody keeping their own session, which is the wrong way round.
  // `autoclear:takeover` is the same fact one step later: it stands a handover DOWN and
  // moves `lastKeyboard`, which is what cancels the queued resume prompt. It types
  // nothing, starts nothing and cannot reach a pty. It is also fired from the renderer by
  // an ESC in a pane mid-handover, and that renderer IS the phone - so gating it would
  // 423 somebody taking their own pane back from the only screen they have.
  // `activity:list` is a READING of things that have already happened - the same words
  // the corner cards said out loud at the time. It types nothing and reaches no pty.
  const REVIEWED_SAFE = new Set([
    'activity:list',
    'autoclear:cancel', 'autoclear:takeover',
    'projects:list', 'projects:route', 'agents:list', 'sessions:list', 'sessions:rename', 'sessions:clientUndo',
    // Read-only, and the answer is a public release page's own notes.
    'app:whatsNew',
    'app:quitIdle', 'sessions:buffer', 'sessions:log', 'drive:stop', 'drive:list',
    'drive:clear', 'goal:list', 'goal:cancel', 'goal:remove', 'goal:clear', 'config:get',
    'config:pickRoot', 'sounds:add', 'sounds:data', 'sounds:remove', 'sounds:rename',
    'discord:status', 'shell:pathKind', 'clipboard:fixtureActive', 'git:info',
    'git:diffFiles', 'git:diffPatch', 'lanes:board', 'lanes:work', 'admin:status',
    'app:profile', 'agents:locate', 'update:state', 'update:check', 'game:status',
    'app:visibleNow', 'game:manual', 'restore:pending', 'board:get', 'board:tasks',
    'board:memory', 'history:list', 'history:search', 'history:read', 'recents:list',
    'recents:search', 'recents:text', 'stash:add', 'stash:pick', 'phone:state',
    'remote:state', 'remote:rename', 'remote:ask', 'remote:cancelAsk', 'remote:scan',
    'remote:watch', 'remote:projects', 'remote:agents', 'remote:handoffPending',
    'prompt:prior', 'improve:status',
    'improve:answer', 'voice:status', 'voice:transcribe', 'usage:get',
    // A read of the process table, filtered to dev servers. `devs:stop` is the other half
    // and is GATED - it kills a process on this desk.
    'devs:list',
    // Reviewed 2026-08-23. A read of the /clear countdowns in flight - what is pending and
    // when it is due. The two channels that START or SKIP one (`autoclear:ask`,
    // `autoclear:answer`) are GATED: both end in keystrokes reaching a pane.
    'autoclear:pending',
    // Reviewed 2026-08-22. The same process table filtered to work no pane owns, here and
    // on a paired machine. Both are reads and neither can start or stop anything: the
    // remote one goes out as a `jobs` frame the other end answers by reading ITS table,
    // and there is no `jobs:stop`. What comes back is a pid, a label and an age.
    'jobs:list', 'jobs:remote',
    // Reviewed 2026-09-01. One boolean off `powerMonitor`: is this machine on battery.
    // It starts nothing, changes nothing, and names nothing that is not already on the
    // lid of the laptop the asker is holding.
    'app:batteryNow'
  ])
  const unclassified = channels.filter((c) => !gated.has(c) && !deskOnly.has(c) && !REVIEWED_SAFE.has(c))
  ok(
    unclassified.length === 0,
    'no invoke channel is ungated merely because nobody classified it',
    `unclassified: ${unclassified.join(', ')} - add each to GATED_INVOKE, DESK_ONLY, or REVIEWED_SAFE here`
  )
  // A channel in both lists is a review that contradicts itself, and the code wins silently.
  const bothWays = [...gated].filter((c) => REVIEWED_SAFE.has(c))
  ok(bothWays.length === 0, 'no channel is both gated and reviewed-safe', bothWays.join(', '))

  // The SEND side has the same hole and had never been checked at all: a send answers
  // nothing, so an attacker using one does not care that the reply is `{ ok: true }`.
  const gatedSend = setLiteral('GATED_SEND')
  ok(gatedSend.has('app:relaunchAsAdmin'), 'relaunching elevated is behind the passkey')
  ok(gatedSend.has('restore:answer'), 'accepting a deskful of panes is behind the passkey')
  // Reviewed 2026-08-16: pane geometry, visibility, bells and the stash's own text - the
  // things a phone touches constantly and none of which start anything.
  const REVIEWED_SAFE_SEND = new Set([
    // Writes ONE number - when the list was last looked at, so a badge stops counting.
    // Nothing it touches can start, stop, type into or close anything.
    'activity:seen',
    'sessions:reorder', 'sessions:attention-clear', 'pty:resize', 'pty:return', 'pty:visible',
    'pty:redraw', 'sessions:busy', 'clipboard:write', 'recents:edit', 'recents:copy',
    'recents:drag', 'recents:remove', 'recents:clear', 'recents:inWindow', 'shelf:toggle',
    'prompt:used', 'improve:cancel', 'research:cancel', 'improve:record', 'sessions:bell',
    // Reviewed 2026-08-25: one line in this desk's own reclaim log saying why a pane was
    // or was not closed. It starts nothing and answers nothing - the worst a phone reaches
    // is a bigger log file.
    'reclaim:log',
    // Reviewed 2026-09-01: "leave that dev server alone". It writes one pid into a
    // never-offer-again set for this app run. It starts nothing and stops nothing - the
    // worst a phone reaches is that a leaked dev server keeps leaking.
    'devs:keep'
  ])
  const unclassifiedSend = sends.filter(
    (c) => !gatedSend.has(c) && !deskOnly.has(c) && !REVIEWED_SAFE_SEND.has(c)
  )
  ok(
    unclassifiedSend.length === 0,
    'no send channel is ungated merely because nobody classified it',
    `unclassified: ${unclassifiedSend.join(', ')} - add each to GATED_SEND, DESK_ONLY, or REVIEWED_SAFE_SEND here`
  )
}

rmSync(work, { recursive: true, force: true })
console.log(`passkey: ${checks - failures}/${checks} checks passed`)
// Not process.exit() on the spot. On Windows that races libuv's teardown of a handle
// this run already asked to close - the whole suite passes, prints 49/49, and then
// aborts with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and exit 127,
// which the runner can only read as a failed suite. Setting the code and letting node
// exit when its loop is empty is the same outcome without the race.
process.exitCode = failures ? 1 : 0
