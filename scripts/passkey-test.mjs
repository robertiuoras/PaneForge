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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
} = await import(passkeyBundle)

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
const { PhoneServer } = await import(phoneBundle)

let keys = []
const invoked = []
const sent = []
const code = 'ABC234'
const server = new PhoneServer({
  staticDir: join(work, 'no-renderer-needed'),
  code: () => code,
  secret: () => 'device-secret',
  channels: {
    invoke: ['sessions:list', 'sessions:start'],
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

rmSync(work, { recursive: true, force: true })
console.log(`passkey: ${checks - failures}/${checks} checks passed`)
process.exit(failures ? 1 : 0)
