/**
 * The second lock: a passkey touch before a browser may type into a pane.
 *
 * Signing in and running commands are not the same risk, and until now they were the same
 * permission. A phone that is signed in can watch panes all day - that is the whole point of
 * carrying the desk in a pocket - but the first keystroke is arbitrary code on this machine,
 * and one stolen cookie should not be enough to reach it. So watching stays free and typing
 * costs one Face ID touch per unlock window.
 *
 * Decisions worth not re-litigating:
 *
 * - **The gate is at the HTTP boundary, never at the write path.** It lives on `/pf/send`
 *   and `/pf/call`, which is bytes that arrived from a browser. Everything the app types
 *   into a pane itself - `recover`'s "continue", the prompt `sessions:start` queues - is
 *   raised in the main process and never crosses that route, so it is structurally exempt
 *   rather than exempt by a flag somebody has to remember to set. Gating `pty:write` itself
 *   would have broken both of those, silently.
 * - **Armed only over TLS.** WebAuthn needs a secure context, so a phone on plain http over
 *   the LAN could not satisfy the gate even in principle - arming it there would lock out
 *   the common case to defend the rare one. `x-forwarded-proto: https` is exactly the
 *   tunnel/Access path, which is the one with the open internet on the other end.
 * - **No attestation checking.** We are not deciding whether an authenticator is a genuine
 *   YubiKey; we are deciding whether the same authenticator that enrolled is the one here
 *   now. The public key out of the enrolment is the whole of what we need, and demanding
 *   attestation would reject exactly the platform authenticators (Face ID, Windows Hello)
 *   this is for.
 * - **User verification is REQUIRED, not preferred.** The point of the touch is the human,
 *   so an assertion with UV clear is refused. Presence alone is a tap anybody holding the
 *   phone can make.
 * - **The unlock is a signed cookie, not server state.** `hmac(secret, credId|expiry)`, so
 *   nothing has to be kept in step, a restart does not strand a phone mid-session, and
 *   revocation is the same lever as everything else here: forget the key, or rotate the
 *   code the secret is derived from.
 * - **Keys are stored as JWK, not DER.** Node's `createPublicKey` takes JWK directly, which
 *   removes the one part of WebAuthn verification that is fiddly enough to get quietly
 *   wrong - hand-building SubjectPublicKeyInfo for two different key types.
 */

import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySig
} from 'node:crypto'
// Node's own JWK type, not the DOM one of the same name - they are structurally different
// and the ambient DOM lib wins the bare name inside this project's config.
import type { JsonWebKey as NodeJwk } from 'node:crypto'
import type { PhoneKey } from '../shared/types'

/** How long one touch is good for. Long enough to work, short enough that a walked-away phone re-asks. */
export const UNLOCK_MS = 15 * 60_000
/** A challenge nobody answered is not worth remembering. */
export const CHALLENGE_MS = 120_000

/** COSE algorithm ids we accept: ES256 is every Apple platform, RS256 is Windows Hello. */
export const ES256 = -7
export const RS256 = -257

/** The stored row lives in shared/types.ts, because config holds it and the panel shows it. */
export type StoredKey = PhoneKey

export const b64url = (b: Buffer): string => b.toString('base64url')
export const unb64url = (s: string): Buffer => Buffer.from(String(s ?? ''), 'base64url')

export function newChallenge(): string {
  return b64url(randomBytes(32))
}

// ---- a CBOR reader, small enough to read in one sitting ----------------------------
//
// WebAuthn hands back two CBOR blobs: the attestation object and, inside it, the COSE
// public key. Both use only maps, arrays, ints, byte strings and text - so this covers
// major types 0-5 and stops. A general CBOR library would be a fourth dependency in a repo
// with three, to read two structures whose shape has been frozen since 2019.

interface Read<T> {
  value: T
  at: number
}

function cbor(buf: Buffer, at: number): Read<unknown> {
  const first = buf[at]
  if (first === undefined) throw new Error('cbor: ran off the end')
  const major = first >> 5
  const minor = first & 0x1f
  at += 1
  let len = minor
  if (minor === 24) {
    len = buf.readUInt8(at)
    at += 1
  } else if (minor === 25) {
    len = buf.readUInt16BE(at)
    at += 2
  } else if (minor === 26) {
    len = buf.readUInt32BE(at)
    at += 4
  } else if (minor >= 28) {
    throw new Error(`cbor: unsupported length ${minor}`)
  }
  switch (major) {
    case 0:
      return { value: len, at }
    case 1:
      return { value: -1 - len, at }
    case 2: {
      const end = at + len
      if (end > buf.length) throw new Error('cbor: byte string ran off the end')
      return { value: buf.subarray(at, end), at: end }
    }
    case 3: {
      const end = at + len
      if (end > buf.length) throw new Error('cbor: text ran off the end')
      return { value: buf.subarray(at, end).toString('utf8'), at: end }
    }
    case 4: {
      const out: unknown[] = []
      for (let i = 0; i < len; i++) {
        const r = cbor(buf, at)
        out.push(r.value)
        at = r.at
      }
      return { value: out, at }
    }
    case 5: {
      const out = new Map<unknown, unknown>()
      for (let i = 0; i < len; i++) {
        const k = cbor(buf, at)
        const v = cbor(buf, k.at)
        out.set(k.value, v.value)
        at = v.at
      }
      return { value: out, at }
    }
    default:
      throw new Error(`cbor: unsupported major type ${major}`)
  }
}

/** Exported for the test, which asserts this against bytes from a real authenticator. */
export function decodeCbor(buf: Buffer): unknown {
  return cbor(buf, 0).value
}

// ---- authenticator data ------------------------------------------------------------

export interface AuthData {
  rpIdHash: Buffer
  /** bit 0 user present, bit 2 user verified, bit 6 attested credential data follows */
  flags: number
  count: number
  credId?: Buffer
  cose?: Map<unknown, unknown>
}

export function parseAuthData(buf: Buffer): AuthData {
  if (buf.length < 37) throw new Error('authenticator data too short')
  const out: AuthData = {
    rpIdHash: buf.subarray(0, 32),
    flags: buf[32],
    count: buf.readUInt32BE(33)
  }
  // Bit 6 (AT) says an enrolment's credential and key are appended. An assertion has it
  // clear and stops here, which is why this is a branch and not an assumption.
  if (out.flags & 0x40) {
    if (buf.length < 55) throw new Error('attested credential data is truncated')
    const idLen = buf.readUInt16BE(53)
    if (buf.length < 55 + idLen) throw new Error('credential id is truncated')
    out.credId = buf.subarray(55, 55 + idLen)
    out.cose = cbor(buf, 55 + idLen).value as Map<unknown, unknown>
  }
  return out
}

/**
 * COSE key -> JWK. The two shapes we accept and nothing else: an EC2 key on P-256, and an
 * RSA key. An algorithm we do not know is refused here rather than at verify time, so an
 * unusable key is never written into config in the first place.
 */
export function coseToJwk(cose: Map<unknown, unknown>): { jwk: Record<string, string>; alg: number } {
  const kty = cose.get(1)
  const alg = Number(cose.get(3))
  if (kty === 2) {
    if (alg !== ES256) throw new Error(`unsupported EC algorithm ${alg}`)
    if (cose.get(-1) !== 1) throw new Error('EC key is not on P-256')
    const x = cose.get(-2)
    const y = cose.get(-3)
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y)) throw new Error('EC key has no coordinates')
    return { jwk: { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) }, alg: ES256 }
  }
  if (kty === 3) {
    if (alg !== RS256) throw new Error(`unsupported RSA algorithm ${alg}`)
    const n = cose.get(-1)
    const e = cose.get(-2)
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) throw new Error('RSA key has no modulus')
    return { jwk: { kty: 'RSA', n: b64url(n), e: b64url(e) }, alg: RS256 }
  }
  throw new Error(`unsupported key type ${String(kty)}`)
}

// ---- the two verifications ---------------------------------------------------------

export interface Expect {
  /** the challenge we issued, base64url */
  challenge: string
  /** the host part only, e.g. `desk-7f2.pf.taskdriver.ai` */
  rpId: string
  /** the full origin the browser must claim, e.g. `https://desk-7f2.pf.taskdriver.ai` */
  origin: string
}

function checkClientData(raw: Buffer, want: Expect, type: string): void {
  let data: { type?: string; challenge?: string; origin?: string }
  try {
    data = JSON.parse(raw.toString('utf8')) as typeof data
  } catch {
    throw new Error('client data is not JSON')
  }
  if (data.type !== type) throw new Error(`client data is a ${String(data.type)}, not a ${type}`)
  // Compared with a timing-safe equal for the same reason the pairing code is: this is a
  // secret we issued and the browser is echoing back.
  const got = Buffer.from(String(data.challenge ?? ''))
  const exp = Buffer.from(want.challenge)
  if (got.length !== exp.length || !timingSafeEqual(got, exp)) throw new Error('wrong challenge')
  // The origin check is what makes a passkey phishing-resistant, so it is exact - not a
  // suffix match, which is the classic way this check gets quietly disabled by an attacker
  // registering `desk.pf.taskdriver.ai.attacker.com`.
  if (data.origin !== want.origin) throw new Error(`wrong origin ${String(data.origin)}`)
}

function checkAuthData(auth: AuthData, want: Expect): void {
  const hash = createHash('sha256').update(want.rpId).digest()
  if (!auth.rpIdHash.equals(hash)) throw new Error('this assertion is for another site')
  if (!(auth.flags & 0x01)) throw new Error('no user present')
  // Required, not preferred: see the header. A touch that did not verify a human is a tap
  // anybody holding an unlocked phone can make, which is the threat, not the defence.
  if (!(auth.flags & 0x04)) throw new Error('the authenticator did not verify the user')
}

export interface RegistrationBody {
  clientDataJSON: string
  attestationObject: string
  label?: string
}

/** Turn a browser's enrolment into the row we keep. Throws with a reason on any failure. */
export function verifyRegistration(body: RegistrationBody, want: Expect, now = Date.now()): StoredKey {
  checkClientData(unb64url(body.clientDataJSON), want, 'webauthn.create')
  const att = decodeCbor(unb64url(body.attestationObject))
  if (!(att instanceof Map)) throw new Error('attestation object is not a map')
  const authRaw = att.get('authData')
  if (!Buffer.isBuffer(authRaw)) throw new Error('attestation carried no authenticator data')
  const auth = parseAuthData(authRaw)
  checkAuthData(auth, want)
  if (!auth.credId || !auth.cose) throw new Error('enrolment carried no credential')
  const { jwk, alg } = coseToJwk(auth.cose)
  return {
    id: b64url(auth.credId),
    jwk: JSON.stringify(jwk),
    alg,
    at: now,
    label: String(body.label ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 40) || 'passkey',
    count: auth.count
  }
}

export interface AssertionBody {
  id: string
  clientDataJSON: string
  authenticatorData: string
  signature: string
}

/**
 * Prove this is the enrolled authenticator. Returns the key that answered, with its counter
 * moved on, so the caller can persist it.
 *
 * The counter is checked but a stall is NOT fatal: Apple's platform authenticators report a
 * permanent 0, so refusing a counter that did not advance would refuse every iPhone. It is
 * enforced only where the authenticator has ever reported a non-zero one, and there what is
 * refused is going BACKWARDS - the signal of a cloned credential.
 */
export function verifyAssertion(body: AssertionBody, want: Expect, keys: StoredKey[]): StoredKey {
  const key = keys.find((k) => k.id === body.id)
  if (!key) throw new Error('unknown credential')
  const clientData = unb64url(body.clientDataJSON)
  checkClientData(clientData, want, 'webauthn.get')
  const authRaw = unb64url(body.authenticatorData)
  const auth = parseAuthData(authRaw)
  checkAuthData(auth, want)
  const signed = Buffer.concat([authRaw, createHash('sha256').update(clientData).digest()])
  const pub = createPublicKey({ key: JSON.parse(key.jwk) as NodeJwk, format: 'jwk' })
  // WebAuthn's ECDSA signature is already DER, which is Node's default for `verify` - said
  // explicitly because the other convention (raw r|s) fails as an invalid signature rather
  // than as an error, and that is a very long afternoon.
  const ok = verifySig(
    'sha256',
    signed,
    key.alg === ES256 ? { key: pub, dsaEncoding: 'der' } : pub,
    unb64url(body.signature)
  )
  if (!ok) throw new Error('signature did not verify')
  if (key.count > 0 && auth.count > 0 && auth.count <= key.count) {
    throw new Error('the signature counter went backwards - this credential may be cloned')
  }
  return { ...key, count: auth.count }
}

// ---- the unlock cookie -------------------------------------------------------------

/**
 * `<credId>.<expiry>.<hmac>`. Nothing is stored: the secret is this desk's, so a cookie
 * minted here cannot be minted anywhere else, and forgetting the key or rotating the code
 * invalidates every one of them at once.
 */
export function mintUnlock(secret: string, credId: string, now = Date.now()): string {
  const until = now + UNLOCK_MS
  return `${credId}.${until}.${sign(secret, credId, until)}`
}

export function checkUnlock(
  secret: string,
  cookie: string,
  keys: StoredKey[],
  now = Date.now()
): boolean {
  const [credId = '', untilRaw = '', mac = ''] = String(cookie ?? '').split('.')
  const until = Number(untilRaw)
  if (!credId || !untilRaw || !Number.isFinite(until) || until <= now) return false
  // A key that has been forgotten must not be able to finish an unlock window it started.
  if (!keys.some((k) => k.id === credId)) return false
  const want = Buffer.from(sign(secret, credId, until))
  const got = Buffer.from(mac)
  return want.length === got.length && timingSafeEqual(want, got)
}

function sign(secret: string, credId: string, until: number): string {
  return createHmac('sha256', secret).update(`unlock|${credId}|${until}`).digest('base64url')
}
